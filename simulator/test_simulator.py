"""Tests for simulator.py. Run with:  uv run pytest"""

import json
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer

import pytest

import simulator as sim

START = datetime(2026, 11, 16, 0, 0, tzinfo=timezone.utc)


def classify(param, value):
    """Simple reference check: NORMAL / WARNING / CRITICAL for one value."""
    n, c = sim.THRESHOLDS[param]["normal"], sim.THRESHOLDS[param]["critical"]
    if (c["min"] is not None and value < c["min"]) or (c["max"] is not None and value > c["max"]):
        return "CRITICAL"
    if value < n["min"] or value > n["max"]:
        return "WARNING"
    return "NORMAL"


def readings(station, count):
    return [station.next_reading(START + timedelta(seconds=5 * i)) for i in range(count)]


@pytest.fixture(autouse=True)
def fresh_stations():
    for s in sim.STATIONS:
        s.reset()


def test_normal_readings_stay_normal_for_a_whole_day():
    for station in sim.STATIONS:
        for r in readings(station, 17280):  # 24h at 5s
            for p in sim.PARAMS:
                assert classify(p, r[p]) == "NORMAL", (station.id, p, r[p])


def test_readings_change_smoothly():
    ph = [r["ph"] for r in readings(sim.STATIONS[0], 200)]
    assert len(set(ph)) > 20  # not the same value over and over
    assert max(abs(a - b) for a, b in zip(ph, ph[1:])) < 0.3  # no wild jumps


def test_same_seed_gives_same_readings():
    first = readings(sim.STATIONS[1], 50)
    sim.STATIONS[1].reset()
    assert readings(sim.STATIONS[1], 50) == first


@pytest.mark.parametrize("level", ["warning", "critical"])
@pytest.mark.parametrize("param", sim.PARAMS)
def test_warning_and_critical_commands_reach_the_right_band(level, param):
    sim.run_command(f"{level} all {param}")
    for station in sim.STATIONS:
        settled = readings(station, 40)[15:]  # give it a few readings to move there
        assert all(classify(param, r[param]) == level.upper() for r in settled)
        others = [p for p in sim.PARAMS if p != param]
        assert all(classify(p, r[p]) == "NORMAL" for r in settled for p in others)


def test_low_direction():
    sim.run_command("critical 3 ph low")
    assert sim.STATIONS[2].target["ph"] < 6.0
    sim.run_command("warning 3 temperature low")
    assert 5 < sim.STATIONS[2].target["temperature"] < 10


def test_set_normal_restore_and_disconnect():
    assert "1180" in sim.run_command("set 1 tds 1180")
    assert sim.STATIONS[0].mode["tds"] == "manual"
    sim.run_command("normal 1")
    assert sim.STATIONS[0].mode["tds"] == "normal"

    sim.run_command("disconnect WATER_STATION_04")
    assert sim.STATIONS[3].online is False
    sim.run_command("critical 4")
    sim.run_command("restore all")
    assert sim.STATIONS[3].online is True
    assert sim.STATIONS[3].mode["ph"] == "normal"


@pytest.mark.parametrize("bad", ["fly 1", "critical 9", "critical 1 chlorine", "set 1 ph 20", "set 1 ph", "warning"])
def test_bad_commands_are_rejected(bad):
    with pytest.raises(ValueError):
        sim.run_command(bad)


def test_message_format():
    station = sim.STATIONS[0]
    now = datetime(2026, 11, 16, 10, 0, 0, 123456, tzinfo=timezone.utc)
    msg = sim.make_message(station, station.next_reading(now), now)
    assert msg["deviceId"] == "WATER_STATION_01"
    assert msg["location"] == "College Water Tank"
    assert msg["timestamp"] == "2026-11-16T10:00:00.123Z"
    assert msg["simulated"] is True
    assert set(msg["readings"]) == set(sim.PARAMS)
    assert isinstance(msg["readings"]["tds"], int)
    assert json.loads(json.dumps(msg)) == msg
    assert sim.TOPIC.format(station.id) == "water-quality/stations/WATER_STATION_01/telemetry"


def test_dry_run_station_loop_publishes_and_disconnects(monkeypatch):
    monkeypatch.setattr(sim, "dry_run", True)
    monkeypatch.setattr(sim, "quiet", True)
    station, stop = sim.STATIONS[0], threading.Event()
    t = threading.Thread(target=sim.station_loop, args=(station, stop, 0.01, 0))
    t.start()
    threading.Event().wait(0.2)
    station.online = False
    threading.Event().wait(0.1)
    assert station.connection is None
    sent = station.sent
    threading.Event().wait(0.1)
    assert station.sent == sent  # nothing sent while disconnected
    stop.set()
    t.join()
    assert sent >= 3


# ---- dashboard control endpoint ---------------------------------------------
@pytest.fixture
def control(monkeypatch):
    monkeypatch.setattr(sim, "CONTROL_TOKEN", "secret-123")
    server = ThreadingHTTPServer(("127.0.0.1", 0), sim.DashboardControl)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def call(url, method="GET", body=None, token="secret-123"):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:5173"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read()), r.headers
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read()), e.headers


def test_control_requires_token(control):
    assert call(control + "/status", token="wrong")[0] == 401
    # POST with a body and a wrong token must get a clean 401, not a dropped connection
    code, body, _ = call(control + "/command", "POST", {"command": "critical 1"}, token="wrong")
    assert code == 401 and body == {"error": "unauthorized"}
    assert sim.STATIONS[0].mode["ph"] == "normal"


@pytest.mark.parametrize("length,code", [("-1", 413), ("abc", 400), ("999999", 413)])
def test_control_rejects_bad_content_length(control, length, code):
    import http.client
    host, port = control.removeprefix("http://").split(":")
    conn = http.client.HTTPConnection(host, int(port), timeout=5)
    conn.putrequest("POST", "/command")
    conn.putheader("Content-Length", length)
    conn.putheader("Authorization", "Bearer secret-123")
    conn.endheaders()
    assert conn.getresponse().status == code
    conn.close()


def test_control_runs_commands(control):
    code, body, headers = call(control + "/command", "POST", {"command": "critical 2 tds"})
    assert code == 200 and body["ok"]
    assert sim.STATIONS[1].mode["tds"] == "critical"
    assert headers["Access-Control-Allow-Origin"] == "http://localhost:5173"

    code, body, _ = call(control + "/status")
    assert code == 200 and len(body["stations"]) == 4

    code, body, _ = call(control + "/command", "POST", {"command": "explode 1"})
    assert code == 400 and not body["ok"]

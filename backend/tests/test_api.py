import json

import pytest

import api
import telemetry
from conftest import api_event, message


def call(route_key, **kw):
    response = api.handler(api_event(route_key, **kw))
    return response["statusCode"], json.loads(response["body"])


def send(clock, seconds=5, **kw):
    clock.advance(seconds=seconds)
    return telemetry.handler(message(**kw))


@pytest.fixture
def data(db, clock):
    """Station 1 normal, station 2 warning, station 3 critical, station 4 never seen."""
    for _ in range(3):
        send(clock, device="WATER_STATION_01")
        send(clock, seconds=0, device="WATER_STATION_02", turbidity=7)
        send(clock, seconds=0, device="WATER_STATION_03", ph=5.5)
    return db


def test_health(db):
    code, body = call("GET /health")
    assert code == 200 and body["status"] == "ok"


def test_thresholds(db):
    code, body = call("GET /config/thresholds")
    assert body["parameters"]["ph"]["normal"] == {"min": 6.5, "max": 8.5}
    assert body["offlineAfterSeconds"] == 20


def test_unknown_route(db):
    assert call("DELETE /devices")[0] == 404


def test_dashboard_summary(data):
    code, body = call("GET /dashboard/summary")
    assert code == 200
    assert {k: body[k] for k in ("totalStations", "online", "offline", "normal", "warning", "critical", "activeAlerts")} == {
        "totalStations": 4, "online": 3, "offline": 1, "normal": 1, "warning": 1, "critical": 1, "activeAlerts": 2}
    assert len(body["stations"]) == 4


def test_device_goes_offline_after_silence(data, clock):
    clock.advance(seconds=21)
    body = call("GET /dashboard/summary")[1]
    assert body["online"] == 0 and body["offline"] == 4
    _, d = call("GET /devices/{deviceId}", path={"deviceId": "WATER_STATION_01"})
    assert d["connection"] == "OFFLINE"


def test_devices(data):
    code, body = call("GET /devices")
    assert [d["deviceId"] for d in body["items"]] == [f"WATER_STATION_0{i}" for i in range(1, 5)]
    s4 = body["items"][3]
    assert s4["connection"] == "NEVER_SEEN" and s4["latestReadings"] is None


def test_device_detail(data):
    code, body = call("GET /devices/{deviceId}", path={"deviceId": "WATER_STATION_03"})
    assert code == 200
    assert body["waterStatus"] == "CRITICAL"
    assert body["latestReadings"]["ph"] == 5.5
    assert len(body["recentAlerts"]) == 1
    assert call("GET /devices/{deviceId}", path={"deviceId": "WATER_STATION_77"})[0] == 404
    assert call("GET /devices/{deviceId}", path={"deviceId": "../etc"})[0] == 400


def test_readings_pagination(data):
    route = "GET /devices/{deviceId}/readings"
    path = {"deviceId": "WATER_STATION_01"}
    code, page1 = call(route, path=path, query={"limit": "2", "from": "2026-11-16T09:00:00Z"})
    assert code == 200 and page1["count"] == 2 and page1["nextToken"]
    assert page1["items"][0]["timestamp"] > page1["items"][1]["timestamp"]  # newest first
    _, page2 = call(route, path=path, query={"limit": "2", "from": "2026-11-16T09:00:00Z", "nextToken": page1["nextToken"]})
    assert page2["count"] == 1 and page2["nextToken"] is None


def test_readings_date_filter_and_order(data):
    _, body = call("GET /devices/{deviceId}/readings", path={"deviceId": "WATER_STATION_01"},
                   query={"from": "2026-11-16T10:00:06Z", "to": "2026-11-16T10:00:12Z", "order": "asc"})
    assert [r["timestamp"] for r in body["items"]] == ["2026-11-16T10:00:10.000Z"]


@pytest.mark.parametrize("query", [
    {"limit": "0"}, {"limit": "5000"}, {"limit": "abc"}, {"from": "not-a-date"},
    {"from": "2026-11-16T11:00:00Z", "to": "2026-11-16T10:00:00Z"}, {"order": "sideways"},
    {"nextToken": "%%%"}, {"from": "2026-01-01T00:00:00Z"},
])
def test_readings_bad_input(data, query):
    assert call("GET /devices/{deviceId}/readings", path={"deviceId": "WATER_STATION_01"}, query=query)[0] == 400


def test_latest_readings(data):
    _, body = call("GET /readings/latest")
    by_id = {i["deviceId"]: i for i in body["items"]}
    assert by_id["WATER_STATION_02"]["latestReadings"]["turbidity"] == 7
    assert by_id["WATER_STATION_02"]["latestViolations"][0]["severity"] == "WARNING"


def test_alert_listing_and_filters(data):
    assert call("GET /alerts")[1]["count"] == 2
    assert call("GET /alerts", query={"status": "active"})[1]["count"] == 2
    assert call("GET /alerts", query={"severity": "critical"})[1]["items"][0]["deviceId"] == "WATER_STATION_03"
    assert call("GET /alerts", query={"deviceId": "WATER_STATION_02"})[1]["items"][0]["parameter"] == "turbidity"
    assert call("GET /alerts", query={"deviceId": "WATER_STATION_01"})[1]["count"] == 0
    assert call("GET /alerts", query={"status": "nope"})[0] == 400


def test_acknowledge(data):
    _, listing = call("GET /alerts", query={"severity": "CRITICAL"})
    alert_id = listing["items"][0]["alertId"]
    route = "PATCH /alerts/{alertId}/acknowledge"

    code, body = call(route, path={"alertId": alert_id}, body={"acknowledgedBy": "demo", "note": "checked"})
    assert code == 200
    assert body["status"] == "ACKNOWLEDGED" and body["acknowledgedBy"] == "demo" and body["acknowledgedAt"]

    assert call(route, path={"alertId": alert_id})[0] == 409
    assert call(route, path={"alertId": "0" * 32})[0] == 404
    assert call(route, path={"alertId": "bad"})[0] == 400
    assert call("GET /dashboard/summary")[1]["activeAlerts"] == 1
    assert call("GET /alerts", query={"status": "ACKNOWLEDGED"})[1]["count"] == 1


def test_acknowledged_alert_is_not_recreated_while_ongoing(data, clock):
    alert_id = call("GET /alerts", query={"severity": "CRITICAL"})[1]["items"][0]["alertId"]
    call("PATCH /alerts/{alertId}/acknowledge", path={"alertId": alert_id})
    send(clock, device="WATER_STATION_03", ph=5.5)
    assert call("GET /alerts", query={"deviceId": "WATER_STATION_03"})[1]["count"] == 1


def test_trends(data):
    code, body = call("GET /analytics/trends", query={"from": "2026-11-16T09:00:00Z", "to": "2026-11-16T11:00:00Z"})
    assert code == 200 and body["granularity"] == "HOUR"
    s3 = next(s for s in body["series"] if s["deviceId"] == "WATER_STATION_03")
    [point] = s3["points"]
    assert point["bucket"] == "2026-11-16T10"
    assert point["count"] == 3 and point["avg"]["ph"] == 5.5 and point["criticalCount"] == 3
    comp = {c["deviceId"]: c for c in body["comparison"]}
    assert comp["WATER_STATION_01"]["abnormalRate"] == 0
    assert comp["WATER_STATION_03"]["abnormalRate"] == 1
    assert comp["WATER_STATION_04"]["readingCount"] == 0
    assert body["abnormalByParameter"]["ph"] == 3 and body["abnormalByParameter"]["turbidity"] == 3


def test_trends_daily_and_validation(data):
    code, body = call("GET /analytics/trends", query={"granularity": "day", "deviceId": "WATER_STATION_01",
                                                      "from": "2026-11-10T00:00:00Z", "to": "2026-11-16T23:00:00Z"})
    assert code == 200 and len(body["series"]) == 1 and body["series"][0]["points"][0]["bucket"] == "2026-11-16"
    assert call("GET /analytics/trends", query={"granularity": "minute"})[0] == 400
    assert call("GET /analytics/trends", query={"from": "2026-10-01T00:00:00Z"})[0] == 400
    assert call("GET /analytics/trends", query={"deviceId": "WATER_STATION_99"})[0] == 404


def test_internal_errors_do_not_leak_details(db, monkeypatch):
    def boom(event):
        raise RuntimeError("arn:aws:dynamodb:secret-internal-detail")
    monkeypatch.setitem(api.ROUTES, "GET /health", boom)
    code, body = call("GET /health")
    assert code == 500 and body == {"error": "internal server error"}

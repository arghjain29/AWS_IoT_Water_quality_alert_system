import pytest
from boto3.dynamodb.conditions import Key

import telemetry
from conftest import message


def alerts(db):
    return db.Table("WaterAlerts").scan()["Items"]


def device(db, device_id="WATER_STATION_01"):
    return db.Table("DeviceRegistry").get_item(Key={"deviceId": device_id})["Item"]


def send(clock, seconds=5, **kw):
    clock.advance(seconds=seconds)
    return telemetry.handler(message(**kw))


# ---- validation ---------------------------------------------------------------
@pytest.mark.parametrize("mutate,reason", [
    (lambda m: m.pop("deviceId"), "deviceId"),
    (lambda m: m.update(deviceId="HACKER"), "deviceId"),
    (lambda m: m.update(topicDeviceId="WATER_STATION_02"), "topic"),
    (lambda m: m.update(timestamp="yesterday"), "timestamp"),
    (lambda m: m.update(timestamp="2026-11-16T10:00:00"), "timestamp"),  # no timezone
    (lambda m: m.update(timestamp="2026-11-17T10:00:00Z"), "future"),
    (lambda m: m.update(timestamp="2026-11-10T10:00:00Z"), "older"),
    (lambda m: m.pop("readings"), "readings"),
    (lambda m: m["readings"].pop("ph"), "ph"),
    (lambda m: m["readings"].update(ph="7"), "ph"),
    (lambda m: m["readings"].update(ph=True), "ph"),
    (lambda m: m["readings"].update(ph=float("nan")), "ph"),
    (lambda m: m["readings"].update(ph=15), "valid range"),
    (lambda m: m["readings"].update(tds=-1), "valid range"),
])
def test_invalid_messages_are_rejected_safely(db, mutate, reason):
    m = message()
    mutate(m)
    result = telemetry.handler(m)
    assert result["result"] == "rejected"
    assert reason in result["reason"]
    assert db.Table("WaterReadings").scan()["Count"] == 0


def test_non_object_payload(db):
    assert telemetry.handler("garbage")["result"] == "rejected"


def test_unknown_device_is_ignored(db):
    assert telemetry.handler(message(device="WATER_STATION_99"))["result"] == "unknown_device"
    assert db.Table("WaterReadings").scan()["Count"] == 0


# ---- normal processing ------------------------------------------------------
def test_normal_reading_is_stored_and_device_updated(db, clock):
    result = telemetry.handler(message())
    assert result == {"result": "stored", "status": "NORMAL", "alertsCreated": []}

    [r] = db.Table("WaterReadings").scan()["Items"]
    assert r["deviceId"] == "WATER_STATION_01"
    assert r["timestamp"] == "2026-11-16T10:00:00.000Z"
    assert r["status"] == "NORMAL"
    assert float(r["readings"]["ph"]) == 7.2
    assert r["expiresAt"] > 0

    d = device(db)
    assert d["lastSeen"] == "2026-11-16T10:00:00.000Z"
    assert d["latestStatus"] == "NORMAL"
    assert d["messageCount"] == 1
    assert alerts(db) == []


def test_duplicate_message_is_ignored(db):
    m = message()
    telemetry.handler(m)
    assert telemetry.handler(m)["result"] == "duplicate"
    assert device(db)["messageCount"] == 1


def test_late_message_kept_in_history_but_not_latest(db, clock):
    old = message(ts=clock.now)
    send(clock, ph=7.0)
    assert telemetry.handler({**old, "timestamp": "2026-11-16T09:59:00.000Z"})["result"] == "stored_out_of_order"
    assert db.Table("WaterReadings").scan()["Count"] == 2
    assert device(db)["lastSeen"] == "2026-11-16T10:00:05.000Z"


def test_aggregates_are_updated(db, clock):
    send(clock, ph=7.0)
    send(clock, ph=8.0, tds=700)  # warning
    send(clock, ph=5.0)           # critical
    item = db.Table("WaterReadingAggregates").get_item(
        Key={"seriesKey": "WATER_STATION_01#HOUR", "bucket": "2026-11-16T10"})["Item"]
    assert item["readingCount"] == 3
    assert float(item["sum_ph"]) == 20.0
    assert (item["warningCount"], item["criticalCount"]) == (1, 1)
    assert (item["abn_tds"], item["abn_ph"], item["abn_turbidity"]) == (1, 1, 0)
    day = db.Table("WaterReadingAggregates").get_item(
        Key={"seriesKey": "WATER_STATION_01#DAY", "bucket": "2026-11-16"})["Item"]
    assert day["readingCount"] == 3


# ---- alerts --------------------------------------------------------------------
def test_abnormal_reading_creates_alert_with_details(db, clock):
    result = send(clock, ph=5.5)
    assert result["status"] == "CRITICAL"
    [a] = alerts(db)
    assert a["alertId"] == result["alertsCreated"][0]
    assert (a["deviceId"], a["parameter"], a["severity"], a["status"]) == ("WATER_STATION_01", "ph", "CRITICAL", "ACTIVE")
    assert float(a["value"]) == 5.5
    assert a["message"] == "pH 5.5 is below the critical limit of 6.0"
    assert a["deviceName"] == "College Water Tank"
    assert device(db)["latestViolations"][0]["parameter"] == "ph"


def test_consecutive_abnormal_readings_update_one_alert(db, clock):
    for value in (8.8, 8.9, 8.7, 8.8):
        send(clock, ph=value)
    [a] = alerts(db)
    assert a["occurrences"] == 4
    assert float(a["lastValue"]) == 8.8


def test_escalation_creates_new_alert_but_deescalation_does_not(db, clock):
    send(clock, ph=8.8)  # warning
    send(clock, ph=9.5)  # critical -> new alert
    send(clock, ph=8.8)  # back to warning -> same critical episode
    found = sorted((a["severity"], int(a["occurrences"])) for a in alerts(db))
    assert found == [("CRITICAL", 2), ("WARNING", 1)]


def test_cooldown(db, clock):
    send(clock, turbidity=7)
    send(clock, seconds=60)                    # normal again
    send(clock, seconds=60, turbidity=7)       # 2 min later: same episode
    assert len(alerts(db)) == 1
    send(clock, seconds=11 * 60, turbidity=7)  # >10 min since last abnormal: new alert
    assert len(alerts(db)) == 2


def test_each_parameter_and_device_gets_its_own_alert(db, clock):
    send(clock, ph=5.5, tds=1500)
    send(clock, device="WATER_STATION_02", ph=5.5)
    assert sorted((a["deviceId"], a["parameter"]) for a in alerts(db)) == [
        ("WATER_STATION_01", "ph"), ("WATER_STATION_01", "tds"), ("WATER_STATION_02", "ph")]


def test_alert_indexes_are_queryable(db, clock):
    send(clock, ph=5.5)
    t = db.Table("WaterAlerts")
    assert t.query(IndexName="byStatus", KeyConditionExpression=Key("status").eq("ACTIVE"))["Count"] == 1
    assert t.query(IndexName="byDevice", KeyConditionExpression=Key("deviceId").eq("WATER_STATION_01"))["Count"] == 1
    assert t.query(IndexName="byTime", KeyConditionExpression=Key("entity").eq("ALERT"))["Count"] == 1

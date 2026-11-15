"""Telemetry processor Lambda: invoked by the AWS IoT rule for every MQTT message.

Steps for each message:
  1. validate the payload
  2. check the device exists in DeviceRegistry
  3. evaluate the readings against the thresholds
  4. store the reading (WaterReadings) and update hourly/daily totals (WaterReadingAggregates)
  5. create or update alerts (WaterAlerts), with de-duplication
  6. update the device's last-seen time and latest readings (DeviceRegistry)

Alert de-duplication rule:
  While a station+parameter stays abnormal, the SAME alert is updated
  (occurrence count, latest value). A new alert is created only if the
  parameter has been normal for ALERT_COOLDOWN_MINUTES, or it gets worse
  (WARNING -> CRITICAL).
"""

import math
import os
import re
import uuid
from datetime import timedelta

from botocore.exceptions import ClientError

import shared
from evaluation import PARAMETERS, THRESHOLDS, evaluate

log = shared.log

DEVICE_ID = re.compile(r"^WATER_STATION_\d{2}$")
READINGS_TTL_DAYS = int(os.getenv("READINGS_TTL_DAYS", "14"))
AGGREGATE_HOUR_TTL_DAYS = 90
COOLDOWN = timedelta(minutes=int(os.getenv("ALERT_COOLDOWN_MINUTES", "10")))
MAX_CLOCK_SKEW = timedelta(minutes=5)
MAX_AGE = timedelta(days=1)
SEVERITY_RANK = {"WARNING": 1, "CRITICAL": 2}


def handler(event, context=None):
    try:
        msg = validate(event)
    except ValueError as error:
        log.warning("REJECTED telemetry: %s | payload=%.500s", error, event)
        return {"result": "rejected", "reason": str(error)}
    return process(msg)


# ---- 1. validation ----------------------------------------------------------
def validate(event):
    if not isinstance(event, dict):
        raise ValueError("payload must be a JSON object")

    device_id = event.get("deviceId")
    if not isinstance(device_id, str) or not DEVICE_ID.match(device_id):
        raise ValueError("deviceId missing or invalid")
    # topicDeviceId is added by the IoT rule from the MQTT topic; they must agree
    if event.get("topicDeviceId") not in (None, device_id):
        raise ValueError("deviceId does not match the MQTT topic")

    try:
        ts = shared.parse_iso(str(event.get("timestamp", "")))
    except ValueError:
        raise ValueError("timestamp missing or not ISO-8601 UTC")
    now = shared.utcnow()
    if ts > now + MAX_CLOCK_SKEW:
        raise ValueError("timestamp is in the future")
    if ts < now - MAX_AGE:
        raise ValueError("timestamp is older than 24 hours")

    readings = event.get("readings")
    if not isinstance(readings, dict):
        raise ValueError("readings must be an object")
    clean = {}
    for p in PARAMETERS:
        v = readings.get(p)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError(f"readings.{p} missing or not a number")
        valid = THRESHOLDS[p]["validRange"]
        if not valid["min"] <= v <= valid["max"]:
            raise ValueError(f"readings.{p}={v} outside the physically valid range")
        clean[p] = v

    seq = event.get("seq")
    return {
        "deviceId": device_id,
        "ts": ts,
        "timestamp": shared.iso(ts),
        "readings": clean,
        "seq": seq if isinstance(seq, int) and not isinstance(seq, bool) else None,
        "simulated": bool(event.get("simulated", True)),
    }


# ---- 2..6 processing ---------------------------------------------------------
def process(msg):
    device = shared.table(shared.REGISTRY_TABLE).get_item(Key={"deviceId": msg["deviceId"]}).get("Item")
    if not device:
        log.warning("REJECTED telemetry from unregistered device %s", msg["deviceId"])
        return {"result": "unknown_device"}

    status, violations = evaluate(msg["readings"])

    if not store_reading(msg, status, violations):
        log.info("duplicate message ignored: %s %s", msg["deviceId"], msg["timestamp"])
        return {"result": "duplicate"}
    update_aggregates(msg, status, violations)

    last_reading_at = device.get("lastReadingAt")
    if last_reading_at and last_reading_at >= msg["timestamp"]:
        # An older message arrived late: keep it in history but don't touch latest state/alerts.
        return {"result": "stored_out_of_order", "status": status}

    alert_state = shared.from_dynamo(device.get("alertState", {}))
    created = handle_alerts(device, msg, violations, alert_state)
    update_device(msg, status, violations, alert_state)

    log.info("%s %s status=%s alerts_created=%d", msg["deviceId"], msg["timestamp"], status, len(created))
    return {"result": "stored", "status": status, "alertsCreated": created}


def store_reading(msg, status, violations):
    """Returns False if this exact message was already stored (MQTT can redeliver)."""
    expires = int((shared.utcnow() + timedelta(days=READINGS_TTL_DAYS)).timestamp())
    item = {
        "deviceId": msg["deviceId"],
        "timestamp": msg["timestamp"],
        "readings": msg["readings"],
        "status": status,
        "violations": [{"parameter": v["parameter"], "severity": v["severity"]} for v in violations],
        "seq": msg["seq"],
        "simulated": msg["simulated"],
        "receivedAt": shared.iso(shared.utcnow()),
        "expiresAt": expires,
    }
    try:
        shared.table(shared.READINGS_TABLE).put_item(
            Item=shared.to_dynamo(item),
            ConditionExpression="attribute_not_exists(deviceId)",
        )
        return True
    except ClientError as error:
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def update_aggregates(msg, status, violations):
    """Add this reading to its hour and day totals, so trend charts never read raw data."""
    abnormal = {v["parameter"] for v in violations}
    values = {":one": 1, ":w": int(status == "WARNING"), ":c": int(status == "CRITICAL"), ":dev": msg["deviceId"]}
    adds = ["readingCount :one", "warningCount :w", "criticalCount :c"]
    for p in PARAMETERS:
        values[f":{p}"] = msg["readings"][p]
        values[f":a_{p}"] = int(p in abnormal)
        adds += [f"sum_{p} :{p}", f"abn_{p} :a_{p}"]

    for granularity, bucket in (("HOUR", msg["timestamp"][:13]), ("DAY", msg["timestamp"][:10])):
        sets = "deviceId = :dev"
        vals = dict(values)
        if granularity == "HOUR":
            sets += ", expiresAt = if_not_exists(expiresAt, :exp)"
            vals[":exp"] = int((shared.utcnow() + timedelta(days=AGGREGATE_HOUR_TTL_DAYS)).timestamp())
        shared.table(shared.AGGREGATES_TABLE).update_item(
            Key={"seriesKey": f"{msg['deviceId']}#{granularity}", "bucket": bucket},
            UpdateExpression=f"SET {sets} ADD {', '.join(adds)}",
            ExpressionAttributeValues=shared.to_dynamo(vals),
        )


def handle_alerts(device, msg, violations, alert_state):
    created = []
    for v in violations:
        p = v["parameter"]
        current = alert_state.get(p)
        still_same_episode = current and msg["ts"] - shared.parse_iso(current["lastAbnormalAt"]) < COOLDOWN
        got_worse = current and SEVERITY_RANK[v["severity"]] > SEVERITY_RANK[current["severity"]]

        if still_same_episode and not got_worse:
            touch_alert(current["alertId"], v, msg)
            current["lastAbnormalAt"] = msg["timestamp"]
        else:
            alert_id = create_alert(device, msg, v)
            alert_state[p] = {"alertId": alert_id, "severity": v["severity"], "lastAbnormalAt": msg["timestamp"]}
            created.append(alert_id)
    return created


def create_alert(device, msg, v):
    alert_id = uuid.uuid4().hex
    item = {
        "alertId": alert_id,
        "entity": "ALERT",  # constant key for the "all alerts by time" index
        "deviceId": msg["deviceId"],
        "deviceName": device.get("name", msg["deviceId"]),
        "location": device.get("location", ""),
        "parameter": v["parameter"],
        "parameterLabel": v["label"],
        "unit": v["unit"],
        "severity": v["severity"],
        "status": "ACTIVE",
        "value": v["value"],
        "lastValue": v["value"],
        "limit": v["limit"],
        "direction": v["direction"],
        "message": v["message"],
        "createdAt": msg["timestamp"],
        "lastAbnormalAt": msg["timestamp"],
        "occurrences": 1,
        "simulated": msg["simulated"],
    }
    shared.table(shared.ALERTS_TABLE).put_item(Item=shared.to_dynamo(item))
    log.warning("ALERT %s %s %s: %s", v["severity"], msg["deviceId"], v["parameter"], v["message"])
    return alert_id


def touch_alert(alert_id, v, msg):
    try:
        shared.table(shared.ALERTS_TABLE).update_item(
            Key={"alertId": alert_id},
            UpdateExpression="SET lastValue = :v, lastAbnormalAt = :t ADD occurrences :one",
            ConditionExpression="attribute_exists(alertId)",
            ExpressionAttributeValues=shared.to_dynamo({":v": v["value"], ":t": msg["timestamp"], ":one": 1}),
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def update_device(msg, status, violations, alert_state):
    latest_violations = [
        {k: v[k] for k in ("parameter", "severity", "value", "limit", "direction", "message")} for v in violations
    ]
    # lastSeen      = when the CLOUD received it (used for online/offline; device clocks can be wrong)
    # lastReadingAt = the device's own timestamp (used to ignore late, out-of-order messages)
    try:
        shared.table(shared.REGISTRY_TABLE).update_item(
            Key={"deviceId": msg["deviceId"]},
            UpdateExpression=(
                "SET lastSeen = :now, lastReadingAt = :ts, latestReadings = :r, latestStatus = :s, "
                "latestViolations = :v, alertState = :a ADD messageCount :one"
            ),
            # never let an older message overwrite newer state
            ConditionExpression="attribute_not_exists(lastReadingAt) OR lastReadingAt < :ts",
            ExpressionAttributeValues=shared.to_dynamo({
                ":now": shared.iso(shared.utcnow()),
                ":ts": msg["timestamp"], ":r": msg["readings"], ":s": status,
                ":v": latest_violations, ":a": alert_state, ":one": 1,
            }),
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise

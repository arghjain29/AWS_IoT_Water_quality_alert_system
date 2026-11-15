"""REST API Lambda for the dashboard (API Gateway HTTP API -> this function).

GET   /health
GET   /config/thresholds
GET   /dashboard/summary
GET   /devices
GET   /devices/{deviceId}
GET   /devices/{deviceId}/readings   ?from&to&limit&order&nextToken
GET   /readings/latest
GET   /alerts                        ?status&deviceId&severity&from&to&limit&nextToken
PATCH /alerts/{alertId}/acknowledge  body: {"acknowledgedBy": "...", "note": "..."} (optional)
GET   /analytics/trends              ?granularity=hour|day&from&to&deviceId

All list endpoints use DynamoDB Query on keys/indexes. The only Scan is on the
tiny DeviceRegistry table (one item per station).
CORS is handled by API Gateway.
"""

import base64
import binascii
import json
import os
import re
from datetime import timedelta

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

import shared
from evaluation import PARAMETERS, THRESHOLDS

log = shared.log

OFFLINE_AFTER = timedelta(seconds=int(os.getenv("OFFLINE_AFTER_SECONDS", "20")))
DEVICE_ID = re.compile(r"^WATER_STATION_\d{2}$")
ALERT_ID = re.compile(r"^[0-9a-f]{32}$")
ROUTES = {}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def route(key):
    def register(fn):
        ROUTES[key] = fn
        return fn
    return register


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(shared.from_dynamo(body)),
    }


def handler(event, context=None):
    fn = ROUTES.get(event.get("routeKey", ""))
    if fn is None:
        return respond(404, {"error": "not found"})
    try:
        return respond(200, fn(event))
    except ApiError as error:
        return respond(error.status, {"error": error.message})
    except Exception:
        log.exception("unhandled error for %s", event.get("routeKey"))
        return respond(500, {"error": "internal server error"})


# ---- request helpers ----------------------------------------------------------
def query_params(event):
    return event.get("queryStringParameters") or {}


def path_param(event, name, pattern):
    value = (event.get("pathParameters") or {}).get(name, "")
    if not pattern.match(value):
        raise ApiError(400, f"invalid {name}")
    return value


def get_limit(q, default, maximum):
    try:
        limit = int(q.get("limit", default))
    except ValueError:
        raise ApiError(400, "limit must be a number")
    if not 1 <= limit <= maximum:
        raise ApiError(400, f"limit must be between 1 and {maximum}")
    return limit


def get_time_range(q, default_span, max_span=None):
    try:
        end = shared.parse_iso(q["to"]) if q.get("to") else shared.utcnow()
        start = shared.parse_iso(q["from"]) if q.get("from") else end - default_span
    except ValueError:
        raise ApiError(400, "from/to must be ISO-8601 timestamps, e.g. 2026-11-16T10:00:00Z")
    if start > end:
        raise ApiError(400, "'from' must be before 'to'")
    if max_span and end - start > max_span:
        raise ApiError(400, f"time range too large (max {max_span.days} days)")
    return start, end


def choice(q, name, allowed, default):
    value = (q.get(name) or default).upper()
    if value not in allowed:
        raise ApiError(400, f"{name} must be one of {', '.join(allowed)}")
    return value


def encode_token(key):
    return base64.urlsafe_b64encode(json.dumps(key).encode()).decode() if key else None


def decode_token(token):
    if not token:
        return None
    try:
        key = json.loads(base64.urlsafe_b64decode(token.encode()))
        if not isinstance(key, dict):
            raise ValueError
        return key
    except (ValueError, binascii.Error):
        raise ApiError(400, "invalid nextToken")


def paged_query(table, limit, token, **kwargs):
    """Query one page of up to `limit` items, following DynamoDB pages if a filter removes items."""
    items, start_key = [], decode_token(token)
    for _ in range(10):
        args = dict(kwargs, Limit=limit - len(items))
        if start_key:
            args["ExclusiveStartKey"] = start_key
        page = table.query(**args)
        items += page["Items"]
        start_key = page.get("LastEvaluatedKey")
        if not start_key or len(items) >= limit:
            break
    return {"items": items, "count": len(items), "nextToken": encode_token(start_key)}


# ---- devices ------------------------------------------------------------------
def all_devices():
    registry = shared.table(shared.REGISTRY_TABLE)
    page = registry.scan()
    items = page["Items"]
    while page.get("LastEvaluatedKey"):
        page = registry.scan(ExclusiveStartKey=page["LastEvaluatedKey"])
        items += page["Items"]
    return sorted(items, key=lambda d: d["deviceId"])


def device_view(item, now):
    last_seen = item.get("lastSeen")
    online = bool(last_seen) and now - shared.parse_iso(last_seen) <= OFFLINE_AFTER
    return {
        "deviceId": item["deviceId"],
        "name": item.get("name"),
        "location": item.get("location"),
        "connection": "ONLINE" if online else ("OFFLINE" if last_seen else "NEVER_SEEN"),
        "online": online,
        "waterStatus": item.get("latestStatus") if last_seen else None,
        "lastSeen": last_seen,
        "latestReadings": item.get("latestReadings"),
        "latestViolations": item.get("latestViolations", []),
        "messageCount": item.get("messageCount", 0),
    }


@route("GET /health")
def health(event):
    return {"status": "ok", "time": shared.iso(shared.utcnow())}


@route("GET /config/thresholds")
def thresholds(event):
    return {"parameters": THRESHOLDS, "offlineAfterSeconds": int(OFFLINE_AFTER.total_seconds())}


@route("GET /devices")
def list_devices(event):
    now = shared.utcnow()
    return {"items": [device_view(d, now) for d in all_devices()]}


@route("GET /devices/{deviceId}")
def get_device(event):
    device_id = path_param(event, "deviceId", DEVICE_ID)
    item = shared.table(shared.REGISTRY_TABLE).get_item(Key={"deviceId": device_id}).get("Item")
    if not item:
        raise ApiError(404, "device not found")
    recent = shared.table(shared.ALERTS_TABLE).query(
        IndexName="byDevice", KeyConditionExpression=Key("deviceId").eq(device_id),
        ScanIndexForward=False, Limit=10,
    )["Items"]
    return {**device_view(item, shared.utcnow()), "recentAlerts": recent}


@route("GET /devices/{deviceId}/readings")
def device_readings(event):
    device_id = path_param(event, "deviceId", DEVICE_ID)
    q = query_params(event)
    start, end = get_time_range(q, timedelta(hours=1), max_span=timedelta(days=31))
    order = choice(q, "order", ("ASC", "DESC"), "DESC")
    return paged_query(
        shared.table(shared.READINGS_TABLE), get_limit(q, 200, 1000), q.get("nextToken"),
        KeyConditionExpression=Key("deviceId").eq(device_id)
        & Key("timestamp").between(shared.iso(start), shared.iso(end)),
        ScanIndexForward=order == "ASC",
    )


@route("GET /readings/latest")
def latest_readings(event):
    now = shared.utcnow()
    return {"items": [
        {k: v[k] for k in ("deviceId", "name", "online", "waterStatus", "lastSeen", "latestReadings", "latestViolations")}
        for v in (device_view(d, now) for d in all_devices())
    ]}


@route("GET /dashboard/summary")
def dashboard_summary(event):
    now = shared.utcnow()
    devices = [device_view(d, now) for d in all_devices()]
    online = [d for d in devices if d["online"]]

    active, start_key = 0, None
    alerts = shared.table(shared.ALERTS_TABLE)
    while True:
        args = {"IndexName": "byStatus", "KeyConditionExpression": Key("status").eq("ACTIVE"), "Select": "COUNT"}
        if start_key:
            args["ExclusiveStartKey"] = start_key
        page = alerts.query(**args)
        active += page["Count"]
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            break

    return {
        "totalStations": len(devices),
        "online": len(online),
        "offline": len(devices) - len(online),
        "normal": sum(d["waterStatus"] == "NORMAL" for d in online),
        "warning": sum(d["waterStatus"] == "WARNING" for d in online),
        "critical": sum(d["waterStatus"] == "CRITICAL" for d in online),
        "activeAlerts": active,
        "stations": devices,
        "generatedAt": shared.iso(now),
    }


# ---- alerts -------------------------------------------------------------------
@route("GET /alerts")
def list_alerts(event):
    q = query_params(event)
    status = choice(q, "status", ("ALL", "ACTIVE", "ACKNOWLEDGED"), "ALL")
    severity = choice(q, "severity", ("ALL", "WARNING", "CRITICAL"), "ALL")
    start, end = get_time_range(q, timedelta(days=3650))
    created = Key("createdAt").between(shared.iso(start), shared.iso(end))

    filters = []
    device_id = q.get("deviceId")
    if device_id:
        if not DEVICE_ID.match(device_id):
            raise ApiError(400, "invalid deviceId")
        index, key = "byDevice", Key("deviceId").eq(device_id) & created
        if status != "ALL":
            filters.append(Attr("status").eq(status))
    elif status != "ALL":
        index, key = "byStatus", Key("status").eq(status) & created
    else:
        index, key = "byTime", Key("entity").eq("ALERT") & created
    if severity != "ALL":
        filters.append(Attr("severity").eq(severity))

    args = {"IndexName": index, "KeyConditionExpression": key, "ScanIndexForward": False}
    if filters:
        f = filters[0]
        for extra in filters[1:]:
            f = f & extra
        args["FilterExpression"] = f
    return paged_query(shared.table(shared.ALERTS_TABLE), get_limit(q, 50, 200), q.get("nextToken"), **args)


@route("PATCH /alerts/{alertId}/acknowledge")
def acknowledge_alert(event):
    alert_id = path_param(event, "alertId", ALERT_ID)
    body = {}
    if event.get("body"):
        try:
            raw = base64.b64decode(event["body"]) if event.get("isBase64Encoded") else event["body"]
            body = json.loads(raw)
        except (ValueError, binascii.Error):
            raise ApiError(400, "body must be JSON")
        if not isinstance(body, dict):
            raise ApiError(400, "body must be a JSON object")
    by = str(body.get("acknowledgedBy") or "dashboard-operator")[:100]
    note = str(body.get("note") or "")[:500]

    alerts = shared.table(shared.ALERTS_TABLE)
    try:
        result = alerts.update_item(
            Key={"alertId": alert_id},
            UpdateExpression="SET #s = :ack, acknowledgedAt = :now, acknowledgedBy = :by, note = :note",
            ConditionExpression="attribute_exists(alertId) AND #s = :active",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":ack": "ACKNOWLEDGED", ":active": "ACTIVE",
                ":now": shared.iso(shared.utcnow()), ":by": by, ":note": note,
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        if "Item" not in alerts.get_item(Key={"alertId": alert_id}):
            raise ApiError(404, "alert not found")
        raise ApiError(409, "alert is already acknowledged")
    return result["Attributes"]


# ---- analytics ----------------------------------------------------------------
def bucket_to_iso(bucket):
    return bucket + ("T00:00:00.000Z" if len(bucket) == 10 else ":00:00.000Z")


@route("GET /analytics/trends")
def trends(event):
    q = query_params(event)
    granularity = choice(q, "granularity", ("HOUR", "DAY"), "HOUR")
    if granularity == "HOUR":
        start, end = get_time_range(q, timedelta(hours=24), max_span=timedelta(days=8))
        cut = 13  # "2026-11-16T10"
    else:
        start, end = get_time_range(q, timedelta(days=7), max_span=timedelta(days=366))
        cut = 10  # "2026-11-16"

    devices = all_devices()
    if q.get("deviceId"):
        devices = [d for d in devices if d["deviceId"] == q["deviceId"]]
        if not devices:
            raise ApiError(404, "device not found")

    aggregates = shared.table(shared.AGGREGATES_TABLE)
    series, comparison = [], []
    abnormal_totals = {p: 0 for p in PARAMETERS}
    for d in devices:
        rows, start_key = [], None
        while True:
            args = {"KeyConditionExpression": Key("seriesKey").eq(f"{d['deviceId']}#{granularity}")
                    & Key("bucket").between(shared.iso(start)[:cut], shared.iso(end)[:cut])}
            if start_key:
                args["ExclusiveStartKey"] = start_key
            page = aggregates.query(**args)
            rows += shared.from_dynamo(page["Items"])
            start_key = page.get("LastEvaluatedKey")
            if not start_key:
                break

        points, totals = [], {"count": 0, "warning": 0, "critical": 0, **{p: 0.0 for p in PARAMETERS}}
        for r in rows:
            n = r["readingCount"]
            points.append({
                "bucket": r["bucket"],
                "timestamp": bucket_to_iso(r["bucket"]),
                "count": n,
                "avg": {p: round(r[f"sum_{p}"] / n, 2) for p in PARAMETERS},
                "warningCount": r["warningCount"],
                "criticalCount": r["criticalCount"],
                "abnormal": {p: r[f"abn_{p}"] for p in PARAMETERS},
            })
            totals["count"] += n
            totals["warning"] += r["warningCount"]
            totals["critical"] += r["criticalCount"]
            for p in PARAMETERS:
                totals[p] += r[f"sum_{p}"]
                abnormal_totals[p] += r[f"abn_{p}"]

        n = totals["count"]
        series.append({"deviceId": d["deviceId"], "name": d.get("name"), "points": points})
        comparison.append({
            "deviceId": d["deviceId"],
            "name": d.get("name"),
            "readingCount": n,
            "avg": {p: round(totals[p] / n, 2) if n else None for p in PARAMETERS},
            "warningCount": totals["warning"],
            "criticalCount": totals["critical"],
            "abnormalRate": round((totals["warning"] + totals["critical"]) / n, 4) if n else 0,
        })

    return {
        "granularity": granularity,
        "from": shared.iso(start),
        "to": shared.iso(end),
        "series": series,
        "comparison": comparison,
        "abnormalByParameter": abnormal_totals,
    }

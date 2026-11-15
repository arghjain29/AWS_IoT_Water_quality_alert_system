"""Small helpers used by both Lambda functions: tables, time and number conversion."""

import json
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3

log = logging.getLogger()
log.setLevel(os.getenv("LOG_LEVEL", "INFO"))

READINGS_TABLE = os.getenv("READINGS_TABLE", "WaterReadings")
ALERTS_TABLE = os.getenv("ALERTS_TABLE", "WaterAlerts")
REGISTRY_TABLE = os.getenv("REGISTRY_TABLE", "DeviceRegistry")
AGGREGATES_TABLE = os.getenv("AGGREGATES_TABLE", "WaterReadingAggregates")

_dynamodb = None


def table(name):
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(name)


# ---- time: always ISO-8601 UTC like 2026-11-16T10:00:00.123Z ----------------
def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso(text):
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamp must include a timezone (use UTC 'Z')")
    return dt.astimezone(timezone.utc)


# ---- numbers: DynamoDB needs Decimal instead of float ------------------------
def to_dynamo(value):
    return json.loads(json.dumps(value), parse_float=Decimal)


def from_dynamo(value):
    if isinstance(value, list):
        return [from_dynamo(v) for v in value]
    if isinstance(value, dict):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value

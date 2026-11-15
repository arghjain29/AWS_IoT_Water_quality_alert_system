"""Test setup: a fake DynamoDB (moto) with the same tables and indexes as Terraform creates."""

import json
import os
from datetime import datetime, timedelta, timezone

import boto3
import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"  # fake credentials: moto never calls AWS
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"

from moto import mock_aws  # noqa: E402

import shared  # noqa: E402

NOW = datetime(2026, 11, 16, 10, 0, 0, tzinfo=timezone.utc)
STATIONS = [
    ("WATER_STATION_01", "College Water Tank"),
    ("WATER_STATION_02", "Residential Water Supply"),
    ("WATER_STATION_03", "Industrial Water Storage"),
    ("WATER_STATION_04", "Community Water Supply"),
]


def create_tables(ddb):
    def table(name, keys, gsis=()):
        attrs = {k for k, _ in keys} | {k for _, ks in gsis for k, _ in ks}
        args = {
            "TableName": name,
            "BillingMode": "PAY_PER_REQUEST",
            "KeySchema": [{"AttributeName": k, "KeyType": t} for k, t in keys],
            "AttributeDefinitions": [{"AttributeName": a, "AttributeType": "S"} for a in attrs],
        }
        if gsis:
            args["GlobalSecondaryIndexes"] = [
                {"IndexName": n, "KeySchema": [{"AttributeName": k, "KeyType": t} for k, t in ks],
                 "Projection": {"ProjectionType": "ALL"}}
                for n, ks in gsis
            ]
        ddb.create_table(**args)

    table("WaterReadings", [("deviceId", "HASH"), ("timestamp", "RANGE")])
    table("DeviceRegistry", [("deviceId", "HASH")])
    table("WaterReadingAggregates", [("seriesKey", "HASH"), ("bucket", "RANGE")])
    table("WaterAlerts", [("alertId", "HASH")], gsis=[
        ("byStatus", [("status", "HASH"), ("createdAt", "RANGE")]),
        ("byDevice", [("deviceId", "HASH"), ("createdAt", "RANGE")]),
        ("byTime", [("entity", "HASH"), ("createdAt", "RANGE")]),
    ])


class Clock:
    """Controllable 'now' so tests can move time forward."""

    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(shared, "utcnow", c)
    return c


@pytest.fixture
def db(clock):
    with mock_aws():
        shared._dynamodb = None
        ddb = boto3.client("dynamodb")
        create_tables(ddb)
        registry = boto3.resource("dynamodb").Table("DeviceRegistry")
        for device_id, name in STATIONS:
            registry.put_item(Item={"deviceId": device_id, "name": name, "location": name})
        yield boto3.resource("dynamodb")
        shared._dynamodb = None


def message(device="WATER_STATION_01", ts=None, **readings):
    base = {"ph": 7.2, "turbidity": 1.8, "tds": 320, "temperature": 26.5}
    base.update(readings)
    return {
        "schemaVersion": 1,
        "deviceId": device,
        "topicDeviceId": device,
        "location": "x",
        "timestamp": shared.iso(ts or shared.utcnow()),
        "seq": 1,
        "simulated": True,
        "readings": base,
    }


def api_event(route_key, path=None, query=None, body=None):
    return {
        "routeKey": route_key,
        "pathParameters": path or {},
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }

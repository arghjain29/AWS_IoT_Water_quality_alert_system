// Test setup: an in-memory fake DynamoDB (dynalite) with the same tables and
// indexes that Terraform creates. Nothing here talks to AWS.

import dynalite from "dynalite";
import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { clock, db, iso, resetDb } from "../src/shared.mjs";

export const NOW = new Date("2026-11-16T10:00:00.000Z");

export const STATIONS = [
  ["WATER_STATION_01", "College Water Tank"],
  ["WATER_STATION_02", "Residential Water Supply"],
  ["WATER_STATION_03", "Industrial Water Storage"],
  ["WATER_STATION_04", "Community Water Supply"],
];

// Controllable clock: tests move time forward with fakeClock.advance(seconds)
export const fakeClock = {
  time: NOW.getTime(),
  reset() { this.time = NOW.getTime(); clock.now = () => new Date(this.time); },
  advance(seconds) { this.time += seconds * 1000; },
  get now() { return new Date(this.time); },
};

function tableDef(name, keys, indexes = []) {
  const attrNames = new Set([...keys.map(([k]) => k), ...indexes.flatMap(([, ks]) => ks.map(([k]) => k))]);
  const toSchema = (ks) => ks.map(([AttributeName, KeyType]) => ({ AttributeName, KeyType }));
  return {
    TableName: name,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: toSchema(keys),
    AttributeDefinitions: [...attrNames].map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
    GlobalSecondaryIndexes: indexes.length
      ? indexes.map(([IndexName, ks]) => ({ IndexName, KeySchema: toSchema(ks), Projection: { ProjectionType: "ALL" } }))
      : undefined,
  };
}

const TABLES = [
  tableDef("WaterReadings", [["deviceId", "HASH"], ["timestamp", "RANGE"]]),
  tableDef("DeviceRegistry", [["deviceId", "HASH"]]),
  tableDef("WaterReadingAggregates", [["seriesKey", "HASH"], ["bucket", "RANGE"]]),
  tableDef("WaterAlerts", [["alertId", "HASH"]], [
    ["byStatus", [["status", "HASH"], ["createdAt", "RANGE"]]],
    ["byDevice", [["deviceId", "HASH"], ["createdAt", "RANGE"]]],
    ["byTime", [["entity", "HASH"], ["createdAt", "RANGE"]]],
  ]),
];

// Start a fresh fake DynamoDB, create tables and register the 4 stations.
export async function startDb() {
  const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  resetDb();
  fakeClock.reset();

  const raw = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT, region: "local",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  for (const def of TABLES) await raw.send(new CreateTableCommand(def));
  for (const [deviceId, name] of STATIONS) {
    await db().send(new PutCommand({ TableName: "DeviceRegistry", Item: { deviceId, name, location: name } }));
  }
  return {
    async stop() {
      resetDb();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function scanAll(table) {
  return (await db().send(new ScanCommand({ TableName: table }))).Items;
}

export async function getItem(table, key) {
  return (await db().send(new GetCommand({ TableName: table, Key: key }))).Item;
}

export function message(device = "WATER_STATION_01", { ts, ...readings } = {}) {
  return {
    schemaVersion: 1,
    deviceId: device,
    topicDeviceId: device,
    location: "x",
    timestamp: iso(ts ?? fakeClock.now),
    seq: 1,
    simulated: true,
    readings: { ph: 7.2, turbidity: 1.8, tds: 320, temperature: 26.5, ...readings },
  };
}

export function apiEvent(routeKey, { path, query, body } = {}) {
  return {
    routeKey,
    pathParameters: path ?? {},
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

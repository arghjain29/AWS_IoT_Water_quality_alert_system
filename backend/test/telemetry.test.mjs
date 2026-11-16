import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/telemetry.mjs";
import { db } from "../src/shared.mjs";
import { fakeClock, getItem, message, scanAll, startDb } from "./helpers.mjs";

let fake;
beforeEach(async () => { fake = await startDb(); });
afterEach(async () => { await fake.stop(); });

const alerts = () => scanAll("WaterAlerts");
const device = (id = "WATER_STATION_01") => getItem("DeviceRegistry", { deviceId: id });
const send = (seconds = 5, device = "WATER_STATION_01", readings = {}) => {
  fakeClock.advance(seconds);
  return handler(message(device, readings));
};

// ---- validation ----------------------------------------------------------------
const invalidCases = [
  [(m) => delete m.deviceId, "deviceId"],
  [(m) => (m.deviceId = "HACKER"), "deviceId"],
  [(m) => (m.topicDeviceId = "WATER_STATION_02"), "topic"],
  [(m) => (m.timestamp = "yesterday"), "timestamp"],
  [(m) => (m.timestamp = "2026-11-16T10:00:00"), "timestamp"], // no timezone
  [(m) => (m.timestamp = "2026-11-17T10:00:00Z"), "future"],
  [(m) => (m.timestamp = "2026-11-10T10:00:00Z"), "older"],
  [(m) => delete m.readings, "readings"],
  [(m) => delete m.readings.ph, "ph"],
  [(m) => (m.readings.ph = "7"), "ph"],
  [(m) => (m.readings.ph = true), "ph"],
  [(m) => (m.readings.ph = NaN), "ph"],
  [(m) => (m.readings.ph = 15), "valid range"],
  [(m) => (m.readings.tds = -1), "valid range"],
];

test("invalid messages are rejected safely and nothing is stored", async () => {
  for (const [mutate, reason] of invalidCases) {
    const m = message();
    mutate(m);
    const result = await handler(m);
    assert.equal(result.result, "rejected", reason);
    assert.match(result.reason, new RegExp(reason));
  }
  for (const bad of ["garbage", null, [1, 2]]) {
    assert.equal((await handler(bad)).result, "rejected");
  }
  assert.equal((await scanAll("WaterReadings")).length, 0);
});

test("unknown device is ignored", async () => {
  assert.equal((await handler(message("WATER_STATION_99"))).result, "unknown_device");
  assert.equal((await scanAll("WaterReadings")).length, 0);
});

// ---- normal processing ----------------------------------------------------------
test("normal reading is stored and the device updated", async () => {
  assert.deepEqual(await handler(message()), { result: "stored", status: "NORMAL", alertsCreated: [] });

  const [r] = await scanAll("WaterReadings");
  assert.equal(r.deviceId, "WATER_STATION_01");
  assert.equal(r.timestamp, "2026-11-16T10:00:00.000Z");
  assert.equal(r.status, "NORMAL");
  assert.equal(r.readings.ph, 7.2);
  assert.ok(r.expiresAt > 0);

  const d = await device();
  assert.equal(d.lastSeen, "2026-11-16T10:00:00.000Z");
  assert.equal(d.latestStatus, "NORMAL");
  assert.equal(d.messageCount, 1);
  assert.deepEqual(await alerts(), []);
});

test("duplicate message is ignored", async () => {
  const m = message();
  await handler(m);
  assert.equal((await handler(m)).result, "duplicate");
  assert.equal((await device()).messageCount, 1);
});

test("late message is kept in history but does not change latest state", async () => {
  await send(5, "WATER_STATION_01", { ph: 7.0 });
  const late = message("WATER_STATION_01", { ts: new Date("2026-11-16T09:59:00.000Z") });
  assert.equal((await handler(late)).result, "stored_out_of_order");
  assert.equal((await scanAll("WaterReadings")).length, 2);
  assert.equal((await device()).lastReadingAt, "2026-11-16T10:00:05.000Z");
});

test("device with a slow clock: lastSeen uses cloud time", async () => {
  fakeClock.advance(5);
  await handler(message("WATER_STATION_01", { ts: new Date(fakeClock.now.getTime() - 16_000) }));
  const d = await device();
  assert.equal(d.lastSeen, "2026-11-16T10:00:05.000Z");
  assert.equal(d.lastReadingAt, "2026-11-16T09:59:49.000Z");
});

test("hourly and daily aggregates are updated", async () => {
  await send(5, "WATER_STATION_01", { ph: 7.0 });
  await send(5, "WATER_STATION_01", { ph: 8.0, tds: 700 }); // warning
  await send(5, "WATER_STATION_01", { ph: 5.0 });           // critical
  const hour = await getItem("WaterReadingAggregates", { seriesKey: "WATER_STATION_01#HOUR", bucket: "2026-11-16T10" });
  assert.equal(hour.readingCount, 3);
  assert.equal(hour.sum_ph, 20);
  assert.deepEqual([hour.warningCount, hour.criticalCount], [1, 1]);
  assert.deepEqual([hour.abn_tds, hour.abn_ph, hour.abn_turbidity], [1, 1, 0]);
  const day = await getItem("WaterReadingAggregates", { seriesKey: "WATER_STATION_01#DAY", bucket: "2026-11-16" });
  assert.equal(day.readingCount, 3);
});

// ---- alerts ----------------------------------------------------------------------
test("abnormal reading creates an alert with details", async () => {
  const result = await send(5, "WATER_STATION_01", { ph: 5.5 });
  assert.equal(result.status, "CRITICAL");
  const [a] = await alerts();
  assert.equal(a.alertId, result.alertsCreated[0]);
  assert.match(a.alertId, /^[0-9a-f]{32}$/);
  assert.deepEqual([a.deviceId, a.parameter, a.severity, a.status], ["WATER_STATION_01", "ph", "CRITICAL", "ACTIVE"]);
  assert.equal(a.value, 5.5);
  assert.equal(a.message, "pH 5.50 is below the critical limit of 6.00");
  assert.equal(a.deviceName, "College Water Tank");
  assert.equal((await device()).latestViolations[0].parameter, "ph");
});

test("consecutive abnormal readings update a single alert", async () => {
  for (const ph of [8.8, 8.9, 8.7, 8.8]) await send(5, "WATER_STATION_01", { ph });
  const [a, ...rest] = await alerts();
  assert.equal(rest.length, 0);
  assert.equal(a.occurrences, 4);
  assert.equal(a.lastValue, 8.8);
});

test("escalation creates a new alert, de-escalation does not", async () => {
  await send(5, "WATER_STATION_01", { ph: 8.8 }); // warning
  await send(5, "WATER_STATION_01", { ph: 9.5 }); // critical -> new alert
  await send(5, "WATER_STATION_01", { ph: 8.8 }); // back to warning -> same critical episode
  const found = (await alerts()).map((a) => [a.severity, a.occurrences]).sort();
  assert.deepEqual(found, [["CRITICAL", 2], ["WARNING", 1]]);
});

test("cooldown: new alert only after 10 normal minutes", async () => {
  await send(5, "WATER_STATION_01", { turbidity: 7 });
  await send(60);                                       // normal again
  await send(60, "WATER_STATION_01", { turbidity: 7 }); // 2 min later: same episode
  assert.equal((await alerts()).length, 1);
  await send(11 * 60, "WATER_STATION_01", { turbidity: 7 }); // >10 min since last abnormal
  assert.equal((await alerts()).length, 2);
});

test("each parameter and device gets its own alert", async () => {
  await send(5, "WATER_STATION_01", { ph: 5.5, tds: 1500 });
  await send(5, "WATER_STATION_02", { ph: 5.5 });
  const found = (await alerts()).map((a) => `${a.deviceId}/${a.parameter}`).sort();
  assert.deepEqual(found, ["WATER_STATION_01/ph", "WATER_STATION_01/tds", "WATER_STATION_02/ph"]);
});

test("alert indexes are queryable", async () => {
  await send(5, "WATER_STATION_01", { ph: 5.5 });
  const count = async (IndexName, attr, value) => (await db().send(new QueryCommand({
    TableName: "WaterAlerts", IndexName,
    KeyConditionExpression: "#k = :v", ExpressionAttributeNames: { "#k": attr }, ExpressionAttributeValues: { ":v": value },
  }))).Count;
  assert.equal(await count("byStatus", "status", "ACTIVE"), 1);
  assert.equal(await count("byDevice", "deviceId", "WATER_STATION_01"), 1);
  assert.equal(await count("byTime", "entity", "ALERT"), 1);
});

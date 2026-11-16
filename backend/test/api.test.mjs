import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { handler as api, routes } from "../src/api.mjs";
import { handler as telemetry } from "../src/telemetry.mjs";
import { apiEvent, fakeClock, message, startDb } from "./helpers.mjs";

let fake;
beforeEach(async () => { fake = await startDb(); });
afterEach(async () => { await fake.stop(); });

async function call(routeKey, options) {
  const response = await api(apiEvent(routeKey, options));
  return [response.statusCode, JSON.parse(response.body)];
}

const send = (seconds, device, readings = {}) => {
  fakeClock.advance(seconds);
  return telemetry(message(device, readings));
};

// Station 1 normal, station 2 warning, station 3 critical, station 4 never seen.
async function seed() {
  for (let i = 0; i < 3; i++) {
    await send(5, "WATER_STATION_01");
    await send(0, "WATER_STATION_02", { turbidity: 7 });
    await send(0, "WATER_STATION_03", { ph: 5.5 });
  }
}

test("health and thresholds", async () => {
  const [code, body] = await call("GET /health");
  assert.equal(code, 200);
  assert.equal(body.status, "ok");
  const [, t] = await call("GET /config/thresholds");
  assert.deepEqual(t.parameters.ph.normal, { min: 6.5, max: 8.5 });
  assert.equal(t.offlineAfterSeconds, 20);
});

test("unknown route returns 404", async () => {
  assert.equal((await call("DELETE /devices"))[0], 404);
});

test("dashboard summary counts stations and alerts", async () => {
  await seed();
  const [code, body] = await call("GET /dashboard/summary");
  assert.equal(code, 200);
  const { totalStations, online, offline, normal, warning, critical, activeAlerts } = body;
  assert.deepEqual(
    { totalStations, online, offline, normal, warning, critical, activeAlerts },
    { totalStations: 4, online: 3, offline: 1, normal: 1, warning: 1, critical: 1, activeAlerts: 2 },
  );
  assert.equal(body.stations.length, 4);
});

test("stations go offline after 20s of silence", async () => {
  await seed();
  fakeClock.advance(21);
  const [, summary] = await call("GET /dashboard/summary");
  assert.deepEqual([summary.online, summary.offline], [0, 4]);
  const [, d] = await call("GET /devices/{deviceId}", { path: { deviceId: "WATER_STATION_01" } });
  assert.equal(d.connection, "OFFLINE");
});

test("device with a slow clock still counts as online", async () => {
  fakeClock.advance(5);
  await telemetry(message("WATER_STATION_01", { ts: new Date(fakeClock.now.getTime() - 16_000) }));
  fakeClock.advance(5);
  const [, d] = await call("GET /devices/{deviceId}", { path: { deviceId: "WATER_STATION_01" } });
  assert.equal(d.online, true);
  assert.ok(d.lastReadingAt < d.lastSeen);
});

test("device list", async () => {
  await seed();
  const [, body] = await call("GET /devices");
  assert.deepEqual(body.items.map((d) => d.deviceId), ["WATER_STATION_01", "WATER_STATION_02", "WATER_STATION_03", "WATER_STATION_04"]);
  assert.equal(body.items[3].connection, "NEVER_SEEN");
  assert.equal(body.items[3].latestReadings, null);
});

test("device detail", async () => {
  await seed();
  const [code, body] = await call("GET /devices/{deviceId}", { path: { deviceId: "WATER_STATION_03" } });
  assert.equal(code, 200);
  assert.equal(body.waterStatus, "CRITICAL");
  assert.equal(body.latestReadings.ph, 5.5);
  assert.equal(body.recentAlerts.length, 1);
  assert.equal((await call("GET /devices/{deviceId}", { path: { deviceId: "WATER_STATION_77" } }))[0], 404);
  assert.equal((await call("GET /devices/{deviceId}", { path: { deviceId: "../etc" } }))[0], 400);
});

test("readings pagination, newest first", async () => {
  await seed();
  const route = "GET /devices/{deviceId}/readings";
  const path = { deviceId: "WATER_STATION_01" };
  const [code, page1] = await call(route, { path, query: { limit: "2", from: "2026-11-16T09:00:00Z" } });
  assert.equal(code, 200);
  assert.equal(page1.count, 2);
  assert.ok(page1.nextToken);
  assert.ok(page1.items[0].timestamp > page1.items[1].timestamp);
  const [, page2] = await call(route, { path, query: { limit: "2", from: "2026-11-16T09:00:00Z", nextToken: page1.nextToken } });
  assert.equal(page2.count, 1);
  assert.equal(page2.nextToken, null);
});

test("readings date filter and ascending order", async () => {
  await seed();
  const [, body] = await call("GET /devices/{deviceId}/readings", {
    path: { deviceId: "WATER_STATION_01" },
    query: { from: "2026-11-16T10:00:06Z", to: "2026-11-16T10:00:12Z", order: "asc" },
  });
  assert.deepEqual(body.items.map((r) => r.timestamp), ["2026-11-16T10:00:10.000Z"]);
});

test("readings reject bad input with 400", async () => {
  await seed();
  const bad = [{ limit: "0" }, { limit: "5000" }, { limit: "abc" }, { from: "not-a-date" },
    { from: "2026-11-16T11:00:00Z", to: "2026-11-16T10:00:00Z" }, { order: "sideways" },
    { nextToken: "%%%" }, { from: "2026-01-01T00:00:00Z" }];
  for (const query of bad) {
    const [code] = await call("GET /devices/{deviceId}/readings", { path: { deviceId: "WATER_STATION_01" }, query });
    assert.equal(code, 400, JSON.stringify(query));
  }
});

test("latest readings", async () => {
  await seed();
  const [, body] = await call("GET /readings/latest");
  const s2 = body.items.find((i) => i.deviceId === "WATER_STATION_02");
  assert.equal(s2.latestReadings.turbidity, 7);
  assert.equal(s2.latestViolations[0].severity, "WARNING");
});

test("alert listing and filters", async () => {
  await seed();
  assert.equal((await call("GET /alerts"))[1].count, 2);
  assert.equal((await call("GET /alerts", { query: { status: "active" } }))[1].count, 2);
  assert.equal((await call("GET /alerts", { query: { severity: "critical" } }))[1].items[0].deviceId, "WATER_STATION_03");
  assert.equal((await call("GET /alerts", { query: { deviceId: "WATER_STATION_02" } }))[1].items[0].parameter, "turbidity");
  assert.equal((await call("GET /alerts", { query: { deviceId: "WATER_STATION_01" } }))[1].count, 0);
  assert.equal((await call("GET /alerts", { query: { status: "nope" } }))[0], 400);
});

test("acknowledge an alert", async () => {
  await seed();
  const [, listing] = await call("GET /alerts", { query: { severity: "CRITICAL" } });
  const alertId = listing.items[0].alertId;
  const route = "PATCH /alerts/{alertId}/acknowledge";

  const [code, body] = await call(route, { path: { alertId }, body: { acknowledgedBy: "demo", note: "checked" } });
  assert.equal(code, 200);
  assert.equal(body.status, "ACKNOWLEDGED");
  assert.equal(body.acknowledgedBy, "demo");
  assert.ok(body.acknowledgedAt);

  assert.equal((await call(route, { path: { alertId } }))[0], 409);
  assert.equal((await call(route, { path: { alertId: "0".repeat(32) } }))[0], 404);
  assert.equal((await call(route, { path: { alertId: "bad" } }))[0], 400);
  assert.equal((await call("GET /dashboard/summary"))[1].activeAlerts, 1);
  assert.equal((await call("GET /alerts", { query: { status: "ACKNOWLEDGED" } }))[1].count, 1);
});

test("acknowledged alert is not re-created while the problem continues", async () => {
  await seed();
  const alertId = (await call("GET /alerts", { query: { severity: "CRITICAL" } }))[1].items[0].alertId;
  await call("PATCH /alerts/{alertId}/acknowledge", { path: { alertId } });
  await send(5, "WATER_STATION_03", { ph: 5.5 });
  assert.equal((await call("GET /alerts", { query: { deviceId: "WATER_STATION_03" } }))[1].count, 1);
});

test("hourly trends and station comparison", async () => {
  await seed();
  const [code, body] = await call("GET /analytics/trends", { query: { from: "2026-11-16T09:00:00Z", to: "2026-11-16T11:00:00Z" } });
  assert.equal(code, 200);
  assert.equal(body.granularity, "HOUR");
  const [point] = body.series.find((s) => s.deviceId === "WATER_STATION_03").points;
  assert.equal(point.bucket, "2026-11-16T10");
  assert.deepEqual([point.count, point.avg.ph, point.criticalCount], [3, 5.5, 3]);
  const comp = Object.fromEntries(body.comparison.map((c) => [c.deviceId, c]));
  assert.equal(comp.WATER_STATION_01.abnormalRate, 0);
  assert.equal(comp.WATER_STATION_03.abnormalRate, 1);
  assert.equal(comp.WATER_STATION_04.readingCount, 0);
  assert.deepEqual([body.abnormalByParameter.ph, body.abnormalByParameter.turbidity], [3, 3]);
});

test("daily trends and validation", async () => {
  await seed();
  const [code, body] = await call("GET /analytics/trends", { query: {
    granularity: "day", deviceId: "WATER_STATION_01", from: "2026-11-10T00:00:00Z", to: "2026-11-16T23:00:00Z" } });
  assert.equal(code, 200);
  assert.equal(body.series.length, 1);
  assert.equal(body.series[0].points[0].bucket, "2026-11-16");
  assert.equal((await call("GET /analytics/trends", { query: { granularity: "minute" } }))[0], 400);
  assert.equal((await call("GET /analytics/trends", { query: { from: "2026-10-01T00:00:00Z" } }))[0], 400);
  assert.equal((await call("GET /analytics/trends", { query: { deviceId: "WATER_STATION_99" } }))[0], 404);
});

test("internal errors don't leak details", async () => {
  const original = routes["GET /health"];
  routes["GET /health"] = async () => { throw new Error("arn:aws:dynamodb:secret-internal-detail"); };
  try {
    const [code, body] = await call("GET /health");
    assert.equal(code, 500);
    assert.deepEqual(body, { error: "internal server error" });
  } finally {
    routes["GET /health"] = original;
  }
});

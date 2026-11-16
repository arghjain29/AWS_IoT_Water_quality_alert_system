// REST API Lambda for the dashboard (API Gateway HTTP API -> this function).
//
//   GET   /health
//   GET   /config/thresholds
//   GET   /dashboard/summary
//   GET   /devices
//   GET   /devices/{deviceId}
//   GET   /devices/{deviceId}/readings   ?from&to&limit&order&nextToken
//   GET   /readings/latest
//   GET   /alerts                        ?status&deviceId&severity&from&to&limit&nextToken
//   PATCH /alerts/{alertId}/acknowledge  body (optional): {"acknowledgedBy": "...", "note": "..."}
//   GET   /analytics/trends              ?granularity=hour|day&from&to&deviceId
//
// List endpoints use DynamoDB Query on keys/indexes. The only Scan is on the
// tiny DeviceRegistry table (one item per station). CORS is handled by API Gateway.

import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PARAMETERS, THRESHOLDS } from "./evaluation.mjs";
import { addSeconds, clock, db, iso, log, parseIso, tables } from "./shared.mjs";

const OFFLINE_AFTER_SECONDS = Number(process.env.OFFLINE_AFTER_SECONDS ?? 20);
const DEVICE_ID = /^WATER_STATION_\d{2}$/;
const ALERT_ID = /^[0-9a-f]{32}$/;
const DAY = 86400;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

// ---- router -----------------------------------------------------------------
export const routes = {
  "GET /health": health,
  "GET /config/thresholds": thresholds,
  "GET /dashboard/summary": dashboardSummary,
  "GET /devices": listDevices,
  "GET /devices/{deviceId}": getDevice,
  "GET /devices/{deviceId}/readings": deviceReadings,
  "GET /readings/latest": latestReadings,
  "GET /alerts": listAlerts,
  "PATCH /alerts/{alertId}/acknowledge": acknowledgeAlert,
  "GET /analytics/trends": trends,
};

export async function handler(event) {
  const route = routes[event.routeKey];
  if (!route) return respond(404, { error: "not found" });
  try {
    return respond(200, await route(event));
  } catch (error) {
    if (error instanceof ApiError) return respond(error.status, { error: error.message });
    log("ERROR", "unhandled error", { route: event.routeKey, error: error.stack });
    return respond(500, { error: "internal server error" }); // never leak internal details
  }
}

// ---- request helpers -----------------------------------------------------------
const queryOf = (event) => event.queryStringParameters ?? {};

function pathParam(event, name, pattern) {
  const value = event.pathParameters?.[name] ?? "";
  if (!pattern.test(value)) throw new ApiError(400, `invalid ${name}`);
  return value;
}

function getLimit(q, fallback, max) {
  const limit = q.limit === undefined ? fallback : Number(q.limit);
  if (!Number.isInteger(limit)) throw new ApiError(400, "limit must be a number");
  if (limit < 1 || limit > max) throw new ApiError(400, `limit must be between 1 and ${max}`);
  return limit;
}

function getTimeRange(q, defaultSpanSeconds, maxSpanDays) {
  let end, start;
  try {
    end = q.to ? parseIso(q.to) : clock.now();
    start = q.from ? parseIso(q.from) : addSeconds(end, -defaultSpanSeconds);
  } catch {
    throw new ApiError(400, "from/to must be ISO-8601 timestamps, e.g. 2026-11-16T10:00:00Z");
  }
  if (start > end) throw new ApiError(400, "'from' must be before 'to'");
  if (maxSpanDays && end - start > maxSpanDays * DAY * 1000) {
    throw new ApiError(400, `time range too large (max ${maxSpanDays} days)`);
  }
  return [start, end];
}

function choice(q, name, allowed, fallback) {
  const value = (q[name] || fallback).toUpperCase();
  if (!allowed.includes(value)) throw new ApiError(400, `${name} must be one of ${allowed.join(", ")}`);
  return value;
}

// nextToken = DynamoDB's LastEvaluatedKey, as base64url JSON
const encodeToken = (key) => (key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null);

function decodeToken(token) {
  if (!token) return undefined;
  try {
    const key = JSON.parse(Buffer.from(token, "base64url").toString());
    if (typeof key !== "object" || key === null || Array.isArray(key)) throw new Error();
    return key;
  } catch {
    throw new ApiError(400, "invalid nextToken");
  }
}

// One page of up to `limit` items. Follows extra DynamoDB pages if a filter removed items.
async function pagedQuery(params, limit, token) {
  const items = [];
  let startKey = decodeToken(token);
  for (let i = 0; i < 10; i++) {
    const page = await db().send(new QueryCommand({ ...params, Limit: limit - items.length, ExclusiveStartKey: startKey }));
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
    if (!startKey || items.length >= limit) break;
  }
  return { items, count: items.length, nextToken: encodeToken(startKey) };
}

// Follow every page (used where results are small, e.g. one station's hourly totals).
async function queryAll(params) {
  const items = [];
  let startKey;
  do {
    const page = await db().send(new QueryCommand({ ...params, ExclusiveStartKey: startKey }));
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// ---- devices -----------------------------------------------------------------
async function allDevices() {
  const items = [];
  let startKey;
  do {
    const page = await db().send(new ScanCommand({ TableName: tables.registry, ExclusiveStartKey: startKey }));
    items.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

function deviceView(item, now) {
  const lastSeen = item.lastSeen ?? null;
  const online = Boolean(lastSeen) && now - parseIso(lastSeen) <= OFFLINE_AFTER_SECONDS * 1000;
  return {
    deviceId: item.deviceId,
    name: item.name,
    location: item.location,
    connection: online ? "ONLINE" : lastSeen ? "OFFLINE" : "NEVER_SEEN",
    online,
    waterStatus: lastSeen ? item.latestStatus : null,
    lastSeen, // when the cloud last received a message
    lastReadingAt: item.lastReadingAt ?? null, // device timestamp of that reading
    latestReadings: item.latestReadings ?? null,
    latestViolations: item.latestViolations ?? [],
    messageCount: item.messageCount ?? 0,
  };
}

async function health() {
  return { status: "ok", time: iso(clock.now()) };
}

async function thresholds() {
  return { parameters: THRESHOLDS, offlineAfterSeconds: OFFLINE_AFTER_SECONDS };
}

async function listDevices() {
  const now = clock.now();
  return { items: (await allDevices()).map((d) => deviceView(d, now)) };
}

async function getDevice(event) {
  const deviceId = pathParam(event, "deviceId", DEVICE_ID);
  const { Item } = await db().send(new GetCommand({ TableName: tables.registry, Key: { deviceId } }));
  if (!Item) throw new ApiError(404, "device not found");
  const recent = await db().send(new QueryCommand({
    TableName: tables.alerts,
    IndexName: "byDevice",
    KeyConditionExpression: "deviceId = :d",
    ExpressionAttributeValues: { ":d": deviceId },
    ScanIndexForward: false,
    Limit: 10,
  }));
  return { ...deviceView(Item, clock.now()), recentAlerts: recent.Items };
}

async function deviceReadings(event) {
  const deviceId = pathParam(event, "deviceId", DEVICE_ID);
  const q = queryOf(event);
  const [start, end] = getTimeRange(q, 3600, 31);
  const order = choice(q, "order", ["ASC", "DESC"], "DESC");
  return pagedQuery({
    TableName: tables.readings,
    KeyConditionExpression: "deviceId = :d AND #ts BETWEEN :from AND :to",
    ExpressionAttributeNames: { "#ts": "timestamp" }, // "timestamp" is a DynamoDB reserved word
    ExpressionAttributeValues: { ":d": deviceId, ":from": iso(start), ":to": iso(end) },
    ScanIndexForward: order === "ASC",
  }, getLimit(q, 200, 1000), q.nextToken);
}

async function latestReadings() {
  const now = clock.now();
  return {
    items: (await allDevices()).map((d) => {
      const v = deviceView(d, now);
      return {
        deviceId: v.deviceId, name: v.name, online: v.online, waterStatus: v.waterStatus,
        lastSeen: v.lastSeen, latestReadings: v.latestReadings, latestViolations: v.latestViolations,
      };
    }),
  };
}

async function countActiveAlerts() {
  let total = 0;
  let startKey;
  do {
    const page = await db().send(new QueryCommand({
      TableName: tables.alerts,
      IndexName: "byStatus",
      KeyConditionExpression: "#s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":active": "ACTIVE" },
      Select: "COUNT",
      ExclusiveStartKey: startKey,
    }));
    total += page.Count;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}

async function dashboardSummary() {
  const now = clock.now();
  const devices = (await allDevices()).map((d) => deviceView(d, now));
  const online = devices.filter((d) => d.online);
  const count = (status) => online.filter((d) => d.waterStatus === status).length;
  return {
    totalStations: devices.length,
    online: online.length,
    offline: devices.length - online.length,
    normal: count("NORMAL"),
    warning: count("WARNING"),
    critical: count("CRITICAL"),
    activeAlerts: await countActiveAlerts(),
    stations: devices,
    generatedAt: iso(now),
  };
}

// ---- alerts --------------------------------------------------------------------
async function listAlerts(event) {
  const q = queryOf(event);
  const status = choice(q, "status", ["ALL", "ACTIVE", "ACKNOWLEDGED"], "ALL");
  const severity = choice(q, "severity", ["ALL", "WARNING", "CRITICAL"], "ALL");
  const [start, end] = getTimeRange(q, 3650 * DAY);

  const names = { "#created": "createdAt" };
  const values = { ":from": iso(start), ":to": iso(end) };
  const filters = [];
  let index, keyCondition;

  if (q.deviceId) {
    if (!DEVICE_ID.test(q.deviceId)) throw new ApiError(400, "invalid deviceId");
    index = "byDevice";
    keyCondition = "deviceId = :d AND #created BETWEEN :from AND :to";
    values[":d"] = q.deviceId;
    if (status !== "ALL") {
      filters.push("#s = :status");
      names["#s"] = "status";
      values[":status"] = status;
    }
  } else if (status !== "ALL") {
    index = "byStatus";
    keyCondition = "#s = :status AND #created BETWEEN :from AND :to";
    names["#s"] = "status";
    values[":status"] = status;
  } else {
    index = "byTime";
    keyCondition = "entity = :alert AND #created BETWEEN :from AND :to";
    values[":alert"] = "ALERT";
  }
  if (severity !== "ALL") {
    filters.push("severity = :severity");
    values[":severity"] = severity;
  }

  return pagedQuery({
    TableName: tables.alerts,
    IndexName: index,
    KeyConditionExpression: keyCondition,
    FilterExpression: filters.length ? filters.join(" AND ") : undefined,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: false, // newest first
  }, getLimit(q, 50, 200), q.nextToken);
}

async function acknowledgeAlert(event) {
  const alertId = pathParam(event, "alertId", ALERT_ID);
  let body = {};
  if (event.body) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
      body = JSON.parse(raw);
    } catch {
      throw new ApiError(400, "body must be JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ApiError(400, "body must be a JSON object");
    }
  }
  // Demo scope: there is no login, so "acknowledgedBy" is a label supplied by the client, not a verified identity.
  const by = String(body.acknowledgedBy || "dashboard-operator").slice(0, 100);
  const note = String(body.note || "").slice(0, 500);

  try {
    const result = await db().send(new UpdateCommand({
      TableName: tables.alerts,
      Key: { alertId },
      UpdateExpression: "SET #s = :ack, acknowledgedAt = :now, acknowledgedBy = :by, #note = :note",
      ConditionExpression: "attribute_exists(alertId) AND #s = :active",
      ExpressionAttributeNames: { "#s": "status", "#note": "note" },
      ExpressionAttributeValues: {
        ":ack": "ACKNOWLEDGED", ":active": "ACTIVE", ":now": iso(clock.now()), ":by": by, ":note": note,
      },
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes;
  } catch (error) {
    if (error.name !== "ConditionalCheckFailedException") throw error;
    const { Item } = await db().send(new GetCommand({ TableName: tables.alerts, Key: { alertId } }));
    if (!Item) throw new ApiError(404, "alert not found");
    throw new ApiError(409, "alert is already acknowledged");
  }
}

// ---- analytics -------------------------------------------------------------------
const bucketToIso = (bucket) => bucket + (bucket.length === 10 ? "T00:00:00.000Z" : ":00:00.000Z");
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

async function trends(event) {
  const q = queryOf(event);
  const granularity = choice(q, "granularity", ["HOUR", "DAY"], "HOUR");
  const [start, end] = granularity === "HOUR"
    ? getTimeRange(q, DAY, 8)
    : getTimeRange(q, 7 * DAY, 366);
  const cut = granularity === "HOUR" ? 13 : 10; // "2026-11-16T10" or "2026-11-16"

  let devices = await allDevices();
  if (q.deviceId) {
    devices = devices.filter((d) => d.deviceId === q.deviceId);
    if (!devices.length) throw new ApiError(404, "device not found");
  }

  const series = [];
  const comparison = [];
  const abnormalByParameter = Object.fromEntries(PARAMETERS.map((p) => [p, 0]));

  for (const d of devices) {
    const rows = await queryAll({
      TableName: tables.aggregates,
      KeyConditionExpression: "seriesKey = :k AND #b BETWEEN :from AND :to",
      ExpressionAttributeNames: { "#b": "bucket" },
      ExpressionAttributeValues: {
        ":k": `${d.deviceId}#${granularity}`, ":from": iso(start).slice(0, cut), ":to": iso(end).slice(0, cut),
      },
    });

    const totals = { count: 0, warning: 0, critical: 0, sums: Object.fromEntries(PARAMETERS.map((p) => [p, 0])) };
    const points = rows.map((r) => {
      const n = r.readingCount;
      totals.count += n;
      totals.warning += r.warningCount;
      totals.critical += r.criticalCount;
      for (const p of PARAMETERS) {
        totals.sums[p] += r[`sum_${p}`];
        abnormalByParameter[p] += r[`abn_${p}`];
      }
      return {
        bucket: r.bucket,
        timestamp: bucketToIso(r.bucket),
        count: n,
        avg: Object.fromEntries(PARAMETERS.map((p) => [p, round(r[`sum_${p}`] / n, 2)])),
        warningCount: r.warningCount,
        criticalCount: r.criticalCount,
        abnormal: Object.fromEntries(PARAMETERS.map((p) => [p, r[`abn_${p}`]])),
      };
    });

    const n = totals.count;
    series.push({ deviceId: d.deviceId, name: d.name, points });
    comparison.push({
      deviceId: d.deviceId,
      name: d.name,
      readingCount: n,
      avg: Object.fromEntries(PARAMETERS.map((p) => [p, n ? round(totals.sums[p] / n, 2) : null])),
      warningCount: totals.warning,
      criticalCount: totals.critical,
      abnormalRate: n ? round((totals.warning + totals.critical) / n, 4) : 0,
    });
  }

  return { granularity, from: iso(start), to: iso(end), series, comparison, abnormalByParameter };
}

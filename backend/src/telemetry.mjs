// Telemetry processor Lambda: invoked by the AWS IoT rule for every MQTT message.
//
// Steps for each message:
//   1. validate the payload
//   2. check the device exists in DeviceRegistry
//   3. evaluate the readings against the thresholds
//   4. store the reading (WaterReadings) and update hourly/daily totals (WaterReadingAggregates)
//   5. create or update alerts (WaterAlerts), with de-duplication
//   6. update the device's last-seen time and latest readings (DeviceRegistry)
//
// Alert de-duplication rule:
//   While a station+parameter stays abnormal, the SAME alert is updated
//   (occurrence count, latest value). A new alert is created only after the
//   parameter has been normal for ALERT_COOLDOWN_MINUTES, or when it gets worse
//   (WARNING -> CRITICAL).

import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PARAMETERS, THRESHOLDS, evaluate } from "./evaluation.mjs";
import { clock, db, iso, log, parseIso, tables } from "./shared.mjs";

const DEVICE_ID = /^WATER_STATION_\d{2}$/;
const READINGS_TTL_DAYS = Number(process.env.READINGS_TTL_DAYS ?? 14);
const AGGREGATE_HOUR_TTL_DAYS = 90;
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MINUTES ?? 10) * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 24 * 3600_000;
const SEVERITY_RANK = { WARNING: 1, CRITICAL: 2 };

const isConditionFailure = (error) => error.name === "ConditionalCheckFailedException";
const epochSecondsIn = (days) => Math.floor(clock.now().getTime() / 1000) + days * 86400;

export async function handler(event) {
  let msg;
  try {
    msg = validate(event);
  } catch (error) {
    log("WARN", "REJECTED telemetry", { reason: error.message, payload: JSON.stringify(event)?.slice(0, 500) });
    return { result: "rejected", reason: error.message };
  }
  return processMessage(msg);
}

// ---- 1. validation ---------------------------------------------------------
export function validate(event) {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new Error("payload must be a JSON object");
  }

  const deviceId = event.deviceId;
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) throw new Error("deviceId missing or invalid");
  // topicDeviceId is added by the IoT rule from the MQTT topic; they must agree
  if (event.topicDeviceId !== undefined && event.topicDeviceId !== deviceId) {
    throw new Error("deviceId does not match the MQTT topic");
  }

  let ts;
  try {
    ts = parseIso(event.timestamp);
  } catch {
    throw new Error("timestamp missing or not ISO-8601 UTC");
  }
  const now = clock.now().getTime();
  if (ts.getTime() > now + MAX_CLOCK_SKEW_MS) throw new Error("timestamp is in the future");
  if (ts.getTime() < now - MAX_AGE_MS) throw new Error("timestamp is older than 24 hours");

  const readings = event.readings;
  if (typeof readings !== "object" || readings === null || Array.isArray(readings)) {
    throw new Error("readings must be an object");
  }
  const clean = {};
  for (const p of PARAMETERS) {
    const v = readings[p];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`readings.${p} missing or not a number`);
    const valid = THRESHOLDS[p].validRange;
    if (v < valid.min || v > valid.max) throw new Error(`readings.${p}=${v} outside the physically valid range`);
    clean[p] = v;
  }

  return {
    deviceId,
    ts,
    timestamp: iso(ts),
    readings: clean,
    seq: Number.isInteger(event.seq) ? event.seq : null,
    simulated: event.simulated !== false,
  };
}

// ---- 2..6 processing --------------------------------------------------------
async function processMessage(msg) {
  const { Item: device } = await db().send(new GetCommand({ TableName: tables.registry, Key: { deviceId: msg.deviceId } }));
  if (!device) {
    log("WARN", "REJECTED telemetry from unregistered device", { deviceId: msg.deviceId });
    return { result: "unknown_device" };
  }

  const { status, violations } = evaluate(msg.readings);

  if (!(await storeReading(msg, status, violations))) {
    log("INFO", "duplicate message ignored", { deviceId: msg.deviceId, timestamp: msg.timestamp });
    return { result: "duplicate" };
  }
  await updateAggregates(msg, status, violations);

  if (device.lastReadingAt && device.lastReadingAt >= msg.timestamp) {
    // An older message arrived late: keep it in history but don't touch latest state/alerts.
    return { result: "stored_out_of_order", status };
  }

  const alertState = device.alertState ?? {};
  const created = await handleAlerts(device, msg, violations, alertState);
  await updateDevice(msg, status, violations, alertState);

  // The readings are included so the CloudWatch dashboard can chart them from the logs.
  log("INFO", "processed", {
    deviceId: msg.deviceId, timestamp: msg.timestamp, status, alertsCreated: created.length, ...msg.readings,
  });
  return { result: "stored", status, alertsCreated: created };
}

// Returns false if this exact message was already stored (MQTT can deliver twice).
async function storeReading(msg, status, violations) {
  try {
    await db().send(new PutCommand({
      TableName: tables.readings,
      Item: {
        deviceId: msg.deviceId,
        timestamp: msg.timestamp,
        readings: msg.readings,
        status,
        violations: violations.map((v) => ({ parameter: v.parameter, severity: v.severity })),
        seq: msg.seq,
        simulated: msg.simulated,
        receivedAt: iso(clock.now()),
        expiresAt: epochSecondsIn(READINGS_TTL_DAYS), // DynamoDB deletes it automatically after this
      },
      ConditionExpression: "attribute_not_exists(deviceId)",
    }));
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

// Add this reading to its hour and day totals, so trend charts never read raw data.
async function updateAggregates(msg, status, violations) {
  const abnormal = new Set(violations.map((v) => v.parameter));
  const values = {
    ":one": 1,
    ":w": status === "WARNING" ? 1 : 0,
    ":c": status === "CRITICAL" ? 1 : 0,
    ":dev": msg.deviceId,
  };
  const adds = ["readingCount :one", "warningCount :w", "criticalCount :c"];
  for (const p of PARAMETERS) {
    values[`:${p}`] = msg.readings[p];
    values[`:a_${p}`] = abnormal.has(p) ? 1 : 0;
    adds.push(`sum_${p} :${p}`, `abn_${p} :a_${p}`);
  }

  const buckets = [
    ["HOUR", msg.timestamp.slice(0, 13)], // "2026-11-16T10"
    ["DAY", msg.timestamp.slice(0, 10)],  // "2026-11-16"
  ];
  for (const [granularity, bucket] of buckets) {
    let sets = "deviceId = :dev";
    const vals = { ...values };
    if (granularity === "HOUR") {
      sets += ", expiresAt = if_not_exists(expiresAt, :exp)";
      vals[":exp"] = epochSecondsIn(AGGREGATE_HOUR_TTL_DAYS);
    }
    await db().send(new UpdateCommand({
      TableName: tables.aggregates,
      Key: { seriesKey: `${msg.deviceId}#${granularity}`, bucket },
      UpdateExpression: `SET ${sets} ADD ${adds.join(", ")}`,
      ExpressionAttributeValues: vals,
    }));
  }
}

async function handleAlerts(device, msg, violations, alertState) {
  const created = [];
  for (const v of violations) {
    const current = alertState[v.parameter];
    const sameEpisode = current && msg.ts - parseIso(current.lastAbnormalAt) < COOLDOWN_MS;
    const gotWorse = current && SEVERITY_RANK[v.severity] > SEVERITY_RANK[current.severity];

    if (sameEpisode && !gotWorse) {
      await touchAlert(current.alertId, v, msg);
      current.lastAbnormalAt = msg.timestamp;
    } else {
      const alertId = await createAlert(device, msg, v);
      alertState[v.parameter] = { alertId, severity: v.severity, lastAbnormalAt: msg.timestamp };
      created.push(alertId);
    }
  }
  return created;
}

async function createAlert(device, msg, v) {
  const alertId = randomUUID().replaceAll("-", "");
  await db().send(new PutCommand({
    TableName: tables.alerts,
    Item: {
      alertId,
      entity: "ALERT", // constant key for the "all alerts by time" index
      deviceId: msg.deviceId,
      deviceName: device.name ?? msg.deviceId,
      location: device.location ?? "",
      parameter: v.parameter,
      parameterLabel: v.label,
      unit: v.unit,
      severity: v.severity,
      status: "ACTIVE",
      value: v.value,
      lastValue: v.value,
      limit: v.limit,
      direction: v.direction,
      message: v.message,
      createdAt: msg.timestamp,
      lastAbnormalAt: msg.timestamp,
      occurrences: 1,
      simulated: msg.simulated,
    },
  }));
  log("WARN", "ALERT", {
    alertId, severity: v.severity, deviceId: msg.deviceId, parameter: v.parameter, value: v.value, description: v.message,
  });
  return alertId;
}

async function touchAlert(alertId, v, msg) {
  try {
    await db().send(new UpdateCommand({
      TableName: tables.alerts,
      Key: { alertId },
      UpdateExpression: "SET lastValue = :v, lastAbnormalAt = :t ADD occurrences :one",
      ConditionExpression: "attribute_exists(alertId)",
      ExpressionAttributeValues: { ":v": v.value, ":t": msg.timestamp, ":one": 1 },
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
  }
}

// lastSeen      = when the CLOUD received it (used for online/offline; device clocks can be wrong)
// lastReadingAt = the device's own timestamp (used to ignore late, out-of-order messages)
async function updateDevice(msg, status, violations, alertState) {
  const latestViolations = violations.map(({ parameter, severity, value, limit, direction, message }) =>
    ({ parameter, severity, value, limit, direction, message }));
  try {
    await db().send(new UpdateCommand({
      TableName: tables.registry,
      Key: { deviceId: msg.deviceId },
      UpdateExpression:
        "SET lastSeen = :now, lastReadingAt = :ts, latestReadings = :r, latestStatus = :s, " +
        "latestViolations = :v, alertState = :a ADD messageCount :one",
      // never let an older message overwrite newer state
      ConditionExpression: "attribute_not_exists(lastReadingAt) OR lastReadingAt < :ts",
      ExpressionAttributeValues: {
        ":now": iso(clock.now()), ":ts": msg.timestamp, ":r": msg.readings, ":s": status,
        ":v": latestViolations, ":a": alertState, ":one": 1,
      },
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
  }
}

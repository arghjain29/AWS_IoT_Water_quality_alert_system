// MOCK MODE ONLY. Generates sample data with the same shape as the real API so
// the dashboard can be developed without AWS. The UI shows a "Mock data" banner
// whenever this is used. Nothing here is real or sent anywhere.

import thresholdsFile from "../../../config/thresholds.json";
import stationsFile from "../../../config/stations.json";

const THRESHOLDS = thresholdsFile.parameters;
const PARAMS = Object.keys(THRESHOLDS);
const STATIONS = stationsFile.stations;
const START = Date.now() - 24 * 3600_000;
const STEP = 5000;

// Scripted conditions so mock mode shows every state.
const SCENARIO = {
  WATER_STATION_02: { param: "turbidity", value: 7.4 }, // warning
  WATER_STATION_03: { param: "ph", value: 5.7 },        // critical
};
const OFFLINE = "WATER_STATION_04";

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function evaluate(readings) {
  const violations = [];
  for (const p of PARAMS) {
    const { normal, critical, label, unit } = THRESHOLDS[p];
    const v = readings[p];
    let severity, limit, direction;
    if (critical.min !== null && v < critical.min) [severity, limit, direction] = ["CRITICAL", critical.min, "below"];
    else if (critical.max !== null && v > critical.max) [severity, limit, direction] = ["CRITICAL", critical.max, "above"];
    else if (v < normal.min) [severity, limit, direction] = ["WARNING", normal.min, "below"];
    else if (v > normal.max) [severity, limit, direction] = ["WARNING", normal.max, "above"];
    else continue;
    const u = unit ? ` ${unit}` : "";
    violations.push({ parameter: p, severity, value: v, limit, direction,
      message: `${label} ${v}${u} is ${direction} the ${severity === "CRITICAL" ? "critical" : "normal"} limit of ${limit}${u}` });
  }
  const status = violations.some((x) => x.severity === "CRITICAL") ? "CRITICAL" : violations.length ? "WARNING" : "NORMAL";
  return { status, violations };
}

function readingAt(station, t) {
  const rand = seeded(Math.floor(t / STEP) + station.deviceId.charCodeAt(15) * 7919);
  const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
  const out = {};
  for (const p of PARAMS) {
    const prof = station.profile[p];
    let v = prof.baseline + prof.diurnal * Math.sin((2 * Math.PI * (hour - 9)) / 24) + (rand() - 0.5) * prof.noise * 4;
    const sc = SCENARIO[station.deviceId];
    // anomaly during the last 20 minutes
    if (sc && sc.param === p && t > Date.now() - 20 * 60_000) v = sc.value + (rand() - 0.5) * prof.noise;
    const d = THRESHOLDS[p].decimals;
    out[p] = d === 0 ? Math.round(v) : Number(v.toFixed(d));
  }
  return out;
}

const iso = (t) => new Date(t).toISOString();
const lastTime = (id) => {
  const now = Math.floor(Date.now() / STEP) * STEP;
  return id === OFFLINE ? now - 4 * 60_000 : now;
};

function device(station) {
  const t = lastTime(station.deviceId);
  const r = readingAt(station, t);
  const { status, violations } = evaluate(r);
  const online = station.deviceId !== OFFLINE;
  return {
    deviceId: station.deviceId, name: station.name, location: station.location,
    connection: online ? "ONLINE" : "OFFLINE", online, waterStatus: status,
    lastSeen: iso(t), lastReadingAt: iso(t), latestReadings: r, latestViolations: violations,
    messageCount: Math.floor((t - START) / STEP),
  };
}

const acknowledged = new Map();
function alerts() {
  const list = Object.entries(SCENARIO).map(([id, sc], i) => {
    const station = STATIONS.find((s) => s.deviceId === id);
    const t = Date.now() - 20 * 60_000 + i * 1000;
    const r = readingAt(station, Math.floor(Date.now() / STEP) * STEP);
    const { violations } = evaluate({ ...r, [sc.param]: sc.value });
    const v = violations.find((x) => x.parameter === sc.param);
    const alertId = `${"0".repeat(31)}${i + 1}`;
    return {
      alertId, entity: "ALERT", deviceId: id, deviceName: station.name, location: station.location,
      parameter: sc.param, parameterLabel: THRESHOLDS[sc.param].label, unit: THRESHOLDS[sc.param].unit,
      severity: v.severity, status: acknowledged.has(alertId) ? "ACKNOWLEDGED" : "ACTIVE",
      value: sc.value, lastValue: r[sc.param], limit: v.limit, direction: v.direction, message: v.message,
      createdAt: iso(t), lastAbnormalAt: iso(Date.now()), occurrences: 240, simulated: true,
      ...(acknowledged.get(alertId) ?? {}),
    };
  });
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const delay = (value) => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), 150));

export const mockApi = {
  health: () => delay({ status: "ok", time: iso(Date.now()) }),
  thresholds: () => delay({ parameters: THRESHOLDS, offlineAfterSeconds: 20 }),
  devices: () => delay({ items: STATIONS.map(device) }),
  latest: () => delay({ items: STATIONS.map(device) }),
  summary() {
    const devices = STATIONS.map(device);
    const online = devices.filter((d) => d.online);
    const count = (s) => online.filter((d) => d.waterStatus === s).length;
    return delay({
      totalStations: devices.length, online: online.length, offline: devices.length - online.length,
      normal: count("NORMAL"), warning: count("WARNING"), critical: count("CRITICAL"),
      activeAlerts: alerts().filter((a) => a.status === "ACTIVE").length, stations: devices, generatedAt: iso(Date.now()),
    });
  },
  device(id) {
    const station = STATIONS.find((s) => s.deviceId === id);
    if (!station) return Promise.reject(Object.assign(new Error("device not found"), { status: 404 }));
    return delay({ ...device(station), recentAlerts: alerts().filter((a) => a.deviceId === id) });
  },
  readings(id, { from, to, order = "desc", limit = 200 } = {}) {
    const station = STATIONS.find((s) => s.deviceId === id);
    const end = Math.min(to ? Date.parse(to) : Date.now(), lastTime(id));
    const start = Math.max(from ? Date.parse(from) : end - 3600_000, START);
    const items = [];
    for (let t = Math.ceil(start / STEP) * STEP; t <= end && items.length < 5000; t += STEP) {
      const r = readingAt(station, t);
      const { status, violations } = evaluate(r);
      items.push({ deviceId: id, timestamp: iso(t), readings: r, status,
        violations: violations.map(({ parameter, severity }) => ({ parameter, severity })) });
    }
    if (order.toLowerCase() === "desc") items.reverse();
    const page = items.slice(0, limit);
    return delay({ items: page, count: page.length, nextToken: null });
  },
  alerts({ status = "ALL", severity = "ALL", deviceId } = {}) {
    const items = alerts().filter((a) =>
      (status === "ALL" || a.status === status.toUpperCase()) &&
      (severity === "ALL" || a.severity === severity.toUpperCase()) &&
      (!deviceId || a.deviceId === deviceId));
    return delay({ items, count: items.length, nextToken: null });
  },
  acknowledge(id, body = {}) {
    if (acknowledged.has(id)) return Promise.reject(Object.assign(new Error("alert is already acknowledged"), { status: 409 }));
    acknowledged.set(id, { acknowledgedAt: iso(Date.now()), acknowledgedBy: body.acknowledgedBy ?? "dashboard-operator" });
    return delay(alerts().find((a) => a.alertId === id));
  },
  trends({ granularity = "HOUR", deviceId } = {}) {
    const hourly = granularity.toUpperCase() === "HOUR";
    const size = hourly ? 3600_000 : 86400_000;
    const buckets = hourly ? 24 : 7;
    const end = Math.floor(Date.now() / size) * size;
    const stations = deviceId ? STATIONS.filter((s) => s.deviceId === deviceId) : STATIONS;
    const abnormalByParameter = Object.fromEntries(PARAMS.map((p) => [p, 0]));
    const series = [];
    const comparison = [];
    for (const s of stations) {
      const points = [];
      for (let i = buckets - 1; i >= 0; i--) {
        const t = end - i * size;
        const r = readingAt(s, t + size / 2);
        const last = i === 0 && SCENARIO[s.deviceId];
        const count = hourly ? 720 : 17280;
        const abn = last ? Math.round(count * 0.3) : 0;
        if (last) abnormalByParameter[SCENARIO[s.deviceId].param] += abn;
        points.push({
          bucket: iso(t).slice(0, hourly ? 13 : 10), timestamp: iso(t), count, avg: r,
          warningCount: last && evaluate(r).status !== "CRITICAL" ? abn : 0, criticalCount: last && s.deviceId === "WATER_STATION_03" ? abn : 0,
          abnormal: Object.fromEntries(PARAMS.map((p) => [p, last && SCENARIO[s.deviceId].param === p ? abn : 0])),
        });
      }
      const n = points.reduce((a, p) => a + p.count, 0);
      const bad = points.reduce((a, p) => a + p.warningCount + p.criticalCount, 0);
      series.push({ deviceId: s.deviceId, name: s.name, points });
      comparison.push({
        deviceId: s.deviceId, name: s.name, readingCount: n,
        avg: Object.fromEntries(PARAMS.map((p) => [p, Number((points.reduce((a, x) => a + x.avg[p], 0) / points.length).toFixed(2))])),
        warningCount: points.reduce((a, p) => a + p.warningCount, 0), criticalCount: points.reduce((a, p) => a + p.criticalCount, 0),
        abnormalRate: Number((bad / n).toFixed(4)),
      });
    }
    return delay({ granularity: hourly ? "HOUR" : "DAY", from: iso(end - (buckets - 1) * size), to: iso(Date.now()), series, comparison, abnormalByParameter });
  },
};

// Loads history for charts. Short ranges use raw readings (every 5 s); long ranges
// use the hourly/daily averages the cloud pre-computes (WaterReadingAggregates),
// so a 7-day chart is ~170 points instead of ~120,000.
import { allReadings, api } from "./api";
import { PARAMETERS } from "./config";

export const RANGES = [
  { key: "15m", label: "15 min", seconds: 15 * 60 },
  { key: "1h", label: "1 hour", seconds: 3600 },
  { key: "6h", label: "6 hours", seconds: 6 * 3600 },
  { key: "24h", label: "24 hours", seconds: 24 * 3600 },
  { key: "7d", label: "7 days", seconds: 7 * 86400 },
];

const RAW_LIMIT_SECONDS = 6 * 3600;

// Returns { resolution: "raw" | "hour" | "day", byDevice: { [id]: [{ t, values: {ph,...}, status? }] } }
export async function loadHistory(deviceIds, from, to) {
  const span = (to - from) / 1000;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  if (span <= RAW_LIMIT_SECONDS) {
    const lists = await Promise.all(deviceIds.map((id) => allReadings(id, fromIso, toIso)));
    const byDevice = Object.fromEntries(deviceIds.map((id, i) => [id, lists[i].map((r) => ({
      t: Date.parse(r.timestamp), values: r.readings, status: r.status, timestamp: r.timestamp,
    }))]));
    return { resolution: "raw", byDevice };
  }

  const granularity = span <= 8 * 86400 ? "hour" : "day";
  const results = await Promise.all(deviceIds.map((id) => api.trends({ granularity, from: fromIso, to: toIso, deviceId: id })));
  const byDevice = Object.fromEntries(deviceIds.map((id, i) => [id, (results[i].series[0]?.points ?? []).map((p) => ({
    t: Date.parse(p.timestamp), values: p.avg, count: p.count, timestamp: p.timestamp,
    abnormal: p.warningCount + p.criticalCount,
  }))]));
  return { resolution: granularity, byDevice };
}

export const bucketFor = (resolution) => ({ raw: 5000, hour: 3600_000, day: 86400_000 })[resolution];

export function seriesFor(param, deviceIds, byDevice, meta) {
  return deviceIds.map((id) => ({
    key: id,
    name: meta[id]?.name ?? id,
    color: meta[id]?.color,
    points: (byDevice[id] ?? []).filter((p) => typeof p.values?.[param] === "number").map((p) => ({ t: p.t, value: p.values[param] })),
  }));
}

export { PARAMETERS };

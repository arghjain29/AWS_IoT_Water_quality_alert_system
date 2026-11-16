// All calls the dashboard makes. In live mode they go to API Gateway; in mock
// mode the same functions return generated data with the same shape.

import { API_BASE_URL, DATA_MODE } from "./config";

// Mock data is only downloaded in mock mode, so live builds never ship it.
const mockModule = DATA_MODE === "mock" ? import("./mock") : null;
const mockApi = new Proxy({}, {
  get: (_, name) => async (...args) => (await mockModule).mockApi[name](...args),
});

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, { params, body } = {}) {
  const url = new URL(API_BASE_URL + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Cannot reach the API. Check your connection or the API URL.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? `Request failed (${response.status})`, response.status);
  return data;
}

const liveApi = {
  health: () => request("GET", "/health"),
  thresholds: () => request("GET", "/config/thresholds"),
  summary: () => request("GET", "/dashboard/summary"),
  devices: () => request("GET", "/devices"),
  device: (id) => request("GET", `/devices/${encodeURIComponent(id)}`),
  readings: (id, params) => request("GET", `/devices/${encodeURIComponent(id)}/readings`, { params }),
  latest: () => request("GET", "/readings/latest"),
  alerts: (params) => request("GET", "/alerts", { params }),
  acknowledge: (id, body) => request("PATCH", `/alerts/${encodeURIComponent(id)}/acknowledge`, { body }),
  trends: (params) => request("GET", "/analytics/trends", { params }),
};

export const api = DATA_MODE === "mock" ? mockApi : liveApi;

// Fetch every page of a device's readings in a time range (oldest first).
export async function allReadings(deviceId, from, to, maxPages = 10) {
  const items = [];
  let nextToken;
  for (let page = 0; page < maxPages; page++) {
    const res = await api.readings(deviceId, { from, to, order: "asc", limit: 1000, nextToken });
    items.push(...res.items);
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return items;
}

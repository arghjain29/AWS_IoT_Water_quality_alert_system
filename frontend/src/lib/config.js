// App-wide settings, read from Vite environment variables (frontend/.env.local).

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

// "live" talks to the real AWS API. "mock" uses generated sample data and is
// shown with a clear banner. Mock is used if asked for, or if no API URL is set.
export const DATA_MODE = import.meta.env.VITE_DATA_MODE === "mock" || !API_BASE_URL ? "mock" : "live";

export const POLL_MS = 5000; // dashboard refresh interval (spec: 3-5 s)

// Local simulator control endpoint (only reachable from the machine running the simulator)
export const SIM_CONTROL_URL = (import.meta.env.VITE_SIM_CONTROL_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");

export const PARAMETERS = ["ph", "turbidity", "tds", "temperature"];

// Fixed station -> color mapping (validated categorical slots 1-4).
// A station keeps its color on every chart, whatever is filtered.
export const STATION_COLORS = {
  WATER_STATION_01: "#2a78d6", // blue
  WATER_STATION_02: "#eb6834", // orange
  WATER_STATION_03: "#1baf7a", // aqua
  WATER_STATION_04: "#eda100", // yellow
};

export const stationColor = (id) => STATION_COLORS[id] ?? "#898781";
export const shortStation = (id) => (id ? `Station ${id.slice(-2)}` : "");

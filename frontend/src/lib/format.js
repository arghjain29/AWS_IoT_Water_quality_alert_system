// Formatting and export helpers.

const LABELS = {
  ph: { label: "pH", unit: "", decimals: 2 },
  turbidity: { label: "Turbidity", unit: "NTU", decimals: 2 },
  tds: { label: "TDS", unit: "mg/L", decimals: 0 },
  temperature: { label: "Temperature", unit: "°C", decimals: 1 },
};

export const paramLabel = (p) => LABELS[p]?.label ?? p;
export const paramUnit = (p) => LABELS[p]?.unit ?? "";

export function formatValue(param, value, withUnit = true) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const { decimals = 2, unit = "" } = LABELS[param] ?? {};
  const text = Number(value).toFixed(decimals);
  return withUnit && unit ? `${text} ${unit}` : text;
}

export function formatTime(iso, withDate = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  return withDate
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---- CSV export ---------------------------------------------------------------
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Quote when needed, and neutralise spreadsheet formulas (=, +, -, @) for safety.
  const safe = /^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function downloadCsv(filename, columns, rows) {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

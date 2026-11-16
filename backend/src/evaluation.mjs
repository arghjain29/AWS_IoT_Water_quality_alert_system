// Water-quality evaluation: compares readings against the configurable thresholds.
//
//   NORMAL   - every parameter is inside its normal range
//   WARNING  - at least one parameter is outside its normal range
//   CRITICAL - at least one parameter is outside its critical range
//
// These are demonstration thresholds from thresholds.json, not a regulatory
// standard. They flag abnormal readings; they do not prove water is safe or
// identify specific contaminants.

import { existsSync, readFileSync } from "node:fs";

// In Lambda, thresholds.json is packaged next to this file; locally use ../../config
let file = new URL("./thresholds.json", import.meta.url);
if (!existsSync(file)) file = new URL("../../config/thresholds.json", import.meta.url);

export const THRESHOLDS = JSON.parse(readFileSync(file, "utf8")).parameters;
export const PARAMETERS = Object.keys(THRESHOLDS); // ph, turbidity, tds, temperature

export function evaluate(readings, thresholds = THRESHOLDS) {
  const violations = [];

  for (const [param, t] of Object.entries(thresholds)) {
    const value = readings[param];
    const { normal, critical } = t;
    let severity, limit, direction;

    if (critical.min !== null && value < critical.min) [severity, limit, direction] = ["CRITICAL", critical.min, "below"];
    else if (critical.max !== null && value > critical.max) [severity, limit, direction] = ["CRITICAL", critical.max, "above"];
    else if (normal.min !== null && value < normal.min) [severity, limit, direction] = ["WARNING", normal.min, "below"];
    else if (normal.max !== null && value > normal.max) [severity, limit, direction] = ["WARNING", normal.max, "above"];
    else continue; // within limits

    const unit = t.unit ? ` ${t.unit}` : "";
    const kind = severity === "CRITICAL" ? "critical" : "normal";
    const show = (n) => n.toFixed(t.decimals); // e.g. pH 9.30, limit 9.00 (configured decimals)
    violations.push({
      parameter: param,
      label: t.label,
      unit: t.unit,
      value,
      severity,
      limit,
      direction,
      message: `${t.label} ${show(value)}${unit} is ${direction} the ${kind} limit of ${show(limit)}${unit}`,
    });
  }

  let status = "NORMAL";
  if (violations.some((v) => v.severity === "CRITICAL")) status = "CRITICAL";
  else if (violations.length > 0) status = "WARNING";
  return { status, violations };
}

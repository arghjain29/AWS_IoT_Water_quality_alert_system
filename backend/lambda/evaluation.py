"""Water-quality evaluation: compares readings against the configurable thresholds.

NORMAL   - every parameter is inside its normal range
WARNING  - at least one parameter is outside its normal range
CRITICAL - at least one parameter is outside its critical range

These are demonstration thresholds from thresholds.json, not a regulatory
standard. They indicate abnormal readings; they do not prove water is safe or
identify specific contaminants.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
# In Lambda, thresholds.json is packaged next to this file; locally use ../../config
_THRESHOLDS_FILE = HERE / "thresholds.json"
if not _THRESHOLDS_FILE.exists():
    _THRESHOLDS_FILE = HERE.parent.parent / "config" / "thresholds.json"

THRESHOLDS = json.loads(_THRESHOLDS_FILE.read_text(encoding="utf-8"))["parameters"]
PARAMETERS = list(THRESHOLDS)  # ph, turbidity, tds, temperature


def evaluate(readings, thresholds=THRESHOLDS):
    """Return (status, violations). Each violation explains which parameter triggered it."""
    violations = []
    for param, t in thresholds.items():
        value = readings[param]
        normal, critical = t["normal"], t["critical"]

        if critical["min"] is not None and value < critical["min"]:
            severity, limit, direction = "CRITICAL", critical["min"], "below"
        elif critical["max"] is not None and value > critical["max"]:
            severity, limit, direction = "CRITICAL", critical["max"], "above"
        elif normal["min"] is not None and value < normal["min"]:
            severity, limit, direction = "WARNING", normal["min"], "below"
        elif normal["max"] is not None and value > normal["max"]:
            severity, limit, direction = "WARNING", normal["max"], "above"
        else:
            continue

        unit = f" {t['unit']}" if t["unit"] else ""
        kind = "critical" if severity == "CRITICAL" else "normal"
        violations.append({
            "parameter": param,
            "label": t["label"],
            "unit": t["unit"],
            "value": value,
            "severity": severity,
            "limit": limit,
            "direction": direction,
            "message": f"{t['label']} {value}{unit} is {direction} the {kind} limit of {limit}{unit}",
        })

    if any(v["severity"] == "CRITICAL" for v in violations):
        status = "CRITICAL"
    elif violations:
        status = "WARNING"
    else:
        status = "NORMAL"
    return status, violations

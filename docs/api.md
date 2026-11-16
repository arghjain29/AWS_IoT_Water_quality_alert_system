# API Reference

Base URL: `terraform output api_url`, for example `https://xxxxxxxxxx.execute-api.ap-south-1.amazonaws.com`.

- **Format:** all responses are JSON, and timestamps are ISO-8601 UTC (`2026-11-16T10:00:00.123Z`).
- **CORS:** allows the local dashboard origin (`http://localhost:5173`).
- **Throttling:** API Gateway allows 20 requests/s, with bursts of 40.

## Errors

| Status | When | Body |
|---|---|---|
| `400` | Invalid input (bad ID, date, limit, filter or `nextToken`) | `{"error": "limit must be between 1 and 1000"}` |
| `404` | Unknown route, station or alert | `{"error": "device not found"}` |
| `409` | Alert already acknowledged | `{"error": "alert is already acknowledged"}` |
| `500` | Unexpected error (details logged, never returned) | `{"error": "internal server error"}` |

## Pagination

List endpoints return:
- `items`;
- `count`;
- `nextToken`: pass it back as `?nextToken=` for the next page. It is `null` on the last page.

---

### `GET /health`
```json
{ "status": "ok", "time": "2026-11-16T10:00:00.000Z" }
```

### `GET /config/thresholds`
The contents of `config/thresholds.json` (normal and critical limits, units, decimals, valid ranges), plus `offlineAfterSeconds`.

### `GET /dashboard/summary`
```json
{
  "totalStations": 4, "online": 3, "offline": 1,
  "normal": 1, "warning": 1, "critical": 1,
  "activeAlerts": 3,
  "stations": [ /* same objects as GET /devices */ ],
  "generatedAt": "2026-11-16T10:00:00.000Z"
}
```
`normal`, `warning` and `critical` count **online** stations only.

### `GET /devices`
```json
{
  "items": [{
    "deviceId": "WATER_STATION_03",
    "name": "Industrial Water Storage",
    "location": "Industrial Water Storage",
    "connection": "ONLINE",            // ONLINE | OFFLINE | NEVER_SEEN
    "online": true,
    "waterStatus": "CRITICAL",         // NORMAL | WARNING | CRITICAL | null
    "lastSeen": "2026-11-16T10:00:05.120Z",       // when the cloud received the last message
    "lastReadingAt": "2026-11-16T10:00:04.987Z",  // the device's own timestamp
    "latestReadings": { "ph": 5.76, "turbidity": 3.77, "tds": 424, "temperature": 29.9 },
    "latestViolations": [{
      "parameter": "ph", "severity": "CRITICAL", "value": 5.76, "limit": 6, "direction": "below",
      "message": "pH 5.76 is below the critical limit of 6.00"
    }],
    "messageCount": 835
  }]
}
```

### `GET /devices/{deviceId}`
The same object as above, plus `recentAlerts` (up to 10, newest first). Returns `404` for an unknown station.

### `GET /devices/{deviceId}/readings`

| Query | Default | Notes |
|---|---|---|
| `from`, `to` | last 1 hour | ISO-8601. Range at most 31 days |
| `limit` | 200 | 1–1000 |
| `order` | `desc` | `asc` or `desc` |
| `nextToken` | | From the previous page |

```json
{
  "items": [{
    "deviceId": "WATER_STATION_01", "timestamp": "2026-11-16T10:00:00.123Z",
    "readings": { "ph": 7.2, "turbidity": 1.8, "tds": 320, "temperature": 26.5 },
    "status": "NORMAL", "violations": [], "seq": 42, "simulated": true,
    "receivedAt": "2026-11-16T10:00:00.240Z"
  }],
  "count": 1,
  "nextToken": null
}
```

### `GET /readings/latest`
The latest readings, status and violations for every station.

### `GET /alerts`

| Query | Default | Values |
|---|---|---|
| `status` | `ALL` | `ACTIVE`, `ACKNOWLEDGED`, `ALL` |
| `severity` | `ALL` | `WARNING`, `CRITICAL`, `ALL` |
| `deviceId` | | e.g. `WATER_STATION_02` |
| `from`, `to` | all time | ISO-8601, filters `createdAt` |
| `limit` | 50 | 1–200 |
| `nextToken` | | |

```json
{
  "items": [{
    "alertId": "3f9c…32 hex…", "deviceId": "WATER_STATION_03", "deviceName": "Industrial Water Storage",
    "parameter": "ph", "parameterLabel": "pH", "unit": "",
    "severity": "CRITICAL", "status": "ACTIVE",
    "value": 5.97, "lastValue": 5.64, "limit": 6, "direction": "below",
    "message": "pH 5.97 is below the critical limit of 6.00",
    "createdAt": "2026-11-16T09:51:34.000Z", "lastAbnormalAt": "2026-11-16T09:53:40.000Z",
    "occurrences": 19, "simulated": true
  }],
  "count": 1,
  "nextToken": null
}
```

- `value` is the reading that created the alert; `lastValue` is the most recent abnormal reading.
- `occurrences` counts the abnormal readings merged into this alert.

### `PATCH /alerts/{alertId}/acknowledge`
Optional body:
```json
{ "acknowledgedBy": "operator name", "note": "checked on site" }
```
Returns the updated alert (`status: "ACKNOWLEDGED"`, `acknowledgedAt`, `acknowledgedBy`, `note`). It returns `409` if the alert is already acknowledged and `404` if it doesn't exist.

> Demo scope: there is no login, so `acknowledgedBy` is a label supplied by the caller, not a verified identity.

### `GET /analytics/trends`

| Query | Default | Notes |
|---|---|---|
| `granularity` | `hour` | `hour` (range at most 8 days) or `day` (at most 366 days) |
| `from`, `to` | last 24 h (hour) / last 7 days (day) | ISO-8601 |
| `deviceId` | all stations | |

```json
{
  "granularity": "HOUR", "from": "…", "to": "…",
  "series": [{
    "deviceId": "WATER_STATION_01", "name": "College Water Tank",
    "points": [{
      "bucket": "2026-11-16T10", "timestamp": "2026-11-16T10:00:00.000Z", "count": 720,
      "avg": { "ph": 7.21, "turbidity": 1.74, "tds": 296, "temperature": 26.9 },
      "warningCount": 0, "criticalCount": 0,
      "abnormal": { "ph": 0, "turbidity": 0, "tds": 0, "temperature": 0 }
    }]
  }],
  "comparison": [{
    "deviceId": "WATER_STATION_01", "name": "College Water Tank", "readingCount": 809,
    "avg": { "ph": 7.22, "turbidity": 1.78, "tds": 335, "temperature": 26.8 },
    "warningCount": 10, "criticalCount": 35, "abnormalRate": 0.0556
  }],
  "abnormalByParameter": { "ph": 162, "turbidity": 56, "tds": 74, "temperature": 0 }
}
```

## Quick tests (PowerShell)

```powershell
$api = terraform -chdir=infra/terraform output -raw api_url
Invoke-RestMethod "$api/health"
Invoke-RestMethod "$api/dashboard/summary"
Invoke-RestMethod "$api/alerts?status=ACTIVE&limit=5"
Invoke-RestMethod "$api/devices/WATER_STATION_01/readings?limit=3"
```

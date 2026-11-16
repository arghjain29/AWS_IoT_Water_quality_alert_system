# Architecture

## Overview

```mermaid
flowchart TB
    subgraph Local["Local computer"]
        direction TB
        SIM["simulator.py<br/>4 virtual stations<br/>(Python, AWS IoT Device SDK v2)"]
        CTRL["Local control endpoint<br/>127.0.0.1:8765 (token)"]
        UI["React dashboard<br/>Vite dev server :5173"]
        SIM --- CTRL
    end

    subgraph AWS["AWS account · ap-south-1"]
        direction TB
        IOT["IoT Core<br/>4 Things · X.509 certs · device policy"]
        RULE["IoT Rule wq_dev_telemetry<br/>SELECT *, topic(3) AS topicDeviceId"]
        ERR[("CloudWatch Logs<br/>rule errors")]
        TL["Lambda wq-dev-telemetry-processor"]
        AL["Lambda wq-dev-api"]
        APIGW["API Gateway HTTP API<br/>CORS · throttling · access logs"]
        R[("WaterReadings")]
        A[("WaterAlerts<br/>GSIs: byStatus, byDevice, byTime")]
        D[("DeviceRegistry")]
        G[("WaterReadingAggregates")]
        CW["CloudWatch dashboard<br/>wq-dev-water-quality"]
        BUD["AWS Budgets<br/>$5 / month alert"]
    end

    SIM == "MQTT 3.1.1 over TLS :8883<br/>topic water-quality/stations/{id}/telemetry" ==> IOT
    IOT --> RULE
    RULE -- "invoke (async)" --> TL
    RULE -. "on failure" .-> ERR
    TL --> R
    TL --> G
    TL --> A
    TL --> D
    UI == "HTTPS GET/PATCH every 5 s" ==> APIGW --> AL
    AL --> R & A & D & G
    UI -. "Simulation page buttons" .-> CTRL
    TL -.-> CW
    AL -.-> CW
```

## Components

| Component | Responsibility | Code |
|---|---|---|
| **Simulator** | Generates realistic readings for 4 stations and publishes them every 5 s with QoS 1, one MQTT connection and certificate per station. Takes commands from the terminal or the local control endpoint | `simulator/simulator.py` |
| **IoT Core** | Authenticates each device by certificate and enforces the device policy | `infra/terraform/iot.tf` |
| **IoT rule** | Matches `water-quality/stations/+/telemetry`, adds `topicDeviceId` taken from the topic, and invokes the telemetry Lambda. Failures go to a log group | `iot.tf` |
| **Telemetry Lambda** | Validate, evaluate, store, aggregate, raise alerts, update the station | `backend/src/telemetry.mjs` |
| **API Lambda** | 10 REST routes for the dashboard, using DynamoDB `Query` (no table scans except the 4-row registry) | `backend/src/api.mjs` |
| **Evaluation** | Threshold rules shared by both Lambdas | `backend/src/evaluation.mjs`, `config/thresholds.json` |
| **Dashboard** | 6 pages; polls the API every 5 s and pauses while the tab is hidden | `frontend/src` |

## Telemetry processing

```mermaid
sequenceDiagram
    autonumber
    participant S as Station (simulator)
    participant I as IoT Core + Rule
    participant L as Telemetry Lambda
    participant DB as DynamoDB
    S->>I: PUBLISH water-quality/stations/WATER_STATION_03/telemetry (QoS 1)
    I-->>S: PUBACK
    I->>L: invoke(message + topicDeviceId)
    L->>L: validate (schema, deviceId == topic, timestamp ±, numeric ranges)
    L->>DB: GetItem DeviceRegistry (is the station registered?)
    L->>L: evaluate thresholds → NORMAL / WARNING / CRITICAL
    L->>DB: PutItem WaterReadings (only if not already stored)
    L->>DB: UpdateItem WaterReadingAggregates (hour + day totals)
    alt reading is abnormal
        L->>DB: PutItem WaterAlerts (new episode) or UpdateItem (same episode)
    end
    L->>DB: UpdateItem DeviceRegistry (lastSeen, latest readings, alert state)
```

**Validation** rejects:
- a missing or malformed `deviceId`;
- a `deviceId` that doesn't match the MQTT topic;
- a missing timestamp, or one without a timezone, more than 5 minutes in the future, or more than 24 hours old;
- a missing or non-numeric reading, or one outside its physically valid range (for example pH outside 0–14).

Rejected messages are logged and dropped. They are never stored.

**Idempotency:** a reading is written with `attribute_not_exists`, so a message delivered twice (MQTT QoS 1) is stored once. A late, out-of-order message is kept in history but does not overwrite the station's latest state.

## Data model

| Table | Key | Indexes | Purpose |
|---|---|---|---|
| `WaterReadings` | `deviceId` (PK), `timestamp` (SK) | – | Every reading; TTL 14 days |
| `WaterAlerts` | `alertId` (PK) | `byStatus` (status, createdAt), `byDevice` (deviceId, createdAt), `byTime` (entity, createdAt) | Alerts and their history |
| `DeviceRegistry` | `deviceId` (PK) | – | Name, location, `lastSeen`, latest readings and status, alert state |
| `WaterReadingAggregates` | `seriesKey` (PK, e.g. `WATER_STATION_01#HOUR`), `bucket` (SK, e.g. `2026-11-16T10`) | – | Hourly and daily count, sums and abnormal counts; hourly rows expire after 90 days |

**Why the aggregates table:** a weekly chart of raw readings would read about 120,000 items per station. The aggregates are updated as each reading arrives, with an atomic `ADD`, so a weekly chart reads about 170 small rows instead. The dashboard uses raw readings for ranges up to 6 hours and aggregates beyond that.

All timestamps are ISO-8601 UTC with milliseconds (`2026-11-16T10:00:00.123Z`), so string order equals time order.

## Alert de-duplication

```mermaid
stateDiagram-v2
    [*] --> NoAlert
    NoAlert --> Active: abnormal reading → create alert
    Active --> Active: still abnormal, same or lower severity → occurrences + 1
    Active --> Escalated: becomes worse (WARNING → CRITICAL) → create new alert
    Active --> Acknowledged: operator acknowledges
    Acknowledged --> Acknowledged: still abnormal → occurrences + 1 (no new alert)
    Active --> Quiet: normal readings
    Acknowledged --> Quiet: normal readings
    Quiet --> Active: abnormal again within 10 min → same alert continues
    Quiet --> NoAlert: 10 min of normal readings (cooldown)
```

Each station keeps a small `alertState` per parameter (`alertId`, `severity`, `lastAbnormalAt`) in `DeviceRegistry`. This gives one alert per station and parameter per episode instead of one every 5 seconds.

## Online and offline detection

`lastSeen` is the time **the cloud received** a message, not the device's own timestamp. In testing, the host clock ran 15.8 s behind AWS, which made stations flicker offline. A station is **ONLINE** if `now − lastSeen ≤ 20 s` (4 missed readings at 5 s), otherwise **OFFLINE**, or **NEVER_SEEN** if it has never reported. This is worked out when the API is called, so no scheduled job is needed.

## Design decisions

| Decision | Reason |
|---|---|
| Certificates created by a script, not Terraform | Keeps private keys out of Terraform state and outputs |
| Simulator in Python, Lambdas in Node.js | The spec asked for a Python device SDK. The cloud code and the dashboard share one language, which is easier to explain and maintain |
| HTTP API instead of REST API | Cheaper and simpler. CORS and throttling are built in |
| Polling every 5 s instead of WebSockets | Meets the spec and is simpler. The UI pauses polling while the tab is hidden |
| Single code zip, no bundled dependencies | AWS SDK v3 is already in the Lambda runtime, so the zip contains only our files and `thresholds.json` |
| arm64 Lambdas, on-demand DynamoDB, TTL, 7-day logs | Lowest cost for occasional demo use |
| Control endpoint on 127.0.0.1 with a token | Demo controls without exposing anything to the internet |
| Logs Insights widgets instead of custom metrics | Charts water quality in CloudWatch for fractions of a cent instead of ~$5/month in custom metrics |

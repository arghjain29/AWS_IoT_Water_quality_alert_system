# Milestone Checklist

| Phase | Milestone | Status |
|---|---|---|
| 1 | Environment inspection & plan | ✅ Done |
| 2 | Repository structure & Python simulator (single file) | ✅ 26 tests, dry-run and live verified |
| 3 | AWS IoT Core MQTT integration (certificates, real connection) | ✅ 4 devices connected over mTLS, PUBACK confirmed |
| 4 | Terraform infrastructure (plan → approval → apply) | ✅ Applied in ap-south-1 |
| 5 | Lambda telemetry processing & DynamoDB (Node.js 22) | ✅ Readings, aggregates, alerts (dedup and escalation) verified live |
| 6 | API Gateway & REST API | ✅ All routes verified live (ack 200/409, pagination, trends, CORS) |
| 7 | React dashboard | ✅ 6 pages verified against live AWS data (desktop and mobile); mock mode verified |
| 7b | CloudWatch dashboard `wq-dev-water-quality` | ✅ Log queries and metrics verified with live data |
| 8 | Full end-to-end integration & testing | ✅ Simulator → IoT Core → rule → Lambda → DynamoDB → API → dashboard, including alerts, acknowledge and offline detection |
| 9 | Documentation | ✅ README, architecture, AWS setup, demo guide, API reference, screenshots |

## Acceptance criteria

1. ✅ Four virtual devices generate sensor readings
2. ✅ Devices connect to AWS IoT Core using MQTT over TLS with per-device certificates
3. ✅ Telemetry reaches AWS (3,060 rule→Lambda handoffs verified, 0 failures)
4. ✅ Lambda processes incoming telemetry
5. ✅ DynamoDB stores readings and alerts
6. ✅ API Gateway exposes working endpoints
7. ✅ The React dashboard displays live cloud readings
8. ✅ Abnormal readings trigger alerts (de-duplicated, with escalation)
9. ✅ Historical charts display stored data (raw and hourly/daily aggregates)
10. ✅ Device disconnection is detected (OFFLINE after about 20 s)
11. ✅ The simulator reproduces normal, warning and critical scenarios (fixed seed)
12. ✅ Documentation explains setup and demonstration
13. ✅ No AWS secrets or private certificates are committed

## Decisions

- Region `ap-south-1`, resource prefix `wq-dev`, local Terraform state (git-ignored)
- Simulator in Python (`uv`); Lambdas ported to Node.js after live verification
- Extra table `WaterReadingAggregates` for efficient trends
- Acknowledge endpoint protected only by throttling and CORS (demo scope, no login)
- AWS Budgets alert at $5/month (real usage, credits excluded)
- No Vercel deployment: the dashboard runs locally (`npm run dev`)

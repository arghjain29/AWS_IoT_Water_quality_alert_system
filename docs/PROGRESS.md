# Milestone Checklist

| Phase | Milestone | Status |
|---|---|---|
| 1 | Environment inspection & plan | ✅ Done |
| 2 | Repository structure & Python simulator (single file) | ✅ Done (23 tests, dry-run verified) |
| 3 | AWS IoT Core MQTT integration (certificates, real connection) | ✅ 4 devices connected over mTLS, PUBACK confirmed |
| 4 | Terraform infrastructure (plan → approval → apply) | ✅ 42 resources applied in ap-south-1 |
| 5 | Lambda telemetry processing & DynamoDB | ✅ readings, aggregates, alerts (dedup + escalation) verified live |
| 6 | API Gateway & REST API | ✅ all routes verified live (ack 200/409, pagination, trends, CORS) |
| 7 | React dashboard | ⬜ |
| 8 | Full end-to-end integration & testing | ⬜ |
| 9 | Vercel deployment & documentation | ⬜ |

## Environment (Phase 1)

- AWS CLI 2.36, Terraform 1.15, Python 3.12, uv 0.8, Node 24, Vercel CLI 59
- AWS account authenticated via default profile, region `ap-south-1`
- No pre-existing IoT / Lambda / DynamoDB / API Gateway resources (no conflicts)

## Approved decisions

- Region `ap-south-1`, resource prefix `wq-dev`, local Terraform state (git-ignored)
- Extra table `WaterReadingAggregates` for efficient trends
- Acknowledge endpoint protected by throttling + CORS (demo scope, no login)
- AWS Budgets alert at $5/month; Vercel deploy in Phase 9
- Python tooling: `uv`

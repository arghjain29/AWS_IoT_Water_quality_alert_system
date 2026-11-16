# AWS Setup

This guide goes from an AWS account to a running stack. Every resource lives in **ap-south-1 (Mumbai)** and is named `wq-dev-*`.

## 1. Account and CLI

1. Install [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and [Terraform](https://developer.hashicorp.com/terraform/install).
2. Configure credentials **on your machine only**. Never paste keys into code, chat or files in this repo:
   ```powershell
   aws configure            # or: aws configure sso
   aws configure set region ap-south-1
   aws sts get-caller-identity   # should print your account and user/role
   ```
3. The identity needs permission to manage IoT Core, Lambda, DynamoDB, API Gateway (v2), IAM roles and policies, CloudWatch (logs and dashboards) and Budgets.

## 2. Terraform

```powershell
cd infra/terraform
copy terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` (it is git-ignored):

```hcl
budget_alert_email = "you@example.com"   # free monthly cost email; leave "" to skip
```

```powershell
terraform init
terraform plan -out tfplan      # review the plan before applying
terraform apply tfplan
```

**What gets created (about 43 resources):**

| File | Resources |
|---|---|
| `iot.tf` | 4 IoT things, device policy, topic rule, Lambda invoke permission |
| `lambda.tf` | Telemetry and API Lambdas (Node.js 22, arm64, 256 MB) |
| `dynamodb.tf` | 4 on-demand tables (TTL, alert indexes) and the 4 registered stations |
| `apigateway.tf` | HTTP API, 10 routes, `$default` stage with throttling and access logs |
| `iam.tf` | 3 least-privilege roles (telemetry Lambda, API Lambda, IoT rule error logging) |
| `cloudwatch.tf` | 4 log groups (7-day retention) and the optional budget |
| `cloudwatch_dashboard.tf` | The `wq-dev-water-quality` dashboard |

Useful outputs:

```powershell
terraform output api_url          # → frontend VITE_API_BASE_URL
terraform output iot_endpoint     # → simulator IOT_ENDPOINT
terraform output dashboard_url    # → CloudWatch dashboard
```

**Terraform state** is stored locally (`terraform.tfstate`, git-ignored). It contains resource IDs but no private keys. If it's lost, existing resources would have to be imported back before Terraform can manage them again. For a team, use an S3 backend with encryption.

## 3. Device certificates

```powershell
cd ../..
uv run scripts/provision_certs.py
```

For each station, the script:
1. Calls `CreateKeysAndCertificate`.
2. Saves `certificate.pem.crt`, `private.pem.key` and `certificate-id.txt` to `certs/<deviceId>/`, with the key readable only by you.
3. Attaches the device policy.
4. Attaches the certificate to the station's thing.

It also downloads the Amazon Root CA. Running it again is safe: stations with a working certificate are skipped.

## 4. Point the apps at AWS

```powershell
# simulator/.env
IOT_ENDPOINT=<terraform output iot_endpoint>
CONTROL_TOKEN=<any long random string>

# frontend/.env.local
VITE_API_BASE_URL=<terraform output api_url>
```

`.\scripts\demo-up.ps1` does steps 2–4 in one go, writes these values for you, and generates a cryptographically random control token.

## 5. See it in the AWS console

Set the region selector (top right) to **Asia Pacific (Mumbai)**, and start the simulator so there's activity to watch.

| What | Where | Look at |
|---|---|---|
| **Whole pipeline** | CloudWatch → Dashboards → `wq-dev-water-quality` | Water-quality charts, latest alerts, IoT / Lambda / DynamoDB / API metrics |
| **Live messages** | IoT Core → MQTT test client | Subscribe to `water-quality/stations/+/telemetry` |
| Devices | IoT Core → All devices → Things | `WATER_STATION_01`–`04` and their certificates |
| Device permissions | IoT Core → Security → Policies | `wq-dev-device-policy` |
| Rule | IoT Core → Message routing → Rules | `wq_dev_telemetry` |
| Code and metrics | Lambda → Functions | `wq-dev-telemetry-processor`, `wq-dev-api` (Monitor tab) |
| Data | DynamoDB → Tables → Explore items | `wq-dev-WaterReadings`, `-WaterAlerts`, `-DeviceRegistry`, `-WaterReadingAggregates` |
| API | API Gateway → `wq-dev-api` | Routes, CORS, throttling |
| Logs | CloudWatch → Log groups | `/aws/lambda/wq-dev-telemetry-processor`; `/aws/iot/wq-dev-rule-errors` should be empty |
| Everything at once | Resource Groups → Tag Editor | Tag `Project = water-quality-monitoring` |
| Cost | Billing → Budgets / Bills / Credits | `wq-dev-monthly` budget |

Logs Insights query listing recent alerts (log group `/aws/lambda/wq-dev-telemetry-processor`):

```
fields @timestamp, @message
| filter @message like /"message":"ALERT"/
| sort @timestamp desc
| limit 20
```

> Browse freely, but **don't edit or delete these resources in the console**. Terraform manages them, and manual changes cause drift. Publishing from the MQTT test client to a station topic creates real readings and alerts.

## 6. Updating

After changing Lambda code or Terraform files:

```powershell
cd infra/terraform
terraform plan -out tfplan    # usually "2 to change" for a code update
terraform apply tfplan
```

## 7. Teardown

```powershell
.\scripts\demo-down.ps1
```

This detaches and deletes this project's certificates first (AWS refuses to delete a thing that still has one), then runs `terraform destroy`. It deletes **all** project resources and data, and touches nothing else in the account.

## Cost notes

| Item | Pricing model | This project |
|---|---|---|
| IoT Core | per connection-minute and per message | Cents per demo hour |
| Lambda | per request and GB-second | Mostly within the free tier |
| DynamoDB on-demand | per read/write request; storage | Cents; TTL keeps storage tiny |
| API Gateway HTTP API | ~$1 per million requests | Throttled to 20 requests/s |
| CloudWatch | logs per GB; first 3 dashboards free | Few MB of logs, 1 dashboard |
| Budgets | Free (no actions) | $5/month alert, credits excluded |

With the simulator stopped, the stack costs approximately nothing.

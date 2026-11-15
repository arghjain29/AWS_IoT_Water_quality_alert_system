# Both functions share one small zip: our Python files + thresholds.json.
# boto3 is already provided by the Lambda runtime, so there are no dependencies to bundle.
data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/build/lambda.zip"

  source {
    content  = file("${local.repo_root}/backend/lambda/shared.py")
    filename = "shared.py"
  }
  source {
    content  = file("${local.repo_root}/backend/lambda/evaluation.py")
    filename = "evaluation.py"
  }
  source {
    content  = file("${local.repo_root}/backend/lambda/telemetry.py")
    filename = "telemetry.py"
  }
  source {
    content  = file("${local.repo_root}/backend/lambda/api.py")
    filename = "api.py"
  }
  source {
    content  = file("${local.repo_root}/config/thresholds.json")
    filename = "thresholds.json"
  }
}

locals {
  table_env = {
    READINGS_TABLE   = aws_dynamodb_table.readings.name
    ALERTS_TABLE     = aws_dynamodb_table.alerts.name
    REGISTRY_TABLE   = aws_dynamodb_table.registry.name
    AGGREGATES_TABLE = aws_dynamodb_table.aggregates.name
    LOG_LEVEL        = "INFO"
  }
}

resource "aws_lambda_function" "telemetry" {
  function_name    = "${local.name}-telemetry-processor"
  description      = "Validates and evaluates IoT telemetry, stores readings, creates alerts"
  role             = aws_iam_role.telemetry_lambda.arn
  runtime          = "python3.12"
  architectures    = ["arm64"] # cheaper than x86 for the same work
  handler          = "telemetry.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = merge(local.table_env, {
      READINGS_TTL_DAYS      = tostring(var.readings_ttl_days)
      ALERT_COOLDOWN_MINUTES = tostring(var.alert_cooldown_minutes)
    })
  }

  depends_on = [aws_cloudwatch_log_group.telemetry_lambda]
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name}-api"
  description      = "REST API for the water-quality dashboard"
  role             = aws_iam_role.api_lambda.arn
  runtime          = "python3.12"
  architectures    = ["arm64"]
  handler          = "api.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = merge(local.table_env, {
      OFFLINE_AFTER_SECONDS = tostring(var.offline_after_seconds)
    })
  }

  depends_on = [aws_cloudwatch_log_group.api_lambda]
}

# Both functions share one small zip: our JavaScript files + thresholds.json.
# The AWS SDK v3 is already provided by the Lambda Node.js runtime, so there
# are no node_modules to bundle.
data "archive_file" "lambda" {
  type        = "zip"
  output_path = "${path.module}/build/lambda.zip"

  dynamic "source" {
    for_each = ["shared.mjs", "evaluation.mjs", "telemetry.mjs", "api.mjs"]
    content {
      content  = file("${local.repo_root}/backend/src/${source.value}")
      filename = source.value
    }
  }
  source {
    content  = file("${local.repo_root}/config/thresholds.json")
    filename = "thresholds.json"
  }
}

locals {
  lambda_runtime = "nodejs22.x"

  table_env = {
    READINGS_TABLE   = aws_dynamodb_table.readings.name
    ALERTS_TABLE     = aws_dynamodb_table.alerts.name
    REGISTRY_TABLE   = aws_dynamodb_table.registry.name
    AGGREGATES_TABLE = aws_dynamodb_table.aggregates.name
  }
}

resource "aws_lambda_function" "telemetry" {
  function_name    = "${local.name}-telemetry-processor"
  description      = "Validates and evaluates IoT telemetry, stores readings, creates alerts"
  role             = aws_iam_role.telemetry_lambda.arn
  runtime          = local.lambda_runtime
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
  runtime          = local.lambda_runtime
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

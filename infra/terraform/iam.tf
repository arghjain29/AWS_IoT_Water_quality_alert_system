# Least-privilege roles: each one can touch only the exact tables / log groups it needs.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- Telemetry processor ------------------------------------------------------
resource "aws_iam_role" "telemetry_lambda" {
  name               = "${local.name}-telemetry-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "telemetry_lambda" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.telemetry_lambda.arn}:*"]
  }
  statement {
    sid       = "ReadAndUpdateRegistry"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.registry.arn]
  }
  statement {
    sid       = "WriteReadings"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.readings.arn]
  }
  statement {
    sid       = "WriteAlerts"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.alerts.arn]
  }
  statement {
    sid       = "UpdateAggregates"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.aggregates.arn]
  }
}

resource "aws_iam_role_policy" "telemetry_lambda" {
  name   = "least-privilege"
  role   = aws_iam_role.telemetry_lambda.id
  policy = data.aws_iam_policy_document.telemetry_lambda.json
}

# ---- API handler (read-only, except acknowledging alerts) ----------------------
resource "aws_iam_role" "api_lambda" {
  name               = "${local.name}-api-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "api_lambda" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api_lambda.arn}:*"]
  }
  statement {
    sid     = "ReadData"
    actions = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [
      aws_dynamodb_table.registry.arn,
      aws_dynamodb_table.readings.arn,
      aws_dynamodb_table.aggregates.arn,
      aws_dynamodb_table.alerts.arn,
      "${aws_dynamodb_table.alerts.arn}/index/*",
    ]
  }
  statement {
    sid       = "AcknowledgeAlerts"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.alerts.arn]
  }
}

resource "aws_iam_role_policy" "api_lambda" {
  name   = "least-privilege"
  role   = aws_iam_role.api_lambda.id
  policy = data.aws_iam_policy_document.api_lambda.json
}

# ---- IoT rule error logging ------------------------------------------------------
resource "aws_iam_role" "iot_rule" {
  name = "${local.name}-iot-rule"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "iot.amazonaws.com" }
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "iot_rule" {
  name = "write-rule-errors"
  role = aws_iam_role.iot_rule.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = ["${aws_cloudwatch_log_group.iot_rule_errors.arn}:*"]
    }]
  })
}

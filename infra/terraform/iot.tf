# ---- Things: one per virtual station ---------------------------------------
resource "aws_iot_thing" "station" {
  for_each = local.stations_by_id
  name     = each.key # WATER_STATION_01 ...

  attributes = {
    environment = var.environment
    simulated   = "true"
  }
}

# ---- Device policy ------------------------------------------------------------
# A device may only:
#   * connect using its own thing name as MQTT client id
#   * publish to its own telemetry topic
# ${iot:Connection.Thing.ThingName} is resolved by AWS IoT from the certificate's
# attached thing ($${...} escapes it from Terraform interpolation).
resource "aws_iot_policy" "device" {
  name = "${local.name}-device-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "iot:Connect"
        Resource = "arn:aws:iot:${local.region}:${local.account_id}:client/$${iot:Connection.Thing.ThingName}"
        Condition = {
          Bool = { "iot:Connection.Thing.IsAttached" = "true" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "iot:Publish"
        Resource = "arn:aws:iot:${local.region}:${local.account_id}:topic/${local.topic_prefix}/$${iot:Connection.Thing.ThingName}/telemetry"
      }
    ]
  })
}

# ---- Rule: every telemetry message -> telemetry Lambda ---------------------
resource "aws_iot_topic_rule" "telemetry" {
  name        = replace("${local.name}_telemetry", "-", "_") # rule names allow only [a-zA-Z0-9_]
  description = "Forward station telemetry to the processing Lambda"
  enabled     = true
  sql_version = "2016-03-23"
  # topic(3) = the {device_id} part of water-quality/stations/{device_id}/telemetry
  sql = "SELECT *, topic(3) AS topicDeviceId FROM '${local.topic_prefix}/+/telemetry'"

  lambda {
    function_arn = aws_lambda_function.telemetry.arn
  }

  # If the rule can't invoke the Lambda, the failure is logged instead of lost silently.
  error_action {
    cloudwatch_logs {
      log_group_name = aws_cloudwatch_log_group.iot_rule_errors.name
      role_arn       = aws_iam_role.iot_rule.arn
    }
  }
}

resource "aws_lambda_permission" "iot_invoke" {
  statement_id   = "AllowIoTRuleInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.telemetry.function_name
  principal      = "iot.amazonaws.com"
  source_arn     = aws_iot_topic_rule.telemetry.arn
  source_account = local.account_id
}

data "aws_iot_endpoint" "data" {
  endpoint_type = "iot:Data-ATS"
}

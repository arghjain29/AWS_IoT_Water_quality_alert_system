# CloudWatch dashboard: one AWS console page showing the whole pipeline.
# Free (an account gets 3 dashboards free). Rows 2, 3 and 8 read the telemetry
# Lambda's logs with Logs Insights ($0.005 per GB scanned; these logs are a few MB).
# Rows 4-7 use metrics AWS records anyway, at no extra cost.

locals {
  telemetry_logs = aws_cloudwatch_log_group.telemetry_lambda.name
  dash_region    = local.region

  # Logs Insights: one line per station for a sensor parameter, from the
  # "processed" log line the telemetry Lambda writes for every message.
  reading_query = { for p in ["ph", "turbidity", "tds", "temperature"] : p => join("\n", [
    "SOURCE '${local.telemetry_logs}'",
    "| filter @message like /\"message\":\"processed\"/",
    "| parse @message /\"deviceId\":\"(?<station>[^\"]+)\"/",
    "| parse @message /\"${p}\":(?<value>-?[\\d.]+)/",
    "| stats avg(value) by bin(1m), station",
  ]) }

  console = "https://${local.region}.console.aws.amazon.com"

  header_markdown = <<-EOT
    # Water Quality Monitoring: AWS pipeline (${var.environment})
    Simulated IoT stations → **IoT Core** (MQTT/TLS) → **IoT rule** → **Lambda** → **DynamoDB** → **API Gateway** → React dashboard.
    Readings come from **software-simulated sensors**. Thresholds are demonstration values, not a drinking-water safety standard.

    [Live MQTT messages](${local.console}/iot/home?region=${local.region}#/test) ·
    [IoT things](${local.console}/iot/home?region=${local.region}#/thinghub) ·
    [DynamoDB tables](${local.console}/dynamodbv2/home?region=${local.region}#tables) ·
    [Lambda functions](${local.console}/lambda/home?region=${local.region}#/functions) ·
    [Telemetry logs](${local.console}/cloudwatch/home?region=${local.region}#logsV2:log-groups/log-group/${replace(local.telemetry_logs, "/", "$252F")})
  EOT

  # helpers for metric widgets
  metric_widget = {
    view    = "timeSeries"
    stacked = false
    region  = local.region
    period  = 60
  }
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name}-water-quality"

  dashboard_body = jsonencode({
    widgets = [
      # ---- 1. header ----------------------------------------------------------
      {
        type       = "text", x = 0, y = 0, width = 24, height = 4
        properties = { markdown = local.header_markdown }
      },

      # ---- 2. water quality (from logs) ------------------------------------------
      {
        type       = "log", x = 0, y = 4, width = 12, height = 6
        properties = { title = "pH by station (normal 6.5–8.5)", region = local.region, view = "timeSeries", stacked = false, query = local.reading_query.ph }
      },
      {
        type       = "log", x = 12, y = 4, width = 12, height = 6
        properties = { title = "Turbidity NTU by station (normal ≤ 5)", region = local.region, view = "timeSeries", stacked = false, query = local.reading_query.turbidity }
      },
      {
        type       = "log", x = 0, y = 10, width = 12, height = 6
        properties = { title = "TDS mg/L by station (normal ≤ 500)", region = local.region, view = "timeSeries", stacked = false, query = local.reading_query.tds }
      },
      {
        type       = "log", x = 12, y = 10, width = 12, height = 6
        properties = { title = "Temperature °C by station (normal 10–35)", region = local.region, view = "timeSeries", stacked = false, query = local.reading_query.temperature }
      },

      # ---- 3. alerts (from logs) --------------------------------------------------
      {
        type = "log", x = 0, y = 16, width = 16, height = 7
        properties = {
          title  = "Latest alerts created in the cloud"
          region = local.region
          view   = "table"
          query = join("\n", [
            "SOURCE '${local.telemetry_logs}'",
            "| filter @message like /\"message\":\"ALERT\"/",
            "| parse @message /\"severity\":\"(?<severity>[^\"]+)\"/",
            "| parse @message /\"deviceId\":\"(?<station>[^\"]+)\"/",
            "| parse @message /\"parameter\":\"(?<parameter>[^\"]+)\"/",
            "| parse @message /\"description\":\"(?<description>[^\"]+)\"/",
            "| sort @timestamp desc",
            "| limit 25",
            "| display @timestamp, severity, station, parameter, description",
          ])
        }
      },
      {
        type = "log", x = 16, y = 16, width = 8, height = 7
        properties = {
          title  = "Alerts by severity"
          region = local.region
          view   = "bar"
          query = join("\n", [
            "SOURCE '${local.telemetry_logs}'",
            "| filter @message like /\"message\":\"ALERT\"/",
            "| parse @message /\"severity\":\"(?<severity>[^\"]+)\"/",
            "| stats count(*) as alerts by severity",
          ])
        }
      },

      # ---- 4. IoT Core ----------------------------------------------------------------
      {
        type = "metric", x = 0, y = 23, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title   = "IoT Core: MQTT messages received", stat = "Sum"
          metrics = [["AWS/IoT", "PublishIn.Success", "Protocol", "MQTT", { label = "Messages published" }]]
        })
      },
      {
        type = "metric", x = 8, y = 23, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title = "IoT Core: device connections", stat = "Sum"
          metrics = [
            ["AWS/IoT", "Connect.Success", "Protocol", "MQTT", { label = "Connect success" }],
            ["AWS/IoT", "Connect.AuthError", "Protocol", "MQTT", { label = "Auth errors" }],
          ]
        })
      },
      {
        type = "metric", x = 16, y = 23, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title = "IoT rule → Lambda", stat = "Sum"
          metrics = [
            ["AWS/IoT", "TopicMatch", "RuleName", aws_iot_topic_rule.telemetry.name, { label = "Messages matched" }],
            ["AWS/IoT", "Success", "RuleName", aws_iot_topic_rule.telemetry.name, "ActionType", "Lambda", { label = "Lambda action success" }],
            ["AWS/IoT", "Failure", "RuleName", aws_iot_topic_rule.telemetry.name, "ActionType", "Lambda", { label = "Lambda action failure" }],
          ]
        })
      },

      # ---- 5. Lambda ---------------------------------------------------------------------
      {
        type = "metric", x = 0, y = 29, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title = "Lambda invocations", stat = "Sum"
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.telemetry.function_name, { label = "Telemetry processor" }],
            ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.api.function_name, { label = "API" }],
          ]
        })
      },
      {
        type = "metric", x = 8, y = 29, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title = "Lambda errors and throttles", stat = "Sum"
          metrics = [
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.telemetry.function_name, { label = "Telemetry errors" }],
            ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.api.function_name, { label = "API errors" }],
            ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.telemetry.function_name, { label = "Telemetry throttles" }],
          ]
        })
      },
      {
        type = "metric", x = 16, y = 29, width = 8, height = 6
        properties = merge(local.metric_widget, {
          title = "Lambda duration (ms, average)", stat = "Average"
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.telemetry.function_name, { label = "Telemetry processor" }],
            ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.api.function_name, { label = "API" }],
          ]
        })
      },

      # ---- 6. DynamoDB ----------------------------------------------------------------------
      {
        type = "metric", x = 0, y = 35, width = 12, height = 6
        properties = merge(local.metric_widget, {
          title = "DynamoDB writes (capacity units)", stat = "Sum"
          metrics = [for t in [aws_dynamodb_table.readings, aws_dynamodb_table.alerts, aws_dynamodb_table.registry, aws_dynamodb_table.aggregates] :
          ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", t.name, { label = replace(t.name, "${local.name}-", "") }]]
        })
      },
      {
        type = "metric", x = 12, y = 35, width = 12, height = 6
        properties = merge(local.metric_widget, {
          title = "DynamoDB reads (capacity units)", stat = "Sum"
          metrics = [for t in [aws_dynamodb_table.readings, aws_dynamodb_table.alerts, aws_dynamodb_table.registry, aws_dynamodb_table.aggregates] :
          ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", t.name, { label = replace(t.name, "${local.name}-", "") }]]
        })
      },

      # ---- 7. API Gateway -------------------------------------------------------------------
      {
        type = "metric", x = 0, y = 41, width = 12, height = 6
        properties = merge(local.metric_widget, {
          title = "API requests and errors", stat = "Sum"
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.http.id, { label = "Requests" }],
            ["AWS/ApiGateway", "4xx", "ApiId", aws_apigatewayv2_api.http.id, { label = "4xx (client errors)" }],
            ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.http.id, { label = "5xx (server errors)" }],
          ]
        })
      },
      {
        type = "metric", x = 12, y = 41, width = 12, height = 6
        properties = merge(local.metric_widget, {
          title = "API latency (ms)", stat = "Average"
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.http.id, { label = "Total latency" }],
            ["AWS/ApiGateway", "IntegrationLatency", "ApiId", aws_apigatewayv2_api.http.id, { label = "Lambda time" }],
          ]
        })
      },

      # ---- 8. data quality -------------------------------------------------------------------
      {
        type = "log", x = 0, y = 47, width = 24, height = 5
        properties = {
          title  = "Rejected telemetry (invalid messages or unknown devices)"
          region = local.region
          view   = "table"
          query = join("\n", [
            "SOURCE '${local.telemetry_logs}'",
            "| filter @message like /REJECTED/",
            "| parse @message /\"reason\":\"(?<reason>[^\"]+)\"/",
            "| parse @message /\"deviceId\":\"(?<station>[^\"]+)\"/",
            "| sort @timestamp desc",
            "| limit 20",
            "| display @timestamp, station, reason",
          ])
        }
      },
    ]
  })
}

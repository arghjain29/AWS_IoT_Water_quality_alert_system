# Only non-secret identifiers. No certificates or keys are ever output.

output "region" {
  value = local.region
}

output "api_url" {
  description = "Base URL for the dashboard (VITE_API_BASE_URL)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "iot_endpoint" {
  description = "MQTT endpoint for the simulator (IOT_ENDPOINT)"
  value       = data.aws_iot_endpoint.data.endpoint_address
}

output "iot_policy_name" {
  description = "Policy that scripts/provision_certs.py attaches to each certificate"
  value       = aws_iot_policy.device.name
}

output "thing_names" {
  value = sort([for t in aws_iot_thing.station : t.name])
}

output "telemetry_topic_filter" {
  value = "${local.topic_prefix}/+/telemetry"
}

output "dynamodb_tables" {
  value = {
    readings   = aws_dynamodb_table.readings.name
    alerts     = aws_dynamodb_table.alerts.name
    registry   = aws_dynamodb_table.registry.name
    aggregates = aws_dynamodb_table.aggregates.name
  }
}

output "lambda_functions" {
  value = {
    telemetry = aws_lambda_function.telemetry.function_name
    api       = aws_lambda_function.api.function_name
  }
}

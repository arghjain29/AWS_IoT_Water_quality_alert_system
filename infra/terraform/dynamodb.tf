# All tables use on-demand billing: you pay per request, nothing when idle.

# Every reading: query one station's history by time range.
resource "aws_dynamodb_table" "readings" {
  name         = "${local.name}-WaterReadings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "deviceId"
  range_key    = "timestamp"

  attribute {
    name = "deviceId"
    type = "S"
  }
  attribute {
    name = "timestamp"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt" # old readings are deleted automatically (free)
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false # not needed for demo data; avoids extra cost
  }
}

# Alerts, with three indexes so every alert view is a Query (no table scans).
resource "aws_dynamodb_table" "alerts" {
  name         = "${local.name}-WaterAlerts"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "alertId"

  attribute {
    name = "alertId"
    type = "S"
  }
  attribute {
    name = "status"
    type = "S"
  }
  attribute {
    name = "deviceId"
    type = "S"
  }
  attribute {
    name = "entity"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "S"
  }

  dynamic "global_secondary_index" {
    for_each = {
      byStatus = "status"   # active / acknowledged alerts, newest first
      byDevice = "deviceId" # alert history for one station
      byTime   = "entity"   # all alerts by time
    }
    content {
      name            = global_secondary_index.key
      projection_type = "ALL"
      key_schema {
        attribute_name = global_secondary_index.value
        key_type       = "HASH"
      }
      key_schema {
        attribute_name = "createdAt"
        key_type       = "RANGE"
      }
    }
  }
}

# One item per station: name, location, last-seen time, latest readings.
resource "aws_dynamodb_table" "registry" {
  name         = "${local.name}-DeviceRegistry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "deviceId"

  attribute {
    name = "deviceId"
    type = "S"
  }
}

# Hourly and daily totals per station, so trend charts don't read raw readings.
resource "aws_dynamodb_table" "aggregates" {
  name         = "${local.name}-WaterReadingAggregates"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "seriesKey" # e.g. "WATER_STATION_01#HOUR"
  range_key    = "bucket"    # e.g. "2026-11-16T10"

  attribute {
    name = "seriesKey"
    type = "S"
  }
  attribute {
    name = "bucket"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# Register the four stations. The Lambda later adds lastSeen/latestReadings to
# these items, so Terraform only creates them and then ignores changes.
resource "aws_dynamodb_table_item" "station" {
  for_each   = local.stations_by_id
  table_name = aws_dynamodb_table.registry.name
  hash_key   = aws_dynamodb_table.registry.hash_key

  item = jsonencode({
    deviceId = { S = each.value.deviceId }
    name     = { S = each.value.name }
    location = { S = each.value.location }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

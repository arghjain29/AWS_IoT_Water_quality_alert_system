# Shared values used across the other .tf files.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "${var.project}-${var.environment}" # e.g. "wq-dev"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  repo_root = "${path.module}/../.."
  stations  = jsondecode(file("${local.repo_root}/config/stations.json")).stations

  # deviceId -> station config
  stations_by_id = { for s in local.stations : s.deviceId => s }

  topic_prefix = "water-quality/stations"
}

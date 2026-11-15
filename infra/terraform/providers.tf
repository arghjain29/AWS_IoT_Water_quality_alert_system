terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Local state (terraform.tfstate) is git-ignored. It contains resource IDs but
  # NO device private keys: certificates are created outside Terraform by
  # scripts/provision_certs.py.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "water-quality-monitoring"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Short project name used in resource names"
  type        = string
  default     = "wq"
}

variable "environment" {
  description = "Environment name used in resource names (e.g. dev, prod)"
  type        = string
  default     = "dev"
}

variable "cors_allowed_origins" {
  description = "Frontend origins allowed to call the API (the local Vite dev server)"
  type        = list(string)
  default     = ["http://localhost:5173", "http://127.0.0.1:5173"]
}

variable "log_retention_days" {
  description = "CloudWatch log retention"
  type        = number
  default     = 7
}

variable "readings_ttl_days" {
  description = "Raw readings are deleted automatically after this many days (keeps storage cost tiny)"
  type        = number
  default     = 14
}

variable "offline_after_seconds" {
  description = "A station with no message for this long is shown as OFFLINE"
  type        = number
  default     = 20
}

variable "alert_cooldown_minutes" {
  description = "A new alert for the same station+parameter is only created after this many minutes of normal readings"
  type        = number
  default     = 10
}

variable "api_throttle_rate" {
  description = "API Gateway steady-state requests per second (protects against runaway cost)"
  type        = number
  default     = 20
}

variable "api_throttle_burst" {
  description = "API Gateway burst limit"
  type        = number
  default     = 40
}

variable "budget_alert_email" {
  description = "Email for the monthly AWS Budgets alert. Leave empty to skip creating the budget."
  type        = string
  default     = ""
}

variable "budget_limit_usd" {
  description = "Monthly budget alert threshold in USD"
  type        = number
  default     = 5
}

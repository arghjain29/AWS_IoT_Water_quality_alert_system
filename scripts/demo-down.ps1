# Removes everything this project created in AWS, in the right order.
#   1. detach + delete the device certificates (AWS won't delete a thing that still has one)
#   2. terraform destroy (asks you to type "yes")
#
# All stored readings and alerts are deleted. Run from the repo root:  .\scripts\demo-down.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tf = Join-Path $root "infra\terraform"

Write-Host "This deletes ALL project resources in AWS, including stored readings and alerts." -ForegroundColor Yellow
$answer = Read-Host "Type DELETE to continue"
if ($answer -ne "DELETE") { Write-Host "Cancelled."; exit 1 }

$policy = terraform -chdir="$tf" output -raw iot_policy_name
$region = terraform -chdir="$tf" output -raw region

Write-Host "`n== 1/2 Device certificates ==" -ForegroundColor Cyan
Push-Location $root
uv run scripts/remove_certs.py --yes --region $region --policy $policy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "certificate removal failed; not destroying" }
Pop-Location

Write-Host "`n== 2/2 Terraform destroy ==" -ForegroundColor Cyan
terraform -chdir="$tf" destroy
if ($LASTEXITCODE -ne 0) { throw "terraform destroy did not complete" }

Write-Host "`nAll AWS resources for this project have been removed." -ForegroundColor Green
Write-Host "Run .\scripts\demo-up.ps1 to set everything up again."

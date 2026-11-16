# Sets up everything in AWS for a demo, in the right order.
#   1. terraform apply         (asks you to type "yes")
#   2. device certificates     (scripts/provision_certs.py)
#   3. writes the new API URL / IoT endpoint into simulator/.env and frontend/.env.local
#
# Run from the repo root:   .\scripts\demo-up.ps1
# Then start the simulator and the dashboard (printed at the end).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tf = Join-Path $root "infra\terraform"

function Set-EnvValue($file, $key, $value) {
    # Replace KEY=... in an env file, or append it. Other lines are kept.
    $lines = @()
    if (Test-Path $file) { $lines = @(Get-Content $file) }
    $found = $false
    $lines = $lines | ForEach-Object {
        if ($_ -match "^$key=") { $found = $true; "$key=$value" } else { $_ }
    }
    if (-not $found) { $lines += "$key=$value" }
    [IO.File]::WriteAllText($file, (($lines -join "`n") + "`n"))
}

Write-Host "`n== 1/3 Terraform: create AWS resources ==" -ForegroundColor Cyan
terraform -chdir="$tf" init -input=false | Out-Null
terraform -chdir="$tf" apply
if ($LASTEXITCODE -ne 0) { throw "terraform apply did not complete" }

$apiUrl = (terraform -chdir="$tf" output -raw api_url).TrimEnd("/")
$endpoint = terraform -chdir="$tf" output -raw iot_endpoint
$policy = terraform -chdir="$tf" output -raw iot_policy_name
$region = terraform -chdir="$tf" output -raw region

Write-Host "`n== 2/3 Device certificates ==" -ForegroundColor Cyan
Push-Location $root
uv run scripts/provision_certs.py --region $region --policy $policy
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "certificate provisioning failed" }
Pop-Location

Write-Host "`n== 3/3 Local configuration ==" -ForegroundColor Cyan
$simEnv = Join-Path $root "simulator\.env"
if (-not (Test-Path $simEnv)) { Copy-Item (Join-Path $root "simulator\.env.example") $simEnv }
Set-EnvValue $simEnv "IOT_ENDPOINT" $endpoint
$token = ((Get-Content $simEnv | Where-Object { $_ -like "CONTROL_TOKEN=*" }) -split "=", 2)[1]
if (-not $token -or $token -like "change-me*") {
    # cryptographically secure random token (32 bytes -> 64 hex chars)
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create() # works on Windows PowerShell 5.1 and 7
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    if ($token -match "^0+$") { throw "token generation failed" }
    Set-EnvValue $simEnv "CONTROL_TOKEN" $token
}

# Only the public API URL goes into the frontend. The control token is NOT written
# there: VITE_* values are built into the website's JavaScript.
$feEnv = Join-Path $root "frontend\.env.local"
Set-EnvValue $feEnv "VITE_API_BASE_URL" $apiUrl
Set-EnvValue $feEnv "VITE_SIM_CONTROL_URL" "http://127.0.0.1:8765"

Write-Host "`nReady." -ForegroundColor Green
Write-Host "  API:          $apiUrl"
Write-Host "  IoT endpoint: $endpoint"
Write-Host "`nNext, in two terminals:"
Write-Host "  cd simulator; uv run simulator.py"
Write-Host "  cd frontend;  npm run dev      -> http://localhost:5173"
Write-Host "`nFor the Simulation page buttons, paste CONTROL_TOKEN from simulator\.env into that page once."
Write-Host "`nIf the dashboard is deployed on Vercel, update its VITE_API_BASE_URL to the API above and redeploy."

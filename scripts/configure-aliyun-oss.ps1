param(
  [string]$Server = "47.110.180.137",
  [string]$User = "root",
  [string]$Bucket = "imaideo-media-4652437299",
  [string]$Region = "cn-hangzhou"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceEnvPath = Join-Path $projectRoot ".env"
$resultPath = Join-Path $projectRoot "artifacts\migration\oss-setup-result.json"
$helper = Join-Path $PSScriptRoot "configure-server-storage.py"
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
$publicEndpoint = "https://s3.oss-$Region.aliyuncs.com"
$internalEndpoint = "https://s3.oss-$Region-internal.aliyuncs.com"
$remoteHelper = "/tmp/configure-imaideo-oss.py"

function ConvertTo-PlainText([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-DotEnv([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $key = $matches[1]
    $value = $matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

function Save-Result([bool]$Ok, [string]$Message) {
  $directory = Split-Path -Parent $resultPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  @{
    ok = $Ok
    message = $Message
    bucket = $Bucket
    region = $Region
    completedAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}

$secret = $null
$payload = $null
$savedEnvironment = @{}

try {
  Write-Host ""
  Write-Host "Connect imaideo to Alibaba Cloud OSS" -ForegroundColor Cyan
  Write-Host "Bucket: $Bucket" -ForegroundColor DarkGray
  Write-Host "AccessKey Secret input is hidden." -ForegroundColor DarkGray
  Write-Host ""

  $accessKeyId = (Read-Host "RAM AccessKey ID").Trim()
  $secretSecure = Read-Host "RAM AccessKey Secret" -AsSecureString
  $secret = ConvertTo-PlainText $secretSecure
  if (!$accessKeyId -or !$secret) { throw "AccessKey ID and Secret are required." }

  $source = Read-DotEnv $sourceEnvPath
  $requiredSourceKeys = @('S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE')
  foreach ($key in $requiredSourceKeys) {
    if (!$source.ContainsKey($key) -or !$source[$key]) { throw "Local source setting is missing: $key" }
  }

  $managedKeys = @(
    'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE',
    'SOURCE_S3_ENDPOINT', 'SOURCE_S3_REGION', 'SOURCE_S3_BUCKET', 'SOURCE_S3_ACCESS_KEY_ID',
    'SOURCE_S3_SECRET_ACCESS_KEY', 'SOURCE_S3_FORCE_PATH_STYLE'
  )
  foreach ($key in $managedKeys) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  }

  $env:S3_ENDPOINT = $publicEndpoint
  $env:S3_REGION = $Region
  $env:S3_BUCKET = $Bucket
  $env:S3_ACCESS_KEY_ID = $accessKeyId
  $env:S3_SECRET_ACCESS_KEY = $secret
  $env:S3_FORCE_PATH_STYLE = 'false'
  $env:SOURCE_S3_ENDPOINT = $source.S3_ENDPOINT
  $env:SOURCE_S3_REGION = $source.S3_REGION
  $env:SOURCE_S3_BUCKET = $source.S3_BUCKET
  $env:SOURCE_S3_ACCESS_KEY_ID = $source.S3_ACCESS_KEY_ID
  $env:SOURCE_S3_SECRET_ACCESS_KEY = $source.S3_SECRET_ACCESS_KEY
  $env:SOURCE_S3_FORCE_PATH_STYLE = $source.S3_FORCE_PATH_STYLE

  Push-Location $projectRoot
  try {
    Write-Host "Testing OSS read/write/delete..." -ForegroundColor Yellow
    & npx tsx scripts/test-r2-storage.ts
    if ($LASTEXITCODE -ne 0) { throw "OSS read/write test failed. Check the RAM policy and keys." }

    Write-Host "Migrating database-linked local media..." -ForegroundColor Yellow
    & npx tsx scripts/migrate-media-to-r2.ts
    if ($LASTEXITCODE -ne 0) { throw "Local media migration failed." }

    Write-Host "Archiving local artifacts..." -ForegroundColor Yellow
    & npx tsx scripts/upload-local-artifacts-to-s3.ts --root artifacts --prefix archives/local-artifacts/2026-07-21
    if ($LASTEXITCODE -ne 0) { throw "Local artifact upload failed." }
  } finally {
    Pop-Location
  }

  $serverValues = @{
    S3_ENDPOINT = $internalEndpoint
    S3_REGION = $Region
    S3_BUCKET = $Bucket
    S3_ACCESS_KEY_ID = $accessKeyId
    S3_SECRET_ACCESS_KEY = $secret
    S3_FORCE_PATH_STYLE = 'false'
  }
  $payload = @{ values = $serverValues } | ConvertTo-Json -Compress

  & $scp -q -o BatchMode=yes $helper "${User}@${Server}:$remoteHelper"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload the server configuration helper." }
  $serverResult = $payload | & $ssh -o BatchMode=yes "$User@$Server" "python3 '$remoteHelper' /opt/imaideo/current/.env.production"
  if ($LASTEXITCODE -ne 0) { throw "Failed to update the server storage configuration." }

  Save-Result $true "OSS credentials verified; local media and artifacts uploaded; server environment prepared."
  Write-Host ""
  Write-Host "OSS setup completed successfully." -ForegroundColor Green
  Write-Host "You can return to Codex now." -ForegroundColor Green
} catch {
  Save-Result $false $_.Exception.Message
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
  }
  $secret = $null
  $payload = $null
  & $ssh -o BatchMode=yes "$User@$Server" "rm -f '$remoteHelper'" 2>$null | Out-Null
}

Write-Host ""
Read-Host "Press Enter to close"

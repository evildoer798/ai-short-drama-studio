$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$appEnvPath = Join-Path $projectRoot ".env"
$cloudEnvPath = Join-Path $projectRoot ".env.cloudflare"

if (-not (Test-Path -LiteralPath $appEnvPath)) {
  throw "Missing .env. Configure the local application before enabling Cloudflare."
}

function Read-Required([string]$Prompt) {
  $value = (Read-Host $Prompt).Trim()
  if (-not $value) {
    throw "$Prompt cannot be empty."
  }
  return $value
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if (-not $value) {
      throw "$Prompt cannot be empty."
    }
    return $value
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Unquote-EnvValue([string]$Value) {
  $trimmed = $Value.Trim()
  if ($trimmed.Length -ge 2 -and (
    ($trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) -or
    ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'"))
  )) {
    return $trimmed.Substring(1, $trimmed.Length - 2)
  }
  return $trimmed
}

function Get-EnvValue([string[]]$Lines, [string]$Key, [string]$Fallback) {
  foreach ($line in $Lines) {
    if ($line -match "^\s*$([Regex]::Escape($Key))\s*=\s*(.*)$") {
      return Unquote-EnvValue $Matches[1]
    }
  }
  return $Fallback
}

function Quote-EnvValue([string]$Value) {
  if ($Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "Environment values cannot contain line breaks."
  }
  return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Set-EnvValue(
  [System.Collections.Generic.List[string]]$Lines,
  [string]$Key,
  [string]$Value
) {
  $replacement = "$Key=$(Quote-EnvValue $Value)"
  for ($index = 0; $index -lt $Lines.Count; $index += 1) {
    if ($Lines[$index] -match "^\s*$([Regex]::Escape($Key))\s*=") {
      $Lines[$index] = $replacement
      return
    }
  }
  $Lines.Add($replacement)
}

$publicUrl = (Read-Required "Public URL, for example https://studio.example.com").TrimEnd('/')
$uri = $null
if (-not [Uri]::TryCreate($publicUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
  throw "Public URL must be a complete HTTPS URL."
}

$accountId = Read-Required "Cloudflare Account ID"
if ($accountId -notmatch '^[a-fA-F0-9]{32}$') {
  throw "Cloudflare Account ID should contain 32 hexadecimal characters."
}

$bucket = Read-Required "R2 bucket name (recommended: shortdrama-assets)"
if ($bucket -notmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') {
  throw "R2 bucket name must be 3-63 lowercase letters, numbers, dots, or hyphens."
}

$accessKeyId = Read-Required "R2 Access Key ID"
$secretAccessKey = Read-Secret "R2 Secret Access Key (hidden)"
$tunnelToken = Read-Secret "Cloudflare Tunnel token (hidden)"

$existingLines = [IO.File]::ReadAllLines($appEnvPath)
$sourceEndpoint = Get-EnvValue $existingLines "S3_ENDPOINT" "http://localhost:19100"
$sourceRegion = Get-EnvValue $existingLines "S3_REGION" "us-east-1"
$sourceBucket = Get-EnvValue $existingLines "S3_BUCKET" "shortdrama-assets"
$sourceAccessKey = Get-EnvValue $existingLines "S3_ACCESS_KEY_ID" "minioadmin"
$sourceSecretKey = Get-EnvValue $existingLines "S3_SECRET_ACCESS_KEY" "minioadmin"
$sourceForcePathStyle = Get-EnvValue $existingLines "S3_FORCE_PATH_STYLE" "true"

if ($sourceEndpoint -match '\.r2\.cloudflarestorage\.com') {
  $sourceEndpoint = "http://localhost:19100"
  $sourceRegion = "us-east-1"
  $sourceBucket = "shortdrama-assets"
  $sourceAccessKey = "minioadmin"
  $sourceSecretKey = "minioadmin"
  $sourceForcePathStyle = "true"
}

$r2Endpoint = "https://$accountId.r2.cloudflarestorage.com"
$cloudValues = [ordered]@{
  CLOUDFLARE_TUNNEL_TOKEN = $tunnelToken
  CLOUDFLARE_PUBLIC_URL = $publicUrl
  CLOUDFLARE_ACCOUNT_ID = $accountId
  S3_ENDPOINT = $r2Endpoint
  S3_REGION = "auto"
  S3_BUCKET = $bucket
  S3_ACCESS_KEY_ID = $accessKeyId
  S3_SECRET_ACCESS_KEY = $secretAccessKey
  S3_FORCE_PATH_STYLE = "false"
  SOURCE_S3_ENDPOINT = $sourceEndpoint
  SOURCE_S3_REGION = $sourceRegion
  SOURCE_S3_BUCKET = $sourceBucket
  SOURCE_S3_ACCESS_KEY_ID = $sourceAccessKey
  SOURCE_S3_SECRET_ACCESS_KEY = $sourceSecretKey
  SOURCE_S3_FORCE_PATH_STYLE = $sourceForcePathStyle
}

$cloudLines = foreach ($entry in $cloudValues.GetEnumerator()) {
  "$($entry.Key)=$(Quote-EnvValue ([string]$entry.Value))"
}
[IO.File]::WriteAllLines($cloudEnvPath, $cloudLines, [Text.UTF8Encoding]::new($false))

$backupName = ".env.before-cloudflare-$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
$backupPath = Join-Path $projectRoot $backupName
Copy-Item -LiteralPath $appEnvPath -Destination $backupPath

$updatedLines = [System.Collections.Generic.List[string]]::new()
$updatedLines.AddRange([string[]]$existingLines)
Set-EnvValue $updatedLines "APP_URL" $publicUrl
Set-EnvValue $updatedLines "S3_ENDPOINT" $r2Endpoint
Set-EnvValue $updatedLines "S3_REGION" "auto"
Set-EnvValue $updatedLines "S3_BUCKET" $bucket
Set-EnvValue $updatedLines "S3_ACCESS_KEY_ID" $accessKeyId
Set-EnvValue $updatedLines "S3_SECRET_ACCESS_KEY" $secretAccessKey
Set-EnvValue $updatedLines "S3_FORCE_PATH_STYLE" "false"
[IO.File]::WriteAllLines($appEnvPath, $updatedLines, [Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Cloudflare beta configuration saved." -ForegroundColor Green
Write-Host "Application environment backup: $backupName"
Write-Host "Public hostname: $($uri.Host)"
Write-Host "Tunnel service URL: http://host.docker.internal:14000"
Write-Host "Secrets were written only to ignored local environment files."

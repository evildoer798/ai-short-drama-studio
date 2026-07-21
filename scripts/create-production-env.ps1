param(
  [string]$Domain = "imaideo.xyz",
  [string]$ServerIp = "47.110.180.137"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourcePath = Join-Path $projectRoot ".env"
$targetPath = Join-Path $projectRoot ".env.production"

function Read-Env([string]$path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    if ($line -match '^([^#=]+)="?(.*?)"?$') {
      $values[$matches[1]] = $matches[2].TrimEnd('"')
    }
  }
  return $values
}

function Random-Hex([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return ([System.BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

if (!(Test-Path -LiteralPath $sourcePath)) { throw ".env not found" }
$source = Read-Env $sourcePath
$copyNames = @(
  'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_IMAGE_MODE',
  'IMAGE_MODEL', 'IMAGE_QUALITY', 'IMAGE_SIZE', 'IMAGE_OUTPUT_FORMAT',
  'IMAGE_OUTPUT_COMPRESSION', 'IMAGE_PARTIAL_IMAGES', 'IMAGE_STREAM', 'IMAGE_ASYNC',
  'TEXT_API_BASE_URL', 'TEXT_API_KEY', 'TEXT_API_MODE', 'TEXT_MODEL',
  'TEXT_REASONING_EFFORT', 'TEXT_ANALYSIS_CONCURRENCY', 'TEXT_EPISODE_CONCURRENCY',
  'TEXT_ASSET_CONCURRENCY', 'TEXT_STORYBOARD_CONCURRENCY',
  'VIDEO_API_BASE_URL', 'VIDEO_DIRECT_API_BASE_URL', 'VIDEO_API_KEY', 'VIDEO_API_MODE',
  'VIDEO_MODEL', 'VIDEO_SECONDS', 'VIDEO_SIZE',
  'GROK_VIDEO_API_BASE_URL', 'GROK_VIDEO_API_KEY', 'GROK_VIDEO_API_MODE', 'GROK_VIDEO_MODEL',
  'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'SEED_WORKSPACE_NAME', 'SEED_PROJECT_NAME'
)

$values = [ordered]@{
  NODE_ENV = 'production'
  APP_DOMAIN = $Domain
  SERVER_IP = $ServerIp
  AUTH_SECRET = Random-Hex 48
  POSTGRES_PASSWORD = Random-Hex 24
  MINIO_ROOT_USER = 'imaideo'
  MINIO_ROOT_PASSWORD = Random-Hex 24
  S3_REGION = 'us-east-1'
  S3_BUCKET = 'shortdrama-assets'
  S3_FORCE_PATH_STYLE = 'true'
}
foreach ($name in $copyNames) {
  if ($source.ContainsKey($name) -and ![string]::IsNullOrWhiteSpace($source[$name])) {
    $values[$name] = $source[$name]
  }
}

$lines = $values.GetEnumerator() | ForEach-Object {
  $escaped = ([string]$_.Value).Replace('"', '\"')
  '{0}="{1}"' -f $_.Key, $escaped
}
[System.IO.File]::WriteAllLines($targetPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Created $targetPath without printing secrets." -ForegroundColor Green

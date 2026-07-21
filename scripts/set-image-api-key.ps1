param(
  [string]$BaseUrl = "https://ai.cangyuansuanli.cn",
  [string]$Model = "gpt-image-2"
)

$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot "..\.env"
if (!(Test-Path -LiteralPath $envPath)) {
  throw ".env not found at $envPath"
}

Write-Host ""
Write-Host "Configure the image generation API" -ForegroundColor Cyan
Write-Host "Endpoint: $BaseUrl"
Write-Host "Model:    $Model"
Write-Host "The key stays hidden while you type or paste it."
Write-Host ""

$secureKey = Read-Host "Enter the image API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "API key cannot be empty"
}

$content = Get-Content -LiteralPath $envPath
$updated = $false
$next = foreach ($line in $content) {
  if ($line -match '^OPENAI_COMPAT_BASE_URL=') {
    "OPENAI_COMPAT_BASE_URL=`"$BaseUrl`""
  } elseif ($line -match '^OPENAI_COMPAT_API_KEY=') {
    $updated = $true
    "OPENAI_COMPAT_API_KEY=`"$apiKey`""
  } elseif ($line -match '^IMAGE_MODEL=') {
    "IMAGE_MODEL=`"$Model`""
  } elseif ($line -match '^OPENAI_COMPAT_IMAGE_MODE=') {
    'OPENAI_COMPAT_IMAGE_MODE="images"'
  } elseif ($line -match '^IMAGE_QUALITY=') {
    'IMAGE_QUALITY="low"'
  } elseif ($line -match '^IMAGE_SIZE=') {
    'IMAGE_SIZE="1024x1024"'
  } elseif ($line -match '^IMAGE_OUTPUT_FORMAT=') {
    'IMAGE_OUTPUT_FORMAT="jpeg"'
  } elseif ($line -match '^IMAGE_OUTPUT_COMPRESSION=') {
    'IMAGE_OUTPUT_COMPRESSION="75"'
  } elseif ($line -match '^IMAGE_STREAM=') {
    'IMAGE_STREAM="false"'
  } elseif ($line -match '^IMAGE_ASYNC=') {
    'IMAGE_ASYNC="true"'
  } else {
    $line
  }
}

if (!$updated) {
  $next += "OPENAI_COMPAT_API_KEY=`"$apiKey`""
}

Set-Content -LiteralPath $envPath -Value $next -Encoding UTF8
Write-Host ""
Write-Host "Saved. You may close this terminal after Codex finishes the connection test." -ForegroundColor Green

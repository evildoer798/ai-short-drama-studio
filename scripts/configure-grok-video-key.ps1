param(
  [string]$BaseUrl = "https://sub.kedaya.xyz"
)

$ErrorActionPreference = "Stop"

function Convert-SecureStringToPlainText {
  param([securestring]$SecureString)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Set-DotEnvValue {
  param(
    [string]$Content,
    [string]$Name,
    [string]$Value
  )

  if ($Value -match "[`r`n]") {
    throw "$Name must not contain a newline."
  }

  $escapedValue = $Value.Replace("\", "\\").Replace('"', '\"')
  $entry = "$Name=`"$escapedValue`""
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"

  if ([regex]::IsMatch($Content, $pattern)) {
    return [regex]::Replace($Content, $pattern, $entry)
  }

  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) {
    $Content += "`r`n"
  }
  return $Content + $entry + "`r`n"
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Missing project .env file: $envPath"
}

Write-Host "Grok video API configuration"
Write-Host "Provider: $BaseUrl"
Write-Host "The API key will be stored only in the ignored project .env file."
Write-Host ""

$secureKey = Read-Host "Enter the Grok video API key" -AsSecureString
$apiKey = Convert-SecureStringToPlainText $secureKey
if (-not $apiKey -or -not $apiKey.Trim()) {
  throw "API key is empty."
}

$content = [IO.File]::ReadAllText($envPath)
$content = Set-DotEnvValue -Content $content -Name "GROK_VIDEO_API_BASE_URL" -Value $BaseUrl.TrimEnd('/')
$content = Set-DotEnvValue -Content $content -Name "GROK_VIDEO_API_KEY" -Value $apiKey.Trim()
$content = Set-DotEnvValue -Content $content -Name "GROK_VIDEO_API_MODE" -Value "auto"
$content = Set-DotEnvValue -Content $content -Name "GROK_VIDEO_MODEL" -Value ""
[IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))

$apiKey = $null
Write-Host ""
Write-Host "Grok video API key saved. The key was not displayed or logged."
Read-Host "Press Enter to close"

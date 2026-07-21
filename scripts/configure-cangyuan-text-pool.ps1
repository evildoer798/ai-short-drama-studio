param(
  [string]$BaseUrl = "https://ai.cangyuansuanli.cn",
  [string]$Model = "gpt-5.5",
  [ValidateRange(1, 10)]
  [int]$KeyCount = 10
)

$ErrorActionPreference = "Stop"

function ConvertFrom-HiddenInput([Security.SecureString]$secureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Update-EnvFile([string]$path, [System.Collections.IDictionary]$settings) {
  $remaining = [ordered]@{}
  foreach ($entry in $settings.GetEnumerator()) {
    $remaining[$entry.Key] = [string]$entry.Value
  }

  $output = [System.Collections.Generic.List[string]]::new()
  foreach ($line in (Get-Content -LiteralPath $path -Encoding UTF8)) {
    $matchedName = $null
    foreach ($name in @($remaining.Keys)) {
      if ($line -match "^$([Regex]::Escape($name))=") {
        $matchedName = $name
        break
      }
    }

    if ($null -eq $matchedName) {
      $output.Add($line)
      continue
    }

    $escaped = $remaining[$matchedName].Replace('"', '\"')
    $output.Add(('{0}="{1}"' -f $matchedName, $escaped))
    $remaining.Remove($matchedName)
  }

  if ($remaining.Count -gt 0) {
    if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") {
      $output.Add("")
    }
    foreach ($entry in $remaining.GetEnumerator()) {
      $escaped = ([string]$entry.Value).Replace('"', '\"')
      $output.Add(('{0}="{1}"' -f $entry.Key, $escaped))
    }
  }

  $tempPath = "$path.tmp"
  [IO.File]::WriteAllLines($tempPath, $output, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $path -Force
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
$productionEnvPath = Join-Path $projectRoot ".env.production"
$normalizedBaseUrl = $BaseUrl.Trim().TrimEnd('/')

try {
  if (!(Test-Path -LiteralPath $envPath)) {
    throw ".env was not found at $envPath"
  }
  if ([string]::IsNullOrWhiteSpace($normalizedBaseUrl)) {
    throw "Base URL cannot be empty"
  }
  if ([string]::IsNullOrWhiteSpace($Model)) {
    throw "Model cannot be empty"
  }

  Write-Host ""
  Write-Host "Cangyuan text API key pool" -ForegroundColor Cyan
  Write-Host "Endpoint: $normalizedBaseUrl"
  Write-Host "Model: $Model"
  Write-Host "Enter $KeyCount different API keys. Input is hidden and is never printed." -ForegroundColor Yellow
  Write-Host ""

  $keys = [System.Collections.Generic.List[string]]::new()
  for ($index = 1; $index -le $KeyCount; $index++) {
    while ($true) {
      $secureKey = Read-Host "API key $index of $KeyCount" -AsSecureString
      $apiKey = ConvertFrom-HiddenInput $secureKey
      $secureKey.Dispose()
      if ($null -ne $apiKey) { $apiKey = $apiKey.Trim() }

      if ([string]::IsNullOrWhiteSpace($apiKey)) {
        Write-Host "The key cannot be empty. Enter this key again." -ForegroundColor Red
        $apiKey = $null
        continue
      }
      if ($keys.Contains($apiKey)) {
        Write-Host "This key was already entered. Enter a different key." -ForegroundColor Red
        $apiKey = $null
        continue
      }

      $keys.Add($apiKey)
      $apiKey = $null
      Write-Host "Key $index accepted." -ForegroundColor DarkGreen
      break
    }
  }

  $settings = [ordered]@{
    TEXT_API_BASE_URL = $normalizedBaseUrl
    TEXT_API_KEY = $keys[0]
    TEXT_API_MODE = "chat_completions"
    TEXT_MODEL = $Model.Trim()
    TEXT_REASONING_EFFORT = "low"
    TEXT_STORYBOARD_CONCURRENCY = [string]$KeyCount
  }
  for ($index = 1; $index -le 10; $index++) {
    $settings["TEXT_API_KEY_$index"] = if ($index -le $keys.Count) { $keys[$index - 1] } else { "" }
  }

  Update-EnvFile $envPath $settings
  if (Test-Path -LiteralPath $productionEnvPath) {
    Update-EnvFile $productionEnvPath $settings
  }

  $keys.Clear()
  $keys = $null
  Write-Host ""
  Write-Host "$KeyCount keys saved successfully. No key value was displayed." -ForegroundColor Green
  Write-Host "Keep this window open until Codex confirms that the worker has reloaded." -ForegroundColor Cyan
} catch {
  $apiKey = $null
  if ($null -ne $keys) {
    $keys.Clear()
    $keys = $null
  }
  Write-Host ""
  Write-Host "Configuration failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close this window"

param(
  [string]$BaseUrl = "https://api.deepseek.com",
  [string]$Model = "deepseek-chat",
  [switch]$SkipConnectionTest
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function ConvertFrom-HiddenInput([Security.SecureString]$secureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-EnvFile([string]$path) {
  $settings = [ordered]@{}
  foreach ($line in (Get-Content -LiteralPath $path -Encoding UTF8)) {
    if ($line -notmatch '^([A-Z0-9_]+)=(.*)$') { continue }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2).Replace('\"', '"')
    }
    $settings[$name] = $value
  }
  return $settings
}

function Get-NumberedKeys([System.Collections.IDictionary]$settings, [string]$prefix) {
  $keys = [System.Collections.Generic.List[string]]::new()
  for ($index = 1; $index -le 10; $index++) {
    $value = [string]$settings["${prefix}_$index"]
    if (![string]::IsNullOrWhiteSpace($value) -and !$keys.Contains($value.Trim())) {
      $keys.Add($value.Trim())
    }
  }
  return ,$keys
}

function Update-EnvFile([string]$path, [System.Collections.IDictionary]$settings) {
  $remaining = [ordered]@{}
  foreach ($entry in $settings.GetEnumerator()) { $remaining[$entry.Key] = [string]$entry.Value }
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
    if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") { $output.Add("") }
    foreach ($entry in $remaining.GetEnumerator()) {
      $escaped = ([string]$entry.Value).Replace('"', '\"')
      $output.Add(('{0}="{1}"' -f $entry.Key, $escaped))
    }
  }

  $tempPath = "$path.tmp"
  [IO.File]::WriteAllLines($tempPath, $output, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $path -Force
}

function Invoke-DeepSeekProbe([string]$baseUrl, [string]$apiKey, [string]$model) {
  $probePath = Join-Path $PSScriptRoot 'probe-deepseek-key.mjs'
  if (!(Test-Path -LiteralPath $probePath)) { throw "DeepSeek probe script was not found at $probePath" }
  try {
    $env:DEEPSEEK_PROBE_BASE_URL = $baseUrl
    $env:DEEPSEEK_PROBE_API_KEY = $apiKey
    $env:DEEPSEEK_PROBE_MODEL = $model
    $result = & node $probePath 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($result | Out-String).Trim()) }
    if (($result | Out-String) -notmatch 'DEEPSEEK_PROBE_OK') { throw 'DeepSeek probe did not return a success marker.' }
  } finally {
    Remove-Item Env:DEEPSEEK_PROBE_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:DEEPSEEK_PROBE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:DEEPSEEK_PROBE_MODEL -ErrorAction SilentlyContinue
  }
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
$productionEnvPath = Join-Path $projectRoot ".env.production"
$statusPath = Join-Path $projectRoot ".deepseek-config-status.txt"
$normalizedBaseUrl = $BaseUrl.Trim().TrimEnd('/')
$apiKey = $null
if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath -Force }

try {
  if (!(Test-Path -LiteralPath $envPath)) { throw ".env was not found at $envPath" }
  $current = Read-EnvFile $envPath

  $currentPrimaryBase = [string]$current['TEXT_API_BASE_URL']
  $currentFallbackBase = [string]$current['TEXT_FALLBACK_API_BASE_URL']
  $currentTertiaryBase = [string]$current['TEXT_TERTIARY_API_BASE_URL']

  if ($currentFallbackBase -match 'cangyuansuanli') {
    $cangyuanBase = $currentFallbackBase
    $cangyuanModel = [string]$current['TEXT_FALLBACK_MODEL']
    $cangyuanMode = [string]$current['TEXT_FALLBACK_API_MODE']
    $cangyuanReasoning = [string]$current['TEXT_FALLBACK_REASONING_EFFORT']
    $cangyuanKeys = Get-NumberedKeys $current 'TEXT_FALLBACK_API_KEY'
    if ($cangyuanKeys.Count -eq 0 -and $current['TEXT_FALLBACK_API_KEY']) { $cangyuanKeys.Add(([string]$current['TEXT_FALLBACK_API_KEY']).Trim()) }
  } else {
    $cangyuanBase = if ($currentPrimaryBase -match 'cangyuansuanli') { $currentPrimaryBase } else { 'https://ai.cangyuansuanli.cn' }
    $cangyuanModel = if ($currentPrimaryBase -match 'cangyuansuanli') { [string]$current['TEXT_MODEL'] } else { 'gpt-5.5' }
    $cangyuanMode = if ($currentPrimaryBase -match 'cangyuansuanli') { [string]$current['TEXT_API_MODE'] } else { 'chat_completions' }
    $cangyuanReasoning = if ($currentPrimaryBase -match 'cangyuansuanli') { [string]$current['TEXT_REASONING_EFFORT'] } else { 'low' }
    $cangyuanKeys = Get-NumberedKeys $current 'TEXT_API_KEY'
    if ($cangyuanKeys.Count -eq 0 -and $currentPrimaryBase -match 'cangyuansuanli' -and $current['TEXT_API_KEY']) {
      $cangyuanKeys.Add(([string]$current['TEXT_API_KEY']).Trim())
    }
  }

  if (![string]::IsNullOrWhiteSpace($currentTertiaryBase)) {
    $kedayaBase = $currentTertiaryBase
    $kedayaKey = [string]$current['TEXT_TERTIARY_API_KEY']
    $kedayaMode = [string]$current['TEXT_TERTIARY_API_MODE']
    $kedayaModel = [string]$current['TEXT_TERTIARY_MODEL']
    $kedayaReasoning = [string]$current['TEXT_TERTIARY_REASONING_EFFORT']
  } elseif (![string]::IsNullOrWhiteSpace($currentFallbackBase) -and $currentFallbackBase -notmatch 'cangyuansuanli') {
    $kedayaBase = $currentFallbackBase
    $kedayaKey = [string]$current['TEXT_FALLBACK_API_KEY']
    $kedayaMode = [string]$current['TEXT_FALLBACK_API_MODE']
    $kedayaModel = [string]$current['TEXT_FALLBACK_MODEL']
    $kedayaReasoning = [string]$current['TEXT_FALLBACK_REASONING_EFFORT']
  } else {
    $kedayaBase = ''
    $kedayaKey = ''
    $kedayaMode = 'responses'
    $kedayaModel = 'gpt-5.6-sol'
    $kedayaReasoning = 'xhigh'
  }

  Write-Host ""
  Write-Host "Configure DeepSeek as the primary text provider" -ForegroundColor Cyan
  Write-Host "Endpoint: $normalizedBaseUrl"
  Write-Host "Model: $Model"
  Write-Host "Existing Cangyuan keys retained as fallback: $($cangyuanKeys.Count)"
  Write-Host "The DeepSeek API key stays hidden while you type or paste it." -ForegroundColor Yellow
  Write-Host ""

  $secureKey = Read-Host "Enter the DeepSeek API key" -AsSecureString
  $apiKey = ConvertFrom-HiddenInput $secureKey
  $secureKey.Dispose()
  if ($null -ne $apiKey) { $apiKey = $apiKey.Trim() }
  if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'DeepSeek API key cannot be empty.' }

  if (!$SkipConnectionTest) {
    Write-Host "Testing a tiny DeepSeek chat request..." -ForegroundColor DarkCyan
    Invoke-DeepSeekProbe $normalizedBaseUrl $apiKey $Model.Trim()
  }

  $settings = [ordered]@{
    TEXT_API_BASE_URL = $normalizedBaseUrl
    TEXT_API_KEY = $apiKey
    TEXT_API_MODE = 'chat_completions'
    TEXT_MODEL = $Model.Trim()
    TEXT_REASONING_EFFORT = ''
    TEXT_PRIMARY_CONCURRENCY_PER_KEY = '3'
    TEXT_ANALYSIS_CONCURRENCY = '3'
    TEXT_EPISODE_CONCURRENCY = '3'
    TEXT_ASSET_CONCURRENCY = '3'
    TEXT_STORYBOARD_CONCURRENCY = '3'
    TEXT_FALLBACK_API_BASE_URL = $cangyuanBase
    TEXT_FALLBACK_API_KEY = if ($cangyuanKeys.Count -gt 0) { $cangyuanKeys[0] } else { '' }
    TEXT_FALLBACK_API_MODE = if ($cangyuanMode) { $cangyuanMode } else { 'chat_completions' }
    TEXT_FALLBACK_MODEL = if ($cangyuanModel) { $cangyuanModel } else { 'gpt-5.5' }
    TEXT_FALLBACK_REASONING_EFFORT = if ($cangyuanReasoning) { $cangyuanReasoning } else { 'low' }
    TEXT_TERTIARY_API_BASE_URL = $kedayaBase
    TEXT_TERTIARY_API_KEY = $kedayaKey
    TEXT_TERTIARY_API_MODE = $kedayaMode
    TEXT_TERTIARY_MODEL = $kedayaModel
    TEXT_TERTIARY_REASONING_EFFORT = $kedayaReasoning
  }
  for ($index = 1; $index -le 10; $index++) {
    $settings["TEXT_API_KEY_$index"] = ''
    $settings["TEXT_FALLBACK_API_KEY_$index"] = if ($index -le $cangyuanKeys.Count) { $cangyuanKeys[$index - 1] } else { '' }
  }

  Update-EnvFile $envPath $settings
  if (Test-Path -LiteralPath $productionEnvPath) { Update-EnvFile $productionEnvPath $settings }

  $apiKey = $null
  $cangyuanKeys.Clear()
  [IO.File]::WriteAllText($statusPath, 'SUCCESS', [Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "DeepSeek connection passed and is now the primary text provider." -ForegroundColor Green
  Write-Host "Cangyuan remains the second provider; Kedaya remains the final provider." -ForegroundColor Cyan
} catch {
  $apiKey = $null
  $safeError = $_.Exception.Message -replace 'sk-[A-Za-z0-9_-]+', '[REDACTED]'
  [IO.File]::WriteAllText($statusPath, "FAILED: $safeError", [Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "Configuration failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "No provider settings were changed when the DeepSeek test failed." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to close this window"

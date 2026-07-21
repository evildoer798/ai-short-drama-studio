param(
  [string]$BaseUrl = "https://ai.cangyuansuanli.cn",
  [string]$Model = "",
  [switch]$RestartDockerServices,
  [switch]$SkipConnectionTest
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-CurlJson(
  [string]$Method,
  [string]$Uri,
  [string]$ApiKey,
  [string]$Body = ""
) {
  $arguments = @(
    '-sS',
    '--fail-with-body',
    '--connect-timeout', '15',
    '--max-time', '90',
    '-X', $Method,
    $Uri,
    '-H', "Authorization: Bearer $ApiKey",
    '-H', 'Content-Type: application/json'
  )
  $bodyPath = $null
  try {
    if (![string]::IsNullOrWhiteSpace($Body)) {
      $bodyPath = [System.IO.Path]::GetTempFileName()
      [System.IO.File]::WriteAllText($bodyPath, $Body, [System.Text.UTF8Encoding]::new($false))
      $arguments += @('--data-binary', "@$bodyPath")
    }
    $raw = & curl.exe @arguments
    if ($LASTEXITCODE -ne 0) {
      throw (($raw | Out-String).Trim())
    }
    return (($raw | Out-String) | ConvertFrom-Json)
  } finally {
    if ($bodyPath -and (Test-Path -LiteralPath $bodyPath)) {
      Remove-Item -LiteralPath $bodyPath -Force
    }
  }
}

function Get-ModelIds($response) {
  $ids = [System.Collections.Generic.List[string]]::new()
  $items = if ($null -ne $response.data) { @($response.data) } elseif ($null -ne $response.models) { @($response.models) } else { @() }
  foreach ($item in $items) {
    if ($item -is [string] -and ![string]::IsNullOrWhiteSpace($item)) {
      $ids.Add($item.Trim())
    } elseif ($null -ne $item.id -and ![string]::IsNullOrWhiteSpace([string]$item.id)) {
      $ids.Add(([string]$item.id).Trim())
    }
  }
  return @($ids | Sort-Object -Unique)
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

    if ($null -ne $matchedName) {
      $escaped = $remaining[$matchedName].Replace('"', '\"')
      $output.Add(('{0}="{1}"' -f $matchedName, $escaped))
      $remaining.Remove($matchedName)
    } else {
      $output.Add($line)
    }
  }

  if ($remaining.Count -gt 0) {
    if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") { $output.Add("") }
    foreach ($entry in $remaining.GetEnumerator()) {
      $escaped = ([string]$entry.Value).Replace('"', '\"')
      $output.Add(('{0}="{1}"' -f $entry.Key, $escaped))
    }
  }

  $tempPath = "$path.tmp"
  $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllLines($tempPath, $output, $utf8WithoutBom)
  Move-Item -LiteralPath $tempPath -Destination $path -Force
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
$normalizedBaseUrl = $BaseUrl.TrimEnd('/')

try {
  if (!(Test-Path -LiteralPath $envPath)) { throw ".env not found at $envPath" }

  Write-Host ""
  Write-Host "Configure Cangyuan text API for stages 1-3" -ForegroundColor Cyan
  Write-Host "Endpoint: $normalizedBaseUrl"
  Write-Host "The API key stays hidden while you type or paste it."
  Write-Host "This script checks the model list and sends one tiny READY request."
  Write-Host ""

  $secureKey = Read-Host "Enter an API key with text-model access" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "API key cannot be empty" }
  $apiKey = $apiKey.Trim()
  if ($SkipConnectionTest) {
    if ([string]::IsNullOrWhiteSpace($Model)) { throw "Model is required when connection testing is skipped." }
    $selectedModel = $Model
    $mode = 'chat_completions'
  } else {
    Write-Host "Checking models available to this token..." -ForegroundColor DarkCyan
    $modelResponse = Invoke-CurlJson -Method Get -Uri "$normalizedBaseUrl/v1/models" -ApiKey $apiKey
    $modelIds = @(Get-ModelIds $modelResponse)
    $mediaPattern = '(?i)(image|banana|firefly|sora|veo|seedance|flux|video|sd\d)'
    $textModels = @($modelIds | Where-Object { $_ -notmatch $mediaPattern })

    if ($textModels.Count -eq 0) {
      throw "This token only exposes image/video models. Enable a text-model group and retry."
    }

    if (![string]::IsNullOrWhiteSpace($Model)) {
      $selectedModel = $textModels | Where-Object { $_ -eq $Model } | Select-Object -First 1
      if ([string]::IsNullOrWhiteSpace($selectedModel)) {
        throw "Model $Model is not available to this token."
      }
    } else {
      $preferredNames = @('gpt-5.6-sol', 'gpt-5.5', 'gpt-5', 'claude', 'gemini')
      $selectedModel = $null
      foreach ($preferred in $preferredNames) {
        $selectedModel = $textModels | Where-Object { $_ -like "*$preferred*" } | Select-Object -First 1
        if (![string]::IsNullOrWhiteSpace($selectedModel)) { break }
      }
      if ([string]::IsNullOrWhiteSpace($selectedModel)) { $selectedModel = $textModels[0] }
    }

    Write-Host "Available text models: $($textModels -join ', ')" -ForegroundColor DarkGray
    Write-Host "Selected model: $selectedModel" -ForegroundColor Cyan
    Write-Host "Testing text generation..." -ForegroundColor DarkCyan

    $mode = $null
    try {
      $chatBody = @{
        model = $selectedModel
        messages = @(
          @{ role = 'system'; content = 'You are an API connectivity checker.' },
          @{ role = 'user'; content = 'Reply with exactly READY.' }
        )
        temperature = 0
        max_tokens = 32
      } | ConvertTo-Json -Depth 8 -Compress
      $chatResponse = Invoke-CurlJson -Method Post -Uri "$normalizedBaseUrl/v1/chat/completions" -ApiKey $apiKey -Body $chatBody
      $chatText = [string]$chatResponse.choices[0].message.content
      if ([string]::IsNullOrWhiteSpace($chatText)) { throw "chat/completions returned empty content" }
      $mode = 'chat_completions'
    } catch {
      $responsesBody = @{
        model = $selectedModel
        input = @(
          @{ role = 'system'; content = 'You are an API connectivity checker.' },
          @{ role = 'user'; content = 'Reply with exactly READY.' }
        )
        max_output_tokens = 32
        store = $false
      } | ConvertTo-Json -Depth 8 -Compress
      $responsesResult = Invoke-CurlJson -Method Post -Uri "$normalizedBaseUrl/v1/responses" -ApiKey $apiKey -Body $responsesBody
      if ($null -eq $responsesResult) { throw "Neither text endpoint returned a valid result" }
      $mode = 'responses'
    }
  }

  $settings = [ordered]@{
    TEXT_API_BASE_URL = $normalizedBaseUrl
    TEXT_API_KEY = $apiKey
    TEXT_API_MODE = $mode
    TEXT_MODEL = $selectedModel
    TEXT_REASONING_EFFORT = "low"
    TEXT_ANALYSIS_CONCURRENCY = "3"
    TEXT_EPISODE_CONCURRENCY = "3"
    TEXT_ASSET_CONCURRENCY = "4"
    TEXT_STORYBOARD_CONCURRENCY = "2"
  }
  Update-EnvFile $envPath $settings
  $apiKey = $null

  Write-Host "Connection test passed. Text settings were saved; image/video settings were unchanged." -ForegroundColor Green
  if ($RestartDockerServices) {
    Write-Host "Reloading web and worker services..." -ForegroundColor DarkCyan
    Push-Location $projectRoot
    try {
      & docker compose up -d --force-recreate web worker
      if ($LASTEXITCODE -ne 0) { throw "Docker service reload failed. Keep this window open and notify Codex." }
    } finally {
      Pop-Location
    }
  }
  Write-Host "Done. Codex will reload the local worker." -ForegroundColor Green
} catch {
  $apiKey = $null
  Write-Host ""
  Write-Host "Configuration failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "An image/video token cannot be used as a text-model token." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to close this window"

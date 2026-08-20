param(
  [string]$BaseUrl = ""
)

$ErrorActionPreference = "Stop"

function ConvertFrom-HiddenInput([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-EnvValues([string]$Path) {
  $values = @{}
  if (!(Test-Path -LiteralPath $Path)) { return $values }
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line.TrimStart().StartsWith('#') -or $line -notmatch '=') { continue }
    $name, $value = $line.Split('=', 2)
    $value = $value.Trim()
    if ($value.Length -ge 2) {
      $first = [string]$value[0]
      $last = [string]$value[$value.Length - 1]
      if ($first -eq $last -and ($first -eq '"' -or $first -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    $values[$name.Trim()] = $value
  }
  return $values
}

function Update-EnvFile([string]$Path, [string]$Name, [string]$Value) {
  if ($Value -match '[\r\n"]') { throw "$Name contains an unsupported character" }
  $entry = '{0}="{1}"' -f $Name, $Value
  $lines = [System.Collections.Generic.List[string]]::new()
  $updated = $false
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    if ($line -match "^$([Regex]::Escape($Name))=") {
      $lines.Add($entry)
      $updated = $true
    } else {
      $lines.Add($line)
    }
  }
  if (!$updated) {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne '') { $lines.Add('') }
    $lines.Add($entry)
  }
  $temporaryPath = "$Path.tmp"
  [IO.File]::WriteAllLines($temporaryPath, $lines, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Get-ModelsUrl([string]$ProviderBaseUrl) {
  $normalized = $ProviderBaseUrl.Trim().TrimEnd('/')
  if ($normalized.EndsWith('/v1')) { return "$normalized/models" }
  return "$normalized/v1/models"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envPath = Join-Path $projectRoot '.env'
$productionEnvPath = Join-Path $projectRoot '.env.production'
$statusPath = Join-Path $projectRoot '.video-api-config-status.txt'
$apiKey = $null

try {
  [IO.File]::WriteAllText($statusPath, 'WAITING', [Text.UTF8Encoding]::new($false))
  if (!(Test-Path -LiteralPath $envPath)) { throw '.env was not found' }
  $localValues = Read-EnvValues $envPath
  $productionValues = Read-EnvValues $productionEnvPath

  if ($BaseUrl.Trim()) {
    $configuredBaseUrl = $BaseUrl.Trim().TrimEnd('/')
  } elseif ($productionValues.VIDEO_API_BASE_URL) {
    $configuredBaseUrl = $productionValues.VIDEO_API_BASE_URL.TrimEnd('/')
  } elseif ($localValues.VIDEO_API_BASE_URL) {
    $configuredBaseUrl = $localValues.VIDEO_API_BASE_URL.TrimEnd('/')
  } else {
    $configuredBaseUrl = 'http://direct-api.cangyuansuanli.cn'
  }

  $slot = 2..10 | Where-Object {
    !$localValues["VIDEO_API_KEY_$_"] -and !$productionValues["VIDEO_API_KEY_$_"]
  } | Select-Object -First 1
  if (!$slot) { throw 'VIDEO_API_KEY_2 through VIDEO_API_KEY_10 are all occupied' }

  Write-Host ''
  Write-Host 'Add a video API key' -ForegroundColor Cyan
  Write-Host "Endpoint: $configuredBaseUrl"
  Write-Host "Target slot: VIDEO_API_KEY_$slot"
  Write-Host 'Input is hidden. Configuration changes only after the API test passes.' -ForegroundColor Yellow
  Write-Host ''

  $secureKey = Read-Host 'Enter the new API key' -AsSecureString
  $apiKey = (ConvertFrom-HiddenInput $secureKey).Trim()
  $secureKey.Dispose()
  if (!$apiKey) { throw 'The API key cannot be empty' }

  $knownKeys = @($localValues.VIDEO_API_KEY, $productionValues.VIDEO_API_KEY)
  foreach ($index in 2..10) {
    $knownKeys += $localValues["VIDEO_API_KEY_$index"]
    $knownKeys += $productionValues["VIDEO_API_KEY_$index"]
  }
  if ($knownKeys -contains $apiKey) { throw 'This API key is already configured' }

  Write-Host 'Testing the key and reading available models...' -ForegroundColor Cyan
  try {
    $response = Invoke-RestMethod -Method Get -Uri (Get-ModelsUrl $configuredBaseUrl) -Headers @{
      Authorization = "Bearer $apiKey"
      Accept = 'application/json'
    } -TimeoutSec 30
  } catch {
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    $statusSuffix = ''
    if ($statusCode) { $statusSuffix = ": HTTP $statusCode" }
    throw "API test failed$statusSuffix"
  }

  $modelIds = @($response.data | ForEach-Object { [string]$_.id } | Where-Object { $_ })
  $videoModels = @($modelIds | Where-Object {
    $_ -match '^(?:sd5-)?seedance-2\.0(?:-|$)|^grok-video(?:-|$)|^grok-imagine-video(?:-|$)|^sora-2(?:-|$)'
  } | Sort-Object -Unique)
  if ($videoModels.Count -eq 0) { throw 'The key exposes no supported video model' }

  Update-EnvFile $envPath "VIDEO_API_KEY_$slot" $apiKey
  if (Test-Path -LiteralPath $productionEnvPath) {
    Update-EnvFile $productionEnvPath "VIDEO_API_KEY_$slot" $apiKey
  }
  $modelSummary = $videoModels -join ','
  [IO.File]::WriteAllText(
    $statusPath,
    "OK slot=$slot models=$modelSummary",
    [Text.UTF8Encoding]::new($false)
  )

  $apiKey = $null
  Write-Host ''
  Write-Host "Saved as VIDEO_API_KEY_$slot" -ForegroundColor Green
  Write-Host 'Available video models:' -ForegroundColor Green
  $videoModels | ForEach-Object { Write-Host "  - $_" }
  Write-Host ''
  Write-Host 'Keep this window open while Codex updates and deploys the application.' -ForegroundColor Cyan
} catch {
  $apiKey = $null
  $message = $_.Exception.Message
  [IO.File]::WriteAllText($statusPath, "ERROR $message", [Text.UTF8Encoding]::new($false))
  Write-Host ''
  Write-Host "Configuration failed: $message" -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close this window'

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
$statusPath = Join-Path $projectRoot '.image-api-config-status.txt'
$apiKey = $null

try {
  [IO.File]::WriteAllText($statusPath, 'WAITING', [Text.UTF8Encoding]::new($false))
  if (!(Test-Path -LiteralPath $envPath)) { throw '.env was not found' }
  $localValues = Read-EnvValues $envPath
  $productionValues = Read-EnvValues $productionEnvPath

  if ($BaseUrl.Trim()) {
    $configuredBaseUrl = $BaseUrl.Trim().TrimEnd('/')
  } elseif ($productionValues.OPENAI_COMPAT_BASE_URL) {
    $configuredBaseUrl = $productionValues.OPENAI_COMPAT_BASE_URL.TrimEnd('/')
  } elseif ($localValues.OPENAI_COMPAT_BASE_URL) {
    $configuredBaseUrl = $localValues.OPENAI_COMPAT_BASE_URL.TrimEnd('/')
  } else {
    $configuredBaseUrl = 'http://direct-api.cangyuansuanli.cn'
  }

  if ($productionValues.IMAGE_MODEL) {
    $configuredModel = $productionValues.IMAGE_MODEL
  } elseif ($localValues.IMAGE_MODEL) {
    $configuredModel = $localValues.IMAGE_MODEL
  } else {
    $configuredModel = 'gpt-image-2-1k'
  }

  $slot = 2..10 | Where-Object {
    !$localValues["OPENAI_COMPAT_API_KEY_$_"] -and !$productionValues["OPENAI_COMPAT_API_KEY_$_"]
  } | Select-Object -First 1
  if (!$slot) { throw 'OPENAI_COMPAT_API_KEY_2 through OPENAI_COMPAT_API_KEY_10 are all occupied' }

  Write-Host ''
  Write-Host 'Add a backup image API key' -ForegroundColor Cyan
  Write-Host "Endpoint: $configuredBaseUrl"
  Write-Host "Required image model: $configuredModel"
  Write-Host "Target slot: OPENAI_COMPAT_API_KEY_$slot"
  Write-Host 'Input is hidden. Configuration changes only after the API test passes.' -ForegroundColor Yellow
  Write-Host ''

  $secureKey = Read-Host 'Enter the new API key' -AsSecureString
  $apiKey = (ConvertFrom-HiddenInput $secureKey).Trim()
  $secureKey.Dispose()
  if (!$apiKey) { throw 'The API key cannot be empty' }

  $knownKeys = @($localValues.OPENAI_COMPAT_API_KEY, $productionValues.OPENAI_COMPAT_API_KEY)
  foreach ($index in 2..10) {
    $knownKeys += $localValues["OPENAI_COMPAT_API_KEY_$index"]
    $knownKeys += $productionValues["OPENAI_COMPAT_API_KEY_$index"]
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
  $imageModels = @($modelIds | Where-Object {
    $_ -eq $configuredModel -or $_ -match 'image|banana|flux|recraft|ideogram'
  } | Sort-Object -Unique)
  $providerModel = $configuredModel
  if ($modelIds -notcontains $providerModel -and $configuredModel -eq 'gpt-image-2') {
    $providerModel = $imageModels | Where-Object {
      $_ -match '(?:^|-)gpt-image-2(?:-1k)?$'
    } | Select-Object -First 1
  }
  if (!$providerModel -or $modelIds -notcontains $providerModel) {
    $availableSummary = if ($imageModels.Count) { $imageModels -join ',' } else { 'none' }
    throw "The key does not expose $configuredModel. Available image models: $availableSummary"
  }

  Update-EnvFile $envPath "OPENAI_COMPAT_IMAGE_MODEL_$slot" $providerModel
  Update-EnvFile $envPath "OPENAI_COMPAT_API_KEY_$slot" $apiKey
  if (Test-Path -LiteralPath $productionEnvPath) {
    Update-EnvFile $productionEnvPath "OPENAI_COMPAT_IMAGE_MODEL_$slot" $providerModel
    Update-EnvFile $productionEnvPath "OPENAI_COMPAT_API_KEY_$slot" $apiKey
  }
  $modelSummary = $imageModels -join ','
  [IO.File]::WriteAllText(
    $statusPath,
    "OK slot=$slot active_model=$configuredModel provider_model=$providerModel models=$modelSummary",
    [Text.UTF8Encoding]::new($false)
  )

  $apiKey = $null
  Write-Host ''
  Write-Host "Saved as OPENAI_COMPAT_API_KEY_$slot" -ForegroundColor Green
  Write-Host "Application model: $configuredModel" -ForegroundColor Green
  Write-Host "Provider model for this slot: $providerModel" -ForegroundColor Green
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

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"

if (!(Test-Path -LiteralPath $envPath)) {
  throw ".env not found at $envPath"
}

Write-Host ""
Write-Host "Configure the text model for stages 1-3" -ForegroundColor Cyan
Write-Host "Endpoint: https://sub.kedaya.xyz"
Write-Host "Model:    gpt-5.6-sol"
Write-Host "The key will stay hidden while you type or paste it."
Write-Host ""

$secureKey = Read-Host "Enter the gpt-5.6-sol API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "API key cannot be empty"
}

$settings = [ordered]@{
  TEXT_API_BASE_URL = "https://sub.kedaya.xyz"
  TEXT_API_KEY = $apiKey.Trim()
  TEXT_API_MODE = "responses"
  TEXT_MODEL = "gpt-5.6-sol"
  TEXT_REASONING_EFFORT = "xhigh"
}

$remaining = [ordered]@{}
foreach ($entry in $settings.GetEnumerator()) {
  $remaining[$entry.Key] = $entry.Value
}

$output = [System.Collections.Generic.List[string]]::new()
foreach ($line in (Get-Content -LiteralPath $envPath -Encoding UTF8)) {
  $matchedName = $null
  foreach ($name in @($remaining.Keys)) {
    if ($line -match "^$([Regex]::Escape($name))=") {
      $matchedName = $name
      break
    }
  }

  if ($null -ne $matchedName) {
    $escaped = $remaining[$matchedName].Replace('"', '\"')
    $output.Add("$matchedName=`"$escaped`"")
    $remaining.Remove($matchedName)
  } else {
    $output.Add($line)
  }
}

if ($remaining.Count -gt 0) {
  if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") {
    $output.Add("")
  }

  foreach ($entry in $remaining.GetEnumerator()) {
    $escaped = $entry.Value.Replace('"', '\"')
    $output.Add("$($entry.Key)=`"$escaped`"")
  }
}

$tempPath = "$envPath.tmp"
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllLines($tempPath, $output, $utf8WithoutBom)
Move-Item -LiteralPath $tempPath -Destination $envPath -Force

$apiKey = $null
Write-Host ""
Write-Host "Saved. The image and video API settings were not changed." -ForegroundColor Green
Write-Host "You may close this terminal after Codex finishes the connection test."

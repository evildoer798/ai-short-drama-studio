$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot "..\.env"
if (!(Test-Path -LiteralPath $envPath)) {
  throw ".env not found at $envPath"
}

$secureKey = Read-Host "Enter Cangyuan video API key" -AsSecureString
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
  VIDEO_API_BASE_URL = "https://ai.cangyuansuanli.cn"
  VIDEO_API_KEY = $apiKey
  VIDEO_API_MODE = "auto"
  VIDEO_MODEL = "seedance-2.0-mini-8s"
  VIDEO_SECONDS = "8"
  VIDEO_SIZE = "1280x720"
}

$content = [System.Collections.Generic.List[string]]::new()
foreach ($line in (Get-Content -LiteralPath $envPath)) {
  $matched = $false
  foreach ($name in $settings.Keys) {
    if ($line -match "^$name=") {
      $value = $settings[$name].Replace('"', '\"')
      $content.Add("$name=`"$value`"")
      $settings.Remove($name)
      $matched = $true
      break
    }
  }
  if (!$matched) {
    $content.Add($line)
  }
}

if ($settings.Count -gt 0) {
  $content.Add("")
  foreach ($entry in $settings.GetEnumerator()) {
    $value = $entry.Value.Replace('"', '\"')
    $content.Add("$($entry.Key)=`"$value`"")
  }
}

Set-Content -LiteralPath $envPath -Value $content -Encoding UTF8
Write-Output "Cangyuan video API key saved to .env"
Write-Output "You can close this window."
Read-Host "Press Enter to finish"

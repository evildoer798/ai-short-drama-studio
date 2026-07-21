$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$paths = @(
  (Join-Path $projectRoot ".env"),
  (Join-Path $projectRoot ".env.production")
)
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

Write-Host ""
Write-Host "Configure the Kedaya fallback text model" -ForegroundColor Cyan
Write-Host "Endpoint: https://sub.kedaya.xyz"
Write-Host "Model:    gpt-5.6-sol"
Write-Host "The key will stay hidden while you type or paste it."
Write-Host ""

$secureKey = Read-Host "Enter the Kedaya gpt-5.6-sol API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $fallbackKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($fallbackKey)) {
  throw "API key cannot be empty"
}
$fallbackKey = $fallbackKey.Trim()

foreach ($path in $paths) {
  if (!(Test-Path -LiteralPath $path)) { continue }
  $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)

  $settings = [ordered]@{
    TEXT_FALLBACK_API_BASE_URL = "https://sub.kedaya.xyz"
    TEXT_FALLBACK_API_KEY = $fallbackKey
    TEXT_FALLBACK_API_MODE = "responses"
    TEXT_FALLBACK_MODEL = "gpt-5.6-sol"
    TEXT_FALLBACK_REASONING_EFFORT = "xhigh"
  }
  $remaining = [ordered]@{}
  foreach ($entry in $settings.GetEnumerator()) { $remaining[$entry.Key] = $entry.Value }
  $output = [System.Collections.Generic.List[string]]::new()

  foreach ($line in $lines) {
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
    $output.Add("$matchedName=`"$escaped`"")
    $remaining.Remove($matchedName)
  }

  if ($remaining.Count -gt 0) {
    if ($output.Count -gt 0 -and $output[$output.Count - 1] -ne "") { $output.Add("") }
    foreach ($entry in $remaining.GetEnumerator()) {
      $escaped = $entry.Value.Replace('"', '\"')
      $output.Add("$($entry.Key)=`"$escaped`"")
    }
  }

  $tempPath = "$path.tmp"
  [System.IO.File]::WriteAllLines($tempPath, $output, $utf8WithoutBom)
  Move-Item -LiteralPath $tempPath -Destination $path -Force
  Write-Host "Configured Kedaya gpt-5.6-sol fallback in $([IO.Path]::GetFileName($path))"
}

$fallbackKey = $null
Write-Host ""
Write-Host "Saved. Grok video settings were not changed." -ForegroundColor Green

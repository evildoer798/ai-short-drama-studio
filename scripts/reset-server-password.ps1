param(
  [string]$Server = "47.110.180.137",
  [string]$User = "root",
  [string]$Email = "2992656728@qq.com"
)

$ErrorActionPreference = "Stop"
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
$helper = Join-Path $PSScriptRoot "reset-server-password.mjs"
$remoteHelper = "/tmp/imaideo-reset-password.mjs"
$containerHelper = "/app/.imaideo-reset-password.mjs"

function ConvertTo-PlainText([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

Write-Host ""
Write-Host "Reset password for $Email" -ForegroundColor Cyan
Write-Host "Use 10-128 characters. Input is hidden." -ForegroundColor DarkGray

$firstSecure = Read-Host "New password" -AsSecureString
$secondSecure = Read-Host "Confirm password" -AsSecureString
$first = ConvertTo-PlainText $firstSecure
$second = ConvertTo-PlainText $secondSecure

try {
  if ($first -cne $second) {
    throw "Passwords do not match. Nothing was changed."
  }
  if ($first.Length -lt 10 -or $first.Length -gt 128) {
    throw "Password must contain 10-128 characters. Nothing was changed."
  }
  if (!(Test-Path -LiteralPath $helper)) {
    throw "Reset helper is missing: $helper"
  }

  $payload = @{ email = $Email; password = $first } | ConvertTo-Json -Compress

  & $scp -q -o BatchMode=yes $helper "${User}@${Server}:$remoteHelper"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload the reset helper." }

  & $ssh -o BatchMode=yes "$User@$Server" "docker cp '$remoteHelper' imaideo-web-1:'$containerHelper'"
  if ($LASTEXITCODE -ne 0) { throw "Failed to prepare the reset helper." }

  $result = $payload | & $ssh -o BatchMode=yes "$User@$Server" "docker exec -i imaideo-web-1 node '$containerHelper'"
  if ($LASTEXITCODE -ne 0) { throw "Password reset failed." }

  Write-Host ""
  Write-Host "Password updated successfully." -ForegroundColor Green
  Write-Host "Login: https://imaideo.xyz" -ForegroundColor Green
  Write-Host "Account: $Email" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  $first = $null
  $second = $null
  $payload = $null
  & $ssh -o BatchMode=yes "$User@$Server" "rm -f '$remoteHelper'; docker exec imaideo-web-1 rm -f '$containerHelper' 2>/dev/null || true" 2>$null | Out-Null
}

Write-Host ""
Read-Host "Press Enter to close"

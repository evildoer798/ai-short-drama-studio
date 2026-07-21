param(
  [string]$EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path ".env.production")
)

$ErrorActionPreference = "Stop"
if (!(Test-Path -LiteralPath $EnvFile)) { throw ".env.production not found" }

$email = Read-Host "Administrator email"
if ([string]::IsNullOrWhiteSpace($email)) { throw "Administrator email is required" }
$securePassword = Read-Host "New password (input is hidden)" -AsSecureString
$confirmPassword = Read-Host "Enter the new password again" -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
$confirmation = [System.Net.NetworkCredential]::new('', $confirmPassword).Password
if ($password -ne $confirmation) { throw "Passwords do not match" }
if ($password.Length -lt 12) { throw "Password must contain at least 12 characters" }

$lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $EnvFile -Encoding UTF8)
function Set-EnvValue([string]$name, [string]$value) {
  $escaped = $value.Replace('"', '\"')
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$([regex]::Escape($name))=") {
      $lines[$i] = "$name=`"$escaped`""
      return
    }
  }
  $lines.Add("$name=`"$escaped`"")
}

Set-EnvValue 'SEED_ADMIN_EMAIL' $email.Trim().ToLowerInvariant()
Set-EnvValue 'SEED_ADMIN_PASSWORD' $password
[System.IO.File]::WriteAllLines($EnvFile, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Production administrator credentials updated. You can close this window." -ForegroundColor Green
Read-Host "Press Enter to finish"

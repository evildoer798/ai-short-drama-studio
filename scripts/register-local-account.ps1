param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
  [string]$Email
)

$ErrorActionPreference = 'Stop'
$normalizedEmail = $Email.Trim().ToLowerInvariant()
$securePassword = Read-Host -Prompt "Enter a local password for $normalizedEmail (minimum 8 characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  if ($plainPassword.Length -lt 8) {
    throw 'Password must contain at least 8 characters.'
  }

  $env:LOCAL_ACCOUNT_EMAIL = $normalizedEmail
  $env:LOCAL_ACCOUNT_PASSWORD = $plainPassword
  docker exec `
    -e LOCAL_ACCOUNT_EMAIL `
    -e LOCAL_ACCOUNT_PASSWORD `
    shortdrama-web `
    node /app/scripts/register-local-account.mjs

  if ($LASTEXITCODE -ne 0) {
    throw "Local account creation failed. docker exec exit code: $LASTEXITCODE"
  }
} finally {
  Remove-Item Env:LOCAL_ACCOUNT_EMAIL -ErrorAction SilentlyContinue
  Remove-Item Env:LOCAL_ACCOUNT_PASSWORD -ErrorAction SilentlyContinue
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $plainPassword = $null
}

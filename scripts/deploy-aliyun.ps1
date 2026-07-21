param(
  [string]$Server = "47.110.180.137",
  [string]$User = "root",
  [string]$Domain = "imaideo.xyz"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$productionEnv = Join-Path $projectRoot ".env.production"
$release = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = ".deploy-$release.tar.gz"
$archivePath = Join-Path $projectRoot $archiveName
$remoteRoot = "/opt/imaideo"
$remoteRelease = "$remoteRoot/releases/$release"
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"

if (!(Test-Path -LiteralPath $productionEnv)) {
  throw ".env.production is missing. Run scripts/create-production-env.ps1 first."
}

Push-Location $projectRoot
try {
  & tar.exe -czf $archivePath `
    --exclude=.git `
    --exclude=.next `
    --exclude=node_modules `
    --exclude=artifacts `
    --exclude=coverage `
    --exclude=uploads `
    --exclude=.env `
    --exclude=.env.production `
    --exclude=.env.cloudflare `
    --exclude=.deploy-*.tar.gz `
    --exclude=*.log `
    .
  if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive." }

  & $ssh -o BatchMode=yes "$User@$Server" "mkdir -p '$remoteRelease'"
  if ($LASTEXITCODE -ne 0) { throw "SSH connection failed." }

  & $scp $archivePath "${User}@${Server}:/tmp/$archiveName"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload application archive." }
  & $scp $productionEnv "${User}@${Server}:/tmp/imaideo.env.production"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload production environment." }

  $remoteCommand = @(
    'set -e',
    "tar -xzf '/tmp/$archiveName' -C '$remoteRelease'",
    "if [ -f '$remoteRoot/current/.env.production' ]; then install -m 600 '$remoteRoot/current/.env.production' '$remoteRelease/.env.production'; else install -m 600 /tmp/imaideo.env.production '$remoteRelease/.env.production'; fi",
    "python3 '$remoteRelease/scripts/merge-production-text-env.py' /tmp/imaideo.env.production '$remoteRelease/.env.production'",
    "cd '$remoteRelease'",
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --build',
    "if docker ps --format '{{.Names}}' | grep -qx nginx-app; then docker network connect imaideo_default nginx-app 2>/dev/null || true; docker cp scripts/configure-nginx-proxy-manager.cjs nginx-app:/tmp/configure-imaideo-proxy.cjs; docker exec -e NPM_DOMAIN='$Domain' nginx-app node /tmp/configure-imaideo-proxy.cjs; fi",
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo ps',
    'curl -fsS --retry 20 --retry-delay 3 http://127.0.0.1:14000/login >/dev/null',
    "ln -sfn '$remoteRelease' '$remoteRoot/current'",
    "rm -f '/tmp/$archiveName' /tmp/imaideo.env.production",
    "echo DEPLOYMENT_OK release=$release"
  ) -join '; '
  & $ssh -o BatchMode=yes "$User@$Server" $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed." }
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}

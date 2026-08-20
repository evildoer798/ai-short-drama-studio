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
$imageName = "imaideo-app:$release"
$imageTarName = ".deploy-image-$release.tar"
$imageTarPath = Join-Path $projectRoot $imageTarName
$imageArchiveName = "$imageTarName.gz"
$imageArchivePath = Join-Path $projectRoot $imageArchiveName
$remoteRoot = "/opt/imaideo"
$remoteRelease = "$remoteRoot/releases/$release"
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"

if (!(Test-Path -LiteralPath $productionEnv)) {
  throw ".env.production is missing. Run scripts/create-production-env.ps1 first."
}

if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker is not installed locally. Production builds are forbidden; install or start Docker Desktop and retry."
}

$deployMutex = [System.Threading.Mutex]::new($false, "Local\ImaideoDeploy")
if (!$deployMutex.WaitOne(0)) {
  $deployMutex.Dispose()
  throw "Another deployment is already running. Wait for it to finish before retrying."
}

Push-Location $projectRoot
try {
  & docker version --format '{{.Server.Version}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "The local Docker daemon is unavailable. Production builds are forbidden; start Docker Desktop and retry."
  }

  Write-Host "Building production image locally: $imageName"
  & docker build --target runtime --tag $imageName .
  if ($LASTEXITCODE -ne 0) { throw "Local Docker image build failed." }

  & docker save --output $imageTarPath $imageName
  if ($LASTEXITCODE -ne 0) { throw "Failed to export the locally built Docker image." }
  $imageInput = [System.IO.File]::OpenRead($imageTarPath)
  $imageOutput = [System.IO.File]::Create($imageArchivePath)
  try {
    $gzip = [System.IO.Compression.GZipStream]::new(
      $imageOutput,
      [System.IO.Compression.CompressionLevel]::Optimal,
      $true
    )
    try {
      $imageInput.CopyTo($gzip)
    } finally {
      $gzip.Dispose()
    }
  } finally {
    $imageInput.Dispose()
    $imageOutput.Dispose()
  }
  Remove-Item -LiteralPath $imageTarPath -Force

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
    --exclude=.deploy-* `
    --exclude=*.log `
    .
  if ($LASTEXITCODE -ne 0) { throw "Failed to create deployment archive." }

  & $ssh -o BatchMode=yes "$User@$Server" "mkdir -p '$remoteRelease'"
  if ($LASTEXITCODE -ne 0) { throw "SSH connection failed." }

  & $scp $archivePath "${User}@${Server}:/tmp/$archiveName"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload application archive." }
  & $scp $imageArchivePath "${User}@${Server}:/tmp/$imageArchiveName"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload prebuilt Docker image." }
  & $scp $productionEnv "${User}@${Server}:/tmp/imaideo.env.production"
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload production environment." }

  $remoteCommand = @(
    'set -e',
    "tar -xzf '/tmp/$archiveName' -C '$remoteRelease'",
    "if [ -f '$remoteRoot/current/.env.production' ]; then install -m 600 '$remoteRoot/current/.env.production' '$remoteRelease/.env.production'; else install -m 600 /tmp/imaideo.env.production '$remoteRelease/.env.production'; fi",
    "python3 '$remoteRelease/scripts/merge-production-text-env.py' /tmp/imaideo.env.production '$remoteRelease/.env.production'",
    "cd '$remoteRelease'",
    "docker load -i '/tmp/$imageArchiveName'",
    "docker tag '$imageName' imaideo-app:latest",
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build postgres redis',
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps web',
    'health_attempt=0; until health_status=$(docker inspect --format={{.State.Health.Status}} imaideo-web-1 2>/dev/null || true); [ "$health_status" = "healthy" ]; do health_attempt=$((health_attempt + 1)); if [ "$health_attempt" -ge 120 ]; then docker inspect --format="web status={{.State.Status}} health={{.State.Health.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}" imaideo-web-1 || true; docker logs --tail 80 imaideo-web-1 2>&1 || true; free -m || true; exit 1; fi; sleep 3; done',
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo up -d --no-build --force-recreate --no-deps worker',
    "if docker ps --format '{{.Names}}' | grep -qx nginx-app; then docker network connect imaideo_default nginx-app 2>/dev/null || true; docker cp scripts/configure-nginx-proxy-manager.cjs nginx-app:/tmp/configure-imaideo-proxy.cjs; docker exec -e NPM_DOMAIN='$Domain' nginx-app node /tmp/configure-imaideo-proxy.cjs; fi",
    'docker compose --env-file .env.production -f docker-compose.production.yml -p imaideo ps',
    "ln -sfn '$remoteRelease' '$remoteRoot/current'",
    "rm -f '/tmp/$archiveName' '/tmp/$imageArchiveName' /tmp/imaideo.env.production",
    "echo DEPLOYMENT_OK release=$release"
  ) -join '; '
  & $ssh -o BatchMode=yes "$User@$Server" $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed." }
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  if (Test-Path -LiteralPath $imageTarPath) {
    Remove-Item -LiteralPath $imageTarPath -Force
  }
  if (Test-Path -LiteralPath $imageArchivePath) {
    Remove-Item -LiteralPath $imageArchivePath -Force
  }
  $deployMutex.ReleaseMutex()
  $deployMutex.Dispose()
}

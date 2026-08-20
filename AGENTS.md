# Repository Operating Rules

## Production deployment hard rule

- Never build Docker images on the production server (`47.110.180.137`).
- Never run `docker build`, `docker compose build`, or `docker compose up --build` on production.
- Build the Linux `runtime` image on the local workstation or in CI, then transfer or pull the completed image.
- Production may only load/pull a prebuilt image and start it with `docker compose up --no-build`.
- If the local Docker daemon or CI builder is unavailable, stop before contacting production. Do not fall back to a server-side build.
- Never run `docker builder prune`, `docker system prune`, or `docker system df` on the live production host. BuildKit cache scans can exhaust memory and swap even when no image is being built.
- Any Docker cache maintenance requires a planned offline maintenance window and explicit user approval. Routine deployments must not perform cache inspection or cleanup.
- Run tests, type checking, and the production application build before deployment.
- Keep the previous production image available until the new web container passes its health check.
- Treat `docker load` as a high-impact production operation on this host. Loading a large image can saturate disk I/O and make Docker, HTTPS, and SSH unresponsive even though no image is being built.
- For source-only changes with an unchanged production `package.json` hash, deploy the locally built `.next` and `src` artifacts as a small code-delta layer based on the current production image. Verify local/remote file hashes before recreating Web and Worker.
- Do not load a full application image while production traffic is live when its uncompressed size approaches 1 GB. Dependency or base-image changes require a planned maintenance window, explicit user approval, and a rollback-ready health check.

## Production capacity

- The production ECS instance has 2 CPU cores and 2 GB RAM. Treat it as a runtime host, not a build host.
- Keep Docker image build caches and development dependencies off production.
- Before deployment, verify free disk, available memory, swap usage, container health, and SSH responsiveness.
- Do not use extra swap as a substitute for physical memory. Sustained swap use can make HTTPS, SSH, and Docker unresponsive.

## Incident record: 2026-07-26

- A server-side `docker compose up -d --build` ran while the existing web, worker, PostgreSQL, Redis, proxy, and monitoring services were active.
- Docker grew to roughly 700 MB RSS and the Next.js build used roughly 400 MB.
- Swap reached about 1.96 GB of 2 GB, disk usage was 88%, and the host entered severe memory and I/O thrashing.
- The old containers initially stayed healthy, but Docker API, HTTPS, and SSH banner responses later timed out.
- No application defect caused the outage. The deployment architecture exceeded the host's safe capacity.
- Permanent lesson: build elsewhere, deploy immutable prebuilt images, and never silently fall back to a production build.
- Follow-up lesson: a live `docker builder prune -af` also caused Docker RPC disconnection, swap pressure, and HTTPS timeouts. Production verification must use lightweight health checks only.

## Incident record: 2026-07-30

- A locally built image was transferred correctly, but loading the 245 MB gzip archive expanded a roughly 1.19 GB runtime image on the 2 GB production host.
- The Docker daemon entered severe disk I/O contention; Docker RPC, HTTPS, and SSH timed out even though the server did not run a Docker build.
- Stopping the load client was insufficient because Docker remained stuck in `deactivating`; recovery required ending the stalled Docker daemon and starting it again. Existing database volumes and the previous release remained intact.
- The release was completed with a 31.6 MB locally built code artifact after verifying that local and production `package.json` hashes matched. The updated `.next` and `src` hashes were verified before Web and Worker were recreated.
- Permanent lesson: "no production build" is necessary but not sufficient. Large full-image loads are also unsafe on this host; prefer verified code-delta releases for dependency-identical changes.

## Incident record: 2026-08-03

- A code-delta container was initially started with `--entrypoint sh` before `docker commit`.
- Docker preserved that temporary entrypoint in the committed image, so the Compose command was invoked as `sh sh -c ...` and Web entered a restart loop before serving traffic.
- The rollback image and application data remained intact. The release was rebuilt as a small code layer from the rollback image without overriding its entrypoint, then Web passed health checks before Worker was recreated.
- Permanent lesson: never use `--entrypoint` on a temporary container that will be committed as a release image. Override only its command when a keep-alive process is needed.
- Before tagging any committed code-delta image as `latest`, inspect both `.Config.Entrypoint` and `.Config.Cmd`, verify hashes inside the temporary container, and keep the rollback tag until Web and Worker are healthy.

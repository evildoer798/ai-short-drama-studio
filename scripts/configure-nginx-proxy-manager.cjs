const http = require("http");

const apiHost = "127.0.0.1";
const apiPort = 81;
const domain = process.env.NPM_DOMAIN || "imaideo.xyz";

function request(path, { method = "GET", token, body, timeoutMs = 15_000 } = {}) {
  const encodedBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (encodedBody) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(encodedBody.length);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: apiHost, port: apiPort, path: `/api${path}`, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = raw;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`NPM API ${method} ${path} failed (${res.statusCode}): ${raw.slice(0, 300)}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("NPM API request timed out")));
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}

async function main() {
  const credentials = {
    identity: process.env.NPM_IDENTITY || "admin@example.com",
    secret: process.env.NPM_SECRET || "changeme",
  };
  const login = await request("/tokens", { method: "POST", body: credentials });
  if (!login || !login.token) throw new Error("NPM login did not return a token");

  const hosts = await request("/nginx/proxy-hosts", { token: login.token });
  const existing = Array.isArray(hosts)
    ? hosts.find((host) => Array.isArray(host.domain_names) && host.domain_names.includes(domain))
    : null;
  let certificateId = Number(existing?.certificate_id || 0);
  if (/^(1|true|yes)$/i.test(process.env.NPM_ENABLE_SSL || "")) {
    const letsencryptEmail = process.env.NPM_LETSENCRYPT_EMAIL;
    if (!letsencryptEmail) throw new Error("NPM_LETSENCRYPT_EMAIL is required when enabling SSL");
    const certificates = await request("/nginx/certificates", { token: login.token });
    const existingCertificate = Array.isArray(certificates)
      ? certificates.find(
          (certificate) =>
            certificate.provider === "letsencrypt" &&
            Array.isArray(certificate.domain_names) &&
            certificate.domain_names.includes(domain),
        )
      : null;
    if (existingCertificate) {
      certificateId = Number(existingCertificate.id);
    } else {
      const certificate = await request("/nginx/certificates", {
        method: "POST",
        token: login.token,
        timeoutMs: 15 * 60_000,
        body: {
          provider: "letsencrypt",
          domain_names: [domain],
          meta: {
            letsencrypt_email: letsencryptEmail,
            letsencrypt_agree: true,
            dns_challenge: false,
          },
        },
      });
      certificateId = Number(certificate.id);
    }
  }
  const sslEnabled = certificateId > 0;
  const payload = {
    domain_names: [domain],
    forward_scheme: "http",
    forward_host: "imaideo-web-1",
    forward_port: 14000,
    access_list_id: 0,
    certificate_id: certificateId,
    ssl_forced: sslEnabled,
    caching_enabled: false,
    block_exploits: true,
    advanced_config: [
      "client_max_body_size 512m;",
      "proxy_connect_timeout 60s;",
      "proxy_read_timeout 3600s;",
      "proxy_send_timeout 3600s;",
    ].join("\n"),
    meta: { letsencrypt_agree: sslEnabled, dns_challenge: false },
    allow_websocket_upgrade: true,
    http2_support: true,
    hsts_enabled: sslEnabled,
    hsts_subdomains: false,
    locations: [],
    enabled: true,
  };

  if (existing) {
    await request(`/nginx/proxy-hosts/${existing.id}`, {
      method: "PUT",
      token: login.token,
      body: payload,
    });
    process.stdout.write(`NPM_PROXY_UPDATED domain=${domain}\n`);
  } else {
    await request("/nginx/proxy-hosts", { method: "POST", token: login.token, body: payload });
    process.stdout.write(`NPM_PROXY_CREATED domain=${domain}\n`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

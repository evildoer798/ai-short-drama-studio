import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const previewOrigin = 'http://127.0.0.1:14003'
const canvasPath = '/canvas?id=cmsklbnnm0001nb8s3bybxku8'
const screenshotPath = resolve('.diagnostics/canvas-shotlab-local.png')
const addMenuScreenshotPath = resolve('.diagnostics/canvas-shotlab-add-menu.png')

function envValue(name) {
  const line = readFileSync('.env', 'utf8')
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith(`${name}=`))
  if (!line) throw new Error(`Missing ${name} in .env`)
  const value = line.slice(name.length + 1).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

async function waitForJson(url, options, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, options)
      if (response.ok) return response.json()
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

if (!existsSync(edgePath)) throw new Error('Microsoft Edge was not found')

const profileDir = mkdtempSync(join(tmpdir(), 'imaideo-canvas-edge-'))
const port = 9331
const edge = spawn(edgePath, [
  '--headless=new',
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--window-size=1440,900',
  `${previewOrigin}/login`,
], { stdio: 'ignore', windowsHide: true })

let socket
try {
  await waitForJson(`http://127.0.0.1:${port}/json/version`)
  const target = await waitForJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${previewOrigin}/login`)}`,
    { method: 'PUT' },
  )
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', rejectOpen, { once: true })
  })

  let requestId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const callbacks = pending.get(message.id)
    if (!callbacks) return
    pending.delete(message.id)
    if (message.error) callbacks.reject(new Error(message.error.message))
    else callbacks.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const id = ++requestId
    pending.set(id, { resolve: resolveSend, reject: rejectSend })
    socket.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: `${previewOrigin}/login` })
  await send('Runtime.evaluate', {
    expression: `new Promise((resolveReady, rejectReady) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (location.origin === ${JSON.stringify(previewOrigin)} && document.readyState === 'complete') {
          clearInterval(timer);
          resolveReady(true);
        } else if (Date.now() - started > 10000) {
          clearInterval(timer);
          rejectReady(new Error('Login page did not load'));
        }
      }, 100);
    })`,
    awaitPromise: true,
    returnByValue: true,
  })
  const identifier = envValue('SEED_ADMIN_EMAIL')
  const password = envValue('SEED_ADMIN_PASSWORD')
  const loginExpression = `fetch('/api/auth/login', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(${JSON.stringify({ identifier, password })})
  }).then(async response => ({ok: response.ok, body: await response.json()}))`
  const login = await send('Runtime.evaluate', {
    expression: loginExpression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (!login.result?.value?.ok) throw new Error('Local preview login failed')

  await send('Page.navigate', { url: `${previewOrigin}${canvasPath}` })
  const readyExpression = `new Promise((resolveReady, rejectReady) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (document.querySelector('.canvasAppShell .react-flow')) {
        clearInterval(timer);
        setTimeout(() => resolveReady(true), 900);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        rejectReady(new Error('Canvas did not render'));
      }
    }, 100);
  })`
  await send('Runtime.evaluate', {
    expression: readyExpression,
    awaitPromise: true,
    returnByValue: true,
  })
  const capture = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'))
  await send('Runtime.evaluate', {
    expression: `document.querySelector('.canvasToolRail button.primary')?.click()`,
    returnByValue: true,
  })
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  const menuVisible = await send('Runtime.evaluate', {
    expression: `Boolean(document.querySelector('.canvasAddMenu'))`,
    returnByValue: true,
  })
  if (!menuVisible.result?.value) throw new Error('Add-node menu did not open')
  const addMenuCapture = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  writeFileSync(addMenuScreenshotPath, Buffer.from(addMenuCapture.data, 'base64'))
  process.stdout.write(`${screenshotPath}\n${addMenuScreenshotPath}\n`)
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close()
  edge.kill()
  await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  rmSync(profileDir, { recursive: true, force: true })
}

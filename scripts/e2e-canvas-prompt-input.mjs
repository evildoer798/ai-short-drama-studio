import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const debuggingPort = 9333
const profilePath = join(tmpdir(), `imaideo-edge-${process.pid}`)
let testStage = 'startup'

function readEnv(path) {
  const values = {}
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [name, ...parts] = line.split('=')
    let value = parts.join('=').trim()
    if (value.length >= 2 && value[0] === value.at(-1) && /["']/u.test(value[0])) {
      value = value.slice(1, -1)
    }
    values[name.trim()] = value
  }
  return values
}

async function waitForJson(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function main() {
  const env = readEnv('.env.production')
  const identifier = env.SEED_ADMIN_EMAIL
  const password = env.SEED_ADMIN_PASSWORD
  if (!identifier || !password) throw new Error('Production test credentials are not configured')

  const edge = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    await waitForJson(`http://127.0.0.1:${debuggingPort}/json/version`)
    const target = await fetch(
      `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent('https://imaideo.xyz/login')}`,
      { method: 'PUT' },
    ).then((response) => response.json())
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })

    let messageId = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const promise = pending.get(message.id)
      if (!promise) return
      pending.delete(message.id)
      if (message.error) promise.reject(new Error(message.error.message))
      else promise.resolve(message.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++messageId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result?.value
    }
    const waitFor = async (expression, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`Timed out waiting for browser condition: ${expression}`)
    }

    await send('Page.enable')
    await send('Runtime.enable')
    testStage = 'login page'
    await waitFor(`location.hostname === 'imaideo.xyz'`)
    const login = await evaluate(`(async () => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify({ identifier, password }))},
      })
      return { status: response.status, body: await response.text() }
    })()`)
    if (login.status !== 200) throw new Error(`Login failed with HTTP ${login.status}`)

    testStage = 'canvas navigation'
    await send('Page.navigate', { url: 'https://imaideo.xyz/canvas' })
    await waitFor(`Boolean(document.querySelector('.canvasPromptInput') && document.querySelector('.canvasReferenceStrip button'))`, 30_000)

    testStage = 'read original prompt'
    const original = await evaluate(`String(document.querySelector('.canvasPromptInput').value)`)
    const setValue = (value, selection) => evaluate(`(() => {
      const input = document.querySelector('.canvasPromptInput')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
      input.focus()
      input.setSelectionRange(${selection}, ${selection})
      return true
    })()`)

    testStage = 'middle deletion'
    await setValue('0123456789', 5)
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const deletion = await evaluate(`(() => {
      const input = document.querySelector('.canvasPromptInput')
      return { value: input.value, selection: input.selectionStart }
    })()`)

    testStage = 'IME composition'
    await setValue('甲乙丙丁', 2)
    await send('Input.imeSetComposition', {
      text: 'lin', selectionStart: 3, selectionEnd: 3, replacementStart: 2, replacementEnd: 2,
    })
    await send('Input.insertText', { text: '林' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const composition = await evaluate(`(() => {
      const input = document.querySelector('.canvasPromptInput')
      return { value: input.value, selection: input.selectionStart }
    })()`)

    testStage = 'reference insertion'
    await setValue('前景 后景', 3)
    await evaluate(`(() => { document.querySelector('.canvasReferenceStrip button').click(); return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const reference = await evaluate(`(() => {
      const input = document.querySelector('.canvasPromptInput')
      return { value: input.value, selection: input.selectionStart, focused: document.activeElement === input }
    })()`)

    testStage = 'restore prompt'
    await setValue(original, original.length)
    await evaluate(`(() => { document.querySelector('.canvasPromptInput').blur(); return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 800))
    const restored = await evaluate(`document.querySelector('.canvasPromptInput').value === ${JSON.stringify(original)}`)
    await send('Page.reload', { ignoreCache: true })
    await waitFor(`Boolean(document.querySelector('.canvasPromptInput'))`, 30_000)
    const persisted = await evaluate(`document.querySelector('.canvasPromptInput').value === ${JSON.stringify(original)}`)

    const result = {
      deletion,
      composition,
      reference,
      restored,
      persisted,
    }
    if (deletion.value !== '012356789' || deletion.selection !== 4) {
      throw new Error(`Caret regression: ${JSON.stringify(deletion)}`)
    }
    if (composition.value !== '甲乙林丙丁' || /lin/iu.test(composition.value)) {
      throw new Error(`IME regression: ${JSON.stringify(composition)}`)
    }
    if (!/@图片1/u.test(reference.value) || !reference.focused) {
      throw new Error(`Reference insertion regression: ${JSON.stringify(reference)}`)
    }
    if (!result.restored) throw new Error('Original prompt was not restored')
    if (!result.persisted) throw new Error('Restored prompt was not persisted')
    console.log(JSON.stringify(result))
    socket.close()
  } finally {
    edge.kill()
    await new Promise((resolve) => setTimeout(resolve, 800))
    if (profilePath.startsWith(tmpdir())) {
      try {
        rmSync(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        // Windows may briefly retain Edge profile locks after a headless run.
      }
    }
  }
}

main().catch((error) => {
  console.error(`${testStage}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

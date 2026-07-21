const baseUrl = (process.env.DEEPSEEK_PROBE_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const apiKey = process.env.DEEPSEEK_PROBE_API_KEY || ''
const model = process.env.DEEPSEEK_PROBE_MODEL || 'deepseek-chat'

if (!apiKey) throw new Error('DeepSeek probe key is missing')

const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`
const response = await fetch(`${apiBase}/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'You are an API connectivity checker.' },
      { role: 'user', content: 'Reply with exactly READY.' },
    ],
    max_tokens: 16,
    temperature: 0,
    stream: false,
  }),
  signal: AbortSignal.timeout(90_000),
})

const raw = await response.text()
let payload = null
try {
  payload = JSON.parse(raw)
} catch {
  // The sanitized response excerpt below is enough for connection diagnostics.
}

if (!response.ok) {
  const message = payload?.error?.message || payload?.message || raw || response.statusText
  throw new Error(`DeepSeek probe failed (${response.status}): ${String(message).replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 800)}`)
}

const text = payload?.choices?.[0]?.message?.content
if (typeof text !== 'string' || !text.trim()) throw new Error('DeepSeek returned empty text')
process.stdout.write('DEEPSEEK_PROBE_OK')

import { env } from '../src/lib/env'
const startedAt = Date.now()
const keySource = process.argv[2] || 'image'
const apiKey = keySource === 'video'
  ? env.videoApiKey()
  : keySource === 'grok'
    ? env.grokVideoApiKey()
    : keySource === 'text'
      ? env.textApiKey()
      : env.openAICompatApiKey()
const response = await fetch('http://direct-api.cangyuansuanli.cn/v1/chat/completions', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'You are an API connectivity checker.' },
      { role: 'user', content: 'Reply with exactly READY.' },
    ],
    max_tokens: 32,
    temperature: 0,
  }),
  signal: AbortSignal.timeout(45_000),
})
const raw = await response.text()
let payload: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string; code?: string } } = {}
try { payload = JSON.parse(raw) } catch { /* Keep the sanitized raw response. */ }
const text = payload.choices?.[0]?.message?.content || ''

console.log(JSON.stringify({
  ok: response.ok && text.trim().toUpperCase().includes('READY'),
  status: response.status,
  keySource,
  model: 'gpt-5.5',
  mode: 'chat_completions',
  elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  response: text.trim().slice(0, 80) || payload.error?.message?.slice(0, 300) || raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
  errorCode: payload.error?.code || null,
}, null, 2))

if (!response.ok) process.exitCode = 1

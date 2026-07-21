import { env } from '@/lib/env'
import { extractJsonValue, generateTextViaOpenAICompat } from '@/lib/openai-text'

const startedAt = Date.now()
const text = await generateTextViaOpenAICompat({
  baseUrl: env.textApiBaseUrl(),
  apiKey: env.textApiKey(),
  model: env.textModel(),
  mode: 'chat_completions',
  system: 'Return one valid JSON object with a boolean field named ready.',
  prompt: 'Set ready to true.',
  maxOutputTokens: 128,
  temperature: 0,
  responseFormat: 'json_object',
  disableThinking: true,
  timeoutMs: 30_000,
  maxAttempts: 1,
})

const parsed = extractJsonValue(text) as { ready?: unknown }
if (parsed.ready !== true) throw new Error('DeepSeek structured probe returned an unexpected payload')

console.log(JSON.stringify({
  ok: true,
  model: env.textModel(),
  elapsedMs: Date.now() - startedAt,
}, null, 2))

import { env } from '../src/lib/env'
import { generateTextViaOpenAICompat } from '../src/lib/openai-text'

const text = await generateTextViaOpenAICompat({
  baseUrl: env.textApiBaseUrl(),
  apiKey: env.textApiKey(),
  model: env.textModel(),
  mode: env.textApiMode(),
  reasoningEffort: env.textReasoningEffort(),
  system: 'You are an API connectivity checker.',
  prompt: 'Reply with exactly READY and nothing else.',
  maxOutputTokens: 512,
})

console.log(JSON.stringify({
  ok: text.trim().toUpperCase().includes('READY'),
  baseUrl: env.textApiBaseUrl(),
  mode: env.textApiMode(),
  model: env.textModel(),
  reasoningEffort: env.textReasoningEffort() || null,
  response: text.trim().slice(0, 120),
}, null, 2))

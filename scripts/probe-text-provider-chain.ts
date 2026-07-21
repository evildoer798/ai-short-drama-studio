import { env } from '@/lib/env'
import { generateTextViaOpenAICompat } from '@/lib/openai-text'

const providers = [
  {
    name: 'primary',
    baseUrl: env.textApiBaseUrl(),
    model: env.textModel(),
    mode: env.textApiMode(),
    reasoningEffort: env.textReasoningEffort(),
    keys: env.textApiKeys(),
  },
  {
    name: 'fallback',
    baseUrl: env.textFallbackApiBaseUrl(),
    model: env.textFallbackModel(),
    mode: env.textFallbackApiMode(),
    reasoningEffort: env.textFallbackReasoningEffort(),
    keys: env.textFallbackApiKeys(),
  },
  {
    name: 'tertiary',
    baseUrl: env.textTertiaryApiBaseUrl(),
    model: env.textTertiaryModel(),
    mode: env.textTertiaryApiMode(),
    reasoningEffort: env.textTertiaryReasoningEffort(),
    keys: env.textTertiaryApiKeys(),
  },
]

function compactError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

const results = []
for (const provider of providers) {
  if (!provider.baseUrl || provider.keys.length === 0) {
    results.push({ name: provider.name, configured: false })
    continue
  }
  const startedAt = Date.now()
  try {
    const response = await generateTextViaOpenAICompat({
      baseUrl: provider.baseUrl,
      apiKey: provider.keys[0],
      model: provider.model,
      mode: provider.mode,
      reasoningEffort: provider.reasoningEffort || undefined,
      system: 'You are an API connectivity checker.',
      prompt: 'Reply with exactly READY and nothing else.',
      maxOutputTokens: 64,
      temperature: 0,
      timeoutMs: 30_000,
      maxAttempts: 1,
    })
    results.push({
      name: provider.name,
      configured: true,
      keyCount: provider.keys.length,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ok: response.trim().toUpperCase().includes('READY'),
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    results.push({
      name: provider.name,
      configured: true,
      keyCount: provider.keys.length,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: compactError(error),
    })
  }
}

console.log(JSON.stringify({ ok: results.some((result) => result.ok), results }, null, 2))
if (!results.some((result) => result.ok)) process.exitCode = 1

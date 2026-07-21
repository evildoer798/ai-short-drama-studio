export const MAX_TEXT_API_KEYS = 10

type EnvironmentSource = Record<string, string | undefined>

function uniqueValues(values: Array<string | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value?.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function numberedKeyPool(source: EnvironmentSource, prefix: string) {
  return uniqueValues(
    Array.from({ length: MAX_TEXT_API_KEYS }, (_, index) => source[`${prefix}_${index + 1}`]),
  )
}

export function resolveTextApiKeys(source: EnvironmentSource = process.env) {
  const pool = numberedKeyPool(source, 'TEXT_API_KEY')
  if (pool.length > 0) return pool

  return uniqueValues([
    source.TEXT_API_KEY,
    source.OPENAI_COMPAT_API_KEY,
    source.VIDEO_API_KEY,
  ]).slice(0, 1)
}

export function resolveTextFallbackApiKeys(source: EnvironmentSource = process.env) {
  const pool = numberedKeyPool(source, 'TEXT_FALLBACK_API_KEY')
  if (pool.length > 0) return pool
  return uniqueValues([source.TEXT_FALLBACK_API_KEY]).slice(0, 1)
}

export function resolveTextTertiaryApiKeys(source: EnvironmentSource = process.env) {
  const pool = numberedKeyPool(source, 'TEXT_TERTIARY_API_KEY')
  if (pool.length > 0) return pool
  return uniqueValues([source.TEXT_TERTIARY_API_KEY]).slice(0, 1)
}

export function orderedTextApiKeyIndexes(keyCount: number, preferredIndex = 0) {
  const count = Math.max(1, Math.min(MAX_TEXT_API_KEYS, Math.round(keyCount)))
  const start = ((Math.round(preferredIndex) % count) + count) % count
  return Array.from({ length: count }, (_, offset) => (start + offset) % count)
}

export function storyboardTextKeyPasses(keyCount: number, preferredIndex = 0, keysPerPass = 2) {
  const order = orderedTextApiKeyIndexes(keyCount, preferredIndex)
  const passSize = Math.max(1, Math.min(order.length, Math.round(keysPerPass)))
  const passes: number[] = []
  for (let index = 0; index < order.length; index += passSize) passes.push(order[index])
  return passes
}

export function textStoryboardParallelism(input: {
  requested: number
  keyCount: number
  pendingEpisodeCount: number
}) {
  return Math.max(1, Math.min(
    MAX_TEXT_API_KEYS,
    Math.max(1, Math.round(input.requested)),
    Math.max(1, Math.round(input.keyCount)),
    Math.max(1, Math.round(input.pendingEpisodeCount)),
  ))
}

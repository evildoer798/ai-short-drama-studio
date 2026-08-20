import {
  listVideoProviderModels,
  type VideoApiConfig,
  type VideoApiMode,
} from './openai-video'

export type VideoApiKeyEntry = {
  slot: number
  apiKey: string
}

export type VideoApiPoolSnapshot = {
  modelIds: string[]
  modelKeySlots: Map<string, number[]>
  successfulSlots: number[]
  failedSlots: number[]
}

type EnvSource = Record<string, string | undefined>

type DiscoverOptions = {
  baseUrl: string
  mode: 'auto' | VideoApiMode
  forceRefresh?: boolean
  source?: EnvSource
  listModels?: (config: VideoApiConfig) => Promise<string[]>
}

let discoveryCache: { key: string, expiresAt: number, value: VideoApiPoolSnapshot } | null = null
const providerCursor = new Map<string, number>()

export function resolveVideoApiKeyEntries(source: EnvSource = process.env) {
  const candidates = [
    { slot: 1, apiKey: source.VIDEO_API_KEY || source.VIDEO_API_KEY_1 || '' },
    ...Array.from({ length: 9 }, (_, index) => {
      const slot = index + 2
      return { slot, apiKey: source[`VIDEO_API_KEY_${slot}`] || '' }
    }),
  ]
  const seen = new Set<string>()
  return candidates.flatMap((candidate): VideoApiKeyEntry[] => {
    const apiKey = candidate.apiKey.trim()
    if (!apiKey || seen.has(apiKey)) return []
    seen.add(apiKey)
    return [{ slot: candidate.slot, apiKey }]
  })
}

export function resolveVideoApiKeys(source: EnvSource = process.env) {
  return resolveVideoApiKeyEntries(source).map((entry) => entry.apiKey)
}

function cacheKey(baseUrl: string, entries: VideoApiKeyEntry[]) {
  return `${baseUrl}|${entries.map((entry) => entry.slot).join(',')}`
}

export async function discoverVideoApiModels(options: DiscoverOptions): Promise<VideoApiPoolSnapshot> {
  const entries = resolveVideoApiKeyEntries(options.source)
  if (entries.length === 0) throw new Error('VIDEO_API_KEY is required')
  const key = cacheKey(options.baseUrl, entries)
  const now = Date.now()
  if (!options.forceRefresh && discoveryCache?.key === key && discoveryCache.expiresAt > now) {
    return discoveryCache.value
  }

  const listModels = options.listModels || listVideoProviderModels
  const results = await Promise.allSettled(entries.map((entry) => listModels({
    baseUrl: options.baseUrl,
    apiKey: entry.apiKey,
    mode: options.mode,
  })))
  const modelKeySlots = new Map<string, number[]>()
  const successfulSlots: number[] = []
  const failedSlots: number[] = []

  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    const entry = entries[index]
    if (result.status === 'rejected') {
      failedSlots.push(entry.slot)
      continue
    }
    successfulSlots.push(entry.slot)
    for (const modelId of result.value) {
      const slots = modelKeySlots.get(modelId) || []
      if (!slots.includes(entry.slot)) slots.push(entry.slot)
      modelKeySlots.set(modelId, slots)
    }
  }
  if (successfulSlots.length === 0) throw new Error('VIDEO_API_POOL_UNAVAILABLE')

  const value = {
    modelIds: [...modelKeySlots.keys()],
    modelKeySlots,
    successfulSlots,
    failedSlots,
  }
  discoveryCache = { key, expiresAt: now + 30_000, value }
  return value
}

export async function resolveVideoApiProvider(options: DiscoverOptions & {
  model: string
  preferredKeySlot?: number
}) {
  const entries = resolveVideoApiKeyEntries(options.source)
  const preferred = Number.isInteger(options.preferredKeySlot)
    ? entries.find((entry) => entry.slot === options.preferredKeySlot)
    : null
  if (preferred) {
    return {
      keySlot: preferred.slot,
      config: {
        baseUrl: options.baseUrl,
        apiKey: preferred.apiKey,
        mode: options.mode,
        model: options.model,
      } satisfies VideoApiConfig,
    }
  }

  const snapshot = await discoverVideoApiModels(options)
  const slots = snapshot.modelKeySlots.get(options.model) || []
  if (slots.length === 0) return null
  const cursor = providerCursor.get(options.model) || 0
  const slot = slots[cursor % slots.length]
  providerCursor.set(options.model, cursor + 1)
  const entry = entries.find((candidate) => candidate.slot === slot)
  if (!entry) return null
  return {
    keySlot: entry.slot,
    config: {
      baseUrl: options.baseUrl,
      apiKey: entry.apiKey,
      mode: options.mode,
      model: options.model,
    } satisfies VideoApiConfig,
  }
}

export function resetVideoApiPoolForTests() {
  discoveryCache = null
  providerCursor.clear()
}

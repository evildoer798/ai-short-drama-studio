export type ImageApiKeyEntry = {
  slot: number
  apiKey: string
  providerModel?: string
}

export type ImageApiPoolSnapshot = {
  modelIds: string[]
  modelKeySlots: Map<string, number[]>
  successfulSlots: number[]
  failedSlots: number[]
}

type EnvSource = Record<string, string | undefined>

type ImageProviderConfig = {
  baseUrl: string
  apiKey: string
}

type DiscoverOptions = {
  baseUrl: string
  forceRefresh?: boolean
  source?: EnvSource
  listModels?: (config: ImageProviderConfig) => Promise<string[]>
}

let discoveryCache: { key: string, expiresAt: number, value: ImageApiPoolSnapshot } | null = null

const IMAGE_MODEL_ID_PATTERN = /(?:image|banana|flux|recraft|ideogram|dall[-_.]?e|seedream|midjourney|jimeng|kolors|stable[-_.]?diffusion|sdxl)/iu

export function isImageModelId(model: string) {
  return IMAGE_MODEL_ID_PATTERN.test(model)
}

function normalizeModelFamily(model: string) {
  return model
    .trim()
    .toLowerCase()
    .replace(/[-_.](?:1k|2k|4k|8k|1024|2048|4096)$/u, '')
}

function imageModelCostRank(model: string) {
  const normalized = model.toLowerCase()
  const resolution = /(?:^|[-_.])1k(?:$|[-_.])/u.test(normalized)
    ? 0
    : /(?:^|[-_.])2k(?:$|[-_.])/u.test(normalized)
      ? 10
      : /(?:^|[-_.])4k(?:$|[-_.])/u.test(normalized)
        ? 20
        : /(?:^|[-_.])8k(?:$|[-_.])/u.test(normalized)
          ? 30
          : 5
  const premium = /(?:^|[-_.])pro(?:$|[-_.])/u.test(normalized) ? 4 : 0
  return resolution + premium
}

function imageModelPreferenceRank(model: string) {
  const normalized = model.toLowerCase()
  if (/^(?:codex-)?gpt-image/u.test(normalized)) return 0
  if (/gemini-banana/u.test(normalized) && !/pro/u.test(normalized)) return 1
  if (/nano-banana2/u.test(normalized)) return 2
  if (/banana/u.test(normalized) && !/pro/u.test(normalized)) return 3
  if (/banana/u.test(normalized)) return 4
  return 5
}

export function selectCompatibleImageModel(input: {
  requestedModel: string
  providerModel?: string
  availableModels: string[]
}) {
  const availableModels = [...new Set(input.availableModels.map((model) => model.trim()).filter(Boolean))]
  const configuredModels = [input.providerModel, input.requestedModel]
    .map((model) => model?.trim())
    .filter((model): model is string => Boolean(model))

  for (const configuredModel of configuredModels) {
    const exact = availableModels.find((model) => model === configuredModel)
    if (exact) return exact
  }

  const requestedFamilies = new Set(configuredModels.map(normalizeModelFamily))
  const relatedModels = availableModels.filter((model) => requestedFamilies.has(normalizeModelFamily(model)))
  if (relatedModels.length > 0) {
    return relatedModels.sort((left, right) => (
      imageModelCostRank(left) - imageModelCostRank(right) || left.localeCompare(right)
    ))[0]
  }

  const imageModels = availableModels.filter((model) => IMAGE_MODEL_ID_PATTERN.test(model))
  return imageModels.sort((left, right) => (
    imageModelPreferenceRank(left) - imageModelPreferenceRank(right)
    || imageModelCostRank(left) - imageModelCostRank(right)
    || left.localeCompare(right)
  ))[0] || null
}

function apiRoot(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

export function resolveImageApiKeyEntries(source: EnvSource = process.env) {
  const candidates = [
    { slot: 1, apiKey: source.OPENAI_COMPAT_API_KEY || source.OPENAI_COMPAT_API_KEY_1 || '' },
    ...Array.from({ length: 9 }, (_, index) => {
      const slot = index + 2
      return { slot, apiKey: source[`OPENAI_COMPAT_API_KEY_${slot}`] || '' }
    }),
  ]
  const seen = new Set<string>()
  return candidates.flatMap((candidate): ImageApiKeyEntry[] => {
    const apiKey = candidate.apiKey.trim()
    if (!apiKey || seen.has(apiKey)) return []
    seen.add(apiKey)
    const providerModel = (source[`OPENAI_COMPAT_IMAGE_MODEL_${candidate.slot}`] || '').trim()
    return [{
      slot: candidate.slot,
      apiKey,
      ...(providerModel ? { providerModel } : {}),
    }]
  })
}

export function resolveImageApiKeys(source: EnvSource = process.env) {
  return resolveImageApiKeyEntries(source).map((entry) => entry.apiKey)
}

export async function listImageProviderModels(
  config: ImageProviderConfig,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(`${apiRoot(config.baseUrl)}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`IMAGE_MODELS_HTTP_${response.status}`)
  const payload = await response.json() as { data?: unknown }
  const data = Array.isArray(payload.data) ? payload.data : []
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('id' in item)) return []
    const id = String((item as { id?: unknown }).id || '').trim()
    return id ? [id] : []
  })
}

function cacheKey(baseUrl: string, entries: ImageApiKeyEntry[]) {
  return `${baseUrl}|${entries.map((entry) => entry.slot).join(',')}`
}

export async function discoverImageApiModels(options: DiscoverOptions): Promise<ImageApiPoolSnapshot> {
  const entries = resolveImageApiKeyEntries(options.source)
  if (entries.length === 0) throw new Error('OPENAI_COMPAT_API_KEY is required')
  const key = cacheKey(options.baseUrl, entries)
  const now = Date.now()
  if (!options.forceRefresh && discoveryCache?.key === key && discoveryCache.expiresAt > now) {
    return discoveryCache.value
  }

  const listModels = options.listModels || listImageProviderModels
  const results = await Promise.allSettled(entries.map((entry) => listModels({
    baseUrl: options.baseUrl,
    apiKey: entry.apiKey,
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
  if (successfulSlots.length === 0) throw new Error('IMAGE_API_POOL_UNAVAILABLE')

  const value = {
    modelIds: [...modelKeySlots.keys()],
    modelKeySlots,
    successfulSlots,
    failedSlots,
  }
  discoveryCache = { key, expiresAt: now + 30_000, value }
  return value
}

export async function resolveImageApiProviders(options: DiscoverOptions & {
  model: string
  preferredKeySlot?: number
}) {
  const entries = resolveImageApiKeyEntries(options.source)
  if (entries.length === 0) throw new Error('OPENAI_COMPAT_API_KEY is required')

  if (Number.isInteger(options.preferredKeySlot)) {
    const preferred = entries.find((entry) => entry.slot === options.preferredKeySlot)
    if (!preferred) throw new Error(`IMAGE_API_KEY_SLOT_UNAVAILABLE: ${options.preferredKeySlot}`)
    return [{ ...preferred, model: preferred.providerModel || options.model }]
  }

  try {
    const snapshot = await discoverImageApiModels(options)
    const supportedEntries = entries.flatMap((entry) => {
      const availableModels = snapshot.modelIds.filter((model) => (
        snapshot.modelKeySlots.get(model)?.includes(entry.slot)
      ))
      const model = selectCompatibleImageModel({
        requestedModel: options.model,
        providerModel: entry.providerModel,
        availableModels,
      })
      return model ? [{ ...entry, model }] : []
    })
    if (supportedEntries.length === 0) throw new Error(`IMAGE_MODEL_UNAVAILABLE: ${options.model}`)
    return supportedEntries
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('IMAGE_MODEL_UNAVAILABLE:')) throw error
    // A temporary failure of /models must not stop a real generation request.
    return entries.map((entry) => ({
      ...entry,
      model: entry.providerModel || options.model,
    }))
  }
}

export function shouldFailoverImageApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/CONTENT_POLICY|SAFETY|MODERATION|PROMPT_BLOCKED|IMAGE_POLICY/iu.test(message)) return false
  if (/(?:model|模型)[\s\S]{0,80}(?:not found|unavailable|unsupported|not supported|no permission|无权限|不可用|不支持|不存在)/iu.test(message)) return true
  const status = Number(message.match(/IMAGE_API_FAILED:\s*(\d{3})/i)?.[1] || 0)
  if (status === 400 || status === 413 || status === 415 || status === 422) return false
  if (status >= 400) return true
  return /TIMEOUT|TIMED_OUT|NETWORK|FETCH|ECONN|ENOTFOUND|EAI_AGAIN|EMPTY_RESPONSE|ASYNC_FAILED|NO_ACCOUNT|SERVICE_UNAVAILABLE/iu.test(message)
}

export function resetImageApiPoolForTests() {
  discoveryCache = null
}

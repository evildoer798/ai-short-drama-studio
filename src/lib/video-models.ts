import { env } from './env'
import { listVideoProviderModels } from './openai-video'

export type VideoModelPriceMode = 'flat' | 'per_second'
export type VideoResolution = '480p' | '720p'
export type VideoAspectRatio = '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3'
export type VideoModelPriceSource = 'live' | 'reference'

export type VideoModelOption = {
  id: string
  label: string
  family: 'Grok' | 'Seedance'
  description: string
  priceLabel: string
  priceMode: VideoModelPriceMode
  priceSource: VideoModelPriceSource
  unitPrice: number
  startingAt: boolean
  minimumDuration: number
  maximumDuration: number
  supportedDurations: number[] | null
  maximumReferenceImages: number
  maximumPromptCharacters: number
  supportsAudio: boolean
  resolutions: VideoResolution[]
  defaultResolution: VideoResolution
  aspectRatios: VideoAspectRatio[]
  available: boolean | null
}

type VideoModelDefinition = Omit<VideoModelOption, 'available'>

type VideoModelOptionsResult = {
  models: VideoModelOption[]
  defaultModel: string
  warning: string | null
  priceNotice: string
  refreshedAt: string
  priceUpdatedAt: string | null
  refreshIntervalSeconds: number
  stale: boolean
}

const supportedResolutions = new Set<VideoResolution>(['480p', '720p'])
const supportedAspectRatios = new Set<VideoAspectRatio>(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'])
const refreshIntervalMilliseconds = 30_000
const publicPricingPageUrl = 'https://ai.cangyuansuanli.cn/pricing'

const fallbackVideoModelCatalog: VideoModelDefinition[] = [
  {
    id: 'grok-video',
    label: 'xAI · Grok Video',
    family: 'Grok',
    description: '适合低成本动作预演，也支持使用资产参考图。',
    priceLabel: '¥0.80/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 0.8,
    startingAt: false,
    minimumDuration: 6,
    maximumDuration: 15,
    supportedDurations: [6, 10, 15],
    maximumReferenceImages: 4,
    maximumPromptCharacters: 4096,
    supportsAudio: false,
    resolutions: ['480p'],
    defaultResolution: '480p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'grok-video-1.5',
    label: 'xAI · Grok Video 1.5',
    family: 'Grok',
    description: 'Grok 新版本，适合先做低成本镜头验证。',
    priceLabel: '¥1.10/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 1.1,
    startingAt: false,
    minimumDuration: 6,
    maximumDuration: 15,
    supportedDurations: [6, 10, 15],
    maximumReferenceImages: 1,
    maximumPromptCharacters: 4096,
    supportsAudio: false,
    resolutions: ['480p'],
    defaultResolution: '480p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'seedance-2.0-mini',
    label: '即梦 · Seedance 2.0 Mini',
    family: 'Seedance',
    description: '4–15 秒，最多 4 张资产参考图，支持标准 480p 与 HD 720p。',
    priceLabel: '¥2.90/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 2.9,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 4,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'],
  },
  {
    id: 'seedance-2.0-fast-720p',
    label: '字节跳动 · Seedance 2.0 Fast 720p',
    family: 'Seedance',
    description: '快速档，最高支持 15 秒。',
    priceLabel: '¥0.75/秒',
    priceMode: 'per_second',
    priceSource: 'reference',
    unitPrice: 0.75,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 4,
    maximumPromptCharacters: 5000,
    supportsAudio: false,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'seedance-2.0-720p',
    label: '字节跳动 · Seedance 2.0 720p',
    family: 'Seedance',
    description: '质量优先档，适合确认后的正式分镜视频。',
    priceLabel: '¥0.975/秒',
    priceMode: 'per_second',
    priceSource: 'reference',
    unitPrice: 0.975,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 4,
    maximumPromptCharacters: 5000,
    supportsAudio: false,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
]

let responseCache: { value: VideoModelOptionsResult, expiresAt: number } | null = null
let lastAvailableModelIds: Set<string> | null = null
let lastLivePricingCatalog: VideoModelDefinition[] | null = null
let lastPriceUpdate: number | null = null

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function formatPriceLabel(price: number, mode: VideoModelPriceMode) {
  const decimals = Math.abs(price * 100 - Math.round(price * 100)) > 0.00001 ? 3 : 2
  return `¥${price.toFixed(decimals)}/${mode === 'per_second' ? '秒' : '条'}`
}

function pricingProviderLabel(item: Record<string, unknown>, modelId: string) {
  const vendorId = Number(item.vendor_id)
  if (vendorId === 10 || /^grok-video(?:-|$)/i.test(modelId)) return 'xAI'
  if (vendorId === 12) return '字节跳动'
  return '即梦'
}

function liveModelLabel(modelId: string, providerLabel: string) {
  const faceLocked = modelId.startsWith('sd5-')
  const normalized = modelId.replace(/^sd5-/, '')
  const label = /^grok-video(?:-|$)/i.test(normalized)
    ? normalized.replace(/^grok-video/i, 'Grok Video').replace(/-1\.5$/i, ' 1.5')
    : normalized
        .replace(/^seedance-2\.0/i, 'Seedance 2.0')
        .replace(/-mini/gi, ' Mini')
        .replace(/-fast/gi, ' Fast')
        .replace(/-(480p|720p)$/i, ' $1')
        .replace(/-8s$/i, ' 8s')
  return `${providerLabel} · ${label}${faceLocked ? '（卡人脸）' : ''}`
}

function pricingApiUrl() {
  return new URL('/api/pricing', publicPricingPageUrl).toString()
}

function optionValues(value: unknown) {
  const options = Array.isArray(record(value).options) ? record(value).options as unknown[] : []
  return options.flatMap((option) => {
    const candidate = String(record(option).value || '').toLowerCase()
    return candidate ? [candidate] : []
  })
}

function durationOptionValues(value: unknown) {
  const options = Array.isArray(record(value).options) ? record(value).options as unknown[] : []
  return [...new Set(options.flatMap((option) => {
    const rawValue = typeof option === 'object' && option !== null
      ? record(option).value
      : option
    const match = String(rawValue ?? '').match(/\d+(?:\.\d+)?/)
    if (!match) return []
    const duration = Math.round(Number(match[0]))
    return Number.isFinite(duration) && duration >= 4 && duration <= 15 ? [duration] : []
  }))].sort((left, right) => left - right)
}

function modelResolutions(modelId: string, resolutionConfig: unknown) {
  const config = record(resolutionConfig)
  const candidates = optionValues(config)
  const fixedLabel = String(config.fixedLabel || '').toLowerCase()
  if (fixedLabel) candidates.push(fixedLabel)
  const idResolution = modelId.match(/(?:^|-)(480p|720p|1080p|4k)(?:-|$)/i)?.[1]?.toLowerCase()
  if (idResolution) candidates.push(idResolution)
  if (candidates.length === 0) candidates.push('720p')
  return [...new Set(candidates)]
    .filter((value): value is VideoResolution => supportedResolutions.has(value as VideoResolution))
}

function modelAspectRatios(ratioConfig: unknown) {
  const values = optionValues(record(ratioConfig))
    .filter((value): value is VideoAspectRatio => supportedAspectRatios.has(value as VideoAspectRatio))
  return values.length > 0 ? [...new Set(values)] : ['16:9', '9:16'] as VideoAspectRatio[]
}

export function parseVideoPricingCatalog(payload: unknown): VideoModelDefinition[] {
  const data = Array.isArray(record(payload).data) ? record(payload).data as unknown[] : []
  return data.flatMap((rawItem) => {
    const item = record(rawItem)
    const id = String(item.model_name || '').trim()
    const family = /^grok-video(?:-|$)/i.test(id)
      ? 'Grok' as const
      : /^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(id) ? 'Seedance' as const : null
    if (!family) return []

    const price = Number(item.model_price)
    if (!Number.isFinite(price) || price < 0) return []
    const params = record(record(item.video_ui_params).params)
    const resolutions = modelResolutions(id, params.resolution)
    if (resolutions.length === 0) return []
    const duration = record(params.duration)
    const liveDurationOptions = durationOptionValues(duration)
    const supportedDurations = liveDurationOptions.length > 0
      ? liveDurationOptions
      : family === 'Grok' ? [6, 10, 15] : null
    const minimumDuration = supportedDurations?.[0]
      ?? Math.max(4, Math.round(Number(duration.min) || 4))
    const maximumDuration = supportedDurations?.at(-1)
      ?? Math.min(15, Math.max(minimumDuration, Math.round(Number(duration.max) || 15)))
    const priceMode: VideoModelPriceMode = item.billing_mode === 'per_second' ? 'per_second' : 'flat'
    const generateAudio = record(params.generateAudio)
    const referenceLimits = record(record(item.video_ui_params).referenceLimits)
    const maximumReferenceImages = Math.max(1, Math.min(4, Math.round(Number(referenceLimits.images) || 4)))
    const providerLabel = pricingProviderLabel(item, id)
    const maximumPromptCharacters = family === 'Grok' ? 4096 : 5000
    const defaultResolution = /(?:^|-)480p(?:-|$)/i.test(id)
      ? '480p'
      : resolutions.includes('720p') ? '720p' : resolutions[0]

    return [{
      id,
      label: liveModelLabel(id, providerLabel),
      family,
      description: String(item.description || `${providerLabel} 视频生成模型。`).trim(),
      priceLabel: formatPriceLabel(price, priceMode),
      priceMode,
      priceSource: 'live' as const,
      unitPrice: price,
      startingAt: false,
      minimumDuration,
      maximumDuration,
      supportedDurations,
      maximumReferenceImages,
      maximumPromptCharacters,
      supportsAudio: generateAudio.enabled !== false,
      resolutions,
      defaultResolution,
      aspectRatios: modelAspectRatios(params.ratio),
    }]
  })
}

function mergeCatalog(liveCatalog: VideoModelDefinition[] | null) {
  if (!liveCatalog?.length) return fallbackVideoModelCatalog
  const liveIds = new Set(liveCatalog.map((model) => model.id))
  return [
    ...liveCatalog,
    ...fallbackVideoModelCatalog.filter((model) => !liveIds.has(model.id)),
  ]
}

function effectiveEightSecondPrice(model: VideoModelDefinition) {
  const duration = Math.min(8, model.maximumDuration)
  return estimateVideoModelPrice(model, duration)
}

export function getVideoModelDefinition(modelId: string) {
  return fallbackVideoModelCatalog.find((model) => model.id === modelId) || null
}

export function estimateVideoModelPrice(model: VideoModelDefinition, duration: number) {
  return model.priceMode === 'per_second'
    ? model.unitPrice * duration
    : model.unitPrice
}

export function videoModelPromptBudget(model: Pick<VideoModelDefinition, 'maximumPromptCharacters'>) {
  return Math.max(1600, model.maximumPromptCharacters - 96)
}

async function fetchLivePricingCatalog() {
  const response = await fetch(pricingApiUrl(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`VIDEO_PRICING_HTTP_${response.status}`)
  const catalog = parseVideoPricingCatalog(await response.json())
  if (catalog.length === 0) throw new Error('VIDEO_PRICING_EMPTY')
  return catalog
}

export async function getVideoModelOptions(options: { forceRefresh?: boolean } = {}) {
  const now = Date.now()
  if (!options.forceRefresh && responseCache && responseCache.expiresAt > now) {
    return responseCache.value
  }

  const [availabilityResult, pricingResult] = await Promise.allSettled([
    listVideoProviderModels({
      baseUrl: env.videoApiBaseUrl(),
      apiKey: env.videoApiKey(),
    }),
    fetchLivePricingCatalog(),
  ])

  if (availabilityResult.status === 'fulfilled') {
    lastAvailableModelIds = new Set(availabilityResult.value)
  }
  if (pricingResult.status === 'fulfilled') {
    lastLivePricingCatalog = pricingResult.value
    lastPriceUpdate = now
  }

  const warningParts: string[] = []
  if (availabilityResult.status === 'rejected') {
    warningParts.push(lastAvailableModelIds
      ? '模型可用性刷新失败，正在使用上一次结果。'
      : '暂时无法实时校验模型状态，提交任务时会再次检查。')
  }
  if (pricingResult.status === 'rejected') {
    warningParts.push(lastLivePricingCatalog
      ? '实时价格刷新失败，正在使用上一次价格。'
      : '实时价格暂不可用，当前显示参考价格。')
  }

  const catalog = mergeCatalog(lastLivePricingCatalog)
  const models = catalog
    .map((model) => ({
      ...model,
      available: lastAvailableModelIds ? lastAvailableModelIds.has(model.id) : null,
    }))
    .sort((left, right) => (
      Number(right.available === true) - Number(left.available === true)
      || Number(left.available === false) - Number(right.available === false)
      || effectiveEightSecondPrice(left) - effectiveEightSecondPrice(right)
      || left.label.localeCompare(right.label, 'zh-CN')
    ))
  const configured = env.videoModel()
  const defaultModel = models.find((model) => model.id === configured && model.available !== false)?.id
    || models.find((model) => model.available)?.id
    || models.find((model) => model.available !== false)?.id
    || models[0].id
  const hasReferencePrices = models.some((model) => model.priceSource === 'reference')
  const stale = availabilityResult.status === 'rejected' || pricingResult.status === 'rejected'
  const value: VideoModelOptionsResult = {
    models,
    defaultModel,
    warning: warningParts.join(' ') || null,
    priceNotice: lastPriceUpdate
      ? `字节跳动、xAI 与即梦视频价格实时读取自沧元模型广场。${hasReferencePrices ? '未被实时目录覆盖的模型标记为参考价格。' : ''}`
      : '当前显示本地参考价格，实际扣费以沧元模型广场为准。',
    refreshedAt: new Date(now).toISOString(),
    priceUpdatedAt: lastPriceUpdate ? new Date(lastPriceUpdate).toISOString() : null,
    refreshIntervalSeconds: 60,
    stale,
  }
  responseCache = { value, expiresAt: now + refreshIntervalMilliseconds }
  return value
}

export async function resolveVideoModelDefinition(modelId: string) {
  const options = await getVideoModelOptions()
  const model = options.models.find((candidate) => candidate.id === modelId && candidate.available !== false)
  if (!model) return null
  const { available: _available, ...definition } = model
  return definition
}

export function resetVideoModelCacheForTests() {
  responseCache = null
  lastAvailableModelIds = null
  lastLivePricingCatalog = null
  lastPriceUpdate = null
}

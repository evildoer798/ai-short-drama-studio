import { env } from './env'
import { preferCangyuanDirectApiBaseUrl } from './cangyuan-api'
import { isDirectSeedanceModel, isSd6SeedanceModel, isSeedance25Model } from './openai-video'
import { discoverVideoApiModels } from './video-api-pool'
import { DEFAULT_VIDEO_MODEL_ID } from './video-defaults'

export type VideoModelPriceMode = 'flat' | 'per_second'
export type VideoResolution = '480p' | '720p' | '1080p' | '2k' | '4k'
export type VideoAspectRatio = '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3' | '3:2' | '2:3'
export type VideoModelPriceSource = 'live' | 'reference'
export type VideoModelFamily = 'Grok' | 'Seedance' | 'Sora' | 'HappyHouse' | 'Kling' | 'MiniMax' | 'Veo' | 'Gemini' | 'Omni' | 'Other'

export type VideoModelOption = {
  id: string
  label: string
  family: VideoModelFamily
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
  maximumReferenceVideos?: number
  maximumReferenceAudios?: number
  requiresReferenceVideo?: boolean
  maximumPromptCharacters: number
  supportsAudio: boolean
  resolutions: VideoResolution[]
  defaultResolution: VideoResolution
  aspectRatios: VideoAspectRatio[]
  supportsHumanFaceReferences: boolean
  available: boolean | null
}

type VideoModelDefinition = Omit<VideoModelOption, 'available' | 'supportsHumanFaceReferences'>

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

const supportedResolutions = new Set<VideoResolution>(['480p', '720p', '1080p', '2k', '4k'])

function fallbackAudioReferenceLimit(modelId: string) {
  return /^(?:sd7-seedance-2\.0-(?:720p|1080p)|sd8-seedance-2\.0|seedance-2\.0|minimax-h3-2k)$/i.test(modelId)
    ? 3
    : 0
}
const supportedAspectRatios = new Set<VideoAspectRatio>(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3', '3:2', '2:3'])
const refreshIntervalMilliseconds = 30_000
const publicPricingPageUrl = preferCangyuanDirectApiBaseUrl('https://ai.cangyuansuanli.cn/pricing')

const fallbackVideoModelCatalog: VideoModelDefinition[] = [
  {
    id: 'kling-3.0-omni',
    label: 'kling-3.0-omni',
    family: 'Kling',
    description: 'Kling 3.0 Omni 多模态视频生成，支持 3–15 秒、720p/1080p、原生音频与最多 3 张参考图。',
    priceLabel: '¥1.30/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 1.3,
    startingAt: false,
    minimumDuration: 3,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 3,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'minimax-h3-2k',
    label: 'minimax-h3-2k',
    family: 'MiniMax',
    description: 'MiniMax H3 2K，支持文生、图生、多模态、首尾帧、原生音频与 5–15 秒。',
    priceLabel: '¥2.50/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 2.5,
    startingAt: false,
    minimumDuration: 5,
    maximumDuration: 15,
    supportedDurations: Array.from({ length: 11 }, (_value, index) => index + 5),
    maximumReferenceImages: 5,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['2k'],
    defaultResolution: '2k',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'],
  },
  {
    id: 'seedance-2.5-480p',
    label: '即梦 · Seedance 2.5 480p',
    family: 'Seedance',
    description: '固定 480p，支持 4–30 秒、原生音频和最多 30 张多模态参考图，按秒计费。',
    priceLabel: '¥0.25/秒',
    priceMode: 'per_second',
    priceSource: 'reference',
    unitPrice: 0.25,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 30,
    supportedDurations: Array.from({ length: 27 }, (_value, index) => index + 4),
    maximumReferenceImages: 30,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['480p'],
    defaultResolution: '480p',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'],
  },
  {
    id: 'seedance-2.5-720p',
    label: '即梦 · Seedance 2.5 720p',
    family: 'Seedance',
    description: '固定 720p，支持 4–29 秒、原生音频和最多 30 张多模态参考图，按秒计费。',
    priceLabel: '¥0.35/秒',
    priceMode: 'per_second',
    priceSource: 'reference',
    unitPrice: 0.35,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 29,
    supportedDurations: Array.from({ length: 26 }, (_value, index) => index + 4),
    maximumReferenceImages: 30,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'],
  },
  {
    id: 'sd6-seedance-2.0-720p',
    label: 'sd6-seedance-2.0-720p',
    family: 'Seedance',
    description: '不卡脸固定 720p，支持文生、图生、多模态参考与首尾帧。',
    priceLabel: '¥4.60/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 4.6,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: [4, 5, 6, 8, 10, 12, 15],
    maximumReferenceImages: 9,
    maximumPromptCharacters: 5000,
    supportsAudio: false,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
  {
    id: 'sd6-seedance-2.0-1080p',
    label: 'sd6-seedance-2.0-1080p',
    family: 'Seedance',
    description: '不卡脸固定 1080p，支持文生、图生、多模态参考与首尾帧。',
    priceLabel: '¥0.89/秒',
    priceMode: 'per_second',
    priceSource: 'reference',
    unitPrice: 0.89,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: [4, 5, 6, 8, 10, 12, 15],
    maximumReferenceImages: 9,
    maximumPromptCharacters: 5000,
    supportsAudio: false,
    resolutions: ['1080p'],
    defaultResolution: '1080p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  },
  {
    id: 'sd5-seedance-2.0',
    label: '字节跳动 · Seedance 2.0（卡人脸/真人受限）',
    family: 'Seedance',
    description: '异步卡人脸版，4–15 秒；写实真人面孔参考可能被上游拒绝。',
    priceLabel: '¥3.35/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 3.35,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 9,
    maximumPromptCharacters: 1200,
    supportsAudio: true,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'sd5-seedance-2.0-fast',
    label: '字节跳动 · Seedance 2.0 Fast（卡人脸/真人受限）',
    family: 'Seedance',
    description: '异步卡人脸快速版，4–15 秒；写实真人面孔参考可能被上游拒绝。',
    priceLabel: '¥2.10/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 2.1,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 9,
    maximumPromptCharacters: 1200,
    supportsAudio: true,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'happyhouse-1.1',
    label: '阿里巴巴 · HappyHouse 1.1',
    family: 'HappyHouse',
    description: '3–15 秒，支持 720p / 1080p、原生音频和最多 9 张参考图。',
    priceLabel: '¥2.90/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 2.9,
    startingAt: false,
    minimumDuration: 3,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 9,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3'],
  },
  {
    id: 'happyhouse-1.0',
    label: '阿里巴巴 · HappyHouse 1.0',
    family: 'HappyHouse',
    description: '3–15 秒，支持 720p / 1080p、原生音频和最多 9 张参考图。',
    priceLabel: '¥4.50/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 4.5,
    startingAt: false,
    minimumDuration: 3,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 9,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3'],
  },
  {
    id: 'sora-2',
    label: 'OpenAI · Sora 2（不支持真人人脸参考）',
    family: 'Sora',
    description: '异步标准版，支持 4/8/12 秒、原生音频和单张非真人人脸帧参考图。',
    priceLabel: '¥0.70/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 0.7,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 12,
    supportedDurations: [4, 8, 12],
    maximumReferenceImages: 1,
    maximumPromptCharacters: 1200,
    supportsAudio: true,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
  {
    id: 'sora-2-pro',
    label: 'OpenAI · Sora 2 Pro（不支持真人人脸参考）',
    family: 'Sora',
    description: '异步高阶版，支持 4/8/12 秒、原生音频和单张非真人人脸帧参考图。',
    priceLabel: '¥0.90/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 0.9,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 12,
    supportedDurations: [4, 8, 12],
    maximumReferenceImages: 1,
    maximumPromptCharacters: 1200,
    supportsAudio: true,
    resolutions: ['720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16'],
  },
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
    id: 'seedance-2.0',
    label: '即梦 · Seedance 2.0',
    family: 'Seedance',
    description: '标准版，支持文生、图生、多模态和首尾帧，4–15 秒；最多 5 张原图与 3 段参考视频。',
    priceLabel: '¥3.90/条',
    priceMode: 'flat',
    priceSource: 'reference',
    unitPrice: 3.9,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: null,
    maximumReferenceImages: 5,
    maximumReferenceVideos: 3,
    maximumPromptCharacters: 5000,
    supportsAudio: true,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'],
  },
  {
    id: 'seedance-2.0-mini',
    label: '即梦 · Seedance 2.0 Mini',
    family: 'Seedance',
    description: '4–15 秒，当前线路最多 4 张参考图片，支持标准 480p 与 HD 720p。',
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
  if (vendorId === 2 || /^sora-2(?:-|$)/i.test(modelId)) return 'OpenAI'
  if (vendorId === 8 || /^happyhouse-(?:1\.0|1\.1)$/i.test(modelId)) return '阿里巴巴'
  if (vendorId === 11 || /^kling-(?:-|\d)/i.test(modelId)) return '快手'
  if (vendorId === 30 || /^minimax-(?:-|\w)/i.test(modelId)) return 'MiniMax'
  if (vendorId === 6 || /^(?:veo-|gemini-|omni-)/i.test(modelId)) return 'Google'
  if (vendorId === 12) return '字节跳动'
  return '即梦'
}

function pricingModelFamily(item: Record<string, unknown>, modelId: string): VideoModelFamily {
  const vendorId = Number(item.vendor_id)
  if (/^grok-(?:video|imagine-video)(?:-|$)/i.test(modelId)) return 'Grok'
  if (/^(?:sd[5-8]-)?seedance-2\.(?:0|5)(?:-|$)/i.test(modelId)) return 'Seedance'
  if (/^sora-2(?:-|$)/i.test(modelId)) return 'Sora'
  if (/^happyhouse-(?:1\.0|1\.1)$/i.test(modelId)) return 'HappyHouse'
  if (vendorId === 11 || /^kling-(?:-|\d)/i.test(modelId)) return 'Kling'
  if (vendorId === 30 || /^minimax-(?:-|\w)/i.test(modelId)) return 'MiniMax'
  if (/^veo-(?:-|\d)/i.test(modelId)) return 'Veo'
  if (/^gemini-(?:-|\w)/i.test(modelId)) return 'Gemini'
  if (/^omni-(?:-|\w)/i.test(modelId)) return 'Omni'
  return 'Other'
}

export function videoModelSupportsHumanFaceReferences(
  model: Pick<VideoModelDefinition, 'id' | 'family'>,
) {
  return model.family !== 'Sora' && !isDirectSeedanceModel(model.id)
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
  const config = record(value)
  const options = [
    ...(Array.isArray(config.options) ? config.options as unknown[] : []),
    ...(Array.isArray(config.numericOptions) ? config.numericOptions as unknown[] : []),
  ]
  const fixedMatch = String(config.fixedLabel || '').match(/\d+(?:\.\d+)?/)
  if (fixedMatch) options.push(Number(fixedMatch[0]))
  return [...new Set(options.flatMap((option) => {
    const rawValue = typeof option === 'object' && option !== null
      ? record(option).value
      : option
    const match = String(rawValue ?? '').match(/\d+(?:\.\d+)?/)
    if (!match) return []
    const duration = Math.round(Number(match[0]))
    return Number.isFinite(duration) && duration >= 3 && duration <= 30 ? [duration] : []
  }))].sort((left, right) => left - right)
}

function modelResolutions(modelId: string, resolutionConfig: unknown) {
  const config = record(resolutionConfig)
  const candidates = optionValues(config)
  const fixedLabel = String(config.fixedLabel || '').toLowerCase()
  if (fixedLabel) candidates.push(fixedLabel)
  const idResolution = modelId.match(/(?:^|-)(480p|720p|1080p|2k|4k)(?:-|$)/i)?.[1]?.toLowerCase()
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

function dedupeVideoModelDefinitions(models: VideoModelDefinition[]) {
  const unique = new Map<string, VideoModelDefinition>()
  for (const model of models) {
    const key = model.id.trim().toLowerCase()
    if (!key) continue
    const existing = unique.get(key)
    if (!existing || (existing.priceSource === 'reference' && model.priceSource === 'live')) {
      unique.set(key, model)
    }
  }
  return [...unique.values()]
}

export function parseVideoPricingCatalog(payload: unknown): VideoModelDefinition[] {
  const data = Array.isArray(record(payload).data) ? record(payload).data as unknown[] : []
  const catalog = data.flatMap((rawItem) => {
    const item = record(rawItem)
    const id = String(item.model_name || '').trim()
    const videoUiParams = record(item.video_ui_params)
    if (!id || Object.keys(videoUiParams).length === 0) return []
    const family = pricingModelFamily(item, id)

    const price = Number(item.model_price)
    if (!Number.isFinite(price) || price < 0) return []
    const params = record(videoUiParams.params)
    const resolutions = modelResolutions(id, params.resolution)
    if (resolutions.length === 0) return []
    const duration = record(params.duration)
    const parsedDurationOptions = durationOptionValues(duration)
    const liveDurationOptions = id.toLowerCase() === 'seedance-2.5-480p'
      ? [...new Set([...parsedDurationOptions, 30])].sort((left, right) => left - right)
      : parsedDurationOptions
    const supportedDurations = liveDurationOptions.length > 0
      ? liveDurationOptions
      : family === 'Grok' ? [6, 10, 15] : null
    const minimumDuration = supportedDurations?.[0]
      ?? Math.max(3, Math.round(Number(duration.min) || 4))
    const documentedMaximumDuration = id.toLowerCase() === 'seedance-2.5-480p'
      ? 30
      : id.toLowerCase() === 'seedance-2.5-720p' ? 29 : null
    const maximumDuration = documentedMaximumDuration
      ?? supportedDurations?.at(-1)
      ?? Math.min(30, Math.max(minimumDuration, Math.round(Number(duration.max) || 15)))
    const priceMode: VideoModelPriceMode = item.billing_mode === 'per_second' ? 'per_second' : 'flat'
    const generateAudio = record(params.generateAudio)
    const referenceLimits = record(videoUiParams.referenceLimits)
    const documentedParams = Array.isArray(record(item.api_doc).params)
      ? record(item.api_doc).params as unknown[]
      : []
    const documentedFields = new Set(documentedParams.flatMap((value) => {
      const name = String(record(value).name || '').trim()
      return name ? [name] : []
    }))
    const hasDocumentedFields = documentedFields.size > 0
    const allowsImageReferences = !hasDocumentedFields || documentedFields.has('reference_image_urls')
    const allowsVideoReferences = !hasDocumentedFields || documentedFields.has('reference_videos')
    const allowsAudioReferences = !hasDocumentedFields || documentedFields.has('reference_audios')
    const isSd7 = /^sd7-seedance-2\.0-(?:720p|1080p)$/i.test(id)
    const fallbackReferenceLimit = isSeedance25Model(id)
      ? 30
      : isSd7 ? 5
      : isDirectSeedanceModel(id) || isSd6SeedanceModel(id) || family === 'HappyHouse' ? 9
      : family === 'Sora' ? 1 : family === 'Grok' ? 7 : 3
    const reportedReferenceLimit = Math.round(Number(referenceLimits.images))
    const maximumReferenceImages = allowsImageReferences
      ? Number.isFinite(reportedReferenceLimit) && reportedReferenceLimit >= 0
        ? Math.min(30, reportedReferenceLimit)
        : fallbackReferenceLimit
      : 0
    const reportedVideoLimit = Math.round(Number(referenceLimits.videos))
    const maximumReferenceVideos = allowsVideoReferences
      ? Number.isFinite(reportedVideoLimit) && reportedVideoLimit >= 0
        ? Math.min(3, reportedVideoLimit)
        : isSd6SeedanceModel(id) ? 3 : 0
      : 0
    const reportedAudioLimit = Math.round(Number(referenceLimits.audios ?? referenceLimits.audio))
    const maximumReferenceAudios = allowsAudioReferences
      ? Number.isFinite(reportedAudioLimit) && reportedAudioLimit >= 0
        ? Math.min(3, reportedAudioLimit)
        : fallbackAudioReferenceLimit(id)
      : 0
    const providerLabel = pricingProviderLabel(item, id)
    const maximumPromptCharacters = family === 'Grok'
      ? 4096
      : family === 'Sora' || isDirectSeedanceModel(id) ? 1200 : 5000
    const defaultResolution = /(?:^|-)480p(?:-|$)/i.test(id)
      ? '480p'
      : resolutions.includes('720p') ? '720p' : resolutions[0]

    return [{
      id,
      label: id,
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
      maximumReferenceVideos,
      maximumReferenceAudios,
      requiresReferenceVideo: String(videoUiParams.payloadBuilder || '') === 'omni-v2v',
      maximumPromptCharacters,
      supportsAudio: generateAudio.enabled !== false,
      resolutions,
      defaultResolution,
      aspectRatios: modelAspectRatios(params.ratio),
    }]
  })
  return dedupeVideoModelDefinitions(catalog)
}

function mergeCatalog(liveCatalog: VideoModelDefinition[] | null) {
  if (!liveCatalog?.length) return fallbackVideoModelCatalog
  const liveIds = new Set(liveCatalog.map((model) => model.id.toLowerCase()))
  const merged = [
    ...liveCatalog,
    ...fallbackVideoModelCatalog.filter((model) => !liveIds.has(model.id.toLowerCase())),
  ]
  return dedupeVideoModelDefinitions(merged)
}

function effectiveEightSecondPrice(model: VideoModelDefinition) {
  const duration = Math.min(8, model.maximumDuration)
  return estimateVideoModelPrice(model, duration)
}

export function getVideoModelDefinition(modelId: string) {
  const model = fallbackVideoModelCatalog.find((candidate) => candidate.id === modelId)
  if (model) return { ...model, label: model.id }
  const sd7Match = /^sd7-seedance-2\.0-(720p|1080p)$/i.exec(modelId.trim())
  if (!sd7Match) return null
  const resolution = sd7Match[1].toLowerCase() as VideoResolution
  return {
    id: modelId,
    label: modelId,
    family: 'Seedance' as const,
    description: `Seedance 2.0 ${resolution} 多模态视频生成。`,
    priceLabel: '实时价格',
    priceMode: 'flat' as const,
    priceSource: 'live' as const,
    unitPrice: 0,
    startingAt: false,
    minimumDuration: 4,
    maximumDuration: 15,
    supportedDurations: [4, 5, 6, 8, 10, 12, 15],
    maximumReferenceImages: 5,
    maximumReferenceVideos: 3,
    maximumPromptCharacters: 5000,
    supportsAudio: false,
    resolutions: [resolution],
    defaultResolution: resolution,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'] as VideoAspectRatio[],
  }
}

export function estimateVideoModelPrice(model: VideoModelDefinition, duration: number) {
  return model.priceMode === 'per_second'
    ? model.unitPrice * duration
    : model.unitPrice
}

export function videoModelPromptBudget(
  model: Pick<VideoModelDefinition, 'id' | 'family' | 'maximumPromptCharacters'>,
) {
  const providerBudget = Math.max(400, model.maximumPromptCharacters - 96)
  return model.family === 'Seedance' && !isSeedance25Model(model.id)
    ? Math.min(providerBudget, 1104)
    : providerBudget
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
    discoverVideoApiModels({
      baseUrl: env.videoApiBaseUrl(),
      mode: env.videoApiMode() as 'auto' | 'openai' | 'sub2api-grok' | 'newapi-grok',
      forceRefresh: options.forceRefresh,
    }),
    fetchLivePricingCatalog(),
  ])

  if (availabilityResult.status === 'fulfilled') {
    lastAvailableModelIds = new Set(availabilityResult.value.modelIds)
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
  if (availabilityResult.status === 'fulfilled' && availabilityResult.value.failedSlots.length > 0) {
    warningParts.push(`视频 API 线路 ${availabilityResult.value.failedSlots.join('、')} 暂时不可用，已使用其余线路。`)
  }
  if (pricingResult.status === 'rejected') {
    warningParts.push(lastLivePricingCatalog
      ? '实时价格刷新失败，正在使用上一次价格。'
      : '实时价格暂不可用，当前显示参考价格。')
  }

  const catalog = mergeCatalog(lastLivePricingCatalog)
  if (lastAvailableModelIds && lastLivePricingCatalog?.some((model) => (
    isDirectSeedanceModel(model.id) && !lastAvailableModelIds?.has(model.id)
  ))) {
    warningParts.push('Seedance 2.0 Fast 实时价格可见，但当前视频 API Key 尚未开通该模型权限。')
  }
  const models = catalog
    .map((model) => ({
      ...model,
      maximumReferenceAudios: model.maximumReferenceAudios ?? fallbackAudioReferenceLimit(model.id),
      label: model.id,
      supportsHumanFaceReferences: videoModelSupportsHumanFaceReferences(model),
      available: lastAvailableModelIds ? lastAvailableModelIds.has(model.id) : null,
    }))
    .sort((left, right) => (
      Number(right.available === true) - Number(left.available === true)
      || Number(left.available === false) - Number(right.available === false)
      || effectiveEightSecondPrice(left) - effectiveEightSecondPrice(right)
      || left.label.localeCompare(right.label, 'zh-CN')
    ))
  const configured = env.videoModel() || DEFAULT_VIDEO_MODEL_ID
  const defaultModel = models.find((model) => model.id === configured && model.available !== false)?.id
    || models.find((model) => model.available)?.id
    || models.find((model) => model.available !== false)?.id
    || models[0].id
  const hasReferencePrices = models.some((model) => model.priceSource === 'reference')
  const stale = availabilityResult.status === 'rejected'
    || availabilityResult.value.failedSlots.length > 0
    || pricingResult.status === 'rejected'
  const value: VideoModelOptionsResult = {
    models,
    defaultModel,
    warning: warningParts.join(' ') || null,
    priceNotice: lastPriceUpdate
      ? `视频模型价格与能力实时读取自沧元模型广场。${hasReferencePrices ? '未被实时目录覆盖的模型标记为参考价格。' : ''}`
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

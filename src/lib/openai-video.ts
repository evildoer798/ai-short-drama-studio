import { normalizeVideoDuration } from './video-batch'
import { prepareVideoPromptForProvider } from './video-prompt-safety'

export type VideoApiMode = 'openai' | 'sub2api-grok' | 'newapi-grok'
export type VideoGenerationResolution = '480p' | '720p' | '1080p' | '2k' | '4k'
export type VideoGenerationAspectRatio = '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3'

export type VideoCapability = {
  mode: VideoApiMode
  model: string
}

export type VideoApiConfig = {
  baseUrl: string
  apiKey: string
  mode?: 'auto' | VideoApiMode
  model?: string
}

export type VideoJob = {
  id: string
  status: string
  progress?: number
  raw: Record<string, unknown>
}

const directSeedanceModelIds = new Set([
  'sd5-seedance-2.0',
  'sd5-seedance-2.0-fast',
])

export function isDirectSeedanceModel(model: string) {
  return directSeedanceModelIds.has(model.trim().toLowerCase())
}

export function isSeedance25Model(model: string) {
  return /^seedance-2\.5-(?:480p|720p)$/i.test(model.trim())
}

export function isSd6SeedanceModel(model: string) {
  return /^sd[67]-seedance-2\.0-(?:720p|1080p)$/i.test(model.trim())
}

export function isSoraVideoModel(model: string) {
  return /^sora-2(?:-pro)?$/i.test(model.trim())
}

export function isHappyHouseVideoModel(model: string) {
  return /^happyhouse-(?:1\.0|1\.1)$/i.test(model.trim())
}

type CanonicalVideoProfile = {
  duration: null | { defaultValue: number, minimum: number, maximum: number, options?: number[] }
  resolution: null | 'input' | '2k'
  generateAudio: boolean
  maximumReferenceImages: number
  maximumReferenceVideos: number
  maximumReferenceAudios: number
  supportsFrameUrls: boolean
  maximumPromptCharacters: number
}

function canonicalVideoProfile(model: string): CanonicalVideoProfile | null {
  const id = model.trim().toLowerCase()
  if (id === 'grok-video' || id === 'grok-video-1.5') {
    return {
      duration: { defaultValue: 8, minimum: 4, maximum: 15, options: [4, 6, 8, 10, 12, 15] },
      resolution: 'input', generateAudio: false,
      maximumReferenceImages: 7, maximumReferenceVideos: 0, maximumReferenceAudios: 0,
      supportsFrameUrls: false, maximumPromptCharacters: 4096,
    }
  }
  if (id === 'happyhouse-1.0' || id === 'happyhouse-1.1') {
    return {
      duration: { defaultValue: 8, minimum: 3, maximum: 15 },
      resolution: 'input', generateAudio: true,
      maximumReferenceImages: 9, maximumReferenceVideos: id === 'happyhouse-1.0' ? 1 : 0,
      maximumReferenceAudios: 0, supportsFrameUrls: false, maximumPromptCharacters: 5000,
    }
  }
  if (id === 'sd7-seedance-2.0-720p' || id === 'sd7-seedance-2.0-1080p' || id === 'seedance-2.0') {
    return {
      duration: { defaultValue: 8, minimum: 4, maximum: 15 },
      resolution: null, generateAudio: true,
      maximumReferenceImages: 5, maximumReferenceVideos: 3, maximumReferenceAudios: 3,
      supportsFrameUrls: false, maximumPromptCharacters: 5000,
    }
  }
  if (id === 'sd8-seedance-2.0') {
    return {
      duration: { defaultValue: 10, minimum: 5, maximum: 15, options: [5, 10, 15] },
      resolution: null, generateAudio: false,
      maximumReferenceImages: 9, maximumReferenceVideos: 3, maximumReferenceAudios: 3,
      supportsFrameUrls: false, maximumPromptCharacters: 5000,
    }
  }
  if (id === 'minimax-h3-2k') {
    return {
      duration: { defaultValue: 8, minimum: 5, maximum: 15 },
      resolution: '2k', generateAudio: true,
      maximumReferenceImages: 5, maximumReferenceVideos: 0, maximumReferenceAudios: 3,
      supportsFrameUrls: true, maximumPromptCharacters: 5000,
    }
  }
  if (id === 'omni-fast' || id === 'omni-fast-no-water') {
    return {
      duration: null, resolution: null, generateAudio: false,
      maximumReferenceImages: 5, maximumReferenceVideos: 0, maximumReferenceAudios: 0,
      supportsFrameUrls: true, maximumPromptCharacters: 5000,
    }
  }
  if (id === 'omni-v2v' || id === 'omni-v2v-no-water') {
    return {
      duration: null, resolution: null, generateAudio: false,
      maximumReferenceImages: 2, maximumReferenceVideos: 1, maximumReferenceAudios: 0,
      supportsFrameUrls: false, maximumPromptCharacters: 5000,
    }
  }
  return null
}

export function isCanonicalCangyuanVideoModel(model: string) {
  return canonicalVideoProfile(model) !== null
}

function apiRoot(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function videoFormat(size = '1280x720', model = '') {
  const [width, height] = size.split('x').map(Number)
  const aspectRatio = width > height ? '16:9' : width < height ? '9:16' : '1:1'
  const modelResolution = model.match(/(?:-|^)(480p|720p|1080p|4k)(?:-|$)/i)?.[1]
  const shortEdge = Math.min(width || 0, height || 0)
  const resolution = modelResolution?.toLowerCase()
    || (shortEdge > 0 && shortEdge <= 540 ? '480p' : shortEdge >= 1000 ? '1080p' : '720p')
  return { aspectRatio, resolution }
}

function inferMode(model: string): VideoApiMode | null {
  if (isCanonicalCangyuanVideoModel(model)) return 'openai'
  if (/^sora-2(?:-pro)?(?:-|$)/i.test(model)) return 'openai'
  if (/^(?:sd[5-7]-)?seedance-2\.(?:0|5)(?:-|$)/i.test(model)) return 'openai'
  if (isHappyHouseVideoModel(model)) return 'openai'
  if (/^(?:cy-gv1-)?grok-video(?:-|$)/i.test(model)) return 'newapi-grok'
  if (/^grok-imagine-video(?:-|$)/i.test(model)) return 'sub2api-grok'
  return null
}

export function selectVideoCapability(
  modelIds: string[],
  preferredModel = '',
  preferredMode: 'auto' | VideoApiMode = 'auto',
): VideoCapability | null {
  if (preferredModel) {
    const inferred = preferredMode === 'auto' ? inferMode(preferredModel) : preferredMode
    if (!inferred || !modelIds.includes(preferredModel)) return null
    return { mode: inferred, model: preferredModel }
  }

  const ordered = [
    'sd7-seedance-2.0-1080p',
    'sd7-seedance-2.0-720p',
    'sd8-seedance-2.0',
    'seedance-2.0',
    'minimax-h3-2k',
    'omni-fast-no-water',
    'omni-fast',
    'omni-v2v-no-water',
    'omni-v2v',
    'happyhouse-1.1',
    'happyhouse-1.0',
    'grok-video-1.5',
    'grok-video',
    'seedance-2.5-720p',
    'seedance-2.5-480p',
    'sd6-seedance-2.0-1080p',
    'sd6-seedance-2.0-720p',
    'sd5-seedance-2.0-fast',
    'sd5-seedance-2.0',
    'seedance-2.0-fast-720p',
    'seedance-2.0-720p',
    'seedance-2.0-fast',
    'sora-2-pro',
    'sora-2',
    'grok-imagine-video-1.5-preview',
    'grok-imagine-video-1.5',
    'grok-imagine-video',
  ]
  for (const model of ordered) {
    if (!modelIds.includes(model)) continue
    const mode = inferMode(model)
    if (mode && (preferredMode === 'auto' || preferredMode === mode)) {
      return { mode, model }
    }
  }
  return null
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`VIDEO_API_INVALID_RESPONSE: HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  if (!response.ok) {
    const error = parsed.error
    const message = typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : JSON.stringify(parsed)
    throw new Error(`VIDEO_API_ERROR: HTTP ${response.status}: ${message}`)
  }
  return parsed
}

export function isUnrecoverableVideoGenerationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/VIDEO_TASK_CANCELLED/iu.test(message)) return true
  if (/upstream (?:is )?overloaded|system under load|submission timed out|please retry later/iu.test(message)) {
    return false
  }
  if (/sensitive_words_detected|content moderation|prompt or reference material was rejected/iu.test(message)) {
    return false
  }
  if (/field ['"]generate['"] not found in type|upstream adapter unavailable/iu.test(message)) {
    return false
  }
  const unspecifiedProviderFailure = /VIDEO_TASK_FAILED:[\s\S]*(?:Video generation failed without a specific reason|no failure detail|视频生成失败[，,：:\s]*上游未提供具体原因|上游未提供具体原因)/iu.test(message)
  return /VIDEO_API_ERROR:\s*HTTP\s*(400|401|402|403|404|405|422)\b/i.test(message)
    || (/VIDEO_TASK_FAILED:/i.test(message) && !unspecifiedProviderFailure)
    || /VIDEO_(?:MODEL_UNAVAILABLE|REFERENCE_REQUIRED|PROMPT_REQUIRED|PROMPT_TOO_LONG|DURATION_NOT_SUPPORTED|RESOLUTION_NOT_SUPPORTED|ASPECT_RATIO_NOT_SUPPORTED)/i.test(message)
}

export function shouldResetVideoProviderJobOnRetry(message: string) {
  return /VIDEO_TASK_(?:FAILED|TIMEOUT)\b/i.test(message)
}

export async function listVideoProviderModels(
  config: VideoApiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(`${apiRoot(config.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  const payload = await readResponse(response)
  const data = Array.isArray(payload.data) ? payload.data : []
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('id' in item)) return []
    const id = String((item as { id?: unknown }).id || '').trim()
    return id ? [id] : []
  })
}

export async function detectVideoCapability(
  config: VideoApiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<VideoCapability | null> {
  const models = await listVideoProviderModels(config, fetchImpl)
  return selectVideoCapability(models, config.model, config.mode || 'auto')
}

function videoJobFromPayload(payload: Record<string, unknown>, fallbackId = ''): VideoJob {
  const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload
  const id = String(nested.id || nested.task_id || nested.request_id || fallbackId).trim()
  if (!id) throw new Error('VIDEO_API_INVALID_RESPONSE: missing video job id')
  const sourceStatus = String(nested.status || nested.state || 'queued').toLowerCase()
  const status = ['success', 'succeeded', 'finished', 'done'].includes(sourceStatus)
    ? 'completed'
    : ['failure', 'error', 'cancelled', 'canceled'].includes(sourceStatus)
      ? 'failed'
      : ['processing', 'running'].includes(sourceStatus)
        ? 'in_progress'
        : ['pending', 'submitted', 'starting'].includes(sourceStatus) ? 'queued' : sourceStatus
  const rawProgress = nested.progress
  const parsedProgress = typeof rawProgress === 'string'
    ? Number.parseFloat(rawProgress.replace('%', ''))
    : rawProgress
  return {
    id,
    status,
    progress: typeof parsedProgress === 'number' && Number.isFinite(parsedProgress)
      ? parsedProgress
      : undefined,
    raw: nested,
  }
}

export function extractVideoUrl(payload: Record<string, unknown>): string | null {
  const direct = [payload.url, payload.video_url, payload.output_url, payload.result_url]
  for (const value of direct) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  const output = payload.output
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const url = (output as Record<string, unknown>).url
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  }
  const video = payload.video
  if (video && typeof video === 'object' && !Array.isArray(video)) {
    const url = (video as Record<string, unknown>).url
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  }
  const metadata = payload.metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const url = (metadata as Record<string, unknown>).video_url
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  }
  const data = payload.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const dataRecord = data as Record<string, unknown>
    const dataUrl = dataRecord.url || dataRecord.result_url
    if (typeof dataUrl === 'string' && /^https?:\/\//i.test(dataUrl)) return dataUrl
    const dataVideo = dataRecord.video
    if (dataVideo && typeof dataVideo === 'object' && !Array.isArray(dataVideo)) {
      const url = (dataVideo as Record<string, unknown>).url
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const url = (item as Record<string, unknown>).url
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    }
  }
  const results = payload.results
  if (Array.isArray(results)) {
    const url = results.find((value) => typeof value === 'string')
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  }
  return null
}

export type VideoGenerationInput = {
  prompt: string
  seconds?: number
  size?: string
  aspectRatio?: VideoGenerationAspectRatio
  resolution?: VideoGenerationResolution
  referenceImageUrls?: string[]
  maximumReferenceImages?: number
  referenceVideoUrls?: string[]
  maximumReferenceVideos?: number
  referenceAudioUrls?: string[]
  maximumReferenceAudios?: number
  firstImageUrl?: string
  lastImageUrl?: string
  generateAudio?: boolean
}

function canonicalReferenceLimit(requested: number | undefined, maximum: number) {
  if (requested == null) return maximum
  return Math.min(maximum, Math.max(0, Math.floor(requested)))
}

function canonicalHttpsUrls(
  values: string[] | undefined,
  requestedMaximum: number | undefined,
  providerMaximum: number,
  field: string,
) {
  const selected = (values || []).slice(0, canonicalReferenceLimit(requestedMaximum, providerMaximum))
  for (const value of selected) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`VIDEO_REFERENCE_URL_INVALID: ${field} must contain valid HTTPS URLs`)
    }
    if (url.protocol !== 'https:') {
      throw new Error(`VIDEO_REFERENCE_URL_INVALID: ${field} must contain HTTPS URLs`)
    }
  }
  return selected
}

function canonicalHttpsUrl(value: string | undefined, field: string) {
  if (!value) return null
  return canonicalHttpsUrls([value], 1, 1, field)[0] || null
}

export function buildCanonicalCangyuanVideoRequest(
  model: string,
  input: VideoGenerationInput,
  preparedPrompt = prepareVideoPromptForProvider(input.prompt).prompt,
) {
  const profile = canonicalVideoProfile(model)
  if (!profile) return null
  if (!preparedPrompt) throw new Error('VIDEO_PROMPT_REQUIRED: 视频提示词不能为空')
  if (preparedPrompt.length > profile.maximumPromptCharacters) {
    throw new Error(
      `VIDEO_PROMPT_TOO_LONG: ${model} prompt is ${preparedPrompt.length} characters; maximum is ${profile.maximumPromptCharacters}`,
    )
  }

  let imageUrls = canonicalHttpsUrls(
    input.referenceImageUrls,
    input.maximumReferenceImages,
    profile.maximumReferenceImages,
    'reference_image_urls',
  )
  const videoUrls = canonicalHttpsUrls(
    input.referenceVideoUrls,
    input.maximumReferenceVideos,
    profile.maximumReferenceVideos,
    'reference_videos',
  )
  const audioUrls = canonicalHttpsUrls(
    input.referenceAudioUrls,
    input.maximumReferenceAudios,
    profile.maximumReferenceAudios,
    'reference_audios',
  )
  if (model.toLowerCase() === 'happyhouse-1.0' && videoUrls.length > 0) {
    imageUrls = imageUrls.slice(0, 5)
  }

  const firstImageUrl = profile.supportsFrameUrls
    ? canonicalHttpsUrl(input.firstImageUrl, 'first_image_url')
    : null
  const lastImageUrl = profile.supportsFrameUrls
    ? canonicalHttpsUrl(input.lastImageUrl, 'last_image_url')
    : null
  if (model.toLowerCase() === 'minimax-h3-2k' && Boolean(firstImageUrl) !== Boolean(lastImageUrl)) {
    throw new Error('VIDEO_REFERENCE_REQUIRED: MiniMax first_image_url and last_image_url must be provided together')
  }
  const frameMode = Boolean(firstImageUrl && lastImageUrl)
  if (frameMode && model.toLowerCase() === 'minimax-h3-2k') {
    imageUrls = []
  }

  const inferred = videoFormat(input.size, model)
  const body: Record<string, unknown> = {
    model,
    prompt: preparedPrompt,
    aspect_ratio: input.aspectRatio || inferred.aspectRatio,
  }
  if (profile.duration) {
    const maximum = (model === 'grok-video' || model === 'grok-video-1.5') && imageUrls.length > 1
      ? Math.min(10, profile.duration.maximum)
      : profile.duration.maximum
    const options = profile.duration.options?.filter((value) => value <= maximum)
    body.duration = normalizeVideoDuration(
      input.seconds || profile.duration.defaultValue,
      profile.duration.minimum,
      maximum,
      options,
    )
  }
  if (profile.resolution === '2k') {
    body.resolution = '2k'
  } else if (profile.resolution === 'input') {
    const id = model.toLowerCase()
    const allowed: VideoGenerationResolution[] = id.startsWith('happyhouse-')
      ? ['720p', '1080p']
      : id === 'grok-video-1.5' ? ['480p', '720p', '1080p'] : ['480p', '720p']
    const requested = input.resolution || inferred.resolution as VideoGenerationResolution
    body.resolution = allowed.includes(requested) ? requested : allowed.includes('720p') ? '720p' : allowed[0]
  }
  if (profile.generateAudio) {
    body.generate_audio = frameMode ? false : input.generateAudio ?? true
  }
  if (imageUrls.length > 0) body.reference_image_urls = imageUrls
  if (videoUrls.length > 0) body.reference_videos = videoUrls
  if (audioUrls.length > 0 && !frameMode) body.reference_audios = audioUrls
  if (firstImageUrl) body.first_image_url = firstImageUrl
  if (lastImageUrl) body.last_image_url = lastImageUrl

  if ((model === 'omni-v2v' || model === 'omni-v2v-no-water') && videoUrls.length === 0) {
    throw new Error(`VIDEO_REFERENCE_REQUIRED: ${model} requires reference_videos`)
  }
  return body
}

export async function submitVideoGeneration(
  config: VideoApiConfig,
  capability: VideoCapability,
  input: VideoGenerationInput,
  fetchImpl: typeof fetch = fetch,
): Promise<VideoJob> {
  const root = apiRoot(config.baseUrl)
  const prompt = prepareVideoPromptForProvider(input.prompt).prompt
  const maximumReferenceImages = Math.max(0, Math.floor(input.maximumReferenceImages ?? 0))
  const references = (fallback: number) => (
    input.referenceImageUrls || []
  ).slice(0, maximumReferenceImages || fallback)
  const maximumReferenceVideos = Math.max(0, Math.floor(input.maximumReferenceVideos ?? 0))
  const referenceVideos = (fallback: number) => (
    input.referenceVideoUrls || []
  ).slice(0, maximumReferenceVideos || fallback)
  let response: Response
  const canonicalBody = buildCanonicalCangyuanVideoRequest(capability.model, input, prompt)
  if (canonicalBody) {
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(canonicalBody),
    })
  } else if (capability.mode === 'newapi-grok') {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const referenceUrls = references(7)
    const seconds = normalizeVideoDuration(input.seconds || 6, 6, 15, [6, 10, 15])
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        seconds,
        aspect_ratio: aspectRatio,
        resolution,
        ...(referenceUrls.length > 0 ? { image_urls: referenceUrls } : {}),
      }),
    })
  } else if (isHappyHouseVideoModel(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const referenceUrls = references(9)
    if (prompt.length > 5000) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: HappyHouse prompt is ${prompt.length} characters; maximum is 5000`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: normalizeVideoDuration(input.seconds || 4, 3, 15),
        aspect_ratio: aspectRatio,
        resolution,
        audio: input.generateAudio ?? true,
        ...(referenceUrls.length > 0 ? { reference_image_urls: referenceUrls } : {}),
      }),
    })
  } else if (isSoraVideoModel(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const referenceUrls = references(1)
    if (prompt.length > 1200) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: Sora 2 prompt is ${prompt.length} characters; maximum is 1200`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: normalizeVideoDuration(input.seconds || 12, 4, 12, [4, 8, 12]),
        aspect_ratio: aspectRatio,
        generate_audio: input.generateAudio ?? true,
        ...(referenceUrls.length > 0 ? {
          reference_mode: 'frame',
          images: referenceUrls,
        } : {}),
      }),
    })
  } else if (isSeedance25Model(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const referenceUrls = references(30)
    const maximumDuration = capability.model.toLowerCase() === 'seedance-2.5-480p' ? 30 : 29
    if (prompt.length > 5000) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: Seedance 2.5 prompt is ${prompt.length} characters; maximum is 5000`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: normalizeVideoDuration(input.seconds || 8, 4, maximumDuration),
        aspect_ratio: aspectRatio,
        generate_audio: input.generateAudio ?? true,
        ...(referenceUrls.length > 0 ? { reference_image_urls: referenceUrls } : {}),
      }),
    })
  } else if (isSd6SeedanceModel(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const referenceUrls = references(9)
    const referenceVideoUrls = referenceVideos(3)
    const durations = [4, 5, 6, 8, 10, 12, 15]
    if (prompt.length > 5000) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: ${capability.model} prompt is ${prompt.length} characters; maximum is 5000`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: normalizeVideoDuration(input.seconds || 8, 4, 15, durations),
        aspect_ratio: aspectRatio,
        ...(referenceUrls.length > 0 ? { reference_image_urls: referenceUrls } : {}),
        ...(referenceVideoUrls.length > 0 ? { reference_videos: referenceVideoUrls } : {}),
      }),
    })
  } else if (isDirectSeedanceModel(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const referenceUrls = references(9)
    if (prompt.length > 1200) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: Seedance 2.0 Fast prompt is ${prompt.length} characters; maximum is 1200`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: input.seconds || 4,
        aspect_ratio: aspectRatio,
        generate_audio: input.generateAudio ?? true,
        resolution,
        ...(referenceUrls.length > 0 ? {
          reference_mode: 'media',
          reference_image_urls: referenceUrls,
        } : {}),
      }),
    })
  } else if (/^seedance-2\.0(?:-|$)/i.test(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const referenceUrls = references(4)
    if (prompt.length > 5000) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: Seedance 2.0 prompt is ${prompt.length} characters; maximum is 5000`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: input.seconds || 8,
        aspect_ratio: aspectRatio,
        resolution,
        audio: input.generateAudio ?? true,
        ...(referenceUrls.length > 0 ? {
          reference_mode: 'media',
          reference_image_urls: referenceUrls,
        } : {}),
      }),
    })
  } else if (capability.mode === 'openai') {
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: input.seconds || 8,
      }),
    })
  } else {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    response = await fetchImpl(`${root}/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt,
        duration: input.seconds || 8,
        aspect_ratio: aspectRatio,
        resolution,
      }),
    })
  }
  return videoJobFromPayload(await readResponse(response))
}

export async function retrieveVideoJob(
  config: VideoApiConfig,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VideoJob> {
  const response = await fetchImpl(`${apiRoot(config.baseUrl)}/videos/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  })
  return videoJobFromPayload(await readResponse(response), jobId)
}

export async function downloadOpenAIVideo(
  config: VideoApiConfig,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(
    `${apiRoot(config.baseUrl)}/videos/${encodeURIComponent(jobId)}/content`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } },
  )
  if (!response.ok) {
    throw new Error(`VIDEO_DOWNLOAD_FAILED: HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

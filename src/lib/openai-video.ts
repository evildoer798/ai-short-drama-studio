export type VideoApiMode = 'openai' | 'sub2api-grok' | 'newapi-grok'
export type VideoGenerationResolution = '480p' | '720p'
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
  if (/^sora-2(?:-pro)?(?:-|$)/i.test(model)) return 'openai'
  if (/^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(model)) return 'openai'
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
    'seedance-2.0-fast-720p',
    'seedance-2.0-720p',
    'seedance-2.0-fast',
    'seedance-2.0',
    'sora-2-pro',
    'sora-2',
    'grok-video',
    'grok-video-1.5',
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
        : sourceStatus
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

export async function submitVideoGeneration(
  config: VideoApiConfig,
  capability: VideoCapability,
  input: {
    prompt: string
    seconds?: number
    size?: string
    aspectRatio?: VideoGenerationAspectRatio
    resolution?: VideoGenerationResolution
    referenceImageUrls?: string[]
    generateAudio?: boolean
  },
  fetchImpl: typeof fetch = fetch,
): Promise<VideoJob> {
  const root = apiRoot(config.baseUrl)
  let response: Response
  if (capability.mode === 'newapi-grok') {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const references = (input.referenceImageUrls || []).slice(0, 7)
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt: input.prompt,
        seconds: input.seconds || 8,
        aspect_ratio: aspectRatio,
        resolution,
        ...(references.length > 0 ? { image_urls: references } : {}),
      }),
    })
  } else if (/^(?:sd5-)?seedance-2\.0(?:-|$)/i.test(capability.model)) {
    const inferred = videoFormat(input.size, capability.model)
    const aspectRatio = input.aspectRatio || inferred.aspectRatio
    const resolution = input.resolution || inferred.resolution
    const references = (input.referenceImageUrls || []).slice(0, 4)
    if (input.prompt.length > 5000) {
      throw new Error(`VIDEO_PROMPT_TOO_LONG: Seedance 2.0 prompt is ${input.prompt.length} characters; maximum is 5000`)
    }
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: capability.model,
        prompt: input.prompt,
        duration: input.seconds || 8,
        aspect_ratio: aspectRatio,
        resolution,
        audio: input.generateAudio ?? true,
        ...(references[0] ? { image_url: references[0] } : {}),
        ...(references.length > 1 ? { reference_image_urls: references.slice(1) } : {}),
      }),
    })
  } else if (capability.mode === 'openai') {
    const form = new FormData()
    form.set('model', capability.model)
    form.set('prompt', input.prompt)
    form.set('seconds', String(input.seconds || 8))
    form.set('size', input.size || '1280x720')
    response = await fetchImpl(`${root}/videos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
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
        prompt: input.prompt,
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

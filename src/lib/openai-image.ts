export type ImageOutput = {
  source: 'url' | 'base64'
  value: string
  mimeType: string
}

export type ImageRetryInfo = {
  attempt: number
  maxAttempts: number
  delayMs: number
  status: number | null
  message: string
}

export type ImageProviderTask = {
  taskId: string
  pollUrl: string
}

export type ImageProviderTaskUpdate = ImageProviderTask & {
  status: 'submitted' | 'completed' | 'failed'
  error?: string
}

type ImageApiMode = 'images' | 'responses' | 'auto'
type ImageOutputFormat = 'png' | 'jpeg' | 'webp'

type OpenAICompatImageItem = {
  url?: unknown
  b64_json?: unknown
}

const RESPONSES_IMAGE_PROMPT_PREFIX = [
  'You are an image generation adapter.',
  'Generate exactly one image for the user prompt.',
  'Use the image_generation tool result as the final output.',
  'Do not return an explanation.',
].join(' ')

const RESPONSES_IMAGE_POLL_INTERVAL_MS = 3000
const RESPONSES_IMAGE_POLL_TIMEOUT_MS = 600000
const IMAGE_TASK_POLL_INTERVAL_MS = 3000
const IMAGE_TASK_POLL_TIMEOUT_MS = 30 * 60_000
const DEFAULT_IMAGE_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 90_000, 180_000, 300_000, 300_000]

export type ImageGenerationInput = {
  prompt: string
  model: string
  baseUrl: string
  apiKey: string
  mode?: string
  quality?: string
  size?: string
  outputFormat?: string
  outputCompression?: number
  partialImages?: number
  stream?: boolean
  useAsync?: boolean
  retryDelaysMs?: number[]
  providerTimeoutRetries?: number
  resumeProviderTask?: ImageProviderTask
  onRetry?: (info: ImageRetryInfo) => void | Promise<void>
  onProviderTaskUpdate?: (info: ImageProviderTaskUpdate) => void | Promise<void>
  referenceImages?: Array<{ dataUrl: string }>
}

class ImageApiHttpError extends Error {
  status: number
  retryAfterMs: number | null

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(`IMAGE_API_FAILED: ${status} ${message}`)
    this.name = 'ImageApiHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function normalizeMimeType(value: unknown) {
  if (typeof value === 'string' && value.startsWith('image/')) return value
  return 'image/png'
}

function parseDataUrl(value: string): { base64: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  if (!match) return null
  return {
    mimeType: normalizeMimeType(match[1]),
    base64: match[2],
  }
}

const IMAGE_CONTENT_POLICY_PATTERN = /IMAGE_CONTENT_POLICY|content\s*(?:policy|moderation)|safety\s*policy|sensitive|refus(?:ed|al)|not\s+allowed|cannot\s+be\s+used\s+to\s+generate|无法用于生成图像|安全政策|内容政策|内容规则|不适合进行图像生成|被拦截|敏感词|违规/iu

function parseRemoteImageUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function parseImageOutputValue(value: string, fallbackMimeType: string): ImageOutput | null {
  const dataUrl = parseDataUrl(value)
  if (dataUrl) {
    return { source: 'base64', value: dataUrl.base64, mimeType: dataUrl.mimeType }
  }
  const remoteUrl = parseRemoteImageUrl(value)
  return remoteUrl
    ? { source: 'url', value: remoteUrl, mimeType: fallbackMimeType }
    : null
}

function findImageContentPolicyMessage(payload: unknown): string {
  const stack: unknown[] = [payload]
  while (stack.length > 0) {
    const current = stack.pop()
    if (typeof current === 'string') {
      const value = current.trim()
      if (value.length <= 2_000 && IMAGE_CONTENT_POLICY_PATTERN.test(value)) return value.slice(0, 500)
      continue
    }
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    for (const value of Object.values(current)) stack.push(value)
  }
  return ''
}

export function isImageContentPolicyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return IMAGE_CONTENT_POLICY_PATTERN.test(message)
}

export function isUnrecoverableImageGenerationError(error: unknown) {
  if (isImageContentPolicyError(error)) return true
  const status = imageErrorStatus(error)
  return status !== null
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 409
    && status !== 429
}

export function shouldDiscardImageProviderCheckpoint(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return isImageContentPolicyError(error)
    || /IMAGE_ASYNC_(?:FAILED|EMPTY_RESPONSE)|RESPONSES_IMAGE_(?:API_FAILED_STATUS|DATA_URL_INVALID)/iu.test(message)
}

export function extractImageOutputs(response: unknown): ImageOutput[] {
  return extractImageOutputsWithMimeType(response, 'image/png')
}

function extractImageOutputsWithMimeType(response: unknown, fallbackMimeType: string): ImageOutput[] {
  if (!response || typeof response !== 'object') return []
  const data = (response as { data?: unknown }).data
  if (!Array.isArray(data)) return []

  const outputs: ImageOutput[] = []
  for (const item of data as OpenAICompatImageItem[]) {
    if (!item || typeof item !== 'object') continue

    if (typeof item.url === 'string' && item.url.trim()) {
      const value = item.url.trim()
      const output = parseImageOutputValue(value, fallbackMimeType)
      if (output) outputs.push(output)
    }

    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      outputs.push({
        source: 'base64',
        value: item.b64_json.trim(),
        mimeType: fallbackMimeType,
      })
    }
  }

  return outputs
}

function normalizeOutputFormat(value: unknown): ImageOutputFormat {
  if (value === 'jpeg' || value === 'webp') return value
  return 'png'
}

function outputFormatMimeType(format: ImageOutputFormat) {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

export function buildImagesGenerationRequestBody(input: {
  prompt: string
  model: string
  quality?: string
  size?: string
  outputFormat?: string
  outputCompression?: number
  partialImages?: number
  stream?: boolean
}, includeLatencyOptions = true, asyncMode = false) {
  const outputFormat = normalizeOutputFormat(input.outputFormat)
  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    n: 1,
  }

  if (includeLatencyOptions) {
    body.quality = input.quality || 'low'
    body.size = input.size || '1024x1024'
    body.output_format = outputFormat
    if (outputFormat === 'jpeg' || outputFormat === 'webp') {
      body.output_compression = input.outputCompression ?? 75
    }
  }

  if (asyncMode) {
    body.async = true
  } else if (input.stream) {
    body.stream = true
    body.response_format = 'b64_json'
    body.partial_images = Math.min(3, Math.max(1, Math.round(input.partialImages || 1)))
  }

  return body
}

type ImageSSEState = {
  latest: ImageOutput | null
  error: string
}

function inferBase64MimeType(base64: string, fallbackMimeType: string) {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return fallbackMimeType
}

function readOutputFormatMimeType(payload: unknown, fallbackMimeType: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallbackMimeType
  const format = (payload as { output_format?: unknown }).output_format
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'png') return 'image/png'
  return fallbackMimeType
}

function findImageBase64(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const stack: unknown[] = [payload]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const dataUrl = parseDataUrl(value)
        if (dataUrl) return dataUrl.base64
        if (key === 'b64_json' || key === 'partial_image_b64' || key === 'result') {
          if (value.trim()) return value.trim()
        }
        continue
      }
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return ''
}

function readSSEError(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as { type?: unknown; error?: unknown; message?: unknown }
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : ''
  if (type !== 'error' && !type.endsWith('.failed')) return ''
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const message = (record.error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  return type || 'image stream failed'
}

function consumeImageSSEBlock(block: string, state: ImageSSEState, fallbackMimeType: string) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()

  if (!data || data === '[DONE]') return
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }

  const error = readSSEError(payload)
  if (error) {
    state.error = error
    return
  }

  const base64 = findImageBase64(payload)
  if (!base64) return
  const configuredMimeType = readOutputFormatMimeType(payload, fallbackMimeType)
  state.latest = {
    source: 'base64',
    value: base64,
    mimeType: inferBase64MimeType(base64, configuredMimeType),
  }
}

export function extractImageOutputFromSSEText(sse: string, fallbackMimeType = 'image/png') {
  const state: ImageSSEState = { latest: null, error: '' }
  for (const block of sse.split(/\r?\n\r?\n/)) {
    consumeImageSSEBlock(block, state, fallbackMimeType)
  }
  if (state.error) throw new Error(`IMAGE_STREAM_FAILED: ${state.error}`)
  return state.latest
}

async function readImageSSEStream(response: Response, fallbackMimeType: string) {
  if (!response.body) throw new Error('IMAGE_STREAM_EMPTY_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const state: ImageSSEState = { latest: null, error: '' }
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (!boundary || boundary.index === undefined) break
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      consumeImageSSEBlock(block, state, fallbackMimeType)
      if (state.error) {
        await reader.cancel()
        throw new Error(`IMAGE_STREAM_FAILED: ${state.error}`)
      }
    }

    if (done) break
  }

  if (buffer.trim()) consumeImageSSEBlock(buffer, state, fallbackMimeType)
  if (state.error) throw new Error(`IMAGE_STREAM_FAILED: ${state.error}`)
  if (!state.latest) throw new Error('IMAGE_STREAM_EMPTY_RESPONSE')
  return state.latest
}

export function resolveOpenAICompatImageEndpoint(baseUrl: string) {
  return `${resolveOpenAICompatApiBase(baseUrl)}/images/generations`
}

export function resolveOpenAICompatAsyncImageEndpoint(baseUrl: string) {
  return `${resolveOpenAICompatImageEndpoint(baseUrl)}/async`
}

export function resolveOpenAICompatImageTaskEndpoint(baseUrl: string, taskId: string) {
  return `${resolveOpenAICompatApiBase(baseUrl)}/images/tasks/${encodeURIComponent(taskId)}`
}

export function resolveOpenAICompatResponsesEndpoint(baseUrl: string) {
  return `${resolveOpenAICompatApiBase(baseUrl)}/responses`
}

function resolveOpenAICompatApiBase(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summarizeErrorPayload(payload: unknown, rawText: string) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as { error?: unknown }).error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 800)
    }
  }

  return rawText
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
}

function findImageDataUrl(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const stack: unknown[] = [payload]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        if (value.startsWith('data:image/')) return value
        if ((key === 'b64_json' || key === 'result') && value.length > 100) {
          return `data:image/png;base64,${value}`
        }
        continue
      }
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return ''
}

function readResponseId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as { id?: unknown; task_id?: unknown; data?: unknown; task?: unknown }
  const id = typeof record.task_id === 'string' ? record.task_id : record.id
  if (typeof id === 'string' && id.trim()) return id.trim()
  return readResponseId(record.data) || readResponseId(record.task)
}

function readResponseStatus(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const status = (payload as { status?: unknown }).status
  return typeof status === 'string' ? status.trim().toLowerCase() : ''
}

function isDoneStatus(status: string) {
  return status === 'completed' || status === 'succeeded'
}

function isFailedStatus(status: string) {
  return status === 'failed'
    || status === 'error'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'incomplete'
}

function extractImageOutputsFromTaskPayload(payload: unknown, fallbackMimeType: string) {
  const refusal = findImageContentPolicyMessage(payload)
  if (refusal) throw new Error(`IMAGE_CONTENT_POLICY: ${refusal}`)

  const direct = extractImageOutputsWithMimeType(payload, fallbackMimeType)
  if (direct.length > 0) return direct
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []

  const record = payload as { result?: unknown; output?: unknown; image_url?: unknown }
  for (const nested of [record.result, record.output]) {
    const outputs = extractImageOutputsWithMimeType(nested, fallbackMimeType)
    if (outputs.length > 0) return outputs
  }

  if (typeof record.image_url === 'string' && record.image_url.trim()) {
    const value = record.image_url.trim()
    const output = parseImageOutputValue(value, fallbackMimeType)
    return output ? [output] : []
  }

  return []
}

function readRetryAfterMs(response: Response) {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function imageErrorStatus(error: unknown) {
  if (error instanceof ImageApiHttpError) return error.status
  const message = error instanceof Error ? error.message : String(error)
  const match = /(?:IMAGE_(?:ASYNC_)?(?:API|POLL)|RESPONSES_IMAGE_(?:API|POLL))_FAILED:\s*(\d{3})/i.exec(message)
  return match ? Number(match[1]) : null
}

function isRetryableImageError(error: unknown) {
  const status = imageErrorStatus(error)
  if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500
  if (isProviderTerminalTimeoutError(error)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(message)
}

function isProviderTerminalTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /IMAGE_ASYNC_FAILED:[\s\S]*(?:TIMEOUT|TIMED[_ -]?OUT|超时)/i.test(message)
}

function retryStatusMessage(status: number | null, error: unknown) {
  if (isProviderTerminalTimeoutError(error)) return '图片服务商本次排队超时，正在自动重新排队'
  if (status === 429) return '生图通道当前繁忙，正在排队自动重试'
  if (status === 524 || status === 504) return '生图服务响应较慢，正在自动重连'
  if (status !== null && status >= 500) return '生图服务暂时波动，正在自动重试'
  return '网络暂时不稳定，正在自动重试'
}

export function readableImageGenerationError(error: unknown) {
  const status = imageErrorStatus(error)
  if (status === 429) return '生图通道持续繁忙，系统已自动重试多次。请稍后再点一次生成。'
  if (status === 524 || status === 504) return '生图服务等待超时，系统已自动重连但仍未取得结果。请稍后重试。'
  if (status === 401 || status === 403) return '生图 API 密钥无效或没有当前模型权限，请检查服务商配置。'
  if (status !== null && status >= 500) return '生图服务暂时不可用，系统已自动重试。请稍后再试。'

  const message = error instanceof Error ? error.message : String(error)
  if (/IMAGE_MODEL_UNAVAILABLE/iu.test(message)) {
    return '当前生图模型名称已失效或没有权限，系统未找到可用的主通道或备用通道。'
  }
  if (isImageContentPolicyError(error)) {
    return '生图请求被内容规则拒绝，请调整提示词后重试。'
  }
  if (/IMAGE_API_EMPTY_RESPONSE|IMAGE_STREAM_EMPTY_RESPONSE|IMAGE_ASYNC_EMPTY_RESPONSE/i.test(message)) {
    return '生图服务完成了请求，但没有返回可保存的图片。请重新生成。'
  }
  if (isProviderTerminalTimeoutError(error)) {
    return '图片服务商连续多次排队超时，系统已自动重新排队。请稍后再点一次生成。'
  }
  return message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || '生图失败，请稍后重试。'
}

function dataUrlToImageOutput(dataUrl: string): ImageOutput {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) throw new Error('RESPONSES_IMAGE_DATA_URL_INVALID')
  return {
    source: 'base64',
    value: parsed.base64,
    mimeType: parsed.mimeType,
  }
}

function normalizeImageApiMode(mode: unknown): ImageApiMode {
  if (mode === 'images' || mode === 'responses' || mode === 'auto') return mode
  return 'responses'
}

async function parseJsonResponse(response: Response) {
  const rawText = await response.text()
  let payload: unknown = null
  try {
    payload = JSON.parse(rawText)
  } catch {
    payload = null
  }
  return { rawText, payload }
}

export async function generateImageViaOpenAICompat(input: ImageGenerationInput) {
  if (input.referenceImages?.length) return generateImageViaResponses(input)
  const mode = normalizeImageApiMode(input.mode)
  if (mode === 'responses') return generateImageViaResponses(input)

  try {
    return await generateImageViaImagesEndpoint(input)
  } catch (error) {
    if (mode === 'auto') return generateImageViaResponses(input)
    throw error
  }
}

const unsupportedAsyncImageEndpoints = new Set<string>()
const timedOutSynchronousImageEndpoints = new Set<string>()

function usesBodyAsyncImageProtocol(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.endsWith('cangyuansuanli.cn')
  } catch {
    return false
  }
}

async function generateImageViaImagesEndpoint(input: ImageGenerationInput) {
  const retryDelays = input.retryDelaysMs || DEFAULT_IMAGE_RETRY_DELAYS_MS
  const maxAttempts = retryDelays.length + 1
  const endpoint = resolveOpenAICompatImageEndpoint(input.baseUrl)
  const providerTimeoutRetryLimit = Math.max(0, Math.min(5, Math.round(input.providerTimeoutRetries ?? 2)))
  let providerTimeoutFailures = 0
  let resumeProviderTask = input.resumeProviderTask

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (resumeProviderTask) {
        const task = resumeProviderTask
        resumeProviderTask = undefined
        return await pollImageTask(
          input,
          task.pollUrl,
          outputFormatMimeType(normalizeOutputFormat(input.outputFormat)),
          task.taskId,
        )
      }
      if (timedOutSynchronousImageEndpoints.has(endpoint)) {
        return await generateImageViaResponses(input)
      }
      if (input.useAsync !== false) {
        const asyncOutput = usesBodyAsyncImageProtocol(input.baseUrl)
          ? await tryGenerateImageViaBodyAsyncEndpoint(input)
          : await tryGenerateImageViaAsyncEndpoint(input)
        if (asyncOutput) return asyncOutput
      }
      return await generateImageViaImagesEndpointOnce(input)
    } catch (error) {
      const status = imageErrorStatus(error)
      if ((status === 504 || status === 524) && !usesBodyAsyncImageProtocol(input.baseUrl)) {
        timedOutSynchronousImageEndpoints.add(endpoint)
      }
      const providerTimedOut = isProviderTerminalTimeoutError(error)
      if (providerTimedOut) {
        providerTimeoutFailures += 1
        if (providerTimeoutFailures > providerTimeoutRetryLimit) throw error
      }
      if (attempt >= maxAttempts || !isRetryableImageError(error)) throw error

      const configuredDelay = retryDelays[attempt - 1] ?? retryDelays.at(-1) ?? 15_000
      const retryAfter = error instanceof ImageApiHttpError ? error.retryAfterMs : null
      const switchingToBackground = status === 504 || status === 524
      const delayMs = switchingToBackground
        ? Math.min(configuredDelay, 5_000)
        : Math.min(Math.max(configuredDelay, retryAfter || 0), 5 * 60_000)
      try {
        await input.onRetry?.({
          attempt: providerTimedOut ? providerTimeoutFailures + 1 : attempt + 1,
          maxAttempts: providerTimedOut ? providerTimeoutRetryLimit + 1 : maxAttempts,
          delayMs,
          status,
          message: retryStatusMessage(status, error),
        })
      } catch {
        // A progress update must never cancel a generation retry.
      }
      await sleep(delayMs)
    }
  }

  throw new Error('IMAGE_API_RETRY_EXHAUSTED')
}

async function tryGenerateImageViaBodyAsyncEndpoint(input: ImageGenerationInput): Promise<ImageOutput | null> {
  const endpoint = resolveOpenAICompatImageEndpoint(input.baseUrl)
  const request = (includeLatencyOptions: boolean) => fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildImagesGenerationRequestBody({ ...input, stream: false }, includeLatencyOptions, true)),
  })

  let response = await request(true)
  let parsed = await parseJsonResponse(response)
  if (response.status === 400 && /(?:unknown|unsupported|unrecognized).*(?:quality|size|output_format|output_compression)/i.test(
    summarizeErrorPayload(parsed.payload, parsed.rawText),
  )) {
    response = await request(false)
    parsed = await parseJsonResponse(response)
  }
  if (!response.ok) {
    throw new ImageApiHttpError(
      response.status,
      summarizeErrorPayload(parsed.payload, parsed.rawText),
      readRetryAfterMs(response),
    )
  }

  const fallbackMimeType = outputFormatMimeType(normalizeOutputFormat(input.outputFormat))
  const immediate = extractImageOutputsFromTaskPayload(parsed.payload, fallbackMimeType)
  if (immediate.length > 0) return immediate[0]

  const taskId = readResponseId(parsed.payload)
  if (!taskId) throw new Error('IMAGE_ASYNC_EMPTY_RESPONSE: missing task id or image data')
  const pollUrl = `${endpoint}/${encodeURIComponent(taskId)}`
  await notifyProviderTask(input, { taskId, pollUrl, status: 'submitted' })
  return pollImageTask(input, pollUrl, fallbackMimeType, taskId)
}

async function tryGenerateImageViaAsyncEndpoint(input: ImageGenerationInput): Promise<ImageOutput | null> {
  const endpoint = resolveOpenAICompatAsyncImageEndpoint(input.baseUrl)
  if (unsupportedAsyncImageEndpoints.has(endpoint)) return null

  const request = (includeLatencyOptions: boolean) => fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildImagesGenerationRequestBody({ ...input, stream: false }, includeLatencyOptions)),
  })

  let response = await request(true)
  let parsed = await parseJsonResponse(response)

  if (response.status === 400 && /(?:unknown|unsupported|unrecognized).*(?:quality|size|output_format|output_compression)/i.test(
    summarizeErrorPayload(parsed.payload, parsed.rawText),
  )) {
    response = await request(false)
    parsed = await parseJsonResponse(response)
  }

  if (response.status === 404 || response.status === 405) {
    unsupportedAsyncImageEndpoints.add(endpoint)
    return null
  }
  if (!response.ok) {
    throw new ImageApiHttpError(
      response.status,
      summarizeErrorPayload(parsed.payload, parsed.rawText),
      readRetryAfterMs(response),
    )
  }

  const fallbackMimeType = outputFormatMimeType(normalizeOutputFormat(input.outputFormat))
  const immediate = extractImageOutputsFromTaskPayload(parsed.payload, fallbackMimeType)
  if (immediate.length > 0) return immediate[0]

  const taskId = readResponseId(parsed.payload)
  if (!taskId) throw new Error('IMAGE_ASYNC_EMPTY_RESPONSE: missing task id or image data')

  const pollUrl = resolveImageTaskPollUrl(input.baseUrl, taskId, parsed.payload, response.headers.get('location'))
  await notifyProviderTask(input, { taskId, pollUrl, status: 'submitted' })
  return pollImageTask(input, pollUrl, fallbackMimeType, taskId)
}

function resolveImageTaskPollUrl(baseUrl: string, taskId: string, payload: unknown, location: string | null) {
  let candidate = location?.trim() || ''
  if (!candidate && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const pollUrl = (payload as { poll_url?: unknown }).poll_url
    if (typeof pollUrl === 'string') candidate = pollUrl.trim()
  }
  if (!candidate) return resolveOpenAICompatImageTaskEndpoint(baseUrl, taskId)
  try {
    return new URL(candidate, `${resolveOpenAICompatApiBase(baseUrl)}/`).toString()
  } catch {
    return resolveOpenAICompatImageTaskEndpoint(baseUrl, taskId)
  }
}

async function notifyProviderTask(input: ImageGenerationInput, update: ImageProviderTaskUpdate) {
  try {
    await input.onProviderTaskUpdate?.(update)
  } catch {
    // A checkpoint update must never cancel or duplicate provider work.
  }
}

async function pollImageTask(
  input: ImageGenerationInput,
  pollUrl: string,
  fallbackMimeType: string,
  taskId: string,
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < IMAGE_TASK_POLL_TIMEOUT_MS) {
    await sleep(IMAGE_TASK_POLL_INTERVAL_MS)
    let response: Response
    try {
      response = await fetch(pollUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${input.apiKey}` },
      })
    } catch (error) {
      if (isRetryableImageError(error)) {
        await sleep(IMAGE_TASK_POLL_INTERVAL_MS)
        continue
      }
      throw error
    }
    const parsed = await parseJsonResponse(response)
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await sleep(Math.min(readRetryAfterMs(response) || IMAGE_TASK_POLL_INTERVAL_MS, 60_000))
        continue
      }
      throw new ImageApiHttpError(
        response.status,
        summarizeErrorPayload(parsed.payload, parsed.rawText),
        readRetryAfterMs(response),
      )
    }

    const outputs = extractImageOutputsFromTaskPayload(parsed.payload, fallbackMimeType)
    if (outputs.length > 0) {
      await notifyProviderTask(input, { taskId, pollUrl, status: 'completed' })
      return outputs[0]
    }

    const status = readResponseStatus(parsed.payload)
    if (isFailedStatus(status)) {
      const message = summarizeErrorPayload(parsed.payload, parsed.rawText) || status
      await notifyProviderTask(input, { taskId, pollUrl, status: 'failed', error: message })
      throw new Error(`IMAGE_ASYNC_FAILED: ${message}`)
    }
    if (isDoneStatus(status)) {
      await notifyProviderTask(input, {
        taskId,
        pollUrl,
        status: 'failed',
        error: 'Provider completed without image data',
      })
      throw new Error('IMAGE_ASYNC_EMPTY_RESPONSE')
    }
  }
  throw new Error('IMAGE_ASYNC_TIMEOUT')
}

async function generateImageViaImagesEndpointOnce(input: ImageGenerationInput) {
  const endpoint = resolveOpenAICompatImageEndpoint(input.baseUrl)
  const request = (includeLatencyOptions: boolean) => fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildImagesGenerationRequestBody(input, includeLatencyOptions)),
  })

  let response = await request(true)
  let parsed = response.ok ? null : await parseJsonResponse(response)

  if (response.status === 400 && /(?:unknown|unsupported|unrecognized).*(?:quality|size|output_format|output_compression)/i.test(
    summarizeErrorPayload(parsed?.payload, parsed?.rawText || ''),
  )) {
    response = await request(false)
    parsed = response.ok ? null : await parseJsonResponse(response)
  }

  if (!response.ok) {
    const message = summarizeErrorPayload(parsed?.payload, parsed?.rawText || '')
    throw new ImageApiHttpError(response.status, message, readRetryAfterMs(response))
  }

  const outputFormat = normalizeOutputFormat(input.outputFormat)
  const fallbackMimeType = outputFormatMimeType(outputFormat)
  const contentType = response.headers.get('content-type') || ''
  if (input.stream || contentType.includes('text/event-stream')) {
    return readImageSSEStream(response, fallbackMimeType)
  }

  const success = await parseJsonResponse(response)
  const refusal = findImageContentPolicyMessage(success.payload)
  if (refusal) throw new Error(`IMAGE_CONTENT_POLICY: ${refusal}`)
  const outputs = extractImageOutputsWithMimeType(success.payload, fallbackMimeType)
  if (outputs.length === 0) {
    throw new Error('IMAGE_API_EMPTY_RESPONSE')
  }

  return outputs[0]
}

export function buildResponsesImageInput(input: Pick<ImageGenerationInput, 'prompt' | 'referenceImages'>) {
  const prompt = `${RESPONSES_IMAGE_PROMPT_PREFIX}\n\nUser prompt:\n${input.prompt}`
  if (!input.referenceImages?.length) return prompt
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text: prompt },
      ...input.referenceImages.map((reference) => ({
        type: 'input_image',
        image_url: reference.dataUrl,
      })),
    ],
  }]
}

async function generateImageViaResponses(input: ImageGenerationInput) {
  const imageTool: Record<string, unknown> = {
    type: 'image_generation',
    partial_images: Math.min(3, Math.max(1, Math.round(input.partialImages || 3))),
  }
  if (input.quality) imageTool.quality = input.quality
  if (input.size) imageTool.size = input.size
  if (input.outputFormat) imageTool.output_format = normalizeOutputFormat(input.outputFormat)
  if (input.outputCompression !== undefined) imageTool.output_compression = input.outputCompression

  const response = await fetch(resolveOpenAICompatResponsesEndpoint(input.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      input: buildResponsesImageInput(input),
      tools: [imageTool],
      tool_choice: { type: 'image_generation' },
      store: false,
      background: true,
    }),
  })

  const { rawText, payload } = await parseJsonResponse(response)
  if (!response.ok) {
    throw new Error(`RESPONSES_IMAGE_API_FAILED: ${response.status} ${summarizeErrorPayload(payload, rawText)}`)
  }

  const immediateDataUrl = findImageDataUrl(payload)
  if (immediateDataUrl) return dataUrlToImageOutput(immediateDataUrl)

  const responseId = readResponseId(payload)
  const initialStatus = readResponseStatus(payload)
  if (!responseId) throw new Error('RESPONSES_IMAGE_API_EMPTY_RESPONSE: missing response id or image data')
  if (isFailedStatus(initialStatus)) throw new Error(`RESPONSES_IMAGE_API_FAILED_STATUS: ${initialStatus}`)

  const endpoint = resolveOpenAICompatResponsesEndpoint(input.baseUrl)
  const startedAt = Date.now()
  while (Date.now() - startedAt < RESPONSES_IMAGE_POLL_TIMEOUT_MS) {
    await sleep(RESPONSES_IMAGE_POLL_INTERVAL_MS)
    const pollResponse = await fetch(`${endpoint}/${encodeURIComponent(responseId)}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
      },
    })
    const polled = await parseJsonResponse(pollResponse)
    if (!pollResponse.ok) {
      throw new Error(`RESPONSES_IMAGE_POLL_FAILED: ${pollResponse.status} ${summarizeErrorPayload(polled.payload, polled.rawText)}`)
    }

    const dataUrl = findImageDataUrl(polled.payload)
    if (dataUrl) return dataUrlToImageOutput(dataUrl)

    const status = readResponseStatus(polled.payload)
    if (isFailedStatus(status)) throw new Error(`RESPONSES_IMAGE_API_FAILED_STATUS: ${status}`)
    if (isDoneStatus(status)) break
  }

  throw new Error('RESPONSES_IMAGE_API_TIMEOUT: no image data returned')
}

export async function imageOutputToBuffer(output: ImageOutput): Promise<{ buffer: Buffer; mimeType: string }> {
  if (output.source === 'base64') {
    return {
      buffer: Buffer.from(output.value, 'base64'),
      mimeType: output.mimeType,
    }
  }

  const response = await fetch(output.value)
  if (!response.ok) {
    throw new Error(`IMAGE_DOWNLOAD_FAILED: ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || output.mimeType,
  }
}

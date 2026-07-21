export type TextApiMode = 'auto' | 'chat_completions' | 'responses'

export type GenerateTextInput = {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  prompt: string
  mode?: string
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: string
  responseFormat?: 'json_object'
  disableThinking?: boolean
  timeoutMs?: number
  maxAttempts?: number
}

class TextApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(`TEXT_API_FAILED: ${status} ${message}`)
    this.status = status
  }
}

function isTimeoutError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError'
    || error.name === 'AbortError'
    || /timed?\s*out|timeout|aborted/i.test(error.message)
}

async function fetchTextApi(url: string, init: RequestInit) {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new TextApiError(504, '上游文本模型响应超时')
    }
    throw error
  }
}

function apiBase(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '')
  return /\/v\d+$/i.test(normalized) ? normalized : `${normalized}/v1`
}

export function resolveChatCompletionsEndpoint(baseUrl: string) {
  return `${apiBase(baseUrl)}/chat/completions`
}

export function resolveResponsesEndpoint(baseUrl: string) {
  return `${apiBase(baseUrl)}/responses`
}

function errorMessage(payload: unknown, raw: string) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const error = (payload as { error?: unknown }).error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 1200)
    }
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 1200)
  }
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200)
}

function responseErrorMessage(status: number, payload: unknown, raw: string) {
  if ([502, 503, 504].includes(status)) return '上游文本模型网关暂时不可用'
  return errorMessage(payload, raw)
}

async function parseResponse(response: Response) {
  const raw = await response.text()
  try {
    return { raw, payload: JSON.parse(raw) as unknown }
  } catch {
    return { raw, payload: null }
  }
}

export function extractChatCompletionText(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const message = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as { message?: unknown }).message
    : null
  if (!message || typeof message !== 'object' || Array.isArray(message)) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const text = (item as { text?: unknown }).text
    return typeof text === 'string' ? [text] : []
  }).join('').trim()
}

export function extractResponsesText(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const outputText = (payload as { output_text?: unknown }).output_text
  if (typeof outputText === 'string' && outputText.trim()) return outputText.trim()
  const output = (payload as { output?: unknown }).output
  if (!Array.isArray(output)) return ''
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return []
      const record = part as { text?: unknown; output_text?: unknown }
      if (typeof record.text === 'string') return [record.text]
      if (typeof record.output_text === 'string') return [record.output_text]
      return []
    })
  }).join('').trim()
}

function parseResponsesSseEvents(raw: string) {
  return raw.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return []
    try {
      return [JSON.parse(data) as unknown]
    } catch {
      return []
    }
  })
}

export function extractResponsesSseText(raw: string) {
  const deltas: string[] = []
  let finalText = ''
  for (const payload of parseResponsesSseEvents(raw)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const record = payload as { type?: unknown; delta?: unknown; text?: unknown; response?: unknown }
    if (record.type === 'response.output_text.delta' && typeof record.delta === 'string') {
      deltas.push(record.delta)
      continue
    }
    if (record.type === 'response.output_text.done' && typeof record.text === 'string') {
      finalText = record.text.trim()
      continue
    }
    const completed = extractResponsesText(record.response || payload)
    if (completed) finalText = completed
  }
  return (deltas.join('') || finalText).trim()
}

function extractResponsesSseError(raw: string) {
  for (const payload of parseResponsesSseEvents(raw)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const record = payload as { type?: unknown; error?: unknown; response?: unknown }
    const response = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
      ? record.response as { status?: unknown; error?: unknown }
      : null
    const failed = record.type === 'error'
      || record.type === 'response.failed'
      || response?.status === 'failed'
    if (!failed) continue
    return errorMessage(record.error || response?.error || payload, JSON.stringify(payload))
  }
  return ''
}

function normalizeMode(value: string | undefined): TextApiMode {
  if (value === 'chat_completions' || value === 'responses' || value === 'auto') return value
  return 'auto'
}

async function requestChat(input: GenerateTextInput) {
  const system = input.responseFormat === 'json_object' && !/json/i.test(input.system)
    ? `${input.system}\nReturn only one valid JSON object.`
    : input.system
  const response = await fetchTextApi(resolveChatCompletionsEndpoint(input.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxOutputTokens ?? 12000,
      ...(input.responseFormat ? { response_format: { type: input.responseFormat } } : {}),
      ...(input.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  })
  const parsed = await parseResponse(response)
  if (!response.ok) throw new TextApiError(
    response.status,
    responseErrorMessage(response.status, parsed.payload, parsed.raw),
  )
  const text = extractChatCompletionText(parsed.payload)
  if (!text) throw new TextApiError(502, '文本模型返回了空内容')
  return text
}

async function requestResponses(input: GenerateTextInput) {
  const response = await fetchTextApi(resolveResponsesEndpoint(input.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      ...(!input.reasoningEffort ? { temperature: input.temperature ?? 0.2 } : {}),
      max_output_tokens: input.maxOutputTokens ?? 12000,
      store: false,
      stream: true,
      ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  })
  const parsed = await parseResponse(response)
  if (!response.ok) throw new TextApiError(
    response.status,
    responseErrorMessage(response.status, parsed.payload, parsed.raw),
  )
  const streamError = extractResponsesSseError(parsed.raw)
  if (streamError) throw new TextApiError(502, streamError)
  const text = parsed.payload
    ? extractResponsesText(parsed.payload)
    : extractResponsesSseText(parsed.raw)
  if (!text) throw new TextApiError(502, '文本模型返回了空内容')
  return text
}

function retryable(error: unknown) {
  return error instanceof TextApiError && [429, 502, 503, 504].includes(error.status)
}

function endpointUnsupported(error: unknown) {
  return error instanceof TextApiError && [400, 404, 405, 422].includes(error.status)
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry(operation: () => Promise<string>, maxAttempts = 3) {
  const attempts = Math.max(1, Math.min(5, Math.round(maxAttempts)))
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!retryable(error) || attempt === attempts - 1) throw error
      await sleep([2_000, 6_000, 12_000, 20_000][attempt] || 20_000)
    }
  }
  throw lastError
}

export async function generateTextViaOpenAICompat(input: GenerateTextInput) {
  const mode = normalizeMode(input.mode)
  const maxAttempts = input.maxAttempts ?? 3
  if (mode === 'chat_completions') return withRetry(() => requestChat(input), maxAttempts)
  if (mode === 'responses') return withRetry(() => requestResponses(input), maxAttempts)

  try {
    return await withRetry(() => requestChat(input), maxAttempts)
  } catch (error) {
    if (!endpointUnsupported(error)) throw error
    return withRetry(() => requestResponses(input), maxAttempts)
  }
}

function compactProviderError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export async function generateTextWithFallback(
  primary: GenerateTextInput,
  fallback?: GenerateTextInput | null,
  labels = { primary: 'primary', fallback: 'fallback' },
) {
  if (!fallback) return generateTextViaOpenAICompat(primary)

  let primaryError: unknown
  try {
    return await generateTextViaOpenAICompat(primary)
  } catch (error) {
    primaryError = error
  }

  try {
    return await generateTextViaOpenAICompat(fallback)
  } catch (fallbackError) {
    throw new Error(
      `TEXT_PROVIDERS_FAILED: ${labels.primary}: ${compactProviderError(primaryError)}; ${labels.fallback}: ${compactProviderError(fallbackError)}`,
    )
  }
}

export function extractJsonValue(text: string): unknown {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    // Continue with a balanced JSON scan so explanatory text around JSON is harmless.
  }

  for (let start = 0; start < cleaned.length; start++) {
    const opener = cleaned[start]
    if (opener !== '{' && opener !== '[') continue
    const closer = opener === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < cleaned.length; index++) {
      const char = cleaned[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === opener) depth++
      if (char === closer) depth--
      if (depth !== 0) continue
      try {
        return JSON.parse(cleaned.slice(start, index + 1))
      } catch {
        break
      }
    }
  }
  throw new Error('模型没有返回可解析的 JSON 结果')
}

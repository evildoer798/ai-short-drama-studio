export type CangyuanAudioConfig = {
  baseUrl: string
  apiKey: string
}

export type CangyuanAudioJob = {
  id: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  url: string | null
  error: string | null
  raw: Record<string, unknown>
}

function apiRoot(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizedStatus(value: unknown): CangyuanAudioJob['status'] {
  const status = String(value || '').trim().toLowerCase()
  if (['completed', 'succeeded', 'success'].includes(status)) return 'completed'
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed'
  if (['processing', 'running', 'in_progress', 'in-progress'].includes(status)) return 'in_progress'
  return 'queued'
}

export function parseCangyuanAudioJob(value: unknown, fallbackId = ''): CangyuanAudioJob {
  const raw = record(value)
  const nested = record(raw.data)
  const dataList = Array.isArray(raw.data) ? raw.data : Array.isArray(nested.data) ? nested.data : []
  const first = record(dataList[0])
  const output = record(raw.output)
  const id = String(raw.id || raw.task_id || nested.id || nested.task_id || fallbackId).trim()
  const status = normalizedStatus(raw.status || nested.status)
  const url = String(first.url || output.url || raw.url || nested.url || '').trim() || null
  const errorValue = raw.error || nested.error || raw.message || nested.message
  const error = typeof errorValue === 'string'
    ? errorValue.trim() || null
    : Object.keys(record(errorValue)).length > 0 ? JSON.stringify(errorValue) : null
  return { id, status, url, error, raw }
}

async function audioRequest(config: CangyuanAudioConfig, path: string, init?: RequestInit) {
  const response = await fetch(`${apiRoot(config.baseUrl)}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.apiKey}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let payload: unknown = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { message: text.slice(0, 2_000) }
  }
  if (!response.ok) {
    throw new Error(`AUDIO_API_HTTP_${response.status}: ${JSON.stringify(payload).slice(0, 2_000)}`)
  }
  return payload
}

export async function submitCangyuanAudioGeneration(
  config: CangyuanAudioConfig,
  input: { model: string, prompt: string },
) {
  const payload = await audioRequest(config, '/audio/generations', {
    method: 'POST',
    body: JSON.stringify({
      async: true,
      model: input.model,
      prompt: input.prompt,
      response_format: 'url',
    }),
  })
  const job = parseCangyuanAudioJob(payload)
  if (!job.id) throw new Error(`AUDIO_TASK_ID_MISSING: ${JSON.stringify(payload).slice(0, 2_000)}`)
  return job
}

export async function retrieveCangyuanAudioGeneration(config: CangyuanAudioConfig, taskId: string) {
  const payload = await audioRequest(config, `/audio/generations/${encodeURIComponent(taskId)}`)
  return parseCangyuanAudioJob(payload, taskId)
}

export function readableCanvasAudioError(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (!error) return null
  if (error.includes('AUDIO_TASK_TIMEOUT')) return '参考音频生成超时，请稍后重试'
  if (error.includes('AUDIO_RESULT_URL_MISSING')) return '音频任务已完成，但没有返回可下载的音频'
  if (error.includes('AUDIO_DOWNLOAD')) return '生成成功，但下载音频失败，请稍后重试'
  if (error.includes('AUDIO_API_HTTP_401') || error.includes('AUDIO_API_HTTP_403')) return '音频 API 密钥无效或没有模型权限'
  if (error.includes('AUDIO_API_HTTP_429')) return '音频生成请求过多，请稍后重试'
  if (error.includes('AUDIO_TASK_FAILED')) return '参考音频生成失败，请调整描述后重试'
  return error.replace(/^Error:\s*/u, '').slice(0, 500)
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildImagesGenerationRequestBody,
  extractImageOutputs,
  extractImageOutputFromSSEText,
  generateImageViaOpenAICompat,
  isUnrecoverableImageGenerationError,
  resolveOpenAICompatAsyncImageEndpoint,
  resolveOpenAICompatImageEndpoint,
  resolveOpenAICompatImageTaskEndpoint,
  resolveOpenAICompatResponsesEndpoint,
  shouldDiscardImageProviderCheckpoint,
} from '@/lib/openai-image'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('image failure recovery', () => {
  it('does not queue-retry terminal policy and permission failures', () => {
    expect(isUnrecoverableImageGenerationError(new Error('IMAGE_CONTENT_POLICY: request rejected'))).toBe(true)
    expect(isUnrecoverableImageGenerationError(new Error('IMAGE_API_FAILED: 403 forbidden'))).toBe(true)
    expect(isUnrecoverableImageGenerationError(new Error('IMAGE_API_FAILED: 429 busy'))).toBe(false)
  })

  it('discards terminal provider task checkpoints before retrying', () => {
    expect(shouldDiscardImageProviderCheckpoint(new Error('IMAGE_ASYNC_FAILED: GENERATION_FAILED'))).toBe(true)
    expect(shouldDiscardImageProviderCheckpoint(new Error('fetch failed'))).toBe(false)
  })
})

describe('buildImagesGenerationRequestBody', () => {
  it('uses low-latency image options', () => {
    expect(buildImagesGenerationRequestBody({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      quality: 'low',
      size: '1024x1024',
      outputFormat: 'jpeg',
      outputCompression: 75,
    })).toEqual({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      n: 1,
      quality: 'low',
      size: '1024x1024',
      output_format: 'jpeg',
      output_compression: 75,
    })
  })

  it('enables the Sub2API streaming extension', () => {
    expect(buildImagesGenerationRequestBody({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      stream: true,
    })).toMatchObject({
      stream: true,
      response_format: 'b64_json',
    })
  })

  it('uses asynchronous task mode without conflicting stream fields', () => {
    expect(buildImagesGenerationRequestBody({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      stream: true,
    }, true, true)).toMatchObject({
      async: true,
    })
    expect(buildImagesGenerationRequestBody({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      stream: true,
    }, true, true)).not.toHaveProperty('stream')
  })

  it('can fall back to the minimal compatible request', () => {
    expect(buildImagesGenerationRequestBody({
      model: 'gpt-image-2',
      prompt: 'character sheet',
    }, false)).toEqual({
      model: 'gpt-image-2',
      prompt: 'character sheet',
      n: 1,
    })
  })
})

describe('extractImageOutputFromSSEText', () => {
  it('keeps the latest Sub2API partial image', () => {
    const output = extractImageOutputFromSSEText([
      'event: image_generation.partial_image',
      'data: {"type":"image_generation.partial_image","b64_json":"iVBORfirst","output_format":"png"}',
      '',
      'event: image_generation.partial_image',
      'data: {"type":"image_generation.partial_image","b64_json":"/9j/final","output_format":"jpeg"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))

    expect(output).toEqual({
      source: 'base64',
      value: '/9j/final',
      mimeType: 'image/jpeg',
    })
  })

  it('reads raw Responses partial image events', () => {
    const output = extractImageOutputFromSSEText([
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"iVBORraw","output_format":"png"}',
      '',
    ].join('\n'))

    expect(output).toEqual({
      source: 'base64',
      value: 'iVBORraw',
      mimeType: 'image/png',
    })
  })

  it('does not save partial output after a stream error', () => {
    expect(() => extractImageOutputFromSSEText([
      'data: {"type":"image_generation.partial_image","b64_json":"iVBORpartial"}',
      '',
      'data: {"type":"error","error":{"message":"generation failed"}}',
      '',
    ].join('\n'))).toThrow('IMAGE_STREAM_FAILED: generation failed')
  })
})

describe('extractImageOutputs', () => {
  it('reads url outputs', () => {
    const outputs = extractImageOutputs({
      data: [
        { url: 'https://example.com/a.png' },
        { url: 'https://example.com/b.png' },
      ],
    })

    expect(outputs).toEqual([
      { source: 'url', value: 'https://example.com/a.png', mimeType: 'image/png' },
      { source: 'url', value: 'https://example.com/b.png', mimeType: 'image/png' },
    ])
  })

  it('reads b64_json outputs', () => {
    const outputs = extractImageOutputs({
      data: [
        { b64_json: 'YWJj' },
      ],
    })

    expect(outputs).toEqual([
      { source: 'base64', value: 'YWJj', mimeType: 'image/png' },
    ])
  })

  it('normalizes data urls', () => {
    const outputs = extractImageOutputs({
      data: [
        { url: 'data:image/webp;base64,AAAA' },
      ],
    })

    expect(outputs).toEqual([
      { source: 'base64', value: 'AAAA', mimeType: 'image/webp' },
    ])
  })

  it('does not treat provider refusal text as an image url', () => {
    expect(extractImageOutputs({
      data: [{ url: '您的请求无法用于生成图像。该请求可能因安全政策被拦截。' }],
    })).toEqual([])
  })
})

describe('resolveOpenAICompatImageEndpoint', () => {
  it('adds /v1 when the base url is a sub2api root', () => {
    expect(resolveOpenAICompatImageEndpoint('https://sub.kedaya.xyz')).toBe(
      'https://sub.kedaya.xyz/v1/images/generations',
    )
  })

  it('keeps an explicit /v1 base url', () => {
    expect(resolveOpenAICompatImageEndpoint('https://sub.kedaya.xyz/v1')).toBe(
      'https://sub.kedaya.xyz/v1/images/generations',
    )
  })

  it('builds Sub2API asynchronous task endpoints', () => {
    expect(resolveOpenAICompatAsyncImageEndpoint('https://sub.kedaya.xyz')).toBe(
      'https://sub.kedaya.xyz/v1/images/generations/async',
    )
    expect(resolveOpenAICompatImageTaskEndpoint('https://sub.kedaya.xyz', 'img task')).toBe(
      'https://sub.kedaya.xyz/v1/images/tasks/img%20task',
    )
  })
})

describe('generateImageViaOpenAICompat retries', () => {
  it('waits and retries when the provider returns 429', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'YWJj' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const onRetry = vi.fn()

    const output = await generateImageViaOpenAICompat({
      baseUrl: 'https://provider.example',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: false,
      retryDelaysMs: [0],
      onRetry,
    })

    expect(output).toEqual({ source: 'base64', value: 'YWJj', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2,
      maxAttempts: 2,
      status: 429,
    }))
  })

  it('uses Cangyuan async submission and polling', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_1',
        status: 'queued',
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_1',
        status: 'completed',
        data: [{ b64_json: 'YWJj' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateImageViaOpenAICompat({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: true,
      retryDelaysMs: [],
    })
    await vi.runAllTimersAsync()
    const output = await promise

    expect(output).toEqual({ source: 'base64', value: 'YWJj', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://ai.cangyuansuanli.cn/v1/images/generations')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ async: true })
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://ai.cangyuansuanli.cn/v1/images/generations/image_task_1',
    )
  })

  it('requeues after a provider task explicitly times out', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_timeout',
        status: 'queued',
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_timeout',
        status: 'failed',
        error: { code: 'TIMEOUT', message: '图片生成超时，请稍后再试。' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_retry',
        status: 'queued',
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_retry',
        status: 'completed',
        data: [{ b64_json: 'YWJj' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onRetry = vi.fn()
    const onProviderTaskUpdate = vi.fn()

    const promise = generateImageViaOpenAICompat({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: true,
      retryDelaysMs: [0],
      providerTimeoutRetries: 1,
      onRetry,
      onProviderTaskUpdate,
    })
    await vi.runAllTimersAsync()
    const output = await promise

    expect(output).toEqual({ source: 'base64', value: 'YWJj', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2,
      message: '图片服务商本次排队超时，正在自动重新排队',
    }))
    expect(onProviderTaskUpdate.mock.calls.map(([update]) => update.status)).toEqual([
      'submitted',
      'failed',
      'submitted',
      'completed',
    ])
  })

  it('resumes a saved provider task without submitting a duplicate', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'image_task_saved',
      status: 'completed',
      data: [{ b64_json: 'YWJj' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateImageViaOpenAICompat({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: true,
      retryDelaysMs: [],
      resumeProviderTask: {
        taskId: 'image_task_saved',
        pollUrl: 'https://ai.cangyuansuanli.cn/v1/images/generations/image_task_saved',
      },
    })
    await vi.runAllTimersAsync()
    const output = await promise

    expect(output).toEqual({ source: 'base64', value: 'YWJj', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://ai.cangyuansuanli.cn/v1/images/generations/image_task_saved',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
  })

  it('keeps polling the same task after a temporary network failure', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_network',
        status: 'queued',
      }), { status: 202, headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_network',
        status: 'completed',
        data: [{ b64_json: 'YWJj' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateImageViaOpenAICompat({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: true,
      retryDelaysMs: [],
    })
    await vi.runAllTimersAsync()
    const output = await promise

    expect(output).toEqual({ source: 'base64', value: 'YWJj', mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[2]?.[0])
  })

  it('reports a Cangyuan refusal instead of downloading it as a url', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_refused',
        status: 'queued',
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'image_task_refused',
        status: 'completed',
        data: [{ url: '您的请求无法用于生成图像。该请求可能因安全政策被拦截。' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateImageViaOpenAICompat({
      baseUrl: 'https://ai.cangyuansuanli.cn',
      apiKey: 'secret',
      model: 'gpt-image-2',
      prompt: 'character sheet',
      mode: 'images',
      useAsync: true,
      retryDelaysMs: [],
    })
    const rejection = expect(promise).rejects.toThrow('IMAGE_CONTENT_POLICY')
    await vi.runAllTimersAsync()
    await rejection
  })
})

describe('resolveOpenAICompatResponsesEndpoint', () => {
  it('adds /v1 when the base url is a sub2api root', () => {
    expect(resolveOpenAICompatResponsesEndpoint('https://sub.kedaya.xyz')).toBe(
      'https://sub.kedaya.xyz/v1/responses',
    )
  })

  it('keeps an explicit /v1 base url', () => {
    expect(resolveOpenAICompatResponsesEndpoint('https://sub.kedaya.xyz/v1')).toBe(
      'https://sub.kedaya.xyz/v1/responses',
    )
  })
})

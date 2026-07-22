import { describe, expect, it } from 'vitest'
import {
  extractVideoUrl,
  retrieveVideoJob,
  selectVideoCapability,
  submitVideoGeneration,
} from '@/lib/openai-video'

describe('selectVideoCapability', () => {
  it('prefers Sora Pro when the OpenAI Videos API is available', () => {
    expect(selectVideoCapability(['gpt-5.5', 'sora-2', 'sora-2-pro'])).toEqual({
      mode: 'openai',
      model: 'sora-2-pro',
    })
  })

  it('detects the Sub2API Grok video model', () => {
    expect(selectVideoCapability(['grok-4.5', 'grok-imagine-video-1.5-preview'])).toEqual({
      mode: 'sub2api-grok',
      model: 'grok-imagine-video-1.5-preview',
    })
  })

  it('detects a NewAPI Grok video model', () => {
    expect(selectVideoCapability(['grok-video', 'grok-video-1.5'], 'grok-video')).toEqual({
      mode: 'newapi-grok',
      model: 'grok-video',
    })
  })

  it('detects a NewAPI Seedance model through the OpenAI Videos route', () => {
    expect(selectVideoCapability(['seedance-2.0', 'seedance-2.0-fast-720p'])).toEqual({
      mode: 'openai',
      model: 'seedance-2.0-fast-720p',
    })
  })

  it('detects the face-locked Seedance alias from live pricing', () => {
    expect(selectVideoCapability(['sd5-seedance-2.0-fast'], 'sd5-seedance-2.0-fast')).toEqual({
      mode: 'openai',
      model: 'sd5-seedance-2.0-fast',
    })
  })

  it('does not treat GPT or image models as video models', () => {
    expect(selectVideoCapability(['gpt-5.5', 'gpt-image-2'])).toBeNull()
  })

  it('rejects a configured model that is absent from the provider', () => {
    expect(selectVideoCapability(['gpt-5.5'], 'sora-2')).toBeNull()
  })
})

describe('submitVideoGeneration', () => {
  it('sends Seedance resolution, aspect ratio, four asset references and native audio settings', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'video_test', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'seedance-2.0-mini' },
      {
        prompt: 'use @image1 and @image2',
        seconds: 12,
        size: '1280x720',
        aspectRatio: '3:4',
        resolution: '480p',
        referenceImageUrls: [
          'data:image/jpeg;base64,AAA',
          'data:image/jpeg;base64,BBB',
          'data:image/jpeg;base64,CCC',
          'data:image/jpeg;base64,DDD',
          'data:image/jpeg;base64,IGNORED',
        ],
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedBody).toMatchObject({
      model: 'seedance-2.0-mini',
      duration: 12,
      aspect_ratio: '3:4',
      resolution: '480p',
      audio: true,
      image_url: 'data:image/jpeg;base64,AAA',
      reference_image_urls: [
        'data:image/jpeg;base64,BBB',
        'data:image/jpeg;base64,CCC',
        'data:image/jpeg;base64,DDD',
      ],
    })
  })

  it('rejects Seedance prompts longer than 5000 characters before submitting', async () => {
    let requested = false
    const fetchImpl = async () => {
      requested = true
      return new Response('{}')
    }

    await expect(submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'seedance-2.0-mini' },
      { prompt: 'x'.repeat(5001) },
      fetchImpl as typeof fetch,
    )).rejects.toThrow('VIDEO_PROMPT_TOO_LONG')
    expect(requested).toBe(false)
  })

  it('sends Grok preview duration, aspect ratio, and 480p resolution', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ request_id: 'grok_test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'sub2api-grok', model: 'grok-imagine-video' },
      {
        prompt: 'faceless mannequin action preview',
        seconds: 15,
        size: '854x480',
        generateAudio: false,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos/generations')
    expect(submittedBody).toMatchObject({
      model: 'grok-imagine-video',
      duration: 15,
      aspect_ratio: '16:9',
      resolution: '480p',
    })
  })

  it('sends NewAPI Grok video requests to the OpenAI videos route', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'grok_newapi_test', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'newapi-grok', model: 'grok-video' },
      {
        prompt: 'faceless mannequin action preview',
        seconds: 12,
        size: '854x480',
        referenceImageUrls: ['data:image/jpeg;base64,AAA'],
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'grok-video',
      seconds: 15,
      aspect_ratio: '16:9',
      resolution: '480p',
      image_urls: ['data:image/jpeg;base64,AAA'],
    })
  })

  it('retrieves a Grok result without a repeated request id', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      status: 'done',
      progress: 100,
      video: { url: 'https://example.com/preview.mp4' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

    const job = await retrieveVideoJob(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      'grok_test',
      fetchImpl as typeof fetch,
    )

    expect(job).toMatchObject({ id: 'grok_test', status: 'completed', progress: 100 })
    expect(extractVideoUrl(job.raw)).toBe('https://example.com/preview.mp4')
  })

  it('retrieves a NewAPI Grok result from the OpenAI videos route', async () => {
    let requestedUrl = ''
    const fetchImpl = async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({
        code: 'success',
        data: {
          task_id: 'grok_newapi_test',
          status: 'SUCCESS',
          progress: '100%',
          result_url: 'https://example.com/grok.mp4',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const job = await retrieveVideoJob(
      {
        baseUrl: 'https://example.com',
        apiKey: 'test',
        mode: 'newapi-grok',
        model: 'grok-video',
      },
      'grok_newapi_test',
      fetchImpl as typeof fetch,
    )

    expect(requestedUrl).toBe('https://example.com/v1/videos/grok_newapi_test')
    expect(job).toMatchObject({
      id: 'grok_newapi_test',
      status: 'completed',
      progress: 100,
    })
    expect(extractVideoUrl(job.raw)).toBe('https://example.com/grok.mp4')
  })
})

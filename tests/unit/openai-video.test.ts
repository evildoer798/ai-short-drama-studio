import { describe, expect, it } from 'vitest'
import {
  extractVideoUrl,
  isUnrecoverableVideoGenerationError,
  retrieveVideoJob,
  selectVideoCapability,
  shouldResetVideoProviderJobOnRetry,
  submitVideoGeneration,
} from '@/lib/openai-video'

describe('shouldResetVideoProviderJobOnRetry', () => {
  it('starts a fresh provider task after a provider failure or polling timeout', () => {
    expect(shouldResetVideoProviderJobOnRetry('VIDEO_TASK_FAILED: upstream failed')).toBe(true)
    expect(shouldResetVideoProviderJobOnRetry('VIDEO_TASK_TIMEOUT: task_123')).toBe(true)
  })

  it('keeps the provider checkpoint for unrelated transient failures', () => {
    expect(shouldResetVideoProviderJobOnRetry('VIDEO_DOWNLOAD_FAILED: HTTP 503')).toBe(false)
  })
})

describe('selectVideoCapability', () => {
  it('prefers HappyHouse 1.1 when both HappyHouse models are available', () => {
    expect(selectVideoCapability(['happyhouse-1.0', 'happyhouse-1.1'])).toEqual({
      mode: 'openai',
      model: 'happyhouse-1.1',
    })
  })

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

  it('routes current Grok models through the canonical OpenAI-style videos endpoint', () => {
    expect(selectVideoCapability(['grok-video', 'grok-video-1.5'], 'grok-video')).toEqual({
      mode: 'openai',
      model: 'grok-video',
    })
  })

  it('prefers the current public Seedance model name over legacy aliases', () => {
    expect(selectVideoCapability(['seedance-2.0', 'seedance-2.0-fast-720p'])).toEqual({
      mode: 'openai',
      model: 'seedance-2.0',
    })
  })

  it('detects and prefers Seedance 2.5 fixed-resolution models', () => {
    expect(selectVideoCapability(['seedance-2.5-480p', 'seedance-2.5-720p'])).toEqual({
      mode: 'openai',
      model: 'seedance-2.5-720p',
    })
    expect(selectVideoCapability(['seedance-2.5-480p'], 'seedance-2.5-480p')).toEqual({
      mode: 'openai',
      model: 'seedance-2.5-480p',
    })
  })

  it('detects sd6 Seedance by its exact provider model id', () => {
    expect(selectVideoCapability(
      ['sd6-seedance-2.0-720p', 'sd6-seedance-2.0-1080p'],
      'sd6-seedance-2.0-720p',
    )).toEqual({ mode: 'openai', model: 'sd6-seedance-2.0-720p' })
  })

  it('supports the live sd7 Seedance 2.0 provider id', () => {
    expect(selectVideoCapability(
      ['sd7-seedance-2.0-720p'],
      'sd7-seedance-2.0-720p',
    )).toEqual({ mode: 'openai', model: 'sd7-seedance-2.0-720p' })
  })

  it('detects the face-locked Seedance alias when the provider key exposes it', () => {
    expect(selectVideoCapability(['sd5-seedance-2.0-fast'], 'sd5-seedance-2.0-fast')).toEqual({
      mode: 'openai',
      model: 'sd5-seedance-2.0-fast',
    })
  })

  it('rejects the face-locked Seedance alias when the provider key lacks permission', () => {
    expect(selectVideoCapability([], 'sd5-seedance-2.0-fast')).toBeNull()
  })

  it('does not treat GPT or image models as video models', () => {
    expect(selectVideoCapability(['gpt-5.5', 'gpt-image-2'])).toBeNull()
  })

  it('rejects a configured model that is absent from the provider', () => {
    expect(selectVideoCapability(['gpt-5.5'], 'sora-2')).toBeNull()
  })
})

describe('submitVideoGeneration', () => {
  it('does not retry deterministic provider permission and request errors', () => {
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_API_ERROR: HTTP 403: token has no access to model'),
    )).toBe(true)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_API_ERROR: HTTP 422: invalid reference'),
    )).toBe(true)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_API_ERROR: HTTP 400: {"code":"sensitive_words_detected","message":"content moderation rejected the prompt"}'),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_TASK_FAILED: upstream render returned status 408'),
    )).toBe(true)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_TASK_FAILED: Video generation failed without a specific reason; upstream returned FAILED with no output and no failure detail'),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_TASK_FAILED: 视频生成失败，上游未提供具体原因。本次参考素材已成功上传。'),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_TASK_FAILED: The SD5 upstream is overloaded or the submission timed out. Please retry later.'),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error("VIDEO_TASK_FAILED: All cookies failed: field 'generate' not found in type: 'mutation_root'"),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_TASK_FAILED: All cookies failed: insufficient credits (need 4536, have 1244)'),
    )).toBe(true)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_API_ERROR: HTTP 429: rate limited'),
    )).toBe(false)
    expect(isUnrecoverableVideoGenerationError(
      new Error('VIDEO_API_ERROR: HTTP 503: provider unavailable'),
    )).toBe(false)
  })

  it('submits HappyHouse 1.1 with audio, 1080p and at most nine image references', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'video_happy_11', status: 'queued', progress: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const references = Array.from(
      { length: 10 },
      (_, index) => `https://example.com/reference-${index + 1}.jpg`,
    )
    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'happyhouse-1.1' },
      {
        prompt: '@image1 and @image2 walk through a corridor.',
        seconds: 3,
        aspectRatio: '3:4',
        resolution: '1080p',
        referenceImageUrls: references,
        maximumReferenceImages: 9,
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'happyhouse-1.1',
      duration: 3,
      aspect_ratio: '3:4',
      resolution: '1080p',
      generate_audio: true,
      reference_image_urls: references.slice(0, 9),
    })
    expect(submittedBody).not.toHaveProperty('reference_mode')
    expect(submittedBody).not.toHaveProperty('audio')
    expect(JSON.stringify(submittedBody)).not.toContain('reference-10.jpg')
  })

  it('submits Seedance 2.5 480p as JSON with audio, 30 seconds, and at most 30 references', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const references = Array.from({ length: 31 }, (_, index) => `https://example.com/ref-${index + 1}.jpg`)
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'seedance_25_480', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'seedance-2.5-480p' },
      {
        prompt: 'Use the people and setting from the references.',
        seconds: 30,
        aspectRatio: '21:9',
        resolution: '480p',
        referenceImageUrls: references,
        maximumReferenceImages: 30,
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'seedance-2.5-480p',
      duration: 30,
      aspect_ratio: '21:9',
      generate_audio: true,
      reference_image_urls: references.slice(0, 30),
    })
    expect(submittedBody).not.toHaveProperty('resolution')
    expect(submittedBody).not.toHaveProperty('reference_mode')
    expect(submittedBody).not.toHaveProperty('audio')
    expect(JSON.stringify(submittedBody)).not.toContain('ref-31.jpg')
  })

  it('clamps Seedance 2.5 720p to 29 seconds and enforces its 5000-character prompt limit', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'seedance_25_720', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'seedance-2.5-720p' },
      { prompt: 'A cinematic dialogue scene.', seconds: 30, resolution: '720p' },
      fetchImpl as typeof fetch,
    )
    expect(submittedBody).toMatchObject({
      model: 'seedance-2.5-720p',
      duration: 29,
      generate_audio: true,
    })
    expect(submittedBody).not.toHaveProperty('resolution')

    await expect(submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'seedance-2.5-720p' },
      { prompt: 'x'.repeat(5001) },
      fetchImpl as typeof fetch,
    )).rejects.toThrow('maximum is 5000')
  })

  it('submits sd6 with its exact API id, fixed resolution, discrete duration, and nine references', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const references = Array.from({ length: 10 }, (_, index) => `https://example.com/sd6-${index + 1}.jpg`)
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'sd6_task_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd6-seedance-2.0-1080p' },
      {
        prompt: 'Use the characters from the references in a continuous tracking shot.',
        seconds: 7,
        aspectRatio: '3:4',
        resolution: '1080p',
        referenceImageUrls: references,
        maximumReferenceImages: 9,
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'sd6-seedance-2.0-1080p',
      duration: 8,
      aspect_ratio: '3:4',
      reference_image_urls: references.slice(0, 9),
    })
    expect(submittedBody).not.toHaveProperty('resolution')
    expect(submittedBody).not.toHaveProperty('audio')
    expect(submittedBody).not.toHaveProperty('generate_audio')
    expect(submittedBody).not.toHaveProperty('reference_mode')
    expect(JSON.stringify(submittedBody)).not.toContain('sd6-10.jpg')
  })

  it('submits sd7 with five original images and three reference montage videos', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const images = Array.from({ length: 6 }, (_, index) => `https://example.com/image-${index + 1}.jpg`)
    const videos = Array.from({ length: 4 }, (_, index) => `https://example.com/reference-${index + 1}.mp4`)
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'sd7_task_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd7-seedance-2.0-720p' },
      {
        prompt: 'Keep the locked character identity and wardrobe consistent.',
        seconds: 8,
        aspectRatio: '16:9',
        referenceImageUrls: images,
        maximumReferenceImages: 5,
        referenceVideoUrls: videos,
        maximumReferenceVideos: 3,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedBody).toMatchObject({
      model: 'sd7-seedance-2.0-720p',
      duration: 8,
      aspect_ratio: '16:9',
      generate_audio: true,
      reference_image_urls: images.slice(0, 5),
      reference_videos: videos.slice(0, 3),
    })
    expect(submittedBody).not.toHaveProperty('resolution')
    expect(submittedBody).not.toHaveProperty('reference_mode')
    expect(submittedBody).not.toHaveProperty('audio')
  })

  it('submits sd8 with only its documented fields and discrete duration', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ task_id: 'sd8_task_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const result = await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd8-seedance-2.0' },
      {
        prompt: 'A stylized character crosses the courtyard.',
        seconds: 8,
        aspectRatio: '3:4',
        resolution: '1080p',
        referenceImageUrls: ['https://example.com/character.png'],
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(result).toMatchObject({ id: 'sd8_task_01', status: 'queued' })
    expect(submittedBody).toEqual({
      model: 'sd8-seedance-2.0',
      prompt: 'A stylized character crosses the courtyard.',
      aspect_ratio: '3:4',
      duration: 10,
      reference_image_urls: ['https://example.com/character.png'],
    })
  })

  it('submits MiniMax 2K without undocumented video-reference fields', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'minimax_task_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'minimax-h3-2k' },
      {
        prompt: 'A restrained cinematic close-up.',
        seconds: 7,
        aspectRatio: '16:9',
        resolution: '720p',
        referenceImageUrls: ['https://example.com/actor.png'],
        referenceVideoUrls: ['https://example.com/ignored.mp4'],
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedBody).toMatchObject({
      model: 'minimax-h3-2k',
      duration: 7,
      resolution: '2k',
      generate_audio: true,
      reference_image_urls: ['https://example.com/actor.png'],
    })
    expect(submittedBody).not.toHaveProperty('reference_videos')
  })

  it('requires an HTTPS source video for Omni V2V', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ id: 'omni_task_01', status: 'queued' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    await expect(submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'omni-v2v' },
      { prompt: 'Restyle the source video.', aspectRatio: '9:16' },
      fetchImpl as typeof fetch,
    )).rejects.toThrow('requires reference_videos')

    await expect(submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'omni-v2v' },
      { prompt: 'Restyle the source video.', referenceVideoUrls: ['http://example.com/source.mp4'] },
      fetchImpl as typeof fetch,
    )).rejects.toThrow('must contain HTTPS URLs')
  })

  it('limits the provider Seedance route to four reference images', async () => {
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
        referenceImageUrls: Array.from(
          { length: 10 },
          (_, index) => `data:image/jpeg;base64,REF${index + 1}`,
        ),
        maximumReferenceImages: 4,
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
      reference_mode: 'media',
      reference_image_urls: Array.from(
        { length: 4 },
        (_, index) => `data:image/jpeg;base64,REF${index + 1}`,
      ),
    })
    const submittedReferences = Reflect.get(submittedBody || {}, 'reference_image_urls') as string[]
    expect(submittedReferences).toHaveLength(4)
    expect(JSON.stringify(submittedBody)).not.toContain('REF5')
    expect(submittedBody).not.toHaveProperty('image_url')
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

  it('submits Seedance 2.0 Fast through the async media-reference API', async () => {
    let submittedUrl = ''
    let submittedBody: Record<string, unknown> | null = null
    const references = Array.from({ length: 10 }, (_, index) => `data:image/jpeg;base64,REF${index + 1}`)
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      submittedUrl = String(url)
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'task_fast_01',
        model: 'sd5-seedance-2.0-fast',
        status: 'queued',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd5-seedance-2.0-fast' },
      {
        prompt: '人物在庭院中缓慢转身',
        seconds: 15,
        aspectRatio: '16:9',
        resolution: '720p',
        referenceImageUrls: references,
        maximumReferenceImages: 9,
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'sd5-seedance-2.0-fast',
      duration: 15,
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: '720p',
      reference_mode: 'media',
      reference_image_urls: references.slice(0, 9),
    })
    expect(submittedBody).not.toHaveProperty('audio')
    expect(submittedBody).not.toHaveProperty('image_url')
    expect(submittedBody).not.toHaveProperty('images')
  })

  it('keeps direct Seedance audio while omitting image-reference fields in text-to-video mode', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'task_text_video_01',
        model: 'sd5-seedance-2.0',
        status: 'queued',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd5-seedance-2.0' },
      {
        prompt: 'Two fictional actors speak in a moonlit plaza.',
        seconds: 15,
        aspectRatio: '16:9',
        resolution: '720p',
        referenceImageUrls: [],
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedBody).toMatchObject({
      model: 'sd5-seedance-2.0',
      duration: 15,
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: '720p',
    })
    expect(submittedBody).not.toHaveProperty('reference_mode')
    expect(submittedBody).not.toHaveProperty('reference_image_urls')
    expect(submittedBody).not.toHaveProperty('images')
  })

  it('sanitizes provider-sensitive wording immediately before submitting', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'task_safe_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd5-seedance-2.0-fast' },
      {
        prompt: '【场景】月光悬崖。0~5s：@image1 死死抠住崖边，指尖渗血。5~15s：身体连续向下坠落，不得再次回到崖边。',
        referenceImageUrls: ['https://example.com/claire.jpg'],
      },
      fetchImpl as typeof fetch,
    )

    const body = submittedBody as Record<string, unknown> | null
    const prompt = String(body?.prompt || '')
    expect(prompt).toContain('@image1')
    expect(prompt).toContain('0~5s：')
    expect(prompt).toContain('5~15s：')
    expect(prompt).toContain('【场景】月光悬崖')
    expect(prompt).toContain('身体沿月光悬崖垂直方向持续下落并离开画面')
    expect(prompt).toContain('不得再次回到崖边')
    expect(prompt).not.toMatch(/死死抠住|指尖渗血|碎石坠落声/u)
  })

  it('enforces the 1200-character Seedance 2.0 Fast prompt limit', async () => {
    await expect(submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sd5-seedance-2.0-fast' },
      { prompt: 'x'.repeat(1201) },
      (async () => new Response('{}')) as typeof fetch,
    )).rejects.toThrow('maximum is 1200')
  })

  it('submits Sora 2 through the JSON async frame-reference API', async () => {
    let submittedBody: Record<string, unknown> | null = null
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'task_sora_01', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await submitVideoGeneration(
      { baseUrl: 'https://example.com', apiKey: 'test' },
      { mode: 'openai', model: 'sora-2-pro' },
      {
        prompt: '雨夜城市中的人物缓慢回头',
        seconds: 10,
        aspectRatio: '9:16',
        referenceImageUrls: ['https://example.com/frame.jpg', 'https://example.com/ignored.jpg'],
        generateAudio: true,
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedBody).toMatchObject({
      model: 'sora-2-pro',
      duration: 12,
      aspect_ratio: '9:16',
      generate_audio: true,
      reference_mode: 'frame',
      images: ['https://example.com/frame.jpg'],
    })
    expect(submittedBody).not.toHaveProperty('resolution')
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

  it('sends Grok canonical JSON to the unified videos route', async () => {
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
      { mode: 'openai', model: 'grok-video' },
      {
        prompt: 'faceless mannequin action preview',
        seconds: 12,
        size: '854x480',
        referenceImageUrls: ['https://example.com/reference.jpg'],
      },
      fetchImpl as typeof fetch,
    )

    expect(submittedUrl).toBe('https://example.com/v1/videos')
    expect(submittedBody).toMatchObject({
      model: 'grok-video',
      duration: 12,
      aspect_ratio: '16:9',
      resolution: '480p',
      reference_image_urls: ['https://example.com/reference.jpg'],
    })
    expect(submittedBody).not.toHaveProperty('seconds')
    expect(submittedBody).not.toHaveProperty('image_urls')
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

  it('extracts the Seedance 2.0 Fast content URL from metadata', () => {
    expect(extractVideoUrl({
      status: 'completed',
      metadata: { video_url: 'https://example.com/v1/videos/task_fast_01/content' },
    })).toBe('https://example.com/v1/videos/task_fast_01/content')
  })
})

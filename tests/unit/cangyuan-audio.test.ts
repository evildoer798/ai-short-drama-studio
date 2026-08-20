import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCangyuanAudioJob,
  readableCanvasAudioError,
  submitCangyuanAudioGeneration,
} from '@/lib/cangyuan-audio'

afterEach(() => vi.unstubAllGlobals())

describe('Cangyuan reference audio API', () => {
  it('parses create and completed task responses', () => {
    expect(parseCangyuanAudioJob({
      id: 'task_audio_1',
      model: 'gemini-music',
      status: 'queued',
    })).toMatchObject({ id: 'task_audio_1', status: 'queued', url: null })

    expect(parseCangyuanAudioJob({
      id: 'task_audio_1',
      status: 'completed',
      data: [{ url: 'https://cdn.example/audio.mp3' }],
    })).toMatchObject({
      id: 'task_audio_1',
      status: 'completed',
      url: 'https://cdn.example/audio.mp3',
    })
  })

  it('submits only the canonical fields documented by Cangyuan', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        async: true,
        model: 'gemini-music',
        prompt: '轻快的电子风格背景音乐',
        response_format: 'url',
      })
      return new Response(JSON.stringify({ id: 'task_audio_2', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(submitCangyuanAudioGeneration(
      { baseUrl: 'https://ai.cangyuansuanli.cn', apiKey: 'test-key' },
      { model: 'gemini-music', prompt: '轻快的电子风格背景音乐' },
    )).resolves.toMatchObject({ id: 'task_audio_2', status: 'queued' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai.cangyuansuanli.cn/v1/audio/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('turns provider failures into concise user messages', () => {
    expect(readableCanvasAudioError('AUDIO_API_HTTP_403: forbidden')).toContain('没有模型权限')
    expect(readableCanvasAudioError('AUDIO_TASK_TIMEOUT: task_audio_3')).toContain('生成超时')
    expect(readableCanvasAudioError('AUDIO_DOWNLOAD_FAILED: HTTP 503')).toContain('下载音频失败')
  })
})

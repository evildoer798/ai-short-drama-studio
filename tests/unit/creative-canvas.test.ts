import { describe, expect, it } from 'vitest'
import {
  canvasVideoFaceFallbackModel,
  canvasImageSize,
  canvasMediaThumbnailUrl,
  generateCanvasImageSchema,
  generateCanvasAudioSchema,
  generateCanvasVideoSchema,
  insertCanvasPromptReference,
  nextCanvasVideoNodePosition,
  nextCanvasVideoVersionTitle,
  normalizeCanvasVideoPrompt,
  normalizeCanvasImagePrompt,
  readableCanvasVideoError,
} from '@/lib/creative-canvas'

describe('creative canvas video references', () => {
  it('accepts the documented Gemini Music reference-audio request', () => {
    expect(generateCanvasAudioSchema.parse({
      prompt: '紧张悬疑的夜间追逐配乐，鼓点逐渐加快',
      model: 'gemini-music',
    })).toEqual({
      prompt: '紧张悬疑的夜间追逐配乐，鼓点逐渐加快',
      model: 'gemini-music',
    })
    expect(() => generateCanvasAudioSchema.parse({ prompt: 'x', model: 'gemini-music' })).toThrow()
  })
  it('accepts ShotLab-style image generation controls', () => {
    expect(generateCanvasImageSchema.parse({
      prompt: '雨夜街头的人物特写',
      model: 'gpt-image-2-1k',
      aspectRatio: '9:16',
      resolution: '2K',
      count: 4,
    })).toMatchObject({ aspectRatio: '9:16', resolution: '2K', count: 4 })
    expect(() => generateCanvasImageSchema.parse({
      prompt: 'too many', model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K', count: 5,
    })).toThrow()
  })

  it('maps canvas image resolution and aspect ratio to provider dimensions', () => {
    expect(canvasImageSize('1:1', '1K')).toEqual({ width: 1024, height: 1024, size: '1024x1024' })
    expect(canvasImageSize('16:9', '2K')).toEqual({ width: 2048, height: 1152, size: '2048x1152' })
    expect(canvasImageSize('9:16', '2K')).toEqual({ width: 1152, height: 2048, size: '1152x2048' })
  })

  it('uses a same-origin streaming URL for canvas thumbnails', () => {
    expect(canvasMediaThumbnailUrl('media-123')).toBe('/api/media/media-123?thumbnail=1')
  })

  it('validates image prompt reference tokens against connected images', () => {
    expect(normalizeCanvasImagePrompt('使用 @图片1 的服装，参考 @Image2 的光线', 2))
      .toBe('使用 @Image1 的服装，参考 @Image2 的光线')
    expect(() => normalizeCanvasImagePrompt('使用 @图片2', 1)).toThrow('没有对应的连线图片')
  })

  it('enables dialogue audio by default while preserving an explicit opt-out', () => {
    const base = {
      prompt: 'A woman turns toward the camera.',
      model: 'seedance-2.0',
      duration: 15,
      aspectRatio: '16:9' as const,
      resolution: '720p' as const,
    }
    expect(generateCanvasVideoSchema.parse(base).generateAudio).toBe(true)
    expect(generateCanvasVideoSchema.parse({ ...base, generateAudio: false }).generateAudio).toBe(false)
  })

  it('accepts HappyHouse 3-second 1080p canvas generation', () => {
    expect(generateCanvasVideoSchema.parse({
      prompt: 'A cinematic corridor conversation.',
      model: 'happyhouse-1.1',
      duration: 3,
      aspectRatio: '3:4',
      resolution: '1080p',
    })).toMatchObject({
      duration: 3,
      aspectRatio: '3:4',
      resolution: '1080p',
      generateAudio: true,
    })
  })

  it('accepts a 30-second Seedance 2.5 480p canvas generation', () => {
    expect(generateCanvasVideoSchema.parse({
      prompt: 'A continuous 30-second performance in one location.',
      model: 'seedance-2.5-480p',
      duration: 30,
      aspectRatio: '16:9',
      resolution: '480p',
    })).toMatchObject({ duration: 30, model: 'seedance-2.5-480p', generateAudio: true })
    expect(() => generateCanvasVideoSchema.parse({
      prompt: 'Too long.',
      model: 'seedance-2.5-480p',
      duration: 31,
      aspectRatio: '16:9',
      resolution: '480p',
    })).toThrow()
  })

  it('inserts an image mention at the current selection and keeps a usable caret', () => {
    expect(insertCanvasPromptReference({
      prompt: '人物走进房间回头。',
      selectionStart: 6,
      selectionEnd: 6,
      referenceOrder: 2,
    })).toEqual({
      prompt: '人物走进房间 @图片2 回头。',
      selection: 12,
    })
  })

  it('does not add duplicate whitespace around a mention', () => {
    expect(insertCanvasPromptReference({
      prompt: '参考  生成视频',
      selectionStart: 3,
      selectionEnd: 3,
      referenceOrder: 1,
    })).toEqual({
      prompt: '参考 @图片1 生成视频',
      selection: 7,
    })
  })

  it('inserts video and audio mentions with independent labels', () => {
    expect(insertCanvasPromptReference({
      prompt: '让节奏与画面同步',
      selectionStart: 0,
      selectionEnd: 0,
      referenceOrder: 1,
      referenceType: 'audio',
    }).prompt).toBe('@音频1 让节奏与画面同步')
    expect(insertCanvasPromptReference({
      prompt: '延续动作',
      selectionStart: 4,
      selectionEnd: 4,
      referenceOrder: 2,
      referenceType: 'video',
    }).prompt).toBe('延续动作 @视频2')
  })

  it('places each additional video version in the next free window', () => {
    const source = { positionX: 80, positionY: 120, width: 360, height: 560 }
    expect(nextCanvasVideoNodePosition(source, [source])).toEqual({ positionX: 500, positionY: 120 })
    expect(nextCanvasVideoNodePosition(source, [
      source,
      { positionX: 500, positionY: 120, width: 360, height: 560 },
    ])).toEqual({ positionX: 920, positionY: 120 })
  })

  it('assigns a stable, non-overlapping title to each video version', () => {
    expect(nextCanvasVideoVersionTitle('镜头 A', ['镜头 A'])).toBe('镜头 A · 版本 2')
    expect(nextCanvasVideoVersionTitle('镜头 A · 版本 2', [
      '镜头 A',
      '镜头 A · 版本 2',
      '镜头 A · 版本 3',
    ])).toBe('镜头 A · 版本 4')
  })

  it('maps connected Chinese image mentions to provider image tokens', () => {
    expect(normalizeCanvasVideoPrompt(
      '@图片1 作为首帧，镜头转向 @Image2，人物缓慢抬头。',
      2,
    )).toBe('@Image1 作为首帧，镜头转向 @Image2，人物缓慢抬头。')
  })

  it('rejects image mentions without a matching incoming edge', () => {
    expect(() => normalizeCanvasVideoPrompt('参考 @图片3 生成视频', 2))
      .toThrow('没有对应的连线图片')
  })

  it('normalizes image, video, and audio references independently', () => {
    expect(normalizeCanvasVideoPrompt(
      '@图片1 延续 @视频1 的动作，并跟随 @音频2 的节奏。',
      { images: 1, videos: 1, audios: 2 },
    )).toBe('@Image1 延续 @Video1 的动作，并跟随 @Audio2 的节奏。')
    expect(() => normalizeCanvasVideoPrompt(
      '跟随 @音频2 的节奏。',
      { images: 0, videos: 0, audios: 1 },
    )).toThrow('没有对应的连线音频')
  })

  it('allows text-to-video prompts when no image token is used', () => {
    expect(normalizeCanvasVideoPrompt('清晨城市街道，固定镜头。', 0))
      .toBe('清晨城市街道，固定镜头。')
  })

  it('converts provider errors to concise canvas messages', () => {
    expect(readableCanvasVideoError(
      'VIDEO_TASK_FAILED: Video generation failed without a specific reason and no failure detail',
    )).toContain('生成阶段无明确原因失败')
    expect(readableCanvasVideoError('VIDEO_TASK_FAILED: Adobe video submit failed with status 408'))
      .toContain('不会自动重复提交')
    expect(readableCanvasVideoError('VIDEO_API_ERROR: HTTP 403: no access to model'))
      .toContain('没有所选模型权限')
    expect(readableCanvasVideoError('Reference images contain real human faces'))
      .toContain('写实人脸参考图')
  })

  it('selects a regular Seedance fallback only for sd5 face restrictions', () => {
    const faceError = 'Reference images contain real human faces, use source media without real faces.'
    expect(canvasVideoFaceFallbackModel('sd5-seedance-2.0', faceError)).toBe('seedance-2.0')
    expect(canvasVideoFaceFallbackModel('sd5-seedance-2.0-fast', faceError)).toBe('seedance-2.0-fast')
    expect(canvasVideoFaceFallbackModel('seedance-2.0', faceError)).toBeNull()
    expect(canvasVideoFaceFallbackModel('sd5-seedance-2.0', 'VIDEO_TASK_TIMEOUT')).toBeNull()
  })
})

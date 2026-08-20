import { describe, expect, it } from 'vitest'
import {
  estimateVideoModelPrice,
  getVideoModelDefinition,
  parseVideoPricingCatalog,
  videoModelSupportsHumanFaceReferences,
  videoModelPromptBudget,
} from '@/lib/video-models'
import { DEFAULT_VIDEO_MODEL_ID, DEFAULT_VIDEO_RESOLUTION } from '@/lib/video-defaults'

describe('video model pricing', () => {
  it('defaults storyboard generation to Jimeng Seedance 2.0 at 720p', () => {
    expect(DEFAULT_VIDEO_MODEL_ID).toBe('seedance-2.0')
    expect(DEFAULT_VIDEO_RESOLUTION).toBe('720p')
    expect(getVideoModelDefinition(DEFAULT_VIDEO_MODEL_ID)).toMatchObject({
      label: 'seedance-2.0',
      defaultResolution: '720p',
      resolutions: ['480p', '720p'],
      supportsAudio: true,
      maximumReferenceImages: 5,
      maximumReferenceVideos: 3,
    })
  })

  it('calculates flat Grok pricing', () => {
    const model = getVideoModelDefinition('grok-video')
    expect(model).not.toBeNull()
    expect(estimateVideoModelPrice(model!, 15)).toBe(0.8)
    expect(model?.priceLabel).toBe('¥0.80/条')
    expect(model?.maximumPromptCharacters).toBe(4096)
    expect(model?.supportedDurations).toEqual([6, 10, 15])
    expect(videoModelPromptBudget(model!)).toBe(4000)
  })

  it('calculates flat Seedance Mini pricing for either resolution', () => {
    const model = getVideoModelDefinition('seedance-2.0-mini')
    expect(model).not.toBeNull()
    expect(estimateVideoModelPrice(model!, 4)).toBe(2.9)
    expect(estimateVideoModelPrice(model!, 15)).toBe(2.9)
    expect(model?.priceLabel).toBe('¥2.90/条')
    expect(model?.startingAt).toBe(false)
    expect(model?.resolutions).toEqual(['480p', '720p'])
    expect(model?.aspectRatios).toContain('21:9')
    expect(model?.maximumReferenceImages).toBe(4)
    expect(videoModelPromptBudget(model!)).toBe(1104)
  })

  it('exposes the async Seedance 2.0 Fast limits', () => {
    const model = getVideoModelDefinition('sd5-seedance-2.0-fast')
    expect(model).toMatchObject({
      priceLabel: '¥2.10/条',
      maximumReferenceImages: 9,
      maximumPromptCharacters: 1200,
      supportsAudio: true,
      resolutions: ['480p', '720p'],
      aspectRatios: ['16:9', '9:16'],
    })
    expect(videoModelPromptBudget(model!)).toBe(1104)
  })

  it('exposes both Seedance 2.5 fixed-resolution SKUs with their documented limits', () => {
    const standard = getVideoModelDefinition('seedance-2.5-480p')
    const hd = getVideoModelDefinition('seedance-2.5-720p')

    expect(standard).toMatchObject({
      priceLabel: '¥0.25/秒',
      minimumDuration: 4,
      maximumDuration: 30,
      maximumReferenceImages: 30,
      maximumPromptCharacters: 5000,
      supportsAudio: true,
      resolutions: ['480p'],
      defaultResolution: '480p',
    })
    expect(standard?.supportedDurations).toEqual(Array.from({ length: 27 }, (_value, index) => index + 4))
    expect(estimateVideoModelPrice(standard!, 30)).toBe(7.5)
    expect(videoModelPromptBudget(standard!)).toBe(4904)

    expect(hd).toMatchObject({
      priceLabel: '¥0.35/秒',
      minimumDuration: 4,
      maximumDuration: 29,
      maximumReferenceImages: 30,
      resolutions: ['720p'],
      defaultResolution: '720p',
    })
    expect(hd?.supportedDurations?.at(-1)).toBe(29)
    expect(estimateVideoModelPrice(hd!, 29)).toBeCloseTo(10.15)
  })

  it('exposes both sd6 Seedance API models with fixed resolution and no generated audio', () => {
    expect(getVideoModelDefinition('sd6-seedance-2.0-720p')).toMatchObject({
      label: 'sd6-seedance-2.0-720p',
      priceLabel: '¥4.60/条',
      supportedDurations: [4, 5, 6, 8, 10, 12, 15],
      maximumReferenceImages: 9,
      maximumPromptCharacters: 5000,
      supportsAudio: false,
      resolutions: ['720p'],
      defaultResolution: '720p',
    })
    expect(getVideoModelDefinition('sd6-seedance-2.0-1080p')).toMatchObject({
      label: 'sd6-seedance-2.0-1080p',
      priceLabel: '¥0.89/秒',
      supportsAudio: false,
      resolutions: ['1080p'],
      defaultResolution: '1080p',
    })
  })

  it('exposes sd7 with five image slots and three reference-video slots', () => {
    expect(getVideoModelDefinition('sd7-seedance-2.0-720p')).toMatchObject({
      label: 'sd7-seedance-2.0-720p',
      maximumReferenceImages: 5,
      maximumReferenceVideos: 3,
      supportsAudio: false,
      resolutions: ['720p'],
    })
  })

  it('exposes both HappyHouse fallback models with 1080p and nine references', () => {
    expect(getVideoModelDefinition('happyhouse-1.1')).toMatchObject({
      family: 'HappyHouse',
      priceLabel: '¥2.90/条',
      minimumDuration: 3,
      maximumDuration: 15,
      maximumReferenceImages: 9,
      supportsAudio: true,
      resolutions: ['720p', '1080p'],
    })
    expect(getVideoModelDefinition('happyhouse-1.0')).toMatchObject({
      family: 'HappyHouse',
      priceLabel: '¥4.50/条',
      maximumReferenceImages: 9,
    })
  })

  it('parses HappyHouse live pricing capabilities', () => {
    const catalog = parseVideoPricingCatalog({
      data: ['happyhouse-1.1', 'happyhouse-1.0'].map((model_name, index) => ({
        model_name,
        description: `Happy House ${index === 0 ? '1.1' : '1.0'}`,
        model_price: index === 0 ? 2.9 : 4.5,
        vendor_id: 8,
        billing_mode: 'per_request',
        video_ui_params: {
          referenceLimits: { images: 9 },
          params: {
            duration: { min: 3, max: 15, numericOptions: [3, 4, 15] },
            generateAudio: { enabled: true },
            resolution: { options: [{ value: '720p' }, { value: '1080p' }] },
            ratio: { options: [{ value: '16:9' }, { value: '3:4' }] },
          },
        },
      })),
    })

    expect(catalog.map((model) => model.id)).toEqual(['happyhouse-1.1', 'happyhouse-1.0'])
    expect(catalog[0]).toMatchObject({
      label: 'happyhouse-1.1',
      family: 'HappyHouse',
      minimumDuration: 3,
      supportedDurations: [3, 4, 15],
      maximumReferenceImages: 9,
      resolutions: ['720p', '1080p'],
      defaultResolution: '720p',
      supportsAudio: true,
    })
  })

  it('rejects models outside the asset-reference catalog', () => {
    expect(getVideoModelDefinition('unknown-video-model')).toBeNull()
    expect(getVideoModelDefinition('sora-2')).toMatchObject({
      family: 'Sora',
      supportedDurations: [4, 8, 12],
      maximumReferenceImages: 1,
      maximumPromptCharacters: 1200,
    })
  })

  it('distinguishes models that officially accept human face references', () => {
    expect(videoModelSupportsHumanFaceReferences(getVideoModelDefinition('sora-2-pro')!)).toBe(false)
    expect(videoModelSupportsHumanFaceReferences(getVideoModelDefinition('sd5-seedance-2.0-fast')!)).toBe(false)
    expect(videoModelSupportsHumanFaceReferences(getVideoModelDefinition('sd6-seedance-2.0-720p')!)).toBe(true)
    expect(videoModelSupportsHumanFaceReferences(getVideoModelDefinition('seedance-2.0-mini')!)).toBe(true)
    expect(videoModelSupportsHumanFaceReferences(getVideoModelDefinition('seedance-2.0-720p')!)).toBe(true)
  })

  it('builds compatible Seedance options from the live pricing payload', () => {
    const catalog = parseVideoPricingCatalog({
      data: [
        {
          model_name: 'sd5-seedance-2.0-fast',
          description: 'Seedance 2.0 Fast',
          model_price: 2.1,
          vendor_id: 12,
          billing_mode: 'per_request',
          video_ui_params: {
            referenceLimits: { images: 9 },
            params: {
              duration: { min: 4, max: 15 },
              generateAudio: { enabled: true },
              resolution: { options: [{ value: '480p' }, { value: '720p' }] },
              ratio: { options: [{ value: '16:9' }, { value: '9:16' }] },
            },
          },
        },
        {
          model_name: 'seedance-2.0-mini-480p',
          description: 'Seedance Mini 480p',
          model_price: 0.3,
          vendor_id: 12,
          billing_mode: 'per_second',
          video_ui_params: {
            params: {
              duration: { min: 4, max: 15 },
              generateAudio: { enabled: false },
              resolution: { options: [{ value: '480p' }] },
              ratio: { options: [{ value: '16:9' }, { value: '1:1' }] },
            },
          },
        },
        {
          model_name: 'seedance-2.0-mini',
          description: 'Seedance Mini',
          model_price: 2.9,
          vendor_id: 4,
          billing_mode: 'per_request',
          video_ui_params: {
            params: {
              duration: { min: 4, max: 15 },
              generateAudio: { enabled: true },
              resolution: { options: [{ value: '480p' }, { value: '720p' }] },
              ratio: { options: [{ value: '16:9' }, { value: '9:16' }] },
            },
          },
        },
        {
          model_name: 'grok-video-1.5',
          description: 'Grok 1.5 单图生视频',
          model_price: 1.1,
          vendor_id: 10,
          billing_mode: 'per_request',
          video_ui_params: {
            referenceLimits: { images: 1 },
            params: {
              duration: { min: 4, max: 15, options: [{ value: 6 }, { value: 10 }, { value: 15 }] },
              generateAudio: { enabled: false },
              resolution: { options: [{ value: '480p' }, { value: '720p' }] },
              ratio: { options: [{ value: '16:9' }, { value: '9:16' }] },
            },
          },
        },
        {
          model_name: 'seedance-2.0-4k',
          model_price: 4.5,
          billing_mode: 'per_second',
          video_ui_params: { params: { resolution: { options: [{ value: '4k' }] } } },
        },
        {
          model_name: 'sora-2',
          description: 'Sora 2',
          model_price: 0.7,
          vendor_id: 2,
          billing_mode: 'per_request',
          video_ui_params: {
            referenceLimits: { images: 1 },
            params: {
              duration: { min: 4, max: 12, numericOptions: [4, 8, 12] },
              generateAudio: { enabled: true },
              resolution: { enabled: false },
              ratio: { options: [{ value: '16:9' }, { value: '9:16' }] },
            },
          },
        },
      ],
    })

    expect(catalog.map((model) => model.id)).toEqual([
      'sd5-seedance-2.0-fast',
      'seedance-2.0-mini-480p',
      'seedance-2.0-mini',
      'grok-video-1.5',
      'seedance-2.0-4k',
      'sora-2',
    ])
    expect(catalog[0]).toMatchObject({
      priceLabel: '¥2.10/条',
      maximumReferenceImages: 9,
      maximumPromptCharacters: 1200,
      supportsAudio: true,
    })
    expect(catalog[1]).toMatchObject({
      priceLabel: '¥0.30/秒',
      priceMode: 'per_second',
      priceSource: 'live',
      supportsAudio: false,
      resolutions: ['480p'],
      aspectRatios: ['16:9', '1:1'],
    })
    expect(catalog[2]).toMatchObject({
      priceLabel: '¥2.90/条',
      unitPrice: 2.9,
      defaultResolution: '720p',
      maximumReferenceImages: 3,
    })
    expect(catalog[3]).toMatchObject({
      label: 'grok-video-1.5',
      family: 'Grok',
      priceLabel: '¥1.10/条',
      maximumReferenceImages: 1,
      maximumPromptCharacters: 4096,
      minimumDuration: 6,
      supportedDurations: [6, 10, 15],
    })
    expect(catalog[4]).toMatchObject({
      label: 'seedance-2.0-4k',
      resolutions: ['4k'],
      defaultResolution: '4k',
    })
    expect(catalog[5]).toMatchObject({
      label: 'sora-2',
      family: 'Sora',
      priceLabel: '¥0.70/条',
      maximumReferenceImages: 1,
      maximumPromptCharacters: 1200,
      supportedDurations: [4, 8, 12],
      resolutions: ['720p'],
    })
  })

  it('parses Seedance 2.5 and corrects the public 480p duration panel to the 30-second API limit', () => {
    const durationOptions = Array.from({ length: 26 }, (_value, index) => index + 4)
    const catalog = parseVideoPricingCatalog({
      data: [
        {
          model_name: 'seedance-2.5-480p',
          description: 'Seedance 2.5 standard',
          model_price: 0.25,
          vendor_id: 4,
          billing_mode: 'per_second',
          video_ui_params: {
            referenceLimits: { images: 30, videos: 10, audios: 10 },
            params: {
              duration: { min: 4, max: 29, numericOptions: durationOptions },
              generateAudio: { enabled: true },
              resolution: { enabled: false },
              ratio: { options: [{ value: '16:9' }, { value: '21:9' }, { value: '4:3' }] },
            },
          },
        },
        {
          model_name: 'seedance-2.5-720p',
          description: 'Seedance 2.5 HD',
          model_price: 0.35,
          vendor_id: 4,
          billing_mode: 'per_second',
          video_ui_params: {
            referenceLimits: { images: 30, videos: 10, audios: 10 },
            params: {
              duration: { min: 4, max: 29, numericOptions: durationOptions },
              generateAudio: { enabled: true },
              resolution: { enabled: false },
              ratio: { options: [{ value: '16:9' }, { value: '9:16' }] },
            },
          },
        },
      ],
    })

    expect(catalog).toHaveLength(2)
    expect(catalog[0]).toMatchObject({
      id: 'seedance-2.5-480p',
      label: 'seedance-2.5-480p',
      priceLabel: '¥0.25/秒',
      minimumDuration: 4,
      maximumDuration: 30,
      maximumReferenceImages: 30,
      maximumPromptCharacters: 5000,
      supportsAudio: true,
      resolutions: ['480p'],
      defaultResolution: '480p',
    })
    expect(catalog[0].supportedDurations?.at(-1)).toBe(30)
    expect(catalog[1]).toMatchObject({
      id: 'seedance-2.5-720p',
      label: 'seedance-2.5-720p',
      maximumDuration: 29,
      maximumReferenceImages: 30,
      resolutions: ['720p'],
      defaultResolution: '720p',
    })
    expect(catalog[1].supportedDurations?.at(-1)).toBe(29)
  })

  it('parses and deduplicates sd6 models by their exact API id', () => {
    const sd6 = (model_name: string, resolution: '720p' | '1080p', price: number) => ({
      model_name,
      description: `Seedance sd6 ${resolution}`,
      model_price: price,
      vendor_id: 4,
      billing_mode: resolution === '720p' ? 'per_request' : 'per_second',
      video_ui_params: {
        referenceLimits: { images: 9, videos: 3, audios: 1, total: 12 },
        params: {
          duration: { min: 4, max: 15, numericOptions: [4, 5, 6, 8, 10, 12, 15] },
          generateAudio: { enabled: false },
          resolution: { enabled: false, fixedLabel: resolution },
          ratio: { options: [{ value: '16:9' }, { value: '9:16' }, { value: '3:4' }] },
        },
      },
    })
    const catalog = parseVideoPricingCatalog({
      data: [
        sd6('sd6-seedance-2.0-720p', '720p', 4.6),
        sd6('sd6-seedance-2.0-720p', '720p', 4.6),
        sd6('sd6-seedance-2.0-1080p', '1080p', 0.89),
      ],
    })

    expect(catalog.map((model) => model.id)).toEqual([
      'sd6-seedance-2.0-720p',
      'sd6-seedance-2.0-1080p',
    ])
    expect(catalog[0]).toMatchObject({
      label: 'sd6-seedance-2.0-720p',
      family: 'Seedance',
      priceLabel: '¥4.60/条',
      supportedDurations: [4, 5, 6, 8, 10, 12, 15],
      maximumReferenceImages: 9,
      maximumPromptCharacters: 5000,
      supportsAudio: false,
      resolutions: ['720p'],
      defaultResolution: '720p',
      aspectRatios: ['16:9', '9:16', '3:4'],
    })
    expect(catalog[1]).toMatchObject({
      label: 'sd6-seedance-2.0-1080p',
      priceLabel: '¥0.89/秒',
      resolutions: ['1080p'],
      defaultResolution: '1080p',
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  estimateVideoModelPrice,
  getVideoModelDefinition,
  parseVideoPricingCatalog,
  videoModelPromptBudget,
} from '@/lib/video-models'

describe('video model pricing', () => {
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
  })

  it('rejects models outside the asset-reference catalog', () => {
    expect(getVideoModelDefinition('unknown-video-model')).toBeNull()
    expect(getVideoModelDefinition('sora-2')).toBeNull()
  })

  it('builds compatible Seedance options from the live pricing payload', () => {
    const catalog = parseVideoPricingCatalog({
      data: [
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
        { model_name: 'sora-2', model_price: 0.7, billing_mode: 'per_request' },
      ],
    })

    expect(catalog.map((model) => model.id)).toEqual([
      'seedance-2.0-mini-480p',
      'seedance-2.0-mini',
      'grok-video-1.5',
    ])
    expect(catalog[0]).toMatchObject({
      priceLabel: '¥0.30/秒',
      priceMode: 'per_second',
      priceSource: 'live',
      supportsAudio: false,
      resolutions: ['480p'],
      aspectRatios: ['16:9', '1:1'],
    })
    expect(catalog[1]).toMatchObject({
      priceLabel: '¥2.90/条',
      unitPrice: 2.9,
      defaultResolution: '720p',
    })
    expect(catalog[2]).toMatchObject({
      label: 'xAI · Grok Video 1.5',
      family: 'Grok',
      priceLabel: '¥1.10/条',
      maximumReferenceImages: 1,
      maximumPromptCharacters: 4096,
      minimumDuration: 6,
      supportedDurations: [6, 10, 15],
    })
  })
})

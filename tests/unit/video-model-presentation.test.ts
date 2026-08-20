import { describe, expect, it } from 'vitest'
import {
  groupVideoModelOptions,
  videoModelGroupId,
  videoModelOptionText,
} from '@/lib/video-model-presentation'

describe('video model presentation', () => {
  it('groups Seedance versions and Grok into stable adjacent sections', () => {
    const groups = groupVideoModelOptions([
      { id: 'grok-video-1.5', priceLabel: '¥1.39/条', available: true },
      { id: 'sd6-seedance-2.0-720p', priceLabel: '¥4.60/条', available: true },
      { id: 'seedance-2.5-720p', priceLabel: '¥0.35/秒', available: true },
      { id: 'seedance-2.0-mini-480p', priceLabel: '¥0.30/秒', available: true },
      { id: 'sora-2', priceLabel: '¥0.70/条', available: true },
    ])

    expect(groups.map((group) => group.label)).toEqual([
      'Seedance 2.5',
      'Seedance 2.0',
      'Grok',
      'Sora',
    ])
    expect(groups[1].models.map((model) => model.id)).toEqual([
      'sd6-seedance-2.0-720p',
      'seedance-2.0-mini-480p',
    ])
  })

  it('deduplicates exact API ids case-insensitively and keeps an available entry', () => {
    const groups = groupVideoModelOptions([
      { id: 'seedance-2.5-480p', priceLabel: '旧价格', available: false },
      { id: 'SEEDANCE-2.5-480P', priceLabel: '¥0.25/秒', available: true },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].models).toEqual([
      { id: 'SEEDANCE-2.5-480P', priceLabel: '¥0.25/秒', available: true },
    ])
  })

  it('uses exact API ids in option text and recognizes sd5/sd6 as Seedance 2.0', () => {
    expect(videoModelOptionText({
      id: 'sd6-seedance-2.0-720p',
      priceLabel: '¥4.60/条',
      available: true,
    })).toBe('sd6-seedance-2.0-720p · ¥4.60/条')
    expect(videoModelGroupId('sd5-seedance-2.0-fast')).toBe('seedance-2.0')
    expect(videoModelGroupId('sd6-seedance-2.0-1080p')).toBe('seedance-2.0')
  })
})

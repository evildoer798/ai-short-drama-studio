import { describe, expect, it } from 'vitest'
import {
  findCangyuanMediaPrice,
  findCangyuanRequestPrice,
  findCangyuanTokenPrice,
  parseCangyuanPricingPayload,
  parseCangyuanStatusPayload,
  pricingItemTaskType,
} from '../../src/lib/cangyuan-pricing'

const payload = parseCangyuanPricingPayload({
  success: true,
  pricing_version: 'price-v1',
  group_ratio: { VIDEO: 1, 'LLM-GPT-plus': 0.095, 'LLM-GPT-pro': 0.15 },
  data: [
    {
      model_name: 'sd7-seedance-2.0-720p',
      model_price: 3.9,
      quota_type: 1,
      billing_mode: 'per_request',
      request_unit: 'generation',
      tags: 'video,seedance',
      supported_endpoint_types: ['openai-video'],
    },
    {
      model_name: 'seedance-2.5-720p',
      model_price: 0.45,
      quota_type: 1,
      billing_mode: 'per_second',
      request_unit: 'second',
      tags: 'video,seedance',
      supported_endpoint_types: ['openai-video'],
    },
    {
      model_name: 'gpt-5.5',
      model_price: 0,
      quota_type: 0,
      model_ratio: 2.5,
      completion_ratio: 6,
      cache_ratio: 0.1,
      enable_groups: ['LLM-GPT-plus', 'LLM-GPT-pro'],
    },
  ],
})

describe('cangyuan pricing', () => {
  it('uses the exact official per-request model name and price', () => {
    const item = findCangyuanRequestPrice(payload, 'SD7-SEEDANCE-2.0-720P')
    expect(item?.model_price).toBe(3.9)
    expect(item?.request_unit).toBe('generation')
    expect(pricingItemTaskType(item!)).toBe('video')
  })

  it('does not treat token-priced models as request-priced media', () => {
    expect(findCangyuanRequestPrice(payload, 'gpt-5.5')).toBeNull()
  })

  it('resolves official per-second media pricing without treating it as a flat request', () => {
    const item = findCangyuanMediaPrice(payload, 'SEEDANCE-2.5-720P')
    expect(item).toMatchObject({
      model_price: 0.45,
      billing_mode: 'per_second',
      request_unit: 'second',
    })
    expect(findCangyuanRequestPrice(payload, 'seedance-2.5-720p')).toBeNull()
  })

  it('classifies a video with audio support by its video endpoint', () => {
    expect(pricingItemTaskType({
      model_name: 'happyhouse-1.1',
      model_price: 2.9,
      quota_type: 1,
      billing_mode: 'per_request',
      request_unit: 'generation',
      tags: 'video,audio,multi-reference',
      supported_endpoint_types: ['openai-video'],
    })).toBe('video')
  })

  it('derives the standard token rates displayed by the official page', () => {
    const price = findCangyuanTokenPrice(payload, 'gpt-5.5', 500_000)
    expect(price?.groupRatio).toBe(0.095)
    expect(price?.inputPerMillion).toBeCloseTo(0.475)
    expect(price?.outputPerMillion).toBeCloseTo(2.85)
    expect(price?.cachedInputPerMillion).toBeCloseTo(0.0475)
  })

  it('parses the live quota conversion metadata', () => {
    const status = parseCangyuanStatusPayload({
      success: true,
      data: { quota_per_unit: 500_000, quota_display_type: 'CNY' },
    })
    expect(status.data.quota_per_unit).toBe(500_000)
    expect(status.data.quota_display_type).toBe('CNY')
  })
})

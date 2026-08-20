import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverImageApiModels,
  resetImageApiPoolForTests,
  resolveImageApiKeyEntries,
  resolveImageApiProviders,
  selectCompatibleImageModel,
  shouldFailoverImageApiError,
} from '@/lib/image-api-pool'

afterEach(() => resetImageApiPoolForTests())

describe('image API key pool', () => {
  it('loads unique configured keys in stable slot order', () => {
    expect(resolveImageApiKeyEntries({
      OPENAI_COMPAT_API_KEY: ' primary ',
      OPENAI_COMPAT_API_KEY_2: 'secondary',
      OPENAI_COMPAT_API_KEY_3: 'primary',
    })).toEqual([
      { slot: 1, apiKey: 'primary' },
      { slot: 2, apiKey: 'secondary' },
    ])
  })

  it('merges model permissions from every healthy key', async () => {
    const snapshot = await discoverImageApiModels({
      baseUrl: 'https://example.com',
      source: { OPENAI_COMPAT_API_KEY: 'primary', OPENAI_COMPAT_API_KEY_2: 'secondary' },
      listModels: async (config) => config.apiKey === 'primary'
        ? ['gpt-image-2']
        : ['gpt-image-2', 'nano-banana2-1k'],
    })
    expect(snapshot.modelKeySlots.get('gpt-image-2')).toEqual([1, 2])
    expect(snapshot.modelKeySlots.get('nano-banana2-1k')).toEqual([2])
  })

  it('uses primary first and pins resumed jobs to their original slot', async () => {
    const source = { OPENAI_COMPAT_API_KEY: 'primary', OPENAI_COMPAT_API_KEY_2: 'secondary' }
    const providers = await resolveImageApiProviders({
      baseUrl: 'https://example.com',
      model: 'gpt-image-2',
      source,
      listModels: async () => ['gpt-image-2'],
    })
    expect(providers.map((provider) => provider.slot)).toEqual([1, 2])

    const resumed = await resolveImageApiProviders({
      baseUrl: 'https://example.com',
      model: 'gpt-image-2',
      preferredKeySlot: 2,
      source,
    })
    expect(resumed).toEqual([{ slot: 2, apiKey: 'secondary', model: 'gpt-image-2' }])
  })

  it('uses a slot-specific compatible provider model', async () => {
    const providers = await resolveImageApiProviders({
      baseUrl: 'https://example.com',
      model: 'gpt-image-2',
      source: {
        OPENAI_COMPAT_API_KEY: 'primary',
        OPENAI_COMPAT_API_KEY_2: 'secondary',
        OPENAI_COMPAT_IMAGE_MODEL_2: 'codex-gpt-image-2-1k',
      },
      listModels: async (config) => config.apiKey === 'primary'
        ? ['gpt-image-2']
        : ['codex-gpt-image-2-1k'],
    })
    expect(providers.map((provider) => [provider.slot, provider.model])).toEqual([
      [1, 'gpt-image-2'],
      [2, 'codex-gpt-image-2-1k'],
    ])
  })

  it('maps a retired model alias to the lowest-cost compatible model on each key', async () => {
    const providers = await resolveImageApiProviders({
      baseUrl: 'https://example.com',
      model: 'gpt-image-2',
      source: {
        OPENAI_COMPAT_API_KEY: 'primary',
        OPENAI_COMPAT_API_KEY_2: 'secondary',
        OPENAI_COMPAT_IMAGE_MODEL_2: 'retired-provider-model',
      },
      listModels: async (config) => config.apiKey === 'primary'
        ? ['gpt-image-2-4k', 'gpt-image-2-1k', 'sora-2']
        : ['gemini-banana-pro-4k', 'gemini-banana-2.0', 'veo-3-1'],
    })

    expect(providers.map((provider) => [provider.slot, provider.model])).toEqual([
      [1, 'gpt-image-2-1k'],
      [2, 'gemini-banana-2.0'],
    ])
  })

  it('never treats video-only models as an image fallback', () => {
    expect(selectCompatibleImageModel({
      requestedModel: 'retired-image-model',
      availableModels: ['sora-2', 'veo-3-1', 'sd5-seedance-2.0-fast'],
    })).toBeNull()
  })

  it('fails over for provider and credential errors but not prompt validation', () => {
    expect(shouldFailoverImageApiError(new Error('IMAGE_API_FAILED: 401 unauthorized'))).toBe(true)
    expect(shouldFailoverImageApiError(new Error('IMAGE_API_FAILED: 503 unavailable'))).toBe(true)
    expect(shouldFailoverImageApiError(new Error('IMAGE_API_FAILED: 400 model is not supported'))).toBe(true)
    expect(shouldFailoverImageApiError(new Error('IMAGE_API_FAILED: 422 invalid size'))).toBe(false)
    expect(shouldFailoverImageApiError(new Error('PROMPT_BLOCKED'))).toBe(false)
  })
})

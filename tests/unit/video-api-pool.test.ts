import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverVideoApiModels,
  resetVideoApiPoolForTests,
  resolveVideoApiKeyEntries,
  resolveVideoApiProvider,
} from '@/lib/video-api-pool'

afterEach(() => resetVideoApiPoolForTests())

describe('video API key pool', () => {
  it('loads unique configured keys in stable slot order', () => {
    expect(resolveVideoApiKeyEntries({
      VIDEO_API_KEY: ' primary ',
      VIDEO_API_KEY_2: 'secondary',
      VIDEO_API_KEY_3: 'primary',
    })).toEqual([
      { slot: 1, apiKey: 'primary' },
      { slot: 2, apiKey: 'secondary' },
    ])
  })

  it('merges model permissions from every healthy key', async () => {
    const snapshot = await discoverVideoApiModels({
      baseUrl: 'https://example.com',
      mode: 'auto',
      source: { VIDEO_API_KEY: 'primary', VIDEO_API_KEY_2: 'secondary' },
      listModels: async (config) => config.apiKey === 'primary'
        ? ['sd5-seedance-2.0-fast']
        : ['sd5-seedance-2.0', 'sd5-seedance-2.0-fast'],
    })
    expect(snapshot.modelIds).toEqual(['sd5-seedance-2.0-fast', 'sd5-seedance-2.0'])
    expect(snapshot.modelKeySlots.get('sd5-seedance-2.0')).toEqual([2])
    expect(snapshot.modelKeySlots.get('sd5-seedance-2.0-fast')).toEqual([1, 2])
  })

  it('keeps polling on the key slot that created an async job', async () => {
    const provider = await resolveVideoApiProvider({
      baseUrl: 'https://example.com',
      mode: 'auto',
      model: 'sd5-seedance-2.0',
      preferredKeySlot: 2,
      source: { VIDEO_API_KEY: 'primary', VIDEO_API_KEY_2: 'secondary' },
    })
    expect(provider).toMatchObject({
      keySlot: 2,
      config: { apiKey: 'secondary', model: 'sd5-seedance-2.0' },
    })
  })
})

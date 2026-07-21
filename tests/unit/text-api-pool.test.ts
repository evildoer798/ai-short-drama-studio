import { describe, expect, it } from 'vitest'
import {
  orderedTextApiKeyIndexes,
  resolveTextApiKeys,
  resolveTextFallbackApiKeys,
  resolveTextTertiaryApiKeys,
  storyboardTextKeyPasses,
  textStoryboardParallelism,
} from '../../src/lib/text-api-pool'

describe('text API key pool', () => {
  it('uses numbered keys in order and removes duplicates', () => {
    expect(resolveTextApiKeys({
      TEXT_API_KEY: 'legacy-key',
      TEXT_API_KEY_1: ' key-a ',
      TEXT_API_KEY_2: 'key-b',
      TEXT_API_KEY_3: 'key-a',
    })).toEqual(['key-a', 'key-b'])
  })

  it('falls back to the legacy provider key when no pool is configured', () => {
    expect(resolveTextApiKeys({ OPENAI_COMPAT_API_KEY: 'image-key' })).toEqual(['image-key'])
  })

  it('keeps a numbered fallback provider pool separate from the primary key', () => {
    expect(resolveTextFallbackApiKeys({
      TEXT_API_KEY: 'deepseek-key',
      TEXT_FALLBACK_API_KEY: 'legacy-cangyuan-key',
      TEXT_FALLBACK_API_KEY_1: 'cangyuan-a',
      TEXT_FALLBACK_API_KEY_2: 'cangyuan-b',
    })).toEqual(['cangyuan-a', 'cangyuan-b'])
  })

  it('supports a numbered tertiary provider pool', () => {
    expect(resolveTextTertiaryApiKeys({
      TEXT_TERTIARY_API_KEY: 'legacy-key',
      TEXT_TERTIARY_API_KEY_1: 'cangyuan-a',
      TEXT_TERTIARY_API_KEY_2: 'cangyuan-b',
      TEXT_TERTIARY_API_KEY_3: 'cangyuan-a',
    })).toEqual(['cangyuan-a', 'cangyuan-b'])
  })

  it('assigns a sticky key and rotates through the remaining pool', () => {
    expect(orderedTextApiKeyIndexes(4, 2)).toEqual([2, 3, 0, 1])
    expect(orderedTextApiKeyIndexes(4, 6)).toEqual([2, 3, 0, 1])
  })

  it('covers all ten keys in five non-overlapping storyboard passes', () => {
    expect(storyboardTextKeyPasses(10, 8)).toEqual([8, 0, 2, 4, 6])
    const covered = storyboardTextKeyPasses(10, 8).flatMap((start) => (
      orderedTextApiKeyIndexes(10, start).slice(0, 2)
    ))
    expect(new Set(covered)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
  })

  it('caps cross-episode concurrency by keys and pending episodes', () => {
    expect(textStoryboardParallelism({ requested: 10, keyCount: 10, pendingEpisodeCount: 7 })).toBe(7)
    expect(textStoryboardParallelism({ requested: 10, keyCount: 3, pendingEpisodeCount: 15 })).toBe(3)
  })
})

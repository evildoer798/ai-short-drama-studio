import { describe, expect, it } from 'vitest'
import { extractAssetsSchema } from '@/lib/preproduction'

describe('preproduction request schemas', () => {
  it('accepts one or more storyboarded episodes for incremental asset planning', () => {
    expect(extractAssetsSchema.parse({
      refreshDrafts: true,
      episodeIds: ['episode-2', 'episode-3', 'episode-2'],
    })).toEqual({
      refreshDrafts: true,
      episodeIds: ['episode-2', 'episode-3', 'episode-2'],
    })
  })

  it('keeps episode scope optional for legacy full-project requests', () => {
    expect(extractAssetsSchema.parse({})).toEqual({ refreshDrafts: true })
  })
})

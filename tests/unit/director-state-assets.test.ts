import { describe, expect, it } from 'vitest'
import {
  identityMasterPromptFor,
  identityMasterStateId,
  identityMasterVersionIdFromPayload,
  isIdentityMasterStateId,
  lockedStateMediaIds,
  stateIdsForShot,
  unresolvedStateAssetIds,
} from '@/lib/director-state-assets'
import type { LiraStageOutput } from '@/lib/director-system'

describe('Director character-state asset flow', () => {
  it('maps a shot to only its locked character-state images', () => {
    const lira = { keyframes: [{ shotKey: 'shot-1', characterStateIds: ['claire-awake'] }] } as LiraStageOutput
    const ids = stateIdsForShot(lira, 'shot-1')
    expect(lockedStateMediaIds([
      { stateId: 'claire-awake', selectedImageVersion: { mediaId: 'media-awake' } },
      { stateId: 'claire-wolf', selectedImageVersion: { mediaId: 'media-wolf' } },
    ], ids)).toEqual(['media-awake'])
  })

  it('blocks LIRA confirmation while any state image is not locked', () => {
    expect(unresolvedStateAssetIds([
      { stateId: 'locked', selectedImageVersionId: 'version-1' },
      { stateId: 'missing', selectedImageVersionId: null },
    ])).toEqual(['missing'])
  })

  it('creates a stable identity-master id without colliding with shot state ids', () => {
    expect(identityMasterStateId('claire')).toBe('__identity__:claire')
    expect(isIdentityMasterStateId('__identity__:claire')).toBe(true)
    expect(isIdentityMasterStateId('claire-awake')).toBe(false)
  })

  it('builds a neutral identity prompt from immutable anchors', () => {
    const prompt = identityMasterPromptFor('Claire', [{
      identityAnchors: ['oval face', 'gray eyes'],
      wardrobe: 'black coat',
      hairMakeup: 'long silver hair',
    }] as LiraStageOutput['characterStates'])
    expect(prompt).toContain('canonical initial character identity')
    expect(prompt).toContain('oval face; gray eyes')
    expect(prompt).toContain('Neutral standing pose')
    expect(prompt).toContain('No injuries')
  })

  it('records which identity-master version generated a state image', () => {
    expect(identityMasterVersionIdFromPayload({ identityMasterVersionId: 'master-v2' })).toBe('master-v2')
    expect(identityMasterVersionIdFromPayload({})).toBeNull()
    expect(identityMasterVersionIdFromPayload(null)).toBeNull()
  })
})

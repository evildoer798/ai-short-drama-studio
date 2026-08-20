import { describe, expect, it } from 'vitest'
import { resolveMediaProjectId } from '@/lib/media-access'

describe('resolveMediaProjectId', () => {
  it('resolves Director keyframe image ownership through its production', () => {
    expect(resolveMediaProjectId({
      directorImageVersions: [{ keyframe: { production: { projectId: 'director-project' } } }],
    })).toBe('director-project')
  })

  it('resolves Director video ownership through its production', () => {
    expect(resolveMediaProjectId({
      directorVideoVersions: [{ shot: { production: { projectId: 'director-project' } } }],
    })).toBe('director-project')
  })

  it('resolves Director character-state image ownership through its production', () => {
    expect(resolveMediaProjectId({
      directorStateImageVersions: [{ stateAsset: { production: { projectId: 'director-project' } } }],
    })).toBe('director-project')
  })

  it('keeps existing asset media ownership behavior', () => {
    expect(resolveMediaProjectId({ images: [{ asset: { projectId: 'asset-project' } }] })).toBe('asset-project')
    expect(resolveMediaProjectId(null)).toBeNull()
  })
})

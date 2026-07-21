import { describe, expect, it } from 'vitest'
import {
  attachmentContentDisposition,
  buildProjectRenderStorageKey,
  buildStorageKey,
  extensionForMime,
} from '@/lib/storage'

describe('storage helpers', () => {
  it('maps image mime types to stable extensions', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/webp')).toBe('webp')
    expect(extensionForMime('image/png')).toBe('png')
  })

  it('builds project-scoped storage keys', () => {
    const key = buildStorageKey({
      projectId: 'project_1',
      assetId: 'asset_1',
      mimeType: 'image/png',
    })

    expect(key).toMatch(/^projects\/project_1\/assets\/asset_1\/.+\.png$/)
  })

  it('builds mp4 keys for project renders', () => {
    const key = buildProjectRenderStorageKey({ projectId: 'project_1', mimeType: 'video/mp4' })
    expect(key).toMatch(/^projects\/project_1\/renders\/.+\.mp4$/)
  })

  it('builds a safe UTF-8 attachment filename', () => {
    const value = attachmentContentDisposition('Demo 项目成片.mp4')
    expect(value).toContain('attachment;')
    expect(value).toContain('filename="Demo ____.mp4"')
    expect(value).toContain("filename*=UTF-8''Demo%20%E9%A1%B9%E7%9B%AE%E6%88%90%E7%89%87.mp4")
  })
})

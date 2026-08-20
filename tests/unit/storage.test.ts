import { describe, expect, it } from 'vitest'
import {
  attachmentContentDisposition,
  buildStorageKey,
  extensionForMime,
  publicStorageEndpoint,
} from '@/lib/storage'

describe('storage helpers', () => {
  it('uses the public OSS endpoint for browser media delivery', () => {
    expect(publicStorageEndpoint('https://s3.oss-cn-hangzhou-internal.aliyuncs.com'))
      .toBe('https://oss-cn-hangzhou.aliyuncs.com')
    expect(publicStorageEndpoint('https://s3.oss-cn-hangzhou.aliyuncs.com'))
      .toBe('https://oss-cn-hangzhou.aliyuncs.com')
    expect(publicStorageEndpoint('https://s3.example.com')).toBe('https://s3.example.com')
  })

  it('maps image mime types to stable extensions', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/webp')).toBe('webp')
    expect(extensionForMime('image/png')).toBe('png')
  })

  it('maps reference-audio mime types to playable extensions', () => {
    expect(extensionForMime('audio/mpeg')).toBe('mp3')
    expect(extensionForMime('audio/wav')).toBe('wav')
    expect(extensionForMime('audio/aac')).toBe('aac')
    expect(extensionForMime('audio/ogg')).toBe('ogg')
  })

  it('builds project-scoped storage keys', () => {
    const key = buildStorageKey({
      projectId: 'project_1',
      assetId: 'asset_1',
      mimeType: 'image/png',
    })

    expect(key).toMatch(/^projects\/project_1\/assets\/asset_1\/.+\.png$/)
  })
  it('builds a safe UTF-8 attachment filename', () => {
    const value = attachmentContentDisposition('Demo 分镜视频.mp4')
    expect(value).toContain('attachment;')
    expect(value).toContain('filename="Demo ____.mp4"')
    expect(value).toContain("filename*=UTF-8''Demo%20%E5%88%86%E9%95%9C%E8%A7%86%E9%A2%91.mp4")
  })
})

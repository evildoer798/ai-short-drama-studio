import { describe, expect, it } from 'vitest'
import {
  buildStoryboardVideoDisplayName,
  buildStoryboardVideoDownloadFilename,
  renameStoryboardVideoSchema,
} from '@/lib/storyboard-video-names'

describe('storyboard video names', () => {
  it('builds a useful fallback name for old videos', () => {
    expect(buildStoryboardVideoDisplayName({
      episodeNumber: 2,
      storyboardNumber: 7,
      storyboardTitle: '雨夜来电',
      sourceCount: 4,
      createdAt: new Date(2026, 6, 22, 14, 5, 9),
    })).toBe('第02集-分镜07-组合4镜-雨夜来电-20260722-140509')
  })

  it('keeps a valid custom name and appends the extension once', () => {
    const displayName = buildStoryboardVideoDisplayName({
      customName: '第一集-雨夜来电.mp4',
      storyboardNumber: 1,
      createdAt: new Date(),
    })
    expect(buildStoryboardVideoDownloadFilename({ displayName })).toBe('第一集-雨夜来电.mp4')
  })

  it('rejects path separators and control characters', () => {
    expect(() => renameStoryboardVideoSchema.parse({ name: '../第一集' })).toThrow()
    expect(() => renameStoryboardVideoSchema.parse({ name: '第一集\n视频' })).toThrow()
  })
})

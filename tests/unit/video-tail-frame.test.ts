import { describe, expect, it } from 'vitest'
import { proxiedMediaSource } from '@/lib/video-tail-frame'

describe('proxiedMediaSource', () => {
  it('forces authenticated media URLs through the same-origin proxy for canvas capture', () => {
    expect(proxiedMediaSource('/api/media/media_1?direct=1', 'https://imaideo.xyz/canvas'))
      .toBe('/api/media/media_1?direct=1&proxy=1')
  })

  it('leaves external object-storage URLs unchanged', () => {
    const source = 'https://oss-cn-hangzhou.aliyuncs.com/bucket/video.mp4'
    expect(proxiedMediaSource(source, 'https://imaideo.xyz/canvas')).toBe(source)
  })
})

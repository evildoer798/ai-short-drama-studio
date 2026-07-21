import { describe, expect, it } from 'vitest'
import {
  buildProjectRenderFilter,
  createProjectRenderSchema,
} from '@/lib/project-renders'

describe('project render request', () => {
  it('applies safe defaults', () => {
    const result = createProjectRenderSchema.parse({ sourceVideoIds: ['video-1'] })

    expect(result).toEqual({
      title: '项目成片',
      aspectRatio: '16:9',
      sourceVideoIds: ['video-1'],
    })
  })

  it('rejects an empty or duplicated timeline', () => {
    expect(() => createProjectRenderSchema.parse({ sourceVideoIds: [] })).toThrow()
    expect(() => createProjectRenderSchema.parse({
      sourceVideoIds: ['video-1', 'video-1'],
    })).toThrow('镜头不能重复')
  })
})

describe('project render filter', () => {
  it('normalizes video and supplies silence for clips without audio', () => {
    const filter = buildProjectRenderFilter({
      width: 1280,
      height: 720,
      clips: [
        { duration: 4, hasAudio: true },
        { duration: 5.25, hasAudio: false },
      ],
    })

    expect(filter).toContain('[0:v:0]scale=1280:720')
    expect(filter).toContain('[0:a:0]aresample=48000')
    expect(filter).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
    expect(filter).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]')
  })
})

import { describe, expect, it } from 'vitest'
import {
  planVideoReferences,
  referenceMontagePrompt,
} from '@/lib/video-reference-plan'

describe('video reference planning', () => {
  it('keeps the first five assets as images and turns each overflow image into its own video', () => {
    const ids = Array.from({ length: 8 }, (_value, index) => `media-${index + 1}`)
    expect(planVideoReferences(ids, 5, 3)).toEqual({
      imageMediaIds: ids.slice(0, 5),
      videoGroups: [[ids[5]], [ids[6]], [ids[7]]],
      rejectedMediaIds: [],
      totalCapacity: 8,
    })
  })

  it('deduplicates without changing priority and reports assets beyond total capacity', () => {
    const ids = Array.from({ length: 9 }, (_value, index) => `media-${index + 1}`)
    const plan = planVideoReferences([ids[0], ids[0], ...ids.slice(1)], 5, 3)
    expect(plan.imageMediaIds).toEqual(ids.slice(0, 5))
    expect(plan.videoGroups).toEqual([[ids[5]], [ids[6]], [ids[7]]])
    expect(plan.rejectedMediaIds).toEqual([ids[8]])
  })

  it('does not silently pack images for models without video references', () => {
    expect(planVideoReferences(['a', 'b', 'c'], 2, 0)).toMatchObject({
      imageMediaIds: ['a', 'b'],
      videoGroups: [],
      rejectedMediaIds: ['c'],
    })
  })

  it('labels montage videos as static asset references in the submitted prompt', () => {
    expect(referenceMontagePrompt('角色穿过走廊。', 100)).toContain('每段参考视频仅包含一张静态资产图且无声音')
    expect(referenceMontagePrompt('角色穿过走廊。', 100)).toContain('不代表动作或时间顺序')
    expect(() => referenceMontagePrompt('x'.repeat(70), 100)).toThrow('VIDEO_PROMPT_TOO_LONG_WITH_REFERENCE_MONTAGE')
  })
})

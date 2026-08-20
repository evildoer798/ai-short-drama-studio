import { describe, expect, it } from 'vitest'
import { adaptScriptSchema } from '../../src/lib/preproduction'
import {
  MAX_EPISODE_MINUTES,
  recommendAdaptationPlan,
} from '../../src/lib/adaptation-recommendation'

describe('adaptation recommendation', () => {
  it('recommends a chapter-aligned plan without exceeding three minutes per episode', () => {
    const content = Array.from({ length: 12 }, (_, index) => [
      `第${index + 1}章 转折`,
      '林晨进入新的场景，冲突升级，人物关系发生变化。'.repeat(85),
    ].join('\n')).join('\n\n')

    const recommendation = recommendAdaptationPlan(content)

    expect(recommendation).not.toBeNull()
    expect(recommendation?.chapterCount).toBe(12)
    expect(recommendation?.targetEpisodeCount).toBe(12)
    expect(recommendation?.episodeMinutes).toBeLessThanOrEqual(MAX_EPISODE_MINUTES)
    expect(recommendation?.reason).toContain('识别到 12 个章节标题')
  })

  it('reserves more screen time for dialogue-heavy material than prose of similar length', () => {
    const dialogue = Array.from({ length: 120 }, (_, index) => (
      `林晨：第${index + 1}次确认这件事，我不会放弃这段关系。`
    )).join('\n')
    const prose = '林晨沿着街道继续前行，回忆过去并重新思考两个人的关系。'.repeat(120)

    const dialoguePlan = recommendAdaptationPlan(dialogue)
    const prosePlan = recommendAdaptationPlan(prose)

    expect(dialoguePlan?.dialogueRatio).toBeGreaterThan(prosePlan?.dialogueRatio || 0)
    expect(dialoguePlan?.estimatedScreenMinutes).toBeGreaterThan(prosePlan?.estimatedScreenMinutes || 0)
  })

  it('caps oversized material at sixty three-minute episodes and recommends splitting it', () => {
    const recommendation = recommendAdaptationPlan('剧情持续推进，人物关系不断反转。'.repeat(16_000))

    expect(recommendation).toMatchObject({
      targetEpisodeCount: 60,
      episodeMinutes: 3,
      capacityLimited: true,
    })
    expect(recommendation?.reason).toContain('建议拆分原文')
  })

  it('does not recommend a plan before enough source content exists', () => {
    expect(recommendAdaptationPlan('内容太短')).toBeNull()
  })

  it('enforces the three-minute limit in the adaptation API schema', () => {
    expect(adaptScriptSchema.parse({ targetEpisodeCount: 10, episodeMinutes: 3 }))
      .toMatchObject({ episodeMinutes: 3 })
    expect(() => adaptScriptSchema.parse({ targetEpisodeCount: 10, episodeMinutes: 3.5 }))
      .toThrow()
  })
})

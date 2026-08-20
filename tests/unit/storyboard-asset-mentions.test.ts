import { describe, expect, it } from 'vitest'
import {
  activeStoryboardAssetMention,
  insertStoryboardAssetMention,
  removeStoryboardAssetMention,
  replaceActiveStoryboardAssetMention,
} from '@/lib/storyboard-asset-mentions'

const prompt = [
  '【风格基调】',
  '电影级动漫写实。',
  '【本分镜人物】',
  '秦绾绾站在石桌旁。',
  '【场景】',
  '夜晚｜农家小院。',
  '【视频分镜】',
  '0~5s：秦绾绾抬眼。',
].join('\n')

describe('storyboard asset mentions', () => {
  it('inserts a character beneath 本分镜人物', () => {
    const result = insertStoryboardAssetMention(prompt, { name: '裴九棠', type: 'character' })
    expect(result).toContain('【本分镜人物】\n@裴九棠\n秦绾绾站在石桌旁。')
  })

  it('inserts a location or prop beneath 场景', () => {
    const withLocation = insertStoryboardAssetMention(prompt, { name: '农家小院', type: 'location' })
    const withProp = insertStoryboardAssetMention(prompt, { name: '同心结', type: 'prop' })
    expect(withLocation).toContain('【场景】\n@农家小院\n夜晚｜农家小院。')
    expect(withProp).toContain('【场景】\n@同心结\n夜晚｜农家小院。')
  })

  it('avoids duplicate mentions and can remove a manual mention', () => {
    const once = insertStoryboardAssetMention(prompt, { name: '裴九棠', type: 'character' })
    const twice = insertStoryboardAssetMention(once, { name: '裴九棠', type: 'character' })
    expect(twice.match(/@裴九棠/gu)).toHaveLength(1)
    expect(removeStoryboardAssetMention(twice, '裴九棠')).not.toContain('@裴九棠')
  })

  it('detects an active @ query at the caret without treating email text as an asset mention', () => {
    expect(activeStoryboardAssetMention('画面中出现 @农家', 9)).toEqual({
      start: 6,
      end: 9,
      query: '农家',
    })
    expect(activeStoryboardAssetMention('联系 user@example.com', 15)).toBeNull()
    expect(activeStoryboardAssetMention('下一行：\n@', 6)).toEqual({ start: 5, end: 6, query: '' })
    expect(activeStoryboardAssetMention('画面中出现 @农家小院 月光', 14)).toBeNull()
  })

  it('replaces the active @ query with the selected asset and returns the next caret position', () => {
    const result = replaceActiveStoryboardAssetMention({
      prompt: '夜晚，@农家 月光洒在地面。',
      mention: { start: 3, end: 6, query: '农家' },
      assetName: '农家小院',
    })
    expect(result.prompt).toBe('夜晚，@农家小院 月光洒在地面。')
    expect(result.cursor).toBe(8)
  })
})

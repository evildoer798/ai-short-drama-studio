import { describe, expect, it } from 'vitest'
import {
  calculateSceneConsistency,
  storyboardLocationName,
  storyboardLocationNames,
} from '@/lib/scene-consistency'

describe('storyboard and asset scene consistency', () => {
  const storyboards = [
    { notes: '凌晨｜翡翠山庄34号客厅\n接续上一镜尾帧：林晨站在玄关。' },
    { notes: '凌晨｜老陈中餐门口' },
    { notes: '凌晨｜翡翠山庄34号客厅' },
  ]

  it('extracts the exact standard scene name from storyboard notes', () => {
    expect(storyboardLocationName(storyboards[0])).toBe('翡翠山庄34号客厅')
    expect(storyboardLocationNames({
      notes: '凌晨｜老陈中餐门口；凌晨｜翡翠山庄34号客厅',
    })).toEqual(['老陈中餐门口', '翡翠山庄34号客厅'])
    expect(storyboardLocationNames({
      notes: '凌晨｜老陈中餐门口｜密集秋雨、油腻屋檐、湿砖墙',
    })).toEqual(['老陈中餐门口'])
  })

  it('requires exact asset names and reports every missing storyboard scene', () => {
    const partial = calculateSceneConsistency(storyboards, [
      { type: 'location', name: '翡翠山庄34号客厅' },
      { type: 'location', name: '老陈餐馆门口' },
      { type: 'character', name: '林晨' },
    ])
    expect(partial.total).toBe(2)
    expect(partial.matched).toBe(1)
    expect(partial.missingNames).toEqual(['老陈中餐门口'])
    expect(partial.exact).toBe(false)

    const complete = calculateSceneConsistency(storyboards, [
      { type: 'location', name: '翡翠山庄34号客厅' },
      { type: 'location', name: '老陈中餐门口' },
    ])
    expect(complete.exact).toBe(true)
  })
})

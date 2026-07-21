import { describe, expect, it } from 'vitest'
import { splitAssetHighlights } from '@/lib/asset-highlights'

const assets = [
  {
    id: 'mother',
    name: '苏文菁',
    type: 'character' as const,
    referenceOrder: 1,
    highlightTerms: ['苏文菁'],
  },
  {
    id: 'daughter',
    name: '陈蕊（Jessica）',
    type: 'character' as const,
    referenceOrder: 2,
    highlightTerms: ['陈蕊（Jessica）', '陈蕊', 'Jessica'],
  },
  {
    id: 'room',
    name: '翡翠山庄别墅客厅',
    type: 'location' as const,
    referenceOrder: 3,
    highlightTerms: ['翡翠山庄别墅客厅'],
  },
  {
    id: 'prop',
    name: '别墅入口门卡',
    type: 'prop' as const,
    referenceOrder: 4,
    highlightTerms: ['入口', '门卡'],
  },
]

describe('asset prompt highlights', () => {
  it('marks asset names, aliases, and reference tokens inline', () => {
    const segments = splitAssetHighlights(
      '@image1 苏文菁看向 @image2 陈蕊（Jessica），Jessica 回答。',
      assets,
    )
    const highlighted = segments.filter((segment) => segment.assetId)

    expect(highlighted.map((segment) => segment.text)).toEqual([
      '@image1',
      '苏文菁',
      '@image2',
      '陈蕊（Jessica）',
      'Jessica',
    ])
    expect(highlighted.every((segment) => segment.assetType === 'character')).toBe(true)
  })

  it('keeps unmatched prompt text untouched', () => {
    expect(splitAssetHighlights('夜晚客厅，镜头缓慢推进。', assets)).toEqual([
      { text: '夜晚客厅，镜头缓慢推进。' },
    ])
  })

  it('highlights only recognized characters and locations, never props or generic tags', () => {
    const segments = splitAssetHighlights(
      '苏文菁走进翡翠山庄别墅客厅，经过入口并拿起门卡。',
      assets,
    )
    const highlighted = segments.filter((segment) => segment.assetId)

    expect(highlighted.map((segment) => segment.text)).toEqual(['苏文菁', '翡翠山庄别墅客厅'])
    expect(highlighted.every((segment) => segment.assetType !== 'prop')).toBe(true)
  })
})

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
      [
        '【本分镜人物】',
        '@image1 苏文菁；@image2 陈蕊（Jessica），英文名 Jessica。',
        '【场景】',
        '翡翠山庄别墅客厅。',
        '【视频分镜】',
        '苏文菁看向陈蕊（Jessica），Jessica 回答。',
      ].join('\n'),
      assets,
    )
    const highlighted = segments.filter((segment) => segment.assetId)

    expect(highlighted.map((segment) => segment.text)).toEqual([
      '@image1',
      '苏文菁',
      '@image2',
      '陈蕊（Jessica）',
      'Jessica',
      '翡翠山庄别墅客厅',
    ])
    expect(highlighted.filter((segment) => segment.assetType === 'character')).toHaveLength(5)
  })

  it('keeps unmatched prompt text untouched', () => {
    expect(splitAssetHighlights('夜晚客厅，镜头缓慢推进。', assets)).toEqual([
      { text: '夜晚客厅，镜头缓慢推进。' },
    ])
  })

  it('does not turn generic prop tags into asset highlights', () => {
    const segments = splitAssetHighlights(
      [
        '【人物及初始站位】',
        '苏文菁站在入口。',
        '【场景】',
        '翡翠山庄别墅客厅，入口旁放着门卡。',
        '【视频分镜】',
        '苏文菁走进翡翠山庄别墅客厅，经过入口并拿起门卡。',
      ].join('\n'),
      assets,
    )
    const highlighted = segments.filter((segment) => segment.assetId)

    expect(highlighted.map((segment) => segment.text)).toEqual(['苏文菁', '翡翠山庄别墅客厅'])
    expect(highlighted.every((segment) => segment.assetType !== 'prop')).toBe(true)
  })

  it('highlights an explicitly mentioned prop inside the scene section', () => {
    const segments = splitAssetHighlights([
      '【本分镜人物】',
      '苏文菁。',
      '【场景】',
      '@别墅入口门卡',
      '【视频分镜】',
      '苏文菁拿起门卡。',
    ].join('\n'), assets)
    expect(segments.filter((segment) => segment.assetType === 'prop').map((segment) => segment.text))
      .toEqual(['别墅入口门卡'])
  })

  it('does not highlight repeated character names after the opening cast mapping', () => {
    const segments = splitAssetHighlights([
      '【本分镜人物】',
      '@image1=苏文菁；@image2=陈蕊（Jessica）。',
      '【场景】',
      '翡翠山庄别墅客厅。',
      '【视频分镜】',
      '0~5s：苏文菁质问陈蕊，陈蕊看向苏文菁。',
    ].join('\n'), assets)
    const highlightedCharacters = segments.filter((segment) => segment.assetType === 'character')

    expect(highlightedCharacters.map((segment) => segment.text)).toEqual([
      '@image1',
      '苏文菁',
      '@image2',
      '陈蕊（Jessica）',
    ])
  })
})

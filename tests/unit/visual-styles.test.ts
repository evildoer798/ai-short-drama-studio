import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildStyleLock,
  buildStyledAssetPrompt,
  VISUAL_STYLE_PRESETS,
} from '@/lib/visual-styles'

describe('project visual styles', () => {
  it('provides all four supported style families', () => {
    expect(Object.keys(VISUAL_STYLE_PRESETS)).toEqual([
      'photorealistic',
      'anime_2d',
      'anime_3d',
      'chibi',
    ])
  })

  it('locks the selected style into an asset prompt', () => {
    const prompt = buildStyledAssetPrompt({
      asset: {
        type: AssetType.character,
        name: '陈蕊',
        description: '18 岁艺术史学生，黑色中长发。',
        prompt: '角色三视图，耶鲁卫衣。',
      },
      visualStyle: VisualStyle.anime_2d,
    })

    expect(prompt).toContain('项目统一画风：2D 动漫')
    expect(prompt).toContain('禁止 3D 渲染和真人照片质感')
    expect(prompt).toContain('角色三视图，耶鲁卫衣')
    expect(prompt).toContain('面部身份、发型、体型、服装')
  })

  it('adds custom project rules to image and video prompts', () => {
    const imageLock = buildStyleLock(
      VisualStyle.photorealistic,
      '全片使用雨夜冷色调。',
      'image',
    )
    const videoLock = buildStyleLock(
      VisualStyle.photorealistic,
      '全片使用雨夜冷色调。',
      'video',
    )

    expect(imageLock).toContain('全片使用雨夜冷色调')
    expect(videoLock).toContain('服装、发型、肤色、场景陈设保持稳定')
  })
})

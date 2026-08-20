import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildCharacterIdentityAnchor,
  buildStyleLock,
  buildStyledAssetPrompt,
  VISUAL_STYLE_PRESETS,
} from '@/lib/visual-styles'

describe('project visual styles', () => {
  it('provides all five supported style families', () => {
    expect(Object.keys(VISUAL_STYLE_PRESETS)).toEqual([
      'photorealistic',
      'overseas_live_action',
      'anime_2d',
      'anime_3d',
      'chibi',
    ])
  })

  it('locks North American live-action production rules without overriding scripted ethnicity', () => {
    const imagePrompt = buildStyledAssetPrompt({
      asset: {
        type: AssetType.character,
        name: '林晨',
        description: '华裔青年，生活在纽约。',
        prompt: '人物设定板，深色防水外套。',
      },
      visualStyle: VisualStyle.overseas_live_action,
    })
    const videoLock = buildStyleLock(
      VisualStyle.overseas_live_action,
      null,
      'video',
    )

    expect(imagePrompt).toContain('【海外真人短剧】')
    expect(imagePrompt).toContain('北美市场美式真人短剧')
    expect(imagePrompt).toContain('人物族裔服从剧本与资产')
    expect(imagePrompt).toContain('只用自然英语，不出现中文')
    expect(videoLock).toContain('北美与全球英语市场')
    expect(videoLock).toContain('对白和旁白必须使用自然美式英语')
    expect(videoLock).toContain('同一角色跨分镜保持相同音色')
    expect(videoLock).toContain('不得擅自换脸或改成其他族裔')
    expect(imagePrompt).toContain('狼族、Alpha、Luna、王族和长老仅是身份')
    expect(videoLock).toContain('除非当前时间段明确写出变身或狼形')
    expect(videoLock).toContain('禁止狼头人身、兽耳、长吻')
    expect(videoLock).toContain('不要字幕、海报文字、Logo、排行榜或 App UI')
  })

  it('keeps the selected overseas style ahead of a legacy style marker', () => {
    const prompt = buildStyledAssetPrompt({
      asset: {
        type: AssetType.location,
        name: '纽约公寓',
        description: '曼哈顿公寓客厅。',
        prompt: '【真人写实】旧版写实提示词。',
      },
      visualStyle: VisualStyle.overseas_live_action,
    })

    expect(prompt.startsWith('【海外真人短剧】')).toBe(true)
  })

  it('locks the 3D preset to mature semi-realistic Chinese animation instead of childlike CG', () => {
    const imagePrompt = buildStyledAssetPrompt({
      asset: {
        type: AssetType.character,
        name: '洛雪微',
        description: '成年女性，深色长发，红色连衣裙。',
        prompt: '【3D CG 动漫】旧版游戏过场角色设定。',
      },
      visualStyle: VisualStyle.anime_3d,
    })
    const videoLock = buildStyleLock(VisualStyle.anime_3d, null, 'video')

    expect(VISUAL_STYLE_PRESETS.anime_3d.label).toBe('半写实数字人 3D')
    expect(imagePrompt.startsWith('【半写实数字人 3D】')).toBe(true)
    expect(imagePrompt).toContain('高精度数字人电影 CG')
    expect(imagePrompt).toContain('成年真实比例')
    expect(imagePrompt).toContain('真人面捕式微表情')
    expect(imagePrompt).toContain('禁止欧美儿童 3D 动画')
    expect(videoLock).toContain('高精度半写实 3D 数字人电影 CG')
    expect(videoLock).toContain('皮肤次表面散射')
    expect(videoLock).toContain('连续镜头中脸型')
    expect(videoLock).toContain('禁止欧美儿童 3D 动画')
    expect(videoLock).toContain('表情包式表演')
    expect(imagePrompt).not.toContain('【3D CG 动漫】')
    expect(imagePrompt).not.toContain('游戏过场动画级')
    expect(imagePrompt).not.toContain('圆脸，大眼睛')
  })

  it('assigns stable but distinct facial identity anchors to different characters', () => {
    const linXia = buildCharacterIdentityAnchor('林夏')
    const luYe = buildCharacterIdentityAnchor('陆野')
    const prompt = buildStyledAssetPrompt({
      asset: {
        type: AssetType.character,
        name: '林夏',
        description: '19岁男大学生，黑色短发，白色T恤。',
        prompt: '人物设定板。',
      },
      visualStyle: VisualStyle.anime_3d,
    })

    expect(buildCharacterIdentityAnchor('林夏')).toBe(linXia)
    expect(luYe).not.toBe(linXia)
    expect(prompt).toContain(linXia)
    expect(prompt).toContain('同一角色所有视角和后续版本稳定复用')
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

    expect(prompt).toContain('【2D 动漫】')
    expect(prompt).not.toContain('禁止 3D 渲染和真人照片质感')
    expect(prompt).toContain('角色三视图，耶鲁卫衣')
    expect(prompt).toContain('正面、侧面、背面全身三视图')
    expect(prompt.length).toBeLessThan(260)
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

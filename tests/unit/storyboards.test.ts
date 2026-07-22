import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildCombinedStoryboardVideoPrompt,
  buildStoryboardScriptSceneContext,
  buildStoryboardVideoPrompt,
  compactStoryboardVideoCore,
  generateStoryboardVideoGroupSchema,
  generateStoryboardVideoSchema,
  matchStoryboardAssets,
  matchStoryboardVideoAssets,
} from '@/lib/storyboards'

const assets = [
  {
    id: 'mother',
    type: AssetType.character,
    name: '苏文菁（Jessica 母亲）',
    description: '富商太太',
    tags: ['苏文菁', '母亲'],
    selectedImageId: 'image-1',
  },
  {
    id: 'daughter',
    type: AssetType.character,
    name: '陈蕊（Jessica）',
    description: '耶鲁学生',
    tags: ['女儿', 'Jessica'],
    selectedImageId: 'image-2',
  },
  {
    id: 'room',
    type: AssetType.location,
    name: '翡翠山庄别墅客厅',
    description: '暖黄落地灯',
    tags: ['别墅', '客厅'],
    selectedImageId: 'image-3',
  },
  {
    id: 'wine',
    type: AssetType.prop,
    name: '水晶红酒杯',
    description: '杯沿豆沙唇印',
    tags: ['红酒', '酒杯'],
    selectedImageId: 'image-4',
  },
]

describe('storyboard asset matching', () => {
  it('recognizes canonical names, aliases, locations and props', () => {
    const matches = matchStoryboardAssets(
      assets,
      '夜晚，翡翠山庄别墅客厅。苏文菁看向 Jessica，茶几上放着水晶红酒杯。',
    )

    expect(matches.map((match) => match.id)).toEqual(['mother', 'daughter', 'room', 'wine'])
    expect(matches.map((match) => match.referenceOrder)).toEqual([1, 2, 3, 4])
  })

  it('does not match an asset from one generic tag alone', () => {
    const matches = matchStoryboardAssets(assets, '夜晚的普通客厅')
    expect(matches).toHaveLength(0)
  })

  it('uses only characters and a script-consistent location for video references', () => {
    const matches = matchStoryboardVideoAssets(assets, {
      title: '母女视频通话',
      notes: '夜晚｜翡翠山庄别墅客厅｜暖黄落地灯',
      videoPrompt: '苏文菁看向 Jessica，茶几上放着水晶红酒杯。',
      script: '夜晚，翡翠山庄别墅客厅。苏文菁与陈蕊进行视频通话。',
    })

    expect(matches.map((match) => match.id)).toEqual(['mother', 'daughter', 'room'])
    expect(matches.some((match) => match.type === AssetType.prop)).toBe(false)
    expect(matches.find((match) => match.id === 'room')?.reason).toContain('剧本场景一致')
  })

  it('matches multiple explicitly mentioned locations while keeping four references total', () => {
    const matches = matchStoryboardVideoAssets([
      {
        id: 'lin-chen',
        type: AssetType.character,
        name: '林晨',
        description: '青年外卖骑手',
        tags: [],
        selectedImageId: 'image-lin',
      },
      {
        id: 'old-chen',
        type: AssetType.character,
        name: '老陈',
        description: '中餐馆老板',
        tags: [],
        selectedImageId: 'image-old',
      },
      {
        id: 'restaurant',
        type: AssetType.location,
        name: '老陈中餐外·雨夜·凌晨1:17',
        description: '油腻屋檐与湿路面',
        tags: [],
        selectedImageId: 'image-restaurant',
      },
      {
        id: 'bridge',
        type: AssetType.location,
        name: '皇后大桥·雨夜',
        description: '雨夜桥面与哈德逊河',
        tags: [],
        selectedImageId: 'image-bridge',
      },
      {
        id: 'mansion',
        type: AssetType.location,
        name: '翡翠山庄34号·雨夜',
        description: '花岗岩外墙与暖黄落地窗',
        tags: [],
        selectedImageId: 'image-mansion',
      },
    ], {
      title: '林晨从老陈中餐外出发，骑过皇后大桥，抵达翡翠山庄34号',
      videoPrompt: '老陈把纸袋递给林晨；林晨随后骑过皇后大桥。',
      script: '【场次1】老陈中餐外·雨夜·凌晨1:17\n老陈把纸袋递给林晨。\n【场次2】皇后大桥·雨夜\n林晨骑车过桥。\n【场次3】翡翠山庄34号·雨夜\n林晨抵达门前。',
    })

    expect(matches.map((match) => match.id)).toEqual([
      'lin-chen',
      'old-chen',
      'restaurant',
      'bridge',
    ])
    expect(matches).toHaveLength(4)
  })

  it('rejects a location that conflicts with the episode script', () => {
    const matches = matchStoryboardVideoAssets([
      ...assets,
      {
        id: 'office',
        type: AssetType.location,
        name: '曼哈顿律所办公室',
        description: '玻璃隔断与冷白顶灯',
        tags: ['律所', '办公室'],
        selectedImageId: 'image-5',
      },
    ], {
      notes: '夜晚｜曼哈顿律所办公室',
      videoPrompt: '苏文菁站在曼哈顿律所办公室。',
      script: '夜晚，翡翠山庄别墅客厅。苏文菁坐在暖黄落地灯旁。',
    })

    expect(matches.map((match) => match.id)).toEqual(['mother'])
  })

  it('does not invent extra characters from generic tags or names embedded in a location', () => {
    const matches = matchStoryboardVideoAssets([
      {
        id: 'lin-chen',
        type: AssetType.character,
        name: '林晨',
        description: '年轻男性研究生与外卖骑手',
        tags: ['外卖骑手', '湿透', '苍白疲惫'],
        selectedImageId: 'image-lin',
      },
      {
        id: 'old-chen',
        type: AssetType.character,
        name: '老陈',
        description: '中餐馆工作人员',
        tags: ['中餐馆', '老陈'],
        selectedImageId: 'image-old-chen',
      },
      {
        id: 'generic-rider',
        type: AssetType.character,
        name: '亚裔骑手',
        description: '穿荧光绿马甲的配送骑手',
        tags: ['电动车', '真人写实'],
        selectedImageId: 'image-rider',
      },
      {
        id: 'restaurant',
        type: AssetType.location,
        name: '老陈中餐门口',
        description: '纽约临街中餐馆雨夜外景',
        tags: ['纽约', '秋雨', '油腻屋檐'],
        selectedImageId: 'image-restaurant',
      },
    ], {
      title: '雨夜停靠',
      notes: '凌晨一点十七分｜老陈中餐门口｜密集秋雨、油腻屋檐',
      imagePrompt: '真人写实，纽约秋雨中，林晨浑身湿透，将电动车推停进屋檐下。',
      videoPrompt: '林晨拧了拧滴水的袖口，手机订单亮起。',
    })

    expect(matches.map((match) => match.id)).toEqual(['lin-chen', 'restaurant'])
  })
})

describe('storyboard video prompt', () => {
  it('combines adjacent storyboard prompts in order within the Seedance limit', () => {
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.photorealistic,
      maxLength: 4900,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 2, type: AssetType.location, name: '翡翠山庄别墅客厅' },
      ],
      storyboards: [
        { title: '抬眼', duration: 6, videoPrompt: '动作顺序：苏文菁先抬眼，再看向平板。' },
        { title: '回应', duration: 7, videoPrompt: '动作对白：苏文菁低声回应，随后保持不动。' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(4900)
    expect(prompt).toContain('总时长：13秒')
    expect(prompt).toContain('共 2 个同集相邻分镜')
    expect(prompt).toContain('【0-6秒｜镜头1：抬眼】')
    expect(prompt).toContain('【6-13秒｜镜头2：回应】')
    expect(prompt.indexOf('镜头1：抬眼')).toBeLessThan(prompt.indexOf('镜头2：回应'))
    expect(prompt).toContain('前一镜尾帧')
  })

  it('builds an exact 15-second timeline for four adjacent shots', () => {
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.photorealistic,
      maxLength: 4900,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 2, type: AssetType.location, name: '翡翠山庄别墅客厅' },
      ],
      storyboards: [
        { title: '镜头一', duration: 3.75, videoPrompt: '画面描述：苏文菁抬眼。' },
        { title: '镜头二', duration: 3.75, videoPrompt: '画面描述：苏文菁看向平板。' },
        { title: '镜头三', duration: 3.75, videoPrompt: '画面描述：苏文菁指尖停住。' },
        { title: '镜头四', duration: 3.75, videoPrompt: '画面描述：苏文菁缓慢收回视线。' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(4900)
    expect(prompt).toContain('总时长：15秒')
    expect(prompt).toContain('【0-3.75秒｜镜头1：镜头一】')
    expect(prompt).toContain('【11.25-15秒｜镜头4：镜头四】')
    expect(prompt.indexOf('@image1：角色“苏文菁”')).toBeLessThan(prompt.indexOf('【分镜时间轴】'))
    expect(prompt.trim().endsWith('画面描述：苏文菁缓慢收回视线。')).toBe(true)
  })

  it('binds reference images and preserves the project style', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '母女视频通话',
      videoPrompt: '中景固定，苏文菁看着平板，陈蕊回答：哦。',
      visualStyle: VisualStyle.photorealistic,
      scriptSceneContext: '分镜场景锚点：夜晚｜翡翠山庄别墅客厅｜暖黄落地灯',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 2, type: AssetType.character, name: '陈蕊' },
        { referenceOrder: 3, type: AssetType.location, name: '翡翠山庄别墅客厅' },
        { referenceOrder: 4, type: AssetType.prop, name: '水晶红酒杯' },
      ],
    })

    expect(prompt).toContain('@image1：角色“苏文菁”')
    expect(prompt).toContain('@image2：角色“陈蕊”')
    expect(prompt).toContain('@image3：场景“翡翠山庄别墅客厅”')
    expect(prompt).not.toContain('@image4')
    expect(prompt).toContain('场景锚点：')
    expect(prompt).toContain('道具不绑定参考图')
    expect(prompt).toContain('忽略卡片文字、色板、标尺和排版')
    expect(prompt).toContain('三视图只代表同一人')
    expect(prompt).toContain('不得复制人物')
    expect(prompt).toContain('真人影视摄影风格')
    expect(prompt).toContain('连续性与动作安全')
    expect(prompt).toContain('双脚不滑移')
    expect(prompt).toContain('物体不穿透')
  })

  it('keeps Seedance prompts within the API limit while preserving critical sections', () => {
    const longPrompt = [
      '【分镜1】',
      `时间地点：${'夜晚，翡翠山庄别墅客厅。'.repeat(80)}`,
      `人物锁定：${'苏文菁位于左侧，陈蕊位于右侧。'.repeat(100)}`,
      `首帧画面：${'两人保持稳定站位。'.repeat(100)}`,
      `动作顺序：${'先抬眼；随后转移重心；然后抬起右手；最后稳定停住。'.repeat(120)}`,
      `动作与物理约束：${'右手沿可见路径移动，双脚不滑移，人物互不穿透。'.repeat(120)}`,
      `画面内容：${'视线与眉眼随对白自然变化。'.repeat(100)}`,
      `动作对白：${'苏文菁：下周我过来带你们见面吃饭。'.repeat(80)}`,
      `尾帧画面：${'苏文菁右手停在身体右侧。'.repeat(100)}`,
      `禁止项：${'肢体融合、脚底滑移、道具换手。'.repeat(100)}`,
      '统一视觉风格锁定：这部分会由外层统一提供。',
      '【所有分镜默认生效的电影级参数】重复规则。',
    ].join('\n')
    const prompt = buildStoryboardVideoPrompt({
      title: '长度安全测试',
      videoPrompt: longPrompt,
      visualStyle: VisualStyle.photorealistic,
      scriptSceneContext: '夜晚，翡翠山庄别墅客厅，暖黄落地灯照亮沙发一角。',
      maxLength: 4900,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 2, type: AssetType.character, name: '陈蕊' },
        { referenceOrder: 3, type: AssetType.location, name: '翡翠山庄别墅客厅' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(4900)
    expect(prompt).toContain('动作顺序：')
    expect(prompt).toContain('动作物理：')
    expect(prompt).toContain('动作对白：')
    expect(prompt).toContain('禁止项：')
    expect(prompt).not.toContain('这部分会由外层统一提供')
    expect(prompt.indexOf('禁止项：')).toBeLessThan(prompt.indexOf('动作顺序：'))
    expect(prompt.indexOf('动作顺序：')).toBeLessThan(prompt.lastIndexOf('画面描述：'))
  })

  it('allocates more compacting space to actions, physics, dialogue, and prohibitions', () => {
    const compact = compactStoryboardVideoCore([
      `环境锁定：${'固定陈设。'.repeat(200)}`,
      `动作顺序：${'先准备；随后移动；最后站稳。'.repeat(200)}`,
      `动作与物理约束：${'重心稳定，双脚不滑移。'.repeat(200)}`,
      `动作对白：${'苏文菁：下周见。'.repeat(200)}`,
      `禁止项：${'肢体融合、人物瞬移。'.repeat(200)}`,
    ].join('\n'), 1000)

    expect(compact.length).toBeLessThanOrEqual(1000)
    expect(compact).toContain('动作顺序：')
    expect(compact).toContain('动作物理：')
    expect(compact).toContain('动作对白：')
    expect(compact).toContain('禁止项：')
  })

  it('keeps the prioritized action and picture sections at the end of a very small prompt budget', () => {
    const compact = compactStoryboardVideoCore([
      `时间地点：${'固定场景。'.repeat(100)}`,
      `人物锁定：${'人物形象固定。'.repeat(100)}`,
      `禁止项：${'禁止穿模。'.repeat(100)}`,
      `画面内容：${'眉眼从戒备逐渐转为迟疑。'.repeat(100)}`,
      `动作顺序：${'先抬眼；随后伸手；最后站稳。'.repeat(100)}`,
      `动作对白：${'林晨：我明白了。'.repeat(100)}`,
      `动作与物理约束：${'右手沿连续路径移动，双脚不滑移。'.repeat(100)}`,
    ].join('\n'), 320)

    expect(compact.length).toBeLessThanOrEqual(320)
    expect(compact.indexOf('禁止项：')).toBeLessThan(compact.indexOf('动作对白：'))
    expect(compact.indexOf('动作对白：')).toBeLessThan(compact.indexOf('动作顺序：'))
    expect(compact.indexOf('动作顺序：')).toBeLessThan(compact.indexOf('动作物理：'))
    expect(compact.indexOf('动作物理：')).toBeLessThan(compact.lastIndexOf('画面描述：'))
  })

  it('extracts the matched location context from the episode script', () => {
    const context = buildStoryboardScriptSceneContext({
      notes: '深夜｜翡翠山庄别墅客厅',
      script: '场次一，白天，街道。\n场次二，深夜，翡翠山庄别墅客厅，暖黄落地灯照亮沙发一角。苏文菁看向平板。',
      locations: [assets[2]],
    })

    expect(context).toContain('分镜场景锚点：深夜｜翡翠山庄别墅客厅')
    expect(context).toContain('所属分集剧本原文')
    expect(context).toContain('暖黄落地灯')
  })
})

describe('storyboard video generation settings', () => {
  it('accepts two to four unique storyboards for one combined task', () => {
    expect(generateStoryboardVideoGroupSchema.parse({
      storyboardIds: ['shot-1', 'shot-2', 'shot-3', 'shot-4'],
      model: 'seedance-2.0-mini',
    }).storyboardIds).toHaveLength(4)
    expect(() => generateStoryboardVideoGroupSchema.parse({
      storyboardIds: ['shot-1', 'shot-1'],
    })).toThrow()
  })

  it('accepts a selected video model', () => {
    expect(generateStoryboardVideoSchema.parse({
      duration: 15,
      aspectRatio: '21:9',
      resolution: '480p',
      model: 'grok-video',
    })).toMatchObject({
      duration: 15,
      aspectRatio: '21:9',
      resolution: '480p',
      model: 'grok-video',
    })
  })

  it('rejects unsupported video resolutions', () => {
    expect(() => generateStoryboardVideoSchema.parse({ resolution: '1080p' })).toThrow()
  })
})

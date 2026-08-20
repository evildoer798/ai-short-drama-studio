import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildLegacyDirectorStoryboardPrompt,
  buildCombinedStoryboardVideoPrompt,
  buildCharacterVoiceProfile,
  buildNaturalStoryboardPrompt,
  buildStoryboardScriptSceneContext,
  buildStoryboardVideoPrompt,
  compactStoryboardVideoCore,
  generateStoryboardVideoGroupSchema,
  generateStoryboardVideoSchema,
  isExcludedStoryboardAssetLink,
  isManualStoryboardAssetLink,
  matchStoryboardAssets,
  matchStoryboardVideoAssets,
  prioritizeCombinedStoryboardReferences,
  prioritizeStoryboardReferences,
  storyboardAssetExclusionReason,
  unboundStoryboardTimelineCharacters,
  updateStoryboardSchema,
  visibleStoryboardTimelineCharacters,
} from '@/lib/storyboards'
import {
  parseStoryboardTimelineSegments,
} from '@/lib/storyboard-timeline'
import { sanitizeStoryboardPromptSceneSection } from '@/lib/storyboard-scene'

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
  it('distinguishes removable manual links from persistent per-shot exclusions', () => {
    expect(isManualStoryboardAssetLink('手动添加：盒饭')).toBe(true)
    expect(isManualStoryboardAssetLink('手动排除：盒饭')).toBe(false)
    expect(isExcludedStoryboardAssetLink(storyboardAssetExclusionReason(' 盒饭 '))).toBe(true)
    expect(storyboardAssetExclusionReason(' 盒饭 ')).toBe('手动排除：盒饭')
  })

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

  it('binds the canonical boxed-meal prop when a storyboard mentions a boxed meal alias', () => {
    const matches = matchStoryboardVideoAssets([{
      id: 'boxed-meal-1990s',
      type: AssetType.prop,
      name: '90年代白色塑料盒饭（盒饭、饭盒、盒餐、塑料饭盒）',
      description: '白色长方形一次性塑料饭盒，固定菜品布局',
      tags: ['90年代', '白色塑料盒', '盒饭'],
      selectedImageId: 'image-boxed-meal',
    }], {
      videoPrompt: '许桂芳把盒饭整齐码放到三轮车上。',
    })

    expect(matches.map((match) => match.id)).toEqual(['boxed-meal-1990s'])
    expect(matches[0]?.reason).toContain('别名“盒饭”')
  })

  it('uses characters, mentioned props and a script-consistent location for video references', () => {
    const matches = matchStoryboardVideoAssets(assets, {
      title: '母女视频通话',
      notes: '夜晚｜翡翠山庄别墅客厅｜暖黄落地灯',
      videoPrompt: '苏文菁看向 Jessica，茶几上放着水晶红酒杯。',
      script: '夜晚，翡翠山庄别墅客厅。苏文菁与陈蕊进行视频通话。',
    })

    expect(matches.map((match) => match.id)).toEqual(['mother', 'daughter', 'wine', 'room'])
    expect(matches.some((match) => match.type === AssetType.prop)).toBe(true)
    expect(matches.find((match) => match.id === 'room')?.reason).toContain('剧本场景一致')
  })

  it('binds a dotted full character name when the storyboard uses its stable short name', () => {
    const matches = matchStoryboardVideoAssets([
      {
        id: 'claire',
        type: AssetType.character,
        name: '克莱尔·摩根',
        description: '40岁女性医生',
        tags: [],
        selectedImageId: 'image-claire',
      },
    ], {
      videoPrompt: '【视频分镜】\n0~5s：克莱尔站在人群边缘，冷冷看向高台。',
    })

    expect(matches.map((match) => match.id)).toEqual(['claire'])
  })

  it('binds a role-named character when the storyboard uses only the role suffix', () => {
    const matches = matchStoryboardVideoAssets([
      {
        id: 'canteen-director',
        type: AssetType.character,
        name: '食堂主任',
        description: '中年食堂管理人员',
        tags: ['食堂管理'],
        selectedImageId: 'image-director',
      },
      {
        id: 'xu-guifang',
        type: AssetType.character,
        name: '许桂芳',
        description: '食堂女工',
        tags: [],
        selectedImageId: 'image-xu',
      },
    ], {
      videoPrompt: [
        '【人物及初始站位】',
        '许桂芳站在灶台前，主任从她身后走来。',
        '【视频分镜】',
        '0~3s：主任贴完通知，许桂芳紧盯主任。',
      ].join('\n'),
    })

    expect(matches.map((match) => match.id)).toEqual(['xu-guifang', 'canteen-director'])
    expect(matches.find((match) => match.id === 'canteen-director')?.reason).toContain('别名“主任”')
  })

  it('keeps every visible character and uses scene text when characters fill a four-image cap', () => {
    const crowdedAssets = [
      ...['council', 'emma', 'guard', 'claire'].map((id, index) => ({
        id,
        type: AssetType.character,
        name: ['议会长老', '艾玛·克劳', '守卫', '克莱尔·摩根'][index],
        description: '人物资产',
        tags: [],
        selectedImageId: `image-${id}`,
      })),
      {
        id: 'altar-square',
        type: AssetType.location,
        name: '黑松庄园祭坛广场',
        description: '中央石质祭坛与环形火把',
        tags: [],
        selectedImageId: 'image-altar-square',
      },
    ]
    const matches = matchStoryboardVideoAssets(crowdedAssets, {
      notes: '黑松庄园祭坛广场',
      videoPrompt: '议会长老宣读祭品，艾玛·克劳被守卫押在右侧，克莱尔·摩根藏在人群后方。',
      script: '黑松庄园祭坛广场。议会长老宣读祭品，艾玛·克劳、守卫和克莱尔·摩根均在场。',
    })
    const seedanceMiniReferences = prioritizeStoryboardReferences(matches, 4)

    expect(matches).toHaveLength(5)
    expect(matches.at(-1)?.id).toBe('altar-square')
    expect(seedanceMiniReferences).toHaveLength(4)
    expect(seedanceMiniReferences.some((match) => match.id === 'altar-square')).toBe(false)
    expect(seedanceMiniReferences.some((match) => match.id === 'claire')).toBe(true)
    expect(seedanceMiniReferences.some((match) => match.id === 'guard')).toBe(true)
    expect(prioritizeStoryboardReferences(matches, 1)[0].type).toBe(AssetType.character)
  })

  it('keeps a location reference when all visible characters still leave a free slot', () => {
    const selected = prioritizeStoryboardReferences([
      { id: 'lin', type: AssetType.character, referenceOrder: 1 },
      { id: 'chen', type: AssetType.character, referenceOrder: 2 },
      { id: 'lu', type: AssetType.character, referenceOrder: 3 },
      { id: 'dorm', type: AssetType.location, referenceOrder: 4 },
    ], 4)

    expect(selected.map((item) => item.id)).toEqual(['lin', 'chen', 'lu', 'dorm'])
  })

  it('uses the previous tail frame instead of a location image whenever continuity is enabled', () => {
    const candidates = [
      { id: 'claire', type: AssetType.character, referenceOrder: 1 },
      { id: 'damian', type: AssetType.character, referenceOrder: 2 },
      { id: 'sienna', type: AssetType.character, referenceOrder: 3 },
      { id: 'corridor', type: AssetType.location, referenceOrder: 4 },
    ]

    const selectedAssets = prioritizeStoryboardReferences(candidates, 3, { omitLocations: true })

    expect(selectedAssets.map((item) => item.id)).toEqual(['claire', 'damian', 'sienna'])
    expect(selectedAssets.some((item) => item.type === AssetType.location)).toBe(false)
  })

  it('submits references only for characters explicitly listed in frame', () => {
    const videoPrompt = [
      '【视频分镜】',
      '0~15s：镜内：克莱尔；画外：达米安、西耶娜；达米安继续现场对白。',
    ].join('\n')
    const knownCharacterNames = ['克莱尔·摩根', '达米安', '西耶娜']

    expect(visibleStoryboardTimelineCharacters({ videoPrompt, knownCharacterNames }))
      .toEqual(['克莱尔·摩根'])
    expect(unboundStoryboardTimelineCharacters({
      videoPrompt,
      knownCharacterNames,
      referencedCharacterNames: ['克莱尔·摩根'],
    })).toEqual([])
  })

  it('prioritizes continuous cast identity over scene boards for combined videos', () => {
    const selected = prioritizeCombinedStoryboardReferences([
      { id: 'damian', type: AssetType.character, referenceOrder: 1, appearanceCount: 1, mentionCount: 8 },
      { id: 'guard', type: AssetType.character, referenceOrder: 2, appearanceCount: 1, mentionCount: 4 },
      { id: 'claire', type: AssetType.character, referenceOrder: 3, appearanceCount: 2, mentionCount: 12, appearsInFinalStoryboard: true },
      { id: 'emma', type: AssetType.character, referenceOrder: 4, appearanceCount: 1, mentionCount: 3 },
      { id: 'cliff', type: AssetType.location, referenceOrder: 5, appearanceCount: 1, mentionCount: 2 },
      { id: 'ocean', type: AssetType.location, referenceOrder: 6, appearanceCount: 1, mentionCount: 2, appearsInFinalStoryboard: true },
    ], 4)

    expect(selected.map((item) => item.id)).toEqual(['claire', 'damian', 'guard', 'emma'])
  })

  it('detects a timeline character that would be generated without an asset reference', () => {
    expect(unboundStoryboardTimelineCharacters({
      videoPrompt: [
        '【风格基调】',
        '海外真人短剧。',
        '【人物及初始站位】',
        '克莱尔·摩根站在崖边，达米安·克劳站在上方。',
        '【场景】',
        '月光悬崖。',
        '【视频分镜】',
        '0~5s：艾玛·克劳被护卫带离，克莱尔·摩根看向艾玛·克劳。',
      ].join('\n'),
      knownCharacterNames: ['克莱尔·摩根', '达米安·克劳', '艾玛·克劳'],
      referencedCharacterNames: ['克莱尔·摩根', '达米安·克劳'],
    })).toEqual(['艾玛·克劳'])
  })

  it('keeps only the strongest standard scene when legacy text mentions several locations', () => {
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

    expect(matches.map((match) => match.id)).toEqual(['lin-chen', 'old-chen', 'restaurant'])
    expect(matches.filter((match) => match.type === AssetType.location)).toHaveLength(1)
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

  it('accepts an exact standard scene when the script supports it through a scene tag', () => {
    const sceneAssets = [
      {
        id: 'tree-shade',
        type: AssetType.location,
        name: '城市街道旁树荫下',
        description: '校门附近的行道树阴影与街边路面',
        tags: ['树荫', '校门附近'],
        selectedImageId: 'image-tree-shade',
      },
      {
        id: 'maybach',
        type: AssetType.location,
        name: '城市街道，黑色迈巴赫S680旁',
        description: '黑色豪华轿车停在城市街边',
        tags: ['迈巴赫', 'S680'],
        selectedImageId: 'image-maybach',
      },
    ]
    const treeShade = matchStoryboardVideoAssets(sceneAssets, {
      notes: '白天｜城市街道旁树荫下',
      videoPrompt: '洛雪微把林夏拉进城市街道旁树荫下继续说话。',
      script: '大学校门口，洛雪微抓住林夏的手腕，把他拉进树荫下。',
    })
    const maybach = matchStoryboardVideoAssets(sceneAssets, {
      notes: '白天｜城市街道，黑色迈巴赫S680旁',
      videoPrompt: '黑色迈巴赫S680停在两人面前。',
      script: '一辆黑色迈巴赫S680驶来，洛雪微打开后车门。',
    })

    expect(treeShade.map((match) => match.id)).toEqual(['tree-shade'])
    expect(treeShade[0].reason).toContain('标签“树荫”')
    expect(maybach.map((match) => match.id)).toEqual(['maybach'])
    expect(maybach[0].reason).toContain('标签“迈巴赫”')
  })

  it('does not replace an explicit standard scene with a merely similar asset', () => {
    const matches = matchStoryboardVideoAssets(assets, {
      notes: '翡翠山庄书房',
      videoPrompt: '【场景】\n翡翠山庄书房，黑胡桃木书桌。',
      script: '【场3】日/内/翡翠山庄书房\n林晨坐在书桌前。',
    })

    expect(matches.filter((match) => match.type === AssetType.location)).toEqual([])
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
  it('preserves manual @asset lines when sanitizing the scene section', () => {
    const prompt = sanitizeStoryboardPromptSceneSection([
      '【风格基调】',
      '3D CG 动漫。',
      '【本分镜人物】',
      '@秦绾绾',
      '【场景】',
      '@农家小院',
      '@同心结',
      '夜晚｜农家小院。青砖地与灰白石桌固定。',
      '【视频分镜】',
      '0~5s：秦绾绾抬眼。',
    ].join('\n'), '农家小院')

    expect(prompt).toContain('【场景】\n@农家小院\n@同心结\n')
  })

  it('keeps saved scene sections static when a manual edit contains character actions', () => {
    const prompt = sanitizeStoryboardPromptSceneSection([
      '【风格基调】',
      '3D CG 动漫。',
      '【人物及初始站位】',
      '林夏和洛雪微站在入口。',
      '【场景】',
      '民政局登记大厅。洛雪微拽住林夏手腕，林夏踉跄走进大厅；林夏凑近亲吻洛雪微；洛雪微：临大的学生吗。大理石地面、登记台和红色背景墙固定，自然窗光明亮；固定空间结构沿用场景资产主图。',
      '【视频分镜】',
      '0~5s：洛雪微拉着林夏进入大厅。',
    ].join('\n'), '民政局登记大厅', '', ['林夏', '洛雪微'])
    const scene = prompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''

    expect(scene).toContain('民政局登记大厅')
    expect(scene).toContain('大理石地面')
    expect(scene).not.toContain('林夏')
    expect(scene).not.toContain('洛雪微')
    expect(scene).not.toContain('拽')
    expect(scene).not.toContain('亲吻')
    expect(scene).not.toContain('临大的学生吗')
    expect(scene).not.toContain('场景资产主图')
    expect(prompt).toContain('0~5s：洛雪微拉着林夏进入大厅。')
  })

  it('removes action and dialogue from legacy multi-location scene sections', () => {
    const prompt = sanitizeStoryboardPromptSceneSection([
      '【风格基调】',
      '3D CG 动漫。',
      '【人物及初始站位】',
      '洛雪微坐在后座。',
      '【场景】',
      '0~10s：民政局门口。',
      '10~15s：迈巴赫车内。0~10s：洛雪微缓步走出，坐进停在门口的黑色迈巴赫后座；洛雪微：临大的学生吗 10~15s：洛雪微缓步走出，坐进停在门口的黑色迈巴赫后座；洛雪微：临大的学生吗。0~10s：自然日光，色温5600K，明亮通透；10~15s：车内光线柔和，色温4500K，窗外日光补充。',
      '【视频分镜】',
      '0~10s：洛雪微走出民政局。',
    ].join('\n'), '民政局门口；迈巴赫车内', '', ['洛雪微'])
    const scene = prompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''

    expect(scene).toContain('民政局门口')
    expect(scene).toContain('迈巴赫车内')
    expect(scene).toContain('自然日光')
    expect(scene).toContain('车内光线柔和')
    expect(scene).not.toContain('洛雪微')
    expect(scene).not.toContain('缓步')
    expect(scene).not.toContain('临大的学生吗')
  })

  it('uses a continuity frame as the scene reference and removes offscreen lip-sync conflicts', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '广场对白续镜',
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 1400,
      duration: 15,
      aspectRatio: '16:9',
      knownCharacterNames: ['克莱尔·摩根', '达米安', '西耶娜'],
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安' },
        { referenceOrder: 3, type: AssetType.character, name: '西耶娜' },
        { referenceOrder: 4, type: 'continuity', name: '上一镜尾帧', continuityMode: 'spatial' },
      ],
      videoPrompt: [
        '【风格基调】',
        '海外真人短剧。',
        '【人物及初始站位】',
        '克莱尔·摩根站在人群边缘。',
        '【场景】',
        '黑松庄园广场。固定空间结构、陈设、材质与基础光线沿用场景资产主图。',
        '【视频分镜】',
        '0~15s：镜内：克莱尔·摩根；画外：达米安、西耶娜；达米安按对白顺序自然同步口型；达米安：I choose a stronger bloodline.',
      ].join('\n'),
    })

    expect(prompt).toContain('沿用上一镜尾帧')
    expect(prompt).not.toContain('场景资产主图')
    expect(prompt).toContain('达米安仅作画外现场对白，不入镜、不要求口型')
    expect(prompt).not.toContain('达米安按对白顺序自然同步口型')
  })

  it('uses the structured scene text when character references consume every image slot', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '四人宿舍打闹',
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1400,
      duration: 15,
      aspectRatio: '16:9',
      knownCharacterNames: ['林夏', '陈浩', '吕嘉豪', '陆野'],
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林夏' },
        { referenceOrder: 2, type: AssetType.character, name: '陈浩' },
        { referenceOrder: 3, type: AssetType.character, name: '吕嘉豪' },
        { referenceOrder: 4, type: AssetType.character, name: '陆野' },
      ],
      videoPrompt: [
        '【风格基调】',
        '3D CG 动漫。',
        '【人物及初始站位】',
        '林夏站在门口；陈浩、吕嘉豪和陆野位于宿舍中央。',
        '【场景】',
        '206宿舍内。固定空间结构、床铺、书桌和自然光沿用场景资产主图。',
        '【视频分镜】',
        '0~15s：四人中景，林夏推门，陈浩和吕嘉豪按住陆野。',
      ].join('\n'),
    })

    expect(prompt).toContain('206宿舍内')
    expect(prompt).toContain('本镜场景文字设定')
    expect(prompt).not.toContain('场景资产主图')
    expect(prompt).not.toContain('场景“206宿舍内”')
  })

  it('deduplicates compact style and shared multi-character declarations before truncation', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '走廊焦急至冷漠回应',
      visualStyle: VisualStyle.photorealistic,
      maxLength: 1400,
      duration: 15,
      aspectRatio: '16:9',
      knownCharacterNames: ['克莱尔·摩根', '达米安', '西耶娜', '守卫'],
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安' },
        { referenceOrder: 3, type: AssetType.character, name: '西耶娜' },
        { referenceOrder: 4, type: AssetType.location, name: '庄园走廊' },
      ],
      videoPrompt: [
        '【风格基调】',
        '项目统一画风：真人写实。',
        '项目统一画风：真人写实。',
        '【人物及初始站位】',
        '克莱尔·摩根：中年女性，手提医药箱；守卫：站在走廊两侧',
        '达米安：高大冷漠，西装，拥着西耶娜',
        '达米安：高大冷漠，西装，拥着西耶娜',
        '【场景】',
        '庄园走廊，古典壁灯与油画。',
        '【视频分镜】',
        '0~7s：克莱尔·摩根快步走进走廊。',
        '7~15s：达米安拥着西耶娜出现。',
      ].join('\n'),
    })

    expect(prompt.match(/真人影视摄影风格/gu)).toHaveLength(1)
    expect(prompt.match(/@image2=达米安/gu)).toHaveLength(1)
    expect(prompt).toContain('0~7s：')
    expect(prompt).toContain('7~15s：')
    expect(prompt.length).toBeLessThanOrEqual(1400)
  })

  it('keeps Claire bound and removes unreferenced background cast declarations', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '长老宣读祭品',
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 4900,
      duration: 8,
      aspectRatio: '16:9',
      knownCharacterNames: ['议会长老', '艾玛·克劳', '守卫', '克莱尔·摩根', '达米安·克劳'],
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '议会长老' },
        { referenceOrder: 2, type: AssetType.character, name: '艾玛·克劳' },
        { referenceOrder: 3, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 4, type: AssetType.location, name: '黑松庄园祭坛广场' },
      ],
      videoPrompt: [
        '【风格基调】',
        '海外真人短剧。',
        '【人物及初始站位】',
        '议会长老（老年狼族，手持卷轴）站在祭坛中央；艾玛·克劳（白色祭袍）站在右侧。',
        '守卫（黑色制服）站在艾玛·克劳身后；克莱尔·摩根（40岁，灰袍）站在人群前排。',
        '达米安·克劳（西装笔挺）站在祭坛左侧。',
        '【场景】',
        '黑松庄园祭坛广场，血月悬空。',
        '【视频分镜】',
        '0~8s：议会长老展开卷轴宣读，艾玛·克劳抬头，克莱尔·摩根在前排注视女儿。',
      ].join('\n'),
    })

    const people = prompt.split('【本分镜人物】')[1].split('【场景】')[0]
    expect(people).toContain('@image3=克莱尔·摩根')
    expect(people).toContain(`固定声音：${buildCharacterVoiceProfile('克莱尔·摩根', VisualStyle.overseas_live_action)}`)
    expect(people).not.toContain('克莱尔·摩根（40岁，灰袍）')
    expect(people).not.toContain('守卫（黑色制服）')
    expect(people).not.toContain('达米安·克劳（西装笔挺）')
  })

  it('locks the irreversible action owner, human form, and exact scene geometry', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '悬崖坠落',
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 4900,
      duration: 15,
      aspectRatio: '16:9',
      knownCharacterNames: ['克莱尔·摩根', '达米安·克劳'],
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安·克劳' },
        { referenceOrder: 3, type: AssetType.location, name: '月光悬崖' },
      ],
      videoPrompt: [
        '【风格基调】',
        '海外真人奇幻短剧。',
        '【人物及初始站位】',
        '克莱尔·摩根悬在崖边；达米安·克劳站在崖顶。',
        '【场景】',
        '月光悬崖，碎石崖壁。',
        '【视频分镜】',
        '0~8s：克莱尔·摩根仍抓住崖边，达米安·克劳完成对白。',
        '8~15s：克莱尔·摩根手指滑开，克莱尔·摩根身体持续向下坠落并离开画面。',
      ].join('\n'),
    })

    expect(prompt).toContain('克莱尔·摩根唯一执行“坠落、离开画面、失去支撑”')
    expect(prompt).not.toContain('达米安·克劳唯一执行“坠落')
    expect(prompt).toContain('奇幻身份词如狼族、Alpha、Luna、王族和长老不改变人体外观')
    expect(prompt).toContain('全段只使用 @image 对应的“月光悬崖”')
    expect(prompt).toContain('不得替换为庭院、舞台、竞技场、规则石台、科幻建筑')
  })

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
    expect(prompt).toContain('剧情时间轴：13秒；成片时长：13秒')
    expect(prompt).toContain('共 2 个同集相邻分镜，可来自不同场景')
    expect(prompt).toContain('0~6s：镜头1《抬眼》')
    expect(prompt).toContain('6~13s：镜头2《回应》')
    expect(prompt.indexOf('镜头1《抬眼》')).toBeLessThan(prompt.indexOf('镜头2《回应》'))
    expect(prompt).toContain('切换到不同场景时使用干净直接剪辑')
    expect(prompt).toContain('【风格基调】')
    expect(prompt).toContain('【本分镜人物】')
    expect(prompt).toContain('【场景】')
    expect(prompt).toContain('【视频分镜】')
  })

  it('keeps different scenes in separate timed scene blocks inside one 15-second video', () => {
    const lobby = [
      '【风格基调】',
      '海外真人短剧。',
      '【人物及初始站位】',
      'Claire stands by the lobby door.',
      '【场景】',
      '白天｜酒店大堂。玻璃门与前台保持固定。',
      '【视频分镜】',
      '0~6s：Claire turns toward the elevator.',
    ].join('\n')
    const elevator = [
      '【风格基调】',
      '海外真人短剧。',
      '【人物及初始站位】',
      'Claire stands inside the elevator.',
      '【场景】',
      '白天｜酒店电梯。金属轿厢与楼层灯保持固定。',
      '【视频分镜】',
      '0~7s：The doors close as Claire looks up.',
    ].join('\n')
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.overseas_live_action,
      outputDuration: 15,
      references: [{ referenceOrder: 1, type: AssetType.character, name: 'Claire' }],
      storyboards: [
        { title: '离开大堂', duration: 6, videoPrompt: lobby },
        { title: '进入电梯', duration: 7, videoPrompt: elevator },
      ],
    })

    expect(prompt).toContain('0~6s｜镜头1《离开大堂》：白天｜酒店大堂')
    expect(prompt).toContain('6~13s｜镜头2《进入电梯》：白天｜酒店电梯')
    expect(prompt).toContain('6~13s：The doors close')
    expect(prompt).toContain('13~15s：剧情已结束，只保持最后尾帧')
    expect(prompt).toContain('禁止叠加、融合或同时出现两个空间')
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
    expect(prompt).toContain('剧情时间轴：15秒；成片时长：15秒')
    expect(prompt).toContain('0~3.75s：镜头1《镜头一》')
    expect(prompt).toContain('11.25~15s：镜头4《镜头四》')
    expect(prompt.indexOf('@image1=苏文菁')).toBeLessThan(prompt.indexOf('【视频分镜】'))
    expect(prompt.trim().endsWith('画面描述：苏文菁缓慢收回视线。')).toBe(true)
  })

  it('mentions each character and scene reference exactly once and never appends episode script excerpts', () => {
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.photorealistic,
      maxLength: 4900,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林晨' },
        { referenceOrder: 2, type: AssetType.location, name: '翡翠山庄34号大门' },
      ],
      storyboards: [
        {
          title: '停在门前',
          duration: 5,
          videoPrompt: '人物锁定：林晨站在门前。\n场景连续性：翡翠山庄34号大门。\n画面描述：林晨抬头看向门牌。',
          scriptSceneContext: '所属分集剧本原文：这是一段绝不能重复进入视频提示词的整集剧本文本。',
        },
        {
          title: '确认门牌',
          duration: 5,
          videoPrompt: '首帧：林晨保持上一镜位置。\n画面描述：林晨确认门牌后收回视线。',
          scriptSceneContext: '所属分集剧本原文：第二段整集剧本文本。',
        },
      ],
    })

    expect(prompt.match(/@image1/gu)).toHaveLength(1)
    expect(prompt.match(/@image2/gu)).toHaveLength(1)
    expect(prompt).not.toContain('所属分集剧本原文')
    expect(prompt).not.toContain('绝不能重复进入视频提示词')
    expect(prompt.indexOf('人物锁定：')).toBeLessThan(prompt.lastIndexOf('画面描述：'))
  })

  it('binds combined-video character images only in the opening cast section and keeps canonical names', () => {
    const cliff = [
      '【风格基调】',
      '海外真人短剧。',
      '【人物及初始站位】',
      '达米安·克劳（西装）面对克莱尔；克莱尔·摩根（灰袍）站在崖边；艾玛·克劳（白袍）在右侧；克莱尔·摩根（下坠中）；达米安·克劳（俯视下方）',
      '【场景】',
      '月光悬崖。',
      '【视频分镜】',
      '0~11s：达米安命令护卫带走艾玛；随后克莱尔坠离崖边。',
    ].join('\n')
    const ocean = [
      '【风格基调】',
      '海外真人短剧。',
      '【人物及初始站位】',
      '克莱尔·摩根（灰袍）在深海下沉。',
      '【场景】',
      '深海之下。',
      '【视频分镜】',
      '0~4s：克莱尔在水中下沉，封印发光。',
    ].join('\n')
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 4900,
      outputDuration: 15,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安·克劳' },
        { referenceOrder: 3, type: AssetType.character, name: '议会护卫' },
        { referenceOrder: 4, type: AssetType.character, name: '艾玛·克劳' },
      ],
      characterNames: ['克莱尔·摩根', '达米安·克劳', '议会护卫', '艾玛·克劳'],
      storyboards: [
        { title: '悬崖坠落', duration: 11, videoPrompt: cliff },
        { title: '坠入深海', duration: 4, videoPrompt: ocean },
      ],
    })

    const people = prompt.match(/【本分镜人物】\n([\s\S]*?)\n【场景】/u)?.[1] || ''
    const afterPeople = prompt.slice(prompt.indexOf('【场景】'))
    const timeline = prompt.slice(prompt.indexOf('【视频分镜】'))
    expect(people.match(/@image\d+/gu)).toHaveLength(4)
    expect(afterPeople).not.toContain('@image')
    expect(people).not.toContain('深海下沉')
    expect(people).not.toContain('下坠中')
    expect(people).not.toContain('俯视下方')
    expect(people).toContain('跨分镜身份连续：克莱尔·摩根')
    expect(timeline).toContain('达米安·克劳命令议会护卫带走艾玛·克劳')
    expect(timeline).toContain('克莱尔·摩根在水中下沉')
    expect(timeline).not.toMatch(/克莱尔(?!·摩根)/u)
    expect(timeline).not.toMatch(/达米安(?!·克劳)/u)
    expect(timeline).not.toMatch(/艾玛(?!·克劳)/u)
  })

  it('rebases a four-section storyboard timeline and only holds the tail for a discrete model duration', () => {
    const structured = [
      '【风格基调】',
      '现实主义都市短剧，冷灰蓝晨光。',
      '【人物及初始站位】',
      '人物锁定：林晨站在岗亭外三米处。',
      '【场景】',
      '时间地点：清晨｜高档小区门口',
      '环境锁定：金属岗亭和升降栏杆位置固定。',
      '【视频分镜】',
      '0~4s：地面特写，外卖散落。',
      '4~8s：林晨攥紧背包肩带。',
    ].join('\n')
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.photorealistic,
      maxLength: 4900,
      outputDuration: 10,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林晨' },
        { referenceOrder: 2, type: AssetType.location, name: '高档小区门口' },
      ],
      storyboards: [{ title: '门口冲突', duration: 8, videoPrompt: structured }],
    })

    expect(prompt.match(/@image1/gu)).toHaveLength(1)
    expect(prompt.match(/@image2/gu)).toHaveLength(1)
    expect(prompt).toContain('0~4s：地面特写')
    expect(prompt).toContain('4~8s：林晨攥紧背包肩带')
    expect(prompt).toContain('8~10s：剧情已结束，只保持最后尾帧')
    expect(prompt).not.toContain('下一场景')
  })

  it('sanitizes a polluted legacy scene before submitting the structured prompt to video generation', () => {
    const structured = [
      '【风格基调】',
      '现实主义都市短剧。',
      '【人物及初始站位】',
      '林晨站在河边。',
      '【场景】',
      '日，外｜哈德逊河边。场景资产唯一锚点“哈德逊河边”：林晨扶着栏杆喘气。苏文菁：“现在几点？”河面宽阔，铁质栏杆沿岸延伸。午后自然光从左侧斜射。你来翡翠山庄，现在。',
      '【视频分镜】',
      '0~5s：林晨回答：“八点十七。”',
    ].join('\n')
    const prompt = buildStoryboardVideoPrompt({
      title: '河边通话',
      videoPrompt: structured,
      visualStyle: VisualStyle.photorealistic,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林晨' },
        { referenceOrder: 2, type: AssetType.location, name: '哈德逊河边' },
      ],
    })
    const scene = prompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''

    expect(scene).toContain('@image2 是场景“哈德逊河边”')
    expect(scene).toContain('铁质栏杆沿岸延伸')
    expect(scene).not.toContain('林晨扶着栏杆')
    expect(scene).not.toContain('苏文菁')
    expect(scene).not.toContain('你来翡翠山庄')
    expect(scene.length).toBeLessThan(560)
  })

  it('keeps the overseas English dialogue and voice lock above a structured local style', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '纽约公寓争执',
      videoPrompt: [
        '【风格基调】',
        '项目统一画风：真人写实。',
        '真人影视摄影风格，真实人物比例与面部，电影级自然光和材质。',
        '严格保持同一项目中人物、道具、场景的色彩体系一致。',
        '现实主义都市短剧。',
        '【人物及初始站位】',
        '林晨站在门边。',
        '【场景】',
        '纽约公寓客厅。',
        '【视频分镜】',
        '0~5s：林晨说：“你为什么骗我？”',
      ].join('\n'),
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 1200,
      duration: 5,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林晨' },
        { referenceOrder: 2, type: AssetType.location, name: '纽约公寓' },
      ],
    })

    expect(prompt).toContain('海外真人短剧，美式真人电影感')
    expect(prompt).toContain('对白使用自然美式英语')
    expect(prompt).toContain('声线贴合人物')
    expect(prompt).toContain('现实主义都市短剧')
    expect(prompt).not.toContain('项目统一画风：真人写实')
    expect(prompt.length).toBeLessThanOrEqual(1200)
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

    expect(prompt).toContain('@image1=苏文菁')
    expect(prompt).toContain('@image2=陈蕊')
    expect(prompt).toContain('@image3=场景“翡翠山庄别墅客厅”')
    expect(prompt).toContain('@image4=道具“水晶红酒杯”')
    expect(prompt).toContain('场景锚点：')
    expect(prompt).toContain('关键道具必须复刻对应参考图')
    expect(prompt).toContain('忽略卡片文字、色板、标尺和排版')
    expect(prompt).toContain('正面、侧面、背面和面部特写只代表同一人')
    expect(prompt).toContain('人物参考图是唯一视觉依据')
    expect(prompt).toContain('若与图冲突，一律以图为准')
    expect(prompt).toContain('不得复制、替换人物')
    expect(prompt).toContain('真人影视摄影风格')
    expect(prompt).toContain('连续性与动作安全')
    expect(prompt).toContain('双脚不滑移')
    expect(prompt).toContain('物体不穿透')
  })

  it('keeps long prompts within the Grok API limit while preserving critical sections', () => {
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
      maxLength: 4000,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 2, type: AssetType.character, name: '陈蕊' },
        { referenceOrder: 3, type: AssetType.location, name: '翡翠山庄别墅客厅' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(4000)
    expect(prompt).toContain('动作顺序：')
    expect(prompt).toContain('动作物理：')
    expect(prompt).toContain('动作对白：')
    expect(prompt).toContain('禁止项：')
    expect(prompt).not.toContain('这部分会由外层统一提供')
    expect(prompt.indexOf('禁止项：')).toBeLessThan(prompt.indexOf('动作顺序：'))
    expect(prompt.indexOf('动作顺序：')).toBeLessThan(prompt.lastIndexOf('画面描述：'))
  })

  it('keeps a structured Seedance Fast prompt below 1200 characters with references and timeline', () => {
    const structured = [
      '【风格基调】',
      '现实主义都市短剧，冷灰晨光，纪实质感。不要字幕。',
      '【人物及初始站位】',
      '林晨站在书桌左侧，苏文菁坐在右侧，两人保持固定服装。',
      '【场景】',
      '下午｜翡翠山庄书房。整面墙书架与黑胡桃木书桌保持固定。',
      '【视频分镜】',
      '0~5s：中景固定，林晨抬眼看向苏文菁。',
      '5~10s：苏文菁放下文件，低声说：“继续。”',
      '10~15s：林晨轻轻点头，视线回到电脑屏幕。',
    ].join('\n')
    const prompt = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.photorealistic,
      maxLength: 1104,
      outputDuration: 15,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林晨' },
        { referenceOrder: 2, type: AssetType.character, name: '苏文菁' },
        { referenceOrder: 3, type: AssetType.location, name: '翡翠山庄书房' },
      ],
      storyboards: [{ title: '书房交谈', duration: 15, videoPrompt: structured }],
    })

    expect(prompt.length).toBeLessThanOrEqual(1104)
    expect(prompt).toContain('@image1')
    expect(prompt).toContain('@image2')
    expect(prompt).toContain('@image3')
    expect(prompt).toContain('0~5s：')
    expect(prompt).toContain('10~15s：')
  })

  it('preserves every timed segment and the ending when compacting a long cliff reveal', () => {
    const structured = [
      '【风格基调】',
      '海外真人短剧，美式真人电影感，冷峻压抑、背叛揭密、月夜奇幻反转。不要字幕，不要背景音乐，保留现场对白和环境声。',
      '【人物及初始站位】',
      '克莱尔·摩根：40岁灰袍医生，位于月光岩壁外侧的窄岩台，声音颤抖，使用自然美式英语。',
      '达米安·克劳：西装笔挺，站在岩壁上方，男声平静冰冷，使用自然美式英语。',
      '【场景】',
      '夜晚｜月光悬崖。月光岩壁，冷蓝月光，强风卷动衣摆与发丝。',
      '【视频分镜】',
      '0~3s：中景，固定机位。克莱尔扶住岩壁，缓慢抬头说：“Why...?”',
      '3~10s：双人中近景，达米安平静地说：“Twenty years ago, Gideon and I sealed your power. You were only a tool.” 克莱尔听完后表情转为震惊。',
      '10~15s：克莱尔面部特写。白狼银光从脚下升起，她沿垂直方向连续移出画面；一道巨大白狼虚影在月光下闪现，随后消失，画面直接切黑。无对白。',
    ].join('\n')
    const prompt = buildStoryboardVideoPrompt({
      title: '悬崖揭密与奇幻转场',
      videoPrompt: structured,
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 1104,
      duration: 15,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安·克劳' },
        { referenceOrder: 3, type: AssetType.location, name: '月光悬崖' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(1104)
    expect(prompt).toContain('@image1')
    expect(prompt).toContain('@image2')
    expect(prompt).toContain('@image3')
    expect(prompt).toContain('0~3s：')
    expect(prompt).toContain('3~10s：')
    expect(prompt).toContain('10~15s：')
    expect(prompt).toContain('Twenty years ago')
    expect(prompt).toContain('白狼虚影')
    expect(prompt).toContain('画面直接切黑')
  })

  it('fuses directing details into concise natural-language Seedance timeline blocks', () => {
    const structured = [
      '【风格基调】',
      '海外真人短剧，美式真人电影感。不要字幕，不要背景音乐。',
      '【人物及初始站位】',
      '林夏站在画面左侧，洛雪微站在画面右侧，两人保持一臂距离。',
      '【场景】',
      '白天｜学校门口。灰色石阶与金属校门位置固定。',
      '【视频分镜】',
      '0~8s：镜头与构图：林夏正面近景，固定机位；动作顺序：林夏先抬起下巴，随后说完拒绝并站在原地；动作物理：林夏双脚不换位，重心保持在两脚之间；表演变化：林夏眉峰收紧，眼神由警惕转为坚定；对白：林夏：“我不能跟陌生人走。”；本段结束状态：林夏仍在画面左侧，下巴抬起，双脚站稳。',
      '8~15s：镜头与构图：双人中近景，固定机位；动作顺序：洛雪微先报价，随后林夏前倾半步追问；动作物理：林夏只向前转移重心，不跨步，不与洛雪微接触；表演变化：洛雪微保持平静，林夏由坚定转为惊讶；对白：洛雪微：“给你一万。” 林夏：“多少？”；本段结束状态：林夏仍在左侧并前倾半步，洛雪微仍在右侧。',
    ].join('\n')
    const prompt = buildStoryboardVideoPrompt({
      title: '学校门口报价',
      videoPrompt: structured,
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 1104,
      duration: 15,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林夏' },
        { referenceOrder: 2, type: AssetType.character, name: '洛雪微' },
        { referenceOrder: 3, type: AssetType.location, name: '学校门口' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(1104)
    const segments = parseStoryboardTimelineSegments(prompt)
    expect(segments).toHaveLength(2)
    expect(prompt).toContain('林夏正面近景')
    expect(prompt).toContain('林夏：“我不能跟陌生人走。”')
    expect(prompt).toContain('洛雪微：“给你一万。” 林夏：“多少？”')
    expect(prompt).toContain('林夏由坚定转为惊讶')
    expect(prompt).toContain('林夏双脚不换位')
    expect(prompt.match(/林夏双脚不换位/gu)).toHaveLength(1)
    expect(prompt).not.toContain('动作顺序：')
    expect(prompt).not.toContain('动作物理：')
    expect(prompt).not.toContain('表演变化：')
    expect(prompt).not.toContain('本段结束状态：')
  })

  it('deduplicates character states and locks one actor per role for turnaround references', () => {
    const structured = [
      '【风格基调】',
      '海外真人短剧，美式真人电影感。不要字幕，不要背景音乐。',
      '【人物及初始站位】',
      '克莱尔·摩根（40岁女性，灰袍，双手抓住岩石平台边缘）；达米安·克劳（西装笔挺，站在后方较高岩面）；克莱尔·摩根（向下移动中，灰袍飘动）；达米安·克劳（站在岩石平台边缘，望向下方）',
      '【场景】',
      '夜晚｜月光岩石平台。冷蓝月光，强风。',
      '【视频分镜】',
      '0~4s：中近景，从达米安·克劳腰部高度俯拍克莱尔·摩根。达米安·克劳说：“You were just a tool.”',
      '4~8s：单人中景，仅克莱尔·摩根入镜；达米安·克劳留在画外。克莱尔·摩根向下移出画面，白狼虚影闪现。',
    ].join('\n')
    const prompt = buildStoryboardVideoPrompt({
      title: '悬崖对白续镜至白狼虚影',
      videoPrompt: structured,
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 1104,
      duration: 8,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.character, name: '达米安·克劳' },
        { referenceOrder: 3, type: AssetType.location, name: '月光悬崖' },
      ],
    })

    const people = prompt.match(/【本分镜人物】\n([\s\S]*?)\n【场景】/u)?.[1] || ''
    expect(prompt.length).toBeLessThanOrEqual(1104)
    expect(people).toContain('人数硬锁：全片最多2名唯一人物')
    expect(people).toContain('不得出现第3人')
    expect(people).toContain('单人正面全身，唯一人物')
    expect(people).not.toContain('向下移动中')
    expect(people).not.toContain('站在岩石平台边缘，望向下方')
    expect(prompt).toContain('中近景，从达米安·克劳腰部高度俯拍克莱尔·摩根')
    expect(prompt).toContain('达米安·克劳留在画外')
  })

  it('removes polluted scene actions and merges a repeated clerk beat before Seedance submission', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '拽入大厅至工作人员引导',
      videoPrompt: [
        '【风格基调】',
        '高品质 3D CG 游戏过场动画。',
        '【人物及初始站位】',
        '林夏：白色T恤，左手拖行李箱；洛雪微：白衬衫，左手握林夏右手腕。',
        '初始位置：民政局大门内，洛雪微在前，林夏在后。',
        '【场景】',
        '民政局登记大厅。林夏被洛雪微拽着手腕走进大门；林夏突然凑近，在洛雪微唇上亲了一下。大理石地面、登记台和红色背景墙固定，自然窗光明亮。',
        '【视频分镜】',
        '0~5s：镜头与构图：入口内侧全景；动作顺序：洛雪微左手拽林夏右手腕走进大厅，林夏左手拖行李箱，踉跄一步后站稳；动作物理：洛雪微左手始终握林夏右手腕；表演变化：镜内：洛雪微、林夏，两人。洛雪微强势，林夏困惑；对白：无对白；本段结束状态：两人并排站在入口。',
        '5~10s：镜头与构图：三人中景；动作顺序：中年女工作人员上前，洛雪微点头，随后拉着林夏迈步；动作物理：洛雪微左手仍握林夏右手腕；表演变化：镜内：洛雪微、林夏、中年女工作人员，三人。工作人员微笑，林夏皱眉；对白：中年女工作人员：洛小姐，都准备好了，这边请。；本段结束状态：三人开始走向拍照区。',
        '10~15s：镜头与构图：三人中景；动作顺序：中年女工作人员再次上前，洛雪微再次点头；动作物理：洛雪微仍握林夏右手腕；表演变化：镜内：洛雪微、林夏、中年女工作人员，三人；对白：中年女工作人员：洛小姐，都准备好了，这边请。；本段结束状态：洛雪微拉着林夏跟随工作人员走向拍照区。',
      ].join('\n'),
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1104,
      duration: 15,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '洛雪微' },
        { referenceOrder: 2, type: AssetType.character, name: '林夏' },
        { referenceOrder: 3, type: AssetType.location, name: '民政局登记大厅' },
      ],
    })

    const scene = prompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''
    expect(prompt.length).toBeLessThanOrEqual(1104)
    expect(parseStoryboardTimelineSegments(prompt).map((segment) => [segment.start, segment.end])).toEqual([[0, 5], [5, 15]])
    expect(prompt.match(/洛小姐，都准备好了，这边请/gu)).toHaveLength(1)
    expect(prompt).toContain('文字角色“中年女工作人员”是独立人物')
    expect(prompt).toContain('不得变成或复制洛雪微、林夏')
    expect(scene).toContain('@image3=民政局登记大厅')
    expect(scene).toContain('大理石地面')
    expect(scene).not.toContain('林夏')
    expect(scene).not.toContain('洛雪微')
    expect(scene).not.toContain('亲')
    expect(scene).not.toContain('拽')
    expect(prompt).not.toContain('动作顺序：')
    expect(prompt).not.toContain('动作物理：')
  })

  it('keeps the named speaker when a concise timeline embeds dialogue after an action', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '工作人员引导',
      videoPrompt: [
        '【风格基调】',
        '3D CG 动漫。',
        '【人物及初始站位】',
        '洛雪微在左侧，林夏在右侧，中年女工作人员在前方。',
        '【场景】',
        '民政局登记大厅。大理石地面与登记台固定。',
        '【视频分镜】',
        '0~5s：入口内侧全景，固定机位。洛雪微拉着林夏走进大厅，林夏站稳。无对白。结尾两人停在入口。',
        '5~15s：三人中景，固定机位。中年女工作人员从左前方上前一步，微笑看向洛雪微，说：“洛小姐，都准备好了，这边请。”洛雪微点头，拉着林夏跟随。对白结束后不再重复上前、点头或说话。结尾三人走向拍照区。',
      ].join('\n'),
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1104,
      duration: 15,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '洛雪微' },
        { referenceOrder: 2, type: AssetType.character, name: '林夏' },
        { referenceOrder: 3, type: AssetType.location, name: '民政局登记大厅' },
      ],
    })

    expect(prompt).toContain('中年女工作人员从左前方上前一步，微笑看向洛雪微，说：“洛小姐，都准备好了，这边请。”')
    expect(prompt).not.toContain('说说：')
    expect(prompt).not.toContain('无对白')
    expect(prompt).not.toContain('对白结束后不再重复')
    expect(prompt).not.toContain('结尾三人')
    expect(prompt).not.toContain('…')
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

  it('keeps one deterministic and distinguishable voice profile per character', () => {
    const linXiaVoice = buildCharacterVoiceProfile('林夏', VisualStyle.anime_3d)
    const luoXueweiVoice = buildCharacterVoiceProfile('洛雪微', VisualStyle.anime_3d)

    expect(buildCharacterVoiceProfile('林夏', VisualStyle.anime_3d)).toBe(linXiaVoice)
    expect(luoXueweiVoice).not.toBe(linXiaVoice)
    expect(linXiaVoice).toContain('自然普通话')
    expect(buildCharacterVoiceProfile('Claire Morgan', VisualStyle.overseas_live_action))
      .toContain('自然美式英语')
  })

  it('binds character images and fixed voices only in the opening cast section', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '校门口报价',
      videoPrompt: [
        '【风格基调】',
        '3D CG 动漫，不要背景音乐。',
        '【人物及初始站位】',
        '林夏站在左侧，洛雪微站在右侧。',
        '【场景】',
        '白天｜学校门口。灰色石阶与金属校门位置固定。',
        '【视频分镜】',
        '0~8s：林夏正面近景，林夏拒绝跟洛雪微离开。',
        '8~15s：双人中近景，洛雪微报价，林夏由坚定转为惊讶。',
      ].join('\n'),
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1104,
      duration: 15,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林夏' },
        { referenceOrder: 2, type: AssetType.character, name: '洛雪微' },
        { referenceOrder: 3, type: AssetType.location, name: '学校门口' },
      ],
    })

    const people = prompt.match(/【本分镜人物】\n([\s\S]*?)\n【场景】/u)?.[1] || ''
    const scene = prompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''
    const timeline = prompt.split('【视频分镜】')[1] || ''
    const linXiaVoice = buildCharacterVoiceProfile('林夏', VisualStyle.anime_3d)

    expect(people.match(/@image1=林夏/gu)).toHaveLength(1)
    expect(people.match(/@image2=洛雪微/gu)).toHaveLength(1)
    expect(people).toContain(`固定声音：${linXiaVoice}`)
    expect(scene).not.toMatch(/@image[12]/u)
    expect(timeline).not.toContain('@image')
    expect(timeline).toContain('林夏')
    expect(timeline).toContain('洛雪微')
    expect(prompt).toContain('绝对不要生成任何背景音乐（BGM）或旋律性配乐')
    expect(prompt.match(/BGM/gu)).toHaveLength(1)
  })

  it('keeps the mature semi-realistic 3D style and exact asset appearance lock with four characters', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '宿舍推门',
      videoPrompt: [
        '【风格基调】',
        '3D CG 动漫，不要背景音乐。',
        '【本分镜人物】',
        '林夏在门口；陈浩和吕嘉豪按住陆野。',
        '【场景】',
        '白天｜206宿舍。床铺、书桌和自然窗光固定。',
        '【视频分镜】',
        '0~5s：林夏推门，看见陈浩和吕嘉豪按住陆野。',
        '5~10s：陆野抬头向林夏求救。',
        '10~15s：林夏停下脚步，观察三人。',
      ].join('\n'),
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1104,
      duration: 15,
      aspectRatio: '16:9',
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林夏' },
        { referenceOrder: 2, type: AssetType.character, name: '陈浩' },
        { referenceOrder: 3, type: AssetType.character, name: '吕嘉豪' },
        { referenceOrder: 4, type: AssetType.character, name: '陆野' },
      ],
    })

    expect(prompt.length).toBeLessThanOrEqual(1104)
    expect(prompt).toContain('高精度半写实3D数字人电影CG')
    expect(prompt).toContain('真人面捕式微表情')
    expect(prompt).toContain('眼眶嘴巴尺寸固定')
    expect(prompt).toContain('禁儿童3D动画、萌系Q版、大头圆脸、圆瞪眼、张大嘴')
    expect(prompt).toContain('外观硬锁：逐帧复刻各人物@image的脸型、五官比例、发型发色、年龄体型和服装')
    expect(prompt).toContain('@image1=林夏（单人正面全身，唯一人物）')
    expect(prompt).toContain('@image4=陆野（单人正面全身，唯一人物）')
    expect(prompt).toContain('人数硬锁：全片最多4名唯一人物')
    expect(prompt).toContain('不得出现第5人')
    expect(prompt).toContain('10~15s：')
  })

  it('converts cartoon-like expression directions into restrained facial acting without changing dialogue', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '克制表演',
      videoPrompt: [
        '【风格基调】',
        '3D CG。',
        '【本分镜人物】',
        '林夏和陆野面对面。',
        '【场景】',
        '白天｜宿舍。',
        '【视频分镜】',
        '0~5s：林夏愣了一下，随后大喊：“你别瞪大眼睛吓我。”',
        '5~10s：陆野瞪大眼睛，张大嘴看向林夏。',
        '10~15s：林夏嘴角带笑，保持原位。',
      ].join('\n'),
      visualStyle: VisualStyle.anime_3d,
      maxLength: 1104,
      duration: 15,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '林夏' },
        { referenceOrder: 2, type: AssetType.character, name: '陆野' },
      ],
    })

    expect(prompt).toContain('林夏目光短暂停住，眉间轻微收紧，面部幅度克制')
    expect(prompt).toContain('提高音量呼喊，嘴型自然不过度张开：“你别瞪大眼睛吓我。”')
    expect(prompt).toContain('陆野眼神骤然定住，内眉轻抬，眼眶大小保持不变')
    expect(prompt).toContain('嘴唇微张，嘴型大小保持自然')
    expect(prompt).toContain('林夏嘴角轻微上扬')
    expect(prompt).not.toContain('林夏愣了一下')
    expect(prompt).not.toContain('陆野瞪大眼睛')
  })

  it('reuses the same character voice text in single and combined video prompts', () => {
    const source = [
      '【风格基调】',
      '3D CG 动漫。',
      '【本分镜人物】',
      '林夏站在左侧。',
      '【场景】',
      '白天｜学校门口。',
      '【视频分镜】',
      '0~5s：林夏看向校门。',
    ].join('\n')
    const references = [
      { referenceOrder: 1, type: AssetType.character, name: '林夏' },
    ]
    const single = buildStoryboardVideoPrompt({
      title: '看向校门',
      videoPrompt: source,
      visualStyle: VisualStyle.anime_3d,
      references,
    })
    const combined = buildCombinedStoryboardVideoPrompt({
      visualStyle: VisualStyle.anime_3d,
      references,
      storyboards: [
        { title: '看向校门', duration: 5, videoPrompt: source },
        { title: '继续等待', duration: 5, videoPrompt: source.replace('看向校门', '留在原地') },
      ],
    })
    const voice = buildCharacterVoiceProfile('林夏', VisualStyle.anime_3d)

    expect(single).toContain(`固定声音：${voice}`)
    expect(combined).toContain(`固定声音：${voice}`)
    expect(combined.match(/BGM/gu)).toHaveLength(1)
  })

  it('splits a composite cast label and defines each character voice only once', () => {
    const prompt = buildNaturalStoryboardPrompt({
      visualStyle: VisualStyle.anime_3d,
      style: '3D CG 动漫。',
      people: '陆野、陈浩、吕嘉豪（站在背景中）\n初始位置：陆野、陈浩、吕嘉豪在走廊等候。',
      scene: '白天｜校园主干道。',
      detailedTimeline: '0~5s：陆野看向陈浩，吕嘉豪保持画外。',
      duration: 5,
      characterNames: ['陆野', '陈浩', '吕嘉豪', '陆野、陈浩、吕嘉豪'],
    })

    expect(prompt.match(/陆野固定声音：/gu)).toHaveLength(1)
    expect(prompt.match(/陈浩固定声音：/gu)).toHaveLength(1)
    expect(prompt.match(/吕嘉豪固定声音：/gu)).toHaveLength(1)
    expect(prompt).not.toContain('陆野、陈浩、吕嘉豪固定声音：')
  })

  it('omits background-only characters even when the cast is below four', () => {
    const prompt = buildNaturalStoryboardPrompt({
      visualStyle: VisualStyle.anime_3d,
      style: '3D CG 动漫。',
      people: '林夏（学生）；顾玉荣（主管）；陆野（同学）\n初始位置：林夏面对顾玉荣；陆野在背景等待。',
      scene: '白天｜校园主干道。',
      detailedTimeline: '0~5s：林夏质问顾玉荣；陆野在背景等待，不参与动作。',
      duration: 5,
      characterNames: ['林夏', '顾玉荣', '陆野'],
    })

    expect(prompt).toContain('林夏固定声音：')
    expect(prompt).toContain('顾玉荣固定声音：')
    expect(prompt).not.toContain('陆野固定声音：')
    expect(prompt).not.toContain('陆野在背景等待')
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
  it('derives the required director-review format for legacy storyboards', () => {
    const prompt = buildLegacyDirectorStoryboardPrompt({
      number: 4,
      title: '门口对峙',
      videoPrompt: [
        '【场景】',
        '夜晚，厂家属院门口，砖墙和路灯位置固定。',
        '【视频分镜】',
        '0~5s：中景快速横移，赵金虎把木牌挂上墙，对许桂芳说：“明天，你一份也别想卖出去。”',
      ].join('\n'),
    })

    expect(prompt).toMatch(/^分镜4：\n景别机位运动：/u)
    expect(prompt).toContain('\n画面内容：夜晚，厂家属院门口')
    expect(prompt).toContain('\n动作对白：')
    expect(prompt).toContain('“明天，你一份也别想卖出去。”')
  })

  it('requires the current revision when updating a storyboard', () => {
    expect(() => updateStoryboardSchema.parse({ videoPrompt: '新提示词' })).toThrow()
    expect(updateStoryboardSchema.parse({
      videoPrompt: '新提示词',
      baseUpdatedAt: '2026-07-27T12:00:00.000Z',
    })).toMatchObject({
      videoPrompt: '新提示词',
      baseUpdatedAt: '2026-07-27T12:00:00.000Z',
    })
  })

  it('accepts two to four unique storyboards for one combined task', () => {
    expect(generateStoryboardVideoGroupSchema.parse({
      storyboardIds: ['shot-1', 'shot-2', 'shot-3', 'shot-4'],
      model: 'seedance-2.0-mini',
      duration: 12,
    })).toMatchObject({
      storyboardIds: ['shot-1', 'shot-2', 'shot-3', 'shot-4'],
      duration: 12,
    })
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

  it('accepts Seedance 2.5 long-duration generation settings up to 30 seconds', () => {
    expect(generateStoryboardVideoSchema.parse({
      duration: 30,
      resolution: '480p',
      model: 'seedance-2.5-480p',
    })).toMatchObject({ duration: 30, resolution: '480p', model: 'seedance-2.5-480p' })
    expect(generateStoryboardVideoGroupSchema.parse({
      storyboardIds: ['shot-1', 'shot-2'],
      duration: 30,
      model: 'seedance-2.5-480p',
    })).toMatchObject({ duration: 30 })
    expect(() => generateStoryboardVideoSchema.parse({ duration: 31 })).toThrow()
  })

  it('requires the continuity source video and tail-frame media as a pair', () => {
    expect(generateStoryboardVideoSchema.parse({
      continuitySourceVideoId: 'video-1',
      continuityFrameMediaId: 'media-1',
    })).toMatchObject({
      continuitySourceVideoId: 'video-1',
      continuityFrameMediaId: 'media-1',
    })
    expect(() => generateStoryboardVideoSchema.parse({
      continuitySourceVideoId: 'video-1',
    })).toThrow()
  })

  it('enables dialogue audio by default for video generation', () => {
    expect(generateStoryboardVideoSchema.parse({})).toMatchObject({ generateAudio: true })
    expect(generateStoryboardVideoSchema.parse({ generateAudio: false }))
      .toMatchObject({ generateAudio: false })
  })

  it('rejects unsupported video resolutions', () => {
    expect(() => generateStoryboardVideoSchema.parse({ resolution: '2160p' })).toThrow()
  })

  it('accepts HappyHouse 3-second 1080p generation settings', () => {
    expect(generateStoryboardVideoSchema.parse({
      duration: 3,
      resolution: '1080p',
      model: 'happyhouse-1.1',
    })).toMatchObject({
      duration: 3,
      resolution: '1080p',
      model: 'happyhouse-1.1',
      generateAudio: true,
    })
  })
})

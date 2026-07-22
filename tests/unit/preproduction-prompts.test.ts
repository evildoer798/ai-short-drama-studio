import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildAssetExtractionPrompt,
  buildAssetCurationPrompt,
  buildAssetInventoryPrompt,
  buildAssetSelectionPrompt,
  buildEpisodeDraftPrompt,
  buildEpisodePlanPrompt,
  buildEpisodeQualityRepairPrompt,
  buildMissingDialogueShotsPrompt,
  buildSeriesBibleMergePrompt,
  buildSeriesBiblePrompt,
  buildSingleAssetPrompt,
  buildStoryboardGenerationPrompt,
  canonicalizeScriptCharacterNames,
  dialogueMissing,
  enforceAssetPrompt,
  extractRequiredStoryboardDialogueLines,
  extractScriptDialogueLines,
  extractScriptSceneLocations,
  extractSourceDialogues,
  sanitizeNovelEvidenceForTextPrompt,
  splitNovelIntoChunks,
  STORYBOARD_GLOBAL_RULES,
} from '../../src/lib/preproduction-prompts'

describe('preproduction prompt rules', () => {
  it('keeps plot consequences while redacting explicit intimacy from provider evidence', () => {
    const evidence = '苏文菁提出交易。两名成年人发生性交，随后林晨发现衬衫扣子掉了。第二天二人关系变得紧张。'
    const safe = sanitizeNovelEvidenceForTextPrompt(evidence)
    expect(safe).not.toContain('性交')
    expect(safe).toContain('成年人亲密关系情节')
    expect(safe).toContain('人物关系变化')
    expect(safe).toContain('事后影响')
  })

  it('splits long novels in source order without dropping paragraph text', () => {
    const source = ['第一段内容。', '第二段内容很长。', '第三段收尾。'].join('\n\n')
    const chunks = splitNovelIntoChunks(source, 12)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.content).join('\n\n')).toContain('第一段内容。')
    expect(chunks.map((chunk) => chunk.content).join('\n\n')).toContain('第三段收尾。')
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index + 1))
  })

  it('extracts quoted source dialogue and screenplay dialogue', () => {
    const source = '苏文菁说：“下周见面吃饭。”陈蕊只回了一句：“哦。”'
    expect(extractSourceDialogues(source).map((item) => item.text)).toEqual(['下周见面吃饭。', '哦。'])
    expect(extractScriptDialogueLines('苏文菁：下周见面吃饭。\n陈蕊【OS】：真麻烦。')).toEqual([
      { speaker: '苏文菁', os: false, text: '下周见面吃饭。' },
      { speaker: '陈蕊', os: true, text: '真麻烦。' },
    ])
    expect(dialogueMissing('苏文菁：下周见面吃饭', '下周见面吃饭。')).toBe(false)
  })

  it('requires on-screen dialogue but leaves narration and OS available for visual replacement', () => {
    const script = [
      '苏文菁：下周见面吃饭。',
      '陈蕊【OS】：真麻烦。',
      '旁白：夜色压在城市上空。',
      '画外音：三年前，她曾离开这里。',
    ].join('\n')

    expect(extractRequiredStoryboardDialogueLines(script)).toEqual([
      { speaker: '苏文菁', os: false, text: '下周见面吃饭。' },
    ])
  })

  it('locks canonical character names and adjacent episode context into script prompts', () => {
    const seriesBible = {
      characters: [{
        canonicalName: '陈蕊',
        aliases: ['Jessica'],
        identity: '苏文菁的女儿，艺术史学生',
        relationships: ['苏文菁的女儿'],
      }],
      continuityRules: ['陈蕊始终使用陈蕊作为说话人姓名'],
    }
    const biblePrompt = buildSeriesBiblePrompt({
      analyses: [{ index: 1, analysis: '陈蕊也被称作Jessica。' }],
      sourceExcerpts: [{ index: 1, content: '苏文菁给女儿陈蕊打电话。' }],
    })
    expect(biblePrompt).toContain('canonicalName')
    const mergePrompt = buildSeriesBibleMergePrompt({
      parts: [{ sourceChunkIndexes: [1], bible: seriesBible }],
    })
    expect(mergePrompt).toContain('canonicalName')
    expect(mergePrompt).toContain('原文片段 1')
    expect(biblePrompt).toContain('同一人物的英文名、昵称、旧称放入 aliases')

    const planPrompt = buildEpisodePlanPrompt({
      analyses: [{ index: 1, analysis: '母女通话。' }],
      targetEpisodeCount: 2,
      episodeMinutes: 1.5,
      seriesBible,
    })
    expect(planPrompt).toContain('全剧唯一人物名册')
    expect(planPrompt).toContain('openingContinuity')
    expect(planPrompt).toContain('endingContinuity')
    expect(planPrompt).toContain('每个片段必须且只能分配给一集')
    expect(planPrompt).toContain('倒叙冷开场')
    expect(planPrompt).toContain('第 1 至 3 集必须快速进入核心矛盾')

    const draftPrompt = buildEpisodeDraftPrompt({
      episodeNumber: 2,
      title: '见面之前',
      logline: '陈蕊准备赴约',
      episodeMinutes: 1.5,
      goals: ['承接视频通话'],
      sourceText: '陈蕊放下手机。',
      analyses: '陈蕊情绪倦怠。',
      sourceDialogues: [],
      seriesBible,
      openingContinuity: '陈蕊仍靠在床头，手机在手中',
      endingContinuity: '陈蕊决定赴约',
      previousEpisode: {
        title: '母女通话',
        logline: '苏文菁通知见面',
        endingExcerpt: '陈蕊：哦。陈蕊放下手机。',
      },
      nextEpisode: {
        title: '初次见面',
        logline: '陈蕊到达餐厅',
        openingContinuity: '陈蕊穿着耶鲁卫衣进入餐厅',
      },
    })
    expect(draftPrompt).toContain('上一集连续性尾帧')
    expect(draftPrompt).toContain('下一集专属开场条件')
    expect(draftPrompt).toContain('只能使用“全剧唯一人物名册”的标准姓名')
    expect(draftPrompt).toContain('陈蕊仍靠在床头')
    expect(draftPrompt).toContain('原则上不写旁白')
    expect(draftPrompt).toContain('每个物理拍摄空间建立一个至少四个字的全剧唯一标准场景名')
    expect(draftPrompt).toContain('严禁逐句复制、概述、闪回或再次表演')
    expect(draftPrompt).toContain('【结尾Hook】')
    expect(draftPrompt).toContain('本集不得使用 【倒叙冷开场】')

    const firstEpisodePrompt = buildEpisodeDraftPrompt({
      episodeNumber: 1,
      title: '雨夜订单',
      logline: '林晨接到改变命运的订单',
      episodeMinutes: 1.5,
      goals: ['进入翡翠山庄'],
      sourceText: '林晨在雨夜接到最后一单。',
      analyses: '订单指向陌生别墅。',
      sourceDialogues: [],
      seriesBible,
      openingContinuity: '原著开端',
      endingContinuity: '门锁落下',
      flashforwardCandidates: '后续片段：铁门后传来枪声。',
    })
    expect(firstEpisodePrompt).toContain('第一集必须在标题之后先写 【倒叙冷开场】')
    expect(firstEpisodePrompt).toContain('【回到主线】')
    expect(firstEpisodePrompt).toContain('前 20 秒触发主角当前困境')

    const repairPrompt = buildEpisodeQualityRepairPrompt({
      episodeNumber: 2,
      episodeMinutes: 1.5,
      title: '重复版本',
      logline: '交易升级',
      content: '重复上一集的交易。',
      issues: ['与第 1 集存在大段重复', '缺少 【结尾Hook】'],
      sourceText: '林晨在交易后第一次见到陈蕊。',
      seriesBible,
      previousEpisode: { title: '雨夜订单', endingExcerpt: '门锁落下。' },
      nextEpisode: { title: '艰难选择', openingContinuity: '陈蕊离开房间' },
    })
    expect(repairPrompt).toContain('本集之外的事件一律删除')
    expect(repairPrompt).toContain('下一集材料是禁区')
    expect(repairPrompt).toContain('【结尾Hook】')
  })

  it('canonicalizes speaker labels without rewriting nicknames inside dialogue', () => {
    const content = [
      '场次一 夜 内景',
      'Jessica靠在床头，苏文菁看向屏幕。',
      '动作：Jessica放下手机。',
      'Jessica：我还是Jessica。',
      '苏文菁：Jessica，下周见。',
    ].join('\n')
    const normalized = canonicalizeScriptCharacterNames(content, [
      { observedName: 'Jessica', canonicalName: '陈蕊' },
      { observedName: '文菁', canonicalName: '苏文菁' },
    ])
    expect(normalized).toContain('陈蕊靠在床头，苏文菁看向屏幕。')
    expect(normalized).toContain('动作：陈蕊放下手机。')
    expect(normalized).toContain('陈蕊：我还是Jessica。')
    expect(normalized).toContain('苏文菁：Jessica，下周见。')
    expect(normalized).not.toContain('苏苏文菁')
  })

  it('enforces anonymous, empty location prompts and distinctive names', () => {
    const result = enforceAssetPrompt({
      type: AssetType.location,
      name: '客厅',
      prompt: '夜晚，苏文菁坐在暖黄落地灯旁，24mm，f5.6。',
      characterNames: ['苏文菁'],
      visualStyle: VisualStyle.photorealistic,
    })
    expect([...result.name].length).toBeGreaterThanOrEqual(4)
    expect(result.prompt.startsWith('不能出现其他人, 无人, 纯场景,')).toBe(true)
    expect(result.prompt).not.toContain('苏文菁')
    expect(result.prompt).toMatch(/no humans, empty, landscape only/i)
  })

  it('preserves an exact storyboard scene name even when it is short', () => {
    const result = enforceAssetPrompt({
      type: AssetType.location,
      name: '旧屋',
      prompt: '夜晚空置旧屋，木门和旧沙发位置固定。',
      characterNames: [],
      visualStyle: VisualStyle.photorealistic,
      preserveName: true,
    })
    expect(result.name).toBe('旧屋')
  })

  it('includes the supplied production rules in asset and storyboard prompts', () => {
    const assetPrompt = buildAssetExtractionPrompt({
      script: '第1集\n苏文菁：下周见。',
      visualStyle: VisualStyle.photorealistic,
      knownAssets: [{
        type: AssetType.character,
        name: '陈蕊（Jessica）',
        description: '十八岁艺术史学生',
      }],
    })
    expect(assetPrompt).toContain('正面、侧面、背面')
    expect(assetPrompt).toContain('高角度航拍俯瞰')
    expect(assetPrompt).toContain('不能出现其他人, 无人, 纯场景,')
    expect(assetPrompt).toContain('陈蕊（Jessica）')
    expect(assetPrompt).toContain('原样复用已有名称')

    const storyboardPrompt = buildStoryboardGenerationPrompt({
      episodeNumber: 1,
      episodeTitle: '母女视频通话',
      script: '苏文菁：下周见。',
      assets: [
        { type: AssetType.character, name: '苏文菁', description: '中年女性' },
        { type: AssetType.location, name: '翡翠山庄别墅客厅', description: '米白长沙发、黑色矮几与左侧暖黄落地灯位置固定' },
      ],
      allAssetNames: [
        { type: AssetType.character, name: '苏文菁' },
        { type: AssetType.location, name: '翡翠山庄别墅客厅' },
      ],
      visualStyle: VisualStyle.photorealistic,
    })
    expect(storyboardPrompt).toContain('苏文菁')
    expect(storyboardPrompt).toContain('一个分镜最多只允许一个人物说话')
    expect(storyboardPrompt).toContain('人物在场说出的对白必须逐字保留')
    expect(storyboardPrompt).toContain('非必要旁白/画外音/【OS】必须写成“无对白”')
    expect(storyboardPrompt).toContain('默认全部省略')
    expect(storyboardPrompt).toContain('系统会在保存前自动移除')
    expect(storyboardPrompt).toContain('禁止使用画外音解释角色正在做什么')
    expect(storyboardPrompt).toContain('每镜承载约 70 个中文字')
    expect(storyboardPrompt).toContain('c 对应“景别机位运动”')
    expect(storyboardPrompt).toContain('同职业、同族裔、同款服装或相似道具不代表同一人物')
    expect(storyboardPrompt).toContain('禁止把甲角色的伤势、经历、车辆或随身物品转移给乙角色')
    expect(storyboardPrompt).toContain('v 对应“画面内容”')
    expect(storyboardPrompt).toContain('a 对应“动作对白”')
    expect(storyboardPrompt).toContain('人物锁定、道具锁定、环境与照明锁定')
    expect(storyboardPrompt).toContain('下一镜 p 必须逐项复述上一镜 g')
    expect(storyboardPrompt).toContain('道具只属于谁、戴在哪只手或拿在哪只手')
    expect(storyboardPrompt).toContain('先……；随后……；然后……；最后……')
    expect(storyboardPrompt).toContain('起始姿态和重心、哪一侧肢体主动')
    expect(storyboardPrompt).toContain('人物或物体间接触点')
    expect(storyboardPrompt).toContain('确保主动肢体、双脚和接触点始终在画内')
    expect(storyboardPrompt).toContain('每个原子镜头最多一个复杂身体动作')
    expect(storyboardPrompt).toContain('"m":"重心、主动肢体路径、接触点、遮挡和结束姿态"')
    expect(storyboardPrompt).toContain('"f":"首帧精确构图"')
    expect(storyboardPrompt).toContain('"g":"尾帧精确构图和人物状态"')
    expect(storyboardPrompt).toContain('"z":"剧情专属禁止项和具体负面缺陷词"')
    expect(storyboardPrompt).toContain('{"shots"')
    expect(storyboardPrompt).toContain('翡翠山庄别墅客厅')
    expect(storyboardPrompt).toContain('本段允许的场景资产｜唯一地点白名单')
    expect(storyboardPrompt).toContain('n 必须严格使用“时间｜场景资产标准名”')
    expect(storyboardPrompt).toContain('米白长沙发、黑色矮几与左侧暖黄落地灯位置固定')
    expect(storyboardPrompt).toContain('不得让画面人物错误开口')
    expect(storyboardPrompt).toContain('通用电影参数由系统自动补齐')
    expect(storyboardPrompt).toContain('初始神态 -> 触发动作或对白 -> 可见变化')
    expect(storyboardPrompt).toContain('相邻镜头要有连续而不重复的情绪递进')
    expect(storyboardPrompt).toContain('禁止脱离剧情随机变脸')
    expect(storyboardPrompt).toContain('shots 必须至少包含一个镜头')
    expect(storyboardPrompt).toContain('严禁跨集组合')
    expect(storyboardPrompt).toContain('3-4 个相邻分镜')
    expect(storyboardPrompt).toContain('每集至少形成约 20 个分镜')
    expect(STORYBOARD_GLOBAL_RULES).toContain('相邻镜头承接上一情绪但不得无理由重复同一表情')
    expect(STORYBOARD_GLOBAL_RULES).toContain('只有当前时间段指定的角色开口')
    expect(STORYBOARD_GLOBAL_RULES).toContain('下一镜首帧必须从上一镜尾帧')
    expect(STORYBOARD_GLOBAL_RULES).toContain('角色专属道具不得换手')
    expect(STORYBOARD_GLOBAL_RULES).toContain('禁止两个时空的人物或陈设同时存在')
    expect(STORYBOARD_GLOBAL_RULES).toContain('双脚接触地面时不得滑移')
    expect(STORYBOARD_GLOBAL_RULES).toContain('复杂动作时，优先中景、全身景别的固定机位或单向稳定跟拍')
    expect(STORYBOARD_GLOBAL_RULES).toContain('默认无旁白、无画外音、无内心独白')

    const missingDialoguePrompt = buildMissingDialogueShotsPrompt({
      episodeNumber: 1,
      script: '苏文菁垂眼看着屏幕。\n苏文菁：下周见。',
      missing: [{ speaker: '苏文菁', os: false, text: '下周见。' }],
    })
    expect(missingDialoguePrompt).toContain('初始神态 -> 遗漏对白触发 -> 可见变化')
    expect(missingDialoguePrompt).toContain('视线以及眉眼或嘴角微变化')
    expect(missingDialoguePrompt).toContain('人物、道具、环境、照明、首尾帧和禁止项')
  })

  it('builds storyboard scene anchors directly from locked script headings before assets exist', () => {
    const script = [
      '场次一｜凌晨｜外景｜老陈中餐门口',
      '秋雨密集，油腻屋檐下停着一辆破旧电动车。',
      '场次二｜凌晨｜内景｜翡翠山庄34号客厅',
      '挑空客厅内，落地窗与假火壁炉保持固定位置。',
    ].join('\n')
    const locations = extractScriptSceneLocations(script)

    expect(locations.map((location) => location.name)).toEqual([
      '老陈中餐门口',
      '翡翠山庄34号客厅',
    ])

    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: 1,
      episodeTitle: '雨夜送入豪宅',
      script,
      assets: [],
      visualStyle: VisualStyle.photorealistic,
    })
    expect(prompt).toContain('当前处于先分镜、后资产规划流程')
    expect(prompt).toContain('本段允许的剧本标准场景｜唯一地点白名单')
    expect(prompt).toContain('n 必须严格使用“时间｜剧本标准场景名”')
    expect(prompt).toContain('翡翠山庄34号客厅')
    expect(prompt).toContain('后续资产规划必须复用的唯一名称')
  })

  it('recognizes bracketed scene headings used by uploaded short-drama scripts', () => {
    const script = [
      '【第1集】',
      '',
      '【场次1】老陈中餐外·雨夜·凌晨1:17',
      '纽约秋雨阴冷，屋檐下停着一辆电动车。',
      '',
      '【场次2】皇后大桥·雨夜',
      '哈德逊河在桥下翻着黑色浪花。',
      '',
      '【场次3】翡翠山庄34号·雨夜',
      '花岗岩外墙，落地窗透出暖黄色光。',
    ].join('\n')

    const locations = extractScriptSceneLocations(script)

    expect(locations.map((location) => location.name)).toEqual([
      '老陈中餐外·雨夜·凌晨1:17',
      '皇后大桥·雨夜',
      '翡翠山庄34号·雨夜',
    ])
    expect(locations[0].description).toContain('纽约秋雨阴冷')
    expect(locations[0].description).not.toContain('皇后大桥')
  })

  it('builds small API-only inventory prompts for one asset type at a time', () => {
    const prompt = buildAssetInventoryPrompt({
      script: '夜晚，苏文菁在别墅客厅拿起红酒杯。',
      type: AssetType.prop,
      knownAssets: [
        { type: AssetType.character, name: '苏文菁', description: '中年女性' },
        { type: AssetType.prop, name: '水晶红酒杯', description: '杯沿留有豆沙色唇印' },
      ],
    })
    expect(prompt).toContain('只分析下面这一集中的【道具】')
    expect(prompt).toContain('水晶红酒杯')
    expect(prompt).not.toContain('中年女性')
    expect(prompt).toContain('没有该类型资产时返回空数组')

    const locationInventoryPrompt = buildAssetInventoryPrompt({
      script: '场次一，夜晚，翡翠山庄别墅客厅。',
      type: AssetType.location,
      storyboardEvidence: '- 标准场景：夜晚｜翡翠山庄别墅客厅｜固定环境：米白沙发与暖黄落地灯位置固定',
    })
    expect(locationInventoryPrompt).toContain('逐字复用已锁定剧本场次中的全剧唯一标准场景名')
    expect(locationInventoryPrompt).toContain('固定陈设')
    expect(locationInventoryPrompt).toContain('分镜已经先于资产规划完成')
    expect(locationInventoryPrompt).toContain('夜晚｜翡翠山庄别墅客厅')

    const characterInventoryPrompt = buildAssetInventoryPrompt({
      script: '小张与另一名中年骑手先后出现。',
      type: AssetType.character,
    })
    expect(characterInventoryPrompt).toContain('不同角色即使职业、族裔、服装或道具相同也不得合并')
    expect(characterInventoryPrompt).toContain('地点或剧情身份 + 年龄层 + 职业')
  })

  it('builds a complete single-asset prompt for the same text API', () => {
    const characterPrompt = buildSingleAssetPrompt({
      asset: {
        type: AssetType.character,
        name: '林野',
        description: '24岁中国男性，短黑发，黑色旧夹克。',
        tags: ['普通青年', '疲惫'],
      },
      visualStyle: VisualStyle.photorealistic,
    })
    expect(characterPrompt).toContain('正面、侧面、背面')
    expect(characterPrompt).toContain('统一画风')
    expect(characterPrompt).toContain('林野')
    expect(characterPrompt).toContain('只输出严格 JSON')

    const locationPrompt = buildSingleAssetPrompt({
      asset: {
        type: AssetType.location,
        name: '雨夜老旧街区',
        description: '深夜雨后，老旧小区入口与霓虹街道。',
        tags: ['雨夜'],
      },
      visualStyle: VisualStyle.photorealistic,
    })
    expect(locationPrompt).toContain('不能出现其他人, 无人, 纯场景,')
    expect(locationPrompt).toContain('no humans, empty, landscape only')
  })

  it('asks the API to remove incidental candidates before prompt generation', () => {
    const candidates = [
      { type: AssetType.prop, name: '剧情推荐信', description: '推动入学剧情的推荐信', tags: ['线索'] },
      { type: AssetType.prop, name: '普通找零', description: '购买咖啡后收到的零钱', tags: ['一次性'] },
    ]
    const curationPrompt = buildAssetCurationPrompt({ type: AssetType.prop, assets: candidates })
    expect(curationPrompt).toContain('至少 2 个不同分集')
    expect(curationPrompt).toContain('普通杯子')
    expect(curationPrompt).toContain('不得新增候选中不存在的资产')
    expect(curationPrompt).toContain('剧情推荐信')

    const selectionPrompt = buildAssetSelectionPrompt({
      type: AssetType.prop,
      assets: candidates,
      requiredNames: ['剧情推荐信'],
      episodeAppearances: [
        { name: '剧情推荐信', count: 3 },
        { name: '普通找零', count: 1 },
      ],
    })
    expect(selectionPrompt).toContain('selectedNames 必须逐字复制候选名称')
    expect(selectionPrompt).toContain('剧情推荐信')
    expect(selectionPrompt).toContain('出现于 3 个分集')
  })
})

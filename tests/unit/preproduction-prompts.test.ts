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
  buildStoryboardContinuityRepairPrompt,
  buildStoryboardFinalRepairPrompt,
  buildStoryboardFinalReviewPrompt,
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
    expect(dialogueMissing(
      '林夏：失恋就失恋，看开点。大学里还有漂亮学姐和诗与远方。',
      '失恋就失恋了，看开一点，往好的想，大学里还有漂亮的学姐以及诗和远方呢。',
    )).toBe(false)
    expect(dialogueMissing('林夏：大学生活会更好。', '大学里还有漂亮的学姐以及诗和远方。')).toBe(true)
  })

  it('keeps speaker directions out of names and ignores narrative colons', () => {
    const script = [
      '陆野（语音通话，哭腔）：夏哥，我失恋了。',
      '林夏（叹气）：看开一点。',
      '林夏的手机突然震动，他低头一看，是母亲发来的微信：“儿子，开学快乐。”',
    ].join('\n')

    expect(extractScriptDialogueLines(script)).toEqual([
      { speaker: '陆野', os: false, text: '夏哥，我失恋了。' },
      { speaker: '林夏', os: false, text: '看开一点。' },
    ])
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

  it('does not count screenplay cast metadata as spoken dialogue', () => {
    const script = [
      '场1-1',
      '出场人物：克莱尔、达米安',
      '地点：黑松庄园主屋客厅',
      '克莱尔·摩根：为什么？',
      '达米安·克劳：你只是个工具。',
    ].join('\n')

    expect(extractRequiredStoryboardDialogueLines(script)).toEqual([
      { speaker: '克莱尔·摩根', os: false, text: '为什么？' },
      { speaker: '达米安·克劳', os: false, text: '你只是个工具。' },
    ])
  })

  it('resolves overseas storyboard dialogue to American English instead of exact Chinese speech', () => {
    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: 1,
      episodeTitle: '坠落的开端',
      script: '克莱尔·摩根：为什么？',
      assets: [],
      visualStyle: VisualStyle.overseas_live_action,
    })

    expect(prompt).toContain('a 字段只能写自然、简洁的美式英语')
    expect(prompt).toContain('完整对应源剧本对白的语义、说话人和先后顺序')
    expect(prompt).toContain('禁止出现中文台词')
    expect(prompt).not.toContain('CINE-LOCK 导演情绪设计')
    expect(prompt).toContain('每 3 个连续原子分镜合成为一条 15 秒视频')
  })

  it('preserves exact Chinese dialogue without an episode duration cap', () => {
    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: 1,
      episodeTitle: '开学遇到老婆',
      script: '林夏：失恋就失恋了，看开一点，往好的想。',
      assets: [],
      visualStyle: VisualStyle.anime_3d,
    })

    expect(prompt).toContain('不得删词、改写、合并、串词或换说话人')
    expect(prompt).not.toContain('整集最长 180 秒')
    expect(prompt).toContain('每 3 个连续原子分镜合成为一条 15 秒视频')
    expect(prompt).not.toContain('覆盖约 90 秒剧情')
  })

  it('does not expose the next segment text to the current storyboard generation call', () => {
    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: 1,
      episodeTitle: '坠落的开端',
      script: '克莱尔·摩根仍悬在崖边。',
      assets: [],
      visualStyle: VisualStyle.overseas_live_action,
      segment: {
        index: 1,
        total: 2,
        nextHead: '深海之下，克莱尔手腕封印碎裂。',
      },
    })

    expect(prompt).toContain('当前段不得提前生成、概括或复述后段事件')
    expect(prompt).not.toContain('深海之下，克莱尔手腕封印碎裂')
  })

  it('builds a mandatory full-episode review against the locked script', () => {
    const prompt = buildStoryboardFinalReviewPrompt({
      episodeNumber: 1,
      script: '克莱尔·摩根：为什么？\n崖边碎石松脱。',
      currentJson: '{"shots":[]}',
      targetShotCount: 18,
      visualStyle: VisualStyle.overseas_live_action,
      allowedLocationNames: ['月光悬崖'],
      issues: ['镜头 2 重复坠落'],
    })

    expect(prompt).toContain('从第一行到最后一行做一次最终审片')
    expect(prompt).toContain('镜头 2 重复坠落')
    expect(prompt).toContain('剧情顺序')
    expect(prompt).toContain('结尾钩子')
    expect(prompt).toContain('自然、简洁的美式英语')
    expect(prompt).toContain('月光悬崖')
    expect(prompt).toContain('本次调用只负责找出仍然存在的问题')
    expect(prompt).toContain('"severity":"fatal"')
    expect(prompt).not.toContain('只返回需要执行的小型修复补丁')
  })

  it('builds a separate repair prompt that must apply the review result', () => {
    const prompt = buildStoryboardFinalRepairPrompt({
      episodeNumber: 1,
      script: '克莱尔·摩根：为什么？\n崖边碎石松脱。',
      currentJson: '{"shots":[]}',
      targetShotCount: 18,
      visualStyle: VisualStyle.overseas_live_action,
      allowedLocationNames: ['月光悬崖'],
      repairRound: 2,
      issues: [{
        severity: 'fatal',
        category: 'dialogue',
        shotNumbers: [2],
        scriptEvidence: '克莱尔先问为什么',
        problem: '对白顺序错误',
        repairInstruction: '把克莱尔的对白移到坠落之前',
      }],
    })

    expect(prompt).toContain('第 2 轮整集分镜修复')
    expect(prompt).toContain('只负责根据这些问题生成可执行的小型补丁')
    expect(prompt).toContain('把克莱尔的对白移到坠落之前')
    expect(prompt).toContain('不得返回空补丁')
    expect(prompt).toContain('passed 固定写 false')
  })

  it('keeps dialogue repair verbatim and splits overlong speech', () => {
    const prompt = buildStoryboardContinuityRepairPrompt({
      episodeNumber: 1,
      script: '陆野：感觉还是不太靠谱啊，要不你女装给兄弟我看一次吧。',
      currentJson: '{"shots":[]}',
      issues: ['对白超过镜头自然时长'],
      targetShotCount: 12,
    })

    expect(prompt).toContain('逐字保留说话人和完整原台词')
    expect(prompt).toContain('放不下时拆成多个 4-6 秒原子镜头')
    expect(prompt).toContain('禁止删词、改写或加速念词')
    expect(prompt).toContain('多位现场对白说话人')
  })

  it('locks an explicit cold-open replay and dialogue continuations during final review', () => {
    const prompt = buildStoryboardFinalReviewPrompt({
      episodeNumber: 1,
      script: '【倒叙冷开场】\n克莱尔坠落。\n【回到主线】\n克莱尔在主线后段再次坠落。',
      currentJson: '{"shots":[]}',
      targetShotCount: 18,
      visualStyle: VisualStyle.overseas_live_action,
      allowedLocationNames: ['月光悬崖'],
    })

    expect(prompt).toContain('必须同时保留冷开场预演与主线后段的完整事件')
    expect(prompt).toContain('不得把两者判为普通重复')
    expect(prompt).toContain('标题带“对白续镜”的相邻镜头共同承载一条长对白')
    expect(prompt).toContain('禁止把完整长句复制到每个续镜')
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

  it('builds concise positive location prompts and distinctive names', () => {
    const result = enforceAssetPrompt({
      type: AssetType.location,
      name: '客厅',
      prompt: '夜晚，苏文菁坐在暖黄落地灯旁，24mm，f5.6。',
      characterNames: ['苏文菁'],
      visualStyle: VisualStyle.photorealistic,
    })
    expect([...result.name].length).toBeGreaterThanOrEqual(4)
    expect(result.prompt).toContain('【真人写实】')
    expect(result.prompt).toContain('建筑与环境为画面主体')
    expect(result.prompt).toContain('24mm，f5.6')
    expect(result.prompt).not.toContain('苏文菁')
    expect(result.prompt).not.toMatch(/不能出现其他人|no humans|empty|杜绝/iu)
    expect(result.prompt.length).toBeLessThanOrEqual(820)
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

  it('compacts legacy scene prompts without repeating reverse constraints', () => {
    const result = enforceAssetPrompt({
      type: AssetType.location,
      name: '雨夜翡翠山庄',
      prompt: [
        '不能出现其他人, 无人, 纯场景, 【真人写实】电影级超写实。',
        '场景必须绝对真空与匿名，提示词必须以不能出现其他人开头。',
        '现代雨夜独栋别墅，前景为湿润石板路，中景为花岗岩外墙和门廊，背景为冷蓝夜空。落地窗透出暖黄灯光，皮质沙发与玻璃茶几材质清晰。',
        '镜头参数：电影摄影机，35mm，f5.6，深景深，对焦别墅入口，背景保留环境细节，真实镜头焦外。',
        '杜绝游戏 CG 感、塑料感、过度美化、错误透视、过曝和主体模糊。no humans, empty, landscape only。',
      ].join('\n'),
      characterNames: [],
      visualStyle: VisualStyle.photorealistic,
    })

    expect(result.prompt.match(/【真人写实】/g)).toHaveLength(1)
    expect(result.prompt).toContain('前景为湿润石板路')
    expect(result.prompt).toContain('35mm，f5.6')
    expect(result.prompt).not.toMatch(/不能出现其他人|无人|no humans|empty|杜绝|禁止/iu)
    expect(result.prompt.length).toBeLessThanOrEqual(820)
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
    expect(assetPrompt).toContain('建筑与环境为画面主体')
    expect(assetPrompt).not.toContain('no humans, empty, landscape only')
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
    expect(storyboardPrompt).toContain('你是一位深耕电影30余年的世界顶级导演')
    expect(storyboardPrompt).toContain('适合即梦生成动漫视频')
    expect(storyboardPrompt).toContain('同一原子分镜可以按剧本顺序包含多名角色的连续对话')
    expect(storyboardPrompt).toContain('同一原子分镜允许多位现场对白说话人按剧本顺序依次说话')
    expect(storyboardPrompt).toContain('内心独白标注【OS】')
    expect(storyboardPrompt).toContain('本次生成任务')
    expect(storyboardPrompt).toContain('项目画风补充')
    expect(storyboardPrompt).toContain('【本段可用场景资产】')
    expect(storyboardPrompt).toContain('【本段锁定剧本】')
    expect(storyboardPrompt).not.toContain('【统一画风锁定】')
    expect(storyboardPrompt).not.toContain('CINE-LOCK')
    expect(storyboardPrompt).not.toContain('【不可违反】')
    expect(storyboardPrompt).not.toContain('每个独立分镜累计最多 4 名角色')
    expect(storyboardPrompt).toContain('{"shots"')
    expect(storyboardPrompt).toContain('翡翠山庄别墅客厅')
    expect(storyboardPrompt).toContain('米白长沙发、黑色矮几与左侧暖黄落地灯位置固定')
    expect(storyboardPrompt).toContain('每 3 个连续原子分镜合成为一条 15 秒视频')
    expect(storyboardPrompt).toContain('每条视频提示词开头固定包含【风格基调】【本分镜人物】【场景】')
    expect(storyboardPrompt).toContain('无背景音乐、无字幕')
    expect(STORYBOARD_GLOBAL_RULES).toContain('相邻镜头承接上一情绪但不得无理由重复同一表情')
    expect(STORYBOARD_GLOBAL_RULES).toContain('只有当前时间段指定的角色开口')
    expect(STORYBOARD_GLOBAL_RULES).toContain('下一镜首帧必须从上一镜尾帧')
    expect(STORYBOARD_GLOBAL_RULES).toContain('角色专属道具不得换手')
    expect(STORYBOARD_GLOBAL_RULES).toContain('禁止两个时空的人物或陈设同时存在')
    expect(STORYBOARD_GLOBAL_RULES).toContain('双脚接触地面时不得滑移')
    expect(STORYBOARD_GLOBAL_RULES).toContain('复杂动作时，优先中景、全身景别的固定机位或单向稳定跟拍')
    expect(STORYBOARD_GLOBAL_RULES).toContain('完整保留原剧本明确存在的旁白、画外音和【OS】')
    expect(STORYBOARD_GLOBAL_RULES).toContain('不得用斜杠标题、蒙太奇、快切')

    const missingDialoguePrompt = buildMissingDialogueShotsPrompt({
      episodeNumber: 1,
      script: '苏文菁垂眼看着屏幕。\n苏文菁：下周见。',
      missing: [{ speaker: '苏文菁', os: false, text: '下周见。' }],
    })
    expect(missingDialoguePrompt).toContain('初始神态 -> 对白触发 -> 可见变化')
    expect(missingDialoguePrompt).toContain('当前说话者口型、其他人物的倾听反应')
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
    expect(prompt).toContain('【本段剧本场景】')
    expect(prompt).toContain('翡翠山庄34号客厅')
    expect(prompt).not.toContain('唯一地点白名单')
  })

  it('recognizes compact pipe headings and splits explicitly combined interior and exterior spaces', () => {
    const locations = extractScriptSceneLocations([
      '场次 1｜日/内｜民政局登记大厅',
      '林夏与洛雪微走到登记窗口前。',
      '场次 2｜日/外/内｜民政局门口及迈巴赫车内',
      '两人走出民政局门口，随后坐进迈巴赫车内。',
      '场次 3｜日/外/内｜临江大学新生报到处及校园长椅',
      '林夏先到新生报到处，随后在校园长椅坐下。',
    ].join('\n'))

    expect(locations.map((location) => location.name)).toEqual([
      '民政局登记大厅',
      '民政局门口',
      '迈巴赫车内',
      '临江大学新生报到处',
      '校园长椅',
    ])
    expect(locations[0].description).toContain('林夏与洛雪微走到登记窗口前')
    expect(locations[1].description).toContain('复合场次中的独立空间“民政局门口”')
    expect(locations[2].description).toContain('复合场次中的独立空间“迈巴赫车内”')
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

  it('recognizes compact numbered headings such as scene one, day, exterior', () => {
    const locations = extractScriptSceneLocations([
      '【场1】日/外/哈德逊河边',
      '林晨扶着栏杆打电话。',
      '【场2】日/内/翡翠山庄客厅',
      '林晨打开茶几上的文件盒。',
      '【场3】日/内/翡翠山庄书房',
      '林晨坐在黑胡桃木书桌前。',
    ].join('\n'))

    expect(locations.map((location) => location.name)).toEqual([
      '哈德逊河边',
      '翡翠山庄客厅',
      '翡翠山庄书房',
    ])
    expect(locations[2].description).toContain('日，内')
  })

  it('recognizes unbracketed scene numbers and an explicit underwater hook transition', () => {
    const locations = extractScriptSceneLocations([
      '场1-1',
      '日 内 黑松庄园主屋客厅',
      '克莱尔整理药箱。',
      '场1-2',
      '夜 外 月光悬崖',
      '克莱尔从崖边坠落，画面切黑。',
      '△ 深海之下，克莱尔的身体缓缓下沉，手腕封印开始碎裂。',
    ].join('\n'))

    expect(locations.map((location) => location.name)).toEqual([
      '黑松庄园主屋客厅',
      '月光悬崖',
      '深海之下',
    ])
    expect(locations[2].description).toContain('独立水下空间')
  })

  it('extracts an inline flashback laboratory and a following exterior as separate scenes', () => {
    const locations = extractScriptSceneLocations([
      '场2-3',
      '夜 内 崖底木屋',
      '克莱尔脑海中闪过破碎画面——童年，白色实验室，针管，尖叫。',
      '【闪回】',
      '幼年克莱尔被绑在金属床上。',
      '【闪回结束】',
      '克莱尔手腕金光暴涨，单膝跪地，阿德里安被力量震开。',
      '△ 木屋外，月光下一头白狼虚影仰天长啸。',
    ].join('\n'))

    expect(locations.map((location) => location.name)).toEqual([
      '崖底木屋',
      '实验室（闪回）',
      '木屋外',
    ])
    expect(locations.find((location) => location.name === '崖底木屋')?.description).toContain('手腕金光暴涨')
    expect(locations.find((location) => location.name === '实验室（闪回）')?.description).not.toContain('手腕金光暴涨')
    expect(locations.find((location) => location.name === '木屋外')?.description).toContain('白狼虚影')
  })

  it('treats walking out of a named building as a new exterior scene', () => {
    const locations = extractScriptSceneLocations([
      '【场4】夜 内 黑松庄园·走廊',
      '克莱尔在走廊扶起艾玛。',
      '【结尾Hook】',
      '△ 克莱尔、艾玛和阿德里安三人走出黑松庄园。突然，远处传来狼嚎，无数黑影逼近。',
    ].join('\n'))

    expect(locations.map((location) => location.name)).toEqual([
      '夜 内 黑松庄园·走廊',
      '黑松庄园外',
    ])
    expect(locations[0].description).not.toContain('远处传来狼嚎')
    expect(locations[1].description).toContain('远处传来狼嚎')
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
    expect(prompt).toContain('每一项都必须明确保留 type:"prop"')

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
    expect(characterInventoryPrompt).toContain('至少记录三项可稳定复现的面部身份锚点')
    expect(characterInventoryPrompt).toContain('地点或剧情身份 + 年龄层 + 职业')
    expect(characterInventoryPrompt).toContain('每一项都必须明确保留 type:"character"')
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
    expect(characterPrompt).toContain('同项目角色至少在其中三项形成可见差异')
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
    expect(locationPrompt).toContain('建筑与环境为画面主体')
    expect(locationPrompt).toContain('280-620 个中文字')
    expect(locationPrompt).not.toContain('no humans, empty, landscape only')
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

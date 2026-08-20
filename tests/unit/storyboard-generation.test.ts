import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  actionableStoryboardFinalReviewIssues,
  applyStoryboardFinalReviewPatch,
  allocateStoryboardShotTargets,
  assetInventorySchemaForType,
  assetEpisodeAppearanceCounts,
  canFinalizeStoryboardAfterRepairFailure,
  canUseLocalStoryboardVerificationFallback,
  compactStoryboardShots,
  dedupeStoryboardDialogueShots,
  enforceStoryboardLocationAssets,
  enforceSupplementalDialogue,
  extractAllStoryboardLocationInventories,
  extractStoryboardLocationInventories,
  filterCoreAssetCandidates,
  fitStoryboardDuration,
  materializeStoryboards,
  nonBlockingStoryboardReviewWarnings,
  normalizeOverseasStoryboardDialogueTerms,
  normalizeStoryboardSpokenAudioRules,
  normalizeCompactShot,
  normalizeStoryboardFinalReviewReport,
  normalizeStoryboardFinalReviewPatch,
  packStoryboardVideoClips,
  preferStoryboardReviewCandidate,
  repairStoryboardDirectorCoverage,
  restoreStoryboardCheckpoint,
  storyboardRequestedEpisodeIds,
  storyboardAtomicityIssues,
  storyboardContinuityIssues,
  storyboardDirectorIssues,
  storyboardDialogueMissing,
  storyboardEpisodeReviewIssues,
  storyboardRouteFailureReason,
  storyboardTextRoutePlan,
  storyboardMotionRisk,
  storyboardFinalReviewHasFatalIssues,
  storyboardFinalReviewIssueScore,
  storyboardShotChangeCount,
  shouldFinalizeStoryboardReviewLocally,
  splitStoryboardScript,
  splitOverlongStoryboardDialogueShots,
  stitchStoryboardContinuity,
  suppressNonessentialStoryboardVoiceovers,
  targetStoryboardShotCount,
} from '@/lib/worker/text-generation'
import {
  fuseStoryboardTimelineDetails,
  naturalizeStoryboardTimeline,
  parseStoryboardTimelineDetailFields,
  parseStoryboardTimelineSegments,
  storyboardTimelineDetailIssues,
  STORYBOARD_TIMELINE_DETAIL_LABELS,
} from '@/lib/storyboard-timeline'

type StoryboardTestShot = {
  t: string
  n: string
  i: string
  p: string
  h: string
  r: string
  e: string
  l: string
  c: string
  f: string
  s: string
  m: string
  v: string
  a: string
  q: string
  o: string
  g: string
  x: string
  z: string
  d: number
}

const shot = (action: string, overrides: Partial<StoryboardTestShot> = {}): StoryboardTestShot => ({
  t: '镜头',
  n: '夜晚｜客厅',
  i: '意图：反应；情绪视点：苏文菁；触发：陈蕊的现场对白；情绪落点：苏文菁压住不悦并移开视线',
  p: '承接上一镜稳定尾帧',
  h: '苏文菁与陈蕊保持资产库形象和既定站位',
  r: '黑色窄表带手表只属于苏文菁并固定在左手腕，陈蕊不得佩戴手表',
  e: '米白色沙发和黑色矮几位置固定',
  l: '暖黄落地灯从画面左侧照明',
  c: '中景固定',
  f: '苏文菁位于前景左侧，陈蕊位于背景右侧',
  s: '先保持站位；随后完成动作；最后停在原位置',
  m: '苏文菁双脚稳定着地，右手沿可见路径移动；人物之间无身体接触并保持一米距离',
  v: '人物完成连续动作，视线与眉眼随对白自然变化',
  a: action,
  q: '使用人物固定声线，语气自然克制',
  o: '保留室内空调声，无背景音乐，无字幕',
  g: '苏文菁位于前景左侧，左手腕手表清晰，陈蕊位于背景右侧',
  x: '保持尾帧站位自然进入下一镜',
  z: '禁止手表转移，禁止角色交换位置',
  d: 8,
  ...overrides,
})

describe('asset inventory response normalization', () => {
  it('restores the active extraction type when the model omits or mislabels it', () => {
    const parsed = assetInventorySchemaForType(AssetType.character).parse({
      assets: [{
        name: '洛雪微',
        description: '高马尾青年女性，神情冷静，穿利落短裙。',
        tags: ['高马尾'],
      }, {
        type: AssetType.location,
        name: '林夏',
        description: '清秀男大学生，短发，穿简洁休闲装。',
        tags: ['大学生'],
      }],
    })

    expect(parsed.assets).toHaveLength(2)
    expect(parsed.assets.every((asset) => asset.type === AssetType.character)).toBe(true)
  })

  it('still rejects an asset that lacks required factual content', () => {
    expect(() => assetInventorySchemaForType(AssetType.character).parse({
      assets: [{ name: '洛雪微' }],
    })).toThrow()
  })
})

describe('duration-aware storyboard generation', () => {
  it('flags hidden emotional POV coverage and three repeated camera setups', () => {
    const hiddenClaire = {
      i: '意图：羞辱；情绪视点：克莱尔·摩根；触发：达米安·克劳公开解除伴侣关系；情绪落点：克莱尔·摩根压住震动',
      c: '中景，背面，固定机位',
      f: '克莱尔·摩根背对摄影机站在人群边缘，达米安·克劳正面面对宾客',
      v: '达米安·克劳完成现场对白，克莱尔·摩根保持背影不动',
      g: '克莱尔·摩根仍以背影站在原地',
    }
    const issues = storyboardDirectorIssues([
      shot('达米安·克劳：I am ending our bond.', hiddenClaire),
      shot('达米安·克劳：Sienna is my chosen partner.', hiddenClaire),
      shot('无对白', hiddenClaire),
    ])
    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')

    expect(reasons).toContain('缺少正脸或清晰侧脸的具体微表情反应')
    expect(reasons).toContain('没有保留“克莱尔·摩根”的可读倾听反应')
    expect(reasons).toContain('连续三个镜头使用相同景别、角度和运动')
  })

  it('accepts a readable protagonist reaction with a motivated emotional end beat', () => {
    const issues = storyboardDirectorIssues([
      shot('达米安·克劳：I am ending our bond.', {
        i: '意图：反应；情绪视点：克莱尔·摩根；触发：达米安·克劳公开解除伴侣关系；情绪落点：克莱尔·摩根由受辱转为冷静决断',
        c: '克莱尔·摩根正面近景，固定机位',
        f: '克莱尔·摩根正脸位于画面中心，达米安·克劳肩部虚化在前景',
        v: '达米安·克劳说完后，镜头保留克莱尔·摩根至少一秒反应；克莱尔·摩根眼神短暂下坠，眉眼收紧，随后抬眼直视达米安·克劳',
        g: '克莱尔·摩根正脸清晰，嘴角绷紧，视线稳定落在达米安·克劳身上',
      }),
    ])

    expect(issues).toEqual([])
  })

  it('accepts a safe first-name alias for the same locked emotional POV asset', () => {
    const issues = storyboardDirectorIssues([
      shot('达米安·克劳：I am ending our bond.', {
        i: '意图：反应；情绪视点：克莱尔·摩根；触发：达米安·克劳公开解除伴侣关系；情绪落点：克莱尔·摩根压下受辱感',
        c: '克莱尔正面近景，固定机位',
        f: '克莱尔正脸位于画面中心',
        v: '克莱尔眼神短暂下坠，眉眼收紧，随后抬眼',
        g: '克莱尔正脸清晰，嘴角绷紧',
      }),
    ])

    expect(issues).toEqual([])
  })

  it('gives automatically split dialogue continuations motivated camera progression', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('达米安·克劳：Twenty years ago, Gideon and I sealed your power because you were only a tool and never meant to stand beside me. Sienna is the partner I chose.', {
        i: '意图：羞辱；情绪视点：克莱尔·摩根；触发：达米安·克劳公开贬低克莱尔·摩根；情绪落点：克莱尔·摩根由受辱转为决断',
        c: '双人中景，正面固定机位',
        f: '克莱尔·摩根正脸可见，达米安·克劳位于侧前景',
        v: '克莱尔·摩根眼神收紧并保持清晰侧脸',
        g: '克莱尔·摩根嘴角绷紧，正脸可见',
        d: 5,
      }),
    ])

    expect(shots.length).toBeGreaterThanOrEqual(3)
    expect(new Set(shots.slice(0, 3).map((item) => item.c)).size).toBe(3)
    expect(storyboardDirectorIssues(shots)).toEqual([])
  })

  it('deterministically repairs a hidden emotional POV without changing dialogue or action', () => {
    const source = shot('达米安·克劳：I am ending our bond.', {
      i: '意图：羞辱；情绪视点：克莱尔·摩根；触发：达米安·克劳公开解除伴侣关系；情绪落点：克莱尔·摩根压下受辱感',
      c: '中景，背面，固定机位',
      f: '克莱尔背对摄影机，达米安·克劳正面面对宾客',
      v: '达米安·克劳完成现场对白，克莱尔只以背影状态出现',
      g: '克莱尔仍以背影站在原地',
      s: '先由达米安·克劳说话；最后克莱尔·摩根保持站位。',
    })
    const [repaired] = repairStoryboardDirectorCoverage([source])

    expect(repaired.a).toBe(source.a)
    expect(repaired.s).toBe(source.s)
    expect(repaired.c).toContain('克莱尔·摩根正面或清晰侧面中近景')
    expect(repaired.v).toContain('至少一秒可读反应')
    expect(storyboardDirectorIssues([repaired])).toEqual([])
  })

  it('deterministically changes the third repeated camera in one scene', () => {
    const repaired = repairStoryboardDirectorCoverage([
      shot('无对白', { i: '意图：建立；情绪视点：场景；触发：宾客聚集；情绪落点：公开场合的压力形成' }),
      shot('无对白', { i: '意图：升级；情绪视点：场景；触发：人群安静；情绪落点：冲突即将发生' }),
      shot('无对白', { i: '意图：钩子；情绪视点：场景；触发：所有视线集中；情绪落点：等待公开宣布' }),
    ])

    expect(repaired[2].c).toContain('侧面关系中景')
    expect(storyboardDirectorIssues(repaired)).toEqual([])
  })

  it('applies a compact final-review patch without rewriting unaffected shots', () => {
    const original = [
      shot('角色：第一句', { t: '第一镜' }),
      shot('角色：第二句', { t: '第二镜' }),
      shot('角色：重复内容', { t: '第三镜' }),
    ]
    const replacement = shot('角色：修正后的第二句', { t: '修正第二镜' })
    const insertion = shot('无对白', { t: '结尾钩子' })
    const patched = applyStoryboardFinalReviewPatch(original, {
      passed: true,
      issues: [],
      order: [2, 1],
      remove: [3],
      replacements: [{ shotNumber: 2, shot: replacement }],
      insertions: [{ afterShotNumber: 1, shot: insertion }],
    })

    expect(patched.map((item) => item.t)).toEqual(['修正第二镜', '第一镜', '结尾钩子'])
    expect(patched[1]).toEqual(original[0])
  })

  it('normalizes structured review issues and never downgrades factual errors to warnings', () => {
    const report = normalizeStoryboardFinalReviewReport({
      passed: true,
      issues: [{
        severity: 'warning',
        category: 'directing',
        shotNumber: 2,
        scriptEvidence: '锁定剧本由克莱尔说话',
        problem: '人物身份和说话人错误',
        repairInstruction: '恢复克莱尔身份和对白',
      }, {
        severity: 'warning',
        category: 'directing',
        shotNumbers: [3],
        problem: '连续三个镜头构图略显单调',
        repairInstruction: '调整第三镜景别',
      }],
    })

    expect(report.passed).toBe(false)
    expect(report.issues[0].severity).toBe('fatal')
    expect(report.issues[0].shotNumbers).toEqual([2])
    expect(report.issues[1].severity).toBe('warning')
    expect(storyboardFinalReviewHasFatalIssues(report.issues)).toBe(true)
    expect(storyboardFinalReviewIssueScore(report.issues)).toBeGreaterThan(10_000)
  })

  it('detects an empty repair patch and counts actual changed shots', () => {
    const source = [shot('克莱尔·摩根：Why?'), shot('无对白')]
    const unchanged = applyStoryboardFinalReviewPatch(source, normalizeStoryboardFinalReviewPatch({
      passed: false,
      replacements: [{ shotNumber: 1, shot: { a: source[0].a } }],
    }))
    const changed = applyStoryboardFinalReviewPatch(source, normalizeStoryboardFinalReviewPatch({
      passed: false,
      replacements: [{ shotNumber: 1, shot: { a: '克莱尔·摩根：Why did you betray me?' } }],
    }))

    expect(storyboardShotChangeCount(source, unchanged)).toBe(0)
    expect(storyboardShotChangeCount(source, changed)).toBe(1)
  })

  it('keeps the candidate with fewer fatal review issues', () => {
    const fatalIssue = normalizeStoryboardFinalReviewReport({
      passed: false,
      issues: [{
        severity: 'fatal',
        category: 'dialogue',
        problem: '遗漏现场对白',
        repairInstruction: '补回对白',
      }],
    }).issues
    const warningIssue = normalizeStoryboardFinalReviewReport({
      passed: false,
      issues: [{
        severity: 'warning',
        category: 'directing',
        problem: '第三镜构图略显单调',
        repairInstruction: '调整第三镜景别',
      }],
    }).issues
    const current = [shot('无对白', { t: '当前修复稿' })]
    const best = [shot('无对白', { t: '旧修复稿' })]
    const preferred = preferStoryboardReviewCandidate({
      currentShots: current,
      currentIssues: warningIssue,
      bestShots: best,
      bestIssues: fatalIssue,
    })

    expect(preferred.shots[0].t).toBe('当前修复稿')
    expect(preferred.issues[0].severity).toBe('warning')
  })

  it('finishes locally after the third effective repair instead of requiring another remote verification', () => {
    expect(shouldFinalizeStoryboardReviewLocally({
      stage: 'repaired',
      round: 3,
      maximumRounds: 3,
    })).toBe(true)
    expect(shouldFinalizeStoryboardReviewLocally({
      stage: 'repaired',
      round: 2,
      maximumRounds: 3,
    })).toBe(false)
    expect(shouldFinalizeStoryboardReviewLocally({
      stage: 'verified',
      round: 3,
      maximumRounds: 3,
    })).toBe(false)
  })

  it('uses local verification only for transient or malformed external review failures', () => {
    expect(canUseLocalStoryboardVerificationFallback(new Error('The operation was aborted due to timeout'))).toBe(true)
    expect(canUseLocalStoryboardVerificationFallback(new Error('TEXT_API_FAILED: 503 upstream unavailable'))).toBe(true)
    expect(canUseLocalStoryboardVerificationFallback(new Error('Zod invalid_type in review report'))).toBe(true)
    expect(canUseLocalStoryboardVerificationFallback(new Error('TEXT_API_FAILED: 401 invalid key'))).toBe(false)
  })

  it('saves the best repaired draft when later repair routes are transiently unavailable', () => {
    expect(canFinalizeStoryboardAfterRepairFailure(1, new Error('TEXT_API_FAILED: 503 unavailable'))).toBe(true)
    expect(canFinalizeStoryboardAfterRepairFailure(0, new Error('TEXT_API_FAILED: 503 unavailable'))).toBe(false)
    expect(canFinalizeStoryboardAfterRepairFailure(2, new Error('TEXT_API_FAILED: 403 forbidden'))).toBe(false)
  })

  it('preserves fatal severity when residual findings are exposed for manual confirmation', () => {
    const fatalIssues = normalizeStoryboardFinalReviewReport({
      passed: false,
      issues: [{
        severity: 'fatal',
        category: 'dialogue',
        problem: '遗漏现场对白',
        repairInstruction: '补回对白',
      }],
    }).issues

    const warnings = nonBlockingStoryboardReviewWarnings(fatalIssues)
    expect(warnings).toEqual([expect.objectContaining({
      severity: 'fatal',
      category: 'dialogue',
      problem: '遗漏现场对白',
    })])
    expect(storyboardFinalReviewHasFatalIssues(warnings)).toBe(true)
  })

  it('accepts semantically preserved shortened dialogue and adjacent continuation fragments', () => {
    expect(storyboardDialogueMissing([
      shot('林夏：失恋就失恋，看开点。大学里还有漂亮学姐和诗与远方。'),
    ], {
      speaker: '林夏（叹气）',
      text: '失恋就失恋了，看开一点，往好的想，大学里还有漂亮的学姐以及诗和远方呢。',
    })).toBe(false)

    expect(storyboardDialogueMissing([
      shot('陆野：感觉还是不太靠谱啊，要不你女装给兄弟'),
      shot('陆野：我看一次吧，这样我就不难过了。'),
    ], {
      speaker: '陆野（语音通话）',
      text: '感觉还是不太靠谱啊，要不你女装给兄弟我看一次吧，这样我就不难过了。',
    })).toBe(false)

    expect(storyboardDialogueMissing([
      shot('林夏：还是不太靠谱。'),
    ], {
      speaker: '陆野',
      text: '感觉还是不太靠谱啊，要不你女装给兄弟我看一次吧，这样我就不难过了。',
    })).toBe(true)

    expect(storyboardDialogueMissing([shot('林夏：没有。')], {
      speaker: '林夏',
      text: '没……没啊。',
    })).toBe(false)
    expect(storyboardDialogueMissing([shot('林夏：带了。')], {
      speaker: '林夏',
      text: '带了啊。',
    })).toBe(false)
    expect(storyboardDialogueMissing([shot('林夏：滚。')], {
      speaker: '林夏',
      text: '我@￥……&！',
    })).toBe(false)
  })

  it('migrates legacy checkpoints and resumes the latest repaired episode draft', () => {
    const fingerprint = 'locked-script-fingerprint'
    const legacy = restoreStoryboardCheckpoint({
      version: 5,
      sourceFingerprint: fingerprint,
      completedEpisodeIds: [],
      segments: [{ episodeId: 'episode-1', segmentIndex: 0, shots: [shot('无对白')] }],
    }, fingerprint)
    expect(legacy.version).toBe(6)
    expect(legacy.segments).toHaveLength(1)
    expect(legacy.episodeReviews).toEqual([])

    const resumed = restoreStoryboardCheckpoint({
      version: 6,
      sourceFingerprint: fingerprint,
      completedEpisodeIds: [],
      segments: [],
      episodeReviews: [{
        episodeId: 'episode-1',
        stage: 'repaired',
        round: 1,
        noChangeAttempts: 0,
        modifiedShots: 2,
        currentShots: [shot('克莱尔·摩根：Why?', { t: '最新修复稿' })],
        currentIssues: [],
        bestShots: [shot('无对白', { t: '旧最佳稿' })],
        bestIssues: [],
      }],
    }, fingerprint)

    expect(resumed.episodeReviews[0].stage).toBe('repaired')
    expect(resumed.episodeReviews[0].currentShots[0].t).toBe('最新修复稿')
    expect(resumed.episodeReviews[0].modifiedShots).toBe(2)
  })

  it('persists and resumes an episode review with more than forty atomic shots', () => {
    const fingerprint = 'long-episode-review-fingerprint'
    const longShots = Array.from({ length: 45 }, (_, index) => shot(
      `角色：第 ${index + 1} 个连续剧情节点`,
      { t: `原子镜头 ${index + 1}`, d: 3 },
    ))
    const issue = normalizeStoryboardFinalReviewReport({
      passed: false,
      issues: [{
        severity: 'fatal',
        category: 'continuity',
        shotNumbers: [45],
        problem: '第45镜需要承接前镜站位',
        repairInstruction: '保持上一镜人物站位后再继续动作',
      }],
    }).issues
    const resumed = restoreStoryboardCheckpoint({
      version: 6,
      sourceFingerprint: fingerprint,
      completedEpisodeIds: [],
      segments: [],
      episodeReviews: [{
        episodeId: 'episode-1',
        stage: 'reviewed',
        round: 0,
        noChangeAttempts: 0,
        modifiedShots: 0,
        currentShots: longShots,
        currentIssues: issue,
        bestShots: longShots,
        bestIssues: issue,
      }],
    }, fingerprint)

    expect(resumed.episodeReviews[0].currentShots).toHaveLength(45)
    expect(resumed.episodeReviews[0].currentIssues[0].shotNumbers).toEqual([45])

    const repaired = applyStoryboardFinalReviewPatch(longShots, normalizeStoryboardFinalReviewPatch({
      replacements: [{ shotNumber: 45, shot: { a: '角色：第 45 个节点已完成连续性修复' } }],
    }))
    expect(repaired[44].a).toContain('已完成连续性修复')
  })

  it('accepts a provider top-level shot array and partial replacement fields', () => {
    const source = [
      shot('角色：原对白', { t: '原镜头' }),
      shot('角色：应被完整结果删除', { t: '旧尾镜头' }),
    ]
    const arrayPatch = normalizeStoryboardFinalReviewPatch([
      shot('角色：数组修正对白', { t: '数组修正镜头' }),
    ])
    const partialPatch = normalizeStoryboardFinalReviewPatch({
      passed: true,
      replacements: [{ shotNumber: 1, shot: { a: '角色：局部修正对白' } }],
    })

    expect(arrayPatch.passed).toBe(true)
    const arrayPatched = applyStoryboardFinalReviewPatch(source, arrayPatch)
    expect(arrayPatched).toHaveLength(1)
    expect(arrayPatched[0].t).toBe('数组修正镜头')
    const [partial] = applyStoryboardFinalReviewPatch(source, partialPatch)
    expect(partial.a).toBe('角色：局部修正对白')
    expect(partial.t).toBe('原镜头')
  })

  it('catches full-episode duplicate and out-of-order dialogue after generation', () => {
    const issues = storyboardEpisodeReviewIssues([
      shot('达米安·克劳：你只是个工具。'),
      shot('克莱尔·摩根：为什么？'),
      shot('克莱尔·摩根：为什么？'),
    ], {
      script: '克莱尔·摩根：为什么？\n达米安·克劳：你只是个工具。',
      visualStyle: VisualStyle.photorealistic,
    })
    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')

    expect(reasons).toContain('锁定剧本顺序之前')
    expect(reasons).toContain('整集重复对白')
  })

  it('deterministically removes a later duplicate dialogue before final review', () => {
    const deduped = dedupeStoryboardDialogueShots([
      shot('克莱尔·摩根：Tell me how to control it.', { t: '克莱尔追问' }),
      shot('克莱尔·摩根：Tell me how to control it.', { t: '克莱尔追问（对白续镜 2）' }),
    ], {
      script: '克莱尔·摩根：告诉我怎么控制它。',
      visualStyle: VisualStyle.overseas_live_action,
    })
    const issues = storyboardEpisodeReviewIssues(deduped, {
      script: '克莱尔·摩根：告诉我怎么控制它。',
      visualStyle: VisualStyle.overseas_live_action,
    })

    expect(deduped[0].a).toContain('Tell me how to control it.')
    expect(deduped[1].a).toBe('无对白。')
    expect(deduped[1].t).toBe('克莱尔追问')
    expect(issues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('整集重复对白')
  })

  it('rejects Chinese spoken dialogue and missing dialogue coverage for overseas live action', () => {
    const issues = storyboardEpisodeReviewIssues([
      shot('克莱尔·摩根：为什么？'),
    ], {
      script: '克莱尔·摩根：为什么？\n达米安·克劳：你只是个工具。',
      visualStyle: VisualStyle.overseas_live_action,
    })
    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')

    expect(reasons).toContain('现场对白仍含中文')
    expect(reasons).toContain('少于锁定剧本需要覆盖的 2 句')
  })

  it('normalizes common organization terms accidentally mixed into overseas English dialogue', () => {
    const [normalized] = normalizeOverseasStoryboardDialogueTerms([
      shot('克莱尔·摩根：Rescuing Emma would trigger the议会 guards and alert the狼群.'),
    ])

    expect(normalized.a).toBe('克莱尔·摩根：Rescuing Emma would trigger the Council guards and alert the pack.')
    expect(normalized.a).not.toMatch(/议会|狼群/u)
  })

  it('parses multiple speakers inside one action field without treating the next name as Chinese dialogue', () => {
    const issues = storyboardEpisodeReviewIssues([
      shot('克莱尔·摩根：Why did you do this? 达米安·克劳：You were only a tool.'),
    ], {
      script: '克莱尔·摩根：为什么这么做？\n达米安·克劳：你只是个工具。',
      visualStyle: VisualStyle.overseas_live_action,
    })
    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')

    expect(reasons).not.toContain('现场对白仍含中文')
    expect(reasons).not.toContain('少于锁定剧本需要覆盖')
  })

  it('splits overlong multi-speaker dialogue into natural 4-6 second continuation shots', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('克莱尔·摩根：I have waited twenty years to learn why you betrayed my family and sealed my power. 达米安·克劳：You were only a tool, and you were never meant to survive.', { d: 5 }),
    ])
    const issues = storyboardContinuityIssues(shots)

    expect(shots.length).toBeGreaterThan(1)
    expect(shots.every((item) => item.d >= 4 && item.d <= 6)).toBe(true)
    expect(issues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('对白自然表演约需')
    expect(shots[1].t).toContain('对白续镜')
  })

  it('splits long Chinese dialogue only at natural phrase boundaries', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('陆野：感觉还是不太靠谱啊，要不你女装给兄弟我看一次吧，这样我就不难过了。', { d: 4 }),
    ])

    expect(shots.length).toBeGreaterThan(1)
    expect(shots.some((item) => /：不你/u.test(item.a))).toBe(false)
    expect(shots.some((item) => /要[。；;]?$/u.test(item.a))).toBe(false)
    expect(shots.map((item) => item.a).join('')).toContain('要不你女装')
  })

  it('re-splits dialogue that becomes overlong after a final-review patch', () => {
    const patched = applyStoryboardFinalReviewPatch([
      shot('无对白', { d: 6 }),
    ], normalizeStoryboardFinalReviewPatch({
      passed: false,
      replacements: [{
        shotNumber: 1,
        shot: {
          a: '克莱尔·摩根：I have waited twenty years to learn why you betrayed my family and sealed my power. 达米安·克劳：You were only a tool, and you were never meant to survive.',
          d: 6,
        },
      }],
    }))
    const shots = splitOverlongStoryboardDialogueShots(patched)
    const issues = storyboardContinuityIssues(shots)

    expect(shots.length).toBeGreaterThan(1)
    expect(issues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('对白自然表演约需')
  })

  it('moves a terminal fall and cut-to-black behind every dialogue continuation', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('克莱尔·摩根：Why did you betray me after everything I sacrificed for this family? 达米安·克劳：Because you were only a tool and you were never meant to survive.', {
        d: 6,
        s: '对白结束后克莱尔失去支撑，连续坠入黑暗，白狼虚影闪现，画面切黑。',
        g: '克莱尔已经离开崖边，画面全黑。',
      }),
    ])

    expect(shots.length).toBeGreaterThan(1)
    expect(shots.slice(0, -1).every((item) => !/坠入黑暗|画面切黑/u.test(item.s))).toBe(true)
    expect(shots.slice(0, -1).every((item) => /不可逆动作发生前/u.test(item.g))).toBe(true)
    expect(shots.at(-1)?.s).toContain('对白结束后再连续执行')
    expect(shots.at(-1)?.s).toContain('画面切黑')
    expect(storyboardContinuityIssues(shots)).toEqual([])
  })

  it('adds a fade-in transition after cut-to-black and matches an explicit underwater action', () => {
    const stitched = stitchStoryboardContinuity([
      shot('无对白', {
        t: '坠入黑暗',
        n: '夜晚｜月光悬崖',
        s: '克莱尔连续坠落，画面切黑。',
        g: '画面全黑。',
      }),
      shot('无对白', {
        t: '克莱尔水下下沉',
        n: '夜晚｜月光悬崖',
        s: '深海之下，克莱尔缓缓下沉，手腕封印开始碎裂。',
      }),
    ])
    const located = enforceStoryboardLocationAssets(stitched, [
      { name: '月光悬崖', description: '碎石崖壁与夜风。' },
      { name: '深海之下', description: '幽暗水下空间。' },
    ])

    expect(stitched[1].p).toContain('黑场淡入')
    expect(stitched[1].f).toContain('从全黑自然淡入')
    expect(storyboardContinuityIssues(stitched)).toEqual([])
    expect(located[1].n).toContain('深海之下')
  })

  it('matches an underwater scene semantically and does not inherit the cliff after blackout', () => {
    const firstPass = stitchStoryboardContinuity([
      shot('无对白', {
        t: '悬崖坠落',
        n: '夜晚｜月光悬崖',
        s: '克莱尔连续坠落，画面切黑。',
        g: '画面全黑。',
        d: 5,
      }),
      shot('无对白', {
        t: '克莱尔水下下沉',
        n: '时间承接上一镜',
        s: '克莱尔的身体在水中缓缓下沉，手腕封印开始碎裂。',
        d: 5,
      }),
    ])
    const located = enforceStoryboardLocationAssets(firstPass, [
      { name: '月光悬崖', description: '碎石崖壁、夜风与月光。' },
      { name: '深海之下', description: '幽暗水下空间，人物在水中下沉。' },
    ])
    const finalPass = stitchStoryboardContinuity(located)
    const clips = packStoryboardVideoClips(finalPass)

    expect(finalPass[1].n).toContain('深海之下')
    expect(finalPass[1].p).toContain('深海之下')
    expect(finalPass[1].p).not.toContain('月光悬崖')
    expect(finalPass[1].f).toContain('深海之下')
    expect(clips).toHaveLength(1)
    expect(clips[0].n).toContain('月光悬崖')
    expect(clips[0].n).toContain('深海之下')
    expect(clips[0].v).toContain('上一场景的人物和陈设完全退出')
  })

  it('flags a cliff shot that also contains a semantic underwater location', () => {
    const issues = storyboardAtomicityIssues([
      shot('无对白', {
        n: '夜晚｜月光悬崖',
        s: '克莱尔离开崖边后，身体在水中缓缓下沉。',
        d: 5,
      }),
    ], [
      { name: '月光悬崖', description: '碎石崖壁、夜风与月光。' },
      { name: '深海之下', description: '幽暗水下空间，人物在水中下沉。' },
    ])

    expect(issues.flatMap((issue) => issue.reasons).join('\n')).toContain('同一镜出现多个地点')
  })

  it('does not confuse locations that share a broad cliff or wood-house prefix', () => {
    const issues = storyboardAtomicityIssues([
      shot('无对白', {
        n: '夜晚｜月光悬崖崖底深海',
        s: '克莱尔在深海中缓缓下沉，月光穿过水面。',
        d: 5,
      }),
      shot('无对白', {
        n: '夜晚｜崖底木屋',
        s: '克莱尔在壁炉旁缓缓睁眼。',
        d: 5,
      }),
    ], [
      { name: '月光悬崖崖底深海', description: '深海水下空间。' },
      { name: '月光悬崖崖底海岸', description: '沙滩、礁石与海浪。' },
      { name: '崖底木屋', description: '木床与壁炉。' },
      { name: '木屋外', description: '屋外月光空地。' },
    ])

    expect(issues).toEqual([])
  })

  it('allows a continuous doorway entry when the shot has only one physical location', () => {
    const issues = storyboardAtomicityIssues([
      shot('无对白', {
        t: '推门进入储备室',
        n: '夜晚｜黑松庄园药剂储备室',
        s: '克莱尔推开储备室木门，进入后在门内停稳。',
        c: '中景稳定单向跟拍',
        d: 5,
      }),
    ], [{ name: '黑松庄园药剂储备室', description: '药柜与木门。' }])

    expect(issues).toEqual([])
  })

  it('uses visible physical action to distinguish deep sea, coast, hut, and laboratory', () => {
    const locations = [
      { name: '月光悬崖崖底深海', description: '深海水下空间。' },
      { name: '月光悬崖崖底海岸', description: '沙滩、礁石与海浪。' },
      { name: '崖底木屋', description: '木床与壁炉。' },
      { name: '实验室（闪回）', description: '金属床与实验仪器。' },
    ]
    const anchored = enforceStoryboardLocationAssets([
      shot('无对白', {
        n: '夜晚｜月光悬崖崖底海岸',
        s: '克莱尔在深海中缓缓下沉，海水从身边掠过。',
      }),
      shot('无对白', {
        n: '夜晚｜月光悬崖崖底深海',
        s: '海浪把克莱尔冲上沙滩，礁石留在背景。',
      }),
      shot('克莱尔：I remember the white laboratory.', {
        n: '夜晚｜崖底木屋',
        s: '克莱尔坐在壁炉和木床之间说话。',
      }),
      shot('无对白', {
        n: '夜晚｜崖底木屋',
        t: '闪回实验',
        s: '闪回中，幼年克莱尔被固定在金属床上，实验仪器闪烁。',
      }),
    ], locations)

    expect(anchored.map((item) => item.n)).toEqual([
      '夜晚｜月光悬崖崖底深海',
      '夜晚｜月光悬崖崖底海岸',
      '夜晚｜崖底木屋',
      '夜晚｜实验室（闪回）',
    ])
    expect(anchored[3].e).not.toContain('木床与壁炉')
  })

  it('uses distinctive script actions to keep an interior hook beat before its exterior beat', () => {
    const locations = [
      {
        name: '崖底木屋',
        description: '克莱尔手腕金光突然暴涨，单膝跪地。阿德里安冲上前扶住她，却被力量震开。',
      },
      {
        name: '木屋外',
        description: '月光下，一头白狼虚影在克莱尔身后浮现，仰天长啸，远处狼群回应。',
      },
    ]
    const anchored = enforceStoryboardLocationAssets([
      shot('克莱尔：Ah!', {
        n: '夜晚｜木屋外',
        t: '力量爆发',
        s: '克莱尔手腕金光暴涨，单膝跪地；阿德里安上前扶她，却被力量震开。',
      }),
      shot('无对白', {
        n: '夜晚｜崖底木屋',
        t: '白狼虚影',
        s: '月光下白狼虚影在克莱尔身后浮现并仰天长啸，远处狼群回应。',
      }),
    ], locations)

    expect(anchored.map((item) => item.n)).toEqual([
      '夜晚｜崖底木屋',
      '夜晚｜木屋外',
    ])
  })

  it('does not re-enter a completed flashback after returning to the physical scene', () => {
    const anchored = enforceStoryboardLocationAssets([
      shot('无对白', {
        n: '夜晚｜实验室（闪回）',
        t: '童年实验',
        s: '幼年克莱尔被固定在金属床上，实验仪器闪烁。',
      }),
      shot('克莱尔·摩根：Who was behind it?', {
        n: '夜晚｜崖底木屋',
        t: '回到现实质问',
        s: '克莱尔扶住木桌，抬头追问阿德里安。',
      }),
      shot('阿德里安·布莱克伍德：Gideon was behind it.', {
        n: '夜晚｜实验室（闪回）',
        t: '阿德里安回答',
        s: '阿德里安站在壁炉旁回答，克莱尔握紧匕首。',
      }),
    ], [
      { name: '崖底木屋', description: '木桌、匕首和燃烧的壁炉。' },
      { name: '实验室（闪回）', description: '回忆闪回，金属床与实验仪器。' },
    ])

    expect(anchored.map((item) => item.n)).toEqual([
      '夜晚｜实验室（闪回）',
      '夜晚｜崖底木屋',
      '夜晚｜崖底木屋',
    ])
  })

  it('filters known cold-open and continuation false positives from model review', () => {
    const issues = actionableStoryboardFinalReviewIssues([
      '冷开场与主线结尾重复，需删除其中之一',
      '达米安对白被截断，需合并或补全',
      '深海之下不在白名单，需添加至白名单',
      '结尾钩子缺失，但当前镜头已经包含婚戒和封印碎裂',
      '主线遗漏了艾玛被押走的事件',
    ], {
      script: '【倒叙冷开场】\n克莱尔坠落。\n【回到主线】\n克莱尔再次坠落。',
      shots: [shot('达米安·克劳：sealed your power.', { t: '揭露（对白续镜 2）' })],
      allowedLocationNames: ['月光悬崖', '深海之下'],
    })

    expect(issues).toEqual(['主线遗漏了艾玛被押走的事件'])
  })

  it('allows one intentional cold-open replay in an overseas episode', () => {
    const issues = storyboardEpisodeReviewIssues([
      shot('克莱尔·摩根：Why...?'),
      shot('克莱尔·摩根：Why...?'),
    ], {
      script: '【倒叙冷开场】\n克莱尔·摩根：为什么？\n【回到主线】\n故事继续。',
      visualStyle: VisualStyle.overseas_live_action,
    })

    expect(issues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('整集重复对白')
  })

  it('targets only the explicitly selected locked episodes', () => {
    expect(storyboardRequestedEpisodeIds({
      episodeIds: ['episode-2', 'episode-1', 'episode-2', '', 3],
    })).toEqual(['episode-2', 'episode-1'])
    expect(storyboardRequestedEpisodeIds({})).toBeUndefined()
  })

  it('bounds one segment to five short provider routes instead of all fallback keys', () => {
    const routes = storyboardTextRoutePlan({
      primaryKeyCount: 1,
      fallbackKeyCount: 1,
      tertiaryKeyCount: 10,
      preferredTertiaryIndex: 8,
    })

    expect(routes.map((route) => route.provider)).toEqual([
      'primary',
      'fallback',
      'primary',
      'tertiary',
      'tertiary',
    ])
    expect(routes.filter((route) => route.provider === 'tertiary').map((route) => route.tertiaryKeyIndex))
      .toEqual([8, 9])
    expect(routes.every((route) => route.maxAttempts === 1)).toBe(true)
    expect(routes.reduce((total, route) => total + route.timeoutMs, 0)).toBe(315_000)
  })

  it('retries only DeepSeek when fallback providers are disabled', () => {
    const routes = storyboardTextRoutePlan({
      primaryKeyCount: 1,
      fallbackKeyCount: 0,
      tertiaryKeyCount: 0,
    })

    expect(routes.map((route) => route.provider)).toEqual(['primary', 'primary'])
    expect(routes.map((route) => route.timeoutMs)).toEqual([60_000, 60_000])
  })

  it('shows the real reason for switching text routes', () => {
    expect(storyboardRouteFailureReason(new Error('TEXT_API_FAILED: 504 upstream timeout')))
      .toBe('上一线路读取超时')
    expect(storyboardRouteFailureReason(new Error('Zod invalid_type in shots')))
      .toBe('上一结果格式未通过校验')
  })

  it('allows a short two-person exchange to share one continuous shot', () => {
    expect(targetStoryboardShotCount('苏文菁：下周见。\n陈蕊：哦。')).toBe(1)
  })

  it('allocates about eighteen concise sub-shots across a short-drama episode', () => {
    const chunks = [
      '场次一。林晨推门进入客厅，抬眼看向窗边。',
      '场次二。林晨停下脚步。苏文菁：坐吧。林晨：好。',
      '场次三。两人隔着茶几坐下，气氛逐渐缓和。',
    ]
    const target = targetStoryboardShotCount(chunks.join('\n'), 18)
    const allocated = allocateStoryboardShotTargets(chunks, target)

    expect(target).toBeGreaterThanOrEqual(18)
    expect(allocated).toHaveLength(3)
    expect(allocated.reduce((total, count) => total + count, 0)).toBe(target)
    expect(fitStoryboardDuration(Array.from({ length: target }, () => shot('无对白')), 90)
      .reduce((total, item) => total + item.d, 0)).toBeGreaterThanOrEqual(90)
  })

  it('keeps the active scene heading on every split script segment', () => {
    const chunks = splitStoryboardScript([
      '【场次1】翡翠山庄34号客厅·雨夜',
      '林晨站在沙发边。苏文菁走到酒柜旁。林晨抬眼看向苏文菁。',
      '苏文菁：坐。林晨没有立刻动作。',
      '【场次2】翡翠山庄34号车库·雨夜',
      '林晨把电动车推到车库角落，回头看向门外雨幕。',
    ].join('\n'), 55)

    const livingRoomChunks = chunks.filter((chunk) => chunk.includes('林晨') && !chunk.includes('车库角落'))
    expect(livingRoomChunks.length).toBeGreaterThan(1)
    expect(livingRoomChunks.every((chunk) => chunk.startsWith('【场次1】翡翠山庄34号客厅·雨夜'))).toBe(true)
    expect(chunks.at(-1)).toContain('【场次2】翡翠山庄34号车库·雨夜')
  })

  it('keeps compact numbered scene headings when splitting a script', () => {
    const chunks = splitStoryboardScript([
      '【场1】日/外/哈德逊河边',
      '林晨扶着栏杆打电话。林晨挂断电话后转身离开。',
      '【场2】日/内/翡翠山庄书房',
      '林晨打开电脑。林晨开始整理录取数据。',
    ].join('\n'), 35)

    expect(chunks.some((chunk) => chunk.startsWith('【场1】日/外/哈德逊河边'))).toBe(true)
    expect(chunks.some((chunk) => chunk.startsWith('【场2】日/内/翡翠山庄书房'))).toBe(true)
  })

  it('starts a new segment for unbracketed scene numbers such as 场1-2', () => {
    const chunks = splitStoryboardScript([
      '【倒叙冷开场】',
      '夜 外 月光悬崖',
      '克莱尔悬在崖边，随后画面切黑。',
      '场1-1',
      '日 内 黑松庄园主屋客厅',
      '达米安推门而入，与克莱尔对峙。',
      '场1-2',
      '黄昏 外 黑松庄园祭坛广场',
      '议会长老展开卷轴。',
    ].join('\n'), 520)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toContain('倒叙冷开场')
    expect(chunks[1].startsWith('场1-1')).toBe(true)
    expect(chunks[2].startsWith('场1-2')).toBe(true)
  })

  it('never merges independently editable atomic shots', () => {
    const compacted = compactStoryboardShots([
      shot('苏文菁抬眼，无对白'),
      shot('苏文菁：下周见。'),
      shot('苏文菁放下平板，无对白'),
      shot('陈蕊：哦。'),
    ], 2)
    expect(compacted).toHaveLength(4)
    expect(compacted.map((item) => item.a)).toEqual([
      '苏文菁抬眼，无对白',
      '苏文菁：下周见。',
      '苏文菁放下平板，无对白',
      '陈蕊：哦。',
    ])
  })

  it('rejects legacy storyboards that pack several locations or camera setups into one shot', () => {
    const issues = storyboardAtomicityIssues([
      shot('无对白', {
        t: '雨夜送餐启程 / 雨中骑行过桥 / 抵达翡翠山庄',
        n: '凌晨｜老陈中餐门口',
        e: '从老陈中餐门口切到皇后大桥，再抵达翡翠山庄34号大门',
        c: '蒙太奇快切，多角度跟拍，随后切换为人物特写',
        d: 12,
      }),
    ], [
      { name: '老陈中餐门口', description: '中餐馆外景' },
      { name: '皇后大桥', description: '雨夜桥面' },
      { name: '翡翠山庄34号大门', description: '别墅大门' },
    ])

    expect(issues).toHaveLength(1)
    expect(issues[0].reasons).toContain('标题串联了多个剧情节点')
    expect(issues[0].reasons).toContain('同一镜出现多个地点：老陈中餐门口、皇后大桥、翡翠山庄34号大门')
    expect(issues[0].reasons).toContain('同一镜包含快切、多角度或多个机位')
    expect(issues[0].reasons).toContain('镜头时长为 12 秒，超出原子分镜 4-6 秒范围')
  })

  it('accepts a four-to-six-second shot with one location, one camera setup, and multiple speakers', () => {
    const issues = storyboardAtomicityIssues([
      shot('林晨：到了。；苏文菁：进来吧。', {
        t: '林晨停在门前',
        n: '凌晨｜翡翠山庄34号大门',
        e: '花岗岩门廊和黑色铁门保持固定',
        c: '平视中景，摄影机稳定缓慢推进',
        d: 5,
      }),
    ], [{ name: '翡翠山庄34号大门', description: '花岗岩门廊' }])

    expect(issues).toEqual([])
  })

  it('rejects a fall followed by a reset to the cliff edge and repeated dialogue', () => {
    const issues = storyboardContinuityIssues([
      shot('克莱尔·摩根：为什么……', {
        t: '克莱尔质问',
        n: '夜晚｜月光悬崖',
        s: '先抠住崖边；随后抬头；最后保持悬空',
        g: '克莱尔·摩根双手抠住崖边，身体悬空',
        d: 5,
      }),
      shot('无对白', {
        t: '克莱尔坠落',
        n: '夜晚｜月光悬崖',
        s: '先碎石断裂；随后克莱尔·摩根失去支撑向下坠落；最后画面切黑',
        v: '克莱尔·摩根整个人坠入黑暗，白狼虚影闪现，画面切黑',
        g: '克莱尔·摩根已经坠离崖边，画面全黑',
        d: 5,
      }),
      shot('克莱尔·摩根：为什么……', {
        t: '克莱尔再次质问',
        n: '夜晚｜月光悬崖',
        p: '克莱尔·摩根仍悬在崖边',
        f: '克莱尔·摩根双手重新抠住崖边',
        d: 5,
      }),
    ])

    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')
    expect(reasons).toContain('已经完成坠落')
    expect(reasons).toContain('已经切黑')
    expect(reasons).toContain('重复对白')
  })

  it('does not confuse one character falling with another character standing', () => {
    const unrelatedIssues = storyboardContinuityIssues([
      shot('无对白', {
        n: '夜晚｜关押区',
        s: '克莱尔击倒两名守卫，守卫倒地失去意识。',
        g: '两名守卫倒地，克莱尔站在牢门前。',
      }),
      shot('艾玛·克劳：Mom!', {
        n: '夜晚｜关押区',
        p: '艾玛蜷缩在角落抬头。',
        f: '艾玛从角落站起，克莱尔站在牢门外。',
      }),
    ])
    const sameSubjectIssues = storyboardContinuityIssues([
      shot('无对白', {
        n: '夜晚｜关押区',
        s: '艾玛倒地失去意识。',
        g: '艾玛倒在角落。',
      }),
      shot('无对白', {
        n: '夜晚｜关押区',
        p: '艾玛站在牢门旁。',
        f: '艾玛站立面对克莱尔。',
      }),
    ])

    expect(unrelatedIssues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('未写起身过程')
    expect(sameSubjectIssues.flatMap((issue) => issue.reasons).join('\n')).toContain('未写起身过程')
  })

  it('rejects dialogue that cannot fit naturally and contradictory voice rules', () => {
    const issues = storyboardContinuityIssues([
      shot('克莱尔·摩根：为什么……；达米安·克劳：二十年前，是我和吉迪恩封印了你的力量。你不过是个工具。', {
        n: '夜晚｜月光悬崖',
        q: '克莱尔声音颤抖；达米安无对白；无配音',
        d: 5,
      }),
    ])

    const reasons = issues.flatMap((issue) => issue.reasons).join('\n')
    expect(reasons).toContain('超过当前 5 秒镜头')
    expect(reasons).toContain('声音要求同时写了无配音')
  })

  it('splits long English dialogue at sentence boundaries instead of orphaning a word', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('达米安·克劳：Twenty years ago, Gideon and I sealed your power. You were only a tool.', {
        n: '夜晚｜月光悬崖',
        s: '对白结束后，克莱尔失去支撑并连续坠落，画面切黑。',
        g: '克莱尔已经坠离崖边，画面全黑。',
        d: 5,
      }),
    ])

    expect(shots).toHaveLength(2)
    expect(shots[0].a).toContain('Twenty years ago, Gideon and I sealed your power.')
    expect(shots[0].a).not.toMatch(/\bYou\s*$/u)
    expect(shots[1].a).toContain('You were only a tool.')
  })

  it('keeps English clause endings and names together when splitting dialogue', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('达米安·克劳：Today marks not only my twentieth year as Alpha of Blackpine, but also the evolution of the old order. I hereby dissolve the bond with Claire.', {
        d: 5,
      }),
    ])
    const dialogue = shots.map((item) => item.a).join('\n')

    expect(shots[0].a).toContain('Alpha of Blackpine,')
    expect(dialogue).not.toMatch(/Alpha of\s*$/mu)
  })

  it('does not split an American title abbreviation into its own dialogue line', () => {
    const shots = splitOverlongStoryboardDialogueShots([
      shot('守卫：Dr. Morgan, the Elders have ordered that you may not leave the estate until the ceremony.', {
        d: 4,
      }),
    ])
    const dialogue = shots.map((item) => item.a).join('\n')

    expect(dialogue).toContain('Dr. Morgan')
    expect(dialogue).not.toMatch(/守卫：Dr\.\s*$/mu)
  })

  it('accepts dialogue before a single continuous fall and blackout', () => {
    const issues = storyboardContinuityIssues([
      shot('克莱尔·摩根：Why?', {
        n: '夜晚｜月光悬崖',
        s: '先抠住崖边；随后抬头问话；最后保持悬空',
        g: '克莱尔·摩根仍悬在崖边并看向达米安·克劳',
        d: 4,
      }),
      shot('达米安·克劳：We sealed your power twenty years ago.；达米安·克劳：You were only a tool.', {
        n: '夜晚｜月光悬崖',
        p: '克莱尔·摩根仍悬在崖边，达米安·克劳低头俯视',
        q: '无旁白、无后期配音感，保留达米安·克劳的演员现场对白',
        g: '克莱尔·摩根仍悬在崖边，瞳孔骤缩',
        d: 6,
      }),
      shot('无对白', {
        n: '夜晚｜月光悬崖',
        p: '克莱尔·摩根仍悬在崖边，手指颤抖',
        s: '先崖边断裂；随后克莱尔·摩根失去支撑坠落；然后白狼虚影闪现；最后画面切黑',
        v: '克莱尔·摩根连续向下坠落，白狼虚影闪现后画面切黑',
        q: '无对白，不生成配音',
        g: '克莱尔·摩根已经坠离崖边，画面全黑',
        d: 5,
      }),
    ])

    expect(issues).toEqual([])
  })

  it('fits normal episodes to 90 seconds and allows three-second timeline beats', () => {
    const normal = fitStoryboardDuration(Array.from({ length: 20 }, () => shot('无对白')), 90)
    const dialogueHeavy = fitStoryboardDuration(Array.from({ length: 27 }, () => shot('无对白')), 90)
    expect(normal.reduce((total, item) => total + item.d, 0)).toBe(90)
    expect(dialogueHeavy.reduce((total, item) => total + item.d, 0)).toBe(90)
    expect(dialogueHeavy.every((item) => item.d >= 3)).toBe(true)
  })

  it('keeps thirty-four dialogue beats in valid fifteen-second clips', () => {
    const clips = packStoryboardVideoClips(Array.from({ length: 34 }, () => shot('角色：连续对白', { d: 4 })))
    const totalSeconds = clips.reduce((total, item) => total + item.d, 0)

    expect(totalSeconds).toBeGreaterThanOrEqual(90)
    expect(clips.every((item) => item.d <= 15)).toBe(true)
  })

  it('honors an explicitly requested three-minute cap', () => {
    const fitted = fitStoryboardDuration(Array.from({ length: 45 }, (_, index) => shot(
      `角色${index + 1}：This spoken sentence needs several seconds at a natural pace.`,
      { d: 5 },
    )), 90)
    const clips = packStoryboardVideoClips(fitted, 15, 180)
    const totalSeconds = clips.reduce((total, item) => total + item.d, 0)

    expect(totalSeconds).toBeLessThanOrEqual(180)
    expect(clips.every((item) => item.d <= 15)).toBe(true)
    expect(totalSeconds / clips.length).toBeGreaterThanOrEqual(12)
  })

  it('does not impose a three-minute cap during normal episode review packing', () => {
    const clips = packStoryboardVideoClips(Array.from({ length: 61 }, (_, index) => shot(
      '无对白',
      { d: 3, n: `日｜连续场景${index + 1}` },
    )))
    const totalSeconds = clips.reduce((total, item) => total + item.d, 0)

    expect(totalSeconds).toBeGreaterThanOrEqual(183)
    expect(totalSeconds).toBeGreaterThan(180)
    expect(clips.every((item) => item.d <= 15)).toBe(true)
  })

  it('restores exact source dialogue while preserving API-generated action', () => {
    const repaired = enforceSupplementalDialogue(
      shot('小张攥紧担架边缘；小张：我付不起，把我留在这里。'),
      { speaker: '小张', os: false, text: '我付不起！把我扔这儿！让我死这儿！' },
    )
    expect(repaired.a).toBe('小张攥紧担架边缘；小张：我付不起！把我扔这儿！让我死这儿！')
    expect(repaired.v).toBe('人物完成连续动作，视线与眉眼随对白自然变化')
  })

  it('clips overlong model fields instead of rejecting the entire storyboard segment', () => {
    const normalized = normalizeCompactShot(shot('角色：保留对白', {
      e: '场'.repeat(3_200),
      z: '禁'.repeat(3_600),
    }))

    expect(normalized.e).toHaveLength(2_800)
    expect(normalized.z).toHaveLength(3_200)
    expect(normalized.a).toBe('角色：保留对白')
  })

  it('fills recoverable storyboard fields when a provider omits them', () => {
    const normalized = normalizeCompactShot({
      t: '林晨抬眼',
      n: '夜晚｜翡翠山庄客厅',
      v: '林晨抬眼看向苏文菁。',
      a: '无对白',
      d: 5,
    })

    expect(normalized.c).toBe('中景固定机位')
    expect(normalized.f).toBe('')
    expect(normalized.g).toBe('')
  })

  it('preserves every voiceover and OS line present in the source script', () => {
    const [reduced] = suppressNonessentialStoryboardVoiceovers([
      shot('林晨垂眼看向湿透的袖口；林晨【OS】：我真的太难过了；旁白：雨夜显得格外压抑'),
    ], [
      '林晨【OS】：我真的太难过了',
      '旁白：雨夜显得格外压抑',
    ].join('\n'))

    expect(reduced.a).toContain('林晨【OS】：我真的太难过了')
    expect(reduced.a).toContain('旁白：雨夜显得格外压抑')
  })

  it('keeps only an exact source voiceover carrying non-visual objective facts', () => {
    const [reduced] = suppressNonessentialStoryboardVoiceovers([
      shot('林晨握紧车把；林晨【OS】：两个月前，另一个外卖员在这里被抢车；旁白：三年前这里发生过另一件事'),
    ], '林晨【OS】：两个月前，另一个外卖员在这里被抢车')

    expect(reduced.a).toContain('林晨【OS】：两个月前，另一个外卖员在这里被抢车')
    expect(reduced.a).not.toContain('三年前这里发生过另一件事')
    expect(reduced.q).toContain('完整保留原剧本旁白、画外音或【OS】')
  })

  it('packs neighboring sub-shots into near-fifteen-second clips', () => {
    const atomic = Array.from({ length: 17 }, (_, index) => shot(`角色：第${index + 1}句对白`))
    const clips = packStoryboardVideoClips(atomic)
    expect(clips).toHaveLength(9)
    expect(clips.every((item) => item.d <= 15)).toBe(true)
    expect(clips.reduce((total, item) => total + item.d, 0)).toBeGreaterThanOrEqual(90)
    const combined = clips.map((item) => item.a).join('\n')
    let previousIndex = -1
    for (let index = 1; index <= 17; index++) {
      const currentIndex = combined.indexOf(`第${index}句对白`)
      expect(currentIndex).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
    expect(clips[0].v).toContain('0~')
    expect(clips[0].v).toContain('s：')
  })

  it('packs continuous shots at the same physical location despite harmless time-label drift', () => {
    const clips = packStoryboardVideoClips([
      shot('林晨：我知道。', { n: '夜晚｜皇后大桥雨夜路边', d: 5 }),
      shot('苏文菁：上车。', { n: '深夜｜皇后大桥雨夜路边', d: 5 }),
      shot('林晨拉开车门。', { n: '时间承接上一镜｜皇后大桥雨夜路边', d: 5 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].d).toBe(15)
    expect(clips[0].v).toContain('0~5s：')
    expect(clips[0].v).toContain('10~15s：')
  })

  it('packs five adjacent three-second beats into two videos with at most three beats each', () => {
    const clips = packStoryboardVideoClips(Array.from({ length: 5 }, (_, index) => shot(
      `角色：第 ${index + 1} 个连续动作段`,
      { n: '夜晚｜同一客厅', d: 3 },
    )))

    expect(clips).toHaveLength(2)
    expect(clips.every((clip) => clip.d === 15)).toBe(true)
    expect(clips.every((clip) => parseStoryboardTimelineSegments(clip.v).length <= 3)).toBe(true)
  })

  it('expands an otherwise valid short orphan to a fifteen-second video', () => {
    const clips = packStoryboardVideoClips([
      shot('林夏：我当骚扰电话了。', { n: '日间｜校园主干道', d: 5 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].d).toBe(15)
    expect(clips[0].v).toContain('0~15s：')
  })

  it('ignores explicitly offscreen bystanders when packing visible cast', () => {
    const sharedCast = [
      '林夏：白色T恤，画面左侧',
      '顾玉荣：校服，画面右侧',
      '陆野：画外角色，不得入镜',
      '陈浩：画外角色，不得入镜',
      '吕嘉豪：画外角色，不得入镜',
    ].join('；')
    const clips = packStoryboardVideoClips([
      shot('顾玉荣：你干嘛删我好友！', { n: '日间｜校园主干道', h: sharedCast, d: 5 }),
      shot('林夏：好友满了，清理点无关紧要的人。', { n: '日间｜校园主干道', h: sharedCast, d: 5 }),
      shot('顾玉荣：什么叫无关紧要！', { n: '日间｜校园主干道', h: sharedCast, d: 5 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].d).toBe(15)
    expect(clips[0].h).toContain('林夏')
    expect(clips[0].h).toContain('顾玉荣')
    expect(clips[0].h).not.toMatch(/陆野|陈浩|吕嘉豪/u)
  })

  it('uses one coherent spoken-audio rule when a packed clip mixes dialogue and silent shots', () => {
    const clips = packStoryboardVideoClips([
      shot('克莱尔·摩根：Why...?', { n: '夜晚｜月光悬崖', d: 5 }),
      shot('无对白', {
        n: '夜晚｜月光悬崖',
        d: 5,
        q: '本镜无对白，不生成配音。',
        o: '只保留夜风声。',
      }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].q).toContain('保留演员现场对白')
    expect(clips[0].q).not.toContain('不生成配音')
    expect(storyboardContinuityIssues(clips)).toEqual([])
  })

  it('splits a fifteen-second group when its combined cast would exceed four characters', () => {
    const clips = packStoryboardVideoClips([
      shot('林夏：先走吧。', {
        h: '林夏（白色T恤）；顾玉荣（校园主管）',
        d: 5,
      }),
      shot('陆野：我知道了。', {
        h: '陆野（短发）；陈浩（戴眼镜）',
        d: 5,
      }),
      shot('吕嘉豪：等等我。', {
        h: '吕嘉豪（背双肩包）',
        d: 5,
      }),
    ])

    expect(clips).toHaveLength(2)
    for (const clip of clips) {
      const castCount = ['林夏', '顾玉荣', '陆野', '陈浩', '吕嘉豪']
        .filter((name) => clip.h.includes(name) || clip.a.includes(`${name}：`))
        .length
      expect(castCount).toBeLessThanOrEqual(4)
    }
  })

  it('keeps one initial declaration per actor when packing adjacent shots', () => {
    const clips = packStoryboardVideoClips([
      shot('达米安·克劳：You were just a tool.', {
        n: '夜晚｜月光悬崖',
        h: '克莱尔·摩根（灰袍，位于岩石平台边缘）；达米安·克劳（西装笔挺，站在后方较高岩面）',
        c: '从达米安·克劳腰部高度俯拍克莱尔·摩根',
        d: 4,
      }),
      shot('无对白', {
        n: '夜晚｜月光悬崖',
        h: '克莱尔·摩根（向下移动中，灰袍飘动）；达米安·克劳（站在岩石平台边缘，望向下方）',
        c: '单人中景固定机位',
        d: 4,
      }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].h.match(/(?:^|；)克莱尔·摩根/gu)).toHaveLength(1)
    expect(clips[0].h.match(/(?:^|；)达米安·克劳/gu)).toHaveLength(1)
    expect(clips[0].h).not.toContain('向下移动中')
    expect(clips[0].h).not.toContain('望向下方')

    const [storyboard] = materializeStoryboards({
      shots: clips,
      visualStyle: VisualStyle.overseas_live_action,
    })
    expect(storyboard.videoPrompt).toContain('克莱尔·摩根固定声音：')
    expect(storyboard.videoPrompt).toContain('达米安·克劳固定声音：')
    expect(storyboard.videoPrompt).not.toContain('克莱尔·摩根（灰袍')
    expect(storyboard.videoPrompt).not.toContain('达米安·克劳（西装笔挺')
    expect(storyboard.videoPrompt).toContain('摄影机固定在达米安·克劳身后右侧腰线外，俯拍克莱尔·摩根')
    expect(storyboard.videoPrompt).not.toContain('角色数量锁定：')
  })

  it('deterministically removes no-dialogue audio conflicts from spoken shots', () => {
    const [normalized] = normalizeStoryboardSpokenAudioRules([
      shot('克莱尔·摩根：Ah!', {
        q: '本镜无对白，不生成配音。',
        o: '无对白，只保留风声。',
      }),
    ])

    expect(normalized.q).toContain('保留演员现场对白')
    expect(normalized.q).not.toContain('不生成配音')
    expect(normalized.o).toContain('保留演员现场对白')
    expect(storyboardContinuityIssues([normalized])).toEqual([])
  })

  it('re-splits dialogue before packing when a fifteen-second group would overflow', () => {
    const atomic = Array.from({ length: 3 }, (_, index) => shot(
      `角色${index + 1}：These spoken words must remain natural when several shots are packed together.`,
      { n: '夜晚｜月光悬崖', d: 5 },
    ))
    const clips = packStoryboardVideoClips(atomic, 15, 120)
    const issues = storyboardContinuityIssues(clips)

    expect(clips.every((clip) => clip.d <= 15)).toBe(true)
    expect(issues.flatMap((issue) => issue.reasons).join('\n')).not.toContain('对白自然表演约需')
  })

  it('folds a twelve-second clip and a four-second orphan from one scene into one fifteen-second clip', () => {
    const clips = packStoryboardVideoClips([
      shot('林晨：我看完了。', { n: '时间承接已锁定剧本｜豪宅书房·雨夜', d: 12 }),
      shot('苏文菁：继续。', { n: '夜晚｜豪宅书房·雨夜', d: 4 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].d).toBe(15)
    expect(clips[0].a).toContain('林晨：我看完了。')
    expect(clips[0].a).toContain('苏文菁：继续。')
  })

  it('packs each episode independently without leaking adjacent episode content', () => {
    const episodeOne = packStoryboardVideoClips(Array.from({ length: 4 }, () => shot('第一集角色：第一集对白')))
    const episodeTwo = packStoryboardVideoClips(Array.from({ length: 4 }, () => shot('第二集角色：第二集对白')))
    expect(episodeOne).toHaveLength(2)
    expect(episodeTwo).toHaveLength(2)
    expect(episodeOne.every((item) => item.a.includes('第一集对白') && !item.a.includes('第二集对白'))).toBe(true)
    expect(episodeTwo.every((item) => item.a.includes('第二集对白') && !item.a.includes('第一集对白'))).toBe(true)
  })

  it('combines adjacent scenes into one fifteen-second video task with an explicit transition', () => {
    const atomic = [
      shot('苏文菁：坐吧。', { n: '夜晚｜翡翠山庄别墅客厅' }),
      shot('陈蕊：哦。', { n: '深夜｜耶鲁学生宿舍卧室' }),
    ]
    const compacted = compactStoryboardShots(atomic, 1)
    const clips = packStoryboardVideoClips(atomic)

    expect(compacted).toHaveLength(2)
    expect(clips).toHaveLength(1)
    expect(clips[0].d).toBe(15)
    expect(clips[0].n).toContain('翡翠山庄别墅客厅')
    expect(clips[0].n).toContain('耶鲁学生宿舍卧室')
    expect(clips[0].v).toContain('直接切换到“深夜｜耶鲁学生宿舍卧室”')

    const [storyboard] = materializeStoryboards({
      shots: clips,
      visualStyle: VisualStyle.photorealistic,
    })
    const scene = storyboard.videoPrompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''
    expect(storyboard.notes).toContain('翡翠山庄别墅客厅')
    expect(storyboard.notes).toContain('耶鲁学生宿舍卧室')
    expect(scene).toContain('翡翠山庄别墅客厅')
    expect(scene).toContain('耶鲁学生宿舍卧室')
    expect(storyboard.videoPrompt).toContain('直接切换到“深夜｜耶鲁学生宿舍卧室”')
    expect(storyboard.videoPrompt).not.toContain('上一场景的人物和陈设完全退出')
  })

  it('packs many short independent scenes into near-full fifteen-second clips', () => {
    const atomic = Array.from({ length: 10 }, (_, index) => shot(
      `角色：场景${index + 1}对白`,
      { n: `白天｜独立场景${index + 1}` },
    ))
    const clips = packStoryboardVideoClips(atomic)

    expect(clips).toHaveLength(5)
    expect(clips.every((item) => item.d === 15)).toBe(true)
    expect(clips.reduce((total, item) => total + item.d, 0)).toBe(75)
    expect(clips.map((item) => item.a).join('\n')).toContain('场景1对白')
    expect(clips.map((item) => item.a).join('\n')).toContain('场景10对白')
  })

  it('forces every next shot to inherit the exact previous tail frame', () => {
    const shots = stitchStoryboardContinuity([
      shot('苏文菁：先坐下。', {
        f: '苏文菁站在画面左侧，左手腕佩戴手表',
        g: '苏文菁站在画面中央偏左，左手腕手表清晰，右手扶住沙发靠背',
      }),
      shot('陈蕊：哦。', {
        p: '错误的重置状态',
        f: '陈蕊仍坐在画面右侧，苏文菁保持上一镜位置',
        r: '手表只属于苏文菁并固定在左手腕，陈蕊双手腕为空',
      }),
    ])

    expect(shots[1].p).toBe(shots[0].g)
    expect(shots[1].p).toContain('右手扶住沙发靠背')
    expect(shots[1].r).toContain('手表只属于苏文菁')
    expect(shots[1].r).toContain('陈蕊双手腕为空')
  })

  it('canonicalizes every shot to the matched scene asset and injects its visual anchor', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('苏文菁：坐吧。', {
        n: '夜晚｜普通客厅',
        e: '沙发位于画面左侧',
      }),
    ], [{
      name: '翡翠山庄别墅客厅',
      description: '米白色长沙发位于左侧，黑色矮几固定在沙发前方，暖黄落地灯从左后方照明',
      tags: ['别墅客厅'],
    }])

    expect(anchored.n).toBe('夜晚｜翡翠山庄别墅客厅')
    expect(anchored.e).toContain('场景资产“翡翠山庄别墅客厅”')
    expect(anchored.e).toContain('黑色矮几固定在沙发前方')
    expect(anchored.e.length).toBeLessThanOrEqual(240)
    expect(anchored.z).toContain('禁止将场景“翡翠山庄别墅客厅”替换为其他地点')
  })

  it('does not replace a specific unmatched screenplay location with an unrelated asset fallback', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('工作人员：请出示证件。', {
        t: '民政局大厅入场',
        n: '白天｜民政局登记大厅',
        e: '登记窗口、等候座椅与叫号屏位置固定',
        s: '林夏与洛雪微走向民政局登记窗口。',
      }),
    ], [
      { name: '临江大学校门口', description: '校门拱门与新生报到横幅。' },
      { name: '迈巴赫车内', description: '黑色真皮后座与深色车窗。' },
    ])

    expect(anchored.n).toBe('白天｜民政局登记大厅')
    expect(anchored.e).toContain('登记窗口、等候座椅与叫号屏')
    expect(anchored.e).not.toContain('临江大学校门口')
    expect(anchored.z).not.toContain('禁止将场景“临江大学校门口”替换为其他地点')
  })

  it('preserves an explicit model-produced location when a plain script has no scene headings yet', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('林晨推开仓库铁门。', {
        n: '凌晨｜唐人街货运仓库',
        e: '水泥地面潮湿，卷帘门半开',
      }),
    ], [])

    expect(anchored.n).toBe('凌晨｜唐人街货运仓库')
    expect(anchored.e).toContain('卷帘门半开')
    expect(anchored.e).not.toContain('核心场景')
  })

  it('selects the exact scene asset when an episode contains multiple locations', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('陈蕊：哦。', { n: '深夜｜耶鲁学生宿舍卧室' }),
    ], [
      { name: '翡翠山庄别墅客厅', description: '暖黄落地灯与米白沙发' },
      { name: '耶鲁学生宿舍卧室', description: '凌乱单人床、书桌与冷白窗光' },
    ])

    expect(anchored.n).toBe('深夜｜耶鲁学生宿舍卧室')
    expect(anchored.e).toContain('凌乱单人床、书桌与冷白窗光')
    expect(anchored.e).not.toContain('暖黄落地灯与米白沙发')
  })

  it('removes a previous scene name from current scene frame metadata', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('克莱尔：Who are you?', {
        n: '夜晚｜崖底木屋',
        p: '上一镜位于月光悬崖崖底海岸，克莱尔被抱起。',
        f: '镜头从月光悬崖崖底海岸跟随进入木屋。',
        g: '克莱尔站在崖底木屋内，窗外仍是月光悬崖崖底海岸。',
      }),
    ], [
      { name: '月光悬崖崖底海岸', description: '礁石、沙滩与海浪。' },
      { name: '崖底木屋', description: '木床、壁炉与木桌。' },
    ])

    expect(anchored.n).toContain('崖底木屋')
    expect(anchored.p).toBe('')
    expect(anchored.f).toBe('')
    expect(anchored.g).toBe('')
    expect(anchored.e).toContain('木床、壁炉与木桌')
  })

  it('inherits the previous locked scene when a supplemental shot omits its location name', () => {
    const anchored = enforceStoryboardLocationAssets([
      shot('角色：打开文档。', { n: '白天｜公司档案室' }),
      shot('角色：保存成功。', {
        t: '补录镜头：文档保存提示',
        n: '时间承接上一镜',
        e: '屏幕右下角出现保存完成提示',
        f: '手指停在键盘上方',
        v: '角色轻轻呼气并看向屏幕',
        g: '手指离开键盘，屏幕保持亮起',
      }),
    ], [
      { name: '公司档案室', description: '灰色文件柜沿墙排列，办公桌位于窗边' },
      { name: '地下停车场', description: '混凝土立柱与冷白顶灯形成纵深' },
    ])

    expect(anchored[1].n).toContain('公司档案室')
    expect(anchored[1].e).toContain('灰色文件柜沿墙排列')
    expect(anchored[1].e).not.toContain('混凝土立柱')
  })

  it('turns storyboard standard locations into exact asset-planning candidates', () => {
    const locations = extractStoryboardLocationInventories([
      {
        episodeId: 'episode-1',
        notes: '凌晨｜翡翠山庄34号客厅\n接续上一镜尾帧：林晨站在玄关。',
        videoPrompt: '时间地点：凌晨｜翡翠山庄34号客厅\n\n环境锁定：挑空客厅、落地窗与假火壁炉位置固定。\n\n人物锁定：林晨站在玄关。',
      },
      {
        episodeId: 'episode-1',
        notes: '凌晨｜翡翠山庄34号客厅',
        videoPrompt: '时间地点：凌晨｜翡翠山庄34号客厅\n\n环境锁定：挑空客厅与暖黄灯光保持不变。',
      },
    ])

    expect(locations).toHaveLength(1)
    expect(locations[0].name).toBe('翡翠山庄34号客厅')
    expect(locations[0].description).toContain('挑空客厅')
    expect(locations[0].tags).toContain('分镜标准场景')
  })

  it('does not collapse storyboard scene names that only differ by punctuation', () => {
    const locations = extractStoryboardLocationInventories([
      {
        episodeId: 'episode-1',
        notes: '夜晚｜旧屋-客厅',
        videoPrompt: '时间地点：夜晚｜旧屋-客厅\n\n环境锁定：木门与旧沙发位置固定。',
      },
      {
        episodeId: 'episode-1',
        notes: '夜晚｜旧屋客厅',
        videoPrompt: '时间地点：夜晚｜旧屋客厅\n\n环境锁定：窗户与矮桌位置固定。',
      },
    ])

    expect(locations.map((location) => location.name)).toEqual(['旧屋-客厅', '旧屋客厅'])
  })

  it('keeps orphaned legacy storyboard scenes in the global asset plan', () => {
    const locations = extractAllStoryboardLocationInventories([{
      episodeId: null,
      notes: '夜晚｜未绑定分集的旧屋客厅',
      videoPrompt: '时间地点：夜晚｜未绑定分集的旧屋客厅\n\n环境锁定：木门和旧沙发位置固定。',
    }])

    expect(locations).toHaveLength(1)
    expect(locations[0].name).toBe('未绑定分集的旧屋客厅')
    expect(locations[0].description).toContain('木门和旧沙发')
  })

  it('keeps first frame, ordered actions, and final frame when packing a 15-second clip', () => {
    const clips = packStoryboardVideoClips([
      shot('苏文菁：先坐下。', { f: '第一子镜头首帧', s: '先抬眼；随后扶住沙发', g: '第一子镜头尾帧', d: 7 }),
      shot('陈蕊：哦。', { f: '第二子镜头首帧', s: '先看向屏幕；随后轻轻点头', g: '第二子镜头尾帧', d: 8 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].f).toBe('第一子镜头首帧')
    expect(clips[0].g).toBe('第二子镜头尾帧')
    expect(clips[0].s.indexOf('先抬眼')).toBeLessThan(clips[0].s.indexOf('先看向屏幕'))
  })

  it('fuses directing detail into every legacy timeline segment without repeating dialogue', () => {
    const timeline = fuseStoryboardTimelineDetails({
      duration: 15,
      timeline: [
        '0~8s：林夏正面近景，下巴抬起，语气理直气壮：“不行，我不能稀里糊涂跟陌生人走。”说完仍钉在原地。',
        '8~11s：双人中近景，洛雪微挑眉：“给你一万。”林夏眼睛瞬间睁大，身体前倾半步：“多少？”',
        '11~15s：洛雪微嘴角轻扬：“两万。现在跟我走就给你。”林夏的坚定开始松动，视线短暂下移。',
      ].join('\n'),
      camera: '正面近景与双人中近景，固定机位，保持林夏在画面左侧、洛雪微在画面右侧',
      actionOrder: '先由林夏拒绝并站在原地；随后洛雪微报价，林夏前倾追问；最后洛雪微加价，林夏的视线下移',
      actionPhysics: '林夏双脚始终着地且不换边；前倾时重心只向前移动半步；两人全程无身体接触并保持一臂距离',
      performance: '林夏由理直气壮转为惊讶，再由坚定转为迟疑；洛雪微始终冷静，只在加价时嘴角轻扬',
      dialogue: '林夏：“不行，我不能稀里糊涂跟陌生人走。”\n洛雪微：“给你一万。”\n林夏：“多少？”\n洛雪微：“两万。现在跟我走就给你。”',
      openingState: '林夏站在画面左侧，洛雪微站在画面右侧，两人相隔一臂',
      endingState: '林夏仍在画面左侧，身体前倾半步，视线下移；洛雪微仍在画面右侧，嘴角轻扬；两人没有接触',
    })

    const segments = parseStoryboardTimelineSegments(timeline)
    expect(segments).toHaveLength(3)
    for (const segment of segments) {
      const { fields } = parseStoryboardTimelineDetailFields(segment.body)
      for (const label of STORYBOARD_TIMELINE_DETAIL_LABELS) expect(fields[label]).toBeTruthy()
    }
    expect(storyboardTimelineDetailIssues(timeline)).toEqual([])
    expect(timeline.match(/给你一万/gu)).toHaveLength(1)
    expect(timeline).toContain('本段结束状态：林夏仍在画面左侧，身体前倾半步，视线下移')
  })

  it('stores the checked timeline as short natural storyboard sentences', () => {
    const detailed = fuseStoryboardTimelineDetails({
      duration: 15,
      timeline: [
        '0~5s：双人中近景，林夏紧张抵住洛雪微肩膀，气息发颤：“姐，我们才认识一天，领证是不是太快了？”',
        '5~10s：洛雪微保持压制姿势，手指划过林夏脸颊，嘴角带笑：“快？我等了二十年，才等到你。”林夏的防备转为震惊。',
        '10~15s：林夏近景，瞳孔骤缩，视线越过洛雪微看向车头；镜头短暂转向民政局入口的现场招牌，再回到林夏僵住的脸。仅允许现场建筑招牌，不生成字幕。',
      ].join('\n'),
      camera: '双人中近景转林夏近景',
      actionOrder: '林夏先抵住洛雪微肩膀；洛雪微随后划过林夏脸颊；最后林夏看向民政局入口招牌',
      actionPhysics: '两人接触点保持在肩膀与脸颊，动作沿可见路径完成，双脚稳定着地',
      performance: '林夏由紧张和防备转为震惊；洛雪微保持从容笑意',
      dialogue: '林夏：“姐，我们才认识一天，领证是不是太快了？”；洛雪微：“快？我等了二十年，才等到你。”',
      endingState: '林夏僵在原地看向民政局入口招牌',
    })
    const natural = naturalizeStoryboardTimeline(detailed)

    expect(storyboardTimelineDetailIssues(detailed)).toEqual([])
    expect(parseStoryboardTimelineSegments(natural)).toHaveLength(3)
    expect(natural).toContain('姐，我们才认识一天，领证是不是太快了？')
    expect(natural).toContain('快？我等了二十年，才等到你。')
    expect(natural).toContain('两人接触点保持在肩膀与脸颊')
    expect(natural.match(/两人接触点保持在肩膀与脸颊/gu)).toHaveLength(1)
    expect(natural).toContain('林夏由紧张和防备转为震惊')
    expect(natural).not.toContain('动作顺序：')
    expect(natural).not.toContain('动作物理：')
    expect(natural).not.toContain('表演变化：')
    expect(natural).not.toContain('本段结束状态：')
    expect(natural).not.toContain('…')
  })

  it('keeps each atomic shot physics and exact end state in a packed timeline', () => {
    const clips = packStoryboardVideoClips([
      shot('林夏：“我不走。”', {
        n: '白天｜学校门口',
        c: '林夏正面近景，固定机位',
        s: '林夏先抬起下巴，随后把双脚站稳',
        m: '林夏双脚不换位，重心保持在两脚之间',
        v: '林夏眉峰收紧，眼神保持戒备',
        g: '林夏留在画面左侧，下巴抬起，双脚站稳',
        d: 7,
      }),
      shot('洛雪微：“给你一万。”', {
        n: '白天｜学校门口',
        c: '双人中近景，固定机位',
        s: '洛雪微先报价，随后林夏身体前倾半步',
        m: '林夏只向前转移重心，不跨步，不与洛雪微接触',
        v: '洛雪微神情平静；林夏眼睛睁大，由戒备转为惊讶',
        g: '林夏仍在画面左侧并前倾半步，洛雪微仍在画面右侧',
        d: 8,
      }),
    ])

    expect(clips).toHaveLength(1)
    const segments = parseStoryboardTimelineSegments(clips[0].v)
    expect(segments).toHaveLength(2)
    expect(segments[0].body).toContain('动作物理：林夏双脚不换位，重心保持在两脚之间')
    expect(segments[0].body).toContain('本段结束状态：林夏留在画面左侧，下巴抬起，双脚站稳')
    expect(segments[1].body).toContain('动作物理：林夏只向前转移重心，不跨步，不与洛雪微接触')
    expect(segments[1].body).toContain('本段结束状态：林夏仍在画面左侧并前倾半步，洛雪微仍在画面右侧')
    expect(storyboardTimelineDetailIssues(clips[0].v)).toEqual([])
  })

  it('reports the exact missing and under-detailed fields for each time segment', () => {
    const issues = storyboardTimelineDetailIssues(
      '0~5s：镜头与构图：近景；动作顺序：点头；表演变化：迟疑；本段结束状态：站稳。',
    )

    expect(issues).toHaveLength(1)
    expect(issues[0].range).toBe('0~5s')
    expect(issues[0].missing).toContain('动作物理')
    expect(issues[0].insufficient).toEqual(expect.arrayContaining([
      '镜头与构图',
      '动作顺序',
      '表演变化',
      '本段结束状态',
    ]))
  })

  it('expands a terse action beat before validation without duplicating generic physics', () => {
    const detailed = fuseStoryboardTimelineDetails({
      duration: 5,
      timeline: '0~5s：林夏近景，林夏点头，神情迟疑。',
      camera: '林夏正面近景，固定机位',
      actionOrder: '林夏点头',
      actionPhysics: '林夏双脚站稳，头部小幅向下运动后回到中立位置',
      performance: '林夏由戒备转为迟疑，视线短暂下移',
      openingState: '林夏站在画面左侧，身体朝向洛雪微',
      endingState: '林夏仍在画面左侧，双脚站稳，视线落在洛雪微手中的文件上',
    })

    expect(storyboardTimelineDetailIssues(detailed)).toEqual([])
    expect(detailed).toContain('先承接本段起始姿态')
    const natural = naturalizeStoryboardTimeline(detailed)
    expect(natural).toContain('头部小幅向下运动后回到中立位置')
    expect(natural).toContain('林夏由戒备转为迟疑')
    expect(natural.match(/林夏双脚站稳/gu)).toHaveLength(1)
  })

  it('uses the same 15-second packing rule for physical actions without changing their order', () => {
    const clips = packStoryboardVideoClips([
      shot('无对白', { t: '简单反应一', s: '先抬眼；最后稳定停住' }),
      shot('无对白', { t: '简单反应二', s: '先眨眼；最后稳定停住' }),
      shot('无对白', {
        t: '搀扶动作',
        s: '先靠近；随后用右手搀扶对方左臂；最后两人站稳',
        m: '右手沿可见路径接近对方左臂，唯一接触点为前臂，双脚不滑移',
      }),
      shot('无对白', {
        t: '跌倒动作',
        s: '先失去平衡；随后向右侧跌倒；最后膝盖与右手依次缓冲落地',
        m: '重心先向右移动，右膝和右手依次接触地面，身体不得穿过地面',
      }),
    ])

    expect(clips).toHaveLength(2)
    const combined = clips.map((item) => item.s).join('\n')
    expect(combined.indexOf('先抬眼')).toBeLessThan(combined.indexOf('先眨眼'))
    expect(combined.indexOf('先眨眼')).toBeLessThan(combined.indexOf('先靠近'))
    expect(combined.indexOf('先靠近')).toBeLessThan(combined.indexOf('先失去平衡'))
  })

  it('materializes every storyboard in the four-section video-ready format', () => {
    const items = materializeStoryboards({
      shots: stitchStoryboardContinuity([
        shot('苏文菁：先坐下。', { g: '第一镜精确尾帧' }),
        shot('陈蕊：哦。', { p: '会被覆盖', f: '第二镜精确首帧' }),
      ]),
      visualStyle: VisualStyle.photorealistic,
    })
    const requiredSections = [
      '【风格基调】',
      '【本分镜人物】',
      '【场景】',
      '【视频分镜】',
      '初始位置：',
    ]

    expect(items[0].videoPrompt).toContain('8秒，16:9')
    for (const section of requiredSections) expect(items[0].videoPrompt).toContain(section)
    expect(items[1].videoPrompt).toContain('初始位置：第一镜精确尾帧')
    expect(items[0].videoPrompt).toContain('禁止字幕')
    expect(items[0].videoPrompt).toContain('绝对不要生成任何背景音乐（BGM）')
    expect(items[0].videoPrompt).not.toContain('动作顺序：')
    expect(items[0].videoPrompt).not.toContain('动作物理：')
    expect(items[0].videoPrompt).not.toContain('表演变化：')
    expect(storyboardTimelineDetailIssues(items[0].detailedTimeline)).toEqual([])
    expect(items[0].notes).toBe('客厅')
    expect(items[0].videoPrompt.indexOf('【场景】')).toBeLessThan(items[0].videoPrompt.indexOf('【视频分镜】'))
    expect(items[0].directorPrompt).toMatch(/^分镜1：\n景别机位运动：/u)
    expect(items[0].directorPrompt).toContain('\n画面内容：夜晚，客厅')
    expect(items[0].directorPrompt).toContain('\n动作对白：')
    expect(items[0].directorPrompt).not.toContain('【视频分镜】')
    expect(items[1].directorPrompt).toMatch(/^分镜2：/u)
  })

  it('keeps the scene section short and removes dialogue, character actions, and duplicate legacy anchors', () => {
    const [item] = materializeStoryboards({
      shots: [shot('林晨：八点十七。', {
        n: '日，外｜哈德逊河边',
        e: '场景资产唯一锚点“哈德逊河边”：日，外。林晨扶着栏杆大口喘气。苏文菁：现在几点？林晨拽住苏文菁手腕并凑近亲吻。河面宽阔，铁质栏杆沿岸延伸，石板步道带有潮湿反光；场景资产唯一锚点“哈德逊河边”：林晨掏出手机拨号。远处城市天际线轻微虚化。',
        l: '午后自然光从左侧斜射，河面反光，暗部保留细节。',
        v: '林晨先看向手机，随后回答苏文菁。',
        a: '林晨：八点十七。',
      })],
      visualStyle: VisualStyle.photorealistic,
    })

    const scene = item.videoPrompt.match(/【场景】\n([\s\S]*?)\n【视频分镜】/u)?.[1] || ''
    expect(scene).toContain('哈德逊河边')
    expect(scene).toContain('铁质栏杆沿岸延伸')
    expect(scene).toContain('午后自然光')
    expect(scene).not.toContain('林晨')
    expect(scene).not.toContain('苏文菁')
    expect(scene).not.toContain('拨号')
    expect(scene).not.toContain('拽住')
    expect(scene).not.toContain('凑近')
    expect(scene).not.toContain('亲吻')
    expect(scene).not.toContain('场景资产唯一锚点')
    expect(scene.length).toBeLessThanOrEqual(220)
  })

  it('keeps a flashback prompt concise while retaining the clean scene state', () => {
    const [item] = materializeStoryboards({
      shots: [shot('画外音：【OS】她曾住在山上。', {
        n: '回忆，凌晨｜山间小路',
        h: '回忆中的权知岁独自沿山路下行',
        e: '现实起居室已经完全消失，画面只保留冷蓝色山林',
      })],
      visualStyle: VisualStyle.photorealistic,
    })

    expect(item.videoPrompt).toContain('现实起居室已经完全消失')
    expect(item.videoPrompt).toContain('回忆中的权知岁独自沿山路下行')
    expect(item.videoPrompt).not.toContain('动作物理：')
  })
})

describe('asset planning priority', () => {
  const inventories = [
    {
      episodeId: 'episode-1',
      type: AssetType.prop,
      assets: [
        { type: AssetType.prop, name: '普通咖啡杯' },
        { type: AssetType.prop, name: '关键推荐信' },
      ],
    },
    {
      episodeId: 'episode-2',
      type: AssetType.prop,
      assets: [{ type: AssetType.prop, name: '关键推荐信' }],
    },
  ]

  it('counts distinct episode appearances instead of raw mentions', () => {
    const counts = assetEpisodeAppearanceCounts(inventories)
    expect(counts.get('prop:关键推荐信')).toBe(2)
    expect(counts.get('prop:普通咖啡杯')).toBe(1)
  })

  it('keeps every character and location but removes one-episode props', () => {
    const candidates = [
      { type: AssetType.character, name: '林晨' },
      { type: AssetType.location, name: '翡翠山庄别墅客厅' },
      { type: AssetType.prop, name: '普通咖啡杯' },
      { type: AssetType.prop, name: '关键推荐信' },
    ]
    expect(filterCoreAssetCandidates(candidates, inventories).map((asset) => asset.name)).toEqual([
      '林晨',
      '翡翠山庄别墅客厅',
      '关键推荐信',
    ])
  })
})

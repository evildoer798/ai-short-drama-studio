import { describe, expect, it } from 'vitest'
import { DirectorStage } from '@prisma/client'
import {
  actingStageOutputSchema,
  cinedanceShotSchema,
  cinedanceStageOutputSchema,
  createDirectorProductionSchema,
  nextDirectorStage,
  preflightCinedanceShot,
  parseDirectorStageOutput,
  readableDirectorStageError,
} from '@/lib/director-system'
import { buildDirectorStageRepairPrompt } from '@/lib/director-prompts'

const baseShot = {
  order: 1,
  shotKey: 'shot-1',
  title: '门口停步',
  scriptExcerpt: '她在门口停住。',
  duration: 8,
  aspectRatio: '16:9',
  activeReferences: [],
  firstFrame: '角色位于画面左侧中景，门在画面右侧背景。',
  spatialBlocking: '角色站在画面左侧中景，面朝画面右侧背景的门。',
  optics: {
    diagonalFieldOfView: '47°' as const,
    cameraDistance: '摄影机距角色 4 米。',
    visibleOutcome: '自然人眼透视，环境清晰可读。',
    driftLock: '保持自然透视，不切换长焦或广角。',
  },
  camera: '摄影机固定在眼平高度，轻微手持呼吸。',
  actionTiming: [{ from: 0, to: 4, action: '角色迈出一步后因门内声音停住。' }, { from: 4, to: 8, action: '她把重量落回后脚，视线保持在门把手。' }],
  physics: '脚与地面有摩擦，身体质量随重心转移，衣料因惯性稍后停下。',
  lighting: '主光从门内画面右侧照出，摄影机在角色阴影侧，曝光优先保留门内亮部。',
  audio: '室内低声谈话，角色不说话，无字幕。',
  continuityIn: { characterStates: [], propStates: [], screenDirection: '向右', gazeLines: ['角色看向门'], lightingDirection: '右后方至左前方', geographyFacts: ['门在角色右侧'] },
  continuityOut: { characterStates: [], propStates: [], screenDirection: '向右', gazeLines: ['角色看向门把手'], lightingDirection: '右后方至左前方', geographyFacts: ['角色停在门左侧'] },
  generationPrompt: 'SCENE CONTEXT\nA woman stops beside a door.\nFIRST FRAME AND SPATIAL BLOCKING\nThe woman is screen-left, the door is screen-right.',
}

describe('director stage state machine', () => {
  it('only advances in the confirmed stage order', () => {
    expect(nextDirectorStage(DirectorStage.acting)).toBe(DirectorStage.lira)
    expect(nextDirectorStage(DirectorStage.lira)).toBe(DirectorStage.cinedance)
    expect(nextDirectorStage(DirectorStage.cinedance)).toBe(DirectorStage.review)
    expect(nextDirectorStage(DirectorStage.review)).toBe(DirectorStage.completed)
  })
})

describe('director stage structural repair prompt', () => {
  it('includes exact validation paths, the target shape, and reference object rules', () => {
    const prompt = buildDirectorStageRepairPrompt({
      stage: 'lira',
      invalidOutput: {
        characterStates: [{ identityAnchors: null, references: ['portrait.png'] }],
      },
      issues: [
        { path: 'characterStates.0.identityAnchors', message: 'Expected array, received null' },
        { path: 'characterStates.0.references.0', message: 'Expected object, received string' },
      ],
    })

    expect(prompt).toContain('characterStates.0.identityAnchors')
    expect(prompt).toContain('characterStates.0.references.0')
    expect(prompt).toContain('"styleBible"')
    expect(prompt).toContain('{"assetId":"","assetName":"","mediaId":null}')
    expect(prompt).toContain('保留原有角色、资产、镜头与创作判断')
    expect(prompt).toContain('最外层直接返回一个完整 JSON 对象')
  })
})

describe('ACTING provider output normalization', () => {
  const actingOutput = {
    summary: '角色通过压抑反应推进冲突。',
    characterProfiles: [{
      assetId: 'character-1',
      assetName: '月神女王',
      masterPrompt: 'A controlled ruler whose restraint reveals pressure.',
      physicality: '身体保持稳定，压力增加时肩颈变硬。',
      psychologicalEngine: '通过维持秩序掩饰失控恐惧。',
      vocalBehavior: '语速稳定，压力下句尾变短。',
      signatureTics: ['抚平袖口｜准备隐藏真实反应时'],
      stressTics: ['拇指压住食指关节', '屏住一次呼吸：听到威胁时'],
      concealmentBehavior: null,
      facialMask: null,
      maskCrackTrigger: null,
      pressureTransformation: null,
      gait: '步幅稳定。',
      eyeLife: '先观察对方，再短暂移开视线。',
      softeningTarget: null,
    }],
    voiceProfiles: [],
    shotPerformances: [{
      shotKey: 'shot-1', shotTitle: '王座前', assetId: 'character-1', assetName: '月神女王',
      objective: '迫使来者交代目的。', obstacle: '来者拒绝服从。', stakes: '王权威信可能崩塌。',
      subtext: null, business: null, statusIn: null, statusOut: null, proximityIn: null, proximityOut: null,
      speaks: false,
      beats: [{
        order: 1, startSeconds: 0, endSeconds: 4, trigger: null, tactic: '施压',
        visibleBehavior: '她停止动作，直视来者。', reaction: null, gaze: null, posture: null,
        tempo: null, voiceDelivery: null, entryState: null, exitState: null,
      }],
    }],
    userDecisions: [],
  }

  it('converts string signature and stress tics into structured behavior/trigger objects', () => {
    const result = actingStageOutputSchema.parse(actingOutput)
    expect(result.characterProfiles[0].signatureTics[0]).toEqual({
      behavior: '抚平袖口', trigger: '准备隐藏真实反应时',
    })
    expect(result.characterProfiles[0].stressTics).toEqual([
      { behavior: '拇指压住食指关节', trigger: '角色承受压力或试图掩饰真实反应时' },
      { behavior: '屏住一次呼吸', trigger: '听到威胁时' },
    ])
  })

  it('unwraps common provider envelopes around a complete ACTING object', () => {
    expect(parseDirectorStageOutput('acting', [actingOutput])).toMatchObject({
      summary: actingOutput.summary,
      characterProfiles: [{ assetId: 'character-1' }],
    })
    expect(parseDirectorStageOutput('acting', { result: actingOutput })).toMatchObject({
      summary: actingOutput.summary,
      characterProfiles: [{ assetId: 'character-1' }],
    })
  })

  it('keeps multi-item top-level arrays invalid instead of guessing', () => {
    expect(() => parseDirectorStageOutput('acting', [actingOutput, actingOutput])).toThrow()
  })

  it('turns schema details into a short actionable stage error', () => {
    const invalid = actingStageOutputSchema.safeParse({ ...actingOutput, characterProfiles: 'wrong' })
    expect(invalid.success).toBe(false)
    if (!invalid.success) {
      expect(readableDirectorStageError(invalid.error)).toBe(
        'AI 返回的角色表演档案结构不完整，系统没有保存这份异常结果。请点击“重新生成”，系统会按正确格式重新整理。',
      )
    }
  })
})

describe('director production source', () => {
  it('accepts an independent project with an uploaded script', () => {
    const result = createDirectorProductionSchema.parse({
      mode: 'new',
      workspaceId: 'workspace-1',
      projectName: '雨夜来客',
      scriptTitle: '第一集',
      scriptContent: '雨夜。'.repeat(40),
      name: '雨夜来客 · 导演版',
    })
    expect(result.mode).toBe('new')
  })

  it('rejects uploaded scripts that are too short', () => {
    const result = createDirectorProductionSchema.safeParse({
      mode: 'new',
      workspaceId: 'workspace-1',
      projectName: '雨夜来客',
      scriptTitle: '第一集',
      scriptContent: '太短',
      name: '雨夜来客 · 导演版',
    })
    expect(result.success).toBe(false)
  })

  it('keeps the existing project import contract backward compatible', () => {
    const result = createDirectorProductionSchema.parse({
      projectId: 'project-1',
      sourceEpisodeId: 'episode-1',
      name: '旧项目 · 导演版',
    })
    expect(result.mode).toBeUndefined()
  })
})

describe('CINEDANCE preflight', () => {
  it('normalizes provider shorthand in continuity ledgers', () => {
    const result = parseDirectorStageOutput('cinedance', {
      summary: '测试',
      shots: [{
        ...baseShot,
        activeReferences: ['claire-suppressed'],
        continuityIn: {
          ...baseShot.continuityIn,
          characterStates: [{ characterId: 'claire', status: 'suppressed', condition: '下颌紧绷' }],
          propStates: [{ propId: 'medical-kit', state: 'worn', location: '腰侧' }],
        },
        continuityOut: {
          ...baseShot.continuityOut,
          characterStates: ['claire · awakened'],
          propStates: ['medical-kit · opened'],
        },
      }],
      userDecisions: [],
    })

    expect(result.shots[0].continuityIn.characterStates[0]).toEqual({
      assetId: 'claire', stateId: 'suppressed', visibleFacts: ['下颌紧绷'],
    })
    expect(result.shots[0].continuityIn.propStates[0]).toMatchObject({
      assetId: 'medical-kit', stateId: 'worn', position: '腰侧', condition: '未说明',
    })
    expect(result.shots[0].continuityOut.characterStates[0]).toEqual({
      assetId: 'claire', stateId: 'awakened', visibleFacts: [],
    })
    expect(result.shots[0].continuityOut.propStates[0]).toMatchObject({
      assetId: 'medical-kit', stateId: 'opened', position: '未说明', condition: '未说明',
    })
    expect(result.shots[0].activeReferences[0]).toEqual({
      assetId: 'claire-suppressed', assetName: 'claire-suppressed', mediaId: null,
    })
  })

  it('accepts a physically anchored, non-overlapping shot', () => {
    const shot = cinedanceShotSchema.parse(baseShot)
    expect(preflightCinedanceShot(shot)).toEqual([])
  })

  it('blocks timing overlap and vague physics before video submission', () => {
    const shot = cinedanceShotSchema.parse({
      ...baseShot,
      spatialBlocking: '角色站在那里。',
      physics: '动作自然。',
      actionTiming: [{ from: 0, to: 5, action: '迈步。' }, { from: 4, to: 8, action: '停下。' }],
    })
    expect(preflightCinedanceShot(shot).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'TIMING_OVERLAP', 'BLOCKING_AMBIGUOUS', 'PHYSICS_UNSPECIFIED',
    ]))
  })

  it('rejects duplicate shot keys and non-contiguous order', () => {
    const result = cinedanceStageOutputSchema.safeParse({
      summary: '测试',
      shots: [baseShot, { ...baseShot, order: 3 }],
      userDecisions: [],
    })
    expect(result.success).toBe(false)
  })
})

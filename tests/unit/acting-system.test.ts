import { describe, expect, it } from 'vitest'
import {
  appendShotPerformancePrompt,
  compileShotPerformancePrompt,
  reviewShotPerformance,
  shotPerformancesSchema,
  shotPerformanceSchema,
  type CompilableShotPerformance,
  type ShotPerformanceInput,
} from '@/lib/acting-system'

function performance(patch: Partial<ShotPerformanceInput> = {}): ShotPerformanceInput {
  return {
    assetId: 'character-1',
    objective: '迫使林默承认他在撒谎',
    obstacle: '房间里还有不能知道真相的证人',
    stakes: '失败会暴露自己的调查身份',
    subtext: '表面谈论杯子，实际在验证口供',
    business: '缓慢擦拭桌上的杯子',
    statusIn: '占据优势',
    statusOut: '短暂失控后重新掌控',
    proximityIn: '2.2 米',
    proximityOut: '0.8 米',
    sceneAdaptation: '身体保持低重心，擦杯子的手承担压力，眼睛先于头部找到对方。',
    speaks: true,
    beats: [
      {
        order: 1,
        startSeconds: 0,
        endSeconds: 3,
        tactic: '试探',
        behavior: '不看对方，继续擦杯子，通过余光观察。',
        reaction: '对方说到一半时手指已经放慢。',
      },
      {
        order: 2,
        startSeconds: 3,
        endSeconds: 6,
        tactic: '施压',
        trigger: '对方提到死者名字',
        behavior: '擦拭动作停在杯沿，抬眼后才转头。',
        gaze: '先落在对方手上，再回到眼睛。',
        entryState: '动作仍在继续',
        exitState: '动作已经停止',
      },
    ],
    ...patch,
  }
}

describe('acting system validation', () => {
  it('rejects overlapping beat timing', () => {
    const parsed = shotPerformanceSchema.safeParse(performance({
      beats: [
        { order: 1, startSeconds: 0, endSeconds: 4, tactic: '试探', behavior: '擦杯子。' },
        { order: 2, startSeconds: 3, endSeconds: 6, tactic: '施压', behavior: '停止动作。' },
      ],
    }))
    expect(parsed.success).toBe(false)
  })

  it('requires contiguous beat ordering and one performance per character', () => {
    expect(shotPerformanceSchema.safeParse(performance({
      beats: [
        { order: 1, tactic: '试探', behavior: '擦杯子。' },
        { order: 3, tactic: '施压', behavior: '停止动作。' },
      ],
    })).success).toBe(false)
    expect(shotPerformancesSchema.safeParse({
      performances: [performance(), performance()],
    }).success).toBe(false)
  })

  it('scores behavior-led acting and warns about emotion-only objectives', () => {
    expect(reviewShotPerformance(performance(), { hasEyeLife: true })).toEqual({ score: 5, issues: [] })
    const weak = reviewShotPerformance(performance({
      objective: '表现愤怒',
      business: null,
      beats: [{ order: 1, tactic: '生气', behavior: '皱眉。' }],
    }), { hasEyeLife: false })
    expect(weak.score).toBeLessThanOrEqual(2)
    expect(weak.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'OBJECTIVE_IS_STATE',
      'MONOTACTIC',
      'MISSING_BUSINESS',
      'MISSING_REACTION',
      'MISSING_EYE_LIFE',
    ]))
  })
})

describe('acting prompt compiler', () => {
  const compilable: CompilableShotPerformance = {
    ...performance(),
    assetName: '维克托',
    referenceOrder: 2,
    actingProfile: {
      physicality: '低重心，动作经济。',
      psychologicalEngine: '等待是他的武器。',
      vocalBehavior: '局势越严重，声音越轻。',
      eyeLife: '缓慢眨眼，持续扫描手、出口和倒影。',
    },
    voiceProfile: { prompt: '低沉沙哑的城市口音，短句，严肃时只会更轻。' },
  }

  it('binds acting to the character reference and keeps ordered beats', () => {
    const prompt = compileShotPerformancePrompt([compilable], { includeVoice: true })
    expect(prompt).toContain('【表演导演·维克托 @2】')
    expect(prompt).toContain('当下目标：迫使林默承认他在撒谎')
    expect(prompt.indexOf('0–3s')).toBeLessThan(prompt.indexOf('3–6s'))
    expect(prompt).toContain('固定声音（原样执行）')
    expect(prompt).toContain('潜台词（不要直接表演）')
  })

  it('omits a voice identity when the character is silent or audio is disabled', () => {
    expect(compileShotPerformancePrompt([{ ...compilable, speaks: false }], { includeVoice: true }))
      .not.toContain('固定声音')
    expect(compileShotPerformancePrompt([compilable], { includeVoice: false }))
      .not.toContain('固定声音')
  })

  it('appends the acting layer without replacing the visual prompt', () => {
    expect(appendShotPerformancePrompt('原始分镜', '表演导演')).toBe('原始分镜\n\n表演导演')
  })
})

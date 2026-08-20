import { z } from 'zod'

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().nullable()

export const triggeredTicSchema = z.object({
  behavior: z.string().trim().min(1).max(500),
  trigger: z.string().trim().min(1).max(500),
})

export const characterActingProfileSchema = z.object({
  masterPrompt: z.string().trim().min(1).max(6000),
  physicality: z.string().trim().min(1).max(2000),
  psychologicalEngine: z.string().trim().min(1).max(2000),
  vocalBehavior: z.string().trim().min(1).max(2000),
  signatureTics: z.array(triggeredTicSchema).max(8).default([]),
  stressTics: z.array(triggeredTicSchema).max(8).default([]),
  concealmentBehavior: optionalText(2000),
  facialMask: optionalText(2000),
  maskCrackTrigger: optionalText(2000),
  pressureTransformation: optionalText(2000),
  gait: optionalText(2000),
  eyeLife: z.string().trim().min(1).max(2000),
  softeningTarget: optionalText(1000),
})

export const voiceProfileSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  ageDescriptor: optionalText(200),
  originAccent: optionalText(500),
  timbreRegister: optionalText(1000),
  paceDelivery: optionalText(1000),
  pressureShift: optionalText(1000),
  locked: z.boolean().default(true),
})

export const characterPerformanceProfilesSchema = z.object({
  actingProfile: characterActingProfileSchema.optional(),
  voiceProfile: voiceProfileSchema.optional(),
  unlockVoice: z.boolean().optional(),
}).refine((value) => value.actingProfile || value.voiceProfile, {
  message: '至少提交一份角色表演档案或声音档案',
})

export const performanceBeatSchema = z.object({
  order: z.coerce.number().int().min(1).max(4),
  startSeconds: z.coerce.number().min(0).max(60).optional().nullable(),
  endSeconds: z.coerce.number().min(0).max(60).optional().nullable(),
  tactic: z.string().trim().min(1).max(300),
  trigger: optionalText(1000),
  behavior: z.string().trim().min(1).max(2000),
  reaction: optionalText(1000),
  gaze: optionalText(1000),
  posture: optionalText(1000),
  tempo: optionalText(1000),
  voiceDelivery: optionalText(1000),
  entryState: optionalText(1000),
  exitState: optionalText(1000),
}).superRefine((beat, context) => {
  if (beat.startSeconds != null && beat.endSeconds != null && beat.endSeconds <= beat.startSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endSeconds'],
      message: '节拍结束时间必须晚于开始时间',
    })
  }
})

export const shotPerformanceSchema = z.object({
  assetId: z.string().trim().min(1),
  objective: z.string().trim().min(1).max(2000),
  obstacle: z.string().trim().min(1).max(2000),
  stakes: z.string().trim().min(1).max(2000),
  subtext: optionalText(2000),
  business: optionalText(2000),
  statusIn: optionalText(500),
  statusOut: optionalText(500),
  proximityIn: optionalText(500),
  proximityOut: optionalText(500),
  sceneAdaptation: optionalText(6000),
  speaks: z.boolean().default(false),
  beats: z.array(performanceBeatSchema).min(1).max(4),
}).superRefine((performance, context) => {
  const orders = performance.beats.map((beat) => beat.order)
  if (new Set(orders).size !== orders.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['beats'],
      message: '表演节拍顺序不能重复',
    })
  }
  const expectedOrders = [...orders].sort((left, right) => left - right)
  if (expectedOrders.some((order, index) => order !== index + 1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['beats'],
      message: '表演节拍必须从 1 开始连续编号',
    })
  }
  const ordered = [...performance.beats].sort((left, right) => left.order - right.order)
  ordered.forEach((beat, index) => {
    const previous = ordered[index - 1]
    if (previous?.endSeconds != null && beat.startSeconds != null && beat.startSeconds < previous.endSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['beats', performance.beats.indexOf(beat), 'startSeconds'],
        message: '表演节拍时间不能重叠',
      })
    }
  })
})

export const shotPerformancesSchema = z.object({
  performances: z.array(shotPerformanceSchema).max(12),
}).superRefine((value, context) => {
  const assetIds = value.performances.map((performance) => performance.assetId)
  if (new Set(assetIds).size !== assetIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['performances'],
      message: '同一角色在一个分镜中只能有一份表演任务',
    })
  }
})

export type TriggeredTic = z.infer<typeof triggeredTicSchema>
export type CharacterActingProfileInput = z.infer<typeof characterActingProfileSchema>
export type VoiceProfileInput = z.infer<typeof voiceProfileSchema>
export type PerformanceBeatInput = z.infer<typeof performanceBeatSchema>
export type ShotPerformanceInput = z.infer<typeof shotPerformanceSchema>

export type ActingQualityIssue = {
  code: string
  message: string
}

export type ActingQualityReport = {
  score: number
  issues: ActingQualityIssue[]
}

const stateOnlyObjectivePattern = /^(?:感到|感觉|表现|显得|保持|be|feel|seem|look)\s*(?:愤怒|生气|悲伤|恐惧|紧张|内疚|开心|angry|sad|afraid|nervous|guilty|happy)/iu
const cameraOrWardrobePattern = /(?:镜头|摄影机|推轨|摇摄|变焦|焦段|灯光|调色|服装|衣服|外套|camera|dolly|pan|zoom|lens|lighting|color grade|wardrobe|costume)/iu

export function reviewShotPerformance(
  performance: ShotPerformanceInput,
  options: { hasEyeLife?: boolean } = {},
): ActingQualityReport {
  const issues: ActingQualityIssue[] = []
  let score = 0

  if (stateOnlyObjectivePattern.test(performance.objective)) {
    issues.push({ code: 'OBJECTIVE_IS_STATE', message: '目标应是指向具体对象的行动动词，而不是情绪状态。' })
  } else {
    score += 1
  }
  if (performance.obstacle && performance.stakes) score += 1
  if (performance.beats.length >= 2 || performance.beats[0]?.trigger) score += 1
  else issues.push({ code: 'MONOTACTIC', message: '当前表演只有一个未触发变化的策略，容易显得平。' })

  if (performance.business) score += 1
  else issues.push({ code: 'MISSING_BUSINESS', message: '建议给角色一个可拍摄的身体任务。' })

  const hasReaction = performance.beats.some((beat) => Boolean(beat.reaction?.trim()))
  if (hasReaction && options.hasEyeLife !== false) score += 1
  else {
    if (!hasReaction) issues.push({ code: 'MISSING_REACTION', message: '没有定义倾听或事件后的可见反应。' })
    if (options.hasEyeLife === false) issues.push({ code: 'MISSING_EYE_LIFE', message: '角色永久表演档案缺少眼神生命描述。' })
  }

  if (performance.sceneAdaptation && cameraOrWardrobePattern.test(performance.sceneAdaptation)) {
    issues.push({
      code: 'ACTING_LAYER_POLLUTION',
      message: '场景表演适配中混入了摄影、灯光或服装信息，应移到对应提示词层。',
    })
  }

  return { score: Math.min(5, score), issues }
}

export type CompilableShotPerformance = ShotPerformanceInput & {
  assetName: string
  referenceOrder?: number | null
  actingProfile?: {
    physicality: string
    psychologicalEngine: string
    vocalBehavior: string
    eyeLife: string
  } | null
  voiceProfile?: {
    prompt: string
  } | null
}

function cleanLine(value?: string | null) {
  return value?.trim().replace(/\s+/gu, ' ') || ''
}

function beatTimeLabel(beat: PerformanceBeatInput) {
  if (beat.startSeconds == null || beat.endSeconds == null) return `节拍 ${beat.order}`
  return `${beat.startSeconds}–${beat.endSeconds}s`
}

function compileBeat(beat: PerformanceBeatInput) {
  return [
    `${beatTimeLabel(beat)}：策略“${cleanLine(beat.tactic)}”`,
    beat.trigger ? `触发：${cleanLine(beat.trigger)}` : '',
    `可见行为：${cleanLine(beat.behavior)}`,
    beat.reaction ? `倾听/反应：${cleanLine(beat.reaction)}` : '',
    beat.gaze ? `视线：${cleanLine(beat.gaze)}` : '',
    beat.posture ? `身体：${cleanLine(beat.posture)}` : '',
    beat.tempo ? `节奏：${cleanLine(beat.tempo)}` : '',
    beat.voiceDelivery ? `说话行为：${cleanLine(beat.voiceDelivery)}` : '',
    beat.entryState ? `起始状态：${cleanLine(beat.entryState)}` : '',
    beat.exitState ? `结束状态：${cleanLine(beat.exitState)}` : '',
  ].filter(Boolean).join('；')
}

export function compileShotPerformancePrompt(
  performances: CompilableShotPerformance[],
  options: { includeVoice?: boolean; maximumCharacters?: number } = {},
) {
  if (performances.length === 0) return ''
  const blocks = performances.map((performance) => {
    const referenceTag = performance.referenceOrder ? ` @${performance.referenceOrder}` : ''
    const profile = performance.actingProfile
    const voice = options.includeVoice && performance.speaks && performance.voiceProfile?.prompt
      ? `\n固定声音（原样执行）：“${cleanLine(performance.voiceProfile.prompt).replace(/^“|”$/gu, '')}”`
      : ''
    return [
      `【表演导演·${performance.assetName}${referenceTag}】`,
      `当下目标：${cleanLine(performance.objective)}`,
      `阻碍：${cleanLine(performance.obstacle)}；失败代价：${cleanLine(performance.stakes)}`,
      performance.subtext ? `潜台词（不要直接表演）：${cleanLine(performance.subtext)}` : '',
      performance.business ? `身体任务：${cleanLine(performance.business)}` : '',
      performance.statusIn || performance.statusOut
        ? `地位变化：${cleanLine(performance.statusIn) || '未指定'} → ${cleanLine(performance.statusOut) || '未指定'}`
        : '',
      performance.proximityIn || performance.proximityOut
        ? `人物距离：${cleanLine(performance.proximityIn) || '未指定'} → ${cleanLine(performance.proximityOut) || '未指定'}`
        : '',
      performance.sceneAdaptation
        ? `本镜适配：${cleanLine(performance.sceneAdaptation)}`
        : profile
          ? `恒定行为引擎：${cleanLine(profile.psychologicalEngine)}；身体：${cleanLine(profile.physicality)}；眼神：${cleanLine(profile.eyeLife)}；说话行为：${cleanLine(profile.vocalBehavior)}`
          : '',
      ...[...performance.beats].sort((left, right) => left.order - right.order).map(compileBeat),
    ].filter(Boolean).join('\n') + voice
  })
  const compiled = `【角色表演层】\n${blocks.join('\n\n')}\n只呈现可观察行为；情绪来自目标受阻。按节拍拍摄已存在的动作状态，复杂过渡应拆镜。`
  const maximum = Math.max(500, options.maximumCharacters || 6000)
  return compiled.length <= maximum ? compiled : `${compiled.slice(0, maximum - 1).trimEnd()}…`
}

export function appendShotPerformancePrompt(basePrompt: string, performancePrompt: string) {
  const base = basePrompt.trim()
  const acting = performancePrompt.trim()
  if (!acting) return base
  return base ? `${base}\n\n${acting}` : acting
}

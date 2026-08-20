import { DirectorStage } from '@prisma/client'
import { z } from 'zod'

const text = (maximum = 4000) => z.string().trim().min(1).max(maximum)
const optionalText = (maximum = 4000) => z.string().trim().max(maximum).optional().nullable()

function normalizeTriggeredTic(value: unknown) {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) return value
    const parts = normalized.split(/\s*(?:｜|\||；|;|：|:)\s*/u, 2)
    return {
      behavior: parts[0],
      trigger: parts[1] || '角色承受压力或试图掩饰真实反应时',
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return {
      ...record,
      behavior: record.behavior ?? record.action ?? record.tic ?? record.visibleBehavior,
      trigger: record.trigger ?? record.when ?? record.condition ?? record.triggerCondition,
    }
  }
  return value
}

const triggeredTicOutputSchema = z.preprocess(normalizeTriggeredTic, z.object({
  behavior: text(500),
  trigger: text(500),
}))

export const directorStageSchema = z.enum(['acting', 'lira', 'cinedance'])

function normalizeReference(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim()
    return { assetId: normalized, assetName: normalized, mediaId: null }
  }
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  if (!record) return value
  return {
    ...record,
    assetId: record.assetId ?? record.id ?? record.assetName ?? record.name,
    assetName: record.assetName ?? record.name ?? record.assetId ?? record.id,
    mediaId: record.mediaId ?? null,
  }
}

const referenceSchema = z.preprocess(normalizeReference, z.object({
  assetId: text(200),
  assetName: text(200),
  mediaId: optionalText(200),
}))

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstNonEmptyString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim()
}

function stringList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim())
  const single = firstNonEmptyString(value)
  return single ? [single] : []
}

function splitStateReference(value: string) {
  const parts = value.split(/\s*(?:·|｜|\||:|：|\/|—|–)\s*/u).filter(Boolean)
  return { assetId: parts[0] || value, stateId: parts[1] || parts[0] || value }
}

function normalizeContinuityCharacterState(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = splitStateReference(value.trim())
    return { ...parsed, visibleFacts: [] }
  }
  const record = recordOf(value)
  if (!record) return value
  const assetId = firstNonEmptyString(record.assetId, record.characterId, record.id, record.assetName, record.characterName)
  const stateId = firstNonEmptyString(record.stateId, record.characterStateId, record.state, record.status, record.stateName)
    || (assetId ? `${assetId}-state` : undefined)
  return {
    ...record,
    assetId,
    stateId,
    visibleFacts: stringList(record.visibleFacts ?? record.facts ?? record.visibleState ?? record.visibleDetails ?? record.condition),
  }
}

function normalizeContinuityPropState(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = splitStateReference(value.trim())
    return { ...parsed, holder: null, position: '未说明', condition: '未说明' }
  }
  const record = recordOf(value)
  if (!record) return value
  const assetId = firstNonEmptyString(record.assetId, record.propId, record.id, record.assetName, record.propName)
  const condition = firstNonEmptyString(record.condition, record.visibleCondition, record.status, record.wearAndContinuity, record.stateName)
    || '未说明'
  const stateId = firstNonEmptyString(record.stateId, record.propStateId, record.state, record.status, record.stateName)
    || (assetId ? `${assetId}-state` : undefined)
  return {
    ...record,
    assetId,
    stateId,
    holder: firstNonEmptyString(record.holder, record.owner, record.carriedBy) ?? null,
    position: firstNonEmptyString(record.position, record.location, record.placement, record.ownerOrPosition) || '未说明',
    condition,
  }
}

export const performanceBeatOutputSchema = z.object({
  order: z.number().int().min(1).max(8),
  startSeconds: z.number().min(0).max(120).nullable(),
  endSeconds: z.number().min(0).max(120).nullable(),
  trigger: optionalText(600),
  tactic: text(400),
  visibleBehavior: text(1200),
  reaction: optionalText(1000),
  gaze: optionalText(600),
  posture: optionalText(600),
  tempo: optionalText(400),
  voiceDelivery: optionalText(800),
  entryState: optionalText(800),
  exitState: optionalText(800),
})

export const characterActingProfileOutputSchema = z.object({
  assetId: text(200),
  assetName: text(200),
  masterPrompt: text(6000),
  physicality: text(2000),
  psychologicalEngine: text(2000),
  vocalBehavior: text(2000),
  signatureTics: z.array(triggeredTicOutputSchema).max(8),
  stressTics: z.array(triggeredTicOutputSchema).max(8),
  concealmentBehavior: optionalText(2000),
  facialMask: optionalText(2000),
  maskCrackTrigger: optionalText(2000),
  pressureTransformation: optionalText(2000),
  gait: optionalText(1000),
  eyeLife: text(2000),
  softeningTarget: optionalText(1000),
})

export const voiceProfileOutputSchema = z.object({
  assetId: text(200),
  assetName: text(200),
  prompt: text(2000),
  ageDescriptor: optionalText(300),
  originAccent: optionalText(500),
  timbreRegister: optionalText(1000),
  paceDelivery: optionalText(1000),
  pressureShift: optionalText(1000),
  locked: z.boolean(),
})

export const shotPerformanceOutputSchema = z.object({
  shotKey: text(200),
  shotTitle: text(300),
  assetId: text(200),
  assetName: text(200),
  objective: text(1200),
  obstacle: text(1200),
  stakes: text(1200),
  subtext: optionalText(1200),
  business: optionalText(1200),
  statusIn: optionalText(500),
  statusOut: optionalText(500),
  proximityIn: optionalText(500),
  proximityOut: optionalText(500),
  speaks: z.boolean(),
  beats: z.array(performanceBeatOutputSchema).min(1).max(8),
})

export const actingStageOutputSchema = z.object({
  summary: text(1200),
  characterProfiles: z.array(characterActingProfileOutputSchema).min(1).max(30),
  voiceProfiles: z.array(voiceProfileOutputSchema).max(30),
  shotPerformances: z.array(shotPerformanceOutputSchema).min(1).max(120),
  userDecisions: z.array(text(500)).max(12),
})

const assetStateSchema = z.object({
  stateId: text(200),
  assetId: text(200),
  assetName: text(200),
  stateName: text(300),
  identityAnchors: z.array(text(400)).min(2).max(12),
  wardrobe: text(1000),
  hairMakeup: text(800),
  bodyCondition: text(800),
  wearAndContinuity: text(1000),
  imageModelRoute: z.enum(['soul-2', 'soul-cinema', 'ai-cast', 'nbp', 'seedream-4.5', 'gpt-image-2']),
  soulIdRequired: z.boolean(),
  prompt: text(3000),
  references: z.array(referenceSchema).max(14),
})

const locationBibleSchema = z.object({
  assetId: text(200),
  assetName: text(200),
  geography: text(2000),
  landmarks: z.array(text(500)).min(1).max(12),
  materials: z.array(text(500)).min(1).max(12),
  lightingSource: text(1000),
  palette: z.object({ dominant: text(200), secondary: text(200), accent: text(200) }),
  prompt: text(3000),
  references: z.array(referenceSchema).max(14),
})

const propStateSchema = z.object({
  stateId: text(200),
  assetId: text(200),
  assetName: text(200),
  ownerOrPosition: text(600),
  materialAndFinish: text(600),
  condition: text(600),
  readableText: optionalText(300),
  prompt: text(2000),
  references: z.array(referenceSchema).max(14),
})

const keyframeSchema = z.object({
  shotKey: text(200),
  shotTitle: text(300),
  purpose: text(800),
  characterStateIds: z.array(text(200)).max(12),
  propStateIds: z.array(text(200)).max(12),
  locationAssetId: optionalText(200),
  firstFramePrompt: text(3500),
  endFramePrompt: optionalText(3500),
  aspectRatio: text(20),
  references: z.array(referenceSchema).max(14),
})

export const liraStageOutputSchema = z.object({
  summary: text(1200),
  styleBible: z.object({
    visualRegister: text(1000),
    lightingRule: text(1000),
    materialRule: text(1000),
    paletteRule: text(800),
    imageEditOrder: z.array(z.enum(['nbp', 'seedream-4.5', 'gpt-image-2'])).length(3),
  }),
  characterStates: z.array(assetStateSchema).max(60),
  locations: z.array(locationBibleSchema).max(30),
  props: z.array(propStateSchema).max(60),
  keyframes: z.array(keyframeSchema).min(1).max(120),
  userDecisions: z.array(text(500)).max(12),
})

const continuityLedgerSchema = z.object({
  characterStates: z.array(z.preprocess(normalizeContinuityCharacterState, z.object({ assetId: text(200), stateId: text(200), visibleFacts: z.array(text(500)).max(12) }))).max(20),
  propStates: z.array(z.preprocess(normalizeContinuityPropState, z.object({ assetId: text(200), stateId: text(200), holder: optionalText(300), position: text(500), condition: text(500) }))).max(20),
  screenDirection: text(600),
  gazeLines: z.array(text(500)).max(12),
  lightingDirection: text(600),
  geographyFacts: z.array(text(500)).max(12),
})

export const cinedanceShotSchema = z.object({
  order: z.number().int().min(1).max(999),
  shotKey: text(200),
  title: text(300),
  scriptExcerpt: text(5000),
  duration: z.number().int().min(1).max(60),
  aspectRatio: text(20),
  activeReferences: z.array(referenceSchema).max(14),
  firstFrame: text(2400),
  spatialBlocking: text(2400),
  optics: z.object({
    diagonalFieldOfView: z.enum(['8°', '18°', '29°', '47°', '84°', '107°', '135°']),
    cameraDistance: text(500),
    visibleOutcome: text(1200),
    driftLock: text(1000),
  }),
  camera: text(1800),
  actionTiming: z.array(z.object({ from: z.number().min(0), to: z.number().min(0), action: text(1600) })).min(1).max(12),
  physics: text(1800),
  lighting: text(1800),
  audio: text(1600),
  continuityIn: continuityLedgerSchema,
  continuityOut: continuityLedgerSchema,
  generationPrompt: text(10000),
})

export const cinedanceStageOutputSchema = z.object({
  summary: text(1200),
  shots: z.array(cinedanceShotSchema).min(1).max(120),
  userDecisions: z.array(text(500)).max(12),
}).superRefine((value, context) => {
  const keys = value.shots.map((shot) => shot.shotKey)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shots'], message: '镜头标识不能重复' })
  }
  const orders = value.shots.map((shot) => shot.order).sort((left, right) => left - right)
  if (orders.some((order, index) => order !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shots'], message: '镜头顺序必须从 1 开始连续编号' })
  }
})

export const stageOutputSchemas = {
  acting: actingStageOutputSchema,
  lira: liraStageOutputSchema,
  cinedance: cinedanceStageOutputSchema,
} as const

export type DirectorEditableStage = z.infer<typeof directorStageSchema>
export type ActingStageOutput = z.infer<typeof actingStageOutputSchema>
export type LiraStageOutput = z.infer<typeof liraStageOutputSchema>
export type CinedanceStageOutput = z.infer<typeof cinedanceStageOutputSchema>

const existingDirectorProductionSchema = z.object({
  mode: z.literal('existing').optional(),
  projectId: text(200),
  sourceEpisodeId: z.string().trim().min(1).max(200).optional().nullable(),
  name: z.string().trim().min(1, '请输入制作名称').max(100),
})

const newDirectorProductionSchema = z.object({
  mode: z.literal('new'),
  workspaceId: text(200),
  projectName: z.string().trim().min(1, '请输入新项目名称').max(80),
  scriptTitle: z.string().trim().min(1, '请输入剧本标题').max(120),
  scriptContent: z.string().trim().min(100, '剧本正文至少需要 100 个字符').max(500_000, '剧本正文不能超过 50 万字符'),
  name: z.string().trim().min(1, '请输入制作名称').max(100),
})

export const createDirectorProductionSchema = z.union([
  newDirectorProductionSchema,
  existingDirectorProductionSchema,
])

export const updateDirectorStageSchema = z.object({ output: z.unknown() })
export const generateDirectorStageSchema = z.object({ feedback: z.string().trim().max(4000).optional().default('') })
export const reviewDirectorVideoSchema = z.object({
  decision: z.enum(['undecided', 'selected', 'rejected']),
  reviewNote: z.string().trim().max(2000).optional().nullable(),
})

export function nextDirectorStage(stage: DirectorStage) {
  if (stage === DirectorStage.acting) return DirectorStage.lira
  if (stage === DirectorStage.lira) return DirectorStage.cinedance
  if (stage === DirectorStage.cinedance) return DirectorStage.review
  if (stage === DirectorStage.review) return DirectorStage.completed
  return DirectorStage.completed
}

export function preflightCinedanceShot(shot: z.infer<typeof cinedanceShotSchema>) {
  const issues: Array<{ code: string; message: string }> = []
  if (shot.actionTiming.some((beat) => beat.to <= beat.from || beat.to > shot.duration)) {
    issues.push({ code: 'TIMING_RANGE', message: '动作时间块必须递增且不能超出镜头时长。' })
  }
  for (let index = 1; index < shot.actionTiming.length; index++) {
    if (shot.actionTiming[index].from < shot.actionTiming[index - 1].to) {
      issues.push({ code: 'TIMING_OVERLAP', message: '动作时间块存在重叠。' })
      break
    }
  }
  if (shot.activeReferences.length > 14) issues.push({ code: 'REFERENCE_LIMIT', message: '单镜参考素材不能超过 14 个。' })
  if (!/screen-left|screen-right|画面左|画面右|前景|中景|背景/iu.test(shot.spatialBlocking)) {
    issues.push({ code: 'BLOCKING_AMBIGUOUS', message: '空间站位缺少可测量的画面位置。' })
  }
  if (!/gravity|mass|weight|friction|inertia|重力|重量|摩擦|惯性|接触/iu.test(shot.physics)) {
    issues.push({ code: 'PHYSICS_UNSPECIFIED', message: '物理层缺少重量、接触或惯性描述。' })
  }
  if (!shot.firstFrame.trim()) issues.push({ code: 'FIRST_FRAME_EMPTY', message: '首帧不能为空。' })
  return issues
}

export function parseDirectorStageOutput(stage: 'acting', value: unknown): ActingStageOutput
export function parseDirectorStageOutput(stage: 'lira', value: unknown): LiraStageOutput
export function parseDirectorStageOutput(stage: 'cinedance', value: unknown): CinedanceStageOutput
export function parseDirectorStageOutput(stage: DirectorEditableStage, value: unknown): ActingStageOutput | LiraStageOutput | CinedanceStageOutput
export function parseDirectorStageOutput(stage: DirectorEditableStage, value: unknown) {
  return stageOutputSchemas[stage].parse(normalizeDirectorStageEnvelope(stage, value))
}

function normalizeDirectorStageEnvelope(stage: DirectorEditableStage, value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1) return normalizeDirectorStageEnvelope(stage, value[0])
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const stageKey = stage === 'acting' ? 'characterProfiles' : stage === 'lira' ? 'keyframes' : 'shots'
  if (stageKey in record) return record
  for (const key of ['result', 'output', 'data', stage]) {
    if (record[key] !== undefined) {
      const candidate = normalizeDirectorStageEnvelope(stage, record[key])
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && stageKey in candidate) {
        return candidate
      }
    }
  }
  return value
}

const directorFieldLabels: Record<string, string> = {
  summary: '阶段摘要',
  characterProfiles: '角色表演档案',
  voiceProfiles: '声音档案',
  shotPerformances: '镜头表演节拍',
  characterStates: '角色状态资产',
  locations: '场景资产',
  props: '道具资产',
  keyframes: '关键帧',
  shots: '动态镜头',
}

export function readableDirectorStageError(error: unknown) {
  if (error instanceof z.ZodError) {
    const fields = [...new Set(error.issues.map((issue) => (
      directorFieldLabels[String(issue.path[0])] || '阶段结果'
    )))]
    return `AI 返回的${fields.slice(0, 3).join('、')}结构不完整，系统没有保存这份异常结果。请点击“重新生成”，系统会按正确格式重新整理。`
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid_type[\s\S]*Expected object[\s\S]*received string/iu.test(message)) {
    return 'AI 返回的角色表演档案结构不完整，系统没有保存这份异常结果。请点击“重新生成”，系统会按正确格式重新整理。'
  }
  if (/invalid_type|too_small|too_big|invalid_enum_value|Expected object|Expected array/iu.test(message)) {
    return 'AI 返回的阶段结果结构不完整，系统没有保存这份异常结果。请点击“重新生成”，系统会按正确格式重新整理。'
  }
  if (/JSON|Unexpected token|invalid json/iu.test(message)) {
    return 'AI 返回的阶段结果不是完整 JSON，系统没有保存异常内容。请点击“重新生成”再试一次。'
  }
  if (/timeout|timed out|超时/iu.test(message)) {
    return 'AI 整理阶段结果超时，本次没有保存不完整内容。请点击“重新生成”再试一次。'
  }
  return message.slice(0, 8000) || '本阶段生成失败，请重新生成。'
}

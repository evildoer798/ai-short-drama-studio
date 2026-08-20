import {
  AssetType,
  GenerationTaskType,
  Prisma,
  TaskStatus,
  VisualStyle,
} from '@prisma/client'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import {
  extractJsonValue,
  generateTextViaOpenAICompat,
  type GenerateTextInput,
} from '@/lib/openai-text'
import {
  buildAssetCurationPrompt,
  buildAssetInventoryPrompt,
  buildAssetSelectionPrompt,
  buildSingleAssetPrompt,
  buildDialogueRepairPrompt,
  buildCharacterNameAuditPrompt,
  buildEpisodeDraftPrompt,
  buildEpisodePlanPrompt,
  buildEpisodeQualityRepairPrompt,
  buildEpisodeRevisionPrompt,
  buildNovelChunkAnalysisPrompt,
  buildSeriesBibleMergePrompt,
  buildSeriesBiblePrompt,
  buildMissingDialogueShotsPrompt,
  buildStoryboardAtomicRepairPrompt,
  buildStoryboardFinalRepairPrompt,
  buildStoryboardFinalReviewPrompt,
  buildStoryboardGenerationPrompt,
  type StoryboardFinalReviewPromptIssue,
  dialogueMissing,
  canonicalizeScriptCharacterNames,
  enforceAssetPrompt,
  extractScriptDialogueLines,
  extractScriptSceneLocations,
  extractSourceDialogues,
  isStoryboardVoiceover,
  novelAnalysisSystem,
  sanitizeNovelEvidenceForTextPrompt,
  splitNovelIntoChunks,
  STORYBOARD_SYSTEM_PROMPT,
} from '@/lib/preproduction-prompts'
import {
  requireEpisodesStoryboarded,
  requireLockedEpisodes,
} from '@/lib/preproduction'
import {
  auditScriptEpisodes,
  endingHookIssue,
  episodeLengthBounds,
  firstEpisodeColdOpenIssue,
  isSuspiciousTextReuse,
  removeRepeatedOpeningFromLaterEpisode,
  SCRIPT_COLD_OPEN_START,
  SCRIPT_MAIN_TIMELINE_START,
  scriptAuditPassed,
  scriptCharacterCount,
  scriptQualityAuditScore,
  scriptQualityAuditWarnings,
  textReuseMetrics,
} from '@/lib/script-quality'
import { parseCompletedScreenplay } from '@/lib/screenplay-import'
import {
  calculateSceneConsistency,
  storyboardLocationNames,
  storyboardPromptSection,
  storyboardTimeLocation,
} from '@/lib/scene-consistency'
import {
  conciseStoryboardSceneFacts,
  conciseStoryboardSceneSection,
  storyboardSceneHasDynamicContent,
} from '@/lib/storyboard-scene'
import {
  buildNaturalStoryboardPrompt,
  matchStoryboardAssets,
  syncStoryboardAssetLinks,
} from '@/lib/storyboards'
import {
  orderedTextApiKeyIndexes,
  textStoryboardParallelism,
} from '@/lib/text-api-pool'
import { textProviderLabel, type TextProviderLabel } from '@/lib/text-provider-label'
import { buildStyleLock } from '@/lib/visual-styles'
import {
  inferStoryboardContinuityState,
  storyboardContinuityStateIssues,
  type ContinuityTransitionType,
} from '@/lib/storyboard-continuity'
import {
  fuseStoryboardTimelineDetails,
  storyboardTimelineDetailIssues,
} from '@/lib/storyboard-timeline'
import {
  repairExactFinalStoryboardDialogueDuplicates,
  type FinalStoryboardDialogueDocument,
} from '@/lib/storyboard-dialogue-validation'
import { createStoryboardRevision } from '@/lib/storyboard-revisions'
import { recordTextUsageFromContext } from '@/lib/billing-context'

const episodePlanSchema = z.object({
  episodes: z.array(z.object({
    episodeNumber: z.coerce.number().int().positive(),
    title: z.string().trim().min(1).max(120),
    logline: z.string().trim().min(1).max(3000),
    sourceChunks: z.array(z.coerce.number().int().positive()).min(1),
    contentGoals: z.array(z.string().trim().min(1)).default([]),
    openingContinuity: z.string().trim().max(3000).default(''),
    endingContinuity: z.string().trim().max(3000).default(''),
  })).min(1),
})

const episodeDraftSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  logline: z.string().trim().max(3000).optional(),
  content: z.string().trim().min(1),
})

const adaptationDraftCheckpointSchema = z.object({
  episodeNumber: z.number().int().positive(),
  title: z.string().min(1),
  logline: z.string(),
  content: z.string().min(1),
  sourceChunkIndexes: z.array(z.number().int().positive()),
  dialogueAuditMissing: z.number().int().nonnegative(),
})

const seriesBibleSchema = z.object({
  characters: z.array(z.object({
    canonicalName: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
    identity: z.string().trim().min(1).max(3000),
    relationships: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  })).max(300).default([]),
  continuityRules: z.array(z.string().trim().min(1).max(3000)).max(200).default([]),
})

const characterNameAuditSchema = z.object({
  mappings: z.array(z.object({
    observedName: z.string().trim().min(1).max(120),
    canonicalName: z.string().trim().min(1).max(120),
    reason: z.string().trim().max(1000).optional().default(''),
  })).max(300).default([]),
})

const adaptationCheckpointSchema = z.object({
  sourceFingerprint: z.string().min(1),
  analyses: z.array(z.object({ index: z.number().int().positive(), analysis: z.string().min(1) })).default([]),
  seriesBibleParts: z.array(z.object({
    index: z.number().int().nonnegative(),
    sourceChunkIndexes: z.array(z.number().int().positive()).min(1),
    bible: seriesBibleSchema,
  })).default([]),
  seriesBible: seriesBibleSchema.optional(),
  plan: episodePlanSchema.shape.episodes.optional(),
  drafts: z.array(adaptationDraftCheckpointSchema).default([]),
  nameMappings: z.array(z.object({
    observedName: z.string().min(1),
    canonicalName: z.string().min(1),
  })).default([]),
  nameAuditCompleted: z.boolean().default(false),
  qualityRepairCount: z.number().int().nonnegative().default(0),
  qualityAuditScore: z.number().int().nonnegative().default(0),
  qualityAuditWarnings: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
})

type ScriptQualityProgress = {
  phase: 'reviewing' | 'repairing' | 'verifying' | 'finalizing'
  completedEpisodes: number
  totalEpisodes: number
  completedSegments: number
  totalSegments: number
  activeEpisodeNumbers: number[]
  activeRoutes: []
  parallelism: number
  segmentParallelism: number
  reviewRound: number
  maximumReviewRounds: number
  modifiedShots: number
  remainingIssues: number
  fatalIssues: number
  warning?: string
}

const assetInventoryItemSchema = z.object({
  type: z.nativeEnum(AssetType),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(12000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
})

const assetInventorySchema = z.object({
  assets: z.array(assetInventoryItemSchema).default([]),
})

export function assetInventorySchemaForType(type: AssetType) {
  return z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    if (!Array.isArray(record.assets)) return value
    return {
      ...record,
      assets: record.assets.map((asset) => (
        asset && typeof asset === 'object' && !Array.isArray(asset)
          ? { ...asset as Record<string, unknown>, type }
          : asset
      )),
    }
  }, assetInventorySchema)
}

const assetPromptResultSchema = z.object({
  description: z.string().trim().min(1).max(12000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  prompt: z.string().trim().min(1).max(30000),
})

const assetSelectionSchema = z.object({
  selectedNames: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
})

const generatedAssetItemSchema = assetInventoryItemSchema.extend({
  prompt: z.string().trim().min(1).max(30000),
})

const assetExtractionCheckpointSchema = z.object({
  sourceFingerprint: z.string().min(1),
  inventories: z.array(z.object({
    episodeId: z.string().min(1),
    type: z.nativeEnum(AssetType),
    assets: z.array(assetInventoryItemSchema),
  })).default([]),
  curations: z.array(z.object({
    key: z.string().min(1),
    assets: z.array(assetInventoryItemSchema),
  })).default([]),
  selections: z.array(z.object({
    type: z.nativeEnum(AssetType),
    selectedNames: z.array(z.string().min(1).max(120)),
  })).default([]),
  prompts: z.array(z.object({
    key: z.string().min(1),
    asset: generatedAssetItemSchema,
  })).default([]),
})

const generatedStoryboardSchema = z.object({
  storyboards: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    notes: z.string().trim().max(8000).optional().default(''),
    imagePrompt: z.string().trim().max(16000).optional().default(''),
    videoPrompt: z.string().trim().min(1).max(40000),
    duration: z.coerce.number().int().min(4).max(15).catch(8),
    aspectRatio: z.enum(['16:9', '9:16']).catch('16:9'),
    generateAudio: z.boolean().catch(true),
  })).min(1),
})

const SCRIPT_ADAPTATION_PIPELINE_VERSION = 'series-bible-quality-audit-v3'
const STORYBOARD_SEGMENT_SHOT_LIMIT = 40
const STORYBOARD_REVIEW_SHOT_LIMIT = 120
const STORYBOARD_REVIEW_ISSUE_LIMIT = 240

const compactStoryboardDetail = (max: number) => z.string().trim().optional().default('')
  .transform((value) => value.slice(0, max))
const compactStoryboardDefault = (max: number, fallback: string) => z.string().trim().optional().default(fallback)
  .transform((value) => (value || fallback).slice(0, max))

const compactStoryboardShotSchema = z.object({
  t: compactStoryboardDefault(120, '剧情原子镜头'),
  n: compactStoryboardDefault(1200, '时间地点承接当前剧本场次'),
  i: compactStoryboardDetail(900),
  p: compactStoryboardDetail(2500),
  h: compactStoryboardDetail(3000),
  r: compactStoryboardDetail(2200),
  e: compactStoryboardDetail(2800),
  l: compactStoryboardDetail(1800),
  c: compactStoryboardDefault(1600, '中景固定机位'),
  f: compactStoryboardDetail(2800),
  s: compactStoryboardDetail(4500),
  m: compactStoryboardDetail(3600),
  v: compactStoryboardDefault(14000, '人物按剧本完成本镜动作，神态随剧情触发产生自然变化。'),
  a: compactStoryboardDefault(5000, '无对白'),
  q: compactStoryboardDetail(2400),
  o: compactStoryboardDetail(2400),
  g: compactStoryboardDetail(2800),
  x: compactStoryboardDetail(2200),
  z: compactStoryboardDetail(3200),
  d: z.coerce.number().int().min(3).max(15).catch(8),
})

const compactStoryboardSchema = z.object({
  shots: z.array(compactStoryboardShotSchema).min(1).max(STORYBOARD_SEGMENT_SHOT_LIMIT),
})

const compactStoryboardAllowEmptySchema = z.object({
  shots: z.array(compactStoryboardShotSchema).max(STORYBOARD_SEGMENT_SHOT_LIMIT).default([]),
})

const storyboardDialogueTranslationSchema = z.object({
  translations: z.array(z.object({
    shotNumber: z.coerce.number().int().min(1).max(STORYBOARD_SEGMENT_SHOT_LIMIT),
    a: z.string().trim().min(1).max(5000),
  })).min(1).max(STORYBOARD_SEGMENT_SHOT_LIMIT),
})

export type StoryboardFinalReviewIssue = StoryboardFinalReviewPromptIssue

type StoryboardFinalReviewReport = {
  passed: boolean
  issues: StoryboardFinalReviewIssue[]
}

const storyboardFinalReviewCategories = [
  'plot',
  'dialogue',
  'character',
  'scene',
  'continuity',
  'duration',
  'prompt_conflict',
  'directing',
] as const

function finalReviewCategory(value: unknown, problem: string): StoryboardFinalReviewIssue['category'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((storyboardFinalReviewCategories as readonly string[]).includes(normalized)) {
    return normalized as StoryboardFinalReviewIssue['category']
  }
  if (/对白|台词|说话人|speaker|dialogue/iu.test(problem)) return 'dialogue'
  if (/人物|身份|角色|分身|换人|character/iu.test(problem)) return 'character'
  if (/场景|地点|白名单|scene|location/iu.test(problem)) return 'scene'
  if (/时长|秒|快读|duration/iu.test(problem)) return 'duration'
  if (/连续|站位|朝向|接触|道具|不可逆|尾帧|continuity/iu.test(problem)) return 'continuity'
  if (/景别|构图|机位|情绪视点|反应|导演|camera|framing/iu.test(problem)) return 'directing'
  if (/矛盾|冲突|提示词|prompt/iu.test(problem)) return 'prompt_conflict'
  return 'plot'
}

function normalizeStoryboardFinalReviewIssue(value: unknown): StoryboardFinalReviewIssue | null {
  if (typeof value === 'string') {
    const problem = value.replace(/\s+/g, ' ').trim().slice(0, 800)
    if (!problem) return null
    const category = finalReviewCategory(undefined, problem)
    return {
      severity: category === 'directing' ? 'warning' : 'fatal',
      category,
      shotNumbers: [],
      scriptEvidence: '',
      problem,
      repairInstruction: problem,
    }
  }
  const issue = finalReviewRecord(value)
  if (!issue) return null
  const problem = String(issue.problem ?? issue.issue ?? issue.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 800)
  if (!problem) return null
  const category = finalReviewCategory(issue.category ?? issue.type, problem)
  const requestedWarning = String(issue.severity ?? issue.level ?? '').trim().toLowerCase() === 'warning'
  const containsFatalFacts = /剧情|对白|台词|说话人|人物|身份|角色|场景|地点|错序|时序|无过程换位|状态复原|站位|朝向|接触|道具|不可逆|尾帧|时长|快读|矛盾|冲突|plot|dialogue|speaker|character|scene|location|continuity|duration|prompt/iu.test(problem)
  const rawShotNumbers = issue.shotNumbers ?? issue.shots ?? issue.shotNumber
  return {
    severity: category === 'directing' && requestedWarning && !containsFatalFacts ? 'warning' : 'fatal',
    category,
    shotNumbers: finalReviewIntegerList(Array.isArray(rawShotNumbers) ? rawShotNumbers : [rawShotNumbers], 1),
    scriptEvidence: String(issue.scriptEvidence ?? issue.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    problem,
    repairInstruction: String(issue.repairInstruction ?? issue.fix ?? issue.suggestion ?? problem)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200),
  }
}

export function normalizeStoryboardFinalReviewReport(value: unknown): StoryboardFinalReviewReport {
  const record = finalReviewRecord(value)
  const rawIssues = Array.isArray(record?.issues)
    ? record.issues
    : Array.isArray(value) ? value : []
  const issues = rawIssues
    .map(normalizeStoryboardFinalReviewIssue)
    .filter((issue): issue is StoryboardFinalReviewIssue => Boolean(issue))
    .slice(0, STORYBOARD_REVIEW_ISSUE_LIMIT)
  return {
    passed: record?.passed === true && issues.length === 0,
    issues,
  }
}

const storyboardFinalReviewReportSchema = z.unknown().transform(normalizeStoryboardFinalReviewReport)

type StoryboardFinalReviewPatch = {
  passed: boolean
  issues: string[]
  order: number[]
  remove: number[]
  replacements: Array<{ shotNumber: number; shot: Record<string, unknown> }>
  insertions: Array<{ afterShotNumber: number; shot: Record<string, unknown> }>
  replaceAll?: boolean
}

function finalReviewRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finalReviewInteger(value: unknown, minimum: number) {
  const number = Number(value)
  return Number.isInteger(number) && number >= minimum && number <= STORYBOARD_REVIEW_SHOT_LIMIT ? number : null
}

function finalReviewIntegerList(value: unknown, minimum: number) {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => {
        const number = finalReviewInteger(item, minimum)
        return number === null ? [] : [number]
      }))]
    : []
}

export function normalizeStoryboardFinalReviewPatch(value: unknown): StoryboardFinalReviewPatch {
  const empty = (): StoryboardFinalReviewPatch => ({
    passed: false,
    issues: [],
    order: [],
    remove: [],
    replacements: [],
    insertions: [],
    replaceAll: false,
  })
  if (Array.isArray(value)) {
    const records = value.map(finalReviewRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    const fullShots = records.filter((item) => 't' in item || 'a' in item || 'n' in item)
    if (fullShots.length === value.length && fullShots.length > 0) {
      return {
        ...empty(),
        passed: true,
        replacements: fullShots.slice(0, STORYBOARD_REVIEW_SHOT_LIMIT).map((shot, index) => ({ shotNumber: index + 1, shot })),
        replaceAll: true,
      }
    }
    const replacements = records.flatMap((item) => {
      const shotNumber = finalReviewInteger(item.shotNumber ?? item.shotIndex ?? item.index, 1)
      const shot = finalReviewRecord(item.shot ?? item.replacement ?? item.patch)
      return shotNumber && shot ? [{ shotNumber, shot }] : []
    })
    const issues = value.flatMap((item) => {
      if (typeof item === 'string') return [item.slice(0, 500)]
      const record = finalReviewRecord(item)
      const message = record && typeof (record.issue ?? record.message ?? record.problem) === 'string'
        ? String(record.issue ?? record.message ?? record.problem).slice(0, 500)
        : ''
      return message ? [message] : []
    })
    return { ...empty(), passed: replacements.length > 0 && issues.length === 0, replacements, issues }
  }

  const record = finalReviewRecord(value)
  if (!record) return empty()
  const issues = Array.isArray(record.issues)
    ? record.issues.flatMap((item) => {
        if (typeof item === 'string') return [item.slice(0, 500)]
        const issue = finalReviewRecord(item)
        const message = issue && typeof (issue.issue ?? issue.message ?? issue.problem) === 'string'
          ? String(issue.issue ?? issue.message ?? issue.problem).slice(0, 500)
          : ''
        return message ? [message] : []
      }).slice(0, 24)
    : []
  const sourceReplacements = Array.isArray(record.replacements)
    ? record.replacements
    : Array.isArray(record.shots) ? record.shots : []
  const replaceAll = Array.isArray(record.shots)
    && record.shots.length > 0
    && record.shots.every((item) => {
      const shot = finalReviewRecord(item)
      return Boolean(shot && ('t' in shot || 'a' in shot || 'n' in shot))
    })
  const replacements = sourceReplacements.flatMap((item, index) => {
    const replacement = finalReviewRecord(item)
    if (!replacement) return []
    const nestedShot = finalReviewRecord(replacement.shot ?? replacement.replacement ?? replacement.patch)
    const shot = nestedShot || replacement
    const shotNumber = finalReviewInteger(
      replacement.shotNumber ?? replacement.shotIndex ?? replacement.index ?? (Array.isArray(record.shots) ? index + 1 : null),
      1,
    )
    return shotNumber ? [{ shotNumber, shot }] : []
  }).slice(0, STORYBOARD_REVIEW_SHOT_LIMIT)
  const insertions = (Array.isArray(record.insertions) ? record.insertions : []).flatMap((item) => {
    const insertion = finalReviewRecord(item)
    if (!insertion) return []
    const afterShotNumber = finalReviewInteger(
      insertion.afterShotNumber ?? insertion.afterIndex ?? insertion.after,
      0,
    )
    const shot = finalReviewRecord(insertion.shot ?? insertion.insertion ?? insertion.patch)
    return afterShotNumber !== null && shot ? [{ afterShotNumber, shot }] : []
  }).slice(0, 32)
  return {
    passed: record.passed === true || record.pass === true || (replaceAll && issues.length === 0),
    issues,
    order: finalReviewIntegerList(record.order, 1),
    remove: finalReviewIntegerList(record.remove ?? record.removed, 1),
    replacements,
    insertions,
    replaceAll,
  }
}

const storyboardFinalReviewPatchSchema = z.unknown().transform(normalizeStoryboardFinalReviewPatch)

const storyboardFinalReviewIssueSchema = z.object({
  severity: z.enum(['fatal', 'warning']),
  category: z.enum(storyboardFinalReviewCategories),
  shotNumbers: z.array(z.number().int().min(1).max(STORYBOARD_REVIEW_SHOT_LIMIT))
    .max(STORYBOARD_REVIEW_SHOT_LIMIT)
    .default([]),
  scriptEvidence: z.string().max(1200).default(''),
  problem: z.string().min(1).max(800),
  repairInstruction: z.string().min(1).max(1200),
})

const storyboardEpisodeReviewCheckpointSchema = z.object({
  episodeId: z.string().min(1),
  stage: z.enum(['reviewed', 'repaired', 'verified']),
  round: z.number().int().min(0).max(3),
  noChangeAttempts: z.number().int().nonnegative().max(20).default(0),
  modifiedShots: z.number().int().nonnegative().default(0),
  currentShots: z.array(compactStoryboardShotSchema).min(1).max(STORYBOARD_REVIEW_SHOT_LIMIT),
  currentIssues: z.array(storyboardFinalReviewIssueSchema).max(STORYBOARD_REVIEW_ISSUE_LIMIT).default([]),
  bestShots: z.array(compactStoryboardShotSchema).min(1).max(STORYBOARD_REVIEW_SHOT_LIMIT),
  bestIssues: z.array(storyboardFinalReviewIssueSchema).max(STORYBOARD_REVIEW_ISSUE_LIMIT).default([]),
})

const storyboardCheckpointV5Schema = z.object({
  version: z.literal(5),
  sourceFingerprint: z.string().min(1),
  completedEpisodeIds: z.array(z.string().min(1)).default([]),
  segments: z.array(z.object({
    episodeId: z.string().min(1),
    segmentIndex: z.number().int().nonnegative(),
    shots: z.array(compactStoryboardShotSchema).min(1).max(STORYBOARD_SEGMENT_SHOT_LIMIT),
  })).default([]),
})

const storyboardCheckpointSchema = z.object({
  version: z.literal(6),
  sourceFingerprint: z.string().min(1),
  completedEpisodeIds: z.array(z.string().min(1)).default([]),
  segments: z.array(z.object({
    episodeId: z.string().min(1),
    segmentIndex: z.number().int().nonnegative(),
    shots: z.array(compactStoryboardShotSchema).min(1).max(STORYBOARD_SEGMENT_SHOT_LIMIT),
  })).default([]),
  episodeReviews: z.array(storyboardEpisodeReviewCheckpointSchema).default([]),
})

export function restoreStoryboardCheckpoint(value: unknown, sourceFingerprint: string) {
  const current = storyboardCheckpointSchema.safeParse(value)
  if (current.success && current.data.sourceFingerprint === sourceFingerprint) return current.data
  const legacy = storyboardCheckpointV5Schema.safeParse(value)
  if (legacy.success && legacy.data.sourceFingerprint === sourceFingerprint) {
    return {
      version: 6 as const,
      sourceFingerprint,
      completedEpisodeIds: legacy.data.completedEpisodeIds,
      segments: legacy.data.segments,
      episodeReviews: [],
    }
  }
  return {
    version: 6 as const,
    sourceFingerprint,
    completedEpisodeIds: [],
    segments: [],
    episodeReviews: [],
  }
}

type TaskPayload = Record<string, unknown>

function payloadRecord(payload: Prisma.JsonValue | null): TaskPayload {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as TaskPayload
    : {}
}

export function storyboardRequestedEpisodeIds(payload: TaskPayload) {
  if (!Array.isArray(payload.episodeIds)) return undefined
  const episodeIds = payload.episodeIds.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  return episodeIds.length > 0 ? [...new Set(episodeIds)] : undefined
}

export type StoryboardTextRouteProvider = 'primary' | 'fallback' | 'tertiary'

export type StoryboardTextRoute = {
  provider: StoryboardTextRouteProvider
  primaryKeyIndex: number
  fallbackKeyIndex: number
  tertiaryKeyIndex: number
  allowPrimary: boolean
  allowFallback: boolean
  allowTertiary: boolean
  maxAttempts: 1
  timeoutMs: number
}

export function storyboardTextRoutePlan(input: {
  primaryKeyCount: number
  fallbackKeyCount: number
  tertiaryKeyCount: number
  preferredPrimaryIndex?: number
  preferredFallbackIndex?: number
  preferredTertiaryIndex?: number
}) {
  const primaryCount = Math.max(0, Math.round(input.primaryKeyCount))
  const fallbackCount = Math.max(0, Math.round(input.fallbackKeyCount))
  const primaryIndex = primaryCount > 0
    ? orderedTextApiKeyIndexes(primaryCount, input.preferredPrimaryIndex || 0)[0]
    : 0
  const fallbackOrder = fallbackCount > 0
    ? orderedTextApiKeyIndexes(fallbackCount, input.preferredFallbackIndex || 0)
    : []
  const tertiaryCount = Math.max(0, Math.round(input.tertiaryKeyCount))
  const tertiaryOrder = tertiaryCount > 0
    ? orderedTextApiKeyIndexes(tertiaryCount, input.preferredTertiaryIndex || 0)
    : []
  const routes: StoryboardTextRoute[] = []
  const add = (provider: StoryboardTextRouteProvider, keyIndex: number, timeoutMs: number) => {
    routes.push({
      provider,
      primaryKeyIndex: provider === 'primary' ? keyIndex : 0,
      fallbackKeyIndex: provider === 'fallback' ? keyIndex : 0,
      tertiaryKeyIndex: provider === 'tertiary' ? keyIndex : 0,
      allowPrimary: provider === 'primary',
      allowFallback: provider === 'fallback',
      allowTertiary: provider === 'tertiary',
      maxAttempts: 1,
      timeoutMs,
    })
  }

  if (primaryCount > 0) add('primary', primaryIndex, 60_000)
  if (fallbackOrder.length > 0) add('fallback', fallbackOrder[0], 75_000)
  if (primaryCount > 0) add('primary', primaryIndex, 60_000)
  if (tertiaryOrder.length > 0) add('tertiary', tertiaryOrder[0], 60_000)
  if (tertiaryOrder.length > 1) add('tertiary', tertiaryOrder[1], 60_000)
  return routes
}

export function storyboardRouteFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|timed?\s*out|aborted|TEXT_API_FAILED:\s*504/i.test(message)) return '上一线路读取超时'
  if (/TEXT_API_FAILED:\s*429/i.test(message)) return '上一线路触发限流'
  if (/TEXT_API_FAILED:\s*(502|503)/i.test(message)) return '上一线路服务暂时不可用'
  if (/content moderation|content policy|prompt or reference material was rejected/i.test(message)) return '上一线路触发内容审核'
  if (/遗漏\s*\d+\s*句对白|对白.*遗漏/i.test(message)) return '上一结果未通过对白完整性检查'
  if (/JSON|Zod|invalid_type|too_small|too_big|expected/i.test(message)) return '上一结果格式未通过校验'
  return '上一结果未通过分镜质量检查'
}

async function updateProgress(taskId: string, progress: number) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: { progress: Math.max(0, Math.min(99, Math.round(progress))) },
  })
}

function batchesOf<T>(items: T[], size: number) {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += Math.max(1, size)) {
    batches.push(items.slice(index, index + Math.max(1, size)))
  }
  return batches
}

type TextCallInput = {
  system: string
  prompt: string
  mode?: 'auto' | 'chat_completions' | 'responses'
  maxOutputTokens?: number
  temperature?: number
  reasoningEffort?: string | null
  responseFormat?: 'json_object'
  disableThinking?: boolean
  timeoutMs?: number
  maxAttempts?: number
}

type TextProviderName = 'primary' | 'fallback' | 'tertiary'
type StructuredTextMode = 'responses' | 'chat_completions'

const textKeyCursors: Record<TextProviderName, number> = {
  primary: 0,
  fallback: 0,
  tertiary: 0,
}

function nextTextKeyIndex(provider: TextProviderName, keyCount: number) {
  if (keyCount <= 0) return 0
  const index = textKeyCursors[provider] % keyCount
  textKeyCursors[provider] = (index + 1) % keyCount
  return index
}

function textProviderKeys(provider: TextProviderName) {
  if (provider === 'primary') return env.textApiKeys()
  if (provider === 'fallback') return env.textFallbackApiKeys()
  return env.textTertiaryApiKeys()
}

function textProviderConfigured(provider: TextProviderName) {
  if (provider === 'primary') return Boolean(env.textApiBaseUrl() && textProviderKeys(provider).length > 0)
  if (env.textPrimaryOnly()) return false
  if (provider === 'fallback') return Boolean(env.textFallbackApiBaseUrl() && textProviderKeys(provider).length > 0)
  return Boolean(env.textTertiaryApiBaseUrl() && textProviderKeys(provider).length > 0)
}

function textFallbackConfigured() {
  return textProviderConfigured('fallback')
}

function textTertiaryConfigured() {
  return textProviderConfigured('tertiary')
}

function configuredTextMode(provider: TextProviderName) {
  if (provider === 'primary') return env.textApiMode()
  if (provider === 'fallback') return env.textFallbackApiMode()
  return env.textTertiaryApiMode()
}

function textModeOrder(provider: TextProviderName): StructuredTextMode[] {
  const configured = configuredTextMode(provider)
  if (configured === 'chat_completions') return ['chat_completions', 'chat_completions']
  if (configured === 'responses') return ['responses', 'responses']
  return ['chat_completions', 'responses']
}

function textProviderRequest(
  input: TextCallInput,
  provider: TextProviderName,
  mode?: 'auto' | 'chat_completions' | 'responses',
  apiKeyOverride?: string,
): GenerateTextInput {
  if (!textProviderConfigured(provider)) throw new Error(`TEXT_${provider.toUpperCase()}_NOT_CONFIGURED`)
  const baseUrl = provider === 'primary'
    ? env.textApiBaseUrl()
    : provider === 'fallback' ? env.textFallbackApiBaseUrl() : env.textTertiaryApiBaseUrl()
  const model = provider === 'primary'
    ? env.textModel()
    : provider === 'fallback' ? env.textFallbackModel() : env.textTertiaryModel()
  const configuredReasoningEffort = provider === 'primary'
    ? env.textReasoningEffort()
    : provider === 'fallback' ? env.textFallbackReasoningEffort() : env.textTertiaryReasoningEffort()
  return {
    baseUrl,
    apiKey: apiKeyOverride || textProviderKeys(provider)[0],
    model,
    onUsage: async (usage) => { await recordTextUsageFromContext({ baseUrl, model, usage }) },
    mode: mode || input.mode || configuredTextMode(provider),
    system: input.system,
    prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    responseFormat: input.responseFormat,
    disableThinking: input.disableThinking ?? textProviderLabel(baseUrl) === 'DeepSeek',
    reasoningEffort: input.reasoningEffort === undefined
      ? configuredReasoningEffort || undefined
      : input.reasoningEffort || undefined,
  }
}

async function callTextProvider(
  input: TextCallInput,
  provider: TextProviderName,
  mode?: 'auto' | 'chat_completions' | 'responses',
  apiKeyOverride?: string,
) {
  return generateTextViaOpenAICompat(textProviderRequest(input, provider, mode, apiKeyOverride))
}

async function callText(input: TextCallInput) {
  const keys = {
    primary: textProviderKeys('primary'),
    fallback: textProviderKeys('fallback'),
    tertiary: textProviderKeys('tertiary'),
  }
  const ordered = {
    primary: orderedTextApiKeyIndexes(keys.primary.length, nextTextKeyIndex('primary', keys.primary.length)),
    fallback: orderedTextApiKeyIndexes(keys.fallback.length, nextTextKeyIndex('fallback', keys.fallback.length)),
    tertiary: keys.tertiary.map((_, index) => index),
  }
  const providerAttempts = (provider: TextProviderName, indexes: number[]) => (
    textProviderConfigured(provider)
      ? indexes.map((index) => ({ provider, apiKey: keys[provider][index] }))
      : []
  )
  const attemptPlan = [
    ...providerAttempts('primary', ordered.primary.slice(0, 2)),
    ...providerAttempts('fallback', ordered.fallback.slice(0, 2)),
    ...providerAttempts('tertiary', ordered.tertiary),
    ...providerAttempts('primary', ordered.primary.slice(2)),
    ...providerAttempts('fallback', ordered.fallback.slice(2)),
  ]
  const defaultAttempts = Math.min(12, attemptPlan.length)
  const attempts = attemptPlan.slice(0, Math.max(1, input.maxAttempts ?? defaultAttempts))
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      return await callTextProvider({ ...input, maxAttempts: 1 }, attempt.provider, undefined, attempt.apiKey)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function parseWithSchema<TSchema extends z.ZodTypeAny>(text: string, schema: TSchema): z.output<TSchema> {
  const value = extractJsonValue(text)
  return schema.parse(value)
}

function nonRetryableTextApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /TEXT_API_FAILED:\s*(401|402|403)/i.test(message)
}

async function waitForTextRetry(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function callStructuredText<TSchema extends z.ZodTypeAny>(input: {
  system: string
  prompt: string
  schema: TSchema
  maxOutputTokens: number
  timeoutMs?: number
  maxAttempts?: number
  reasoningEffort?: string | null
  primaryKeyIndex?: number
  fallbackKeyIndex?: number
  tertiaryKeyIndex?: number
  allowPrimary?: boolean
  allowFallback?: boolean
  allowTertiary?: boolean
}) {
  const primaryModes = textModeOrder('primary')
  const fallbackModes = textModeOrder('fallback')
  const tertiaryModes = textModeOrder('tertiary')
  const primaryEnabled = input.allowPrimary !== false && textProviderConfigured('primary')
  const fallbackEnabled = input.allowFallback !== false && textFallbackConfigured()
  const tertiaryEnabled = input.allowTertiary !== false && textTertiaryConfigured()
  const primaryKeys = env.textApiKeys()
  const fallbackKeys = env.textFallbackApiKeys()
  const tertiaryKeys = textProviderKeys('tertiary')
  const primaryKeyOrder = orderedTextApiKeyIndexes(
    primaryKeys.length,
    input.primaryKeyIndex ?? nextTextKeyIndex('primary', primaryKeys.length),
  )
  const fallbackKeyOrder = fallbackKeys.length > 0
    ? orderedTextApiKeyIndexes(
        fallbackKeys.length,
        input.fallbackKeyIndex ?? nextTextKeyIndex('fallback', fallbackKeys.length),
      )
    : []
  const tertiaryKeyOrder = tertiaryKeys.length > 0
    ? orderedTextApiKeyIndexes(
        tertiaryKeys.length,
        input.tertiaryKeyIndex ?? nextTextKeyIndex('tertiary', tertiaryKeys.length),
      )
    : []
  const providerAttempts = (
    provider: TextProviderName,
    keys: string[],
    indexes: number[],
    mode: StructuredTextMode,
  ) => indexes.map((keyIndex) => ({
    provider,
    mode,
    apiKey: keys[keyIndex],
  }))
  const attemptPlan: Array<{
    provider: TextProviderName
    mode: StructuredTextMode
    apiKey?: string
  }> = [
    ...(primaryEnabled ? providerAttempts('primary', primaryKeys, primaryKeyOrder.slice(0, 2), primaryModes[0]) : []),
    ...(fallbackEnabled ? providerAttempts('fallback', fallbackKeys, fallbackKeyOrder.slice(0, 2), fallbackModes[0]) : []),
    ...(tertiaryEnabled ? providerAttempts('tertiary', tertiaryKeys, tertiaryKeyOrder.slice(0, 2), tertiaryModes[0]) : []),
    ...(primaryEnabled ? providerAttempts('primary', primaryKeys, primaryKeyOrder.slice(0, 2), primaryModes[1]) : []),
    ...(fallbackEnabled ? providerAttempts('fallback', fallbackKeys, fallbackKeyOrder.slice(0, 2), fallbackModes[1]) : []),
    ...(tertiaryEnabled ? providerAttempts('tertiary', tertiaryKeys, tertiaryKeyOrder.slice(0, 2), tertiaryModes[1]) : []),
    ...(primaryEnabled ? providerAttempts('primary', primaryKeys, primaryKeyOrder.slice(2), primaryModes[0]) : []),
    ...(fallbackEnabled ? providerAttempts('fallback', fallbackKeys, fallbackKeyOrder.slice(2), fallbackModes[0]) : []),
    ...(tertiaryEnabled ? providerAttempts('tertiary', tertiaryKeys, tertiaryKeyOrder.slice(2), tertiaryModes[0]) : []),
  ]
  const defaultAttempts = Math.min(16, attemptPlan.length)
  const attempts = attemptPlan.slice(0, Math.max(1, Math.min(
    attemptPlan.length,
    input.maxAttempts ?? defaultAttempts,
  )))
  const retryDelays = [0, 1_500, 0]
  let lastError: unknown

  for (let index = 0; index < attempts.length; index++) {
    try {
      const attempt = attempts[index]
      const text = await callTextProvider({
        system: input.system,
        prompt: input.prompt,
        maxOutputTokens: input.maxOutputTokens,
        temperature: 0.1,
        reasoningEffort: input.reasoningEffort === undefined ? 'low' : input.reasoningEffort,
        responseFormat: 'json_object',
        timeoutMs: input.timeoutMs ?? 90_000,
        maxAttempts: 1,
      }, attempt.provider, attempt.mode, attempt.apiKey)
      return parseWithSchema(text, input.schema)
    } catch (error) {
      lastError = error
      if (index === attempts.length - 1) throw error
      await waitForTextRetry(retryDelays[index] || 0)
    }
  }

  throw lastError
}

function evenlyPlannedEpisodes(totalChunks: number, targetCount: number) {
  const count = Math.max(1, targetCount)
  return Array.from({ length: count }, (_, index) => {
    const start = Math.min(totalChunks, Math.floor(index * totalChunks / count) + 1)
    const end = Math.min(totalChunks, Math.max(start, Math.ceil((index + 1) * totalChunks / count)))
    return {
      episodeNumber: index + 1,
      title: `第 ${index + 1} 集`,
      logline: '按原著顺序推进本集剧情',
      sourceChunks: Array.from({ length: end - start + 1 }, (__, offset) => start + offset),
      contentGoals: [] as string[],
      openingContinuity: index === 0 ? '从原著开篇状态开始' : '承接上一集结尾的人物位置、情绪与未完成动作',
      endingContinuity: index === count - 1 ? '按原著完成本阶段收束' : '停在当前剧情节点，将未完成动作与悬念交给下一集',
    }
  })
}

function splitSourceForEpisodes(content: string, targetCount: number) {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  const chapterAligned = lines.length >= targetCount && lines.length <= targetCount * 2

  if (chapterAligned) {
    return {
      chapterAligned,
      chunks: Array.from({ length: targetCount }, (_, index) => {
        const start = Math.floor(index * lines.length / targetCount)
        const end = Math.floor((index + 1) * lines.length / targetCount)
        return { index: index + 1, content: lines.slice(start, end).join('\n') }
      }),
    }
  }

  const chunkSize = Math.max(1800, Math.ceil(normalized.length / targetCount))
  const naturalChunks = splitNovelIntoChunks(normalized, chunkSize)
  if (naturalChunks.length === targetCount) return { chapterAligned: false, chunks: naturalChunks }

  return {
    chapterAligned: false,
    chunks: Array.from({ length: targetCount }, (_, index) => {
      const start = Math.floor(index * normalized.length / targetCount)
      const end = Math.floor((index + 1) * normalized.length / targetCount)
      return { index: index + 1, content: normalized.slice(start, end).trim() }
    }).filter((chunk) => chunk.content),
  }
}

function localContinuityNotes(chunks: Array<{ index: number; content: string }>, index: number) {
  return [
    `本集只拥有原文片段 ${index} 的改编权，不得取用其他片段中的事件、对白或揭示。`,
    index > 1
      ? '开场只承接上一集留下的人物状态与未完成悬念，不得复述或复演上一集内容。'
      : '本集为主时间线开篇，需快速触发主角核心困境。',
    index < chunks.length
      ? `下一集独占原文片段 ${index + 1}；本集必须在该片段开始前停止，只留下剧情 Hook。`
      : '本集为当前原文收束，仍需用剧情中的最后变化形成结尾 Hook。',
  ].join('\n')
}

function sourceEvidenceExcerpt(content: string, maxChars = 8_000) {
  const normalized = content.trim()
  if (normalized.length <= maxChars) return normalized
  const headLength = Math.ceil(maxChars * 0.65)
  const tailLength = maxChars - headLength
  return `${normalized.slice(0, headLength)}\n\n【中段省略】\n\n${normalized.slice(-tailLength)}`
}

function episodeDraftTokenBudget(episodeMinutes: number) {
  // Keep enough room for valid JSON closure; screenplay length is enforced separately.
  return Math.max(3_400, Math.min(6_000, Math.round(episodeMinutes * 1_800)))
}

function episodeRepairTokenBudget(episodeMinutes: number, issues: string[]) {
  const requiresCompression = issues.some((issue) => /字|时长|过长/u.test(issue))
  return requiresCompression
    ? Math.max(2_500, Math.min(3_200, Math.round(episodeMinutes * 1_700)))
    : episodeDraftTokenBudget(episodeMinutes)
}

const FLASHFORWARD_DRAMA_TERMS = [
  '真相', '秘密', '死亡', '死了', '杀', '血', '枪', '爆炸', '失踪', '背叛',
  '威胁', '绑架', '警察', '逮捕', '破产', '离婚', '婚礼', '怀孕', '复仇',
  '崩溃', '绝望', '救命', '不要', '住手', '滚', '选择', '代价', '最后机会',
]

function flashforwardDramaScore(content: string) {
  let score = Math.min(20, (content.match(/[！？!?]/gu) || []).length)
  for (const term of FLASHFORWARD_DRAMA_TERMS) {
    score += (content.split(term).length - 1) * 4
  }
  score += Math.min(20, extractSourceDialogues(content).length)
  return score
}

function dramaticSourceExcerpt(content: string, maxChars = 1_000) {
  if (content.length <= maxChars) return content
  const positions = FLASHFORWARD_DRAMA_TERMS
    .map((term) => content.indexOf(term))
    .filter((position) => position >= 0)
  const center = positions.length > 0 ? Math.min(...positions) : Math.floor(content.length / 2)
  const start = Math.max(0, Math.min(content.length - maxChars, center - Math.floor(maxChars * 0.4)))
  return content.slice(start, start + maxChars).trim()
}

function buildFlashforwardCandidates(chunks: Array<{ index: number; content: string }>) {
  if (chunks.length <= 1) return ''
  const minimumIndex = Math.max(1, Math.floor(chunks.length * 0.2))
  return chunks
    .slice(minimumIndex)
    .map((chunk) => ({ ...chunk, score: flashforwardDramaScore(chunk.content) }))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, 3)
    .map((chunk) => `--- 后续原文片段 ${chunk.index} 候选 ---\n${sanitizeNovelEvidenceForTextPrompt(dramaticSourceExcerpt(chunk.content))}`)
    .join('\n\n')
}

function mergeSeriesBibleParts(parts: Array<z.output<typeof seriesBibleSchema>>) {
  const characters: z.output<typeof seriesBibleSchema>['characters'] = []
  const continuityRules: string[] = []

  for (const part of parts) {
    for (const character of part.characters) {
      const candidateNames = new Set([character.canonicalName, ...character.aliases])
      const existing = characters.find((item) => {
        const existingNames = new Set([item.canonicalName, ...item.aliases])
        return [...candidateNames].some((name) => existingNames.has(name))
      })
      if (!existing) {
        characters.push({
          canonicalName: character.canonicalName,
          aliases: [...new Set(character.aliases)].filter((name) => name !== character.canonicalName).slice(0, 30),
          identity: character.identity,
          relationships: [...new Set(character.relationships)].slice(0, 30),
        })
        continue
      }

      existing.aliases = [...new Set([
        ...existing.aliases,
        ...(character.canonicalName === existing.canonicalName ? [] : [character.canonicalName]),
        ...character.aliases,
      ])].filter((name) => name !== existing.canonicalName).slice(0, 30)
      existing.identity = [...new Set([existing.identity, character.identity])].join('；').slice(0, 3000)
      existing.relationships = [...new Set([...existing.relationships, ...character.relationships])].slice(0, 30)
    }
    continuityRules.push(...part.continuityRules)
  }

  return {
    characters: characters.slice(0, 300),
    continuityRules: [...new Set(continuityRules)].slice(0, 200),
  }
}

async function saveAdaptationCheckpoint(
  taskId: string,
  payload: TaskPayload,
  checkpoint: z.output<typeof adaptationCheckpointSchema>,
  progress?: ScriptQualityProgress,
) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      payload: {
        ...payload,
        adaptationCheckpoint: checkpoint,
        ...(progress ? { scriptQualityProgress: progress } : {}),
      } as Prisma.InputJsonObject,
    },
  })
}

async function processScriptAdaptation(task: {
  id: string
  projectId: string
  payload: Prisma.JsonValue | null
}) {
  const source = await prisma.novelSource.findUnique({ where: { projectId: task.projectId } })
  if (!source) throw new Error('请先保存小说原文')
  const payload = payloadRecord(task.payload)
  const targetEpisodeCount = Math.max(1, Math.min(60, Number(payload.targetEpisodeCount) || 15))
  const episodeMinutes = Math.max(0.5, Math.min(3, Number(payload.episodeMinutes) || 1.5))
  const completedScreenplay = parseCompletedScreenplay(source.content)
  if (completedScreenplay) {
    const detectedEpisodeCount = completedScreenplay.episodes.length
    if (targetEpisodeCount !== detectedEpisodeCount) {
      throw new Error(
        `COMPLETED_SCREENPLAY_EPISODE_COUNT_MISMATCH: 已识别为 ${detectedEpisodeCount} 集完整分集剧本，`
        + `目标集数必须设置为 ${detectedEpisodeCount}；系统不会把成稿压缩或扩写为 ${targetEpisodeCount} 集。`,
      )
    }

    await updateProgress(task.id, 20)
    let detachedStoryboardCount = 0
    await prisma.$transaction(async (tx) => {
      const importedByNumber = new Map(completedScreenplay.episodes.map((episode) => [
        episode.episodeNumber,
        episode,
      ]))
      const existingEpisodes = await tx.scriptEpisode.findMany({
        where: { projectId: task.projectId },
        select: { id: true, episodeNumber: true, title: true, content: true },
      })
      const changedEpisodeIds = existingEpisodes.flatMap((episode) => {
        const imported = importedByNumber.get(episode.episodeNumber)
        return imported && (imported.title !== episode.title || imported.content !== episode.content)
          ? [episode.id]
          : []
      })
      if (changedEpisodeIds.length > 0) {
        const detached = await tx.storyboard.updateMany({
          where: { episodeId: { in: changedEpisodeIds } },
          data: { episodeId: null, episodeSceneNumber: null },
        })
        detachedStoryboardCount = detached.count
      }

      for (const episode of completedScreenplay.episodes) {
        await tx.scriptEpisode.upsert({
          where: {
            projectId_episodeNumber: {
              projectId: task.projectId,
              episodeNumber: episode.episodeNumber,
            },
          },
          update: {
            title: episode.title,
            logline: null,
            content: episode.content,
            sourceChunkIndexes: [episode.episodeNumber],
            locked: false,
          },
          create: {
            projectId: task.projectId,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            logline: null,
            content: episode.content,
            sourceChunkIndexes: [episode.episodeNumber],
            locked: false,
          },
        })
      }
      await tx.scriptEpisode.deleteMany({
        where: {
          projectId: task.projectId,
          episodeNumber: { notIn: completedScreenplay.episodes.map((episode) => episode.episodeNumber) },
        },
      })
    })
    await updateProgress(task.id, 98)

    return {
      targetEpisodeCount,
      episodeMinutes,
      episodeCount: detectedEpisodeCount,
      directScreenplayImport: true,
      aiRewriteSkipped: true,
      sourcePreserved: true,
      detachedStoryboardCount,
      pipelineVersion: 'completed-screenplay-direct-import-v1',
    }
  }
  const segmentation = splitSourceForEpisodes(source.content, targetEpisodeCount)
  const chunks = segmentation.chunks
  if (chunks.length > 40) {
    throw new Error('小说正文过长，当前版本最多处理约 56 万字；请先按卷拆分后再改编')
  }

  const sourceFingerprint = createHash('sha256')
    .update(`${source.content}\n${targetEpisodeCount}\n${episodeMinutes}\n${segmentation.chapterAligned ? 'chapter' : 'balanced'}\n${SCRIPT_ADAPTATION_PIPELINE_VERSION}`)
    .digest('hex')
  const savedCheckpoint = adaptationCheckpointSchema.safeParse(payload.adaptationCheckpoint)
  const checkpoint = savedCheckpoint.success && savedCheckpoint.data.sourceFingerprint === sourceFingerprint
    ? savedCheckpoint.data
    : {
        sourceFingerprint,
        analyses: [],
        seriesBibleParts: [],
        drafts: [],
        nameMappings: [],
        nameAuditCompleted: false,
        qualityRepairCount: 0,
        qualityAuditScore: 0,
        qualityAuditWarnings: [],
      }
  const analyses: Array<{ index: number; analysis: string }> = [...checkpoint.analyses]
  await updateProgress(task.id, 5)
  if (segmentation.chapterAligned) {
    analyses.splice(0, analyses.length, ...chunks.map((chunk) => ({
      index: chunk.index,
      analysis: localContinuityNotes(chunks, chunk.index),
    })))
    checkpoint.analyses = analyses
    await saveAdaptationCheckpoint(task.id, payload, checkpoint)
    await updateProgress(task.id, 40)
  } else {
    const pendingChunks = chunks.filter((chunk) => !analyses.some((item) => item.index === chunk.index))
    for (const batch of batchesOf(pendingChunks, env.textAnalysisConcurrency())) {
      const settled = await Promise.allSettled(batch.map(async (chunk) => ({
        index: chunk.index,
        analysis: await callText({
          system: novelAnalysisSystem(),
          prompt: buildNovelChunkAnalysisPrompt({
            ...chunk,
            content: sanitizeNovelEvidenceForTextPrompt(chunk.content),
          }, chunks.length),
          maxOutputTokens: 1800,
          temperature: 0.1,
          reasoningEffort: 'low',
        }),
      })))
      const completed = settled.flatMap((result) => (
        result.status === 'fulfilled' ? [result.value] : []
      ))
      analyses.push(...completed)
      analyses.sort((a, b) => a.index - b.index)
      checkpoint.analyses = analyses
      await saveAdaptationCheckpoint(task.id, payload, checkpoint)
      await updateProgress(task.id, 5 + (analyses.length / chunks.length) * 35)
      const failure = settled.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }

  let seriesBible = checkpoint.seriesBible
  if (!seriesBible) {
    const totalSourceChars = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0)
    const shouldPartition = chunks.length > 8 || totalSourceChars > 60_000
    if (shouldPartition) {
      const groups = batchesOf(chunks, 3).map((group, index) => ({ index, chunks: group }))
      const parts = [...checkpoint.seriesBibleParts]
      const pendingGroups = groups.filter((group) => !parts.some((part) => part.index === group.index))

      for (const batch of batchesOf(pendingGroups, env.textAnalysisConcurrency())) {
        const settled = await Promise.allSettled(batch.map(async (group) => ({
          index: group.index,
          sourceChunkIndexes: group.chunks.map((chunk) => chunk.index),
          bible: await callStructuredText({
            system: novelAnalysisSystem(),
            prompt: buildSeriesBiblePrompt({
              analyses: analyses
                .filter((item) => group.chunks.some((chunk) => chunk.index === item.index))
                .map((item) => ({ ...item, analysis: item.analysis.slice(0, 1500) })),
              sourceExcerpts: group.chunks.map((chunk) => ({
                index: chunk.index,
                content: sanitizeNovelEvidenceForTextPrompt(sourceEvidenceExcerpt(chunk.content, 3500)),
              })),
            }),
            schema: seriesBibleSchema,
            maxOutputTokens: 3500,
            timeoutMs: 90_000,
            reasoningEffort: 'low',
          }),
        })))

        let failure: unknown
        for (const result of settled) {
          if (result.status === 'rejected') {
            failure ||= result.reason
            continue
          }
          const existingIndex = parts.findIndex((part) => part.index === result.value.index)
          if (existingIndex >= 0) parts[existingIndex] = result.value
          else parts.push(result.value)
        }
        parts.sort((a, b) => a.index - b.index)
        checkpoint.seriesBibleParts = parts
        await saveAdaptationCheckpoint(task.id, payload, checkpoint)
        await updateProgress(task.id, 40 + (parts.length / groups.length) * 3)
        if (failure) throw failure
      }

      const locallyMerged = mergeSeriesBibleParts(parts.map((part) => part.bible))
      if (locallyMerged.characters.length === 0) {
        throw new Error('未能从小说中建立全剧人物名册，请续跑剧本改编任务')
      }
      await updateProgress(task.id, 44)
      try {
        seriesBible = await callStructuredText({
          system: novelAnalysisSystem(),
          prompt: buildSeriesBibleMergePrompt({ parts }),
          schema: seriesBibleSchema,
          maxOutputTokens: 6000,
          timeoutMs: 60_000,
          maxAttempts: 2,
          reasoningEffort: 'low',
        })
      } catch {
        seriesBible = locallyMerged
      }

      checkpoint.seriesBible = seriesBible
      await saveAdaptationCheckpoint(task.id, payload, checkpoint)
    }
  }
  if (!seriesBible) {
    seriesBible = await callStructuredText({
      system: novelAnalysisSystem(),
      prompt: buildSeriesBiblePrompt({
        analyses: analyses.map((item) => ({ ...item, analysis: item.analysis.slice(0, 3000) })),
        sourceExcerpts: chunks.map((chunk) => ({
          index: chunk.index,
          content: sanitizeNovelEvidenceForTextPrompt(sourceEvidenceExcerpt(chunk.content)),
        })),
      }),
      schema: seriesBibleSchema,
      maxOutputTokens: 6000,
      timeoutMs: 120_000,
    })
    if (seriesBible.characters.length === 0) {
      throw new Error('未能建立全剧人物名册，请续跑剧本改编任务')
    }
    checkpoint.seriesBible = seriesBible
    await saveAdaptationCheckpoint(task.id, payload, checkpoint)
  }
  const canonicalSeriesBible = seriesBible

  let plan: ReturnType<typeof evenlyPlannedEpisodes>
  const sourceOwnershipPlan = evenlyPlannedEpisodes(chunks.length, targetEpisodeCount)
  await updateProgress(task.id, 41)
  await updateProgress(task.id, 42)
  if (checkpoint.plan?.length === targetEpisodeCount) {
    plan = checkpoint.plan
  } else if (segmentation.chapterAligned) {
    plan = sourceOwnershipPlan
  } else try {
    const planText = await callText({
      system: novelAnalysisSystem(),
      prompt: buildEpisodePlanPrompt({
        analyses: analyses.map((item) => ({ ...item, analysis: item.analysis.slice(0, 3000) })),
        targetEpisodeCount,
        episodeMinutes,
        seriesBible: canonicalSeriesBible,
      }),
      maxOutputTokens: 5000,
      temperature: 0.15,
      reasoningEffort: 'low',
    })
    const generatedPlan = episodePlanSchema.parse(extractJsonValue(planText)).episodes
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
      .slice(0, 60)
    const coveredChunks = new Set(generatedPlan.flatMap((episode) => episode.sourceChunks))
    if (generatedPlan.length !== targetEpisodeCount || coveredChunks.size < chunks.length) {
      throw new Error('模型返回的分集规划数量或原文覆盖范围不完整')
    }
    plan = generatedPlan.map((episode, index) => ({
      ...episode,
      episodeNumber: index + 1,
      // Source ownership is deterministic: a chunk can never leak into two episodes.
      sourceChunks: sourceOwnershipPlan[index]?.sourceChunks || [Math.min(chunks.length, index + 1)],
    }))
  } catch {
    plan = sourceOwnershipPlan
  }
  checkpoint.plan = plan
  await saveAdaptationCheckpoint(task.id, payload, checkpoint)
  await updateProgress(task.id, 45)

  const drafts: Array<z.output<typeof adaptationDraftCheckpointSchema>> = [...checkpoint.drafts]
  const flashforwardCandidates = buildFlashforwardCandidates(chunks)

  function episodeSourcePackage(episode: (typeof plan)[number], index: number) {
    const sourceChunkIndexes = [...new Set(episode.sourceChunks)]
      .filter((chunkIndex) => chunkIndex >= 1 && chunkIndex <= chunks.length)
    const selectedIndexes = sourceChunkIndexes.length
      ? sourceChunkIndexes
      : sourceOwnershipPlan[index]?.sourceChunks || [1]
    const selectedChunks = selectedIndexes.map((chunkIndex) => chunks[chunkIndex - 1]).filter(Boolean)
    const completeSourceText = selectedChunks
      .map((chunk) => `【原文片段 ${chunk.index}】\n${chunk.content}`)
      .join('\n\n')
    const promptSafeSourceText = sanitizeNovelEvidenceForTextPrompt(completeSourceText)
    const sourceText = promptSafeSourceText.length <= 30_000
      ? promptSafeSourceText
      : `${promptSafeSourceText.slice(0, 30_000)}\n\n【说明】其余细节以导演事实档案和对白核对表为准。`
    return {
      selectedIndexes,
      completeSourceText,
      sourceText,
      relevantAnalyses: analyses
        .filter((item) => selectedIndexes.includes(item.index))
        .map((item) => `【片段 ${item.index} 档案】\n${item.analysis}`)
        .join('\n\n'),
      sourceDialogues: extractSourceDialogues(promptSafeSourceText),
    }
  }

  function draftQualityIssues(
    draft: z.output<typeof adaptationDraftCheckpointSchema>,
    index: number,
  ) {
    const issues: string[] = []
    const hookIssue = endingHookIssue(draft.content)
    if (hookIssue) issues.push(hookIssue)
    if (index === 0) {
      const coldOpenIssue = firstEpisodeColdOpenIssue(draft.content)
      if (coldOpenIssue) issues.push(coldOpenIssue)
    } else if (draft.content.includes('【倒叙冷开场】')) {
      issues.push('只有第一集允许倒叙冷开场，本集必须直接承接主时间线')
    }

    const bounds = episodeLengthBounds(episodeMinutes)
    const characterCount = scriptCharacterCount(draft.content)
    if (characterCount < bounds.minimum || characterCount > bounds.maximum) {
      issues.push(`正文约 ${characterCount} 字，超出 ${bounds.minimum}-${bounds.maximum} 字的可接受时长范围`)
    }

    const nextEpisode = plan[index + 1]
    if (nextEpisode) {
      const nextSource = episodeSourcePackage(nextEpisode, index + 1).completeSourceText
      const nextSourceReuse = textReuseMetrics(draft.content, nextSource)
      if (isSuspiciousTextReuse(nextSourceReuse)) {
        issues.push(`越界取用了第 ${index + 2} 集独占的原文事件或对白，必须在下一片段开始前停止`)
      }
    }

    const previousDraft = drafts.find((item) => item.episodeNumber === index)
    if (previousDraft) {
      const previousReuse = textReuseMetrics(previousDraft.content, draft.content)
      if (isSuspiciousTextReuse(previousReuse)) {
        issues.push(`与第 ${index} 集存在大段重复，开场必须从上一集最后动作之后继续，不能复演`)
      }
    }
    return [...new Set(issues)]
  }

  async function repairEpisodeDraft(
    draft: z.output<typeof adaptationDraftCheckpointSchema>,
    index: number,
    issues: string[],
  ) {
    const episode = plan[index]
    const sourcePackage = episodeSourcePackage(episode, index)
    const previousDraft = drafts.find((item) => item.episodeNumber === index)
    const duplicateRepair = issues.some((issue) => /重复|复演|上一集/u.test(issue))
    const nextEpisode = plan[index + 1]
    const nextSource = nextEpisode ? episodeSourcePackage(nextEpisode, index + 1) : null
    const repaired = await callStructuredText({
      system: novelAnalysisSystem(),
      prompt: buildEpisodeQualityRepairPrompt({
        episodeNumber: index + 1,
        episodeMinutes,
        title: draft.title,
        logline: draft.logline,
        content: draft.content,
        issues,
        sourceText: sourcePackage.sourceText,
        seriesBible: canonicalSeriesBible,
        previousEpisode: previousDraft ? {
          title: previousDraft.title,
          endingExcerpt: duplicateRepair
            ? sourceEvidenceExcerpt(previousDraft.content, 3_500)
            : previousDraft.content.slice(-900),
        } : undefined,
        nextEpisode: nextEpisode ? {
          title: nextEpisode.title,
          openingContinuity: nextEpisode.openingContinuity,
          forbiddenExcerpt: nextSource
            ? sanitizeNovelEvidenceForTextPrompt(sourceEvidenceExcerpt(nextSource.completeSourceText, 1_600))
            : undefined,
        } : undefined,
        flashforwardCandidates: index === 0 ? flashforwardCandidates : undefined,
      }),
      schema: episodeDraftSchema,
      maxOutputTokens: episodeRepairTokenBudget(episodeMinutes, issues),
      timeoutMs: 120_000,
    })
    checkpoint.qualityRepairCount += 1
    const missing = episodeMinutes > 2
      ? sourcePackage.sourceDialogues.filter((dialogue) => dialogueMissing(repaired.content, dialogue.text))
      : []
    return {
      ...draft,
      title: repaired.title || draft.title,
      logline: repaired.logline || draft.logline,
      content: repaired.content,
      dialogueAuditMissing: missing.length,
    }
  }

  async function generateEpisodeDraft(
    episode: (typeof plan)[number],
    index: number,
  ): Promise<z.output<typeof adaptationDraftCheckpointSchema>> {
    const sourcePackage = episodeSourcePackage(episode, index)
    const previousDraft = drafts.find((draft) => draft.episodeNumber === index)
    const nextEpisode = plan[index + 1]
    let parsed = await callStructuredText({
      system: novelAnalysisSystem(),
      prompt: buildEpisodeDraftPrompt({
        episodeNumber: index + 1,
        title: episode.title,
        logline: episode.logline,
        episodeMinutes,
        goals: episode.contentGoals,
        sourceText: sourcePackage.sourceText,
        analyses: sourcePackage.relevantAnalyses,
        sourceDialogues: sourcePackage.sourceDialogues,
        seriesBible: canonicalSeriesBible,
        openingContinuity: episode.openingContinuity,
        endingContinuity: episode.endingContinuity,
        previousEpisode: previousDraft ? {
          title: previousDraft.title,
          logline: previousDraft.logline,
          endingExcerpt: previousDraft.content.slice(-900),
        } : undefined,
        nextEpisode: nextEpisode ? {
          title: nextEpisode.title,
          logline: nextEpisode.logline,
          openingContinuity: nextEpisode.openingContinuity,
        } : undefined,
        flashforwardCandidates: index === 0 ? flashforwardCandidates : undefined,
      }),
      schema: episodeDraftSchema,
      maxOutputTokens: episodeDraftTokenBudget(episodeMinutes),
    })
    let missing = episodeMinutes > 2
      ? sourcePackage.sourceDialogues.filter((dialogue) => dialogueMissing(parsed.content, dialogue.text))
      : []
    if (missing.length > 0) {
      try {
        const repaired = await callStructuredText({
          system: novelAnalysisSystem(),
          prompt: buildDialogueRepairPrompt({ episodeContent: parsed.content, missingDialogues: missing }),
          schema: z.object({ content: z.string().trim().min(1) }),
          maxOutputTokens: 5000,
        })
        parsed = { ...parsed, ...repaired }
        missing = sourcePackage.sourceDialogues.filter((dialogue) => dialogueMissing(parsed.content, dialogue.text))
      } catch {
        // The optional dialogue repair must not discard an otherwise complete episode draft.
      }
    }
    let draft = {
      episodeNumber: index + 1,
      title: parsed.title || episode.title,
      logline: parsed.logline || episode.logline,
      content: parsed.content,
      sourceChunkIndexes: sourcePackage.selectedIndexes,
      dialogueAuditMissing: missing.length,
    }
    const immediateIssues = draftQualityIssues(draft, index)
      .filter((issue) => !/^正文约 \d+ 字/u.test(issue))
    if (immediateIssues.length > 0) {
      draft = await repairEpisodeDraft(draft, index, immediateIssues)
    }
    return draft
  }

  const pendingEpisodes = plan
    .map((episode, index) => ({ episode, index }))
    .filter(({ index }) => !drafts.some((draft) => draft.episodeNumber === index + 1))

  for (const { episode, index } of pendingEpisodes) {
    const completed = await generateEpisodeDraft(episode, index)
    drafts.push(completed)
    drafts.sort((a, b) => a.episodeNumber - b.episodeNumber)
    checkpoint.drafts = drafts
    await saveAdaptationCheckpoint(task.id, payload, checkpoint)
    await updateProgress(task.id, 48 + (drafts.length / plan.length) * 38)
  }

  const cloneDrafts = (items: typeof drafts) => items.map((draft) => ({
    ...draft,
    sourceChunkIndexes: [...draft.sourceChunkIndexes],
  }))
  const scriptQualityIssueCount = (audit: ReturnType<typeof auditScriptEpisodes>) => (
    audit.duplicatePairs.length
    + audit.missingHooks.length
    + audit.lengthIssues.length
    + (audit.firstEpisodeColdOpenIssue ? 1 : 0)
  )
  const scriptQualityProgress = (
    phase: ScriptQualityProgress['phase'],
    reviewRound: number,
    audit: ReturnType<typeof auditScriptEpisodes>,
    warning?: string,
  ): ScriptQualityProgress => ({
    phase,
    completedEpisodes: drafts.length,
    totalEpisodes: plan.length,
    completedSegments: drafts.length,
    totalSegments: plan.length,
    activeEpisodeNumbers: [...new Set([
      ...audit.duplicatePairs.flatMap((item) => [item.leftEpisode, item.rightEpisode]),
      ...audit.missingHooks.map((item) => item.episodeNumber),
      ...audit.lengthIssues.map((item) => item.episodeNumber),
      ...(audit.firstEpisodeColdOpenIssue ? [1] : []),
    ])].sort((left, right) => left - right),
    activeRoutes: [],
    parallelism: 1,
    segmentParallelism: 1,
    reviewRound,
    maximumReviewRounds: 3,
    modifiedShots: checkpoint.qualityRepairCount,
    remainingIssues: scriptQualityIssueCount(audit),
    fatalIssues: 0,
    ...(warning ? { warning } : {}),
  })

  let qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
  let bestQualityDrafts = cloneDrafts(drafts)
  let bestQualityAudit = qualityAudit
  let bestQualityScore = scriptQualityAuditScore(qualityAudit)
  const captureBestQualityDraft = () => {
    const score = scriptQualityAuditScore(qualityAudit)
    if (score > bestQualityScore) return
    bestQualityScore = score
    bestQualityDrafts = cloneDrafts(drafts)
    bestQualityAudit = qualityAudit
  }
  checkpoint.qualityAuditScore = bestQualityScore
  checkpoint.qualityAuditWarnings = scriptQualityAuditWarnings(bestQualityAudit)
  await saveAdaptationCheckpoint(task.id, payload, checkpoint, scriptQualityProgress('reviewing', 0, qualityAudit))

  for (let pass = 0; pass < 3 && !scriptAuditPassed(qualityAudit); pass++) {
    let deterministicDedupApplied = false
    for (const duplicate of qualityAudit.duplicatePairs) {
      if (duplicate.rightEpisode !== duplicate.leftEpisode + 1) continue
      const leftDraft = drafts.find((draft) => draft.episodeNumber === duplicate.leftEpisode)
      const rightIndex = drafts.findIndex((draft) => draft.episodeNumber === duplicate.rightEpisode)
      if (!leftDraft || rightIndex < 0) continue
      const trimmed = removeRepeatedOpeningFromLaterEpisode(leftDraft.content, drafts[rightIndex].content)
      if (trimmed === drafts[rightIndex].content) continue
      drafts[rightIndex] = { ...drafts[rightIndex], content: trimmed }
      deterministicDedupApplied = true
    }
    if (deterministicDedupApplied) {
      checkpoint.drafts = drafts
      qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
      captureBestQualityDraft()
      await saveAdaptationCheckpoint(
        task.id,
        payload,
        checkpoint,
        scriptQualityProgress('repairing', pass + 1, qualityAudit),
      )
      if (scriptAuditPassed(qualityAudit)) break
    }
    const issueMap = new Map<number, Set<string>>()
    const addIssue = (episodeNumber: number, issue: string) => {
      const issues = issueMap.get(episodeNumber) || new Set<string>()
      issues.add(issue)
      issueMap.set(episodeNumber, issues)
    }
    for (const issue of qualityAudit.missingHooks) addIssue(issue.episodeNumber, issue.reason)
    for (const issue of qualityAudit.lengthIssues) {
      addIssue(issue.episodeNumber, `正文约 ${issue.characterCount} 字，必须调整到 ${issue.minimum}-${issue.maximum} 字`)
    }
    if (qualityAudit.firstEpisodeColdOpenIssue) addIssue(1, qualityAudit.firstEpisodeColdOpenIssue)
    for (const duplicate of qualityAudit.duplicatePairs) {
      const leftDraft = drafts.find((draft) => draft.episodeNumber === duplicate.leftEpisode)
      const rightPlan = plan[duplicate.rightEpisode - 1]
      const rightSource = rightPlan
        ? episodeSourcePackage(rightPlan, duplicate.rightEpisode - 1).completeSourceText
        : ''
      const leftLeaksIntoRight = leftDraft
        ? isSuspiciousTextReuse(textReuseMetrics(leftDraft.content, rightSource))
        : false
      const repairEpisode = leftLeaksIntoRight ? duplicate.leftEpisode : duplicate.rightEpisode
      const otherEpisode = leftLeaksIntoRight ? duplicate.rightEpisode : duplicate.leftEpisode
      addIssue(
        repairEpisode,
        `与第 ${otherEpisode} 集存在跨集重复（共享长句 ${duplicate.sharedSentenceCount} 处），必须只保留本集独占事件`,
      )
    }

    await saveAdaptationCheckpoint(
      task.id,
      payload,
      checkpoint,
      scriptQualityProgress('repairing', pass + 1, qualityAudit),
    )
    for (const [episodeNumber, issueSet] of [...issueMap.entries()].sort((left, right) => left[0] - right[0])) {
      const draftIndex = drafts.findIndex((draft) => draft.episodeNumber === episodeNumber)
      if (draftIndex < 0) continue
      drafts[draftIndex] = await repairEpisodeDraft(drafts[draftIndex], draftIndex, [...issueSet])
      checkpoint.drafts = drafts
      await saveAdaptationCheckpoint(
        task.id,
        payload,
        checkpoint,
        scriptQualityProgress('repairing', pass + 1, qualityAudit),
      )
      await updateProgress(task.id, 87 + ((draftIndex + 1) / drafts.length) * 6)
    }
    qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
    captureBestQualityDraft()
    drafts.splice(0, drafts.length, ...cloneDrafts(bestQualityDrafts))
    qualityAudit = bestQualityAudit
    checkpoint.drafts = drafts
    checkpoint.qualityAuditScore = bestQualityScore
    checkpoint.qualityAuditWarnings = scriptQualityAuditWarnings(bestQualityAudit)
    await saveAdaptationCheckpoint(
      task.id,
      payload,
      checkpoint,
      scriptQualityProgress('verifying', pass + 1, qualityAudit),
    )
  }
  drafts.splice(0, drafts.length, ...cloneDrafts(bestQualityDrafts))
  qualityAudit = bestQualityAudit
  checkpoint.drafts = drafts
  checkpoint.qualityAuditScore = bestQualityScore
  checkpoint.qualityAuditWarnings = scriptQualityAuditWarnings(qualityAudit)
  let qualityWarning = checkpoint.qualityAuditWarnings.length > 0
    ? `已自动返工并保存问题最少的剧本，可继续下一步。${checkpoint.qualityAuditWarnings.join('；')}`
    : undefined
  await saveAdaptationCheckpoint(
    task.id,
    payload,
    checkpoint,
    scriptQualityProgress('verifying', 3, qualityAudit, qualityWarning),
  )
  await updateProgress(task.id, 94)

  const observedByName = new Map<string, { episodes: Set<number>; examples: string[] }>()
  for (const draft of drafts) {
    for (const dialogue of extractScriptDialogueLines(draft.content)) {
      const current = observedByName.get(dialogue.speaker) || { episodes: new Set<number>(), examples: [] }
      current.episodes.add(draft.episodeNumber)
      if (current.examples.length < 3) {
        current.examples.push(`${dialogue.speaker}${dialogue.os ? '【OS】' : ''}：${dialogue.text.slice(0, 120)}`)
      }
      observedByName.set(dialogue.speaker, current)
    }
  }
  const observed = [...observedByName.entries()].map(([name, details]) => ({
    name,
    episodes: [...details.episodes].sort((a, b) => a - b),
    examples: details.examples,
  }))

  if (!checkpoint.nameAuditCompleted) {
    const audit = observed.length > 1
      ? await callStructuredText({
          system: novelAnalysisSystem(),
          prompt: buildCharacterNameAuditPrompt({ seriesBible: canonicalSeriesBible, observed }),
          schema: characterNameAuditSchema,
          maxOutputTokens: 4000,
          timeoutMs: 120_000,
        })
      : { mappings: [] }
    const observedNames = new Set(observed.map((item) => item.name))
    const canonicalNames = new Set(canonicalSeriesBible.characters.map((character) => character.canonicalName))
    checkpoint.nameMappings = audit.mappings
      .filter((mapping) => (
        observedNames.has(mapping.observedName)
        && (canonicalNames.has(mapping.canonicalName) || observedNames.has(mapping.canonicalName))
        && mapping.observedName !== mapping.canonicalName
      ))
      .map(({ observedName, canonicalName }) => ({ observedName, canonicalName }))
    checkpoint.nameAuditCompleted = true
  }

  const nameMappings = [
    ...canonicalSeriesBible.characters.flatMap((character) => character.aliases.map((alias) => ({
      observedName: alias,
      canonicalName: character.canonicalName,
    }))),
    ...checkpoint.nameMappings,
  ]
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]
    drafts[index] = {
      ...draft,
      title: canonicalizeScriptCharacterNames(draft.title, nameMappings),
      logline: canonicalizeScriptCharacterNames(draft.logline, nameMappings),
      content: canonicalizeScriptCharacterNames(draft.content, nameMappings),
    }
  }
  checkpoint.drafts = drafts
  qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
  checkpoint.qualityAuditScore = scriptQualityAuditScore(qualityAudit)
  checkpoint.qualityAuditWarnings = scriptQualityAuditWarnings(qualityAudit)
  qualityWarning = checkpoint.qualityAuditWarnings.length > 0
    ? `已自动返工并保存问题最少的剧本，可继续下一步。${checkpoint.qualityAuditWarnings.join('；')}`
    : undefined
  await saveAdaptationCheckpoint(
    task.id,
    payload,
    checkpoint,
    scriptQualityProgress('finalizing', 3, qualityAudit, qualityWarning),
  )
  await updateProgress(task.id, 96)

  await prisma.$transaction(async (tx) => {
    for (const draft of drafts) {
      await tx.scriptEpisode.upsert({
        where: {
          projectId_episodeNumber: {
            projectId: task.projectId,
            episodeNumber: draft.episodeNumber,
          },
        },
        update: {
          title: draft.title,
          logline: draft.logline,
          content: draft.content,
          sourceChunkIndexes: draft.sourceChunkIndexes,
          locked: false,
        },
        create: {
          projectId: task.projectId,
          episodeNumber: draft.episodeNumber,
          title: draft.title,
          logline: draft.logline,
          content: draft.content,
          sourceChunkIndexes: draft.sourceChunkIndexes,
          locked: false,
        },
      })
    }
    await tx.scriptEpisode.deleteMany({
      where: {
        projectId: task.projectId,
        episodeNumber: { notIn: drafts.map((draft) => draft.episodeNumber) },
      },
    })
  })

  return {
    targetEpisodeCount,
    episodeMinutes,
    episodeCount: drafts.length,
    sourceChunkCount: chunks.length,
    dialogueAuditMissing: drafts.reduce((sum, draft) => sum + draft.dialogueAuditMissing, 0),
    canonicalCharacterCount: canonicalSeriesBible.characters.length,
    characterNameMappingsApplied: checkpoint.nameMappings.length,
    seriesBible: canonicalSeriesBible,
    characterNameMappings: checkpoint.nameMappings,
    scriptQualityAudit: {
      duplicatePairCount: qualityAudit.duplicatePairs.length,
      hookCount: drafts.length - qualityAudit.missingHooks.length,
      firstEpisodeFlashforwardColdOpen: qualityAudit.firstEpisodeColdOpenIssue === null,
      lengthIssueCount: qualityAudit.lengthIssues.length,
      repairCount: checkpoint.qualityRepairCount,
      score: checkpoint.qualityAuditScore,
      warnings: checkpoint.qualityAuditWarnings,
      passed: scriptAuditPassed(qualityAudit),
    },
    scriptQualityProgress: scriptQualityProgress('finalizing', 3, qualityAudit, qualityWarning),
    sequentialEpisodeDrafting: true,
    pipelineVersion: SCRIPT_ADAPTATION_PIPELINE_VERSION,
  }
}

async function processScriptRevision(task: {
  id: string
  projectId: string
  payload: Prisma.JsonValue | null
}) {
  const episodeId = String(payloadRecord(task.payload).episodeId || '')
  const episode = await prisma.scriptEpisode.findFirst({
    where: { id: episodeId, projectId: task.projectId },
    include: { comments: { where: { resolved: false }, orderBy: { createdAt: 'asc' } } },
  })
  if (!episode) throw new Error('待修订的分集剧本不存在')
  if (episode.comments.length === 0) throw new Error('当前没有待处理的导演评论')
  const [projectEpisodes, latestAdaptation] = await Promise.all([
    prisma.scriptEpisode.findMany({
      where: { projectId: task.projectId },
      select: { episodeNumber: true, title: true, content: true },
      orderBy: { episodeNumber: 'asc' },
    }),
    prisma.generationTask.findFirst({
      where: {
        projectId: task.projectId,
        type: GenerationTaskType.script_adaptation,
        status: TaskStatus.completed,
      },
      orderBy: { completedAt: 'desc' },
      select: { payload: true },
    }),
  ])
  const adaptationPayload = payloadRecord(latestAdaptation?.payload ?? null)
  const parsedSeriesBible = seriesBibleSchema.safeParse(adaptationPayload.seriesBible)
  const fallbackNames = [...new Set(projectEpisodes.flatMap((item) => (
    extractScriptDialogueLines(item.content).map((dialogue) => dialogue.speaker)
  )))]
  const revisionSeriesBible = parsedSeriesBible.success
    ? parsedSeriesBible.data
    : {
        characters: fallbackNames.map((canonicalName) => ({
          canonicalName,
          aliases: [] as string[],
          identity: '沿用现有分集剧本中的稳定说话人姓名',
          relationships: [] as string[],
        })),
        continuityRules: ['修订不得改变相邻集已经确立的人物身份、关系和剧情状态'],
      }
  const storedMappings = z.array(z.object({
    observedName: z.string().min(1),
    canonicalName: z.string().min(1),
  })).safeParse(adaptationPayload.characterNameMappings)
  const revisionMappings = [
    ...revisionSeriesBible.characters.flatMap((character) => character.aliases.map((alias) => ({
      observedName: alias,
      canonicalName: character.canonicalName,
    }))),
    ...(storedMappings.success ? storedMappings.data : []),
  ]
  const previousEpisode = projectEpisodes.find((item) => item.episodeNumber === episode.episodeNumber - 1)
  const nextEpisode = projectEpisodes.find((item) => item.episodeNumber === episode.episodeNumber + 1)
  await updateProgress(task.id, 15)
  const text = await callText({
    system: novelAnalysisSystem(),
    prompt: buildEpisodeRevisionPrompt({
      title: episode.title,
      content: episode.content,
      comments: episode.comments,
      seriesBible: revisionSeriesBible,
      previousEpisode: previousEpisode ? {
        title: previousEpisode.title,
        endingExcerpt: previousEpisode.content.slice(-2500),
      } : undefined,
      nextEpisode: nextEpisode ? {
        title: nextEpisode.title,
        openingExcerpt: nextEpisode.content.slice(0, 2500),
      } : undefined,
    }),
    maxOutputTokens: 18000,
    temperature: 0.15,
  })
  const revised = parseWithSchema(text, z.object({ content: z.string().trim().min(1) }))
  const canonicalContent = canonicalizeScriptCharacterNames(revised.content, revisionMappings)
  await updateProgress(task.id, 85)
  await prisma.$transaction([
    prisma.scriptEpisode.update({
      where: { id: episode.id },
      data: { content: canonicalContent, locked: false },
    }),
    prisma.scriptComment.updateMany({
      where: { id: { in: episode.comments.map((comment) => comment.id) } },
      data: { resolved: true },
    }),
  ])
  return { episodeId: episode.id, resolvedCommentCount: episode.comments.length }
}

type AssetInventory = z.output<typeof assetInventorySchema>['assets'][number]
type GeneratedAsset = z.output<typeof generatedAssetItemSchema>
type KnownAsset = Pick<AssetInventory, 'type' | 'name' | 'description'>
type AssetExtractionCheckpoint = z.output<typeof assetExtractionCheckpointSchema>

type StoryboardAssetEvidence = {
  episodeId: string | null
  notes: string | null
  videoPrompt: string | null
}

const ASSET_TYPES = [AssetType.character, AssetType.location, AssetType.prop] as const

function normalizedAssetName(value: string) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function assetNameKey(type: AssetType, name: string) {
  // Storyboard locations are production anchors. Punctuation and spacing can
  // distinguish two locked names, so they must not be collapsed here.
  return type === AssetType.location ? name.trim() : normalizedAssetName(name)
}

function assetIdentityKey(asset: Pick<AssetInventory, 'type' | 'name'>) {
  return `${asset.type}:${assetNameKey(asset.type, asset.name)}`
}

export function extractStoryboardLocationInventories(storyboards: StoryboardAssetEvidence[]) {
  const locations = new Map<string, AssetInventory & { episodeId: string }>()
  for (const storyboard of storyboards) {
    if (!storyboard.episodeId) continue
    const environment = storyboardPromptSection(storyboard.videoPrompt, '环境锁定')
    for (const name of storyboardLocationNames(storyboard)) {
      const description = environment
        ? `分镜标准场景。${environment.slice(0, 900)}`
        : `分镜标准场景“${name}”，空间结构、固定陈设、材质和基础光线以分镜为准。`
      const key = `${storyboard.episodeId}:${name.trim()}`
      const current = locations.get(key)
      if (!current || description.length > current.description.length) {
        locations.set(key, {
          episodeId: storyboard.episodeId,
          type: AssetType.location,
          name,
          description,
          tags: ['分镜标准场景'],
        })
      }
    }
  }
  return [...locations.values()]
}

export function extractAllStoryboardLocationInventories(storyboards: StoryboardAssetEvidence[]) {
  const locations = new Map<string, AssetInventory>()
  for (const storyboard of storyboards) {
    const environment = storyboardPromptSection(storyboard.videoPrompt, '环境锁定')
    for (const name of storyboardLocationNames(storyboard)) {
      const description = environment
        ? `分镜标准场景。${environment.slice(0, 900)}`
        : `分镜标准场景“${name}”，空间结构、固定陈设、材质和基础光线以分镜为准。`
      const current = locations.get(name.trim())
      if (!current || description.length > current.description.length) {
        locations.set(name.trim(), {
          type: AssetType.location,
          name,
          description,
          tags: ['分镜标准场景'],
        })
      }
    }
  }
  return [...locations.values()]
}

function storyboardAssetEvidence(storyboards: StoryboardAssetEvidence[], type: AssetType) {
  const lines = new Set<string>()
  for (const storyboard of storyboards) {
    if (type === AssetType.location) {
      const timeLocation = storyboardTimeLocation(storyboard)
      const environment = storyboardPromptSection(storyboard.videoPrompt, '环境锁定')
      if (timeLocation) lines.add(`- 标准场景：${timeLocation}${environment ? `｜固定环境：${environment.slice(0, 500)}` : ''}`)
      continue
    }
    const section = storyboardPromptSection(
      storyboard.videoPrompt,
      type === AssetType.character ? '人物锁定' : '道具锁定',
    )
    if (section) lines.add(`- ${section.slice(0, 700)}`)
  }
  return [...lines].slice(0, 60).join('\n')
}

function canonicalAssetName(asset: Pick<AssetInventory, 'type' | 'name'>, knownAssets: KnownAsset[]) {
  if (asset.type === AssetType.location) {
    return knownAssets.find((known) => (
      known.type === asset.type && known.name.trim() === asset.name.trim()
    ))?.name || asset.name.trim()
  }
  const candidate = normalizedAssetName(asset.name)
  if (candidate.length < 2) return asset.name
  const exact = knownAssets.find((known) => (
    known.type === asset.type && normalizedAssetName(known.name) === candidate
  ))
  if (exact) return exact.name
  if (asset.type !== AssetType.character) return asset.name
  const match = knownAssets.find((known) => {
    if (known.type !== asset.type) return false
    const fullName = normalizedAssetName(known.name)
    const aliases = known.name
      .split(/[（()）/｜|、,，]/)
      .map(normalizedAssetName)
      .filter((alias) => alias.length >= 2)
    return fullName === candidate
      || fullName.includes(candidate)
      || aliases.some((alias) => alias === candidate)
  })
  return match?.name || asset.name
}

function mergeAssetInventories(groups: AssetInventory[][], knownAssets: KnownAsset[] = []) {
  const merged = new Map<string, AssetInventory>()
  for (const rawAsset of groups.flat()) {
    const asset = { ...rawAsset, name: canonicalAssetName(rawAsset, knownAssets) }
    const key = assetIdentityKey(asset)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, asset)
      continue
    }
    merged.set(key, {
      ...current,
      description: current.description.length >= asset.description.length ? current.description : asset.description,
      tags: [...new Set([...current.tags, ...asset.tags])].slice(0, 12),
    })
  }
  return [...merged.values()]
}

export function assetEpisodeAppearanceCounts(input: Array<{
  episodeId: string
  type: AssetType
  assets: Array<{ type: AssetType; name: string }>
}>) {
  const appearances = new Map<string, Set<string>>()
  for (const inventory of input) {
    for (const asset of inventory.assets) {
      const key = assetIdentityKey(asset)
      const episodes = appearances.get(key) || new Set<string>()
      episodes.add(inventory.episodeId)
      appearances.set(key, episodes)
    }
  }
  return new Map([...appearances.entries()].map(([key, episodeIds]) => [key, episodeIds.size]))
}

export function filterCoreAssetCandidates<T extends { type: AssetType; name: string }>(
  assets: T[],
  inventories: Array<{
    episodeId: string
    type: AssetType
    assets: Array<{ type: AssetType; name: string }>
  }>,
  minimumPropEpisodes = 2,
) {
  const appearances = assetEpisodeAppearanceCounts(inventories)
  return assets.filter((asset) => (
    asset.type !== AssetType.prop
    || (appearances.get(`${asset.type}:${normalizedAssetName(asset.name)}`) || 0) >= minimumPropEpisodes
  ))
}

function chunkAssetInventories(items: AssetInventory[], size = 24) {
  const chunks: AssetInventory[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function assetPromptKey(asset: Pick<AssetInventory, 'type' | 'name'>) {
  return assetIdentityKey(asset)
}

function legacyAssetPromptKey(asset: Pick<AssetInventory, 'type' | 'name'>) {
  return `${asset.type}:${normalizedAssetName(asset.name)}`
}

async function saveAssetExtractionCheckpoint(
  taskId: string,
  payload: TaskPayload,
  checkpoint: AssetExtractionCheckpoint,
) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      payload: {
        ...payload,
        assetExtractionCheckpoint: checkpoint,
      } as Prisma.InputJsonObject,
    },
  })
}

async function processAssetExtraction(task: {
  id: string
  projectId: string
  createdById: string
  payload: Prisma.JsonValue | null
}) {
  const payload = payloadRecord(task.payload)
  const requestedEpisodeIds = storyboardRequestedEpisodeIds(payload)
  const selectedEpisodes = await requireLockedEpisodes(task.projectId, requestedEpisodeIds)
  const targetEpisodeIds = selectedEpisodes.map((episode) => episode.id)
  await requireEpisodesStoryboarded(task.projectId, targetEpisodeIds)
  const project = await prisma.project.findUnique({ where: { id: task.projectId } })
  if (!project) throw new Error('项目不存在')
  const productionProject = project
  const [episodes, existingAssets, storyboards] = await Promise.all([
    prisma.scriptEpisode.findMany({
      where: { projectId: task.projectId, locked: true, id: { in: targetEpisodeIds } },
      orderBy: { episodeNumber: 'asc' },
    }),
    prisma.asset.findMany({
      where: { projectId: task.projectId },
      select: {
        id: true,
        type: true,
        name: true,
        description: true,
        tags: true,
        selectedImageId: true,
        _count: { select: { images: true } },
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.storyboard.findMany({
      where: { projectId: task.projectId, episodeId: { in: targetEpisodeIds } },
      select: { id: true, episodeId: true, notes: true, videoPrompt: true, updatedAt: true },
      orderBy: { sceneNumber: 'asc' },
    }),
  ])
  const storyboardLocations = extractStoryboardLocationInventories(storyboards)
  const allStoryboardLocations = extractAllStoryboardLocationInventories(storyboards)
  const sourceFingerprint = createHash('sha256')
    .update(JSON.stringify({
      pipelineVersion: 'storyboard-first-asset-extraction-v6-episode-scope',
      visualStyle: productionProject.visualStyle,
      customStylePrompt: project.customStylePrompt,
      episodes: episodes.map((episode) => ({
        id: episode.id,
        updatedAt: episode.updatedAt.toISOString(),
        content: episode.content,
      })),
      storyboards: storyboards.map((storyboard) => ({
        id: storyboard.id,
        updatedAt: storyboard.updatedAt.toISOString(),
        notes: storyboard.notes,
        videoPrompt: storyboard.videoPrompt,
      })),
    }))
    .digest('hex')
  const savedCheckpoint = assetExtractionCheckpointSchema.safeParse(payload.assetExtractionCheckpoint)
  const checkpoint: AssetExtractionCheckpoint = savedCheckpoint.success
    && savedCheckpoint.data.sourceFingerprint === sourceFingerprint
    ? savedCheckpoint.data
    : { sourceFingerprint, inventories: [], curations: [], selections: [], prompts: [] }
  const checkpointInventories = [...checkpoint.inventories]
  const savedInventories = new Map(checkpointInventories.map((item) => [
    `${item.episodeId}:${item.type}`,
    item.assets,
  ]))
  const inventoryGroups: AssetInventory[][] = []
  const inventoryStepCount = Math.max(1, episodes.length * ASSET_TYPES.length)
  let inventoryStep = 0

  for (let index = 0; index < episodes.length; index++) {
    const episode = episodes[index]
    const episodeStoryboards = storyboards.filter((storyboard) => storyboard.episodeId === episode.id)
    const episodeLocationAnchors = storyboardLocations.filter((location) => location.episodeId === episode.id)
    const priorAssets = mergeAssetInventories(inventoryGroups, existingAssets)
    const knownAssets = [...existingAssets, ...priorAssets]
    const pendingTypes = ASSET_TYPES.filter((type) => !savedInventories.has(`${episode.id}:${type}`))
    const settledTypes = await Promise.allSettled(pendingTypes.map(async (type) => {
      const inventoryKey = `${episode.id}:${type}`
      const extracted = await callStructuredText({
        system: '你是电影制片资产记录员。只从剧本提取指定类型的资产事实，只输出严格 JSON。',
        prompt: buildAssetInventoryPrompt({
          script: `第 ${episode.episodeNumber} 集《${episode.title}》\n${episode.content}`,
          type,
          knownAssets,
          storyboardEvidence: storyboardAssetEvidence(episodeStoryboards, type),
        }),
        schema: assetInventorySchemaForType(type),
        maxOutputTokens: type === AssetType.prop ? 1400 : 1100,
      })
      return {
        inventoryKey,
        type,
        assets: mergeAssetInventories([
          extracted.assets.map((asset) => ({ ...asset, type })),
          type === AssetType.location ? episodeLocationAnchors : [],
        ], knownAssets),
      }
    }))
    const completedTypes = settledTypes.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ))
    for (const completed of completedTypes) {
      checkpointInventories.push({
        episodeId: episode.id,
        type: completed.type,
        assets: completed.assets,
      })
      savedInventories.set(completed.inventoryKey, completed.assets)
    }
    if (completedTypes.length > 0) {
      await saveAssetExtractionCheckpoint(task.id, payload, {
        sourceFingerprint,
        inventories: checkpointInventories,
        curations: checkpoint.curations,
        selections: checkpoint.selections,
        prompts: checkpoint.prompts,
      })
    }
    const failedType = settledTypes.find((result) => result.status === 'rejected')
    if (failedType?.status === 'rejected') throw failedType.reason
    for (const type of ASSET_TYPES) {
      inventoryGroups.push(savedInventories.get(`${episode.id}:${type}`) || [])
      inventoryStep++
    }
    await updateProgress(task.id, 5 + (inventoryStep / inventoryStepCount) * 30)
  }

  const unfilteredInventory = mergeAssetInventories(inventoryGroups, existingAssets)
  const appearanceCounts = assetEpisodeAppearanceCounts(checkpointInventories)
  const rawInventory = filterCoreAssetCandidates(unfilteredInventory, checkpointInventories)
  if (rawInventory.length === 0) throw new Error('文本 API 没有从已锁定剧本中识别出资产')
  const episodeAppearances = rawInventory.map((asset) => ({
    name: asset.name,
    count: appearanceCounts.get(assetIdentityKey(asset)) || 1,
  }))
  const checkpointCurations = [...checkpoint.curations]
  const savedCurations = new Map(checkpointCurations.map((item) => [item.key, item.assets]))
  const checkpointSelections = [...checkpoint.selections]
  const savedSelections = new Map(checkpointSelections.map((item) => [item.type, item.selectedNames]))
  const curatedGroups: AssetInventory[][] = []
  const typeChunks = new Map(ASSET_TYPES.map((type) => [
    type,
    chunkAssetInventories(rawInventory.filter((asset) => asset.type === type)),
  ]))
  const curationStepCount = Math.max(
    1,
    [...typeChunks.values()].reduce((sum, chunks) => sum + chunks.length, 0)
      + ASSET_TYPES.filter((type) => (typeChunks.get(type)?.length || 0) > 0).length,
  )
  let curationStep = 0

  for (const type of ASSET_TYPES) {
    const chunks = typeChunks.get(type) || []
    for (let index = 0; index < chunks.length; index++) {
      const key = `${type}:batch:${index + 1}`
      const priorCurated = mergeAssetInventories(curatedGroups, existingAssets)
      const allowedNames = new Set(
        [...chunks[index], ...existingAssets, ...priorCurated]
          .filter((asset) => asset.type === type)
          .map((asset) => assetNameKey(type, asset.name)),
      )
      let curated = savedCurations.get(key)
      if (!curated) {
        const response = await callStructuredText({
          system: '你是影视项目制片主任。筛选并归并需要保持视觉连续性的指定类型资产，只输出严格 JSON。',
          prompt: buildAssetCurationPrompt({
            type,
            assets: chunks[index],
            knownAssets: [...existingAssets, ...priorCurated],
            episodeAppearances,
          }),
          schema: assetInventorySchemaForType(type),
          maxOutputTokens: 1800,
        })
        curated = response.assets
          .map((asset) => ({ ...asset, type }))
          .filter((asset) => allowedNames.has(assetNameKey(type, asset.name)))
        checkpointCurations.push({ key, assets: curated })
        savedCurations.set(key, curated)
        await saveAssetExtractionCheckpoint(task.id, payload, {
          sourceFingerprint,
          inventories: checkpointInventories,
          curations: checkpointCurations,
          selections: checkpointSelections,
          prompts: checkpoint.prompts,
        })
      } else {
        curated = curated.filter((asset) => allowedNames.has(assetNameKey(type, asset.name)))
      }
      curatedGroups.push(curated)
      curationStep++
      await updateProgress(task.id, 35 + (curationStep / curationStepCount) * 15)
    }
  }

  const requiredStoryboardAssets = mergeAssetInventories([allStoryboardLocations], existingAssets)
  const preliminaryInventory = mergeAssetInventories(
    [...curatedGroups, requiredStoryboardAssets],
    existingAssets,
  )
  const selectedGroups: AssetInventory[][] = []
  for (const type of ASSET_TYPES) {
    const candidates = preliminaryInventory.filter((asset) => asset.type === type)
    if (candidates.length === 0) continue
    let selectedNames = savedSelections.get(type)
    const requiredNames = [...existingAssets, ...requiredStoryboardAssets]
      .filter((asset) => asset.type === type)
      .filter((asset) => candidates.some((candidate) => (
        assetNameKey(type, candidate.name) === assetNameKey(type, asset.name)
      )))
      .map((asset) => asset.name)
    if (!selectedNames) {
      const response = await callStructuredText({
        system: '你是影视项目总制片主任。确认全剧最终资产清单，只输出严格 JSON。',
        prompt: buildAssetSelectionPrompt({
          type,
          assets: candidates,
          requiredNames,
          episodeAppearances,
        }),
        schema: assetSelectionSchema,
        maxOutputTokens: 1400,
      })
      selectedNames = [...new Set([...response.selectedNames, ...requiredNames])]
      checkpointSelections.push({ type, selectedNames })
      savedSelections.set(type, selectedNames)
      await saveAssetExtractionCheckpoint(task.id, payload, {
        sourceFingerprint,
        inventories: checkpointInventories,
        curations: checkpointCurations,
        selections: checkpointSelections,
        prompts: checkpoint.prompts,
      })
    }
    selectedNames = [...new Set([...selectedNames, ...requiredNames])]
    const selectedKeys = new Set(selectedNames.map((name) => assetNameKey(type, name)))
    const selected = candidates.filter((candidate) => selectedKeys.has(assetNameKey(type, candidate.name)))
    if (selected.length === 0) throw new Error(`文本 API 没有为 ${type} 返回有效的最终资产名称`)
    selectedGroups.push(selected)
    curationStep++
    await updateProgress(task.id, 35 + (curationStep / curationStepCount) * 15)
  }

  const inventory = mergeAssetInventories(selectedGroups, existingAssets)
  if (inventory.length === 0) throw new Error('文本 API 筛选后没有可进入资产库的项目')
  const checkpointPrompts = [...checkpoint.prompts]
  const savedPrompts = new Map(checkpointPrompts.map((item) => [item.key, item.asset]))
  const generated: GeneratedAsset[] = []

  for (const batch of batchesOf(inventory, env.textAssetConcurrency())) {
    const settledBatch = await Promise.allSettled(batch.map(async (candidate) => {
      const key = assetPromptKey(candidate)
      const saved = savedPrompts.get(key) || savedPrompts.get(legacyAssetPromptKey(candidate))
      if (saved) {
        return {
          key,
          asset: { ...saved, type: candidate.type, name: candidate.name },
          fresh: false,
        }
      }
      const detailed = await callStructuredText({
        system: '你是电影级视觉设定导演。依据已确认资产事实生成完整生图提示词，只输出严格 JSON。',
        prompt: buildSingleAssetPrompt({
          asset: candidate,
          visualStyle: project.visualStyle,
          customStylePrompt: project.customStylePrompt,
        }),
        schema: assetPromptResultSchema,
        maxOutputTokens: 1600,
      })
      return {
        key,
        fresh: true,
        asset: {
          ...candidate,
          description: detailed.description,
          tags: [...new Set([...candidate.tags, ...detailed.tags])].slice(0, 12),
          prompt: detailed.prompt,
        },
      }
    }))
    const completedBatch = settledBatch.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ))
    for (const completed of completedBatch) {
      generated.push(completed.asset)
      if (!completed.fresh) continue
      checkpointPrompts.push({ key: completed.key, asset: completed.asset })
      savedPrompts.set(completed.key, completed.asset)
    }
    if (completedBatch.some((item) => item.fresh)) {
      await saveAssetExtractionCheckpoint(task.id, payload, {
        sourceFingerprint,
        inventories: checkpointInventories,
        curations: checkpointCurations,
        selections: checkpointSelections,
        prompts: checkpointPrompts,
      })
    }
    const failedPrompt = settledBatch.find((result) => result.status === 'rejected')
    if (failedPrompt?.status === 'rejected') throw failedPrompt.reason
    await updateProgress(task.id, 50 + (generated.length / inventory.length) * 40)
  }

  const characterNames = generated.filter((asset) => asset.type === AssetType.character).map((asset) => asset.name)
  const storyboardSceneNames = new Set(storyboards.flatMap(storyboardLocationNames))
  const refreshDrafts = payload.refreshDrafts !== false
  const result = { created: [] as string[], updated: [] as string[], preserved: [] as string[] }
  const claimedSceneAliasIds = new Set<string>()

  async function persistAsset(candidate: GeneratedAsset) {
    const enforced = enforceAssetPrompt({
      type: candidate.type,
      name: candidate.name,
      prompt: candidate.prompt,
      characterNames,
      visualStyle: productionProject.visualStyle,
      customStylePrompt: productionProject.customStylePrompt,
      preserveName: candidate.type === AssetType.location && storyboardSceneNames.has(candidate.name),
    })
    let existing = await prisma.asset.findFirst({
      where: {
        projectId: task.projectId,
        type: candidate.type,
        name: { equals: enforced.name, mode: 'insensitive' },
      },
      include: { _count: { select: { images: true } } },
    })
    if (!existing && candidate.type === AssetType.location && storyboardSceneNames.has(candidate.name)) {
      const alias = existingAssets.find((asset) => (
        asset.type === AssetType.location
        && !claimedSceneAliasIds.has(asset.id)
        && !storyboardSceneNames.has(asset.name)
        && asset._count.images === 0
        && (
          normalizedAssetName(asset.name) === normalizedAssetName(candidate.name)
          || asset.name.trim() === `${candidate.name.trim()}核心场景`
        )
      ))
      if (alias) {
        claimedSceneAliasIds.add(alias.id)
        existing = await prisma.asset.findUnique({
          where: { id: alias.id },
          include: { _count: { select: { images: true } } },
        })
      }
    }
    if (!existing) {
      const created = await prisma.asset.create({
        data: {
          projectId: task.projectId,
          type: candidate.type,
          name: enforced.name,
          description: candidate.description,
          tags: [...new Set(candidate.tags)].slice(0, 12),
          prompt: enforced.prompt,
          createdById: task.createdById,
        },
      })
      result.created.push(created.id)
    } else if (refreshDrafts && existing._count.images === 0) {
      await prisma.asset.update({
        where: { id: existing.id },
        data: {
          name: enforced.name,
          description: candidate.description,
          tags: [...new Set(candidate.tags)].slice(0, 12),
          prompt: enforced.prompt,
        },
      })
      result.updated.push(existing.id)
    } else {
      result.preserved.push(existing.id)
    }
  }

  for (let index = 0; index < generated.length; index++) {
    await persistAsset(generated[index])
    await updateProgress(task.id, 90 + ((index + 1) / Math.max(1, generated.length)) * 7)
  }

  let storedSceneAssets = await prisma.asset.findMany({
    where: { projectId: task.projectId, type: AssetType.location },
    select: { type: true, name: true },
  })
  let sceneConsistency = calculateSceneConsistency(storyboards, storedSceneAssets)
  if (sceneConsistency.total === 0) {
    throw new Error('SCENE_CONSISTENCY_MISSING: 分镜中没有可核对的“时间｜标准场景名”，请先修正分镜地点')
  }
  let autoRepairedScenes = 0
  let storyboardFallbackScenes = 0
  if (!sceneConsistency.exact) {
    const generatedScenes = new Map(
      generated
        .filter((asset) => asset.type === AssetType.location)
        .map((asset) => [asset.name.trim(), asset]),
    )
    const storyboardScenes = new Map(
      allStoryboardLocations.map((asset) => [asset.name.trim(), asset]),
    )

    for (const missingName of sceneConsistency.missingNames) {
      const anchor = storyboardScenes.get(missingName)
      if (!anchor) continue
      let repair = generatedScenes.get(missingName)
      if (!repair) {
        try {
          const detailed = await callStructuredText({
            system: '你是电影级视觉设定导演。依据已完成分镜的标准场景事实补齐场景生图提示词，只输出严格 JSON。',
            prompt: buildSingleAssetPrompt({
              asset: anchor,
              visualStyle: productionProject.visualStyle,
              customStylePrompt: productionProject.customStylePrompt,
            }),
            schema: assetPromptResultSchema,
            maxOutputTokens: 1600,
          })
          repair = {
            ...anchor,
            description: detailed.description,
            tags: [...new Set([...anchor.tags, ...detailed.tags, '自动补齐'])].slice(0, 12),
            prompt: detailed.prompt,
          }
        } catch {
          // Storyboard environment locks are API-generated production data.
          // Reusing them avoids inventing project-specific details locally.
          repair = {
            ...anchor,
            tags: [...new Set([...anchor.tags, '分镜自动补齐'])].slice(0, 12),
            prompt: `${anchor.description}\n场景名称：${anchor.name}\n横向 16:9 电影级纯场景设定图，保持分镜中的空间结构、固定陈设、材质和基础光线完全一致。`,
          }
          storyboardFallbackScenes++
        }
      }
      await persistAsset(repair)
      autoRepairedScenes++
      await updateProgress(task.id, 98)
    }

    storedSceneAssets = await prisma.asset.findMany({
      where: { projectId: task.projectId, type: AssetType.location },
      select: { type: true, name: true },
    })
    sceneConsistency = calculateSceneConsistency(storyboards, storedSceneAssets)
    if (!sceneConsistency.exact) {
      throw new Error(
        `SCENE_CONSISTENCY_MISMATCH: 自动补齐后仍缺少标准场景：${sceneConsistency.missingNames.join('、')}`,
      )
    }
  }

  for (const batch of batchesOf(storyboards.map((storyboard) => storyboard.id), env.textAssetConcurrency())) {
    await Promise.all(batch.map((storyboardId) => syncStoryboardAssetLinks(storyboardId)))
  }
  return {
    ...result,
    total: generated.length,
    excludedSingleEpisodeProps: unfilteredInventory.length - rawInventory.length,
    coreAssetPriority: true,
    storyboardAnchoredLocations: requiredStoryboardAssets.length,
    sceneConsistency: {
      matched: sceneConsistency.matched,
      total: sceneConsistency.total,
      exact: sceneConsistency.exact,
    },
    autoRepairedScenes,
    storyboardFallbackScenes,
    apiOnly: true,
    model: env.textModel(),
    episodeIds: targetEpisodeIds,
    episodeNumbers: episodes.map((episode) => episode.episodeNumber),
  }
}

type GeneratedStoryboard = z.output<typeof generatedStoryboardSchema>['storyboards'][number]
type CompactShot = z.output<typeof compactStoryboardSchema>['shots'][number]
export type CompactShotInput = Partial<CompactShot>

export function normalizeCompactShot(shot: CompactShotInput): CompactShot {
  return compactStoryboardShotSchema.parse(shot)
}

export function applyStoryboardFinalReviewPatch(
  inputShots: CompactShotInput[],
  patch: z.output<typeof storyboardFinalReviewPatchSchema>,
) {
  const shots = inputShots.map(normalizeCompactShot)
  if (patch.replaceAll) {
    const replacementShots = [...patch.replacements]
      .sort((left, right) => left.shotNumber - right.shotNumber)
      .map((item) => normalizeCompactShot({
        ...(shots[item.shotNumber - 1] || {}),
        ...item.shot,
      }))
    const insertions = new Map<number, CompactShot[]>()
    for (const insertion of patch.insertions) {
      const current = insertions.get(insertion.afterShotNumber) || []
      current.push(normalizeCompactShot(insertion.shot))
      insertions.set(insertion.afterShotNumber, current)
    }
    const result: CompactShot[] = [...(insertions.get(0) || [])]
    replacementShots.forEach((shot, index) => {
      result.push(shot)
      result.push(...(insertions.get(index + 1) || []))
    })
    return result
  }
  const removed = new Set(patch.remove.filter((shotNumber) => shotNumber <= shots.length))
  const replacements = new Map(
    patch.replacements
      .filter((item) => item.shotNumber <= shots.length)
      .map((item) => [item.shotNumber, normalizeCompactShot({
        ...shots[item.shotNumber - 1],
        ...item.shot,
      })]),
  )
  const requestedOrder = [...new Set(patch.order)]
    .filter((shotNumber) => shotNumber <= shots.length && !removed.has(shotNumber))
  const order = requestedOrder.length > 0
    ? [
        ...requestedOrder,
        ...shots.map((_shot, index) => index + 1)
          .filter((shotNumber) => !removed.has(shotNumber) && !requestedOrder.includes(shotNumber)),
      ]
    : shots.map((_shot, index) => index + 1).filter((shotNumber) => !removed.has(shotNumber))
  const insertions = new Map<number, CompactShot[]>()
  for (const insertion of patch.insertions) {
    const current = insertions.get(insertion.afterShotNumber) || []
    current.push(normalizeCompactShot(insertion.shot))
    insertions.set(insertion.afterShotNumber, current)
  }

  const result: CompactShot[] = [...(insertions.get(0) || [])]
  for (const shotNumber of order) {
    result.push(replacements.get(shotNumber) || shots[shotNumber - 1])
    result.push(...(insertions.get(shotNumber) || []))
  }
  const unplacedInsertions = [...insertions.entries()]
    .filter(([afterShotNumber]) => afterShotNumber !== 0 && !order.includes(afterShotNumber))
    .flatMap(([, values]) => values)
  result.push(...unplacedInsertions)
  return result
}

export function storyboardFinalReviewIssueScore(issues: StoryboardFinalReviewIssue[]) {
  const fatal = issues.filter((issue) => issue.severity === 'fatal').length
  const warning = issues.length - fatal
  return fatal * 10_000 + warning * 100 + issues.length
}

export function storyboardFinalReviewHasFatalIssues(issues: StoryboardFinalReviewIssue[]) {
  return issues.some((issue) => issue.severity === 'fatal')
}

export function nonBlockingStoryboardReviewWarnings(issues: StoryboardFinalReviewIssue[]) {
  return issues.map((issue) => ({
    ...issue,
  }))
}

export function storyboardShotChangeCount(before: CompactShotInput[], after: CompactShotInput[]) {
  const normalizedBefore = before.map(normalizeCompactShot)
  const normalizedAfter = after.map(normalizeCompactShot)
  const length = Math.max(normalizedBefore.length, normalizedAfter.length)
  let changed = 0
  for (let index = 0; index < length; index++) {
    if (JSON.stringify(normalizedBefore[index] ?? null) !== JSON.stringify(normalizedAfter[index] ?? null)) {
      changed++
    }
  }
  return changed
}

function dedupeStoryboardFinalReviewIssues(issues: StoryboardFinalReviewIssue[]) {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.category}:${issue.shotNumbers.join(',')}:${issue.problem}`
      .toLocaleLowerCase()
      .replace(/\s+/g, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function preferStoryboardReviewCandidate(input: {
  currentShots: CompactShot[]
  currentIssues: StoryboardFinalReviewIssue[]
  bestShots: CompactShot[]
  bestIssues: StoryboardFinalReviewIssue[]
}) {
  const currentScore = storyboardFinalReviewIssueScore(input.currentIssues)
  const bestScore = storyboardFinalReviewIssueScore(input.bestIssues)
  return currentScore <= bestScore
    ? { shots: input.currentShots, issues: input.currentIssues }
    : { shots: input.bestShots, issues: input.bestIssues }
}

export function shouldFinalizeStoryboardReviewLocally(input: {
  stage: string | null
  round: number
  maximumRounds: number
}) {
  return input.stage === 'repaired' && input.round >= input.maximumRounds
}

export function canUseLocalStoryboardVerificationFallback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (nonRetryableTextApiError(error)) return false
  return /timeout|timed?\s*out|aborted|TEXT_API_FAILED:\s*(?:429|5\d\d)|fetch|socket|ECONN|ENOTFOUND|JSON|Zod|structured|网关|读取超时/iu.test(message)
}

export function canFinalizeStoryboardAfterRepairFailure(repairRound: number, error: unknown) {
  return repairRound > 0 && canUseLocalStoryboardVerificationFallback(error)
}

export function splitStoryboardScript(content: string, maxChars = 520) {
  const lines = content.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  let sceneHeading = ''
  const isSceneHeading = (line: string) => /^(?:\*\*)?(?:【\s*(?:(?:场次|场景)[^】]*|场\s*\d+(?:\s*[-—]\s*\d+)?[^】]*)】|(?:场次|场景)\s*[^\n]{0,80}|场\s*\d+(?:\s*[-—]\s*\d+)?(?:\s+[^\n]{0,80})?$)/u.test(line)
  const flush = () => {
    if (!current.trim()) return
    chunks.push(current.trim())
    current = ''
  }
  const startWithSceneHeading = () => {
    if (!current && sceneHeading) current = sceneHeading
  }

  for (const line of lines) {
    if (isSceneHeading(line)) {
      flush()
      sceneHeading = line
      current = line
      continue
    }
    const units = line.length <= maxChars
      ? [line]
      : line.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) || [line]
    for (const unit of units) {
      startWithSceneHeading()
      if (current && current.length + unit.length + 1 > maxChars) {
        flush()
        startWithSceneHeading()
      }
      if (unit.length > maxChars) {
        flush()
        for (let start = 0; start < unit.length; start += maxChars) {
          const slice = unit.slice(start, start + maxChars)
          chunks.push(`${sceneHeading ? `${sceneHeading}\n` : ''}${slice}`.trim())
        }
      } else {
        current += `${current ? '\n' : ''}${unit}`
      }
    }
  }
  flush()
  return chunks.length > 0 ? chunks : [content.trim()]
}

export function targetStoryboardShotCount(script: string, minimum = 1) {
  const dialogues = extractScriptDialogueLines(script)
  const dialogueChars = dialogues.reduce((total, dialogue) => total + dialogue.text.length, 0)
  const dialogueBeats = Math.ceil(dialogueChars / 70)
  const visibleChars = script.replace(/\s+/g, '').length
  return Math.max(minimum, Math.min(60, Math.max(dialogueBeats, Math.ceil(visibleChars / 70))))
}

export function allocateStoryboardShotTargets(chunks: string[], targetShotCount: number) {
  if (chunks.length === 0) return []
  const targets = chunks.map((chunk) => targetStoryboardShotCount(chunk))
  const minimumTotal = targets.reduce((total, count) => total + count, 0)
  const target = Math.max(minimumTotal, Math.round(targetShotCount))
  let remaining = Math.max(0, target - minimumTotal)
  if (remaining === 0) return targets

  const weights = chunks.map((chunk) => (
    Math.max(1, chunk.replace(/\s+/g, '').length)
    + extractScriptDialogueLines(chunk).length * 70
  ))
  const totalWeight = weights.reduce((total, weight) => total + weight, 0)
  const fractional = weights.map((weight, index) => {
    const share = remaining * weight / totalWeight
    const whole = Math.floor(share)
    targets[index] += whole
    return { index, fraction: share - whole }
  })
  remaining = Math.max(0, target - targets.reduce((total, count) => total + count, 0))
  fractional
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    .slice(0, remaining)
    .forEach(({ index }) => { targets[index] += 1 })
  return targets
}

function parseStoryboardDialogueSegment(segment: string) {
  const match = segment.trim().match(/^([^：:\n【]{1,32})(【OS】)?[：:]\s*(.{1,800})$/u)
  if (!match) return null
  return {
    speaker: match[1].trim(),
    os: Boolean(match[2]),
    text: match[3].trim(),
  }
}

export function suppressNonessentialStoryboardVoiceovers(
  shots: CompactShotInput[],
  script: string,
) {
  const sourceVoiceovers = extractScriptDialogueLines(script).filter(isStoryboardVoiceover)

  return shots.map((inputShot): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    const segments = shot.a.split(/[；;\n]+/u).map((segment) => segment.trim()).filter(Boolean)
    let removed = 0
    const retained = segments.filter((segment) => {
      const dialogue = parseStoryboardDialogueSegment(segment)
      if (!dialogue || !isStoryboardVoiceover(dialogue)) return true
      const source = sourceVoiceovers.find((candidate) => (
        candidate.speaker === dialogue.speaker
        && candidate.os === dialogue.os
        && (!dialogueMissing(dialogue.text, candidate.text) || !dialogueMissing(candidate.text, dialogue.text))
      ))
      const keep = Boolean(source)
      if (!keep) removed++
      return keep
    })
    if (removed === 0) return shot

    const actionDialogue = retained.join('；') || '无对白'
    const retainedDialogues = extractScriptDialogueLines(retained.join('\n'))
    const hasVoiceover = retainedDialogues.some(isStoryboardVoiceover)
    const hasOnscreenDialogue = retainedDialogues.some((dialogue) => !isStoryboardVoiceover(dialogue))
    const voiceRule = hasVoiceover
      ? `${shot.q}；完整保留原剧本旁白、画外音或【OS】，不增加原文之外的声音。`
      : hasOnscreenDialogue
        ? `${shot.q}；只生成保留的现场对白，不生成旁白、画外音或内心独白。`
        : '本镜无对白，不生成配音、旁白、画外音或内心独白。'

    return {
      ...shot,
      a: actionDialogue,
      q: voiceRule.slice(0, 2400),
    }
  })
}

export type StoryboardAtomicityIssue = {
  index: number
  title: string
  reasons: string[]
}

const MULTI_BEAT_STORYBOARD_TITLE = /(?:[\/／]|→|->|\bto\b|\s至\s|(?:抵达|进入|离开|返回).{0,16}(?:再|后|并).{0,16}(?:抵达|进入|离开|返回))/iu
const MULTI_SETUP_CAMERA = /(?:蒙太奇|快切|跳切|多角度|镜头组|分屏|随后切|然后切|再切|切换为|转为.{0,12}(?:特写|近景|中景|全景|远景)|先.{0,24}(?:特写|近景|中景|全景|远景).{0,24}(?:再|随后|然后).{0,24}(?:特写|近景|中景|全景|远景))/u
const LOCATION_TRANSITION_IN_SHOT = /(?:转场|场景切换|画面切到|镜头切到|随后来到|然后来到|回忆结束|回到现实|进入回忆)/u
const PACKED_TIMELINE_MARKER = /\d+(?:\.\d+)?\s*(?:-|~|～|—|至)\s*\d+(?:\.\d+)?\s*秒/u

export function storyboardAtomicityIssues(
  shots: CompactShotInput[],
  locations: StoryboardLocationAsset[] = [],
) {
  return shots.flatMap((inputShot, index): StoryboardAtomicityIssue[] => {
    const shot = normalizeCompactShot(inputShot)
    const reasons: string[] = []
    const sceneText = [shot.n, shot.e, shot.f, shot.s, shot.v, shot.a, shot.g].join('\n')
    const allText = [shot.t, sceneText, shot.c].join('\n')
    const exactLocations = locations.filter((location) => (
      normalizedStoryboardLocation(sceneText).includes(normalizedStoryboardLocation(location.name))
    ))
    const matchedLocations = [...new Map(
      [...exactLocations, ...storyboardSemanticLocationMatches(sceneText, locations)]
        .map((location) => [location.name, location]),
    ).values()]

    if (MULTI_BEAT_STORYBOARD_TITLE.test(shot.t)) reasons.push('标题串联了多个剧情节点')
    if (shot.n.split('｜').length !== 2 || shot.n.includes('\n')) reasons.push('时间地点不是单一“时间｜地点”')
    if (matchedLocations.length > 1) reasons.push(`同一镜出现多个地点：${matchedLocations.map((location) => location.name).join('、')}`)
    if (LOCATION_TRANSITION_IN_SHOT.test(sceneText)) reasons.push('同一镜包含地点或时空切换')
    if (MULTI_SETUP_CAMERA.test(shot.c)) reasons.push('同一镜包含快切、多角度或多个机位')
    if (PACKED_TIMELINE_MARKER.test(allText)) reasons.push('同一镜已经包含多个带时间段的子镜头')
    if (shot.d < 4 || shot.d > 6) reasons.push(`镜头时长为 ${shot.d} 秒，超出原子分镜 4-6 秒范围`)

    return reasons.length > 0 ? [{ index, title: shot.t, reasons }] : []
  })
}

export type StoryboardContinuityIssue = {
  index: number
  title: string
  reasons: string[]
}

const COMPLETED_FALL = /(?:坠入|坠落|跌落|掉下|失去支撑.{0,12}下坠|身体迅速向下|falls?\s+(?:into|from)|plunges?)/iu
const RESTORED_CLIFF_HOLD = /(?:悬在.{0,12}崖|抠住.{0,10}崖|抓住.{0,10}崖|扒住.{0,10}崖|hangs?\s+from\s+the\s+cliff|clings?\s+to\s+the\s+cliff)/iu
const COMPLETED_COLLAPSE = /(?:倒地|瘫倒|昏倒|失去意识|collapses?|falls?\s+unconscious)/iu
const RESTORED_STANDING = /(?:站起|重新起身|起身)/u
const STANDING_WITHOUT_RECOVERY = /(?:站在|站立|快步走|继续行走|walks?|stands?)/iu
const COMPLETED_BLACKOUT = /(?:画面|镜头)?(?:直接)?切黑|画面全黑|黑屏/u
const EXPLICIT_TIME_RESET = /(?:回忆|倒叙|闪回|时间倒回|回到主线|重新起身|从黑屏渐亮|淡入|flashback|time\s+rewinds?|fade\s+in)/iu
const SPOKEN_AUDIO_CONFLICT = /(?:无配音|不生成配音|无对白|全程不说话|说话人无对白)/u
const COLLAPSE_SUBJECT_PATTERN = /(?:^|[\n，。；;：:])\s*([\p{L}\p{N}·•.'’ _-]{1,40}?)\s*(?:倒地|瘫倒|昏厥|失去意识|collapses?|falls?\s+unconscious)/gimu
const STANDING_SUBJECT_PATTERN = /(?:^|[\n，。；;：:])\s*([\p{L}\p{N}·•.'’ _-]{1,40}?)\s*(?:站在|站立|站起|重新起身|继续行走|快步走|walks?|stands?)/gimu

function storyboardStateSubjects(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].map((match) => match[1]
    .replace(/^(?:先|随后|然后|最后|同时|画面中)\s*/u, '')
    .trim()
    .toLocaleLowerCase())
    .filter(Boolean)
}

function normalizedDialogueKey(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function estimatedDialogueSeconds(value: string) {
  const hanCharacters = value.match(/\p{Script=Han}/gu)?.length || 0
  const latinWords = value.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0
  return hanCharacters / 4 + latinWords / 2.5
}

function extractStoryboardShotDialogues(value: string) {
  const markerPattern = /(?:^|(?<=[\n；;。.!?])\s*)([\p{L}\p{N}·•.'’ _-]{1,32})(【OS】)?[：:]\s*/gmu
  const matches = [...value.matchAll(markerPattern)]
  if (matches.length === 0) {
    return value
      .split(/[\r\n；;]+/u)
      .flatMap((segment) => extractScriptDialogueLines(segment.trim()))
  }
  return matches.flatMap((match, index) => {
    const start = (match.index || 0) + match[0].length
    const end = matches[index + 1]?.index ?? value.length
    const text = value.slice(start, end).trim().replace(/^[\s，,]+|[\s；;]+$/gu, '')
    if (!text || /^(?:[（(]?无对白[）)]?|no dialogue)$/iu.test(text)) return []
    return [{
      speaker: match[1].trim(),
      os: Boolean(match[2]),
      text,
    }]
  })
}

function normalizedStoryboardSpeaker(value: string) {
  return value
    .replace(/【OS】/gu, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/\s+/gu, '')
    .trim()
}

function normalizedStoryboardDialogueText(value: string) {
  const normalized = value
    .replace(/[\s“”「」『』'"，。！？：；、,.!?:~～…@￥&]/gu, '')
    .replace(/^嗯+/gu, '')
    .replace(/没没(?:啊)?/gu, '没有')
  return normalized.length > 2
    ? normalized.replace(/[啊呀呢吧]+$/gu, '')
    : normalized
}

function storyboardDialogueLcsRatio(source: string, candidate: string) {
  if (!source || !candidate) return 0
  let previous = new Uint16Array(candidate.length + 1)
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    const current = new Uint16Array(candidate.length + 1)
    for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
      current[candidateIndex + 1] = source[sourceIndex] === candidate[candidateIndex]
        ? previous[candidateIndex] + 1
        : Math.max(previous[candidateIndex + 1], current[candidateIndex])
    }
    previous = current
  }
  return previous[candidate.length] / source.length
}

function storyboardDialogueBigramCoverage(source: string, candidate: string) {
  if (source.length < 2) return candidate.includes(source) ? 1 : 0
  const sourceBigrams = new Set(
    Array.from({ length: source.length - 1 }, (_value, index) => source.slice(index, index + 2)),
  )
  let matched = 0
  for (const bigram of sourceBigrams) {
    if (candidate.includes(bigram)) matched++
  }
  return matched / Math.max(1, sourceBigrams.size)
}

function storyboardDialogueNumericFacts(value: string) {
  return value.match(/(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万]+)(?:万|岁|年|块|元)/gu) || []
}

function storyboardDialogueMeaningCovered(sourceValue: string, candidateValue: string) {
  const source = normalizedStoryboardDialogueText(sourceValue)
  const candidate = normalizedStoryboardDialogueText(candidateValue)
  if (!source || !candidate) return false
  if (candidate.includes(source)) return true
  if (source.length < 2 || candidate.length < 2) return false
  const numericFacts = storyboardDialogueNumericFacts(sourceValue)
  if (numericFacts.some((fact) => !candidateValue.includes(fact))) return false
  const lcsRatio = storyboardDialogueLcsRatio(source, candidate)
  const bigramCoverage = storyboardDialogueBigramCoverage(source, candidate)
  const retainedLength = Math.min(1, candidate.length / source.length)
  if (source.length <= 8) return lcsRatio >= 0.75 && retainedLength >= 0.6
  if (source.length <= 20) return lcsRatio >= 0.48 && bigramCoverage >= 0.3 && retainedLength >= 0.4
  return lcsRatio >= 0.45 && bigramCoverage >= 0.28 && retainedLength >= 0.35
}

export function storyboardDialogueMissing(
  inputShots: CompactShotInput[],
  sourceDialogue: { speaker: string; text: string; os?: boolean },
) {
  if (normalizedStoryboardDialogueText(sourceDialogue.text).length < 2) return false
  const sourceSpeaker = normalizedStoryboardSpeaker(sourceDialogue.speaker)
  const generated = inputShots.flatMap((inputShot) => (
    extractStoryboardShotDialogues(normalizeCompactShot(inputShot).a)
  ))
  const candidates: string[] = []
  for (let index = 0; index < generated.length; index++) {
    if (normalizedStoryboardSpeaker(generated[index].speaker) !== sourceSpeaker) continue
    if (sourceDialogue.os !== undefined && generated[index].os !== sourceDialogue.os) continue
    let combined = ''
    for (let cursor = index; cursor < Math.min(generated.length, index + 5); cursor++) {
      if (normalizedStoryboardSpeaker(generated[cursor].speaker) !== sourceSpeaker) break
      if (sourceDialogue.os !== undefined && generated[cursor].os !== sourceDialogue.os) break
      combined += generated[cursor].text
      candidates.push(combined)
    }
  }
  return !candidates.some((candidate) => storyboardDialogueMeaningCovered(sourceDialogue.text, candidate))
}

export function dedupeStoryboardDialogueShots(
  inputShots: CompactShotInput[],
  options: {
    script?: string
    visualStyle?: VisualStyle
  } = {},
) {
  const sourceCounts = new Map<string, number>()
  for (const dialogue of options.script ? extractScriptDialogueLines(options.script) : []) {
    const key = `${dialogue.speaker}:${dialogue.os ? 'os' : 'spoken'}:${normalizedDialogueKey(dialogue.text)}`
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1)
  }
  const hasMarkedColdOpen = Boolean(
    options.script?.includes(SCRIPT_COLD_OPEN_START)
    && options.script.includes(SCRIPT_MAIN_TIMELINE_START),
  )
  const seenCounts = new Map<string, number>()

  return inputShots.map((inputShot): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    const dialogues = extractStoryboardShotDialogues(shot.a)
    if (dialogues.length === 0) return shot

    const retained = dialogues.filter((dialogue) => {
      const normalizedText = normalizedDialogueKey(dialogue.text)
      if (normalizedText.length < 2) return true
      const key = `${dialogue.speaker}:${dialogue.os ? 'os' : 'spoken'}:${normalizedText}`
      const seenCount = seenCounts.get(key) || 0
      const allowedCount = sourceCounts.get(key)
        || (options.visualStyle === VisualStyle.overseas_live_action && hasMarkedColdOpen ? 2 : 1)
      if (seenCount >= allowedCount) return false
      seenCounts.set(key, seenCount + 1)
      return true
    })
    if (retained.length === dialogues.length) return shot
    if (retained.length === 0) {
      return {
        ...shot,
        t: shot.t.replace(/（对白续镜\s*\d+）/gu, '').trim() || '无对白反应',
        a: '无对白。',
        q: '无对白；保留人物自然呼吸和现场反应。',
        o: '保留当前场景环境声和必要音效；无背景音乐、无字幕。',
      }
    }
    return {
      ...shot,
      a: retained.map((dialogue) => (
        `${dialogue.speaker}${dialogue.os ? '【OS】' : ''}：${dialogue.text}`
      )).join('；'),
    }
  })
}

function splitDialogueTextForTiming(text: string, maximumSeconds: number) {
  if (estimatedDialogueSeconds(text) <= maximumSeconds) return [text]
  const hanCharacters = text.match(/\p{Script=Han}/gu)?.length || 0
  const latinWords = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)?.length || 0
  if (latinWords >= hanCharacters) {
    const maximumWords = Math.max(5, Math.floor(maximumSeconds * 2.5))
    const protectedText = text.replace(/\b(Mr|Mrs|Ms|Dr|Prof|St)\./giu, '$1<prd>')
    const restoreAbbreviations = (value: string) => value.replace(/<prd>/gu, '.')
    const sentenceUnits = protectedText.match(/[^,;.!?]+[,;.!?]+|[^,;.!?]+$/gu)
      ?.map((sentence) => restoreAbbreviations(sentence.trim()))
      .filter(Boolean) || [text]
    const groups: string[] = []
    for (const sentence of sentenceUnits) {
      const words = sentence.split(/\s+/u).filter(Boolean)
      if (words.length > maximumWords) {
        const chunkCount = Math.ceil(words.length / maximumWords)
        const balancedSize = Math.ceil(words.length / chunkCount)
        const chunks: string[][] = []
        for (let index = 0; index < words.length; index += balancedSize) {
          chunks.push(words.slice(index, index + balancedSize))
        }
        for (let index = 0; index < chunks.length - 1; index++) {
          const lastWord = chunks[index].at(-1)?.replace(/[^A-Za-z']/gu, '').toLocaleLowerCase() || ''
          if (/^(?:a|an|the|of|to|for|from|with|and|or|but|as)$/u.test(lastWord) && chunks[index + 1].length > 0) {
            chunks[index].push(chunks[index + 1].shift() as string)
          }
        }
        groups.push(...chunks.filter((chunk) => chunk.length > 0).map((chunk) => chunk.join(' ')))
        continue
      }
      const current = groups.at(-1)
      const currentWords = current?.split(/\s+/u).filter(Boolean).length || 0
      if (current && currentWords + words.length <= maximumWords) {
        groups[groups.length - 1] = `${current} ${sentence}`
      } else {
        groups.push(sentence)
      }
    }
    return groups.filter(Boolean)
  }
  const maximumCharacters = Math.max(8, Math.floor(maximumSeconds * 4))
  const clauses = text.match(/[^，,；;。！？!?]+[，,；;。！？!?]?/gu)?.map((item) => item.trim()).filter(Boolean)
    || [text]
  const groups: string[] = []
  const protectedWords = /要不|富婆|大学|学姐|腰子|身份证|迈巴赫|民政局|洛雪微|林夏|陆野/gu
  const splitLongClause = (clause: string) => {
    const characters = [...clause]
    const chunkCount = Math.ceil(characters.length / maximumCharacters)
    const balancedSize = Math.ceil(characters.length / chunkCount)
    const chunks: string[] = []
    let start = 0
    while (start < characters.length) {
      let end = Math.min(characters.length, start + balancedSize)
      if (end < characters.length) {
        const joined = characters.join('')
        for (const match of joined.matchAll(protectedWords)) {
          const wordStart = match.index || 0
          const wordEnd = wordStart + match[0].length
          if (wordStart < end && end < wordEnd) {
            end = wordStart - start >= Math.max(6, Math.floor(balancedSize * 0.55))
              ? wordStart
              : wordEnd
            break
          }
        }
      }
      if (end <= start) end = Math.min(characters.length, start + balancedSize)
      chunks.push(characters.slice(start, end).join(''))
      start = end
    }
    return chunks
  }
  for (const clause of clauses) {
    if ([...clause].length > maximumCharacters) {
      groups.push(...splitLongClause(clause))
      continue
    }
    const current = groups.at(-1) || ''
    if (current && [...current, ...clause].length <= maximumCharacters) {
      groups[groups.length - 1] = `${current}${clause}`
    } else {
      groups.push(clause)
    }
  }
  return groups.filter(Boolean)
}

export function splitOverlongStoryboardDialogueShots(inputShots: CompactShotInput[]) {
  return inputShots.flatMap((inputShot): CompactShot[] => {
    const normalizedShot = normalizeCompactShot(inputShot)
    const requestedDuration = Number(inputShot.d)
    const shot = Number.isInteger(requestedDuration) && requestedDuration >= 3 && requestedDuration <= 15
      ? { ...normalizedShot, d: requestedDuration }
      : normalizedShot
    const dialogues = extractStoryboardShotDialogues(shot.a)
    const currentSeconds = dialogues.reduce(
      (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
      dialogues.length > 0 ? 0.5 + Math.max(0, dialogues.length - 1) * 0.5 : 0,
    )
    if (dialogues.length === 0 || currentSeconds <= shot.d + 0.05) return [shot]

    const originalEnding = [shot.s, shot.m, shot.v, shot.g, shot.x].join('\n')
    const hasTerminalAction = COMPLETED_FALL.test(originalEnding)
      || COMPLETED_COLLAPSE.test(originalEnding)
      || COMPLETED_BLACKOUT.test(originalEnding)
    const maximumDialogueSeconds = hasTerminalAction ? 4 : 5
    const maximumGroupSeconds = hasTerminalAction ? 4.75 : 5.75
    const emotionalPovOwner = normalizedDirectorPovOwner(
      shot.i.match(STORYBOARD_EMOTIONAL_POV)?.[1] || '',
    )
    const reactionOwner = emotionalPovOwner && !/^(?:场景|环境|空间|无)$/u.test(emotionalPovOwner)
      ? emotionalPovOwner
      : ''
    const units = dialogues.flatMap((dialogue) => (
      splitDialogueTextForTiming(dialogue.text, maximumDialogueSeconds).map((text) => ({ ...dialogue, text }))
    ))
    const groups: typeof units[] = []
    for (const unit of units) {
      const current = groups.at(-1)
      const candidate = [...(current || []), unit]
      const candidateSeconds = candidate.reduce(
        (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
        0.5 + Math.max(0, candidate.length - 1) * 0.5,
      )
      if (current && candidateSeconds <= maximumGroupSeconds) current.push(unit)
      else groups.push([unit])
    }

    return groups.map((group, index): CompactShot => {
      const duration = Math.max(4, Math.min(6, Math.ceil(group.reduce(
        (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
        0.5 + Math.max(0, group.length - 1) * 0.5,
      ))))
      const dialogueText = group.map((dialogue) => (
        `${dialogue.speaker}${dialogue.os ? '【OS】' : ''}：${dialogue.text}`
      )).join('；')
      const speakerNames = [...new Set(group.map((dialogue) => dialogue.speaker))]
      const continuation = index > 0
      const finalGroup = index === groups.length - 1
      const holdTerminalAction = hasTerminalAction && !finalGroup
      const dialogueAction = `${speakerNames.join('、')}按顺序完成本段现场对白，其余人物保持倾听；本镜不提前执行后续不可逆动作。`
      const continuationCamera = index % 3 === 1
        ? `${reactionOwner || '主要倾听者'}正面或清晰侧面近景，固定机位，优先读取触发后的面部反应`
        : index % 3 === 2
          ? `从${reactionOwner || '主要倾听者'}肩后拍摄的双人中近景，过肩固定机位，同时保留说话者口型和倾听者侧脸`
          : continuation
            ? `关系双人中景，侧面轻微手持，保持说话者与${reactionOwner || '主要倾听者'}的视线关系`
            : shot.c
      const continuationReaction = reactionOwner
        ? `${reactionOwner}保持正脸或清晰侧脸可见；触发台词结束后保留${reactionOwner}至少一秒可读反应，具体呈现视线、眉眼或嘴角变化。`
        : '主要倾听者保持正脸或清晰侧脸可见；触发台词结束后保留至少一秒可读反应。'
      return normalizeCompactShot({
        ...shot,
        t: continuation ? `${shot.t}（对白续镜 ${index + 1}）`.slice(0, 120) : shot.t,
        p: continuation ? '严格承接上一镜尾帧，人物、站位、视线、手部、道具和场景均不重置。' : shot.p,
        c: continuationCamera,
        f: continuation
          ? `从上一镜尾帧直接继续；${reactionOwner || '主要倾听者'}正脸或清晰侧脸在画内，当前说话者开始本段口型。`
          : shot.f,
        s: holdTerminalAction
          ? dialogueAction
          : hasTerminalAction && finalGroup
            ? `先由${speakerNames.join('、')}按顺序完成本段现场对白；对白结束后再连续执行：${shot.s}`
            : continuation
              ? `先保持上一镜结束姿态；随后${speakerNames.join('、')}按顺序继续现场对白；最后在本段对白结束后自然停顿。`
              : shot.s,
        m: holdTerminalAction
          ? '人物保持动作发生前的稳定支撑、站位、重心、手部和道具状态，不坠落、不倒地、不离场、不切黑。'
          : continuation && !hasTerminalAction
            ? '人物保持稳定站位和重心，不发生新的身体接触、换位、换手或道具转移。'
            : shot.m,
        v: holdTerminalAction
          ? `${speakerNames.join('、')}自然同步口型，${continuationReaction}画面持续处于不可逆动作发生前。`
          : continuation && !hasTerminalAction
            ? `${speakerNames.join('、')}按对白顺序自然同步口型；${continuationReaction}`
            : shot.v,
        a: dialogueText,
        q: `${speakerNames.join('、')}沿用固定声线和自然语速；无旁白、无后期配音感，保留演员现场对白。`,
        o: '保留演员现场对白、当前场景环境声和必要音效；无背景音乐、无字幕。',
        g: holdTerminalAction
          ? `本段对白结束，${reactionOwner || '主要倾听者'}正脸或清晰侧脸仍可见，人物保持不可逆动作发生前的站位、支撑、手部、视线和道具状态。`
          : continuation && !hasTerminalAction
            ? `本段对白结束，${reactionOwner || '主要倾听者'}的具体面部反应成为尾帧焦点；人物保持当前站位、朝向、手部、视线、服装和道具状态。`
            : shot.g,
        x: holdTerminalAction
          ? '下一镜从完全相同的动作前状态继续剩余对白，不重置人物或道具。'
          : shot.x,
        d: duration,
      })
    })
  })
}

export function normalizeOverseasStoryboardDialogueTerms(inputShots: CompactShotInput[]) {
  return inputShots.map((inputShot): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    return {
      ...shot,
      a: shot.a
        .replace(/[ \t]*议会[ \t]*/gu, ' Council ')
        .replace(/[ \t]*狼群[ \t]*/gu, ' pack ')
        .replace(/[ \t]{2,}/gu, ' ')
        .replace(/[ \t]+([.,!?;:])/gu, '$1'),
    }
  })
}

export function normalizeStoryboardSpokenAudioRules(inputShots: CompactShotInput[]) {
  return inputShots.map((inputShot): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    const dialogues = extractStoryboardShotDialogues(shot.a)
    if (dialogues.length === 0) return shot
    const onsiteDialogues = dialogues.filter((dialogue) => !isStoryboardVoiceover(dialogue))
    const voiceovers = dialogues.filter(isStoryboardVoiceover)
    const onsiteNames = [...new Set(onsiteDialogues.map((dialogue) => dialogue.speaker))]
    const voiceoverNames = [...new Set(voiceovers.map((dialogue) => dialogue.speaker))]
    const voiceoverRule = voiceovers.length > 0
      ? `${voiceoverNames.join('、')}的原剧本旁白、画外音或【OS】完整保留，禁止画面人物为其对口型。`
      : ''
    return {
      ...shot,
      q: onsiteDialogues.length > 0
        ? `${onsiteNames.join('、')}沿用固定声线和自然语速；无新增旁白、无后期配音感，保留演员现场对白。${voiceoverRule}`
        : voiceoverRule,
      o: `${onsiteDialogues.length > 0 ? '保留演员现场对白、' : ''}${voiceovers.length > 0 ? '保留原剧本旁白、画外音和【OS】、' : ''}当前场景环境声和必要音效；无背景音乐、无字幕。`,
    }
  })
}

export function storyboardContinuityIssues(
  inputShots: CompactShotInput[],
  clipSeconds = 15,
) {
  const shots = inputShots.map(normalizeCompactShot)
  const reasonsByIndex = new Map<number, string[]>()
  const addReason = (index: number, reason: string) => {
    const reasons = reasonsByIndex.get(index) || []
    if (!reasons.includes(reason)) reasons.push(reason)
    reasonsByIndex.set(index, reasons)
  }

  for (let index = 1; index < shots.length; index++) {
    const previous = shots[index - 1]
    const current = shots[index]
    if (storyboardLocationFromNote(previous.n) !== storyboardLocationFromNote(current.n)) continue
    const previousEnd = [previous.s, previous.v, previous.a, previous.g].join('\n')
    const currentStart = [current.p, current.f, current.s, current.v, current.a].join('\n')
    const transition = [previous.x, current.n, current.p, current.f].join('\n')
    if (EXPLICIT_TIME_RESET.test(transition)) continue
    if (COMPLETED_FALL.test(previousEnd) && RESTORED_CLIFF_HOLD.test(currentStart)) {
      addReason(index, '上一镜已经完成坠落，下一镜却恢复为悬挂或抓住崖边的旧状态')
    }
    if (COMPLETED_COLLAPSE.test(previousEnd)
      && STANDING_WITHOUT_RECOVERY.test(currentStart)
      && !RESTORED_STANDING.test(currentStart)) {
      const collapsedSubjects = storyboardStateSubjects(previousEnd, COLLAPSE_SUBJECT_PATTERN)
      const standingSubjects = storyboardStateSubjects(currentStart, STANDING_SUBJECT_PATTERN)
      const restoresSameSubject = collapsedSubjects.some((collapsed) => standingSubjects.some((standing) => (
        collapsed.includes(standing) || standing.includes(collapsed)
      )))
      if (restoresSameSubject) {
        addReason(index, '上一镜已经倒地或失去意识，下一镜未写起身过程却恢复站立或行走')
      }
    }
    if (COMPLETED_BLACKOUT.test(previousEnd) && !EXPLICIT_TIME_RESET.test(currentStart)) {
      addReason(index, '上一镜已经切黑，下一镜在同一时空继续动作或对白但没有淡入、倒叙或时间转换')
    }
  }

  const safeClipSeconds = Math.max(4, Math.min(15, Math.round(clipSeconds)))
  let clipIndex = 1
  let clipDuration = 0
  let clipLocation = ''
  let seenDialogues = new Map<string, number>()
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index]
    const location = storyboardLocationFromNote(shot.n)
    if (clipDuration > 0 && (location !== clipLocation || clipDuration + shot.d > safeClipSeconds)) {
      clipIndex++
      clipDuration = 0
      seenDialogues = new Map<string, number>()
    }
    if (clipDuration === 0) clipLocation = location
    clipDuration += shot.d

    const dialogues = extractStoryboardShotDialogues(shot.a)
    const estimatedSeconds = dialogues.reduce(
      (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
      dialogues.length > 0 ? 0.5 + Math.max(0, dialogues.length - 1) * 0.5 : 0,
    )
    if (estimatedSeconds > shot.d + 0.05) {
      addReason(index, `对白自然表演约需 ${estimatedSeconds.toFixed(1)} 秒，超过当前 ${shot.d} 秒镜头`)
    }
    if (dialogues.length > 0 && SPOKEN_AUDIO_CONFLICT.test([shot.q, shot.o].join('\n'))) {
      addReason(index, '镜头存在现场对白，但声音要求同时写了无配音、无对白或说话人无对白')
    }
    for (const dialogue of dialogues) {
      const normalizedText = normalizedDialogueKey(dialogue.text)
      if (normalizedText.length < 3) continue
      const key = `${dialogue.speaker}:${normalizedText}`
      const firstIndex = seenDialogues.get(key)
      if (firstIndex !== undefined) {
        addReason(index, `同一 15 秒段第 ${clipIndex} 段重复对白“${dialogue.speaker}：${dialogue.text}”`)
        addReason(firstIndex, `同一 15 秒段第 ${clipIndex} 段的这句对白在后镜再次出现`)
      } else {
        seenDialogues.set(key, index)
      }
    }
  }

  return [...reasonsByIndex.entries()].map(([index, reasons]): StoryboardContinuityIssue => ({
    index,
    title: shots[index]?.t || `镜头 ${index + 1}`,
    reasons,
  }))
}

export function storyboardEpisodeReviewIssues(
  inputShots: CompactShotInput[],
  options: {
    script?: string
    visualStyle?: VisualStyle
  } = {},
) {
  const shots = inputShots.map(normalizeCompactShot)
  const reasonsByIndex = new Map<number, string[]>()
  const addReason = (index: number, reason: string) => {
    const safeIndex = Math.max(0, Math.min(shots.length - 1, index))
    const reasons = reasonsByIndex.get(safeIndex) || []
    if (!reasons.includes(reason)) reasons.push(reason)
    reasonsByIndex.set(safeIndex, reasons)
  }
  if (shots.length === 0) return []

  const sourceDialogues = options.script
    ? extractScriptDialogueLines(options.script)
    : []
  const hasMarkedColdOpen = Boolean(
    options.script?.includes(SCRIPT_COLD_OPEN_START)
    && options.script.includes(SCRIPT_MAIN_TIMELINE_START),
  )
  const sourceCounts = new Map<string, number>()
  for (const dialogue of sourceDialogues) {
    const key = `${dialogue.speaker}:${dialogue.os ? 'os' : 'spoken'}:${normalizedDialogueKey(dialogue.text)}`
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1)
  }

  const seenDialogues = new Map<string, { count: number; firstIndex: number }>()
  let previousSourceDialogueIndex = -1
  let generatedDialogueCount = 0
  for (let index = 0; index < shots.length; index++) {
    const dialogues = extractStoryboardShotDialogues(shots[index].a)
    generatedDialogueCount += dialogues.length
    for (const dialogue of dialogues) {
      const normalizedText = normalizedDialogueKey(dialogue.text)
      if (normalizedText.length < 2) continue
      if (options.visualStyle === VisualStyle.overseas_live_action && /\p{Script=Han}/u.test(dialogue.text)) {
        addReason(index, `海外真人短剧的现场对白仍含中文“${dialogue.text}”，必须改为自然美式英语`)
      }

      const key = `${dialogue.speaker}:${dialogue.os ? 'os' : 'spoken'}:${normalizedText}`
      const seen = seenDialogues.get(key)
      const nextCount = (seen?.count || 0) + 1
      const allowedCount = sourceCounts.get(key)
        || (options.visualStyle === VisualStyle.overseas_live_action && hasMarkedColdOpen ? 2 : 1)
      if (nextCount > allowedCount) {
        addReason(index, `整集重复对白“${dialogue.speaker}：${dialogue.text}”`)
        if (seen) addReason(seen.firstIndex, '这句对白在本集后续镜头被重复生成')
      }
      seenDialogues.set(key, { count: nextCount, firstIndex: seen?.firstIndex ?? index })

      if (options.visualStyle !== VisualStyle.overseas_live_action && options.script) {
        const sourceIndex = sourceDialogues.findIndex((source, candidateIndex) => (
          candidateIndex >= previousSourceDialogueIndex
          && source.speaker === dialogue.speaker
          && source.os === dialogue.os
          && normalizedDialogueKey(source.text) === normalizedText
        ))
        const anySourceIndex = sourceDialogues.findIndex((source) => (
          source.speaker === dialogue.speaker
          && source.os === dialogue.os
          && normalizedDialogueKey(source.text) === normalizedText
        ))
        if (sourceIndex < 0 && anySourceIndex >= 0) {
          addReason(index, `对白“${dialogue.speaker}：${dialogue.text}”出现在锁定剧本顺序之前`)
        }
        if (sourceIndex >= 0) previousSourceDialogueIndex = sourceIndex
      }
    }
  }

  if (options.visualStyle === VisualStyle.overseas_live_action
    && sourceDialogues.length > 0
    && generatedDialogueCount < sourceDialogues.length) {
    addReason(
      shots.length - 1,
      `海外英语现场对白仅 ${generatedDialogueCount} 句，少于锁定剧本需要覆盖的 ${sourceDialogues.length} 句`,
    )
  }

  return [...reasonsByIndex.entries()].map(([index, reasons]): StoryboardContinuityIssue => ({
    index,
    title: shots[index]?.t || `镜头 ${index + 1}`,
    reasons,
  }))
}

const STORYBOARD_DIRECTOR_INTENT = /(?:^|[；;\n])\s*意图\s*[：:]/u
const STORYBOARD_EMOTIONAL_POV = /(?:^|[；;\n])\s*情绪视点\s*[：:]\s*([^；;\n]+)/u
const STORYBOARD_EMOTIONAL_TRIGGER = /(?:^|[；;\n])\s*触发\s*[：:]/u
const STORYBOARD_EMOTIONAL_END_BEAT = /(?:^|[；;\n])\s*情绪落点\s*[：:]/u
const STORYBOARD_FACE_REACTION = /正脸|清晰侧脸|面部|眼神|瞳孔|眉(?:眼|头)?|眼眶|嘴角|嘴唇|下颌|喉结|泪|表情|面肌/u
const STORYBOARD_HIDDEN_FACE = /背影|背对(?:镜头|摄影机)|面部不可见|看不清.{0,6}(?:脸|面部)|脸部被遮挡/u

function normalizedDirectorPovOwner(value: string) {
  return value
    .replace(/\s*[（(].*$/u, '')
    .replace(/^(?:人物|角色)\s*[：:]?/u, '')
    .trim()
}

function directorPovAliases(owner: string) {
  const aliases = [owner]
  const firstName = owner.split(/[·•]/u)[0]?.trim()
  if (firstName && firstName.length >= 2) aliases.push(firstName)
  return [...new Set(aliases)]
}

function storyboardCameraSignature(value: string) {
  const scales = value.match(/大特写|特写|中近景|近景|中景|全景|远景/g) || []
  const angles = value.match(/正面|侧面|背面|过肩|俯拍|仰拍|平拍/g) || []
  const moves = value.match(/固定|跟拍|推镜|拉镜|摇镜|横移|手持|环绕|甩镜/g) || []
  const signature = [...new Set([...scales, ...angles, ...moves])].join('|')
  return signature || value.replace(/[\s，,。；;]+/gu, '').slice(0, 60)
}

export function storyboardDirectorIssues(inputShots: CompactShotInput[]) {
  const shots = inputShots.map(normalizeCompactShot)
  const reasonsByIndex = new Map<number, string[]>()
  const addReason = (index: number, reason: string) => {
    const reasons = reasonsByIndex.get(index) || []
    if (!reasons.includes(reason)) reasons.push(reason)
    reasonsByIndex.set(index, reasons)
  }

  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index]
    if (!STORYBOARD_DIRECTOR_INTENT.test(shot.i)
      || !STORYBOARD_EMOTIONAL_POV.test(shot.i)
      || !STORYBOARD_EMOTIONAL_TRIGGER.test(shot.i)
      || !STORYBOARD_EMOTIONAL_END_BEAT.test(shot.i)) {
      addReason(index, '缺少完整导演意图 i：必须包含意图、情绪视点、触发和情绪落点')
      continue
    }

    const owner = normalizedDirectorPovOwner(shot.i.match(STORYBOARD_EMOTIONAL_POV)?.[1] || '')
    if (!owner || /^(?:场景|环境|空间|无)$/u.test(owner)) continue

    const visiblePerformance = [shot.f, shot.v, shot.g].join('\n')
    const ownerAliases = directorPovAliases(owner)
    const ownerVisible = ownerAliases.some((alias) => visiblePerformance.includes(alias))
    if (!ownerVisible) {
      addReason(index, `情绪视点角色“${owner}”没有出现在首帧、表演或尾帧画面中`)
    }
    if (!STORYBOARD_FACE_REACTION.test(visiblePerformance)) {
      addReason(index, `情绪视点角色“${owner}”缺少正脸或清晰侧脸的具体微表情反应`)
    }
    if (STORYBOARD_HIDDEN_FACE.test(visiblePerformance) && !STORYBOARD_FACE_REACTION.test(visiblePerformance)) {
      addReason(index, `情绪视点角色“${owner}”只以背影或遮挡状态出现，观众无法读取情绪`)
    }

    const dialogues = extractStoryboardShotDialogues(shot.a)
    const otherSpeakerTriggersEmotion = dialogues.some((dialogue) => !ownerAliases.some((alias) => (
      dialogue.speaker === alias
      || dialogue.speaker.includes(alias)
      || alias.includes(dialogue.speaker)
    )))
    if (otherSpeakerTriggersEmotion && (!ownerVisible || !STORYBOARD_FACE_REACTION.test(visiblePerformance))) {
      addReason(index, `对手台词触发“${owner}”情绪，但镜头没有保留“${owner}”的可读倾听反应`)
    }
  }

  for (let index = 2; index < shots.length; index++) {
    const run = shots.slice(index - 2, index + 1)
    const sameLocation = run.every((shot) => (
      storyboardLocationFromNote(shot.n) === storyboardLocationFromNote(run[0].n)
    ))
    const signatures = run.map((shot) => storyboardCameraSignature(shot.c))
    if (sameLocation && signatures[0] && signatures.every((signature) => signature === signatures[0])) {
      addReason(index, `同一场景连续三个镜头使用相同景别、角度和运动“${signatures[0]}”，情绪镜头缺少推进`)
    }
  }

  return [...reasonsByIndex.entries()].map(([index, reasons]): StoryboardContinuityIssue => ({
    index,
    title: shots[index]?.t || `镜头 ${index + 1}`,
    reasons,
  }))
}

function replaceHiddenPovFraming(value: string) {
  return value
    .replace(/(?:只(?:以|有))?背影(?:状态)?/gu, '清晰侧脸状态')
    .replace(/背对(?:镜头|摄影机)/gu, '侧身面对摄影机并露出清晰侧脸')
    .replace(/面部不可见|脸部被遮挡|看不清.{0,6}(?:脸|面部)/gu, '面部清晰可见')
}

export function repairStoryboardDirectorCoverage(inputShots: CompactShotInput[]) {
  const repaired = inputShots.map((inputShot): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    const owner = normalizedDirectorPovOwner(shot.i.match(STORYBOARD_EMOTIONAL_POV)?.[1] || '')
    if (!owner || /^(?:场景|环境|空间|无)$/u.test(owner)) return shot

    const aliases = directorPovAliases(owner)
    const visiblePerformance = [shot.f, shot.v, shot.g].join('\n')
    const ownerVisible = aliases.some((alias) => visiblePerformance.includes(alias))
    const faceReadable = STORYBOARD_FACE_REACTION.test(visiblePerformance)
    const hiddenFace = STORYBOARD_HIDDEN_FACE.test(visiblePerformance)
    if (ownerVisible && faceReadable && !hiddenFace) return shot

    const repairedFirstFrame = replaceHiddenPovFraming(shot.f)
    const repairedPerformance = replaceHiddenPovFraming(shot.v)
    const repairedEndFrame = replaceHiddenPovFraming(shot.g)
    return normalizeCompactShot({
      ...shot,
      c: hiddenFace || !faceReadable
        ? `${owner}正面或清晰侧面中近景，固定机位，优先读取情绪反应`
        : shot.c,
      f: `${repairedFirstFrame}${repairedFirstFrame ? '；' : ''}${owner}正脸或清晰侧脸位于画面可读位置。`,
      v: `${repairedPerformance}${repairedPerformance ? '；' : ''}触发发生后保留${owner}至少一秒可读反应：${owner}的视线停顿，眉眼收紧，嘴角克制变化。`,
      g: `${repairedEndFrame}${repairedEndFrame ? '；' : ''}${owner}正脸或清晰侧脸保持清晰，具体面部反应成为尾帧焦点。`,
    })
  })

  for (let index = 2; index < repaired.length; index++) {
    const run = repaired.slice(index - 2, index + 1)
    const sameLocation = run.every((shot) => (
      storyboardLocationFromNote(shot.n) === storyboardLocationFromNote(run[0].n)
    ))
    const signatures = run.map((shot) => storyboardCameraSignature(shot.c))
    if (!sameLocation || !signatures[0] || !signatures.every((signature) => signature === signatures[0])) continue

    const shot = repaired[index]
    const owner = normalizedDirectorPovOwner(shot.i.match(STORYBOARD_EMOTIONAL_POV)?.[1] || '')
    repaired[index] = normalizeCompactShot({
      ...shot,
      c: owner && !/^(?:场景|环境|空间|无)$/u.test(owner)
        ? `${owner}正面特写，固定机位，以视线和嘴角变化完成情绪落点`
        : '侧面关系中景，轻微手持，以空间关系完成本镜落点',
    })
  }

  return repaired
}

export function actionableStoryboardFinalReviewIssues(
  issues: string[],
  options: {
    script: string
    shots: CompactShotInput[]
    allowedLocationNames: string[]
  },
) {
  const hasMarkedColdOpen = options.script.includes(SCRIPT_COLD_OPEN_START)
    && options.script.includes(SCRIPT_MAIN_TIMELINE_START)
  const hasDialogueContinuations = options.shots.some((shot) => /对白续镜/u.test(String(shot.t || '')))
  const hasUnderwaterLocation = options.allowedLocationNames.some((name) => /深海|海底|水下/u.test(name))

  return issues.filter((issue) => {
    if (hasMarkedColdOpen && (
      /(?:冷开场|倒叙).{0,100}(?:重复|删除|只保留)/u.test(issue)
      || /(?:重复|删除).{0,100}(?:冷开场|倒叙)/u.test(issue)
      || /重复.{0,80}(?:坠落|白狼|悬崖)/u.test(issue)
    )) return false
    if (hasDialogueContinuations && /对白.{0,100}(?:截断|不完整|补全|合并)/u.test(issue)) return false
    if (/结尾钩子缺失/u.test(issue) && /(?:已包含|当前镜头.{0,40}包含)/u.test(issue)) return false
    if (hasUnderwaterLocation
      && /(?:深海之下|海底深处|水下深处).{0,100}(?:不在白名单|添加.{0,20}白名单)/u.test(issue)) return false
    return true
  })
}

export function enforceSupplementalDialogue<T extends { a: string }>(
  shot: T,
  dialogue: { speaker: string; os: boolean; text: string },
): T {
  const speakerLabel = `${dialogue.speaker}${dialogue.os ? '【OS】' : ''}`
  const labels = [`${speakerLabel}：`, `${speakerLabel}:`]
  const markerIndex = labels
    .map((label) => shot.a.indexOf(label))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1
  const rawAction = markerIndex >= 0 ? shot.a.slice(0, markerIndex) : shot.a
  const action = rawAction
    .replace(/(?:[；;]\s*)?(?:无对白|无台词)\s*$/u, '')
    .replace(/[；;，,\s]+$/u, '')
    .trim()
  const exactDialogue = `${speakerLabel}：${dialogue.text}`
  const availableActionLength = Math.max(0, 4_999 - exactDialogue.length)
  return {
    ...shot,
    a: `${action.slice(0, availableActionLength)}${action ? '；' : ''}${exactDialogue}`,
  }
}

function insertMissingDialogueShots(input: {
  current: CompactShot[]
  supplemental: CompactShot[]
  script: string
  missing: Array<{ speaker: string; os: boolean; text: string }>
}) {
  const sourceDialogues = extractScriptDialogueLines(input.script)
  const result = [...input.current]
  const placements = input.supplemental.flatMap((shot) => {
    const sourceIndexes = input.missing.flatMap((missing) => {
      if (storyboardDialogueMissing([shot], missing)) return []
      const sourceIndex = sourceDialogues.findIndex(
        (dialogue) => dialogue.speaker === missing.speaker
          && dialogue.os === missing.os
          && dialogue.text === missing.text,
      )
      return sourceIndex >= 0 ? [sourceIndex] : []
    })
    return sourceIndexes.length > 0 ? [{ shot, sourceIndex: Math.min(...sourceIndexes) }] : []
  }).sort((left, right) => left.sourceIndex - right.sourceIndex)

  for (const placement of placements) {
    let insertionIndex = result.length
    for (const later of sourceDialogues.slice(Math.max(0, placement.sourceIndex + 1))) {
      const nextShotIndex = result.findIndex((shot) => !storyboardDialogueMissing([shot], later))
      if (nextShotIndex >= 0) {
        insertionIndex = nextShotIndex
        break
      }
    }
    result.splice(insertionIndex, 0, placement.shot)
  }
  return result
}

function storyboardField(value: string, fallback: string) {
  return value.trim() || fallback
}

export function stitchStoryboardContinuity(shots: CompactShotInput[], previousTail = '') {
  let inheritedTail = previousTail.trim()
  let previousEndedBlack = COMPLETED_BLACKOUT.test(inheritedTail)
  let previousSceneKey = ''
  return shots.map((inputShot, index): CompactShot => {
    const normalizedShot = normalizeCompactShot(inputShot)
    const requestedDuration = Number(inputShot.d)
    const shot = Number.isInteger(requestedDuration) && requestedDuration >= 3 && requestedDuration <= 15
      ? { ...normalizedShot, d: requestedDuration }
      : normalizedShot
    const currentSceneKey = storyboardLocationFromNote(shot.n)
    const sceneChanged = Boolean(previousSceneKey && currentSceneKey !== previousSceneKey)
    const firstFrame = previousEndedBlack
      ? `画面从全黑自然淡入${shot.n}，以${shot.c}建立新的可见画面，不恢复切黑前的动作状态。`
      : sceneChanged
        ? `切入${shot.n}，以${shot.c}重新建立当前场景的空间、人物站位和光线，不继承上一场景的陈设或人物位置。`
      : storyboardField(
        shot.f,
        inheritedTail
          ? `严格沿用上一镜尾帧中的人物站位、朝向、手部状态、视线、服装、道具、场景陈设、光线和焦点。`
          : `${shot.n}，以${shot.c}建立本镜开场，人物和场景状态与已锁定剧本一致。`,
      )
    const previousFrame = previousEndedBlack
      ? `上一镜已经切黑；本镜通过黑场淡入进入${shot.n}，按锁定剧本开始下一叙事节拍。`
      : sceneChanged
        ? `上一场景已经结束；本镜按剧本切入${shot.n}，从当前场景的初始人物站位和环境状态开始。`
      : inheritedTail || storyboardField(
        shot.p,
        index === 0
          ? `本集第一镜，从已锁定剧本的开场人物状态、场景陈设和光线开始。`
          : `承接上一镜尾帧，不重置人物和场景状态。`,
      )
    const tailFrame = storyboardField(
      shot.g,
      `${shot.v}；动作停止在可稳定承接下一镜的状态，保留人物站位、视线、服装、道具归属、场景陈设、光线和镜头焦点。`,
    )
    inheritedTail = tailFrame
    previousEndedBlack = COMPLETED_BLACKOUT.test([shot.s, shot.v, tailFrame, shot.x].join('\n'))
    previousSceneKey = storyboardEndLocationFromNote(shot.n)
    return {
      ...shot,
      p: previousFrame,
      f: firstFrame,
      g: tailFrame,
    }
  })
}

type StoryboardLocationAsset = {
  name: string
  description: string
  tags?: string[]
}

function normalizedStoryboardLocation(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

const STORYBOARD_LOCATION_SEMANTIC_GROUPS = [
  ['深海', '海底', '水下', '水中', '下沉', 'underwater', 'oceanfloor', 'beneaththesea'],
  ['悬崖', '崖边', '峭壁', '深渊', 'cliff', 'cliffside'],
  ['木屋', '小屋', '棚屋', 'cabin', 'hut'],
  ['森林', '树林', '林地', '林间', 'forest', 'woods'],
  ['石阵', '石环', 'stonecircle'],
  ['祭坛', 'altar'],
  ['实验室', 'laboratory', 'lab'],
] as const

function storyboardSemanticLocationMatches<T extends StoryboardLocationAsset>(context: string, locations: T[]) {
  const normalizedContext = normalizedStoryboardLocation(context)
  const matches = new Map<string, T>()
  for (const group of STORYBOARD_LOCATION_SEMANTIC_GROUPS) {
    const normalizedTerms = group.map(normalizedStoryboardLocation)
    if (!normalizedTerms.some((term) => normalizedContext.includes(term))) continue
    const candidates = locations.filter((location) => {
      const normalizedLocation = normalizedStoryboardLocation(location.name)
      return normalizedTerms.some((term) => normalizedLocation.includes(term))
    })
    if (candidates.length === 1) matches.set(candidates[0].name, candidates[0])
  }
  return [...matches.values()]
}

function uniqueLocationSemanticMatch<T extends StoryboardLocationAsset>(context: string, locations: T[]): T | undefined {
  const matches = storyboardSemanticLocationMatches(context, locations)
  return matches.length === 1 ? matches[0] : undefined
}

function explicitPhysicalLocationOverride<T extends StoryboardLocationAsset>(shot: CompactShot, locations: T[]) {
  const visibleContext = [shot.t, shot.s, shot.m, shot.v, shot.g].join('\n')
  const rules: Array<{ context: RegExp; location: RegExp }> = [
    { context: /(?:深海中|深海之下|深海深处|海底深处|海水.{0,16}(?:下沉|上浮)|水中.{0,16}(?:下沉|上浮)|水下空间)/u, location: /深海|海底|水下/u },
    { context: /(?:冲上沙滩|海浪拍打|沙滩|礁石|岸边)/u, location: /海岸|沙滩|岸边|礁石/u },
    { context: /(?:【?闪回】?|幼年.{0,30}(?:金属床|仪器|针管)|白色实验室)/u, location: /实验室/u },
    { context: /(?:壁炉|木床|木桌|木屋内)/u, location: /木屋(?!外)/u },
    { context: /(?:木屋外|屋外月光|屋外空地)/u, location: /木屋外|屋外/u },
  ]
  for (const rule of rules) {
    if (!rule.context.test(visibleContext)) continue
    const candidates = locations.filter((location) => rule.location.test(location.name))
    if (candidates.length === 1) return candidates[0]
  }
  return undefined
}

function storyboardEvidenceShingles(value: string) {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const characters = [...normalized]
  const shingles = new Set<string>()
  for (let index = 0; index <= characters.length - 3; index++) {
    shingles.add(characters.slice(index, index + 3).join(''))
  }
  return shingles
}

function storyboardLocationEvidenceMatch<T extends StoryboardLocationAsset>(shot: CompactShot, locations: T[]) {
  if (locations.length < 2) return undefined
  const shotShingles = storyboardEvidenceShingles([shot.t, shot.s, shot.m, shot.v, shot.a].join('\n'))
  if (shotShingles.size === 0) return undefined
  const locationShingles = locations.map((location) => storyboardEvidenceShingles(location.description))
  const frequencies = new Map<string, number>()
  for (const shingles of locationShingles) {
    for (const shingle of shingles) frequencies.set(shingle, (frequencies.get(shingle) || 0) + 1)
  }
  const ranked = locations.map((location, index) => ({
    location,
    score: [...locationShingles[index]].filter((shingle) => (
      frequencies.get(shingle) === 1 && shotShingles.has(shingle)
    )).length,
  })).sort((left, right) => right.score - left.score)
  const best = ranked[0]
  const second = ranked[1]
  return best && best.score >= 3 && best.score >= (second?.score || 0) + 2
    ? best.location
    : undefined
}

function storyboardTimeLabel(value: string) {
  const match = value.match(/^(?:现实|回忆|梦境)?[，,\s]*(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|黄昏|夜晚|深夜|白天)/u)
  return match?.[0].replace(/^[，,\s]+|[，,\s]+$/g, '') || '时间承接已锁定剧本'
}

function explicitStoryboardLocationLabel(value: string) {
  const parts = value.split(/[｜|]/u).map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return ''
  const candidate = parts.slice(1).join('｜').trim()
  if (!candidate || /^(?:时间|场景)?承接(?:上一镜|已锁定剧本)/u.test(candidate)) return ''
  if (/^(?:普通|默认|通用|未命名|某个|一处)/u.test(candidate)) return ''
  return candidate
}

function storyboardLocationIsPlaceholder(value: string) {
  const normalized = value.replace(/\s+/gu, '')
  return !explicitStoryboardLocationLabel(value)
    && /(?:承接上一镜|承接已锁定剧本|时间承接|场景承接)/u.test(normalized)
}

function uniqueLocationSuffixMatch<T extends StoryboardLocationAsset>(context: string, locations: T[]): T | undefined {
  const normalizedContext = normalizedStoryboardLocation(context)
  const locationKinds = ['起居室', '会客室', '办公室', '会议室', '卧室', '客厅', '厨房', '餐厅', '书房', '浴室', '卫生间', '走廊', '楼梯间', '地下室', '停车场', '公路', '山路', '河边', '街道', '小院', '庭院', '医院', '学校', '教室', '宿舍', '商场', '酒店', '车站', '机场', '木屋', '森林', '营地', '石阵', '祭坛', '广场', '悬崖', '崖边', '牢房', '关押区', '储备室', '议会厅', '遗迹', '实验室', '空地', '围墙']
  const matches = locations.filter((location) => locationKinds.some((kind) => (
    location.name.includes(kind) && normalizedContext.includes(normalizedStoryboardLocation(kind))
  )))
  return matches.length === 1 ? matches[0] : undefined
}

export function enforceStoryboardLocationAssets(
  shots: CompactShotInput[],
  locations: StoryboardLocationAsset[],
) {
  if (locations.length === 0) {
    return shots.map(normalizeCompactShot)
  }
  const matchableLocations = locations.map((location, index) => ({
    id: `location-${index}`,
    type: AssetType.location,
    name: location.name,
    description: location.description,
    tags: location.tags || [],
  }))

  const normalizedShots = shots.map(normalizeCompactShot)
  const directMatches = normalizedShots.map((shot) => {
    const actionContext = [shot.t, shot.s, shot.m, shot.a, shot.x].join('\n')
    const context = [shot.t, shot.n, shot.e, shot.f, shot.s, shot.m, shot.v, shot.a, shot.g, shot.x].join('\n')
    const actionExact = locations.find((location) => (
      normalizedStoryboardLocation(actionContext).includes(normalizedStoryboardLocation(location.name))
    ))
    const actionSemantic = uniqueLocationSemanticMatch(actionContext, locations)
    const physicalOverride = explicitPhysicalLocationOverride(shot, locations)
    const evidenceOverride = storyboardLocationEvidenceMatch(shot, locations)
    const noteExact = locations.find((location) => (
      normalizedStoryboardLocation(shot.n).includes(normalizedStoryboardLocation(location.name))
    ))
    const exact = noteExact || locations.find((location) => (
      normalizedStoryboardLocation(context).includes(normalizedStoryboardLocation(location.name))
    ))
    const strongMatch = evidenceOverride
      || physicalOverride
      || noteExact
      || actionExact
      || actionSemantic
      || exact
      || uniqueLocationSemanticMatch(context, locations)
    if (strongMatch) return strongMatch
    if (explicitStoryboardLocationLabel(shot.n)) return undefined
    return matchStoryboardAssets(matchableLocations, context, matchableLocations.length)[0]
      || uniqueLocationSuffixMatch(context, locations)
      || (!explicitStoryboardLocationLabel(shot.n) && locations.length === 1 ? locations[0] : undefined)
  })
  let inheritedLocation: StoryboardLocationAsset | undefined
  let activeFlashbackLocation = ''
  const closedFlashbackLocations = new Set<string>()
  const isFlashbackLocation = (location: StoryboardLocationAsset) => (
    location.name.endsWith('（闪回）') || /(?:回忆|闪回)/u.test(location.description)
  )

  return normalizedShots.map((shot, index): CompactShot => {
    const explicitLocation = explicitStoryboardLocationLabel(shot.n)
    let matched = directMatches[index]
    if (!matched && explicitLocation) return shot
    if (!matched && storyboardLocationIsPlaceholder(shot.n)) {
      matched = inheritedLocation
        || directMatches.slice(index + 1).find(Boolean)
        || (locations.length === 1 ? locations[0] : undefined)
    }
    if (!matched) return shot
    if (activeFlashbackLocation && matched.name !== activeFlashbackLocation) {
      closedFlashbackLocations.add(activeFlashbackLocation)
      activeFlashbackLocation = ''
    }
    if (isFlashbackLocation(matched)) {
      if (closedFlashbackLocations.has(matched.name)
        && inheritedLocation
        && !isFlashbackLocation(inheritedLocation)) {
        matched = inheritedLocation
      } else {
        activeFlashbackLocation = matched.name
      }
    }
    inheritedLocation = matched
    const foreignLocations = locations.filter((location) => location.name !== matched.name)
    const containsForeignLocation = (value: string) => {
      const semanticMatches = new Set(storyboardSemanticLocationMatches(value, locations).map((location) => location.name))
      return foreignLocations.some((location) => (
        normalizedStoryboardLocation(value).includes(normalizedStoryboardLocation(location.name))
        || semanticMatches.has(location.name)
      ))
    }
    const sceneFacts = conciseStoryboardSceneFacts(matched.description, 220)
    const anchor = `场景资产“${matched.name}”：${sceneFacts || '固定空间结构、陈设、材质与基础光线沿用场景资产主图'}`
    const prohibition = `禁止将场景“${matched.name}”替换为其他地点，禁止改变固定空间结构、材质、陈设位置和基础光源。`
    return {
      ...shot,
      n: `${storyboardTimeLabel(shot.n)}｜${matched.name}`,
      p: containsForeignLocation(shot.p) ? '' : shot.p,
      f: containsForeignLocation(shot.f) ? '' : shot.f,
      g: containsForeignLocation(shot.g) ? '' : shot.g,
      e: anchor,
      z: shot.z.includes(prohibition) ? shot.z : `${shot.z}${shot.z ? '；' : ''}${prohibition}`.slice(0, 3200),
    }
  })
}

export function compactStoryboardShots(shots: CompactShotInput[], target: number) {
  void target
  return shots.map(normalizeCompactShot)
}

export function fitStoryboardDuration(shots: CompactShotInput[], targetSeconds = 90): CompactShot[] {
  if (shots.length === 0) return []
  const normalized = shots.map(normalizeCompactShot)
  const minimum = normalized.length * 3
  const maximum = normalized.length * 15
  const total = Math.max(minimum, Math.min(maximum, Math.round(targetSeconds)))
  const durations = Array.from({ length: normalized.length }, () => 3)
  let remaining = total - minimum
  let cursor = 0
  while (remaining > 0) {
    if (durations[cursor] < 15) {
      durations[cursor]++
      remaining--
    }
    cursor = (cursor + 1) % durations.length
  }
  return normalized.map((shot, index) => ({ ...shot, d: durations[index] }))
}

const STORYBOARD_VIDEO_CLIP_SECONDS = 15
const STORYBOARD_MAX_TIMELINE_BEATS_PER_CLIP = 3
const STORYBOARD_MAX_CHARACTERS_PER_CLIP = 4

function formatTimelineSecond(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function compactTimelineValue(value: string, maximum: number) {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trim()}…`
}

function uniqueShotField(
  shots: CompactShot[],
  key: keyof Pick<CompactShot, 'h' | 'r' | 'e' | 'l' | 'o' | 'z'>,
  maximum: number,
) {
  return compactTimelineValue(
    [...new Set(shots.map((shot) => shot[key].trim()).filter(Boolean))].join('；'),
    maximum,
  )
}

function characterDeclarationKey(value: string) {
  const candidate = value
    .replace(/^[\s\-•]+/u, '')
    .match(/^([^：:(（\n]{2,40})(?=\s*[：:(（])/u)?.[1]?.trim()
  if (!candidate || /^(?:人物|角色|本镜|初始|出场|声音|关键道具)/u.test(candidate)) return ''
  return candidate
}

function splitCharacterDeclarationNames(value: string): string[] {
  const punctuationParts = value.split(/[、，,]/u).map((part) => part.trim()).filter(Boolean)
  if (punctuationParts.length > 1) return punctuationParts.flatMap(splitCharacterDeclarationNames)
  const relationParts = value.split(/与/u).map((part) => part.trim()).filter(Boolean)
  if (relationParts.length > 1) return relationParts.flatMap(splitCharacterDeclarationNames)
  const andParts = value.split(/和/u).map((part) => part.trim()).filter(Boolean)
  if (andParts.length === 2 && andParts.every((part) => [...part].length >= 2)) {
    return andParts.flatMap(splitCharacterDeclarationNames)
  }
  return value ? [value] : []
}

function uniqueCharacterShotField(shots: CompactShot[], maximum: number) {
  const seenCharacters = new Set<string>()
  const seenFragments = new Set<string>()
  const output: string[] = []
  for (const shot of shots) {
    for (const rawFragment of shot.h.split(/[；;\n]+/u)) {
      const fragment = rawFragment.trim()
      if (!fragment) continue
      const characterName = characterDeclarationKey(fragment)
      if (characterName) {
        if (seenCharacters.has(characterName)) continue
        seenCharacters.add(characterName)
      } else if (seenFragments.has(fragment)) {
        continue
      }
      seenFragments.add(fragment)
      output.push(fragment)
    }
  }
  return compactTimelineValue(output.join('；'), maximum)
}

function characterNamesFromLock(value: string) {
  return [...new Set(
    value.split(/[；;\n]+/u)
      .flatMap((fragment) => splitCharacterDeclarationNames(characterDeclarationKey(fragment.trim())))
      .filter(Boolean),
  )]
}

function storyboardActiveCharacterNames(shots: CompactShot[]) {
  const declaredNames = characterNamesFromLock(uniqueCharacterShotField(shots, 6000))
  const spokenNames = shots.flatMap((shot) => (
    extractStoryboardShotDialogues(shot.a).map((dialogue) => dialogue.speaker)
  ))
  const explicitlyOffscreenNames = new Set(shots.flatMap((shot) => [
    ...shot.h.split(/[；;\n]+/u)
      .filter((fragment) => /画外|只通过|仅通过|不得入镜|不入镜/u.test(fragment))
      .flatMap((fragment) => splitCharacterDeclarationNames(characterDeclarationKey(fragment))),
    ...[...shot.v.matchAll(/画外角色[：:]?([^。；\n]+)/gu)]
      .flatMap((match) => match[1].split(/[、，,和与\s]+/u).map((name) => name.trim()).filter(Boolean)),
  ]))
  return [...new Set([...declaredNames, ...spokenNames])]
    .filter((name) => !explicitlyOffscreenNames.has(name))
}

function uniqueActiveCharacterShotField(shots: CompactShot[], maximum: number) {
  const activeNames = new Set(storyboardActiveCharacterNames(shots))
  const seenCharacters = new Set<string>()
  const seenFragments = new Set<string>()
  const output: string[] = []
  for (const shot of shots) {
    for (const rawFragment of shot.h.split(/[；;\n]+/u)) {
      const fragment = rawFragment.trim()
      if (!fragment) continue
      const characterName = characterDeclarationKey(fragment)
      if (characterName) {
        const declarationNames = splitCharacterDeclarationNames(characterName)
        if (declarationNames.length > 0 && !declarationNames.some((name) => activeNames.has(name))) continue
        if (seenCharacters.has(characterName)) continue
        seenCharacters.add(characterName)
      } else if (seenFragments.has(fragment)) {
        continue
      }
      seenFragments.add(fragment)
      output.push(fragment)
    }
  }
  return compactTimelineValue(output.join('；'), maximum)
}

function storyboardGroupCharacterNames(shots: CompactShot[]) {
  return storyboardActiveCharacterNames(shots)
}

function normalizeStoryboardCameraCast(value: string, characterNames: string[]) {
  return characterNames.reduce((camera, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return camera.replace(
      new RegExp(`从${escaped}腰部高度(俯拍|仰拍|平拍|拍摄)`, 'gu'),
      `摄影机固定在${name}身后右侧腰线外，$1`,
    )
  }, value)
}

type PackedStoryboardSceneRun = {
  start: number
  end: number
  locationKey: string
  shots: CompactShot[]
}

function packedStoryboardSceneRuns(shots: CompactShot[]) {
  const runs: PackedStoryboardSceneRun[] = []
  let cursor = 0
  for (const shot of shots) {
    const start = cursor
    cursor += shot.d
    const locationKey = storyboardLocationFromNote(shot.n)
    const previous = runs.at(-1)
    if (previous && previous.locationKey === locationKey) {
      previous.end = cursor
      previous.shots.push(shot)
    } else {
      runs.push({ start, end: cursor, locationKey, shots: [shot] })
    }
  }
  return runs
}

function packedStoryboardSceneField(
  runs: PackedStoryboardSceneRun[],
  key: keyof Pick<CompactShot, 'e' | 'l'>,
  maximum: number,
) {
  return compactTimelineValue(runs.map((run) => {
    const value = [...new Set(run.shots.map((shot) => shot[key].trim()).filter(Boolean))].join('；')
    return value ? `${formatTimelineSecond(run.start)}~${formatTimelineSecond(run.end)}s：${value}` : ''
  }).filter(Boolean).join('\n'), maximum)
}

function packCompactShotGroup(inputShots: CompactShot[], requestedClipSeconds?: number): CompactShot {
  const shots = inputShots.map((shot) => ({ ...shot }))
  const sourceSeconds = shots.reduce((total, shot) => total + shot.d, 0)
  const requiredDialogueSeconds = Math.ceil(packedStoryboardGroupDialogueSeconds(shots))
  const clipSeconds = Math.max(
    sourceSeconds,
    Math.min(15, requestedClipSeconds ?? requiredDialogueSeconds),
  )
  let durationSlack = clipSeconds - sourceSeconds
  while (durationSlack > 0) {
    const candidate = shots
      .map((shot, index) => ({ index, duration: shot.d }))
      .sort((left, right) => left.duration - right.duration || left.index - right.index)[0]
    if (!candidate) break
    shots[candidate.index].d++
    durationSlack--
  }
  const spokenDialogues = shots.flatMap((shot) => extractStoryboardShotDialogues(shot.a))
  const onsiteDialogues = spokenDialogues.filter((dialogue) => !isStoryboardVoiceover(dialogue))
  const voiceovers = spokenDialogues.filter(isStoryboardVoiceover)
  const onsiteNames = [...new Set(onsiteDialogues.map((dialogue) => dialogue.speaker))]
  const voiceoverNames = [...new Set(voiceovers.map((dialogue) => dialogue.speaker))]
  const sceneRuns = packedStoryboardSceneRuns(shots)
  const containsSceneChange = sceneRuns.length > 1
  const packedSceneNote = containsSceneChange
    ? sceneRuns.map((run) => (
        `${formatTimelineSecond(run.start)}~${formatTimelineSecond(run.end)}s：${run.shots[0].n}`
      )).join('\n')
    : shots[0].n
  const baseCharacterLock = uniqueActiveCharacterShotField(shots, 2600)
  const castSchedule = containsSceneChange
    ? sceneRuns.map((run) => {
        const names = [...new Set([
          ...characterNamesFromLock(uniqueCharacterShotField(run.shots, 1200)),
          ...run.shots.flatMap((shot) => extractStoryboardShotDialogues(shot.a).map((dialogue) => dialogue.speaker)),
        ])]
        return names.length > 0
          ? `${formatTimelineSecond(run.start)}~${formatTimelineSecond(run.end)}s仅允许${names.join('、')}按本段动作入镜`
          : ''
      }).filter(Boolean).join('；')
    : ''
  let cursor = 0
  let previousSceneKey = ''
  const timeline = shots.map((shot) => {
    const start = cursor
    cursor += shot.d
    const currentSceneKey = storyboardLocationFromNote(shot.n)
    const sceneCue = containsSceneChange
      ? previousSceneKey && previousSceneKey !== currentSceneKey
        ? `直接切换到“${visibleStoryboardTimeLocation(shot.n)}”，上一场景的人物和陈设完全退出，禁止叠加或同时出现`
        : !previousSceneKey
          ? `场景为“${visibleStoryboardTimeLocation(shot.n)}”`
          : ''
      : ''
    previousSceneKey = currentSceneKey
    return fuseStoryboardTimelineDetails({
      duration: shot.d,
      timeline: shot.v,
      camera: compactTimelineValue(shot.c, 360),
      intent: compactTimelineValue(shot.i, 420),
      actionOrder: compactTimelineValue(shot.s, 900),
      actionPhysics: compactTimelineValue(shot.m, 800),
      performance: compactTimelineValue(shot.v, 900),
      dialogue: compactTimelineValue(shot.a, 1200),
      openingState: compactTimelineValue([shot.p, shot.f].filter(Boolean).join('；'), 700),
      endingState: compactTimelineValue(shot.g, 700),
      sceneCue,
      offset: start,
    })
  }).join('\n')

  return normalizeCompactShot({
    t: shots.length === 1
      ? shots[0].t
      : `${shots[0].t} 至 ${shots[shots.length - 1].t}`.slice(0, 120),
    n: packedSceneNote,
    i: compactTimelineValue(shots.map((shot) => shot.i).filter(Boolean).join('；'), 900),
    p: shots[0].p,
    h: compactTimelineValue([
      baseCharacterLock,
      castSchedule ? `跨场景出场时段锁定：${castSchedule}；未到对应时段的人物不得提前出现。` : '',
    ].filter(Boolean).join('；'), 2900),
    r: uniqueShotField(shots, 'r', 2100),
    e: containsSceneChange
      ? packedStoryboardSceneField(sceneRuns, 'e', 2800)
      : shots.find((shot) => shot.e.trim())?.e || '',
    l: containsSceneChange
      ? packedStoryboardSceneField(sceneRuns, 'l', 1800)
      : shots.find((shot) => shot.l.trim())?.l || '',
    c: shots.map((shot) => shot.c).join('\n'),
    f: shots[0].f,
    s: shots.map((shot) => shot.s).join('\n'),
    m: shots.map((shot) => shot.m).join('\n'),
    v: timeline,
    a: shots.map((shot) => shot.a).join('\n'),
    q: spokenDialogues.length > 0
      ? `${onsiteNames.length > 0 ? `${onsiteNames.join('、')}沿用固定声线和自然语速；无新增旁白、无后期配音感，保留演员现场对白。` : ''}${voiceoverNames.length > 0 ? `${voiceoverNames.join('、')}的原剧本旁白、画外音或【OS】完整保留，禁止画面人物对口型。` : ''}`
      : '本段无对白，不生成配音、旁白、画外音或内心独白。',
    o: spokenDialogues.length > 0
      ? `${onsiteDialogues.length > 0 ? '保留各时间段演员现场对白、' : ''}${voiceovers.length > 0 ? '保留原剧本旁白、画外音和【OS】、' : ''}对应场景环境声和必要音效；无背景音乐、无字幕。`
      : uniqueShotField(shots, 'o', 2300),
    g: shots[shots.length - 1].g,
    x: shots[shots.length - 1].x,
    z: uniqueShotField(shots, 'z', 3100),
    d: clipSeconds,
  })
}

const COMPLEX_BODY_MOTION = /奔跑|冲刺|追逐|跳(?:跃|下|起)?|扑向|摔倒|跌倒|翻滚|打斗|搏斗|扭打|踢|挥拳|躲闪|舞蹈|转身奔|run(?:ning)?|jump|fall|fight|roll|dance/iu
const PHYSICAL_INTERACTION = /拥抱|亲吻|搀扶|抓住|握住.*(?:手|腕|肩)|推搡|拖拽|背起|抱起|按住|触碰|递给|接过|交给|抢夺|开门|关门|上下车|hug|kiss|grab|handshake|push|pull|hand over/iu
const TEMPORAL_OR_SCENE_TRANSITION = /回忆|梦境|闪回|转场|叠化|场景切换|进入下一场|flashback|dream|dissolve|transition/iu
const DEMANDING_CAMERA_MOTION = /环绕|甩镜|急推|急拉|快速推|快速拉|快速横移|旋转镜头|手持.*(?:剧烈|快速)|whip pan|arc shot|crash zoom|rapid dolly/iu

export function storyboardMotionRisk(inputShot: CompactShotInput) {
  const shot = normalizeCompactShot(inputShot)
  const actionText = [shot.s, shot.m, shot.v, shot.a].join('\n')
  const cameraText = shot.c
  const sceneText = [shot.n, shot.x].join('\n')
  let score = 0
  if (COMPLEX_BODY_MOTION.test(actionText)) score += 4
  if (PHYSICAL_INTERACTION.test(actionText)) score += 4
  if (TEMPORAL_OR_SCENE_TRANSITION.test(sceneText)) score += 5
  if (DEMANDING_CAMERA_MOTION.test(cameraText)) score += 3
  if (DEMANDING_CAMERA_MOTION.test(cameraText) && (COMPLEX_BODY_MOTION.test(actionText) || PHYSICAL_INTERACTION.test(actionText))) score += 5
  return score
}

function motionAwareShotGroups(shots: CompactShot[]) {
  const groups: CompactShot[][] = []
  for (const shot of shots) {
    const risky = storyboardMotionRisk(shot) >= 4
    const previous = groups[groups.length - 1]
    const previousIsSimple = previous?.every((item) => storyboardMotionRisk(item) < 4)
    const sameLocation = previous
      ? storyboardLocationFromNote(previous[previous.length - 1].n) === storyboardLocationFromNote(shot.n)
      : false
    if (!risky && previousIsSimple && sameLocation && previous.length < 2) previous.push(shot)
    else groups.push([shot])
  }
  return groups
}

function storyboardLocationFromNote(value: string) {
  const firstLine = storyboardSceneNoteSegments(value)[0] || value.trim()
  const parts = firstLine.split('｜').map((part) => part.trim()).filter(Boolean)
  const timeMode = /回忆|梦境/u.exec(parts[0] || value)?.[0] || '现实'
  const physicalLocation = parts.length >= 2 ? parts.slice(1).join('｜') : firstLine || value
  return `${timeMode}｜${normalizedStoryboardLocation(physicalLocation)}`
}

function storyboardSceneNoteSegments(value: string) {
  return value
    .split(/\r?\n+/u)
    .map((line) => line
      .replace(/^\d+(?:\.\d+)?~\d+(?:\.\d+)?s[：:]\s*/u, '')
      .trim())
    .filter(Boolean)
}

function storyboardEndLocationFromNote(value: string) {
  const segments = storyboardSceneNoteSegments(value)
  return storyboardLocationFromNote(segments.at(-1) || value)
}

function storyboardAssetSceneName(value: string) {
  const firstLine = storyboardSceneNoteSegments(value)[0] || value.trim()
  const parts = firstLine.split('｜').map((part) => part.trim()).filter(Boolean)
  return (parts.length >= 2 ? parts.slice(1).join('｜') : firstLine)
    .replace(/^时间(?:地点)?承接(?:已锁定剧本|当前剧本场次)[，,：:\s]*/u, '')
    .trim()
}

function storyboardAssetSceneNames(value: string) {
  return [...new Set(storyboardSceneNoteSegments(value)
    .map((segment) => storyboardAssetSceneName(segment))
    .filter(Boolean))]
}

function storyboardEndAssetSceneName(value: string) {
  return storyboardAssetSceneNames(value).at(-1) || storyboardAssetSceneName(value)
}

function visibleStoryboardTimeLocation(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.replace(
      /^(\d+(?:\.\d+)?~\d+(?:\.\d+)?s[：:]\s*)?时间(?:地点)?承接(?:已锁定剧本|当前剧本场次)｜/u,
      '$1',
    ))
    .join('\n')
    .trim()
}

function visibleStoryboardStartTimeLocation(value: string) {
  const first = storyboardSceneNoteSegments(value)[0] || value
  return visibleStoryboardTimeLocation(first)
}

function firstStoryboardTimedField(value: string) {
  return value
    .split(/\r?\n/u, 1)[0]
    .replace(/^\d+(?:\.\d+)?~\d+(?:\.\d+)?s[：:]\s*/u, '')
    .trim()
}

function minimumPackedStoryboardBeatDuration(shot: CompactShot) {
  const dialogues = extractStoryboardShotDialogues(shot.a)
  const dialogueSeconds = dialogues.reduce(
    (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
    dialogues.length > 0 ? 0.5 + Math.max(0, dialogues.length - 1) * 0.5 : 0,
  )
  return Math.max(3, Math.min(6, Math.ceil(dialogueSeconds)))
}

function packedStoryboardGroupDialogueSeconds(shots: CompactShot[]) {
  const dialogues = shots.flatMap((shot) => extractStoryboardShotDialogues(shot.a))
  return dialogues.reduce(
    (total, dialogue) => total + estimatedDialogueSeconds(dialogue.text),
    dialogues.length > 0 ? 0.5 + Math.max(0, dialogues.length - 1) * 0.5 : 0,
  )
}

function packedStoryboardGroupFits(shots: CompactShot[], clipSeconds: number) {
  const duration = shots.reduce((total, shot) => total + shot.d, 0)
  return duration <= clipSeconds && packedStoryboardGroupDialogueSeconds(shots) <= clipSeconds + 0.05
}

function compressPackedStoryboardGroup(shots: CompactShot[], clipSeconds: number) {
  const compressed = shots.map((shot) => ({ ...shot }))
  let overflow = compressed.reduce((total, shot) => total + shot.d, 0) - clipSeconds
  if (overflow > 3) return null
  while (overflow > 0) {
    const candidate = compressed
      .map((shot, index) => ({
        index,
        reducible: shot.d - minimumPackedStoryboardBeatDuration(shot),
        duration: shot.d,
      }))
      .filter((item) => item.reducible > 0)
      .sort((left, right) => right.reducible - left.reducible || right.duration - left.duration || left.index - right.index)[0]
    if (!candidate) return null
    compressed[candidate.index].d--
    overflow--
  }
  return packedStoryboardGroupFits(compressed, clipSeconds) ? compressed : null
}

function mergeAdjacentStoryboardGroups(groups: CompactShot[][], clipSeconds: number) {
  const merged: CompactShot[][] = []
  let current: CompactShot[] = []
  for (const shot of groups.flat()) {
    const candidate = [...current, shot]
    const compressed = candidate.length <= STORYBOARD_MAX_TIMELINE_BEATS_PER_CLIP
      && storyboardGroupCharacterNames(candidate).length <= STORYBOARD_MAX_CHARACTERS_PER_CLIP
      ? compressPackedStoryboardGroup(candidate, clipSeconds)
      : null
    if (compressed) {
      current = compressed
      continue
    }
    if (current.length > 0) merged.push(current)
    current = [{ ...shot }]
  }
  if (current.length > 0) merged.push(current)
  return merged
}

function balancedSceneShotGroups(shots: CompactShot[], clipSeconds: number) {
  if (shots.length === 0) return []
  const sourceDuration = shots.reduce((total, shot) => total + shot.d, 0)
  const compressionAllowance = Math.max(1, Math.floor(sourceDuration / clipSeconds))
  const durationGroupCount = Math.max(1, Math.ceil((sourceDuration - compressionAllowance) / clipSeconds))
  const groupCount = Math.max(
    durationGroupCount,
    Math.ceil(shots.length / STORYBOARD_MAX_TIMELINE_BEATS_PER_CLIP),
  )
  const baseSize = Math.floor(shots.length / groupCount)
  let largerGroups = shots.length % groupCount
  const initialGroups: CompactShot[][] = []
  let cursor = 0
  for (let index = 0; index < groupCount; index++) {
    const size = baseSize + (largerGroups > 0 ? 1 : 0)
    if (largerGroups > 0) largerGroups--
    initialGroups.push(shots.slice(cursor, cursor + size).map((shot) => ({ ...shot })))
    cursor += size
  }

  const groupDuration = (group: CompactShot[]) => group.reduce((total, shot) => total + shot.d, 0)
  const groups = initialGroups.flatMap((group) => {
    let groupCursor = group.length - 1
    while (groupDuration(group) > clipSeconds) {
      const shot = group[groupCursor]
      if (shot.d > minimumPackedStoryboardBeatDuration(shot)) shot.d--
      groupCursor = (groupCursor - 1 + group.length) % group.length
      if (group.every((item) => item.d <= minimumPackedStoryboardBeatDuration(item))) break
    }
    if (packedStoryboardGroupFits(group, clipSeconds)
      && storyboardGroupCharacterNames(group).length <= STORYBOARD_MAX_CHARACTERS_PER_CLIP) {
      return [group]
    }

    const splitGroups: CompactShot[][] = []
    let current: CompactShot[] = []
    for (const shot of group) {
      if (current.length > 0 && (
        !packedStoryboardGroupFits([...current, shot], clipSeconds)
        || storyboardGroupCharacterNames([...current, shot]).length > STORYBOARD_MAX_CHARACTERS_PER_CLIP
      )) {
        splitGroups.push(current)
        current = []
      }
      current.push(shot)
    }
    if (current.length > 0) splitGroups.push(current)
    return splitGroups
  })

  const targetDuration = Math.max(4, Math.min(sourceDuration, groups.length * clipSeconds))
  let currentDuration = groups.reduce((total, group) => total + groupDuration(group), 0)
  let guard = 0
  while (currentDuration < targetDuration && guard < 500) {
    guard++
    const candidate = groups
      .map((group, index) => ({ group, index, duration: groupDuration(group) }))
      .filter((item) => item.duration < clipSeconds && item.group.some((shot) => shot.d < 6))
      .sort((left, right) => left.duration - right.duration || left.index - right.index)[0]
    if (!candidate) break
    const shot = candidate.group.find((item) => item.d < 6)
    if (!shot) break
    shot.d++
    currentDuration++
  }
  return groups
}

export function packStoryboardVideoClips(
  shots: CompactShotInput[],
  clipSeconds = STORYBOARD_VIDEO_CLIP_SECONDS,
  episodeMaxSeconds?: number | null,
) {
  if (shots.length === 0) return []
  const normalized = stitchStoryboardContinuity(splitOverlongStoryboardDialogueShots(shots))
  const safeClipSeconds = Math.max(4, Math.min(15, Math.round(clipSeconds)))
  const safeEpisodeMaxSeconds = Number.isFinite(episodeMaxSeconds) && Number(episodeMaxSeconds) > 0
    ? Math.max(safeClipSeconds, Math.round(Number(episodeMaxSeconds)))
    : null
  const minimumEpisodeSeconds = normalized.length * 3
  if (safeEpisodeMaxSeconds !== null && minimumEpisodeSeconds > safeEpisodeMaxSeconds) {
    throw new Error(
      `STORYBOARD_EPISODE_SCENE_DENSITY: 当前集有 ${normalized.length} 个子镜头，按最短 3 秒仍超过 ${safeEpisodeMaxSeconds} 秒`,
    )
  }
  const sourceSeconds = normalized.reduce((total, shot) => total + shot.d, 0)
  const durationFitted = safeEpisodeMaxSeconds !== null && sourceSeconds > safeEpisodeMaxSeconds
    ? fitStoryboardDuration(normalized, safeEpisodeMaxSeconds)
    : normalized
  const dialogueFitted = stitchStoryboardContinuity(splitOverlongStoryboardDialogueShots(durationFitted))
  const dialogueFittedMinimumSeconds = dialogueFitted.length * 3
  if (safeEpisodeMaxSeconds !== null && dialogueFittedMinimumSeconds > safeEpisodeMaxSeconds) {
    throw new Error(
      `STORYBOARD_EPISODE_SCENE_DENSITY: 长对白拆分后有 ${dialogueFitted.length} 个子镜头，按最短 3 秒仍超过 ${safeEpisodeMaxSeconds} 秒`,
    )
  }
  const dialogueFittedSeconds = dialogueFitted.reduce((total, shot) => total + shot.d, 0)
  const finalDurationFitted = safeEpisodeMaxSeconds !== null && dialogueFittedSeconds > safeEpisodeMaxSeconds
    ? fitStoryboardDuration(dialogueFitted, safeEpisodeMaxSeconds)
    : dialogueFitted
  const sceneRuns: CompactShot[][] = []
  let currentScene: CompactShot[] = []
  for (const shot of finalDurationFitted) {
    const previous = currentScene.at(-1)
    const sameScene = !previous
      || storyboardLocationFromNote(previous.n) === storyboardLocationFromNote(shot.n)
    if (currentScene.length > 0 && !sameScene) {
      sceneRuns.push(currentScene)
      currentScene = []
    }
    currentScene.push(shot)
  }
  if (currentScene.length > 0) sceneRuns.push(currentScene)
  const sameSceneGroups = sceneRuns.flatMap((sceneShots) => balancedSceneShotGroups(sceneShots, safeClipSeconds))
  const groups = mergeAdjacentStoryboardGroups(sameSceneGroups, safeClipSeconds)

  let expansionBudget = Math.max(
    0,
    (safeEpisodeMaxSeconds ?? Number.POSITIVE_INFINITY) - groups.reduce((total, group) => (
      total + group.reduce((groupTotal, shot) => groupTotal + shot.d, 0)
    ), 0),
  )
  const packed = groups.map((group) => {
    const sourceDuration = group.reduce((total, shot) => total + shot.d, 0)
    const requiredDuration = Math.min(15, Math.ceil(packedStoryboardGroupDialogueSeconds(group)))
    const desiredDuration = Math.max(sourceDuration, requiredDuration, safeClipSeconds)
    const addedDuration = Math.min(expansionBudget, desiredDuration - sourceDuration)
    expansionBudget -= addedDuration
    return packCompactShotGroup(group, sourceDuration + addedDuration)
  })

  return stitchStoryboardContinuity(packed)
}

function directorPromptSentence(parts: Array<string | null | undefined>, fallback: string) {
  const value = parts
    .map((part) => part?.replace(/\r/gu, '').replace(/\n+/gu, '；').trim() || '')
    .filter(Boolean)
    .join('；')
    .replace(/[；;\s]+$/gu, '')
  if (!value) return fallback
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`
}

export function buildDirectorStoryboardPrompt(input: {
  number: number
  shot: CompactShotInput
  visibleTimeLocation: string
  environmentLock: string
  lightingLock: string
}) {
  const timeLocation = input.visibleTimeLocation.replace(/\s*｜\s*/gu, '，')
  return [
    `分镜${input.number}：`,
    `景别机位运动：${directorPromptSentence([input.shot.c], '中景固定机位。')}`,
    `画面内容：${directorPromptSentence([
      timeLocation,
      input.environmentLock,
      input.lightingLock,
      input.shot.f,
      input.shot.v,
    ], input.shot.t || '当前分镜画面。')}`,
    `动作对白：${directorPromptSentence([
      input.shot.s,
      input.shot.m,
      input.shot.a,
      input.shot.q,
    ], '本镜无对白，人物动作按画面内容执行。')}`,
  ].join('\n')
}

export function materializeStoryboards(input: {
  shots: CompactShotInput[]
  visualStyle: typeof import('@prisma/client').VisualStyle[keyof typeof import('@prisma/client').VisualStyle]
  customStylePrompt?: string | null
}) {
  const styleLock = buildStyleLock(input.visualStyle, input.customStylePrompt, 'video')
  const shots = stitchStoryboardContinuity(input.shots)
  return shots.map((shot, index) => {
    const assetSceneNames = storyboardAssetSceneNames(shot.n)
    const assetSceneName = assetSceneNames[0] || storyboardAssetSceneName(shot.n)
    const endingAssetSceneName = assetSceneNames.at(-1) || assetSceneName
    const sceneNotes = storyboardSceneNoteSegments(shot.n)
      .map((segment) => visibleStoryboardTimeLocation(segment))
      .join('；')
    const visibleTimeLocation = visibleStoryboardTimeLocation(shot.n)
    const visibleStartTimeLocation = visibleStoryboardStartTimeLocation(shot.n)
    const containsSceneChange = assetSceneNames.length > 1
    const dedupedCharacterLock = uniqueCharacterShotField([shot], 1200)
    const characterNames = characterNamesFromLock(dedupedCharacterLock)
    const characterLock = storyboardField(
      dedupedCharacterLock,
      `本镜出场人物的姓名、年龄、面容、身材比例、发型和服装严格沿用资产库主图；未在剧本中出现的人物不得入镜。`,
    )
    const propLock = storyboardField(
      shot.r,
      `无新增关键道具；已有道具保持原归属、佩戴位置和持握手，不得转移、复制、漂浮或无故消失。`,
    )
    const environmentLock = storyboardField(
      shot.e,
      `严格沿用“${shot.n}”已经建立的空间结构和固定陈设，不增删或移动无关物品。`,
    )
    const lightingLock = storyboardField(
      shot.l,
      `沿用场景既定光源方向、色温、亮度和人物受光关系，除非动作顺序明确要求，不得突变。`,
    )
    const conciseScene = conciseStoryboardSceneSection({
      timeLocation: visibleTimeLocation,
      sceneName: assetSceneName,
      environment: environmentLock,
      lighting: lightingLock,
    })
    const detailedTimeline = normalizeStoryboardCameraCast(fuseStoryboardTimelineDetails({
      duration: shot.d,
      timeline: shot.v,
      camera: compactTimelineValue(shot.c, 900),
      intent: compactTimelineValue(shot.i, 900),
      actionOrder: compactTimelineValue(shot.s, 2400),
      actionPhysics: compactTimelineValue(shot.m, 2200),
      performance: compactTimelineValue(shot.v, 4000),
      dialogue: compactTimelineValue(shot.a, 4000),
      openingState: compactTimelineValue([shot.p, shot.f].filter(Boolean).join('；'), 1600),
      endingState: compactTimelineValue(shot.g, 1800),
    }), characterNames)
    const previousShot = shots[index - 1]
    const previousScene = previousShot ? storyboardEndAssetSceneName(previousShot.n) : ''
    const transitionType: ContinuityTransitionType = !previousShot
      ? 'scene_start'
      : /回忆|梦境|数日后|翌日|时间跳转/u.test(shot.n)
        ? 'time_jump'
        : previousScene !== assetSceneName
          ? 'scene_change'
          : /正反打|反打|越轴/u.test([shot.c, shot.x, shot.f].join('\n'))
            ? 'reverse_shot'
            : 'same_scene_continuous'
    const continuityIn = inferStoryboardContinuityState({
      transitionType,
      scene: assetSceneName,
      camera: shot.c,
      frame: [shot.p, shot.f].filter(Boolean).join('；'),
      action: '',
      propState: propLock,
      characterNames,
    })
    const continuityOut = inferStoryboardContinuityState({
      transitionType,
      scene: endingAssetSceneName,
      camera: shot.c,
      frame: shot.g,
      action: [shot.s, shot.v, shot.g].filter(Boolean).join('；'),
      propState: propLock,
      characterNames,
    })

    return {
      title: shot.t,
      notes: containsSceneChange ? sceneNotes : assetSceneName,
      imagePrompt: [
        styleLock,
        `时间地点：${visibleStartTimeLocation}`,
        `人物锁定：${characterLock}`,
        `道具锁定：${propLock}`,
        `环境锁定：${firstStoryboardTimedField(environmentLock)}`,
        `照明锁定：${firstStoryboardTimedField(lightingLock)}`,
        containsSceneChange ? '首帧只呈现时间轴第一段场景及当时出场人物，后续场景和人物不得提前出现。' : '',
        `首帧画面：${shot.f}`,
        `电影级首帧构图，人物和资产形象与资产库主图一致，无文字、无水印、无 UI。`,
      ].filter(Boolean).join('\n'),
      directorPrompt: buildDirectorStoryboardPrompt({
        number: index + 1,
        shot,
        visibleTimeLocation,
        environmentLock,
        lightingLock,
      }),
      videoPrompt: buildNaturalStoryboardPrompt({
        visualStyle: input.visualStyle,
        customStylePrompt: input.customStylePrompt,
        style: styleLock,
        people: [
          compactTimelineValue(characterLock, 900),
          `初始位置：${compactTimelineValue([shot.p, shot.f].filter(Boolean).join('；'), 600)}`,
        ].filter(Boolean).join('\n'),
        scene: conciseScene,
        detailedTimeline,
        duration: shot.d,
        aspectRatio: '16:9',
        characterNames,
      }),
      detailedTimeline,
      duration: shot.d,
      aspectRatio: '16:9',
      generateAudio: true,
      continuityIn,
      continuityOut,
    }
  })
}

async function saveStoryboardCheckpoint(
  taskId: string,
  payload: TaskPayload,
  checkpoint: z.output<typeof storyboardCheckpointSchema>,
  progress: number,
  detail: {
    phase: 'preparing' | 'generating' | 'retrying' | 'reviewing' | 'repairing' | 'verifying' | 'saving' | 'finalizing'
    completedEpisodes: number
    totalEpisodes: number
    completedSegments: number
    totalSegments: number
    activeEpisodeNumbers: number[]
    parallelism: number
    segmentParallelism: number
    currentSegment?: number
    currentSegmentTotal?: number
    reviewRound?: number
    maximumReviewRounds?: number
    modifiedShots?: number
    remainingIssues?: number
    fatalIssues?: number
    warning?: string
    activeRoutes?: Array<{
      episodeNumber: number
      provider: TextProviderLabel
      model: string
      attempt: number
      total: number
      reason?: string
    }>
  },
) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      progress: Math.max(0, Math.min(99, Math.round(progress))),
      payload: {
        ...payload,
        storyboardCheckpoint: checkpoint,
        storyboardProgress: detail,
      } as Prisma.InputJsonObject,
    },
  })
}

async function renumberGeneratedStoryboards(projectId: string) {
  const [generated, manualMaximum] = await Promise.all([
    prisma.storyboard.findMany({
      where: { projectId, generatedByAI: true },
      include: { episode: { select: { episodeNumber: true } } },
    }),
    prisma.storyboard.aggregate({
      where: { projectId, generatedByAI: false },
      _max: { sceneNumber: true },
    }),
  ])
  generated.sort((left, right) => (
    (left.episode?.episodeNumber || Number.MAX_SAFE_INTEGER) - (right.episode?.episodeNumber || Number.MAX_SAFE_INTEGER)
    || (left.episodeSceneNumber || 0) - (right.episodeSceneNumber || 0)
  ))
  const firstSceneNumber = (manualMaximum._max.sceneNumber || 0) + 1
  await prisma.$transaction(async (tx) => {
    for (let index = 0; index < generated.length; index++) {
      await tx.storyboard.update({
        where: { id: generated[index].id },
        data: { sceneNumber: -1_000_000 - index },
      })
    }
    for (let index = 0; index < generated.length; index++) {
      await tx.storyboard.update({
        where: { id: generated[index].id },
        data: { sceneNumber: firstSceneNumber + index },
      })
    }
  }, { timeout: 60_000 })
  return generated.map((item) => item.id)
}

async function processStoryboardGeneration(task: {
  id: string
  projectId: string
  createdById: string
  payload: Prisma.JsonValue | null
}) {
  const payload = payloadRecord(task.payload)
  const requestedEpisodeIds = storyboardRequestedEpisodeIds(payload)
  const targetEpisodes = await requireLockedEpisodes(task.projectId, requestedEpisodeIds)
  const targetEpisodeIds = targetEpisodes.map((episode) => episode.id)
  const replaceExisting = payload.replaceExisting === true || Boolean(payload.storyboardCheckpoint)
  const project = await prisma.project.findUnique({ where: { id: task.projectId } })
  if (!project) throw new Error('项目不存在')
  const projectStyle = {
    visualStyle: project.visualStyle,
    customStylePrompt: project.customStylePrompt,
  }
  const [episodes, assets, existingGenerated] = await Promise.all([
    prisma.scriptEpisode.findMany({
      where: {
        projectId: task.projectId,
        id: { in: targetEpisodeIds },
        locked: true,
      },
      orderBy: { episodeNumber: 'asc' },
    }),
    prisma.asset.findMany({
      where: { projectId: task.projectId },
      select: { id: true, type: true, name: true, description: true, tags: true, selectedImageId: true, updatedAt: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.storyboard.findMany({
      where: {
        projectId: task.projectId,
        episodeId: { in: targetEpisodeIds },
        generatedByAI: true,
      },
      select: { id: true, episodeId: true },
    }),
  ])
  if (existingGenerated.length > 0 && !replaceExisting) {
    throw new Error('项目已有 AI 分镜；确认替换后再重新生成')
  }
  const sourceFingerprint = createHash('sha256').update(JSON.stringify({
    pipelineVersion: 'storyboard-first-shotlab-scene-anchored-v14-compact-pipe-locations',
    visualStyle: project.visualStyle,
    customStylePrompt: project.customStylePrompt,
    episodes: episodes.map((episode) => ({ id: episode.id, updatedAt: episode.updatedAt.toISOString() })),
    assets: assets.map((asset) => ({ id: asset.id, updatedAt: asset.updatedAt.toISOString() })),
  })).digest('hex')
  const checkpoint = restoreStoryboardCheckpoint(payload.storyboardCheckpoint, sourceFingerprint)
  const existingByEpisode = new Map<string, string[]>()
  for (const storyboard of existingGenerated) {
    if (!storyboard.episodeId) continue
    const ids = existingByEpisode.get(storyboard.episodeId) || []
    ids.push(storyboard.id)
    existingByEpisode.set(storyboard.episodeId, ids)
  }
  const completedEpisodeIds = new Set(
    checkpoint.completedEpisodeIds.filter((episodeId) => (existingByEpisode.get(episodeId)?.length || 0) > 0),
  )
  checkpoint.completedEpisodeIds = [...completedEpisodeIds]
  const chunksByEpisode = new Map(
    episodes.map((episode) => [episode.id, splitStoryboardScript(episode.content)] as const),
  )
  const episodeIds = new Set(episodes.map((episode) => episode.id))
  checkpoint.segments = checkpoint.segments.filter((segment) => {
    const chunks = chunksByEpisode.get(segment.episodeId)
    return episodeIds.has(segment.episodeId)
      && !completedEpisodeIds.has(segment.episodeId)
      && Boolean(chunks?.[segment.segmentIndex])
  })
  checkpoint.episodeReviews = checkpoint.episodeReviews.filter((review) => (
    episodeIds.has(review.episodeId) && !completedEpisodeIds.has(review.episodeId)
  ))
  const totalSegments = Math.max(
    1,
    episodes.reduce((total, episode) => total + (chunksByEpisode.get(episode.id)?.length || 0), 0),
  )
  const pendingEpisodes = episodes.filter((episode) => !completedEpisodeIds.has(episode.id))
  const primaryKeyCount = env.textApiKeys().length
  const fallbackKeyCount = env.textFallbackApiKeys().length
  const tertiaryKeyCount = env.textTertiaryApiKeys().length
  const primaryCapacity = primaryKeyCount * env.textPrimaryConcurrencyPerKey()
  const segmentParallelism = Math.max(1, Math.min(
    env.textStoryboardSegmentConcurrency(),
    Math.max(1, primaryCapacity),
  ))
  const parallelism = textStoryboardParallelism({
    requested: env.textStoryboardConcurrency(),
    keyCount: primaryCapacity,
    pendingEpisodeCount: pendingEpisodes.length,
  })
  const episodeKeyIndexes = new Map(
    episodes.map((episode, index) => [episode.id, index] as const),
  )
  const activeEpisodeNumbers = new Set<number>()
  const activeRoutes = new Map<number, {
    episodeNumber: number
    provider: TextProviderLabel
    model: string
    attempt: number
    total: number
    reason?: string
  }>()
  let checkpointWrite = Promise.resolve()

  function storyboardRouteIdentity(provider: StoryboardTextRouteProvider) {
    if (provider === 'primary') {
      return { provider: textProviderLabel(env.textApiBaseUrl()), model: env.textModel() }
    }
    if (provider === 'fallback') {
      return { provider: textProviderLabel(env.textFallbackApiBaseUrl()), model: env.textFallbackModel() }
    }
    return { provider: textProviderLabel(env.textTertiaryApiBaseUrl()), model: env.textTertiaryModel() }
  }

  function completedSegmentCount() {
    let count = 0
    for (const episode of episodes) {
      const segmentTotal = chunksByEpisode.get(episode.id)?.length || 0
      if (completedEpisodeIds.has(episode.id)) {
        count += segmentTotal
        continue
      }
      count += new Set(
        checkpoint.segments
          .filter((segment) => segment.episodeId === episode.id && segment.segmentIndex < segmentTotal)
          .map((segment) => segment.segmentIndex),
      ).size
    }
    return Math.min(totalSegments, count)
  }

  function persistStoryboardState(
    phase: 'preparing' | 'generating' | 'retrying' | 'reviewing' | 'repairing' | 'verifying' | 'saving' | 'finalizing',
    current?: {
      segment?: number
      segmentTotal?: number
      reviewRound?: number
      maximumReviewRounds?: number
      modifiedShots?: number
      remainingIssues?: number
      fatalIssues?: number
      warning?: string
    },
  ) {
    checkpoint.completedEpisodeIds = [...completedEpisodeIds]
    const completedSegments = completedSegmentCount()
    const progress = phase === 'finalizing'
      ? 96
      : 5 + (completedSegments / totalSegments) * 88
    const checkpointSnapshot = storyboardCheckpointSchema.parse(checkpoint)
    const detail = {
      phase,
      completedEpisodes: completedEpisodeIds.size,
      totalEpisodes: episodes.length,
      completedSegments,
      totalSegments,
      activeEpisodeNumbers: [...activeEpisodeNumbers].sort((left, right) => left - right),
      activeRoutes: [...activeRoutes.values()].sort((left, right) => left.episodeNumber - right.episodeNumber),
      parallelism,
      segmentParallelism,
      ...(typeof current?.segment === 'number' ? { currentSegment: current.segment } : {}),
      ...(typeof current?.segmentTotal === 'number' ? { currentSegmentTotal: current.segmentTotal } : {}),
      ...(typeof current?.reviewRound === 'number' ? { reviewRound: current.reviewRound } : {}),
      ...(typeof current?.maximumReviewRounds === 'number' ? { maximumReviewRounds: current.maximumReviewRounds } : {}),
      ...(typeof current?.modifiedShots === 'number' ? { modifiedShots: current.modifiedShots } : {}),
      ...(typeof current?.remainingIssues === 'number' ? { remainingIssues: current.remainingIssues } : {}),
      ...(typeof current?.fatalIssues === 'number' ? { fatalIssues: current.fatalIssues } : {}),
      ...(current?.warning ? { warning: current.warning } : {}),
    }
    checkpointWrite = checkpointWrite.then(() => saveStoryboardCheckpoint(
      task.id,
      payload,
      checkpointSnapshot,
      progress,
      detail,
    ))
    return checkpointWrite
  }

  await persistStoryboardState('preparing')

  async function generateEpisodeStoryboards(
    episode: (typeof episodes)[number],
    retryPass = false,
    route: StoryboardTextRoute,
    allowResidualFinalize = false,
  ) {
    activeEpisodeNumbers.add(episode.episodeNumber)
    await persistStoryboardState(retryPass ? 'retrying' : 'generating')
    const episodeText = `${episode.title}\n${episode.logline || ''}\n${episode.content}`
    const initiallyRelatedAssets = matchStoryboardAssets(
      assets,
      episodeText,
      8,
    )
    const matchedAssetLocations = matchStoryboardAssets(
      assets.filter((asset) => asset.type === AssetType.location),
      episodeText,
      12,
    )
    const extractedScriptLocations = extractScriptSceneLocations(episode.content)
    const scriptLocations = extractedScriptLocations
    const scriptedLocationAssets = scriptLocations.map((location, index) => ({
      id: `script-location-${episode.id}-${index}`,
      type: AssetType.location,
      name: location.name,
      description: location.description,
      tags: ['剧本标准场景'],
      selectedImageId: null,
      updatedAt: episode.updatedAt,
    }))
    const episodeLocations = scriptLocations.length > 0
      ? scriptedLocationAssets
      : matchedAssetLocations
    const relatedAssetMap = new Map(
      [
        ...initiallyRelatedAssets,
        ...episodeLocations,
      ].map((asset) => [asset.id, asset]),
    )
    const relatedAssets = [...relatedAssetMap.values()]
    const promptAssets = relatedAssets.map((asset) => ({
      type: asset.type,
      name: asset.name,
      description: asset.description.slice(0, 120),
    }))
    const indexedAssets = new Map<string, { id: string; type: AssetType; name: string }>()
    for (const asset of relatedAssets) indexedAssets.set(asset.id, asset)
    for (const asset of assets) {
      if (episode.content.includes(asset.name)) indexedAssets.set(asset.id, asset)
      if (indexedAssets.size >= 24) break
    }
    const allAssetNames = [
      ...[...indexedAssets.values()].map((asset) => ({ type: asset.type, name: asset.name })),
      ...episodeLocations.map((location) => ({ type: AssetType.location, name: location.name })),
    ]

    async function generateSegment(script: string, segment?: {
      index: number
      total: number
      previousTail?: string
      previousShotTail?: string
      nextHead?: string
    }, requestedTargetShotCount = targetStoryboardShotCount(script), allowRepair = true) {
      const targetShotCount = Math.max(1, Math.min(40, Math.round(requestedTargetShotCount)))
      const locationContext = [
        script,
        segment?.previousTail,
        segment?.previousShotTail,
        segment?.nextHead,
      ].filter(Boolean).join('\n')
      const segmentLocationMatches = matchStoryboardAssets(
        episodeLocations,
        locationContext,
        episodeLocations.length,
      )
      const explicitSegmentLocations = extractScriptSceneLocations(script)
      const exactSegmentLocations = episodeLocations.filter((location) => (
        explicitSegmentLocations.some((explicit) => (
          normalizedStoryboardLocation(location.name) === normalizedStoryboardLocation(explicit.name)
        ))
      ))
      const allowedLocations = exactSegmentLocations.length > 0
        ? exactSegmentLocations
        : segmentLocationMatches.length > 0
          ? segmentLocationMatches
          : episodeLocations
      const allowedLocationNames = new Set(allowedLocations.map((location) => location.name))
      const segmentPromptAssets = promptAssets.filter((asset) => (
        asset.type !== AssetType.location || allowedLocationNames.has(asset.name)
      ))
      let parsed = await callStructuredText({
        system: STORYBOARD_SYSTEM_PROMPT,
        prompt: buildStoryboardGenerationPrompt({
          episodeNumber: episode.episodeNumber,
          episodeTitle: episode.title,
          script,
          assets: segmentPromptAssets,
          allAssetNames,
          scriptLocations: allowedLocations.map((location) => ({
            name: location.name,
            description: location.description,
          })),
          visualStyle: projectStyle.visualStyle,
          customStylePrompt: projectStyle.customStylePrompt,
          targetShotCount,
          segment,
        }),
        schema: compactStoryboardSchema,
        maxOutputTokens: Math.min(8_000, Math.max(script.length <= 200 ? 2_600 : 4_000, targetShotCount * 900)),
        timeoutMs: route.timeoutMs,
        maxAttempts: route.maxAttempts,
        reasoningEffort: 'low',
        primaryKeyIndex: route.primaryKeyIndex,
        fallbackKeyIndex: route.fallbackKeyIndex,
        tertiaryKeyIndex: route.tertiaryKeyIndex,
        allowPrimary: route.allowPrimary,
        allowFallback: route.allowFallback,
        allowTertiary: route.allowTertiary,
      })
      if (projectStyle.visualStyle === VisualStyle.overseas_live_action) {
        const chineseDialogueShots = parsed.shots.flatMap((shot, index) => (
          extractStoryboardShotDialogues(shot.a).some((dialogue) => /\p{Script=Han}/u.test(dialogue.text))
            ? [{ shotNumber: index + 1, a: shot.a }]
            : []
        ))
        if (chineseDialogueShots.length > 0) {
          const translated = await callStructuredText({
            system: 'You are an American TV dialogue translator. Return strict JSON only. Translate spoken dialogue into concise natural American English while preserving every speaker, meaning, order, and dialogue marker. Do not change action fields.',
            prompt: `Translate only the a fields listed below. Character names before the colon may remain unchanged, but every spoken word after the colon must be natural American English. Do not add, remove, merge, reorder, or explain any line.\n\nSource script for meaning:\n${script}\n\nCurrent dialogue fields:\n${JSON.stringify(chineseDialogueShots)}`,
            schema: storyboardDialogueTranslationSchema,
            maxOutputTokens: Math.min(3_000, 900 + chineseDialogueShots.length * 500),
            timeoutMs: Math.min(route.timeoutMs, 60_000),
            maxAttempts: 1,
            reasoningEffort: 'low',
            primaryKeyIndex: route.primaryKeyIndex,
            fallbackKeyIndex: route.fallbackKeyIndex,
            tertiaryKeyIndex: route.tertiaryKeyIndex,
            allowPrimary: route.allowPrimary,
            allowFallback: route.allowFallback,
            allowTertiary: route.allowTertiary,
          })
          const translations = new Map(translated.translations.map((item) => [item.shotNumber, item.a]))
          parsed = {
            shots: parsed.shots.map((shot, index) => ({
              ...shot,
              a: translations.get(index + 1) || shot.a,
            })),
          }
        }
      }
      const dialogues = projectStyle.visualStyle === VisualStyle.overseas_live_action
        ? []
        : extractScriptDialogueLines(script)
      const missing = dialogues.filter((dialogue) => storyboardDialogueMissing(parsed.shots, dialogue))
      if (allowRepair && missing.length > 0) {
        let supplementalShots: CompactShot[] = []
        try {
          const supplemental = await callStructuredText({
            system: '你是分镜对白补录导演。只生成遗漏对白、旁白、画外音或【OS】对应的补充镜头；逐字保留说话人、顺序和完整原文，过长时只能拆镜，禁止删改；禁止返回空数组。',
            prompt: buildMissingDialogueShotsPrompt({
              episodeNumber: episode.episodeNumber,
              script,
              missing,
            }),
            schema: compactStoryboardAllowEmptySchema,
            maxOutputTokens: Math.min(4_000, 1_200 + missing.length * 700),
            timeoutMs: Math.min(route.timeoutMs, 60_000),
            maxAttempts: route.maxAttempts,
            reasoningEffort: 'low',
            primaryKeyIndex: route.primaryKeyIndex,
            fallbackKeyIndex: route.fallbackKeyIndex,
            tertiaryKeyIndex: route.tertiaryKeyIndex,
            allowPrimary: route.allowPrimary,
            allowFallback: route.allowFallback,
            allowTertiary: route.allowTertiary,
          })
          supplementalShots = [...supplemental.shots]
        } catch (error) {
          if (nonRetryableTextApiError(error)) throw error
        }

        const unresolved = missing.filter((dialogue) => storyboardDialogueMissing(supplementalShots, dialogue))
        for (const dialogue of unresolved) {
          const single = await callStructuredText({
            system: '你是分镜对白补录导演。必须为唯一指定对白输出一个镜头，完整保留关键语义并使用自然可表演的台词，shots 禁止为空。',
            prompt: `${buildMissingDialogueShotsPrompt({
              episodeNumber: episode.episodeNumber,
              script,
              missing: [dialogue],
            })}\n\n【再次确认】只输出一个镜头，shots 数组必须恰好包含一项。`,
            schema: compactStoryboardSchema,
            maxOutputTokens: 1_800,
            timeoutMs: Math.min(route.timeoutMs, 60_000),
            maxAttempts: route.maxAttempts,
            reasoningEffort: 'low',
            primaryKeyIndex: route.primaryKeyIndex,
            fallbackKeyIndex: route.fallbackKeyIndex,
            tertiaryKeyIndex: route.tertiaryKeyIndex,
            allowPrimary: route.allowPrimary,
            allowFallback: route.allowFallback,
            allowTertiary: route.allowTertiary,
          })
          supplementalShots.push(enforceSupplementalDialogue(single.shots[0], dialogue))
        }

        parsed = {
          shots: insertMissingDialogueShots({
            current: parsed.shots,
            supplemental: supplementalShots,
            script,
            missing,
          }),
        }
      }
      let atomicShots = enforceStoryboardLocationAssets(
        compactStoryboardShots(parsed.shots, targetShotCount),
        allowedLocations,
      )
      const atomicityIssues = storyboardAtomicityIssues(atomicShots, allowedLocations)
      if (atomicityIssues.length > 0) {
        const issueLines = atomicityIssues.map((issue) => (
          `镜头 ${issue.index + 1}《${issue.title}》：${issue.reasons.join('；')}`
        ))
        const repaired = await callStructuredText({
          system: '你是分镜原子化审片导演。只拆分不合格镜头，禁止合并、改序、删改任何现场对白、旁白、画外音或【OS】；同一原子分镜可按剧本顺序包含多位现场对白说话人，对白过长时只能拆镜。',
          prompt: buildStoryboardAtomicRepairPrompt({
            episodeNumber: episode.episodeNumber,
            script,
            currentJson: JSON.stringify({ shots: atomicShots }),
            issues: issueLines,
            minimumShotCount: targetShotCount,
          }),
          schema: compactStoryboardSchema,
          maxOutputTokens: Math.min(8_000, Math.max(4_000, targetShotCount * 900)),
          timeoutMs: route.timeoutMs,
          maxAttempts: 1,
          reasoningEffort: 'low',
          primaryKeyIndex: route.primaryKeyIndex,
          fallbackKeyIndex: route.fallbackKeyIndex,
          tertiaryKeyIndex: route.tertiaryKeyIndex,
          allowPrimary: route.allowPrimary,
          allowFallback: route.allowFallback,
          allowTertiary: route.allowTertiary,
        })
        atomicShots = enforceStoryboardLocationAssets(repaired.shots, allowedLocations)
        const repairedMissing = dialogues.filter((dialogue) => storyboardDialogueMissing(atomicShots, dialogue))
        if (repairedMissing.length > 0) {
          const supplemental = await callStructuredText({
            system: '你是分镜对白补录导演。原子化重拆后只补录遗漏的现场对白、旁白、画外音或【OS】；同一 4 秒原子镜头可按剧本顺序包含多位现场对白说话人，逐字保留完整原文，过长时只能拆镜。',
            prompt: buildMissingDialogueShotsPrompt({
              episodeNumber: episode.episodeNumber,
              script,
              missing: repairedMissing,
            }),
            schema: compactStoryboardAllowEmptySchema,
            maxOutputTokens: Math.min(4_000, 1_200 + repairedMissing.length * 700),
            timeoutMs: Math.min(route.timeoutMs, 60_000),
            maxAttempts: 1,
            reasoningEffort: 'low',
            primaryKeyIndex: route.primaryKeyIndex,
            fallbackKeyIndex: route.fallbackKeyIndex,
            tertiaryKeyIndex: route.tertiaryKeyIndex,
            allowPrimary: route.allowPrimary,
            allowFallback: route.allowFallback,
            allowTertiary: route.allowTertiary,
          })
          const supplementalShots = supplemental.shots.map((shot) => ({ ...shot, d: 4 }))
          const unresolved = repairedMissing.filter((dialogue) => storyboardDialogueMissing(supplementalShots, dialogue))
          for (const dialogue of unresolved) {
            const single = await callStructuredText({
              system: '你是分镜对白补录导演。必须为唯一指定对白输出一个 4 秒原子镜头，保留关键语义并确保自然语速。',
              prompt: `${buildMissingDialogueShotsPrompt({
                episodeNumber: episode.episodeNumber,
                script,
                missing: [dialogue],
              })}\n\n【再次确认】只输出一个 4 秒镜头，shots 数组必须恰好包含一项。`,
              schema: compactStoryboardSchema,
              maxOutputTokens: 1_800,
              timeoutMs: Math.min(route.timeoutMs, 60_000),
              maxAttempts: 1,
              reasoningEffort: 'low',
              primaryKeyIndex: route.primaryKeyIndex,
              fallbackKeyIndex: route.fallbackKeyIndex,
              tertiaryKeyIndex: route.tertiaryKeyIndex,
              allowPrimary: route.allowPrimary,
              allowFallback: route.allowFallback,
              allowTertiary: route.allowTertiary,
            })
            supplementalShots.push({ ...enforceSupplementalDialogue(single.shots[0], dialogue), d: 4 })
          }
          atomicShots = enforceStoryboardLocationAssets(insertMissingDialogueShots({
            current: atomicShots,
            supplemental: supplementalShots,
            script,
            missing: repairedMissing,
          }), allowedLocations)
        }
      }
      return stitchStoryboardContinuity(atomicShots, segment?.previousShotTail)
    }

    try {
      const chunks = chunksByEpisode.get(episode.id) || [episode.content]
      const episodeTargetShotCount = targetStoryboardShotCount(episode.content, 18)
      const segmentShotTargets = allocateStoryboardShotTargets(chunks, episodeTargetShotCount)
      const groups: Array<CompactShot[] | undefined> = Array.from({ length: chunks.length })
      const pendingIndexes: number[] = []
      for (let index = 0; index < chunks.length; index++) {
        const cached = checkpoint.segments.find(
          (segment) => segment.episodeId === episode.id && segment.segmentIndex === index,
        )
        if (cached) {
          groups[index] = cached.shots
          continue
        }
        pendingIndexes.push(index)
      }

      async function generateChunk(index: number) {
        const previousGroup = groups[index - 1]
        const previousGeneratedTail = previousGroup?.[previousGroup.length - 1]?.g
        const segmentContext = {
          index: index + 1,
          total: chunks.length,
          previousTail: chunks[index - 1]?.slice(-180),
          previousShotTail: previousGeneratedTail,
          nextHead: chunks[index + 1]?.slice(0, 180),
        }
        let shots: CompactShot[]
        try {
          shots = await generateSegment(chunks[index], segmentContext, segmentShotTargets[index])
        } catch (error) {
          if (nonRetryableTextApiError(error) || chunks[index].length <= 200) throw error
          const subchunks = splitStoryboardScript(chunks[index], Math.max(140, Math.ceil(chunks[index].length / 2)))
          if (subchunks.length <= 1) throw error
          const subchunkShotTargets = allocateStoryboardShotTargets(subchunks, segmentShotTargets[index])
          const subgroups: CompactShot[][] = []
          for (let subIndex = 0; subIndex < subchunks.length; subIndex++) {
            const previousSubgroup = subgroups[subgroups.length - 1]
            const previousSubgroupTail = previousSubgroup?.[previousSubgroup.length - 1]?.g
            subgroups.push(await generateSegment(subchunks[subIndex], {
              index: index + 1,
              total: chunks.length,
              previousTail: subchunks[subIndex - 1]?.slice(-180) || segmentContext.previousTail,
              previousShotTail: previousSubgroupTail || segmentContext.previousShotTail,
              nextHead: subchunks[subIndex + 1]?.slice(0, 180) || segmentContext.nextHead,
            }, subchunkShotTargets[subIndex]))
          }
          shots = subgroups.flat()
        }
        groups[index] = shots
        checkpoint.segments = checkpoint.segments.filter(
          (segment) => segment.episodeId !== episode.id || segment.segmentIndex !== index,
        )
        checkpoint.segments.push({ episodeId: episode.id, segmentIndex: index, shots })
        await persistStoryboardState('generating', {
          segment: index + 1,
          segmentTotal: chunks.length,
        })
      }

      for (const batch of batchesOf(pendingIndexes, segmentParallelism)) {
        await persistStoryboardState(retryPass ? 'retrying' : 'generating', {
          segment: batch[0] + 1,
          segmentTotal: chunks.length,
        })
        const settled = await Promise.allSettled(batch.map((index) => generateChunk(index)))
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) throw failed.reason
      }

      const completedGroups = groups.map((group, index) => {
        if (!group) throw new Error(`第 ${episode.episodeNumber} 集第 ${index + 1} 段未生成完成`)
        return group
      })
      const voiceoverReducedShots = suppressNonessentialStoryboardVoiceovers(
        completedGroups.flat(),
        episode.content,
      )
      let atomicShots = compactStoryboardShots(
        stitchStoryboardContinuity(voiceoverReducedShots),
        episodeTargetShotCount,
      )
      atomicShots = stitchStoryboardContinuity(splitOverlongStoryboardDialogueShots(atomicShots))
      const normalizeFinalReviewShots = (shots: CompactShot[]) => repairStoryboardDirectorCoverage(
        stitchStoryboardContinuity(
          normalizeStoryboardSpokenAudioRules(
            dedupeStoryboardDialogueShots(
              splitOverlongStoryboardDialogueShots(
                enforceStoryboardLocationAssets(
                  suppressNonessentialStoryboardVoiceovers(
                    projectStyle.visualStyle === VisualStyle.overseas_live_action
                      ? normalizeOverseasStoryboardDialogueTerms(shots)
                      : shots,
                    episode.content,
                  ),
                  episodeLocations,
                ).map((shot) => ({
                  ...shot,
                  d: Math.max(4, Math.min(6, shot.d)),
                  e: conciseStoryboardSceneFacts(shot.e, 160)
                    || `${shot.n}。仅保留该地点的空间结构、固定陈设、材质、天气、空气状态和静态光线。`,
                })),
              ),
              {
                script: episode.content,
                visualStyle: projectStyle.visualStyle,
              },
            ),
          ),
        ),
      )
      const runFinalEpisodeReview = async (
        shots: CompactShot[],
        issues: string[] = [],
        verificationRound?: number,
      ) => {
        const reviewed = await callStructuredText({
          system: '你是短剧分镜总审片导演。必须逐行对照整集锁定剧本，只输出结构化问题报告。不得修改镜头、不得输出补丁，也不得为通过检查改写剧本。',
          prompt: buildStoryboardFinalReviewPrompt({
            episodeNumber: episode.episodeNumber,
            script: episode.content,
            currentJson: JSON.stringify({ shots }),
            targetShotCount: Math.max(episodeTargetShotCount, shots.length),
            visualStyle: projectStyle.visualStyle,
            allowedLocationNames: episodeLocations.map((location) => location.name),
            issues,
            verificationRound,
          }),
          schema: storyboardFinalReviewReportSchema,
          maxOutputTokens: Math.min(4_500, Math.max(1_800, episodeTargetShotCount * 180)),
          timeoutMs: route.timeoutMs,
          maxAttempts: 1,
          reasoningEffort: 'low',
          primaryKeyIndex: route.primaryKeyIndex,
          fallbackKeyIndex: route.fallbackKeyIndex,
          tertiaryKeyIndex: route.tertiaryKeyIndex,
          allowPrimary: route.allowPrimary,
          allowFallback: route.allowFallback,
          allowTertiary: route.allowTertiary,
        })
        if (!reviewed.passed && reviewed.issues.length === 0 && issues.length === 0) {
          return { passed: true, issues: [] }
        }
        return reviewed
      }

      const runFinalEpisodeRepair = async (
        shots: CompactShot[],
        issues: StoryboardFinalReviewIssue[],
        repairRound: number,
      ) => callStructuredText({
        system: '你是短剧分镜修复导演。复查问题已经确定；必须逐项执行修改并返回可应用补丁，不能只重复问题，不能改写锁定剧本。',
        prompt: buildStoryboardFinalRepairPrompt({
          episodeNumber: episode.episodeNumber,
          script: episode.content,
          currentJson: JSON.stringify({ shots }),
          targetShotCount: Math.max(episodeTargetShotCount, shots.length),
          visualStyle: projectStyle.visualStyle,
          allowedLocationNames: episodeLocations.map((location) => location.name),
          issues,
          repairRound,
        }),
        schema: storyboardFinalReviewPatchSchema,
        maxOutputTokens: Math.min(6_000, Math.max(2_400, episodeTargetShotCount * 320)),
        timeoutMs: route.timeoutMs,
        maxAttempts: 1,
        reasoningEffort: 'low',
        primaryKeyIndex: route.primaryKeyIndex,
        fallbackKeyIndex: route.fallbackKeyIndex,
        tertiaryKeyIndex: route.tertiaryKeyIndex,
        allowPrimary: route.allowPrimary,
        allowFallback: route.allowFallback,
        allowTertiary: route.allowTertiary,
      })

      const localFinalReviewIssues = (shots: CompactShot[]) => {
        const createIssue = (
          problem: string,
          category: StoryboardFinalReviewIssue['category'],
          severity: StoryboardFinalReviewIssue['severity'],
          shotNumber?: number,
        ): StoryboardFinalReviewIssue => ({
          severity,
          category,
          shotNumbers: shotNumber ? [shotNumber] : [],
          scriptEvidence: '以本集锁定剧本和相邻镜头状态为准',
          problem,
          repairInstruction: problem,
        })
        const atomicity = storyboardAtomicityIssues(shots, episodeLocations)
          .flatMap((issue) => issue.reasons.map((reason) => createIssue(
            `镜头 ${issue.index + 1}《${issue.title}》：${reason}`,
            'prompt_conflict',
            'fatal',
            issue.index + 1,
          )))
        const continuity = storyboardContinuityIssues(shots)
          .flatMap((issue) => issue.reasons.map((reason) => createIssue(
            `镜头 ${issue.index + 1}《${issue.title}》：${reason}`,
            'continuity',
            'fatal',
            issue.index + 1,
          )))
        const episodeReview = storyboardEpisodeReviewIssues(shots, {
          script: episode.content,
          visualStyle: projectStyle.visualStyle,
        }).flatMap((issue) => issue.reasons.map((reason) => {
          const category = finalReviewCategory(undefined, reason)
          return createIssue(
            `镜头 ${issue.index + 1}《${issue.title}》：${reason}`,
            category,
            category === 'directing' ? 'warning' : 'fatal',
            issue.index + 1,
          )
        }))
        const directorReview = storyboardDirectorIssues(shots)
          .flatMap((issue) => issue.reasons.map((reason) => createIssue(
            `镜头 ${issue.index + 1}《${issue.title}》：${reason}`,
            'directing',
            'warning',
            issue.index + 1,
          )))
        const dynamicScenes = shots.flatMap((shot, index) => (
          storyboardSceneHasDynamicContent(shot.e)
            ? [createIssue(
                `镜头 ${index + 1}《${shot.t}》：场景描述含人物动作、表情、对白、接触或剧情过程；必须移入视频分镜，e 只保留静态环境`,
                'scene',
                'fatal',
                index + 1,
              )]
            : []
        ))
        const missingDialogue = projectStyle.visualStyle === VisualStyle.overseas_live_action
          ? []
          : extractScriptDialogueLines(episode.content)
            .filter((dialogue) => storyboardDialogueMissing(shots, dialogue))
            .map((dialogue) => createIssue(
              `遗漏现场对白“${dialogue.speaker}：${dialogue.text}”`,
              'dialogue',
              'fatal',
            ))
        return dedupeStoryboardFinalReviewIssues([
          ...atomicity,
          ...continuity,
          ...episodeReview,
          ...directorReview,
          ...dynamicScenes,
          ...missingDialogue,
        ])
      }

      const reviewBaselineShots = normalizeFinalReviewShots(atomicShots)
      const maximumFinalReviewRounds = 3
      const savedReviewState = checkpoint.episodeReviews.find((review) => review.episodeId === episode.id)
      let reviewStage = savedReviewState?.stage || null
      let reviewRound = savedReviewState?.round || 0
      let noChangeAttempts = savedReviewState?.noChangeAttempts || 0
      let modifiedShots = savedReviewState?.modifiedShots || 0
      let currentReviewShots = savedReviewState?.currentShots || reviewBaselineShots
      let currentReviewIssues = savedReviewState?.currentIssues || []
      let bestReviewShots = savedReviewState?.bestShots || currentReviewShots
      let bestReviewIssues = savedReviewState?.bestIssues || currentReviewIssues

      const saveEpisodeReviewState = async (
        phase: 'reviewing' | 'repairing' | 'verifying',
        warning?: string,
      ) => {
        checkpoint.episodeReviews = checkpoint.episodeReviews.filter((review) => review.episodeId !== episode.id)
        checkpoint.episodeReviews.push({
          episodeId: episode.id,
          stage: reviewStage || 'reviewed',
          round: reviewRound,
          noChangeAttempts,
          modifiedShots,
          currentShots: currentReviewShots,
          currentIssues: currentReviewIssues,
          bestShots: bestReviewShots,
          bestIssues: bestReviewIssues,
        })
        await persistStoryboardState(phase, {
          reviewRound,
          maximumReviewRounds: maximumFinalReviewRounds,
          modifiedShots,
          remainingIssues: currentReviewIssues.length,
          fatalIssues: currentReviewIssues.filter((issue) => issue.severity === 'fatal').length,
          warning,
        })
      }

      const mergeReviewIssues = (
        shots: CompactShot[],
        report: StoryboardFinalReviewReport,
      ) => {
        const actionableProblems = new Set(actionableStoryboardFinalReviewIssues(
          report.issues.map((issue) => issue.problem),
          {
            script: episode.content,
            shots,
            allowedLocationNames: episodeLocations.map((location) => location.name),
          },
        ))
        const semanticIssues = report.issues.filter((issue) => actionableProblems.has(issue.problem))
        return dedupeStoryboardFinalReviewIssues([
          ...localFinalReviewIssues(shots),
          ...semanticIssues,
        ])
      }

      if (!reviewStage) {
        const localIssues = localFinalReviewIssues(currentReviewShots)
        await persistStoryboardState('reviewing', {
          reviewRound,
          maximumReviewRounds: maximumFinalReviewRounds,
          modifiedShots,
          remainingIssues: localIssues.length,
          fatalIssues: localIssues.filter((issue) => issue.severity === 'fatal').length,
        })
        const report = await runFinalEpisodeReview(
          currentReviewShots,
          localIssues.map((issue) => issue.problem).slice(0, 24),
        )
        currentReviewIssues = mergeReviewIssues(currentReviewShots, report)
        bestReviewShots = currentReviewShots
        bestReviewIssues = currentReviewIssues
        reviewStage = 'reviewed'
        await saveEpisodeReviewState('reviewing')
      }

      let finalReviewWarnings: StoryboardFinalReviewIssue[] = []
      while (true) {
        if (shouldFinalizeStoryboardReviewLocally({
          stage: reviewStage,
          round: reviewRound,
          maximumRounds: maximumFinalReviewRounds,
        })) {
          currentReviewIssues = localFinalReviewIssues(currentReviewShots)
          const preferred = preferStoryboardReviewCandidate({
            currentShots: currentReviewShots,
            currentIssues: currentReviewIssues,
            bestShots: bestReviewShots,
            bestIssues: bestReviewIssues,
          })
          bestReviewShots = preferred.shots
          bestReviewIssues = preferred.issues
          atomicShots = bestReviewShots
          currentReviewShots = bestReviewShots
          currentReviewIssues = bestReviewIssues
          reviewStage = 'verified'
          finalReviewWarnings = nonBlockingStoryboardReviewWarnings(bestReviewIssues)
          await saveEpisodeReviewState(
            'verifying',
            `已完成 ${maximumFinalReviewRounds} 轮返工和本地完整校验，保存问题最少的版本；剩余 ${bestReviewIssues.length} 项转为人工确认，不再因外部复核超时阻断下一步`,
          )
          break
        }

        if (reviewStage === 'repaired') {
          const localIssues = localFinalReviewIssues(currentReviewShots)
          await persistStoryboardState('verifying', {
            reviewRound,
            maximumReviewRounds: maximumFinalReviewRounds,
            modifiedShots,
            remainingIssues: localIssues.length,
            fatalIssues: localIssues.filter((issue) => issue.severity === 'fatal').length,
          })
          let verificationWarning: string | undefined
          try {
            const report = await runFinalEpisodeReview(
              currentReviewShots,
              localIssues.map((issue) => issue.problem).slice(0, 24),
              reviewRound,
            )
            currentReviewIssues = mergeReviewIssues(currentReviewShots, report)
          } catch (error) {
            if (!canUseLocalStoryboardVerificationFallback(error)) throw error
            currentReviewIssues = localIssues
            verificationWarning = `第 ${reviewRound} 轮外部验收暂时不可用，已用本地完整校验继续返工；最新修复稿和 ${localIssues.length} 项检查结果均已保存`
          }
          const preferred = preferStoryboardReviewCandidate({
            currentShots: currentReviewShots,
            currentIssues: currentReviewIssues,
            bestShots: bestReviewShots,
            bestIssues: bestReviewIssues,
          })
          bestReviewShots = preferred.shots
          bestReviewIssues = preferred.issues
          reviewStage = 'verified'
          await saveEpisodeReviewState('verifying', verificationWarning)
        }

        if (currentReviewIssues.length === 0) {
          atomicShots = currentReviewShots
          break
        }

        if (noChangeAttempts >= 3) {
          if (!allowResidualFinalize && storyboardFinalReviewHasFatalIssues(bestReviewIssues)) {
            noChangeAttempts = 0
            reviewStage = 'verified'
            await saveEpisodeReviewState(
              'repairing',
              '当前文字线路连续返回无变化补丁，已保存最新修复稿并切换备用线路继续修改',
            )
            throw new Error('STORYBOARD_REPAIR_NO_PROGRESS: 当前文字线路连续返回无变化补丁')
          }
          atomicShots = bestReviewShots
          currentReviewShots = bestReviewShots
          currentReviewIssues = bestReviewIssues
          reviewStage = 'verified'
          finalReviewWarnings = nonBlockingStoryboardReviewWarnings(bestReviewIssues)
          await saveEpisodeReviewState(
            'verifying',
            `连续 3 次返工没有继续改善，已保存当前最佳版本；剩余 ${bestReviewIssues.length} 项转为人工确认，不阻断下一步`,
          )
          break
        }

        if (reviewRound >= maximumFinalReviewRounds) {
          atomicShots = bestReviewShots
          currentReviewShots = bestReviewShots
          currentReviewIssues = bestReviewIssues
          reviewStage = 'verified'
          finalReviewWarnings = nonBlockingStoryboardReviewWarnings(bestReviewIssues)
          await saveEpisodeReviewState(
            'verifying',
            `已完成 ${maximumFinalReviewRounds} 轮返工并保存最佳版本；剩余 ${bestReviewIssues.length} 项转为人工确认，不阻断下一步`,
          )
          break
        }

        await persistStoryboardState('repairing', {
          reviewRound: reviewRound + 1,
          maximumReviewRounds: maximumFinalReviewRounds,
          modifiedShots,
          remainingIssues: currentReviewIssues.length,
          fatalIssues: currentReviewIssues.filter((issue) => issue.severity === 'fatal').length,
        })
        let patch: z.output<typeof storyboardFinalReviewPatchSchema>
        try {
          patch = await runFinalEpisodeRepair(
            currentReviewShots,
            currentReviewIssues,
            reviewRound + 1,
          )
        } catch (error) {
          if (!canUseLocalStoryboardVerificationFallback(error)) throw error
          if (!allowResidualFinalize) {
            reviewStage = 'verified'
            await saveEpisodeReviewState(
              'repairing',
              '当前修改线路暂时不可用，已保存最新修复稿并切换备用线路继续修改',
            )
            throw error
          }
          atomicShots = bestReviewShots
          currentReviewShots = bestReviewShots
          currentReviewIssues = bestReviewIssues
          reviewStage = 'verified'
          finalReviewWarnings = nonBlockingStoryboardReviewWarnings(bestReviewIssues)
          await saveEpisodeReviewState(
            'verifying',
            `已完成 ${reviewRound} 轮有效返工；后续修改线路暂时不可用，已保存问题最少的版本，剩余 ${bestReviewIssues.length} 项作为人工修改建议，不阻断下一步`,
          )
          break
        }
        const repairedShots = normalizeFinalReviewShots(
          applyStoryboardFinalReviewPatch(currentReviewShots, patch),
        )
        const changedShots = storyboardShotChangeCount(currentReviewShots, repairedShots)
        if (changedShots === 0) {
          noChangeAttempts++
          await saveEpisodeReviewState(
            'repairing',
            !allowResidualFinalize
              ? '当前文字线路返回空补丁或修改后内容没有变化，已保存检查点并切换备用线路'
              : undefined,
          )
          if (!allowResidualFinalize) {
            noChangeAttempts = 0
            reviewStage = 'verified'
            await saveEpisodeReviewState('repairing')
            throw new Error('STORYBOARD_REPAIR_EMPTY_PATCH: 当前文字线路没有产生有效修改')
          }
          continue
        }
        currentReviewShots = repairedShots
        reviewRound++
        modifiedShots += changedShots
        noChangeAttempts = 0
        reviewStage = 'repaired'
        currentReviewIssues = localFinalReviewIssues(currentReviewShots)
        await saveEpisodeReviewState('verifying')
      }

      atomicShots = normalizeFinalReviewShots(atomicShots)
      let videoReadyShots = packStoryboardVideoClips(atomicShots)
      const deterministicallyStitchedShots = stitchStoryboardContinuity(videoReadyShots)
      const originalPackedContinuityIssues = storyboardContinuityIssues(videoReadyShots)
      const stitchedPackedContinuityIssues = storyboardContinuityIssues(deterministicallyStitchedShots)
      if (stitchedPackedContinuityIssues.length <= originalPackedContinuityIssues.length) {
        videoReadyShots = deterministicallyStitchedShots
      }
      const packedContinuityIssues = storyboardContinuityIssues(videoReadyShots)
      if (packedContinuityIssues.length > 0) {
        finalReviewWarnings = dedupeStoryboardFinalReviewIssues([
          ...finalReviewWarnings,
          ...nonBlockingStoryboardReviewWarnings(packedContinuityIssues.flatMap((issue) => (
            issue.reasons.map((reason) => ({
              severity: 'fatal' as const,
              category: 'continuity' as const,
              shotNumbers: [issue.index + 1],
              scriptEvidence: '以锁定剧本和相邻镜头状态为准',
              problem: `分镜 ${issue.index + 1}《${issue.title}》：${reason}`,
              repairInstruction: reason,
            }))
          ))),
        ])
      }

      await persistStoryboardState('saving')
      const materializedItems = materializeStoryboards({
        shots: videoReadyShots,
        visualStyle: projectStyle.visualStyle,
        customStylePrompt: projectStyle.customStylePrompt,
      })
      if (materializedItems.length === 0) {
        throw new Error(`STORYBOARD_OUTPUT_EMPTY: 第 ${episode.episodeNumber} 集没有可保存的分镜内容`)
      }
      const finalDialogueDocuments: FinalStoryboardDialogueDocument[] = materializedItems.map((item, index) => ({
        id: `generated-${index + 1}`,
        number: index + 1,
        title: item.title,
        videoPrompt: item.videoPrompt,
      }))
      const finalDialogueRepair = repairExactFinalStoryboardDialogueDuplicates(
        finalDialogueDocuments,
        episode.content,
      )
      if (finalDialogueRepair.issues.length > 0) {
        throw new Error(
          `STORYBOARD_FINAL_DIALOGUE_INVALID: 最终可生成提示词仍有重复台词，已阻止覆盖正式分镜。${finalDialogueRepair.issues.slice(0, 6).map((issue) => issue.message).join('；')}`,
        )
      }
      const repairedPromptById = new Map(finalDialogueRepair.documents.map((item) => [item.id, item.videoPrompt]))
      const items = materializedItems.map((item, index) => ({
        ...item,
        videoPrompt: repairedPromptById.get(`generated-${index + 1}`) || item.videoPrompt,
      }))
      const timelineDetailIssues = items.flatMap((item, index) => (
        storyboardTimelineDetailIssues(item.detailedTimeline).map((issue) => ({
          storyboardNumber: index + 1,
          ...issue,
        }))
      ))
      if (timelineDetailIssues.length > 0) {
        const detailWarnings = timelineDetailIssues.slice(0, 12).map((issue) => {
          const details = [
            issue.missing.length > 0 ? `缺少${issue.missing.join('、')}` : '',
            issue.insufficient.length > 0 ? `${issue.insufficient.join('、')}过短` : '',
          ].filter(Boolean).join('；')
          const problem = `分镜${issue.storyboardNumber} ${issue.range}：${details}`
          return {
            severity: 'warning' as const,
            category: 'directing' as const,
            shotNumbers: [issue.storyboardNumber],
            scriptEvidence: '以锁定剧本中的动作、人物关系和情绪触发为准',
            problem,
            repairInstruction: `补充本段独有的动作起点、移动路径、接触或停点、可见表演变化和结束状态；不得重复其他时间段内容。`,
          }
        })
        finalReviewWarnings = dedupeStoryboardFinalReviewIssues([
          ...finalReviewWarnings,
          ...detailWarnings,
        ])
      }
      const structuredContinuityIssues = items.flatMap((item, index) => (
        index === 0
          ? []
          : storyboardContinuityStateIssues(
              items[index - 1].continuityOut,
              item.continuityIn,
              item.continuityOut,
            )
              .map((issue) => `分镜${index + 1}：${issue}`)
      ))
      if (structuredContinuityIssues.length > 0) {
        finalReviewWarnings = dedupeStoryboardFinalReviewIssues([
          ...finalReviewWarnings,
          ...nonBlockingStoryboardReviewWarnings(structuredContinuityIssues.map((problem) => ({
            severity: 'fatal' as const,
            category: 'continuity' as const,
            shotNumbers: [],
            scriptEvidence: '以锁定剧本和相邻镜头状态为准',
            problem,
            repairInstruction: problem,
          }))),
        ])
      }
      const createdIds = await prisma.$transaction(async (tx) => {
        const previousStoryboards = await tx.storyboard.findMany({
          where: { projectId: task.projectId, episodeId: episode.id, generatedByAI: true },
          include: {
            videos: true,
          },
          orderBy: { episodeSceneNumber: 'asc' },
        })
        const previousIndexById = new Map(previousStoryboards.map((storyboard, index) => [storyboard.id, index]))
        for (const previous of previousStoryboards) {
          await createStoryboardRevision(tx, previous, {
            source: 'before_ai_regeneration',
            reason: `第 ${episode.episodeNumber} 集 AI 分镜重新生成前留存`,
            sourceTaskId: task.id,
            createdById: task.createdById,
            validationReport: { finalDialogueIssues: [], preservedBeforeReplacement: true },
          })
        }
        for (let index = 0; index < previousStoryboards.length; index++) {
          await tx.storyboard.update({
            where: { id: previousStoryboards[index].id },
            data: {
              sceneNumber: -1_000_000_000 + episode.episodeNumber * 1_000 + index,
              selectedVideoId: null,
            },
          })
        }

        const ids: string[] = []
        for (let index = 0; index < items.length; index++) {
          const item = items[index]
          const created = await tx.storyboard.create({
            data: {
              projectId: task.projectId,
              episodeId: episode.id,
              episodeSceneNumber: index + 1,
              generatedByAI: true,
              title: item.title,
              sceneNumber: 1_000_000 + episode.episodeNumber * 100 + index + 1,
              notes: item.notes || null,
              imagePrompt: item.imagePrompt || null,
              directorPrompt: item.directorPrompt,
              videoPrompt: item.videoPrompt,
              duration: item.duration,
              aspectRatio: item.aspectRatio,
              generateAudio: item.generateAudio,
              continuityIn: item.continuityIn,
              continuityOut: item.continuityOut,
            },
          })
          ids.push(created.id)
          await createStoryboardRevision(tx, created, {
            source: 'ai_generated_baseline',
            reason: `第 ${episode.episodeNumber} 集 AI 分镜通过最终提示词校验`,
            sourceTaskId: task.id,
            createdById: task.createdById,
            validationReport: {
              finalDialogueIssues: [],
              autoRepairedExactDuplicateDocumentIds: finalDialogueRepair.changedDocumentIds,
            },
          })
        }

        for (let previousIndex = 0; previousIndex < previousStoryboards.length; previousIndex++) {
          const previous = previousStoryboards[previousIndex]
          const replacementId = ids[Math.min(previousIndex, ids.length - 1)]
          if (!replacementId) continue
          for (const video of previous.videos) {
            const mappedSourceIds = [...new Set(video.sourceStoryboardIds.flatMap((sourceId) => {
              const sourceIndex = previousIndexById.get(sourceId)
              const replacementSourceId = sourceIndex === undefined
                ? replacementId
                : ids[Math.min(sourceIndex, ids.length - 1)]
              return replacementSourceId ? [replacementSourceId] : []
            }))]
            await tx.storyboardVideo.update({
              where: { id: video.id },
              data: {
                storyboardId: replacementId,
                sourceStoryboardIds: mappedSourceIds.length > 0 ? mappedSourceIds : [replacementId],
              },
            })
          }
          if (previous.selectedVideoId && previous.videos.some((video) => video.id === previous.selectedVideoId)) {
            const replacement = await tx.storyboard.findUnique({
              where: { id: replacementId },
              select: { selectedVideoId: true },
            })
            if (!replacement?.selectedVideoId) {
              await tx.storyboard.update({
                where: { id: replacementId },
                data: { selectedVideoId: previous.selectedVideoId },
              })
            }
          }
        }

        if (previousStoryboards.length > 0) {
          await tx.storyboard.deleteMany({
            where: { id: { in: previousStoryboards.map((storyboard) => storyboard.id) } },
          })
        }
        return ids
      }, { timeout: 30_000 })
      for (const batch of batchesOf(createdIds, env.textAssetConcurrency())) {
        await Promise.all(batch.map((storyboardId) => syncStoryboardAssetLinks(storyboardId)))
      }
      completedEpisodeIds.add(episode.id)
      checkpoint.segments = checkpoint.segments.filter((segment) => segment.episodeId !== episode.id)
      checkpoint.episodeReviews = checkpoint.episodeReviews.filter((review) => review.episodeId !== episode.id)
      activeEpisodeNumbers.delete(episode.episodeNumber)
      activeRoutes.delete(episode.episodeNumber)
      await persistStoryboardState('generating', finalReviewWarnings.length > 0
        ? { warning: `第 ${episode.episodeNumber} 集已返工并保存；仍有 ${finalReviewWarnings.length} 项待人工确认，可继续下一步` }
        : undefined)
      return {
        episodeId: episode.id,
        episodeNumber: episode.episodeNumber,
        relatedAssetCount: relatedAssets.length,
        storyboardIds: createdIds,
        reviewWarnings: finalReviewWarnings,
        modifiedShots,
      }
    } catch (error) {
      throw error
    }
  }

  let relatedAssetCount = 0
  let totalModifiedShots = 0
  const reviewWarnings: Array<{
    episodeNumber: number
    issues: StoryboardFinalReviewIssue[]
  }> = []
  const finalFailures: Array<{ episode: (typeof episodes)[number]; error: unknown }> = []

  async function generateEpisodeAcrossKeyPool(episode: (typeof episodes)[number]) {
    const initialKeyIndex = episodeKeyIndexes.get(episode.id) || 0
    const routes = storyboardTextRoutePlan({
      primaryKeyCount,
      fallbackKeyCount: textFallbackConfigured() ? fallbackKeyCount : 0,
      tertiaryKeyCount: textTertiaryConfigured() ? tertiaryKeyCount : 0,
      preferredPrimaryIndex: initialKeyIndex,
      preferredFallbackIndex: initialKeyIndex,
      preferredTertiaryIndex: initialKeyIndex,
    })
    if (routes.length === 0) throw new Error('TEXT_PROVIDERS_FAILED: 没有可用的文字模型线路')
    let lastError: unknown
    let previousFailureReason: string | undefined
    for (let pass = 0; pass < routes.length; pass++) {
      const route = routes[pass]
      const identity = storyboardRouteIdentity(route.provider)
      activeRoutes.set(episode.episodeNumber, {
        episodeNumber: episode.episodeNumber,
        ...identity,
        attempt: pass + 1,
        total: routes.length,
        ...(previousFailureReason ? { reason: previousFailureReason } : {}),
      })
      try {
        return await generateEpisodeStoryboards(
          episode,
          pass > 0,
          route,
          pass === routes.length - 1,
        )
      } catch (error) {
        lastError = error
        previousFailureReason = storyboardRouteFailureReason(error)
        activeRoutes.set(episode.episodeNumber, {
          episodeNumber: episode.episodeNumber,
          ...identity,
          attempt: pass + 1,
          total: routes.length,
          reason: previousFailureReason,
        })
        await persistStoryboardState('retrying')
        const message = error instanceof Error ? error.message : String(error)
        if (/STORYBOARD_EPISODE_SCENE_DENSITY/i.test(message)) throw error
      }
    }
    throw lastError
  }

  for (const batch of batchesOf(pendingEpisodes, parallelism)) {
    const results = await Promise.all(batch.map(async (episode) => {
      try {
        const result = await generateEpisodeAcrossKeyPool(episode)
        return { episode, result }
      } catch (error) {
        return { episode, error }
      }
    }))
    for (const result of results) {
      if ('error' in result) {
        finalFailures.push({ episode: result.episode, error: result.error })
      } else {
        relatedAssetCount += result.result.relatedAssetCount
        totalModifiedShots += result.result.modifiedShots
        if (result.result.reviewWarnings.length > 0) {
          reviewWarnings.push({
            episodeNumber: result.result.episodeNumber,
            issues: result.result.reviewWarnings,
          })
        }
      }
    }
  }
  if (finalFailures.length > 0) {
    const firstError = finalFailures[0].error instanceof Error
      ? finalFailures[0].error.message
      : String(finalFailures[0].error)
    throw new Error(
      `已保存 ${completedEpisodeIds.size}/${episodes.length} 集分镜；第 ${finalFailures.map((item) => item.episode.episodeNumber).join('、')} 集仍需续跑。${firstError}`,
    )
  }

  await persistStoryboardState('finalizing')
  const storyboardIds = await renumberGeneratedStoryboards(task.projectId)
  const warningCount = reviewWarnings.reduce((total, item) => total + item.issues.length, 0)
  const fatalIssueCount = reviewWarnings.reduce((total, item) => (
    total + item.issues.filter((issue) => issue.severity === 'fatal').length
  ), 0)
  const warningSuggestions = [...new Set(reviewWarnings.flatMap((item) => (
    item.issues.map((issue) => {
      const shotLabel = issue.shotNumbers.length > 0
        ? `分镜 ${issue.shotNumbers.slice(0, 4).join('、')}`
        : '整集'
      return `第 ${item.episodeNumber} 集 ${shotLabel}：${issue.repairInstruction || issue.problem}`
    })
  )))].slice(0, 6)
  return {
    storyboardCount: storyboardIds.length,
    episodeCount: episodes.length,
    storyboardIds,
    parallelism,
    relatedAssetCount,
    modifiedShots: totalModifiedShots,
    reviewWarnings,
    storyboardProgress: {
      phase: 'finalizing',
      completedEpisodes: episodes.length,
      totalEpisodes: episodes.length,
      completedSegments: totalSegments,
      totalSegments,
      activeEpisodeNumbers: [],
      activeRoutes: [],
      parallelism,
      segmentParallelism,
      modifiedShots: totalModifiedShots,
      remainingIssues: warningCount,
      fatalIssues: fatalIssueCount,
      ...(warningCount > 0
        ? {
            warning: fatalIssueCount > 0
              ? `分镜已保存最新返工稿；仍有 ${fatalIssueCount} 项剧情或执行问题未完成自动修复，另有 ${warningCount - fatalIssueCount} 项导演建议，可继续手动调整`
              : `分镜已自动返工并保存最佳版本；仍有 ${warningCount} 项导演建议，可继续下一步`,
            suggestions: warningSuggestions,
          }
        : {}),
    },
    pipelineVersion: 'cine-lock-emotional-storyboards-v12-scene-heading-repair',
  }
}

export async function processTextGenerationTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.generationTask.findUnique({ where: { id: taskId } })
  if (!task) throw new Error(`Text task not found: ${taskId}`)
  if (task.status === TaskStatus.completed) return payloadRecord(task.payload)

  await prisma.generationTask.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.processing,
      progress: 2,
      startedAt: new Date(),
      completedAt: null,
      error: null,
    },
  })

  try {
    let result: Record<string, unknown>
    if (task.type === GenerationTaskType.script_adaptation) {
      result = await processScriptAdaptation(task)
    } else if (task.type === GenerationTaskType.script_revision) {
      result = await processScriptRevision(task)
    } else if (task.type === GenerationTaskType.asset_extraction) {
      result = await processAssetExtraction(task)
    } else if (task.type === GenerationTaskType.storyboard_generation) {
      result = await processStoryboardGeneration(task)
    } else {
      throw new Error(`Unsupported text task type: ${task.type}`)
    }

    await prisma.generationTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.completed,
        progress: 100,
        completedAt: new Date(),
        payload: result as Prisma.InputJsonObject,
      },
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.generationTask.update({
      where: { id: task.id },
      data: {
        status: options.willRetryOnFailure ? TaskStatus.queued : TaskStatus.failed,
        completedAt: options.willRetryOnFailure ? null : new Date(),
        error: options.willRetryOnFailure ? null : message,
      },
    })
    throw error
  }
}

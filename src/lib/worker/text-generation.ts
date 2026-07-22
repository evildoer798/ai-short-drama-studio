import {
  AssetType,
  GenerationTaskType,
  Prisma,
  TaskStatus,
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
  buildStoryboardGenerationPrompt,
  dialogueMissing,
  canonicalizeScriptCharacterNames,
  enforceAssetPrompt,
  extractRequiredStoryboardDialogueLines,
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
  scriptAuditPassed,
  scriptCharacterCount,
  textReuseMetrics,
} from '@/lib/script-quality'
import {
  calculateSceneConsistency,
  storyboardLocationNames,
  storyboardPromptSection,
  storyboardTimeLocation,
} from '@/lib/scene-consistency'
import { matchStoryboardAssets, syncStoryboardAssetLinks } from '@/lib/storyboards'
import {
  orderedTextApiKeyIndexes,
  textStoryboardParallelism,
} from '@/lib/text-api-pool'
import { textProviderLabel, type TextProviderLabel } from '@/lib/text-provider-label'
import { buildStyleLock } from '@/lib/visual-styles'

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
})

const assetInventoryItemSchema = z.object({
  type: z.nativeEnum(AssetType),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(12000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
})

const assetInventorySchema = z.object({
  assets: z.array(assetInventoryItemSchema).default([]),
})

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

const compactStoryboardRequired = (max: number) => z.string().trim().min(1)
  .transform((value) => value.slice(0, max))
const compactStoryboardDetail = (max: number) => z.string().trim().optional().default('')
  .transform((value) => value.slice(0, max))

const compactStoryboardShotSchema = z.object({
  t: compactStoryboardRequired(120),
  n: compactStoryboardRequired(1200),
  p: compactStoryboardDetail(2500),
  h: compactStoryboardDetail(3000),
  r: compactStoryboardDetail(2200),
  e: compactStoryboardDetail(2800),
  l: compactStoryboardDetail(1800),
  c: compactStoryboardRequired(1600),
  f: compactStoryboardDetail(2800),
  s: compactStoryboardDetail(4500),
  m: compactStoryboardDetail(3600),
  v: compactStoryboardRequired(5000),
  a: compactStoryboardRequired(5000),
  q: compactStoryboardDetail(2400),
  o: compactStoryboardDetail(2400),
  g: compactStoryboardDetail(2800),
  x: compactStoryboardDetail(2200),
  z: compactStoryboardDetail(3200),
  d: z.coerce.number().int().min(4).max(15).catch(8),
})

const compactStoryboardSchema = z.object({
  shots: z.array(compactStoryboardShotSchema).min(1).max(40),
})

function compactStoryboardSchemaForTarget(targetShotCount: number) {
  const minimum = Math.max(1, Math.min(40, Math.round(targetShotCount)))
  return z.object({
    shots: z.array(compactStoryboardShotSchema).min(minimum).max(Math.min(40, minimum + 1)),
  })
}

const compactStoryboardAllowEmptySchema = z.object({
  shots: z.array(compactStoryboardShotSchema).max(40).default([]),
})

const storyboardCheckpointSchema = z.object({
  version: z.literal(5),
  sourceFingerprint: z.string().min(1),
  completedEpisodeIds: z.array(z.string().min(1)).default([]),
  segments: z.array(z.object({
    episodeId: z.string().min(1),
    segmentIndex: z.number().int().nonnegative(),
    shots: z.array(compactStoryboardShotSchema).min(1).max(40),
  })).default([]),
})

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
  return configuredTextMode(provider) === 'chat_completions'
    ? ['chat_completions', 'responses']
    : ['responses', 'chat_completions']
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
) {
  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      payload: {
        ...payload,
        adaptationCheckpoint: checkpoint,
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
  const episodeMinutes = Math.max(0.5, Math.min(10, Number(payload.episodeMinutes) || 1.5))
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
    if (missing.length > 0) {
      parsed.content += `\n\n【原著对白核对区｜需导演安放】\n${missing.map((item) => `- ${item.text}`).join('\n')}`
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

  let qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
  for (let pass = 0; pass < 2 && !scriptAuditPassed(qualityAudit); pass++) {
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
      await saveAdaptationCheckpoint(task.id, payload, checkpoint)
      qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
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

    for (const [episodeNumber, issueSet] of [...issueMap.entries()].sort((left, right) => left[0] - right[0])) {
      const draftIndex = drafts.findIndex((draft) => draft.episodeNumber === episodeNumber)
      if (draftIndex < 0) continue
      drafts[draftIndex] = await repairEpisodeDraft(drafts[draftIndex], draftIndex, [...issueSet])
      checkpoint.drafts = drafts
      await saveAdaptationCheckpoint(task.id, payload, checkpoint)
      await updateProgress(task.id, 87 + ((draftIndex + 1) / drafts.length) * 6)
    }
    qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
  }
  if (!scriptAuditPassed(qualityAudit)) {
    const duplicateSummary = qualityAudit.duplicatePairs
      .slice(0, 6)
      .map((item) => `${item.leftEpisode}-${item.rightEpisode}`)
      .join('、')
    throw new Error(
      `SCRIPT_QUALITY_AUDIT_FAILED: 全剧终检未通过；重复集对 ${duplicateSummary || '无'}，`
      + `缺少 Hook ${qualityAudit.missingHooks.map((item) => item.episodeNumber).join('、') || '无'}，`
      + `时长异常 ${qualityAudit.lengthIssues.map((item) => item.episodeNumber).join('、') || '无'}。任务会保留检查点供自动续跑。`,
    )
  }
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
  await saveAdaptationCheckpoint(task.id, payload, checkpoint)
  await updateProgress(task.id, 96)

  qualityAudit = auditScriptEpisodes(drafts, episodeMinutes)
  if (!scriptAuditPassed(qualityAudit)) {
    throw new Error('SCRIPT_QUALITY_AUDIT_FAILED_AFTER_NAME_NORMALIZATION: 姓名统一后的全剧终检未通过，未覆盖现有剧本')
  }

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
    },
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
        schema: assetInventorySchema,
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
          schema: assetInventorySchema,
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
        maxOutputTokens: 2800,
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
            maxOutputTokens: 2800,
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
type CompactShotCore = Pick<CompactShot, 't' | 'n' | 'c' | 'v' | 'a' | 'd'>
type CompactShotInput = CompactShotCore & Partial<Omit<CompactShot, keyof CompactShotCore>>

export function normalizeCompactShot(shot: CompactShotInput): CompactShot {
  return compactStoryboardShotSchema.parse(shot)
}

export function splitStoryboardScript(content: string, maxChars = 320) {
  const lines = content.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  const units = lines.flatMap((line) => {
    if (line.length <= maxChars) return [line]
    return line.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) || [line]
  })
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > maxChars) {
      chunks.push(current)
      current = ''
    }
    if (unit.length > maxChars) {
      for (let start = 0; start < unit.length; start += maxChars) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        chunks.push(unit.slice(start, start + maxChars))
      }
    } else {
      current += `${current ? '\n' : ''}${unit}`
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [content.trim()]
}

export function targetStoryboardShotCount(script: string, minimum = 1) {
  const dialogueTurns = extractRequiredStoryboardDialogueLines(script).length
  const visibleChars = script.replace(/\s+/g, '').length
  return Math.max(minimum, Math.min(30, Math.max(dialogueTurns, Math.ceil(visibleChars / 70))))
}

export function allocateStoryboardShotTargets(chunks: string[], targetShotCount: number) {
  if (chunks.length === 0) return []
  const targets = chunks.map((chunk) => targetStoryboardShotCount(chunk))
  const target = Math.max(chunks.length, Math.round(targetShotCount))
  let remaining = Math.max(0, target - targets.reduce((total, count) => total + count, 0))
  if (remaining === 0) return targets

  const weights = chunks.map((chunk) => (
    Math.max(1, chunk.replace(/\s+/g, '').length)
    + extractRequiredStoryboardDialogueLines(chunk).length * 70
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

const ESSENTIAL_VOICEOVER_FACT = /(?:[0-9零〇一二三四五六七八九十百千万两]+(?:年|个月|月|天|小时|分钟|公里|米|岁|次|美元|元|万|亿)|年前|年后|此前|后来|曾经|原来|其实|真相|身份|从未|已经|一直|死亡|去世|失踪|怀孕|确诊|欠债|贷款|破产|录取|退学|签证|账户|遗嘱|合同|约定|秘密|凶手)/u

function essentialStoryboardVoiceover(text: string) {
  return ESSENTIAL_VOICEOVER_FACT.test(text)
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
      const keep = Boolean(source && essentialStoryboardVoiceover(source.text))
      if (!keep) removed++
      return keep
    })
    if (removed === 0) return shot

    const actionDialogue = retained.join('；') || '无对白'
    const retainedDialogues = extractScriptDialogueLines(retained.join('\n'))
    const hasVoiceover = retainedDialogues.some(isStoryboardVoiceover)
    const hasOnscreenDialogue = retainedDialogues.some((dialogue) => !isStoryboardVoiceover(dialogue))
    const voiceRule = hasVoiceover
      ? `${shot.q}；只保留剧本中无法视觉化的最短关键信息，不增加其他旁白或内心独白。`
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

function compactShotSpeakers(shot: CompactShot) {
  return new Set(
    extractScriptDialogueLines(shot.a.replace(/[；;]/g, '\n')).map((dialogue) => dialogue.speaker),
  )
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
  for (const missing of input.missing) {
    const supplementalIndex = input.supplemental.findIndex(
      (shot) => !dialogueMissing(shot.a, missing.text),
    )
    if (supplementalIndex < 0) continue
    const sourceIndex = sourceDialogues.findIndex(
      (dialogue) => dialogue.speaker === missing.speaker && dialogue.text === missing.text,
    )
    let insertionIndex = result.length
    for (const later of sourceDialogues.slice(Math.max(0, sourceIndex + 1))) {
      const nextShotIndex = result.findIndex((shot) => !dialogueMissing(shot.a, later.text))
      if (nextShotIndex >= 0) {
        insertionIndex = nextShotIndex
        break
      }
    }
    result.splice(insertionIndex, 0, input.supplemental[supplementalIndex])
    input.supplemental.splice(supplementalIndex, 1)
  }
  return result
}

function mergeCompactShots(left: CompactShot, right: CompactShot): CompactShot {
  const joined = (first: string, second: string, separator: string, max: number) => (
    !first ? second.slice(0, max) : !second || first === second ? first : `${first}${separator}${second}`.slice(0, max)
  )
  return {
    t: joined(left.t, right.t, ' / ', 120),
    n: joined(left.n, right.n, '；', 1200),
    p: left.p || right.p,
    h: joined(left.h, right.h, '；', 3000),
    r: joined(left.r, right.r, '；', 2200),
    e: joined(left.e, right.e, '；', 2800),
    l: joined(left.l, right.l, '；', 1800),
    c: joined(left.c, right.c, '，随后', 1600),
    f: left.f || right.f,
    s: joined(left.s, right.s, '；随后按顺序执行：', 4500),
    m: joined(left.m, right.m, '；', 3600),
    v: joined(left.v, right.v, '；', 5000),
    a: joined(left.a, right.a, '；', 5000),
    q: joined(left.q, right.q, '；', 2400),
    o: joined(left.o, right.o, '；', 2400),
    g: right.g || left.g,
    x: right.x || left.x,
    z: joined(left.z, right.z, '；', 3200),
    d: Math.min(15, left.d + right.d),
  }
}

function storyboardField(value: string, fallback: string) {
  return value.trim() || fallback
}

export function stitchStoryboardContinuity(shots: CompactShotInput[], previousTail = '') {
  let inheritedTail = previousTail.trim()
  return shots.map((inputShot, index): CompactShot => {
    const shot = normalizeCompactShot(inputShot)
    const firstFrame = storyboardField(
      shot.f,
      inheritedTail
        ? `严格沿用上一镜尾帧中的人物站位、朝向、手部状态、视线、服装、道具、场景陈设、光线和焦点。`
        : `${shot.n}，以${shot.c}建立本镜开场，人物和场景状态与已锁定剧本一致。`,
    )
    const previousFrame = inheritedTail || storyboardField(
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

function storyboardTimeLabel(value: string) {
  const match = value.match(/^(?:现实|回忆|梦境)?[，,\s]*(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|黄昏|夜晚|深夜|白天)/u)
  return match?.[0].replace(/^[，,\s]+|[，,\s]+$/g, '') || '时间承接已锁定剧本'
}

function uniqueLocationSuffixMatch(context: string, locations: StoryboardLocationAsset[]) {
  const normalizedContext = normalizedStoryboardLocation(context)
  const locationKinds = ['起居室', '会客室', '办公室', '会议室', '卧室', '客厅', '厨房', '餐厅', '书房', '浴室', '卫生间', '走廊', '楼梯间', '地下室', '停车场', '公路', '山路', '街道', '小院', '庭院', '医院', '学校', '教室', '宿舍', '商场', '酒店', '车站', '机场']
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
    const context = [shot.n, shot.e, shot.f, shot.v, shot.g].join('\n')
    const exact = locations.find((location) => (
      normalizedStoryboardLocation(context).includes(normalizedStoryboardLocation(location.name))
    ))
    return exact
      || matchStoryboardAssets(matchableLocations, context, matchableLocations.length)[0]
      || uniqueLocationSuffixMatch(context, locations)
      || (locations.length === 1 ? locations[0] : undefined)
  })
  let inheritedLocation: StoryboardLocationAsset | undefined

  return normalizedShots.map((shot, index): CompactShot => {
    const matched = directMatches[index]
      || inheritedLocation
      || directMatches.slice(index + 1).find(Boolean)
      || locations[0]
    inheritedLocation = matched
    const anchor = `场景资产唯一锚点“${matched.name}”：${matched.description.slice(0, 800)}`
    const prohibition = `禁止将场景“${matched.name}”替换为其他地点，禁止改变固定空间结构、材质、陈设位置和基础光源。`
    return {
      ...shot,
      n: `${storyboardTimeLabel(shot.n)}｜${matched.name}`,
      e: shot.e.includes(anchor) ? shot.e : `${anchor}；${shot.e}`.slice(0, 2800),
      z: shot.z.includes(prohibition) ? shot.z : `${shot.z}${shot.z ? '；' : ''}${prohibition}`.slice(0, 3200),
    }
  })
}

export function compactStoryboardShots(shots: CompactShotInput[], target: number) {
  const compacted = shots.map(normalizeCompactShot)
  while (compacted.length > Math.max(1, target)) {
    const mergeIndex = compacted.findIndex((shot, index) => {
      const next = compacted[index + 1]
      if (!next) return false
      const speakers = new Set([...compactShotSpeakers(shot), ...compactShotSpeakers(next)])
      const sameLocation = storyboardLocationFromNote(shot.n) === storyboardLocationFromNote(next.n)
      return speakers.size <= 1 && sameLocation
    })
    if (mergeIndex < 0) break
    compacted.splice(mergeIndex, 2, mergeCompactShots(compacted[mergeIndex], compacted[mergeIndex + 1]))
  }
  return compacted
}

export function fitStoryboardDuration(shots: CompactShotInput[], targetSeconds = 90) {
  if (shots.length === 0) return shots
  const normalized = shots.map(normalizeCompactShot)
  const minimum = normalized.length * 4
  const maximum = normalized.length * 15
  const total = Math.max(minimum, Math.min(maximum, Math.round(targetSeconds)))
  const durations = Array.from({ length: normalized.length }, () => 4)
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
const STORYBOARD_EPISODE_MAX_SECONDS = 120

function formatTimelineSecond(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function packCompactShotGroup(shots: CompactShot[], clipSeconds: number): CompactShot {
  if (shots.length === 1) return { ...shots[0], d: clipSeconds }
  const totalWeight = shots.reduce((total, shot) => total + Math.max(1, shot.d), 0)
  let elapsedWeight = 0
  const timed = shots.map((shot, index) => {
    const start = clipSeconds * elapsedWeight / totalWeight
    elapsedWeight += Math.max(1, shot.d)
    const end = index === shots.length - 1
      ? clipSeconds
      : clipSeconds * elapsedWeight / totalWeight
    return {
      shot,
      label: `${formatTimelineSecond(start)}-${formatTimelineSecond(end)}秒 子镜头${index + 1}`,
    }
  })
  const field = (key: keyof Pick<CompactShot, 'n' | 'h' | 'r' | 'e' | 'l' | 'c' | 's' | 'm' | 'v' | 'a' | 'q' | 'o' | 'z'>) => timed
    .filter((item) => item.shot[key].trim())
    .map((item) => `${item.label}：${item.shot[key]}`)
    .join('\n')
  const timedField = (
    key: keyof Pick<CompactShot, 'h' | 'r' | 'e' | 'l' | 's' | 'm' | 'q' | 'o' | 'z'>,
    introduction: string,
  ) => {
    const value = field(key)
    return value ? `${introduction}\n${value}` : ''
  }
  return {
    t: `${shots[0].t} 至 ${shots[shots.length - 1].t}`.slice(0, 120),
    n: `本集内连续 ${clipSeconds} 秒视频，禁止跨集\n${field('n')}`,
    p: shots[0].p,
    h: timedField('h', '按时间段锁定出场人物，未写明的角色不得入镜：'),
    r: timedField('r', '按时间段锁定道具归属和持握位置，不得跨角色转移：'),
    e: timedField('e', '按时间段锁定场景；同一地点的固定陈设不得重置：'),
    l: timedField('l', '按时间段锁定光源方向、色温和明暗变化：'),
    c: `按以下时间顺序切换机位，不得并行呈现：\n${field('c')}`,
    f: shots[0].f,
    s: timedField('s', '严格按以下时间顺序执行动作，前一动作完成后才能开始后一动作：'),
    m: timedField('m', '按时间段锁定重心、主动肢体、运动路径、接触点、遮挡与结束姿态：'),
    v: `按以下时间顺序连续表演，保持角色与场景一致：\n${field('v')}`,
    a: `按以下时间顺序执行动作对白，只有当前时间段角色开口：\n${field('a')}`,
    q: timedField('q', '按以下时间顺序执行配音，不得串词或交换声线：'),
    o: timedField('o', '按以下时间顺序保留环境声和必要音效：'),
    g: shots[shots.length - 1].g,
    x: shots[shots.length - 1].x,
    z: timedField('z', '整段视频共同禁止：'),
    d: clipSeconds,
  }
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
  return value.split('\n')[0].split('｜')[1]?.trim() || normalizedStoryboardLocation(value)
}

function storyboardGroupMergeCost(left: CompactShot[], right: CompactShot[]) {
  const leftRisk = Math.max(...left.map(storyboardMotionRisk))
  const rightRisk = Math.max(...right.map(storyboardMotionRisk))
  const locationChanged = storyboardLocationFromNote(left[left.length - 1].n) !== storyboardLocationFromNote(right[0].n)
  if (locationChanged) return Number.POSITIVE_INFINITY
  return (left.length + right.length) * 10
    + (leftRisk >= 4 ? 500 + leftRisk * 20 : 0)
    + (rightRisk >= 4 ? 500 + rightRisk * 20 : 0)
    + (locationChanged ? 800 : 0)
}

export function packStoryboardVideoClips(
  shots: CompactShotInput[],
  clipSeconds = STORYBOARD_VIDEO_CLIP_SECONDS,
  episodeMaxSeconds = STORYBOARD_EPISODE_MAX_SECONDS,
) {
  if (shots.length === 0) return []
  const normalized = stitchStoryboardContinuity(shots)
  const safeClipSeconds = Math.max(4, Math.min(15, Math.round(clipSeconds)))
  const maxClipCount = Math.max(1, Math.floor(episodeMaxSeconds / safeClipSeconds))
  const groups = motionAwareShotGroups(normalized)
  while (groups.length > maxClipCount) {
    let mergeIndex = 0
    let lowestCost = Number.POSITIVE_INFINITY
    for (let index = 0; index < groups.length - 1; index++) {
      const cost = storyboardGroupMergeCost(groups[index], groups[index + 1])
      if (cost < lowestCost) {
        lowestCost = cost
        mergeIndex = index
      }
    }
    if (!Number.isFinite(lowestCost)) {
      break
    }
    groups.splice(mergeIndex, 2, [...groups[mergeIndex], ...groups[mergeIndex + 1]])
  }
  const minimumClipSeconds = 4
  if (groups.length * minimumClipSeconds > episodeMaxSeconds) {
    throw new Error(
      `STORYBOARD_EPISODE_SCENE_DENSITY: 当前集有 ${groups.length} 个不能合并的独立场景，按最短 ${minimumClipSeconds} 秒仍超过 ${episodeMaxSeconds} 秒`,
    )
  }
  const availableSeconds = Math.min(episodeMaxSeconds, groups.length * safeClipSeconds)
  const baseDuration = Math.floor(availableSeconds / groups.length)
  let remainder = availableSeconds - baseDuration * groups.length
  const durations = groups.map(() => {
    const duration = baseDuration + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    return Math.max(minimumClipSeconds, Math.min(safeClipSeconds, duration))
  })
  return stitchStoryboardContinuity(
    groups.map((group, index) => packCompactShotGroup(group, durations[index])),
  )
}

export function materializeStoryboards(input: {
  shots: CompactShotInput[]
  visualStyle: typeof import('@prisma/client').VisualStyle[keyof typeof import('@prisma/client').VisualStyle]
  customStylePrompt?: string | null
}) {
  const styleLock = buildStyleLock(input.visualStyle, input.customStylePrompt, 'video')
  const shots = stitchStoryboardContinuity(input.shots)
  return shots.map((shot, index): GeneratedStoryboard => {
    const next = shots[index + 1]
    const transition = storyboardField(
      shot.x,
      next
        ? `本镜动作完成后保持尾帧状态，摄影机和人物只按下一镜明确要求变化。`
        : `本镜在尾帧状态自然停留，作为本集当前段落收束。`,
    )
    const transitionWithContinuity = next
      ? `${transition} 下一镜必须逐项承接本镜尾帧，并以“${next.f}”作为开场构图；禁止重置站位、服装、道具、陈设或光线。`
      : transition
    const characterLock = storyboardField(
      shot.h,
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
    const actionSequence = storyboardField(
      shot.s,
      `先保持首帧状态；随后严格按剧本完成${shot.a}；最后停在尾帧状态。所有动作依次发生，不并行、不倒序。`,
    )
    const motionPhysics = storyboardField(
      shot.m,
      `人物先保持稳定起始姿态，再转移重心；每次只有一侧主动肢体沿连续可见路径运动，到达明确接触点或停点后完成缓冲并稳定。双脚着地时不滑移，关节活动符合人体结构；人物之间不发生剧本外身体接触，身体、衣物、头发、家具和道具互不穿透。`,
    )
    const voice = storyboardField(
      shot.q,
      /无对白|全程不说话/u.test(shot.a)
        ? `本镜无角色对白，不生成口型；如有【OS】或画外音，只生成画外声音。`
        : `严格按人物年龄、性别和剧本身份使用固定声线；逐字说出本镜对白，口型同步，不串词。`,
    )
    const sound = storyboardField(
      shot.o,
      `保留与空间和动作一致的自然环境声与必要音效。无背景音乐，无字幕。`,
    )
    const baseProhibitions = storyboardField(
      shot.z,
      `禁止人物面容、年龄、发型和服装变化；禁止角色交换位置；禁止道具换手、转移、复制、漂浮或消失；禁止新增人物和无关物品；禁止镜头突然换角度；禁止字幕、背景音乐、水印和 UI。`,
    )
    const temporalProhibition = /回忆|梦境/u.test(shot.n)
      ? `禁止现实人物、现实陈设与回忆或梦境中的人物、环境同时存在；转场完成后才进入当前时空，禁止人物复制、闪白和从瞳孔内部穿越。`
      : ''
    const explicitNegativeTerms = `负面缺陷词：肢体融合、关节反折、多余手指、多余手臂、多余腿、身体穿透、衣物穿模、头发穿模、脚底滑移、人物瞬移、人物复制、面容漂移、比例突变、道具漂浮、道具变形、道具换手、背景跳变、镜头抖动失控。`
    const prohibitions = `${temporalProhibition
      ? `${baseProhibitions}；${temporalProhibition}`
      : baseProhibitions}；${explicitNegativeTerms}`

    return {
      title: shot.t,
      notes: `${shot.n}\n接续上一镜尾帧：${shot.p}`,
      imagePrompt: [
        styleLock,
        `时间地点：${shot.n}`,
        `人物锁定：${characterLock}`,
        `道具锁定：${propLock}`,
        `环境锁定：${environmentLock}`,
        `照明锁定：${lightingLock}`,
        `首帧画面：${shot.f}`,
        `电影级首帧构图，人物和资产形象与资产库主图一致，无文字、无水印、无 UI。`,
      ].join('\n'),
      videoPrompt: [
        `【分镜 ${index + 1}｜${shot.d}秒｜16:9】`,
        `镜头时长：${shot.d}秒`,
        '画幅比例：16:9',
        `时间地点：${shot.n}`,
        `接续上一镜尾帧：${shot.p}`,
        `人物锁定：${characterLock}`,
        `道具锁定：${propLock}`,
        `场景连续性：${environmentLock}；${lightingLock}`,
        `景别运镜：${shot.c}`,
        `首帧：${shot.f}`,
        `对白声音：${voice}；${sound}`,
        `尾帧衔接：${shot.g}；${transitionWithContinuity}`,
        `禁止项：${prohibitions}`,
        '',
        '主要动作与画面：',
        `动作对白：${shot.a}`,
        `动作顺序：${actionSequence}`,
        `动作物理：${motionPhysics}`,
        `画面描述：${shot.v}`,
      ].join('\n'),
      duration: shot.d,
      aspectRatio: '16:9',
      generateAudio: true,
    }
  })
}

async function saveStoryboardCheckpoint(
  taskId: string,
  payload: TaskPayload,
  checkpoint: z.output<typeof storyboardCheckpointSchema>,
  progress: number,
  detail: {
    phase: 'preparing' | 'generating' | 'retrying' | 'saving' | 'finalizing'
    completedEpisodes: number
    totalEpisodes: number
    completedSegments: number
    totalSegments: number
    activeEpisodeNumbers: number[]
    parallelism: number
    segmentParallelism: number
    currentSegment?: number
    currentSegmentTotal?: number
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
    pipelineVersion: 'storyboard-first-atomic-shots-v10',
    visualStyle: project.visualStyle,
    customStylePrompt: project.customStylePrompt,
    episodes: episodes.map((episode) => ({ id: episode.id, updatedAt: episode.updatedAt.toISOString() })),
    assets: assets.map((asset) => ({ id: asset.id, updatedAt: asset.updatedAt.toISOString() })),
  })).digest('hex')
  const parsedCheckpoint = storyboardCheckpointSchema.safeParse(payload.storyboardCheckpoint)
  const checkpoint = parsedCheckpoint.success && parsedCheckpoint.data.sourceFingerprint === sourceFingerprint
    ? parsedCheckpoint.data
    : { version: 5 as const, sourceFingerprint, completedEpisodeIds: [], segments: [] }
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
    phase: 'preparing' | 'generating' | 'retrying' | 'saving' | 'finalizing',
    current?: { segment: number; segmentTotal: number },
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
      ...(current ? { currentSegment: current.segment, currentSegmentTotal: current.segmentTotal } : {}),
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
    const episodeLocations = matchedAssetLocations.length > 0
      ? matchedAssetLocations
      : scriptedLocationAssets
    const relatedAssetMap = new Map(
      [
        ...initiallyRelatedAssets,
        ...(matchedAssetLocations.length > 0 ? episodeLocations : []),
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
      ...(matchedAssetLocations.length === 0
        ? scriptLocations.map((location) => ({ type: AssetType.location, name: location.name }))
        : []),
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
      const allowedLocations = segmentLocationMatches.length > 0
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
        schema: compactStoryboardSchemaForTarget(targetShotCount),
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
      const dialogues = extractRequiredStoryboardDialogueLines(script)
      let joined = parsed.shots.map((item) => item.a).join('\n')
      let missing = dialogues.filter((dialogue) => dialogueMissing(joined, dialogue.text))
      if (allowRepair && missing.length > 0) {
        let supplementalShots: CompactShot[] = []
        try {
          const supplemental = await callStructuredText({
            system: '你是分镜对白补录导演。只生成遗漏对白对应的补充镜头，并逐字复制指定对白；禁止返回空数组。',
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

        const supplementalText = () => supplementalShots.map((item) => item.a).join('\n')
        const unresolved = missing.filter((dialogue) => dialogueMissing(supplementalText(), dialogue.text))
        for (const dialogue of unresolved) {
          const single = await callStructuredText({
            system: '你是分镜对白补录导演。必须为唯一指定对白输出一个镜头，逐字复制对白，shots 禁止为空。',
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
        joined = parsed.shots.map((item) => item.a).join('\n')
        missing = dialogues.filter((dialogue) => dialogueMissing(joined, dialogue.text))
      }
      if (missing.length > 0) {
        throw new Error(`第 ${episode.episodeNumber} 集当前段仍遗漏 ${missing.length} 句对白`)
      }
      return stitchStoryboardContinuity(
        enforceStoryboardLocationAssets(
          compactStoryboardShots(parsed.shots, targetShotCount),
          allowedLocations,
        ),
        segment?.previousShotTail,
      )
    }

    try {
      const chunks = chunksByEpisode.get(episode.id) || [episode.content]
      const episodeTargetShotCount = targetStoryboardShotCount(episode.content, 20)
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
      const atomicShots = compactStoryboardShots(
        stitchStoryboardContinuity(voiceoverReducedShots),
        episodeTargetShotCount,
      )
      const durationFittedShots = fitStoryboardDuration(atomicShots, 90)

      await persistStoryboardState('saving')
      const items = materializeStoryboards({
        shots: durationFittedShots,
        visualStyle: projectStyle.visualStyle,
        customStylePrompt: projectStyle.customStylePrompt,
      })
      const createdIds = await prisma.$transaction(async (tx) => {
        await tx.storyboard.deleteMany({
          where: { projectId: task.projectId, episodeId: episode.id, generatedByAI: true },
        })
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
              videoPrompt: item.videoPrompt,
              duration: item.duration,
              aspectRatio: item.aspectRatio,
              generateAudio: item.generateAudio,
            },
          })
          ids.push(created.id)
        }
        return ids
      }, { timeout: 30_000 })
      for (const batch of batchesOf(createdIds, env.textAssetConcurrency())) {
        await Promise.all(batch.map((storyboardId) => syncStoryboardAssetLinks(storyboardId)))
      }
      completedEpisodeIds.add(episode.id)
      checkpoint.segments = checkpoint.segments.filter((segment) => segment.episodeId !== episode.id)
      activeEpisodeNumbers.delete(episode.episodeNumber)
      activeRoutes.delete(episode.episodeNumber)
      await persistStoryboardState('generating')
      return {
        episodeId: episode.id,
        relatedAssetCount: relatedAssets.length,
        storyboardIds: createdIds,
      }
    } catch (error) {
      throw error
    }
  }

  let relatedAssetCount = 0
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
        return await generateEpisodeStoryboards(episode, pass > 0, route)
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
  return {
    storyboardCount: storyboardIds.length,
    episodeCount: episodes.length,
    storyboardIds,
    parallelism,
    relatedAssetCount,
    pipelineVersion: 'atomic-storyboards-90s-v6',
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

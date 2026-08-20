import { AssetType, VisualStyle } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './db'
import { assetImageUrl, mediaDownloadUrl } from './assets'
import { buildStoryboardVideoDisplayName } from './storyboard-video-names'
import { storyboardLocationNames } from './scene-consistency'
import {
  compactLegacyStoryboardSceneSection,
  conciseStoryboardSceneFacts,
} from './storyboard-scene'
import { continuityReferenceInstruction } from './storyboard-continuity'
import type { ContinuityReferenceMode } from './storyboard-continuity'
import {
  naturalizeStoryboardTimeline,
  parseStoryboardTimelineSegments,
  parseStoryboardTimelineDetailFields,
  STORYBOARD_TIMELINE_DETAIL_LABELS,
} from './storyboard-timeline'
import { buildStyleLock, getVisualStylePreset } from './visual-styles'
import {
  characterAppearsInStoryboardFrame,
  visibleStoryboardTimelineCharacters as resolveVisibleStoryboardTimelineCharacters,
} from './storyboard-cast'

export const storyboardAspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'])
export const storyboardVideoResolutionSchema = z.enum(['480p', '720p', '1080p', '2k', '4k'])

function normalizeStoryboardAspectRatio(value: string) {
  const parsed = storyboardAspectRatioSchema.safeParse(value)
  return parsed.success ? parsed.data : '16:9'
}

export const createStoryboardSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(8000).optional().nullable(),
  imagePrompt: z.string().trim().max(12000).optional().nullable(),
  directorPrompt: z.string().trim().max(30000).optional().nullable(),
  videoPrompt: z.string().trim().min(1).max(30000),
  duration: z.coerce.number().int().min(3).max(30).default(15),
  aspectRatio: storyboardAspectRatioSchema.default('16:9'),
  generateAudio: z.boolean().default(true),
})

export const updateStoryboardSchema = createStoryboardSchema
  .omit({ projectId: true })
  .partial()
  .extend({ baseUpdatedAt: z.string().datetime({ offset: true }) })

export const generateStoryboardVideoSchema = z.object({
  duration: z.coerce.number().int().min(3).max(30).optional(),
  aspectRatio: storyboardAspectRatioSchema.optional(),
  resolution: storyboardVideoResolutionSchema.optional(),
  generateAudio: z.boolean().default(true),
  model: z.string().trim().min(1).max(120).optional(),
  continuityFrameMediaId: z.string().trim().min(1).max(120).optional(),
  continuitySourceVideoId: z.string().trim().min(1).max(120).optional(),
}).refine((value) => Boolean(value.continuityFrameMediaId) === Boolean(value.continuitySourceVideoId), {
  message: '承接上一镜时必须同时提供来源视频和尾帧',
  path: ['continuityFrameMediaId'],
})

export const generateStoryboardVideoGroupSchema = z.object({
  storyboardIds: z.array(z.string().min(1)).min(2).max(4)
    .refine((ids) => new Set(ids).size === ids.length, '组合分镜不能重复'),
  duration: z.coerce.number().int().min(4).max(30).optional(),
  resolution: storyboardVideoResolutionSchema.optional(),
  generateAudio: z.boolean().optional(),
  model: z.string().trim().min(1).max(120).optional(),
})

export type MatchableAsset = {
  id: string
  type: AssetType
  name: string
  description: string
  tags: string[]
  selectedImageId?: string | null
}

export type StoryboardAssetMatch = MatchableAsset & {
  score: number
  reason: string
  referenceOrder: number
  mentionIndex: number
  storyPriority?: number
}

type StoryboardReferenceCandidate = {
  referenceOrder: number
  type?: AssetType
  name?: string
  asset?: { type: AssetType; name?: string }
  storyPriority?: number
}

const GENERIC_CHARACTER_NAME = /(?:守卫|护卫|保安|工作人员|店员|服务员|群演|群众|成员|路人|司机|医护|警员|士兵|侍从|随从)$/u

// 角色资产经常以“食堂主任 / 苏女士 / 林老师”这类带身份后缀的
// 规范名称保存，而分镜里为了口语化只写“主任 / 苏女士 / 林老师”。
// 这些后缀只作为角色别名使用，避免把普通描述词（例如“女人”）误认成资产。
const CHARACTER_ROLE_ALIASES = [
  '主任', '老板', '店长', '老师', '医生', '护士', '警察', '保安', '司机',
  '店员', '服务员', '经理', '助理', '秘书', '校长', '院长', '教授', '律师',
  '记者', '导演', '厨师', '妈妈', '母亲', '爸爸', '父亲', '女儿', '儿子',
  '哥哥', '姐姐', '弟弟', '妹妹', '爷爷', '奶奶', '叔叔', '阿姨', '先生', '女士',
] as const

export function isManualStoryboardAssetLink(matchReason: string | null | undefined) {
  return Boolean(matchReason?.startsWith('手动添加：'))
}

export function isExcludedStoryboardAssetLink(matchReason: string | null | undefined) {
  return Boolean(matchReason?.startsWith('手动排除：'))
}

export function storyboardAssetExclusionReason(assetName: string) {
  return `手动排除：${assetName.trim()}`
}

function storyboardReferenceName(candidate: StoryboardReferenceCandidate) {
  return candidate.name?.trim() || candidate.asset?.name?.trim() || ''
}

export function prioritizeStoryboardReferences<T extends StoryboardReferenceCandidate>(
  candidates: T[],
  limit: number,
  options: { omitLocations?: boolean } = {},
) {
  const maximum = Math.max(1, Math.floor(limit))
  const typeOf = (candidate: T) => candidate.type ?? candidate.asset?.type
  const ordered = [...candidates].sort((left, right) => left.referenceOrder - right.referenceOrder)
  const characters = ordered
    .filter((candidate) => typeOf(candidate) === AssetType.character)
    .sort((left, right) => (
      (right.storyPriority || 0) - (left.storyPriority || 0)
      || Number(GENERIC_CHARACTER_NAME.test(storyboardReferenceName(left)))
        - Number(GENERIC_CHARACTER_NAME.test(storyboardReferenceName(right)))
      || left.referenceOrder - right.referenceOrder
    ))
  const locations = options.omitLocations
    ? []
    : ordered.filter((candidate) => typeOf(candidate) === AssetType.location)
  const props = ordered.filter((candidate) => typeOf(candidate) === AssetType.prop)
  if (maximum === 1) return (characters.length > 0 ? characters : props.length > 0 ? props : locations).slice(0, 1)
  if (characters.length >= maximum) return characters.slice(0, maximum)

  const remainingAfterCharacters = maximum - characters.length
  const selectedProps = props.slice(0, remainingAfterCharacters)
  const selectedLocations = locations.slice(0, remainingAfterCharacters - selectedProps.length)
  const selected = [...characters, ...selectedProps, ...selectedLocations]
  if (selected.length < maximum) {
    const selectedSet = new Set(selected)
    selected.push(...ordered.filter((candidate) => !selectedSet.has(candidate)).slice(0, maximum - selected.length))
  }
  return selected.slice(0, maximum)
}

type CombinedStoryboardReferenceCandidate = StoryboardReferenceCandidate & {
  appearanceCount?: number
  mentionCount?: number
  appearsInFinalStoryboard?: boolean
}

export function prioritizeCombinedStoryboardReferences<T extends CombinedStoryboardReferenceCandidate>(
  candidates: T[],
  limit: number,
) {
  const maximum = Math.max(1, Math.floor(limit))
  const typeOf = (candidate: T) => candidate.type ?? candidate.asset?.type
  const priority = (left: T, right: T) => (
    Number(Boolean(right.appearsInFinalStoryboard)) - Number(Boolean(left.appearsInFinalStoryboard))
    || (right.appearanceCount || 0) - (left.appearanceCount || 0)
    || (right.mentionCount || 0) - (left.mentionCount || 0)
    || left.referenceOrder - right.referenceOrder
  )
  const characters = candidates
    .filter((candidate) => typeOf(candidate) === AssetType.character)
    .sort(priority)
  const locations = candidates
    .filter((candidate) => typeOf(candidate) === AssetType.location)
    .sort(priority)
  const props = candidates
    .filter((candidate) => typeOf(candidate) === AssetType.prop)
    .sort(priority)

  return [...characters, ...props, ...locations].slice(0, maximum)
}

type MatchStoryboardAssetOptions = {
  requireAliasMatch?: boolean
}

function normalizeForMatching(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function assetAliases(asset: MatchableAsset) {
  const aliases = new Set<string>([asset.name])
  const plainName = asset.name.replace(/[（(【\[].*?[）)】\]]/g, '').trim()
  if (plainName) aliases.add(plainName)

  for (const group of asset.name.matchAll(/[（(【\[](.+?)[）)】\]]/g)) {
    for (const item of group[1].split(/[、,，/|]/)) {
      const alias = item.trim()
      if (alias.length >= 2) aliases.add(alias)
    }
  }

  if (asset.type === AssetType.character) {
    const shortName = plainName.split(/[·•]/u)[0]?.trim()
    if (shortName && normalizeForMatching(shortName).length >= 2) aliases.add(shortName)

    for (const role of CHARACTER_ROLE_ALIASES) {
      if (plainName.endsWith(role) && plainName !== role) aliases.add(role)
    }
  }

  if (asset.type === AssetType.location) {
    const locationParts = asset.name.split(/[·•]/u).map((part) => part.trim()).filter(Boolean)
    if (locationParts[0] && normalizeForMatching(locationParts[0]).length >= 4) {
      aliases.add(locationParts[0])
    }
  }

  return [...aliases]
}

function locationScriptEvidence(asset: MatchableAsset, script: string) {
  const normalizedScript = normalizeForMatching(script)
  if (!normalizedScript) return ''

  const alias = assetAliases(asset)
    .map((value) => ({ value, normalized: normalizeForMatching(value) }))
    .filter((item) => item.normalized.length >= 2)
    .sort((left, right) => right.normalized.length - left.normalized.length)
    .find((item) => normalizedScript.includes(item.normalized))
  if (alias) return `名称或别名“${alias.value}”`

  const tag = asset.tags
    .map((value) => ({ value: value.trim(), normalized: normalizeForMatching(value) }))
    .filter((item) => item.value && item.normalized.length >= 2)
    .find((item) => normalizedScript.includes(item.normalized))
  return tag ? `标签“${tag.value}”` : ''
}

const typePriority: Record<AssetType, number> = {
  [AssetType.character]: 3,
  [AssetType.location]: 2,
  [AssetType.prop]: 1,
}

export function matchStoryboardAssets(
  assets: MatchableAsset[],
  prompt: string,
  limit = 12,
  options: MatchStoryboardAssetOptions = {},
): StoryboardAssetMatch[] {
  const normalizedPrompt = normalizeForMatching(prompt)
  if (!normalizedPrompt) return []

  const matches = assets.flatMap((asset) => {
    let score = 0
    let mentionIndex = Number.MAX_SAFE_INTEGER
    let aliasMatched = false
    const reasons: string[] = []
    const aliases = assetAliases(asset)

    aliases.forEach((alias, index) => {
      const normalizedAlias = normalizeForMatching(alias)
      if (normalizedAlias.length < 2 || !normalizedPrompt.includes(normalizedAlias)) return
      aliasMatched = true
      mentionIndex = Math.min(mentionIndex, normalizedPrompt.indexOf(normalizedAlias))
      const aliasScore = index === 0 ? 120 : 90
      if (aliasScore > score) {
        score = aliasScore + Math.min(normalizedAlias.length, 20)
      }
      reasons.push(index === 0 ? `提到“${asset.name}”` : `提到别名“${alias}”`)
    })

    const matchedTags = asset.tags.filter((tag) => {
      const normalizedTag = normalizeForMatching(tag)
      return normalizedTag.length >= 2 && normalizedPrompt.includes(normalizedTag)
    })
    if (matchedTags.length > 0) {
      score += matchedTags.length * 14
      reasons.push(`匹配标签：${matchedTags.slice(0, 3).join('、')}`)
    }

    if (options.requireAliasMatch && !aliasMatched) return []
    if (score < 28) return []
    return [{
      ...asset,
      score,
      reason: reasons.join('；'),
      referenceOrder: 0,
      mentionIndex,
    }]
  })

  return matches
    .sort((a, b) => (
      typePriority[b.type] - typePriority[a.type]
      || a.mentionIndex - b.mentionIndex
      || b.score - a.score
      || b.name.length - a.name.length
    ))
    .slice(0, limit)
    .map((match, index) => ({ ...match, referenceOrder: index + 1 }))
}

function stripAssetAliasMentions(value: string, assets: MatchableAsset[]) {
  const aliases = [...new Set(assets.flatMap(assetAliases))]
    .filter((alias) => alias.length >= 2)
    .sort((left, right) => right.length - left.length)

  return aliases.reduce((text, alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return text.replace(new RegExp(escaped, 'giu'), ' ')
  }, value)
}

export function matchStoryboardVideoAssets(
  assets: MatchableAsset[],
  input: {
    title?: string | null
    notes?: string | null
    imagePrompt?: string | null
    videoPrompt: string
    script?: string | null
  },
  limit = 9,
): StoryboardAssetMatch[] {
  const maximum = Math.max(1, Math.min(9, limit))
  const characterAssets = assets.filter((asset) => asset.type === AssetType.character)
  const locationAssets = assets.filter((asset) => asset.type === AssetType.location)
  const propAssets = assets.filter((asset) => asset.type === AssetType.prop)
  const currentSceneText = [input.title, input.notes, input.imagePrompt, input.videoPrompt]
    .filter(Boolean)
    .join('\n')
  const characterSceneText = stripAssetAliasMentions(
    [input.title, input.imagePrompt, input.videoPrompt].filter(Boolean).join('\n'),
    locationAssets,
  )
  const baseCharacters = matchStoryboardAssets(
    characterAssets,
    characterSceneText,
    Math.max(16, characterAssets.length),
    { requireAliasMatch: true },
  )
  const structuredPrompt = parseStructuredStoryboardPrompt(input.videoPrompt)
  const timelineCharacters = structuredPrompt
    ? matchStoryboardAssets(
        characterAssets,
        structuredPrompt.timeline,
        Math.max(16, characterAssets.length),
        { requireAliasMatch: true },
      )
    : []
  const timelineOrder = new Map(timelineCharacters.map((character, index) => [character.id, index]))
  const characters = baseCharacters.map((character) => {
    const timelineIndex = timelineOrder.get(character.id)
    const genericCharacter = GENERIC_CHARACTER_NAME.test(character.name)
    const storyPriority = timelineIndex !== undefined
      ? (genericCharacter ? 2_000 : 3_000) - timelineIndex
      : genericCharacter
        ? 0
        : 1_000
    return {
      ...character,
      storyPriority,
      reason: `${character.reason}；${timelineIndex !== undefined ? '视频时间轴出镜' : storyPriority > 0 ? '命名人物优先' : '通用角色后置'}`,
    }
  })
  const standardSceneNames = storyboardLocationNames({
    notes: input.notes,
    videoPrompt: input.videoPrompt,
  })
  const exactSceneNames = new Set(standardSceneNames.map((name) => name.trim()))
  const locationCandidates = standardSceneNames.length > 0
    ? locationAssets.filter((asset) => exactSceneNames.has(asset.name.trim()))
    : locationAssets
  const promptLocations = matchStoryboardAssets(
    locationCandidates,
    currentSceneText,
    Math.max(16, locationCandidates.length),
  )

  let locations = promptLocations
  const script = input.script?.trim()
  if (standardSceneNames.length > 0) {
    locations = promptLocations.flatMap((asset) => {
      const evidence = script ? locationScriptEvidence(asset, script) : ''
      if (script && !evidence) return []
      return [{
        ...asset,
        reason: `${asset.reason}；分镜标准场景名精确匹配${evidence ? `；剧本场景一致（${evidence}）` : ''}`,
      }]
    })
  } else if (script) {
    const scriptLocations = matchStoryboardAssets(
      locationAssets,
      script,
      locationAssets.length,
    )
    const scriptLocationIds = new Set(scriptLocations.map((asset) => asset.id))
    locations = promptLocations
      .filter((asset) => scriptLocationIds.has(asset.id))
      .map((asset) => ({ ...asset, reason: `${asset.reason}；剧本场景一致` }))

    if (promptLocations.length === 0 && scriptLocations.length === 1) {
      locations = [{ ...scriptLocations[0], reason: `${scriptLocations[0].reason}；剧本唯一场景` }]
    }
  }

  const props = matchStoryboardAssets(
    propAssets,
    currentSceneText,
    Math.max(16, propAssets.length),
    { requireAliasMatch: true },
  )

  return prioritizeStoryboardReferences([...characters, ...props, ...locations.slice(0, 1)], maximum)
    .map((match, index) => ({ ...match, referenceOrder: index + 1 }))
}

export function buildStoryboardScriptSceneContext(input: {
  script?: string | null
  notes?: string | null
  locations: MatchableAsset[]
}) {
  const notes = input.notes?.trim().slice(0, 320) || ''
  const script = input.script?.trim() || ''
  if (!script) return notes ? `分镜场景锚点：${notes}` : ''

  const terms = [...new Set(input.locations.flatMap((asset) => [
    ...assetAliases(asset),
    ...asset.tags,
  ]))]
    .filter((term) => normalizeForMatching(term).length >= 2)
    .sort((left, right) => right.length - left.length)
  const lowerScript = script.toLocaleLowerCase()
  const matchedIndexes = terms
    .map((term) => lowerScript.indexOf(term.toLocaleLowerCase()))
    .filter((index) => index >= 0)
  const matchIndex = matchedIndexes.length ? Math.min(...matchedIndexes) : -1
  const excerpt = matchIndex >= 0
    ? script.slice(Math.max(0, matchIndex - 420), Math.min(script.length, matchIndex + 720)).trim()
    : ''

  return [
    notes ? `分镜场景锚点：${notes}` : '',
    excerpt ? `所属分集剧本原文：${excerpt}` : '',
  ].filter(Boolean).join('\n').slice(0, 1000)
}

export async function syncStoryboardAssetLinks(storyboardId: string) {
  const storyboard = await prisma.storyboard.findUnique({
    where: { id: storyboardId },
    select: {
      projectId: true,
      title: true,
      notes: true,
      imagePrompt: true,
      videoPrompt: true,
      assetSelectionInitialized: true,
      episode: { select: { content: true } },
    },
  })
  if (!storyboard) throw new Error(`Storyboard not found: ${storyboardId}`)
  if (storyboard.assetSelectionInitialized) return []

  const assets = await prisma.asset.findMany({
    where: { projectId: storyboard.projectId },
    select: {
      id: true,
      type: true,
      name: true,
      description: true,
      tags: true,
      selectedImageId: true,
    },
  })
  const matches = matchStoryboardVideoAssets(assets, {
    title: storyboard.title,
    notes: storyboard.notes,
    imagePrompt: storyboard.imagePrompt,
    videoPrompt: storyboard.videoPrompt || '',
    script: storyboard.episode?.content,
  })

  // 每个分镜只执行一次初始识别。初始化完成后，资产集合完全由用户通过
  // @资产增删控制，保存提示词和生成视频都不会再次自动改写选择。
  const protectedLinks = await prisma.storyboardAsset.findMany({
    where: {
      storyboardId,
      OR: [
        { matchReason: { startsWith: '手动添加：' } },
        { matchReason: { startsWith: '手动排除：' } },
      ],
    },
    select: {
      assetId: true,
      matchScore: true,
      matchReason: true,
      referenceOrder: true,
    },
    orderBy: { referenceOrder: 'asc' },
  })
  const manualLinks = protectedLinks.filter((link) => isManualStoryboardAssetLink(link.matchReason))
  const excludedLinks = protectedLinks.filter((link) => isExcludedStoryboardAssetLink(link.matchReason))
  const excludedAssetIds = new Set(excludedLinks.map((link) => link.assetId))
  const includedMatches = matches.filter((match) => !excludedAssetIds.has(match.id))
  const autoMatchIds = new Set(includedMatches.map((match) => match.id))
  const manualOnlyLinks = manualLinks.filter((link) => !autoMatchIds.has(link.assetId))
  const manualMatches: StoryboardAssetMatch[] = manualOnlyLinks.flatMap((link) => {
      const asset = assets.find((item) => item.id === link.assetId)
      return asset ? [{
            ...asset,
            score: link.matchScore,
            reason: link.matchReason,
            referenceOrder: 0,
            mentionIndex: Number.MAX_SAFE_INTEGER,
          }] : []
    })
  const mergedMatches: StoryboardAssetMatch[] = [...includedMatches, ...manualMatches]
    .map((match, index) => ({ ...match, referenceOrder: index + 1 }))
  const persistedExclusions = excludedLinks.map((link, index) => ({
    ...link,
    referenceOrder: mergedMatches.length + index + 1,
  }))

  await prisma.$transaction([
    prisma.storyboardAsset.deleteMany({ where: { storyboardId } }),
    prisma.storyboardAsset.createMany({
      data: [
        ...mergedMatches.map((match) => ({
          storyboardId,
          assetId: match.id,
          matchScore: match.score,
          matchReason: match.reason,
          referenceOrder: match.referenceOrder,
        })),
        ...persistedExclusions.map((link) => ({
          storyboardId,
          assetId: link.assetId,
          matchScore: link.matchScore,
          matchReason: link.matchReason,
          referenceOrder: link.referenceOrder,
        })),
      ],
    }),
    prisma.storyboard.update({
      where: { id: storyboardId },
      data: { assetSelectionInitialized: true },
    }),
  ])

  return mergedMatches
}

type StructuredStoryboardPrompt = {
  style: string
  people: string
  scene: string
  timeline: string
}

function parseStructuredStoryboardPrompt(value: string): StructuredStoryboardPrompt | null {
  const headingPattern = /^【(风格基调|本分镜人物|人物及初始站位|人物及站位|场景|视频分镜)】\s*$/gmu
  const matches = [...value.matchAll(headingPattern)]
  if (matches.length < 4) return null
  const sections = new Map<string, string>()
  matches.forEach((match, index) => {
    const start = (match.index || 0) + match[0].length
    const end = matches[index + 1]?.index ?? value.length
    const key = match[1] === '人物及站位' || match[1] === '本分镜人物'
      ? '人物及初始站位'
      : match[1]
    sections.set(key, value.slice(start, end).trim())
  })
  const style = sections.get('风格基调') || ''
  const people = sections.get('人物及初始站位') || ''
  const scene = sections.get('场景') || ''
  const timeline = sections.get('视频分镜') || ''
  return style && people && scene && timeline ? { style, people, scene, timeline } : null
}

function finishDirectorPromptSentence(value: string, fallback: string) {
  const normalized = value.replace(/\r/gu, '').replace(/\n+/gu, '；').trim()
  if (!normalized) return fallback
  return /[。！？.!?]$/u.test(normalized) ? normalized : `${normalized}。`
}

export function buildLegacyDirectorStoryboardPrompt(input: {
  number: number
  title: string
  videoPrompt: string | null | undefined
}) {
  const structured = parseStructuredStoryboardPrompt(input.videoPrompt || '')
  const partialScene = input.videoPrompt?.match(/【场景】\s*\n?([\s\S]*?)(?=\n【视频分镜】|$)/u)?.[1]?.trim() || ''
  const partialTimeline = input.videoPrompt?.match(/【视频分镜】\s*\n?([\s\S]*)$/u)?.[1]?.trim() || ''
  const timeline = structured?.timeline?.trim() || partialTimeline || input.videoPrompt?.trim() || ''
  const segments = parseStoryboardTimelineSegments(timeline)
  const cameraLanguage = /特写|近景|中近景|中景|全景|远景|俯拍|仰拍|平拍|侧拍|正面|背面|过肩|固定机位|固定镜头|跟拍|推镜|拉镜|摇镜|横移|手持|焦点|景深|构图|摄影机|镜头/u
  const camera = [...new Set(segments.map((segment) => {
    const clause = segment.body
      .split(/[。；;]/u)
      .map((item) => item.trim())
      .find((item) => cameraLanguage.test(item)) || ''
    const cameraParts: string[] = []
    for (const part of clause.split(/[，,]/u).map((item) => item.trim()).filter(Boolean)) {
      if (cameraLanguage.test(part)) cameraParts.push(part)
      else if (cameraParts.length > 0) break
    }
    return cameraParts.join('，') || clause
  })
    .filter(Boolean))]
    .join('；')
  const scene = structured?.scene?.trim() || partialScene
  return [
    `分镜${input.number}：`,
    `景别机位运动：${finishDirectorPromptSentence(camera, '沿用当前视频生成提示词中的镜头设计。')}`,
    `画面内容：${finishDirectorPromptSentence([scene, timeline].filter(Boolean).join('；'), input.title)}`,
    `动作对白：${finishDirectorPromptSentence(timeline, '本镜无对白，动作按画面内容执行。')}`,
  ].join('\n')
}

export function unboundStoryboardTimelineCharacters(input: {
  videoPrompt: string
  knownCharacterNames: string[]
  referencedCharacterNames: string[]
}) {
  const structured = parseStructuredStoryboardPrompt(input.videoPrompt)
  const timeline = structured?.timeline || input.videoPrompt
  const referenced = new Set(input.referencedCharacterNames.map((name) => name.trim()).filter(Boolean))
  return visibleStoryboardTimelineCharacters({
    videoPrompt: input.videoPrompt,
    knownCharacterNames: input.knownCharacterNames,
  }).filter((name) => timeline.includes(name) && !referenced.has(name))
}

function rebaseStructuredTimeline(value: string, offset: number) {
  return value.replace(
    /^(\d+(?:\.\d+)?)~(\d+(?:\.\d+)?)s：/gmu,
    (_match, start: string, end: string) => (
      `${formatTimelineSecond(Number(start) + offset)}~${formatTimelineSecond(Number(end) + offset)}s：`
    ),
  )
}

function structuredTimelineDuration(value: string) {
  const endings = [...value.matchAll(/^\d+(?:\.\d+)?~(\d+(?:\.\d+)?)s：/gmu)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
  return endings.length > 0 ? Math.max(...endings) : 0
}

function compactTimelineBlock(value: string, limit: number) {
  if (value.length <= limit) return value
  const heading = value.match(/^(\d+(?:\.\d+)?~\d+(?:\.\d+)?s：)/u)?.[1] || ''
  const body = value.slice(heading.length).trim()
  const detailed = compactDetailedTimelineBlock(heading, body, limit)
  if (detailed) return detailed
  const bodyLimit = Math.max(30, limit - heading.length)
  const quotes = [...body.matchAll(/[“"][^”"\n]+[”"]/gu)]

  if (quotes.length > 0) {
    const firstQuote = quotes[0]
    const lastQuote = quotes[quotes.length - 1]
    const quoteStart = firstQuote.index || 0
    const quoteEnd = (lastQuote.index || 0) + lastQuote[0].length
    const spoken = body.slice(quoteStart, quoteEnd)
    const remaining = Math.max(10, bodyLimit - spoken.length - 1)
    const headLimit = Math.ceil(remaining * 0.58)
    const tailLimit = Math.max(0, remaining - headLimit)
    const head = body.slice(0, quoteStart).trim().slice(0, headLimit).trim()
    const tailSource = body.slice(quoteEnd).trim()
    const tail = tailLimit > 0 ? tailSource.slice(-tailLimit).trim() : ''
    return `${heading}${[head, spoken, tail].filter(Boolean).join('…')}`.slice(0, limit)
  }

  const headLimit = Math.ceil((bodyLimit - 1) * 0.55)
  const tailLimit = Math.max(0, bodyLimit - headLimit - 1)
  const head = body.slice(0, headLimit).trim()
  const tail = tailLimit > 0 ? body.slice(-tailLimit).trim() : ''
  return `${heading}${head}…${tail}`.slice(0, limit)
}

const COMPACT_TIMELINE_DETAIL_ORDER = [
  '镜头与构图',
  '动作顺序',
  '动作物理',
  '表演变化',
  '对白',
  '本段结束状态',
] as const

const COMPACT_TIMELINE_DETAIL_WEIGHTS: Record<typeof COMPACT_TIMELINE_DETAIL_ORDER[number], number> = {
  镜头与构图: 2,
  动作顺序: 4,
  动作物理: 4,
  表演变化: 4,
  对白: 5,
  本段结束状态: 4,
}

function compactTimelineField(value: string, limit: number) {
  if (value.length <= limit) return value
  if (limit <= 1) return '…'.slice(0, limit)
  return `${value.slice(0, limit - 1).trim()}…`.slice(0, limit)
}

function detailedTimelineBlockMinimum(value: string) {
  const heading = value.match(/^(\d+(?:\.\d+)?~\d+(?:\.\d+)?s：)/u)?.[1] || ''
  const body = value.slice(heading.length).trim()
  const { fields } = parseStoryboardTimelineDetailFields(body)
  if (!STORYBOARD_TIMELINE_DETAIL_LABELS.every((label) => fields[label])) return 0
  const labels = COMPACT_TIMELINE_DETAIL_ORDER.filter((label) => fields[label])
  return heading.length
    + labels.reduce((total, label) => total + label.length + 2, 0)
    + Math.max(0, labels.length - 1)
}

function compactDetailedTimelineBlock(heading: string, body: string, limit: number) {
  const { fields, prefix } = parseStoryboardTimelineDetailFields(body)
  if (!STORYBOARD_TIMELINE_DETAIL_LABELS.every((label) => fields[label])) return ''
  let labels = COMPACT_TIMELINE_DETAIL_ORDER.filter((label) => fields[label])
  const minimumLength = (items: typeof labels) => heading.length
    + items.reduce((total, label) => total + label.length + 2, 0)
    + Math.max(0, items.length - 1)
  if (minimumLength(labels) > limit && labels.includes('对白')) {
    labels = labels.filter((label) => label !== '对白')
  }
  const requiredMinimum = minimumLength(labels)
  const prefixValue = prefix && limit >= requiredMinimum + prefix.length + 1 ? `${prefix}；` : ''
  const fixedLength = heading.length + prefixValue.length
    + labels.reduce((total, label) => total + label.length + 1, 0)
    + Math.max(0, labels.length - 1)
  if (fixedLength + labels.length > limit) return ''

  const totalWeight = labels.reduce((total, label) => total + COMPACT_TIMELINE_DETAIL_WEIGHTS[label], 0)
  const fieldLimits = labels.map(() => 1)
  let remaining = limit - fixedLength - labels.length
  const shares = labels.map((label, index) => {
    const share = remaining * COMPACT_TIMELINE_DETAIL_WEIGHTS[label] / totalWeight
    const whole = Math.floor(share)
    fieldLimits[index] += whole
    return { index, fraction: share - whole, weight: COMPACT_TIMELINE_DETAIL_WEIGHTS[label] }
  })
  remaining = limit - fixedLength - fieldLimits.reduce((total, fieldLimit) => total + fieldLimit, 0)
  shares
    .sort((left, right) => right.fraction - left.fraction || right.weight - left.weight || left.index - right.index)
    .slice(0, Math.max(0, remaining))
    .forEach(({ index }) => { fieldLimits[index] += 1 })
  const details = labels.map((label, index) => (
    `${label}：${compactTimelineField(fields[label] || '', fieldLimits[index])}`
  )).join('；')
  return `${heading}${prefixValue}${details}`
}

function compactStructuredTimeline(value: string, limit: number) {
  if (value.length <= limit) return value
  const matches = [...value.matchAll(/^\d+(?:\.\d+)?~\d+(?:\.\d+)?s：/gmu)]
  if (matches.length === 0) return truncatePromptText(value, limit)
  const blocks = matches.map((match, index) => (
    value.slice(match.index || 0, matches[index + 1]?.index ?? value.length).trim()
  ))
  const separatorLength = Math.max(0, blocks.length - 1)
  const available = Math.max(blocks.length, limit - separatorLength)
  const minimums = blocks.map((block) => detailedTimelineBlockMinimum(block) || 30)
  const minimumTotal = minimums.reduce((total, minimum) => total + minimum, 0)
  const blockLimits = minimumTotal <= available ? [...minimums] : blocks.map(() => 1)
  let remaining = available - blockLimits.reduce((total, blockLimit) => total + blockLimit, 0)
  let cursor = 0
  while (remaining > 0) {
    blockLimits[cursor % blockLimits.length]++
    cursor++
    remaining--
  }
  return blocks.map((block, index) => compactTimelineBlock(block, blockLimits[index])).join('\n').slice(0, limit)
}

function stripEmbeddedProjectStyleLock(value: string) {
  const generatedStylePrefixes = [
    '项目统一画风：',
    '项目补充风格规则：',
    '真人影视摄影风格',
    '所有角色对白和旁白必须使用自然美式英语',
    '纯 2D 动画影像',
    '高品质 3D CG 游戏过场动画风格',
    '写实国漫 3D 动画',
    '次世代半写实国漫 3D 剧情 CG',
    '高精度半写实 3D 数字人电影 CG',
    '精致 Q 版动画风格',
    '严格保持同一项目中人物、道具、场景',
  ]
  return value
    .split('\n')
    .filter((line) => !generatedStylePrefixes.some((prefix) => line.trim().startsWith(prefix)))
    .join('\n')
    .trim()
}

function joinUniquePromptLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>()
  const lines: string[] = []

  for (const value of values) {
    for (const sourceLine of (value || '').split('\n')) {
      const line = sourceLine.trim()
      if (!line) continue
      const key = line.replace(/\s+/gu, ' ').replace(/[。；;]+$/gu, '')
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(line)
    }
  }

  return lines.join('\n')
}

function escapePromptPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dedupeStructuredCharacterDeclarations(value: string, characterNames: string[]) {
  const names = [...new Set(characterNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  if (names.length === 0) {
    return [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))].join('\n')
  }

  const marker = new RegExp(
    `(?:^|[；;])\\s*(${names.map(escapePromptPattern).join('|')})(?=\\s*(?:[（(:：]|$))`,
    'gu',
  )
  const seenCharacters = new Set<string>()
  const seenOtherLines = new Set<string>()
  const output: string[] = []

  for (const sourceLine of value.split('\n')) {
    const line = sourceLine.trim()
    if (!line) continue
    const matches = [...line.matchAll(marker)]
    if (matches.length === 0) {
      if (!seenOtherLines.has(line)) {
        seenOtherLines.add(line)
        output.push(line)
      }
      continue
    }

    const firstNameOffset = matches[0][0].lastIndexOf(matches[0][1])
    const prefix = line.slice(0, (matches[0].index || 0) + firstNameOffset).replace(/[；;\s]+$/gu, '').trim()
    if (prefix && !seenOtherLines.has(prefix)) {
      seenOtherLines.add(prefix)
      output.push(prefix)
    }

    matches.forEach((match, index) => {
      const name = match[1]
      if (seenCharacters.has(name)) return
      const nameOffset = match[0].lastIndexOf(name)
      const start = (match.index || 0) + nameOffset
      const end = matches[index + 1]?.index ?? line.length
      const declaration = line.slice(start, end).replace(/[；;\s]+$/gu, '').trim()
      if (!declaration) return
      seenCharacters.add(name)
      output.push(declaration)
    })
  }

  return output.join('\n')
}

function retainReferencedCharacterDeclarations(
  value: string,
  knownCharacterNames: string[],
  referencedCharacterNames: string[],
) {
  const knownNames = [...new Set(knownCharacterNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  const referencedNames = new Set(referencedCharacterNames.map((name) => name.trim()).filter(Boolean))
  const deduped = dedupeStructuredCharacterDeclarations(value, knownNames)
  return deduped
    .split('\n')
    .filter((line) => {
      const declaredName = knownNames.find((name) => new RegExp(
        `^${escapePromptPattern(name)}(?=\\s*(?:[（(:：]|$))`,
        'u',
      ).test(line.trim()))
      return !declaredName || referencedNames.has(declaredName)
    })
    .join('\n')
    .trim()
}

function normalizeCharacterRelativeCamera(value: string, characterNames: string[]) {
  return characterNames.reduce((timeline, name) => {
    const escaped = escapePromptPattern(name)
    return timeline.replace(
      new RegExp(`从${escaped}腰部高度(俯拍|仰拍|平拍|拍摄)`, 'gu'),
      `摄影机固定在${name}身后右侧腰线外，$1`,
    )
  }, value)
}

function buildCharacterCardinalityRule(characterNames: string[], compact: boolean) {
  const names = [...new Set(characterNames.map((name) => name.trim()).filter(Boolean))]
  if (names.length === 0) return ''
  const cast = names.join('、')
  return compact
    ? `角色数量锁定：全片最多${names.length}名唯一人物，只允许${cast}；不得出现第${names.length + 1}人、背景同学、分身或重复脸。每张单人参考图只代表一人；禁止换脸、换装和复制；动作只由句中完整姓名执行，画外角色不入镜。`
    : `角色身份、数量与动作归属强制规则：全片最多${names.length}名唯一人物，只允许${cast}，任何时刻不得出现第${names.length + 1}人、背景同学或未命名路人。每张单人参考图只代表一名唯一演员；禁止分身、双胞胎、替身、镜像、海报、倒影、背景重复人像、换脸或角色互换。每个动作只能由同一句中明确写出的完整姓名执行，动作对象也必须按完整姓名锁定，禁止使用相似服装、邻近站位或代词把甲角色的动作转移给乙角色。每个时间段只生成该段动作明确要求入镜的角色；仅被提及、被望向或在画外说话的角色保持画外，不得自动入镜。`
}

const IRREVERSIBLE_VIDEO_ACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/坠落|下坠|坠入/gu, '坠落'],
  [/跌落|跌下/gu, '跌落'],
  [/下沉|沉入/gu, '下沉'],
  [/倒地|倒下/gu, '倒地'],
  [/离开画面|移出画面|离场/gu, '离开画面'],
  [/松手|手指滑开|手指滑脱|失去支撑/gu, '失去支撑'],
  [/脱手/gu, '物体脱手'],
]

function buildIrreversibleActionOwnershipRule(
  timeline: string,
  characterNames: string[],
  compact: boolean,
) {
  const names = [...new Set(characterNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  const ownedActions = new Map<string, Set<string>>()
  for (const segment of timeline.split(/[；。\n]+/u)) {
    for (const [pattern, label] of IRREVERSIBLE_VIDEO_ACTIONS) {
      pattern.lastIndex = 0
      const action = pattern.exec(segment)
      if (!action) continue
      const prefix = segment.slice(0, action.index)
      const owner = names
        .map((name) => ({ name, index: prefix.lastIndexOf(name) }))
        .filter((candidate) => candidate.index >= 0)
        .sort((left, right) => right.index - left.index)[0]?.name
      if (!owner) continue
      const labels = ownedActions.get(owner) || new Set<string>()
      labels.add(label)
      ownedActions.set(owner, labels)
    }
  }
  if (ownedActions.size === 0) return ''
  const ownership = [...ownedActions.entries()]
    .map(([owner, actions]) => `${owner}唯一执行“${[...actions].join('、')}”`)
    .join('；')
  return compact
    ? `不可逆动作锁：${ownership}；其他人不得代替，完成后不得复位。`
    : `不可逆动作唯一归属锁：${ownership}。其他人物不得代替、交换或同时执行这些动作；未被指定的人物保持原空间层级和结束站位。不可逆动作只发生一次，完成后不得回到动作前位置、姿态或场景。`
}

function plainPromptCharacterName(value: string) {
  return value.replace(/[（(【\[].*$/u, '').trim()
}

function splitPromptCharacterNames(value: string): string[] {
  const plain = plainPromptCharacterName(value)
  if (!plain) return []
  const punctuationParts = plain.split(/[、，,]/u).map((part) => part.trim()).filter(Boolean)
  if (punctuationParts.length > 1) return punctuationParts.flatMap(splitPromptCharacterNames)
  const relationParts = plain.split(/与/u).map((part) => part.trim()).filter(Boolean)
  if (relationParts.length > 1) return relationParts.flatMap(splitPromptCharacterNames)
  const andParts = plain.split(/和/u).map((part) => part.trim()).filter(Boolean)
  if (andParts.length === 2 && andParts.every((part) => [...part].length >= 2)) {
    return andParts.flatMap(splitPromptCharacterNames)
  }
  return [plain]
}

const CHARACTER_VOICE_PITCHES = ['中低音区', '中音区偏低', '自然中音区', '中音区略高'] as const
const CHARACTER_VOICE_TIMBRES = [
  '清亮微气声',
  '冷静微颗粒',
  '温和厚实',
  '干净偏硬',
  '沉稳微沙感',
  '柔和通透',
] as const
const CHARACTER_VOICE_PACES = ['自然中速', '中速略快', '中速偏慢', '节奏利落、停顿较短'] as const
const CHARACTER_VOICE_ARTICULATIONS = [
  '清晰收尾',
  '吐字利落',
  '停顿分明',
  '尾音不拖长',
] as const

function stableStoryboardCharacterHash(value: string) {
  let hash = 2166136261
  for (const character of plainPromptCharacterName(value).normalize('NFKC')) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function buildCharacterVoiceProfile(name: string, visualStyle: VisualStyle) {
  const hash = stableStoryboardCharacterHash(name)
  const language = visualStyle === VisualStyle.overseas_live_action
    ? '自然美式英语'
    : '自然普通话'
  const pitch = CHARACTER_VOICE_PITCHES[hash % CHARACTER_VOICE_PITCHES.length]
  const timbre = CHARACTER_VOICE_TIMBRES[Math.floor(hash / 7) % CHARACTER_VOICE_TIMBRES.length]
  const pace = CHARACTER_VOICE_PACES[Math.floor(hash / 43) % CHARACTER_VOICE_PACES.length]
  const articulation = CHARACTER_VOICE_ARTICULATIONS[Math.floor(hash / 257) % CHARACTER_VOICE_ARTICULATIONS.length]
  return `${language}；${pitch}；${timbre}；${pace}；${articulation}`
}

const STRICT_VIDEO_AUDIO_RULE = '声音硬规则：绝对不要生成任何背景音乐（BGM）或旋律性配乐；只保留演员现场对白、环境音和剧情必要音效。'
const CHARACTER_VOICE_LOCK_RULE = '声音锁：上述固定声音是各角色跨分镜唯一声线，后续逐字保持相同语言、音区、音色、语速和吐字方式；年龄与性别呈现贴合人物资产。'

function canonicalizeStoryboardCharacterNames(value: string, characterNames: string[]) {
  const canonicalNames = [...new Set(characterNames.map(plainPromptCharacterName).filter(Boolean))]
  const personalAliases = canonicalNames.flatMap((canonicalName) => {
    const shortName = canonicalName.split('·')[0]?.trim() || ''
    if (!shortName || shortName === canonicalName) return []
    const suffix = canonicalName.slice(shortName.length)
    return [{ shortName, suffix, canonicalName }]
  })
  const roleAliases = canonicalNames.flatMap((canonicalName) => {
    if (canonicalName.includes('·') || [...canonicalName].length < 4) return []
    const shortName = [...canonicalName].slice(-2).join('')
    const isUnique = canonicalNames.filter((name) => name.endsWith(shortName)).length === 1
    return isUnique ? [{ shortName, suffix: '', canonicalName }] : []
  })
  const aliases = [...personalAliases, ...roleAliases]
    .sort((left, right) => right.shortName.length - left.shortName.length)

  return aliases.reduce((prompt, alias) => prompt.replace(
    alias.suffix
      ? new RegExp(`${escapePromptPattern(alias.shortName)}(?!${escapePromptPattern(alias.suffix)})`, 'gu')
      : new RegExp(`(?<!${escapePromptPattern(alias.canonicalName.slice(0, -alias.shortName.length))})${escapePromptPattern(alias.shortName)}`, 'gu'),
    alias.canonicalName,
  ), value)
}

function listedTimelineCharacters(value: string, label: '镜内' | '画外') {
  const matches = [...value.matchAll(new RegExp(`${label}：([^；。\\n]+)`, 'gu'))]
  return new Set(matches.flatMap((match) => (
    match[1].split(/[、,，]/u).map((item) => item
      .replace(/[（(][^）)]*[）)]/gu, '')
      .trim())
      .filter((item) => item && item !== '无')
  )))
}

function listedNameMatchesCharacter(listedName: string, characterName: string) {
  const canonicalName = plainPromptCharacterName(characterName)
  const shortName = canonicalName.split('·')[0]?.trim() || canonicalName
  return [canonicalName, shortName]
    .filter((name) => [...name].length >= 2)
    .some((name) => listedName === name || listedName.includes(name) || name.includes(listedName))
}

export function visibleStoryboardTimelineCharacters(input: {
  videoPrompt: string
  knownCharacterNames: string[]
}) {
  return resolveVisibleStoryboardTimelineCharacters(input)
}

function normalizeOffscreenDialogueCues(value: string) {
  const visibleCharacters = listedTimelineCharacters(value, '镜内')
  const offscreenCharacters = listedTimelineCharacters(value, '画外')
  let prompt = value
  for (const name of offscreenCharacters) {
    const visible = [...visibleCharacters].some((candidate) => (
      candidate === name || candidate.includes(name) || name.includes(candidate)
    ))
    if (visible) continue
    const escapedName = escapePromptPattern(name)
    prompt = prompt
      .replace(
        new RegExp(`${escapedName}按对白顺序自然同步口型`, 'gu'),
        `${name}仅作画外现场对白，不入镜、不要求口型`,
      )
      .replace(
        new RegExp(`${escapedName}(?:自然)?同步口型`, 'gu'),
        `${name}仅作画外现场对白，不入镜、不要求口型`,
      )
  }
  return prompt
}

function normalizeMissingLocationReference(value: string, mode: ContinuityReferenceMode | 'text' | null) {
  if (!mode) return value
  const replacement = mode === 'spatial' ? '沿用上一镜尾帧' : '按本镜场景文字设定'
  const reference = mode === 'spatial' ? '上一镜尾帧' : '本镜场景文字设定'
  return value
    .replace(/沿用场景资产主图/gu, replacement)
    .replace(/以场景资产主图为准/gu, `以${reference}为准`)
    .replace(/场景资产主图/gu, reference)
}

const NO_VIDEO_DIALOGUE = /^(?:无对白|全程不说话|no dialogue)[。.]?$/iu
const GENERIC_TIMELINE_ROLE = /中年女工作人员|中年男工作人员|工作人员|摄影师|司机|管家|保安|店员|服务员|警员|守卫|医生|护士|老师|辅导员|路人/gu
const TIMELINE_COUNT_LABEL = /^(?:无|一人|两人|三人|四人|\d+人|人物|角色|其他人物)$/u
const PHYSICS_KEEP_CUE = /左手|右手|双手|双脚|手腕|接触点|重心|支撑|持握|抓|握|按|拉|推|拽|牵|坠|落|移出画面|离开画面|行李箱|道具|门/u
const CONCISE_CAMERA_CUE = /特写|近景|中近景|中景|全景|远景|俯拍|仰拍|平拍|侧拍|正面|背面|过肩|固定机位|固定镜头|跟拍|推镜|拉镜|摇镜|横移|手持|摄影机|镜头/u

function normalizedPromptKey(value: string) {
  return value.replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase()
}

function concisePromptClauses(value: string) {
  const seen = new Set<string>()
  return value
    .replace(/\r/gu, '')
    .split(/[。；;\n]+/u)
    .map((clause) => clause.replace(/^[，,：:\s]+|[，,：:\s]+$/gu, '').trim())
    .filter((clause) => {
      const key = normalizedPromptKey(clause)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function conciseTimelinePerformance(value: string) {
  const cleaned = value
    .replace(/(?:^|[；;])\s*(?:镜内(?:角色)?|画外(?:角色)?|人数)[：:][^；;。]*(?:[；;。]|$)/gu, '；')
    .replace(/触发发生后保留[^；;。]*(?:[；;。]|$)/gu, '')
    .replace(/[^；;。]*(?:正脸或清晰侧脸|按对白顺序自然同步口型|成为尾帧焦点)[^；;。]*(?:[；;。]|$)/gu, '')
  return concisePromptClauses(cleaned).slice(0, 2).join('；')
}

function conciseTimelinePhysics(value: string, action: string) {
  const actionKey = normalizedPromptKey(action)
  return concisePromptClauses(value)
    .filter((clause) => PHYSICS_KEEP_CUE.test(clause))
    .filter((clause) => {
      const key = normalizedPromptKey(clause)
      return key.length >= 4 && !actionKey.includes(key)
    })
    .slice(0, 2)
    .join('；')
}

function naturalTimelineDialogue(value: string) {
  const dialogue = value.trim()
  if (!dialogue || NO_VIDEO_DIALOGUE.test(dialogue)) return '无对白'
  const markers = [...dialogue.matchAll(/(?:^|[；;]\s*|(?<=[”"])\s+)([\p{L}\p{N}·•.'’_-]{1,32})[：:]\s*/gmu)]
  if (markers.length === 0) return dialogue
  return markers.map((marker, index) => {
    const start = (marker.index || 0) + marker[0].length
    const end = markers[index + 1]?.index ?? dialogue.length
    const spoken = dialogue.slice(start, end)
      .replace(/^[；;\s“"]+|[；;\s”"]+$/gu, '')
      .trim()
    return `${marker[1]}说：“${spoken}”`
  }).join('；')
}

function timelineBodyDialogue(value: string, characterNames: string[] = []) {
  const names = [...new Set(characterNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  const quotes = [...value.matchAll(/[“"]([^”"\n]+)[”"]/gmu)]
  let previousQuoteEnd = 0
  return quotes.map((quote) => {
    const quoteStart = quote.index || 0
    const punctuationStart = Math.max(
      value.lastIndexOf('。', quoteStart),
      value.lastIndexOf('；', quoteStart),
      value.lastIndexOf('\n', quoteStart),
      previousQuoteEnd,
    )
    const prefix = value.slice(Math.max(0, punctuationStart), quoteStart)
    const speaker = names
      .map((name) => ({ name, index: prefix.indexOf(name) }))
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => left.index - right.index)[0]?.name
      || prefix.match(/([\p{L}\p{N}·•.'’_-]{1,24}?)(?:说|问|回答|喊|低声说)[：:]\s*$/u)?.[1]
      || ''
    previousQuoteEnd = quoteStart + quote[0].length
    return speaker ? `${speaker}：${quote[1]}` : quote[0]
  }).join('；')
}

function removeTimelineBodyDialogue(value: string) {
  return value
    .replace(/[\p{L}\p{N}·•.'’_-]{1,32}?(?:说|问|回答|喊|低声说)?[：:]\s*[“"][^”"\n]+[”"][。]?/gmu, '')
    .replace(/[“"][^”"\n]+[”"][。]?/gmu, '')
    .trim()
}

function compactTimelineText(value: string, maximum: number) {
  return truncatePromptText(value, maximum).replace(/…$/u, '').trim()
}

function simpleTimelineParts(value: string) {
  const clauses = concisePromptClauses(removeTimelineBodyDialogue(value))
  const cameraIndex = clauses.findIndex((clause) => CONCISE_CAMERA_CUE.test(clause))
  const camera = cameraIndex >= 0 ? clauses[cameraIndex] : ''
  const endingClauses = clauses.filter((clause) => /^(?:结尾|最终|尾帧)|不再重复/u.test(clause))
  const action = clauses
    .filter((_clause, index) => index !== cameraIndex)
    .filter((clause) => !NO_VIDEO_DIALOGUE.test(clause))
    .filter((clause) => !endingClauses.includes(clause))
    .join('。')
  return {
    camera,
    action,
    ending: endingClauses.map((clause) => clause.replace(/^(?:结尾|最终|尾帧)[：:]?/u, '')).join('；'),
  }
}

const SEMI_REALISTIC_PERFORMANCE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/明显愣住|愣了一下|愣住/gu, '目光短暂停住，眉间轻微收紧，面部幅度克制'],
  [/瞪大(?:了)?眼睛|眼睛(?:瞬间|猛地|骤然)?睁大/gu, '眼神骤然定住，内眉轻抬，眼眶大小保持不变'],
  [/张大(?:了)?嘴(?:巴)?/gu, '嘴唇微张，嘴型大小保持自然'],
  [/咧嘴(?:大笑|笑)/gu, '嘴角轻微上扬'],
  [/嘴角带笑/gu, '嘴角轻微上扬'],
  [/哈哈大笑/gu, '短促笑出声，面部肌肉保持克制'],
  [/大喊/gu, '提高音量呼喊，嘴型自然不过度张开'],
  [/尖叫/gu, '发出短促高声，嘴型自然不过度张开'],
]

function normalizeSemiRealisticPerformanceCues(value: string, visualStyle: VisualStyle) {
  if (visualStyle !== VisualStyle.anime_3d) return value
  return value.split(/(“[^”]*”|"[^"\n]*")/gu).map((part, index) => {
    if (index % 2 === 1) return part
    return SEMI_REALISTIC_PERFORMANCE_REPLACEMENTS.reduce(
      (result, [pattern, replacement]) => result.replace(pattern, replacement),
      part,
    )
  }).join('')
}

function conciseStructuredTimeline(value: string, maximum: number, characterNames: string[] = []) {
  return canonicalizeStoryboardCharacterNames(naturalizeStoryboardTimeline(value, {
    maximumCharacters: maximum,
    maximumCharactersPerSegment: 180,
  }), characterNames)
}

function conciseStructuredPeople(input: {
  people: string
  timeline: string
  visualStyle: VisualStyle
  references: Array<{
    referenceOrder: number
    type: AssetType | 'continuity'
    name: string
    continuityMode?: ContinuityReferenceMode
  }>
}) {
  const characterReferences = input.references.filter((reference) => reference.type === AssetType.character)
  const characterNames = characterReferences.map((reference) => reference.name)
  const mappedCharacters = characterReferences.map((reference) => (
    `@image${reference.referenceOrder}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}`
  ))
  const mappedProps = input.references.flatMap((reference) => (
    reference.type === AssetType.prop
      ? [`@image${reference.referenceOrder}=道具“${reference.name}”；全段锁定同一外形、材质、颜色、结构、内容物与使用痕迹，不得替换或重新设计。`]
      : []
  ))
  const visibleLabels = [
    ...listedTimelineCharacters(input.timeline, '镜内'),
    ...[...input.timeline.matchAll(GENERIC_TIMELINE_ROLE)].map((match) => match[0]),
  ]
  const extraCharacters = [...new Set(visibleLabels)]
    .filter((name) => name && !TIMELINE_COUNT_LABEL.test(name))
    .filter((name) => !characterNames.some((characterName) => listedNameMatchesCharacter(name, characterName)))
    .sort((left, right) => right.length - left.length)
    .filter((name, index, values) => !values.slice(0, index).some((value) => value.includes(name)))
  const initial = input.people.match(/(?:^|\n)初始位置[：:]([^\n]+)/u)?.[1]
    || ''
  const statedProps = input.people.match(/(?:^|\n)关键道具[：:]([^\n]+)/u)?.[1] || ''
  const castRule = extraCharacters.length > 0
    ? `文字角色“${extraCharacters.join('、')}”是独立人物，不得变成或复制${characterNames.join('、')}。`
    : ''
  const allCharacterNames = [...new Set([...characterNames, ...extraCharacters])]
  const required = [...mappedCharacters, ...mappedProps].join('\n')
  const optional = joinUniquePromptLines([
    characterNames.length > 0
      ? '外观硬锁：逐帧复刻各人物@image的脸型、五官比例、发型发色、年龄体型和服装；禁止重新设计、通用卡通脸、换脸或角色互换。'
      : '',
    castRule,
    allCharacterNames.length > 0
      ? `人数硬锁：全片最多${allCharacterNames.length}名唯一人物，只允许${allCharacterNames.join('、')}；不得出现第${allCharacterNames.length + 1}人、背景同学、分身或重复脸。`
      : '',
    characterNames.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
    initial ? `初始：${truncatePromptText(initial.replace(/^本段开场[：:]/u, ''), 105)}` : '',
    statedProps ? `道具：${truncatePromptText(concisePromptClauses(statedProps).slice(0, 2).join('；'), 78)}` : '',
  ])
  const optionalBudget = Math.max(70, 430 - required.length)
  return joinUniquePromptLines([
    required,
    truncatePromptText(optional, optionalBudget),
  ])
}

function conciseStructuredStyle(input: {
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  structuredStyle: string
  duration: number
  aspectRatio?: string
}) {
  const preset = getVisualStylePreset(input.visualStyle)
  const base = input.visualStyle === VisualStyle.overseas_live_action
    ? '海外真人短剧，美式真人电影感，真实演员与自然皮肤纹理；对白使用自然美式英语，声线贴合人物。'
    : input.visualStyle === VisualStyle.anime_3d
      ? '高精度半写实3D数字人电影CG，次世代游戏过场；成年真实比例与颅面骨相。真人面捕式微表情，只用眼神、内眉、下眼睑、嘴角和呼吸，眼眶嘴巴尺寸固定；禁儿童3D动画、萌系Q版、大头圆脸、圆瞪眼、张大嘴。'
      : preset.videoPrompt.split('。')[0]
  const localStyle = stripEmbeddedProjectStyleLock(input.structuredStyle)
    .split('\n')
    .filter((line) => !/(?:本段\s*\d+\s*秒|字幕|背景音乐|环境声|对白文字)/u.test(line))
    .join('；')
  return truncatePromptText([
    base,
    STRICT_VIDEO_AUDIO_RULE,
    input.customStylePrompt?.trim() ? truncatePromptText(input.customStylePrompt.trim(), 45) : '',
    localStyle ? truncatePromptText(localStyle, 48) : '',
    `${formatTimelineSecond(input.duration)}秒，${input.aspectRatio || '16:9'}；禁止字幕；实体道具文字按参考图保留。`,
  ].filter(Boolean).join('。').replace(/。{2,}/gu, '。'), 190)
}

function conciseStructuredScene(input: {
  scene: string
  references: Array<{
    referenceOrder: number
    type: AssetType | 'continuity'
    name: string
    continuityMode?: ContinuityReferenceMode
  }>
}) {
  const locations = input.references.filter((reference) => reference.type === AssetType.location)
  const mapped = locations.map((reference) => `@image${reference.referenceOrder}=${reference.name}`)
  const continuity = input.references.flatMap((reference) => (
    reference.type === 'continuity'
      ? [continuityReferenceInstruction(reference.referenceOrder, reference.continuityMode)]
      : []
  ))
  let facts = conciseStoryboardSceneFacts(
    input.scene,
    105,
    input.references
      .filter((reference) => reference.type === AssetType.character)
      .map((reference) => reference.name),
  )
  for (const location of locations) {
    facts = facts.replace(new RegExp(escapePromptPattern(location.name), 'gu'), '').trim()
  }
  facts = facts.replace(/^[，,。；;\s]+|[，,。；;\s]+$/gu, '').replace(/[，,][；;]/gu, '；')
  const fallback = locations.length === 0
    ? compactLegacyStoryboardSceneSection(input.scene)
    : ''
  return truncatePromptText([
    mapped.length > 0 ? `${mapped.join('；')}。` : '',
    ...continuity,
    locations.length === 0 ? fallback : facts,
  ].filter(Boolean).join(''), 155)
}

function compactNaturalPromptText(value: string, maximum: number) {
  const source = value.replace(/\s+/gu, ' ').trim()
  if (!source || source.length <= maximum) return source
  const candidate = source.slice(0, Math.max(1, maximum))
  const boundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('；'),
    candidate.lastIndexOf('，'),
  )
  return (boundary >= Math.floor(maximum * 0.58) ? candidate.slice(0, boundary) : candidate)
    .replace(/[，,；;：:\s]+$/gu, '')
    .trim()
}

function inferredStoredStoryboardCharacterNames(value: string) {
  const names = new Set<string>()
  const excluded = /^(?:人物|角色|本镜|本段|初始|出场|声音|关键道具|无人物|无角色)/u
  const sourceWithoutInitialLines = stripStoryboardReferenceTags(value)
    .replace(/(?:^|\n)初始位置[：:][^\n]*/gu, '')
  const addCandidate = (value: string) => {
    const name = value
      .replace(/^(?:回忆中的|画外的|镜内的)/u, '')
      .replace(/[（(【\[].*$/u, '')
      .trim()
    if (!name || excluded.test(name)) return
    const splitNames = splitPromptCharacterNames(name)
    if (splitNames.length > 1) {
      for (const splitName of splitNames) addCandidate(splitName)
      return
    }
    if (!/^(?:[\p{Script=Han}·•]{2,12}|[\p{L}][\p{L} .·•'’-]{1,39})$/u.test(name)) return
    names.add(name)
  }

  for (const fragment of sourceWithoutInitialLines.split(/[；;\n]+/u)) {
    const source = fragment.trim()
    if (!source) continue
    const declared = source.match(/^([^：:(（\n]{2,40})(?=\s*[：:(（])/u)?.[1]
    if (declared) {
      addCandidate(declared)
      continue
    }
    const leadingCast = source.match(/^(.{2,48}?)(?=保持|独自|站在|位于|坐在|走向|沿着|沿|看向|望向|面对|背对|进入|离开|抓住|扶住|躺在|跪在)/u)?.[1]
    if (!leadingCast) continue
    for (const candidate of leadingCast.split(/[、与和]/u)) addCandidate(candidate)
  }
  return [...names]
}

const BACKGROUND_CHARACTER_CUE = /背景|一旁|围观|路人|同学们|众人|人群|等待|候场|远处|画外/u

function essentialStoredStoryboardCharacterNames(
  characterNames: string[],
  timeline: string,
  maximum = 4,
) {
  const names = [...new Set(characterNames.flatMap(splitPromptCharacterNames).filter(Boolean))]
  if (names.length === 0) return names
  const foregroundTimeline = timeline
    .split(/[。；;\n]+/u)
    .filter((clause) => !BACKGROUND_CHARACTER_CUE.test(clause))
    .join('；')
  const score = (name: string, index: number) => {
    const escaped = escapePromptPattern(name)
    const speakerCount = [...timeline.matchAll(new RegExp(`${escaped}\s*[：:]`, 'gu'))].length
    const foregroundCount = [...foregroundTimeline.matchAll(new RegExp(escaped, 'gu'))].length
    const actionCount = [...foregroundTimeline.matchAll(new RegExp(
      `${escaped}[^。；;\n]{0,18}(?:说|问|答|看向|注视|怒视|抬头|低头|转身|走|抓|握|推|拉|递|接|拿|放|坐|起身|倒下|坠落|离开|进入|靠近|后退|点头|摇头)`,
      'gu',
    ))].length
    return speakerCount * 100 + actionCount * 25 + foregroundCount * 8 - index * 0.01
  }
  const ranked = names
    .map((name, index) => ({ name, score: score(name, index), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const relevant = ranked.filter((item) => item.score > 0)
  return (relevant.length > 0 ? relevant : ranked).slice(0, maximum).map((item) => item.name)
}

function omitBackgroundOnlyCharacterClauses(
  timeline: string,
  includedCharacterNames: string[],
  excludedCharacterNames: string[],
) {
  if (excludedCharacterNames.length === 0) return timeline
  return timeline.split(/\n/u).map((line) => line
    .split(/[；;]/u)
    .filter((clause) => {
      const hasExcludedCharacter = excludedCharacterNames.some((name) => clause.includes(name))
      const hasIncludedCharacter = includedCharacterNames.some((name) => clause.includes(name))
      return !(hasExcludedCharacter && !hasIncludedCharacter && BACKGROUND_CHARACTER_CUE.test(clause))
    })
    .join('；')
    .replace(/[；;]\s*([。.!?])/gu, '$1')
    .trim())
    .filter(Boolean)
    .join('\n')
}

function conciseStoredStoryboardPeople(
  value: string,
  characterNames: string[],
  visualStyle: VisualStyle,
  excludedCharacterNames: string[] = [],
) {
  const source = stripStoryboardReferenceTags(value)
  const providedNames = characterNames.flatMap(splitPromptCharacterNames).map((name) => name.trim()).filter(Boolean)
  const names = [...new Set(
    (providedNames.length > 0 ? providedNames : inferredStoredStoryboardCharacterNames(source)),
  )]
  const explicitInitial = source.match(/(?:^|\n)初始位置[：:]([^\n]+)/u)?.[1]?.trim() || ''
  const characterLock = source.split(/(?:^|\n)初始位置[：:]/u)[0]?.trim() || ''
  const explicitInitialNames = inferredStoredStoryboardCharacterNames(explicitInitial)
  const initialMatchesCast = !explicitInitial
    || names.length === 0
    || explicitInitialNames.length === 0
    || explicitInitialNames.some((name) => names.includes(name))
  const initial = initialMatchesCast && explicitInitial
    ? explicitInitial
    : !/[：:(（]/u.test(characterLock) && characterLock.length <= 190
      ? characterLock
      : ''
  const conciseInitial = initial
    .split(/[；;\n]+/u)
    .filter((clause) => !(
      BACKGROUND_CHARACTER_CUE.test(clause)
      && excludedCharacterNames.some((name) => clause.includes(name))
    ))
    .join('；')
  const voices = names.map((name) => (
    `${name}固定声音：${buildCharacterVoiceProfile(name, visualStyle)}`
  ))
  return [
    voices.join('\n'),
    names.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
    conciseInitial ? `初始位置：${compactNaturalPromptText(conciseInitial, 190)}` : '',
  ].filter(Boolean).join('\n') || '本段无人物入镜。'
}

export function buildNaturalStoryboardPrompt(input: {
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  style: string
  people: string
  scene: string
  detailedTimeline: string
  duration: number
  aspectRatio?: string
  characterNames?: string[]
}) {
  const allCharacterNames = [...new Set([
    ...(input.characterNames || []).flatMap(splitPromptCharacterNames),
    ...inferredStoredStoryboardCharacterNames(input.people),
  ])]
  const characterNames = essentialStoredStoryboardCharacterNames(
    allCharacterNames,
    input.detailedTimeline,
  )
  const excludedCharacterNames = allCharacterNames.filter((name) => !characterNames.includes(name))
  const detailedTimeline = omitBackgroundOnlyCharacterClauses(
    input.detailedTimeline,
    characterNames,
    excludedCharacterNames,
  )
  const style = conciseStructuredStyle({
    visualStyle: input.visualStyle,
    customStylePrompt: input.customStylePrompt,
    structuredStyle: input.style,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
  })
  const people = conciseStoredStoryboardPeople(
    input.people,
    characterNames,
    input.visualStyle,
    excludedCharacterNames,
  )
  const scene = conciseStoryboardSceneFacts(input.scene, 220, characterNames)
    || compactNaturalPromptText(compactLegacyStoryboardSceneSection(input.scene), 220)
    || '使用当前分镜的静态环境。'
  const timelineSegments = parseStoryboardTimelineSegments(detailedTimeline)
  const timeline = canonicalizeStoryboardCharacterNames(naturalizeStoryboardTimeline(detailedTimeline, {
    maximumCharactersPerSegment: 150,
    maximumCharacters: Math.max(150, timelineSegments.length * 151),
  }), characterNames)
  return [
    '【风格基调】',
    style,
    '【本分镜人物】',
    people,
    '【场景】',
    scene,
    '【视频分镜】',
    timeline,
  ].join('\n')
}

export function simplifyStoredStoryboardPrompt(input: {
  videoPrompt: string
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  duration: number
  aspectRatio?: string
  characterNames?: string[]
}) {
  const structured = parseStructuredStoryboardPrompt(input.videoPrompt)
  if (!structured) return input.videoPrompt
  return buildNaturalStoryboardPrompt({
    visualStyle: input.visualStyle,
    customStylePrompt: input.customStylePrompt,
    style: structured.style,
    people: structured.people,
    scene: structured.scene,
    detailedTimeline: structured.timeline,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    characterNames: input.characterNames,
  })
}

function buildConciseStructuredVideoPrompt(input: {
  structured: StructuredStoryboardPrompt
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  maxLength: number
  duration: number
  aspectRatio?: string
  references: Array<{
    referenceOrder: number
    type: AssetType | 'continuity'
    name: string
    continuityMode?: ContinuityReferenceMode
  }>
}) {
  const performanceTimeline = normalizeSemiRealisticPerformanceCues(
    input.structured.timeline,
    input.visualStyle,
  )
  const style = conciseStructuredStyle({
    visualStyle: input.visualStyle,
    customStylePrompt: input.customStylePrompt,
    structuredStyle: input.structured.style,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
  })
  const people = conciseStructuredPeople({
    people: stripStoryboardReferenceTags(input.structured.people),
    timeline: stripStoryboardReferenceTags(performanceTimeline),
    visualStyle: input.visualStyle,
    references: input.references,
  })
  const scene = conciseStructuredScene({
    scene: stripStoryboardReferenceTags(input.structured.scene),
    references: input.references,
  })
  const header = [
    '【风格基调】',
    style,
    '【本分镜人物】',
    people || '本段无人物入镜。',
    '【场景】',
    scene || '使用当前分镜的静态环境。',
    '【视频分镜】',
  ].join('\n')
  const timelineBudget = Math.max(220, input.maxLength - header.length - 1)
  const timelineCharacterNames = [...new Set([
    ...input.references
      .filter((reference) => reference.type === AssetType.character)
      .map((reference) => reference.name),
    ...[...performanceTimeline.matchAll(GENERIC_TIMELINE_ROLE)].map((match) => match[0]),
  ])]
  const timeline = conciseStructuredTimeline(
    performanceTimeline,
    timelineBudget,
    timelineCharacterNames,
  )
  return truncatePromptText(`${header}\n${timeline}`, input.maxLength)
}

export function buildStoryboardVideoPrompt(input: {
  title: string
  videoPrompt: string
  scriptSceneContext?: string | null
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  maxLength?: number
  duration?: number
  aspectRatio?: string
  knownCharacterNames?: string[]
  references: Array<{
    referenceOrder: number
    type: AssetType | 'continuity'
    name: string
    continuityMode?: ContinuityReferenceMode
  }>
}) {
  const references = input.references
  const hasLocationReference = references.some((reference) => reference.type === AssetType.location)
  const continuityMode = references.find((reference) => reference.type === 'continuity')?.continuityMode
    ?? (references.some((reference) => reference.type === 'continuity') ? 'spatial' : null)
  const normalizedVideoPrompt = normalizeOffscreenDialogueCues(normalizeMissingLocationReference(
    input.videoPrompt,
    hasLocationReference ? null : continuityMode || 'text',
  ))
  const unstructuredCharacterReferenceLines = references.flatMap((reference) => (
    reference.type === AssetType.character
      ? [`@image${reference.referenceOrder}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}`]
      : []
  ))
  const unstructuredSceneReferenceLines = references.flatMap((reference) => (
    reference.type === AssetType.location
      ? [`@image${reference.referenceOrder}=场景“${reference.name}”`]
      : reference.type === 'continuity'
        ? [continuityReferenceInstruction(reference.referenceOrder, reference.continuityMode)]
        : []
  ))
  const unstructuredPropReferenceLines = references.flatMap((reference) => (
    reference.type === AssetType.prop
      ? [`@image${reference.referenceOrder}=道具“${reference.name}”；锁定同一外形、材质、颜色、结构、内容物与使用痕迹，禁止替换或重新设计。`]
      : []
  ))
  const maxLength = Math.max(600, input.maxLength || 4900)
  const compactForProvider = maxLength <= 1400
  const contextLimit = maxLength <= 5000 ? 480 : 1000
  const scriptSceneContext = input.scriptSceneContext?.trim().slice(0, contextLimit)
  const styleLock = truncatePromptText(
    buildStyleLock(input.visualStyle, input.customStylePrompt, 'video'),
    maxLength <= 5000 ? 620 : 1400,
  )
  const structured = parseStructuredStoryboardPrompt(normalizedVideoPrompt)
  if (structured) {
    const timelineDuration = structuredTimelineDuration(structured.timeline)
    const outputDuration = Math.max(timelineDuration, input.duration || timelineDuration)
    if (compactForProvider) {
      return buildConciseStructuredVideoPrompt({
        structured,
        visualStyle: input.visualStyle,
        customStylePrompt: input.customStylePrompt,
        maxLength,
        duration: outputDuration,
        aspectRatio: input.aspectRatio,
        references,
      })
    }
    const characterNames = references
      .filter((reference) => reference.type === AssetType.character)
      .map((reference) => reference.name)
    const characterReferences = references.flatMap((reference) => (
      reference.type === AssetType.character
        ? [compactForProvider
          ? `@image${reference.referenceOrder}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}；外观锁定。`
          : `@image${reference.referenceOrder}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}；全段保持同一面容、年龄、发型、体态和服装。`]
        : []
    ))
    const continuityReferences = references.flatMap((reference) => (
      reference.type === 'continuity'
        ? [continuityReferenceInstruction(reference.referenceOrder, reference.continuityMode)]
        : []
    ))
    const characterIdentityRule = characterReferences.length > 0
      ? buildCharacterCardinalityRule(characterNames, compactForProvider)
      : ''
    const knownCharacterNames = [...new Set([...(input.knownCharacterNames || []), ...characterNames])]
    const irreversibleActionRule = buildIrreversibleActionOwnershipRule(
      structured.timeline,
      knownCharacterNames,
      compactForProvider,
    )
    const humanFormRule = input.visualStyle === VisualStyle.overseas_live_action
      ? compactForProvider
        ? '真人形态锁：狼族/Alpha/Luna/长老默认都是完整人类演员；未明确变身时禁止狼头、兽耳、长吻、兽毛和兽爪。白狼虚影不得替换真人。'
        : '真人形态锁：狼族、Alpha、Luna、王族和长老只表示身份。除非当前时间段逐字写明变身或狼形，所有角色必须保持完整真人演员、人类面孔皮肤和正常四肢；禁止狼头人身、兽耳、长吻、全身兽毛、兽爪或四足姿态。白狼虚影只能是与真人分离的半透明特效，不得替换、包裹或变成角色本人。'
      : ''
    const locationReferences = references.flatMap((reference) => (
      reference.type === AssetType.location
        ? [compactForProvider
          ? `@image${reference.referenceOrder}：场景“${reference.name}”，空间锁定。`
          : `@image${reference.referenceOrder} 是场景“${reference.name}”，只锁定空间结构、固定陈设、材质和基础光源。`]
        : []
    ))
    const propReferences = references.flatMap((reference) => (
      reference.type === AssetType.prop
        ? [`@image${reference.referenceOrder}=道具“${reference.name}”；全段逐帧保持同一外形、材质、颜色、结构、内容物和使用痕迹，不得换成其他容器或重新设计。`]
        : []
    ))
    const structuredStyle = stripEmbeddedProjectStyleLock(
      stripStoryboardReferenceTags(structured.style),
    ).split('\n').filter((line) => !/(?:背景音乐|BGM|配乐)/iu.test(line)).join('\n')
    const style = compactForProvider
      ? truncatePromptText(joinUniquePromptLines([
          styleLock.split('\n')[0],
          input.visualStyle === VisualStyle.overseas_live_action
            ? '对白和旁白必须使用自然美式英语；同一角色跨分镜保持相同音色。'
            : truncatePromptText(styleLock, 70),
          humanFormRule,
          truncatePromptText(structuredStyle, 40),
        ]), 260)
      : truncatePromptText(joinUniquePromptLines([styleLock, structuredStyle, STRICT_VIDEO_AUDIO_RULE]), 760)
    const structuredPeople = retainReferencedCharacterDeclarations(
      stripStoryboardReferenceTags(structured.people),
      [...new Set([...(input.knownCharacterNames || []), ...characterNames])],
      characterNames,
    )
    const people = compactForProvider
      ? truncatePromptText(joinUniquePromptLines([
          ...characterReferences,
          ...propReferences,
          ...references.flatMap((reference) => {
            if (reference.type !== AssetType.character) return []
            const line = structuredPeople
              .split('\n')
              .find((candidate) => candidate.includes(reference.name))
            return line ? [truncatePromptText(line, 88)] : []
          }),
          characterIdentityRule,
          characterNames.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
          irreversibleActionRule,
        ]), 430)
      : truncatePromptText(joinUniquePromptLines([
          ...characterReferences,
          ...propReferences,
          ...structuredPeople.split('\n').filter((line) => /^(?:初始位置|关键道具|道具)[：:]/u.test(line.trim())),
          characterIdentityRule,
          characterNames.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
          irreversibleActionRule,
        ]), 1500)
    const locationName = references.find((reference) => reference.type === AssetType.location)?.name || ''
    const sceneGeometryRule = locationName
      ? compactForProvider
        ? `空间锁：全段只使用“${locationName}”，保持高度关系、边缘、地面和背景方位；不得替换成庭院、舞台、石台或科幻空间。`
        : `场景物理空间锁：全段只使用 @image 对应的“${locationName}”。保持参考图中的空间结构、地面/边缘、高低层级、背景方向和光源方向；不得替换为庭院、舞台、竞技场、规则石台、科幻建筑或其他相似空间。人物位于边缘、上方、下方、室内、室外或水下的关系不得颠倒。`
      : ''
    const scene = truncatePromptText(joinUniquePromptLines([
      ...locationReferences,
      ...continuityReferences,
      compactLegacyStoryboardSceneSection(
        stripStoryboardReferenceTags(structured.scene),
        locationName,
      ),
      sceneGeometryRule,
    ]), compactForProvider ? 180 : 820)
    const header = [
      '【风格基调】',
      style,
      outputDuration ? `剧情时间轴：${formatTimelineSecond(timelineDuration || outputDuration)}秒；成片时长：${formatTimelineSecond(outputDuration)}秒；画幅比例：${input.aspectRatio || '16:9'}。` : '',
      '【本分镜人物】',
      people || '本段无人物入镜。',
      '【场景】',
      scene || '严格沿用当前分镜的唯一标准场景，不得替换、拼接或擅自转场。',
      '【视频分镜】',
    ].filter(Boolean).join('\n')
    const hold = outputDuration > timelineDuration && timelineDuration > 0
      ? compactForProvider
        ? `\n${formatTimelineSecond(timelineDuration)}~${formatTimelineSecond(outputDuration)}s：保持尾帧，不新增动作或对白。`
        : `\n${formatTimelineSecond(timelineDuration)}~${formatTimelineSecond(outputDuration)}s：剧情已结束，只保持最后尾帧、环境声和自然呼吸，不新增动作、对白、人物或场景。`
      : ''
    const timelineBudget = Math.max(100, maxLength - header.length - hold.length - 1)
    const normalizedTimeline = naturalizeStoryboardTimeline(normalizeCharacterRelativeCamera(
      stripStoryboardReferenceTags(normalizeSemiRealisticPerformanceCues(
        structured.timeline,
        input.visualStyle,
      )),
      characterNames,
    ), {
      maximumCharacters: timelineBudget,
      maximumCharactersPerSegment: 150,
    })
    return truncatePromptText(
      `${header}\n${normalizedTimeline}${hold}`,
      maxLength,
    )
  }
  const unstructuredCharacterNames = references
    .filter((reference) => reference.type === AssetType.character)
    .map((reference) => reference.name)
  const unstructuredActionRule = buildIrreversibleActionOwnershipRule(
    normalizedVideoPrompt,
    [...new Set([...(input.knownCharacterNames || []), ...unstructuredCharacterNames])],
    compactForProvider,
  )
  const unstructuredHumanRule = input.visualStyle === VisualStyle.overseas_live_action
    ? '真人形态锁：狼族/Alpha/Luna/长老未明确变身时保持完整人类演员外观，禁止狼头人身、兽耳、长吻、兽毛和兽爪。'
    : ''
  const header = (compactForProvider ? [
    '【风格基调】',
    truncatePromptText(styleLock, 180),
    input.duration ? `时长：${formatTimelineSecond(input.duration)}秒` : '',
    input.aspectRatio ? `画幅：${input.aspectRatio}` : '',
    STRICT_VIDEO_AUDIO_RULE,
    '【本分镜人物】',
    ...(unstructuredCharacterReferenceLines.length > 0 ? unstructuredCharacterReferenceLines : ['本段无人物入镜。']),
    unstructuredCharacterReferenceLines.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
    '人物锁定：对应 @imageN 是唯一外观依据，逐帧复刻脸型、五官比例、发型发色、年龄体型和服装，文字冲突时以图为准；禁止重新设计成通用卡通脸、分身、换脸、替身、镜像和背景重复人像，画外角色不得自动入镜。',
    unstructuredHumanRule,
    unstructuredActionRule,
    ...(unstructuredPropReferenceLines.length > 0 ? ['【关键道具】', ...unstructuredPropReferenceLines] : []),
    '【场景】',
    ...unstructuredSceneReferenceLines,
    `场景：${truncatePromptText(scriptSceneContext || '沿用分镜标准场景。', 120)}`,
    '连续性：人物脸型、服装、站位、左右手、道具和场景光线稳定；动作按顺序执行；无字幕、无水印。',
    '【视频分镜】',
  ] : [
    '【风格基调】',
    input.duration ? `镜头时长：${formatTimelineSecond(input.duration)}秒` : '',
    input.aspectRatio ? `画幅比例：${input.aspectRatio}` : '',
    styleLock,
    STRICT_VIDEO_AUDIO_RULE,
    '【本分镜人物】',
    ...(unstructuredCharacterReferenceLines.length > 0 ? unstructuredCharacterReferenceLines : ['本段无人物入镜。']),
    unstructuredCharacterReferenceLines.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
    '引用规则：提示词中的角色、场景和关键道具分别使用上方对应的 @imageN。人物参考图是唯一视觉依据；后文的年龄、脸型、发型、体态或服装若与图冲突，一律以图为准。角色设定卡的正面、侧面、背面和面部特写只代表同一人，忽略卡片文字、色板、标尺和排版；不得复制、替换人物。关键道具必须复刻对应参考图，禁止更换材质、结构或内容物。',
    unstructuredHumanRule,
    buildCharacterCardinalityRule(unstructuredCharacterNames, false),
    unstructuredActionRule,
    ...(unstructuredPropReferenceLines.length > 0 ? ['【关键道具】', ...unstructuredPropReferenceLines] : []),
    '【场景】',
    ...unstructuredSceneReferenceLines,
    `场景锚点：${scriptSceneContext || '沿用当前分镜的准确地点，不得替换、拼接或擅自转场。'}`,
    '连续性与动作安全：脸型、发型、服装、站位、左右手、道具归属、场景布局和光线连续；动作逐步执行，一次一个主要动作，接触点和持握手唯一，双脚不滑移，肢体、衣物、头发和物体不穿透；无字幕、无水印、无 UI。',
    '【视频分镜】',
  ]).filter(Boolean).join('\n')
  const contentBudget = Math.max(100, maxLength - header.length - 2)
  const videoPrompt = compactStoryboardVideoCore(stripStoryboardReferenceTags(
    normalizeSemiRealisticPerformanceCues(normalizedVideoPrompt, input.visualStyle),
  ), contentBudget)
  return truncatePromptText(`${header}\n${videoPrompt}`, maxLength)
}

export function buildCombinedStoryboardVideoPrompt(input: {
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  maxLength?: number
  aspectRatio?: string
  outputDuration?: number
  references: Array<{
    referenceOrder: number
    type: AssetType
    name: string
  }>
  characterNames?: string[]
  storyboards: Array<{
    title: string
    duration: number
    videoPrompt: string
    scriptSceneContext?: string | null
  }>
}) {
  const maxLength = Math.max(700, input.maxLength || 12000)
  const compactForProvider = maxLength <= 1400
  const totalDuration = input.storyboards.reduce((total, storyboard) => total + storyboard.duration, 0)
  const references = input.references
  const characterNames = [...new Set([
    ...(input.characterNames || []),
    ...references
      .filter((reference) => reference.type === AssetType.character)
      .map((reference) => reference.name),
  ].map(plainPromptCharacterName).filter(Boolean))]
  const styleLock = truncatePromptText(
    stripStoryboardReferenceTags(buildStyleLock(input.visualStyle, input.customStylePrompt, 'video')),
    compactForProvider ? 180 : maxLength <= 5000 ? 620 : 1400,
  )
  const characterLines = references.flatMap((reference, index) => (
      reference.type === AssetType.character
        ? [compactForProvider
        ? `@image${index + 1}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}；逐帧复刻面容五官、发型体型和服装。`
        : `@image${index + 1}=${reference.name}（单人正面全身，唯一人物）；固定声音：${buildCharacterVoiceProfile(reference.name, input.visualStyle)}；初始站位按视频时间轴第一段首帧执行，逐帧复刻参考图中的脸型、五官比例、发型发色、年龄体型和服装。`]
      : []
  ))
  const locationLines = references.flatMap((reference, index) => (
    reference.type === AssetType.location
      ? [compactForProvider
        ? `@image${index + 1}：场景“${reference.name}”，锁定空间和光线。`
        : `@image${index + 1} 是场景“${reference.name}”；只锁定该场景的空间结构、固定陈设、材质和基础光源，不把参考图中的文字或人物带入视频。`]
      : []
  ))
  const propLines = references.flatMap((reference, index) => (
    reference.type === AssetType.prop
      ? [`@image${index + 1}=道具“${reference.name}”；跨分镜锁定同一外形、材质、颜色、结构、内容物和使用痕迹，不得替换或重新设计。`]
      : []
  ))
  const structuredPrompts = input.storyboards.map((storyboard) => (
    parseStructuredStoryboardPrompt(storyboard.videoPrompt)
  ))
  const peopleDetails = structuredPrompts[0]?.people
    ? canonicalizeStoryboardCharacterNames(
      dedupeStructuredCharacterDeclarations(
        stripStoryboardReferenceTags(structuredPrompts[0].people),
        characterNames,
      ),
      characterNames,
    )
    : ''
  const mappedCharacterNames = references
    .filter((reference) => reference.type === AssetType.character)
    .map((reference) => plainPromptCharacterName(reference.name))
  const continuousCharacterNames = characterNames.filter((characterName) => {
    const shortName = characterName.split('·')[0] || characterName
    return input.storyboards.filter((storyboard) => (
      storyboard.videoPrompt.includes(characterName)
      || storyboard.videoPrompt.includes(shortName)
    )).length > 1
  })
  const continuousCharacterRule = continuousCharacterNames.length > 0
    ? `跨分镜身份连续：${continuousCharacterNames.join('、')}在前后分镜及场景切换中始终是同一名演员，面容和服装身份不得重置，也不得改成其他角色。`
    : ''
  const characterIdentityRule = mappedCharacterNames.length > 0
    ? `${buildCharacterCardinalityRule(mappedCharacterNames, compactForProvider)} ${continuousCharacterRule} 人物图片只在本节绑定一次；后续不得再次出现人物 @image 映射。后文人名必须逐字使用上述标准全名，禁止简称、代词换人或把一个角色的动作转移给另一个角色。此处建立身份映射，不表示所有角色在0秒同时入镜。`
    : ''
  const outputDuration = Math.max(totalDuration, input.outputDuration || totalDuration)
  let sceneCursor = 0
  const timedScenes = input.storyboards.map((storyboard, index) => {
    const start = sceneCursor
    sceneCursor += storyboard.duration
    const structuredScene = structuredPrompts[index]?.scene
      ? compactLegacyStoryboardSceneSection(
        stripStoryboardReferenceTags(structuredPrompts[index]?.scene || ''),
        '',
      )
      : ''
    const scene = structuredScene || '严格使用该分镜已保存的标准场景，不与前后场景混合。'
    return `${formatTimelineSecond(start)}~${formatTimelineSecond(sceneCursor)}s｜镜头${index + 1}《${storyboard.title}》：${truncatePromptText(scene, compactForProvider ? 100 : 320)}`
  })
  const header = [
    '【风格基调】',
    styleLock,
    `剧情时间轴：${formatTimelineSecond(totalDuration)}秒；成片时长：${formatTimelineSecond(outputDuration)}秒。`,
    `画幅比例：${input.aspectRatio || '16:9'}`,
    compactForProvider
      ? `共 ${input.storyboards.length} 个相邻分镜，可跨场景，按时间顺序直接剪辑。`
      : `节奏：共 ${input.storyboards.length} 个同集相邻分镜，可来自不同场景；严格按原始秒数依次推进，不压缩、不拉伸、不倒序。每次场景变化只在对应时间点直接剪辑，前一空间必须完全退出后再出现后一空间。`,
    compactForProvider
      ? '不要字幕；保留对白与环境音。同场景内保持连续；跨场景时直接剪辑，不混合空间。'
      : '不要字幕，保留现场对白、环境声和必要音效。同一场景内，前一镜尾帧成为后一镜首帧，脸型、服装、站位、左右手、道具归属、陈设和光线连续；切换到不同场景时使用干净直接剪辑，旧场景人物与陈设完全退出，禁止叠加、融合或同时出现两个空间。动作一次一个，接触点唯一，双脚不滑移，避免人物复制、面容漂移、肢体或衣物穿透、道具漂浮和背景跳变。',
    STRICT_VIDEO_AUDIO_RULE,
    '【本分镜人物】',
    ...(characterLines.length > 0 ? characterLines : ['本段无人物入镜。']),
    characterLines.length > 0 ? CHARACTER_VOICE_LOCK_RULE : '',
    characterIdentityRule,
    ...peopleDetails.split('\n').filter((line) => /^(?:初始位置|关键道具|道具)[：:]/u.test(line.trim())),
    ...(propLines.length > 0 ? ['【关键道具】', ...propLines] : []),
    '【场景】',
    ...(locationLines.length > 0 ? locationLines : ['各时间段严格采用对应分镜的标准地点。']),
    ...timedScenes,
    '【视频分镜】',
  ].filter(Boolean).join('\n')

  let cursor = 0
  const timeline = input.storyboards.map((storyboard, index) => {
    const start = cursor
    cursor += storyboard.duration
    const structured = structuredPrompts[index]
    if (structured) return canonicalizeStoryboardCharacterNames(rebaseStructuredTimeline(
      naturalizeStoryboardTimeline(stripStoryboardReferenceTags(normalizeSemiRealisticPerformanceCues(
        structured.timeline,
        input.visualStyle,
      )), {
        maximumCharactersPerSegment: 150,
      }),
      start,
    ), characterNames)
    const core = canonicalizeStoryboardCharacterNames(stripStoryboardReferenceTags(
      compactStoryboardVideoCore(storyboard.videoPrompt, 1200),
    ), characterNames)
      .replace(/^(?:镜头时长|画幅比例)：[^\n]*(?:\n|$)/gmu, '')
      .trim()
    return `${formatTimelineSecond(start)}~${formatTimelineSecond(cursor)}s：镜头${index + 1}《${storyboard.title}》\n${core}`
  }).join('\n\n')
  const hold = outputDuration > totalDuration
    ? compactForProvider
      ? `\n${formatTimelineSecond(totalDuration)}~${formatTimelineSecond(outputDuration)}s：保持尾帧，不新增动作或对白。`
      : `\n${formatTimelineSecond(totalDuration)}~${formatTimelineSecond(outputDuration)}s：剧情已结束，只保持最后尾帧、环境声和自然呼吸，不新增动作、对白、人物或场景。`
    : ''
  const timelineBudget = Math.max(120, maxLength - header.length - hold.length - 1)
  return truncatePromptText(`${header}\n${truncatePromptText(timeline, timelineBudget)}${hold}`, maxLength)
}

const VIDEO_PROMPT_SECTION_WEIGHTS: Record<string, number> = {
  镜头时长: 1,
  画幅比例: 1,
  时间地点: 2,
  接续上一镜尾帧: 3,
  人物锁定: 3,
  道具锁定: 2,
  环境锁定: 2,
  照明锁定: 1,
  场景连续性: 3,
  景别运镜: 3,
  首帧: 3,
  动作顺序: 5,
  动作物理: 5,
  画面描述: 5,
  动作对白: 5,
  对白声音: 2,
  配音要求: 2,
  声音设计: 1,
  尾帧: 3,
  尾帧衔接: 3,
  镜间衔接: 2,
  禁止项: 4,
}

const VIDEO_PROMPT_HEADING_ALIASES: Record<string, string> = {
  景别机位运动: '景别运镜',
  首帧画面: '首帧',
  动作与物理约束: '动作物理',
  画面内容: '画面描述',
  尾帧画面: '尾帧',
}

const VIDEO_PROMPT_SECTION_ORDER = [
  '镜头时长',
  '画幅比例',
  '时间地点',
  '接续上一镜尾帧',
  '人物锁定',
  '道具锁定',
  '环境锁定',
  '照明锁定',
  '场景连续性',
  '景别运镜',
  '首帧',
  '对白声音',
  '配音要求',
  '声音设计',
  '尾帧',
  '尾帧衔接',
  '镜间衔接',
  '禁止项',
  '动作对白',
  '动作顺序',
  '动作物理',
  '画面描述',
]

function formatTimelineSecond(value: number) {
  return Number(value.toFixed(2)).toString()
}

function truncatePromptText(value: string, limit: number) {
  if (value.length <= limit) return value
  const candidate = value.slice(0, Math.max(1, limit - 1))
  const boundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('；'),
    candidate.lastIndexOf('\n'),
  )
  const minimumBoundary = Math.floor(limit * 0.55)
  return `${(boundary >= minimumBoundary ? candidate.slice(0, boundary + 1) : candidate).trim()}…`
}

function stripStoryboardReferenceTags(value: string) {
  return value.replace(/@image\d+/giu, '').replace(/[ \t]{2,}/g, ' ').trim()
}

export function compactStoryboardVideoCore(value: string, maxLength: number) {
  const limit = Math.max(160, maxLength)
  const withoutBoilerplate = value
    .replace(/\n统一视觉风格锁定：[\s\S]*?(?=\n+【所有分镜默认生效的电影级参数】|\n+动作对白：|$)/u, '')
    .replace(/\n【所有分镜默认生效的电影级参数】[\s\S]*?(?=\n+(?:动作对白|动作顺序|动作与物理约束|画面内容)：|$)/u, '')
    .replace(/^【分镜[^\n]*】\s*$/gmu, '')
    .replace(/^主要动作与画面：?\s*$/gmu, '')
    .trim()
  const headingPattern = /^(镜头时长|画幅比例|时间地点|接续上一镜尾帧|人物锁定|道具锁定|环境锁定|照明锁定|场景连续性|景别机位运动|景别运镜|首帧画面|首帧|动作顺序|动作与物理约束|动作物理|画面内容|画面描述|动作对白|对白声音|配音要求|声音设计|尾帧画面|尾帧|尾帧衔接|镜间衔接|禁止项)：/gmu
  const matches = [...withoutBoilerplate.matchAll(headingPattern)]
  if (matches.length === 0) return truncatePromptText(withoutBoilerplate, limit)

  const parsedSections = matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length
    const end = matches[index + 1]?.index ?? withoutBoilerplate.length
    return {
      heading: VIDEO_PROMPT_HEADING_ALIASES[match[1]] || match[1],
      content: withoutBoilerplate.slice(start, end).trim(),
    }
  })
  const mergedSections = new Map<string, string>()
  for (const section of parsedSections) {
    if (!section.content) continue
    const current = mergedSections.get(section.heading)
    mergedSections.set(section.heading, current ? `${current}；${section.content}` : section.content)
  }
  const sections = VIDEO_PROMPT_SECTION_ORDER.flatMap((heading) => {
    const content = mergedSections.get(heading)
    return content ? [{ heading, content }] : []
  })
  const ordered = sections.map((section) => `${section.heading}：${section.content}`).join('\n')
  if (ordered.length <= limit) return ordered

  const headingCost = sections.reduce((total, section) => total + section.heading.length + 1, 0)
    + Math.max(0, sections.length - 1)
  const contentLimit = Math.max(sections.length, limit - headingCost)
  const totalWeight = sections.reduce(
    (total, section) => total + (VIDEO_PROMPT_SECTION_WEIGHTS[section.heading] || 1),
    0,
  )
  const sectionLimits = sections.map(() => 1)
  let remaining = Math.max(0, contentLimit - sections.length)
  const weightedShares = sections.map((section, index) => {
    const weight = VIDEO_PROMPT_SECTION_WEIGHTS[section.heading] || 1
    const share = remaining * weight / totalWeight
    const whole = Math.floor(share)
    sectionLimits[index] += whole
    return { index, fraction: share - whole, weight }
  })
  remaining = Math.max(0, contentLimit - sectionLimits.reduce((total, sectionLimit) => total + sectionLimit, 0))
  weightedShares
    .sort((left, right) => right.fraction - left.fraction || right.weight - left.weight || left.index - right.index)
    .slice(0, remaining)
    .forEach(({ index }) => { sectionLimits[index] += 1 })
  const compacted = sections.map((section, index) => {
    return `${section.heading}：${truncatePromptText(section.content, sectionLimits[index])}`
  }).join('\n')
  return compacted.length <= limit ? compacted : truncatePromptText(compacted, limit)
}

export async function getProjectStoryboards(projectId: string) {
  const storyboards = await prisma.storyboard.findMany({
    where: { projectId },
    include: {
      project: {
        select: { visualStyle: true, customStylePrompt: true },
      },
      episode: {
        select: { id: true, episodeNumber: true, title: true },
      },
      assetLinks: {
        include: {
          asset: {
            include: {
              selectedImage: { include: { media: true } },
            },
          },
        },
        orderBy: { referenceOrder: 'asc' },
      },
      videos: {
        include: { media: true, tailFrameMedia: true },
        orderBy: { createdAt: 'desc' },
      },
      tasks: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ sceneNumber: 'asc' }, { createdAt: 'asc' }],
  })

  return storyboards.map((storyboard) => {
    const characterLinks = storyboard.assetLinks.filter((link) => link.asset.type === AssetType.character)
    const normalizedVideoPrompt = storyboard.videoPrompt
      ? simplifyStoredStoryboardPrompt({
          videoPrompt: storyboard.videoPrompt,
          visualStyle: storyboard.project.visualStyle,
          customStylePrompt: storyboard.project.customStylePrompt,
          duration: storyboard.duration,
          aspectRatio: normalizeStoryboardAspectRatio(storyboard.aspectRatio),
          characterNames: characterLinks.map((link) => link.asset.name),
        })
      : storyboard.videoPrompt
    const visibleAssetLinks = storyboard.assetLinks.filter((link) => (
      !isExcludedStoryboardAssetLink(link.matchReason)
    ))

    return {
    id: storyboard.id,
    projectId: storyboard.projectId,
    episodeId: storyboard.episodeId,
    episodeSceneNumber: storyboard.episodeSceneNumber,
    generatedByAI: storyboard.generatedByAI,
    episode: storyboard.episode,
    title: storyboard.title,
    sceneNumber: storyboard.sceneNumber,
    notes: storyboard.notes,
    imagePrompt: storyboard.imagePrompt,
    directorPrompt: storyboard.directorPrompt || buildLegacyDirectorStoryboardPrompt({
      number: storyboard.episodeSceneNumber || storyboard.sceneNumber,
      title: storyboard.title,
      videoPrompt: normalizedVideoPrompt,
    }),
    videoPrompt: normalizedVideoPrompt,
    continuityIn: storyboard.continuityIn,
    continuityOut: storyboard.continuityOut,
    duration: storyboard.duration,
    aspectRatio: normalizeStoryboardAspectRatio(storyboard.aspectRatio),
    generateAudio: storyboard.generateAudio,
    selectedVideoId: storyboard.selectedVideoId,
    updatedAt: storyboard.updatedAt.toISOString(),
    assets: visibleAssetLinks
      .map((link, referenceIndex) => ({
      id: link.asset.id,
      name: link.asset.name,
      type: link.asset.type,
      referenceOrder: referenceIndex + 1,
      matchReason: link.matchReason,
      isManual: isManualStoryboardAssetLink(link.matchReason),
      highlightTerms: assetAliases(link.asset),
      hasSelectedImage: Boolean(link.asset.selectedImage?.media),
      imageUrl: link.asset.selectedImage?.media
        ? assetImageUrl(link.asset.selectedImage.media.id)
        : null,
      })),
    videos: storyboard.videos.map((video) => {
      const sourceStoryboardIds = video.sourceStoryboardIds?.length > 0
        ? video.sourceStoryboardIds
        : [storyboard.id]
      return {
        id: video.id,
        mediaId: video.mediaId,
        tailFrameMediaId: video.tailFrameMediaId,
        tailFrameUrl: video.tailFrameMediaId ? assetImageUrl(video.tailFrameMediaId) : null,
        name: buildStoryboardVideoDisplayName({
          customName: video.name,
          episodeNumber: storyboard.episode?.episodeNumber,
          storyboardNumber: storyboard.episodeSceneNumber || storyboard.sceneNumber,
          storyboardTitle: storyboard.title,
          sourceCount: sourceStoryboardIds.length,
          createdAt: video.createdAt,
        }),
        url: assetImageUrl(video.mediaId),
        downloadUrl: mediaDownloadUrl(video.mediaId),
        prompt: video.prompt,
        model: video.model,
        duration: video.duration,
        sourceStoryboardIds,
        aspectRatio: video.aspectRatio,
        resolution: Math.min(video.media.width || 0, video.media.height || 0) > 0
          && Math.min(video.media.width || 0, video.media.height || 0) <= 540
          ? '480p' as const
          : '720p' as const,
        isSelected: video.isSelected,
        createdAt: video.createdAt.toISOString(),
      }
    }),
    latestTask: storyboard.tasks[0]
      ? {
        id: storyboard.tasks[0].id,
        type: storyboard.tasks[0].type,
        status: storyboard.tasks[0].status,
        progress: storyboard.tasks[0].progress,
        error: storyboard.tasks[0].error,
        model: storyboard.tasks[0].model,
        storyboardId: storyboard.id,
        sourceStoryboardIds: (() => {
          const payload = storyboard.tasks[0].payload
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [storyboard.id]
          const sourceIds = (payload as Record<string, unknown>).sourceStoryboardIds
          const ids = Array.isArray(sourceIds)
            ? sourceIds.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))
            : []
          return ids.length > 0 ? ids : [storyboard.id]
        })(),
        projectId: storyboard.projectId,
        createdAt: storyboard.tasks[0].createdAt.toISOString(),
      }
      : null,
    }
  })
}

export async function getAccessibleVideoLibrary(projectIds: string[]) {
  if (projectIds.length === 0) return []
  const videos = await prisma.storyboardVideo.findMany({
    where: { storyboard: { projectId: { in: projectIds } } },
    include: {
      media: true,
      tailFrameMedia: true,
      storyboard: {
        include: {
          project: { select: { id: true, name: true } },
          episode: { select: { id: true, episodeNumber: true, title: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
  const sourceIds = [...new Set(videos.flatMap((video) => (
    video.sourceStoryboardIds.length > 0 ? video.sourceStoryboardIds : [video.storyboardId]
  )))]
  const sourceStoryboards = sourceIds.length > 0
    ? await prisma.storyboard.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, sceneNumber: true, episodeSceneNumber: true },
    })
    : []
  const sourceNumbers = new Map(sourceStoryboards.map((storyboard) => (
    [storyboard.id, storyboard.episodeSceneNumber || storyboard.sceneNumber] as const
  )))

  return videos.map((video) => {
    const storyboard = video.storyboard
    const sourceStoryboardIds = video.sourceStoryboardIds.length > 0
      ? video.sourceStoryboardIds
      : [storyboard.id]
    return {
      project: storyboard.project,
      storyboard: {
        id: storyboard.id,
        projectId: storyboard.projectId,
        episodeSceneNumber: storyboard.episodeSceneNumber,
        episode: storyboard.episode,
        title: storyboard.title,
        sceneNumber: storyboard.sceneNumber,
      },
      video: {
        id: video.id,
        mediaId: video.mediaId,
        tailFrameMediaId: video.tailFrameMediaId,
        tailFrameUrl: video.tailFrameMediaId ? assetImageUrl(video.tailFrameMediaId) : null,
        name: buildStoryboardVideoDisplayName({
          customName: video.name,
          episodeNumber: storyboard.episode?.episodeNumber,
          storyboardNumber: storyboard.episodeSceneNumber || storyboard.sceneNumber,
          storyboardTitle: storyboard.title,
          sourceCount: sourceStoryboardIds.length,
          createdAt: video.createdAt,
        }),
        url: assetImageUrl(video.mediaId),
        downloadUrl: mediaDownloadUrl(video.mediaId),
        prompt: video.prompt,
        model: video.model,
        duration: video.duration,
        sourceStoryboardIds,
        sourceStoryboardNumbers: sourceStoryboardIds
          .map((id) => sourceNumbers.get(id))
          .filter((value): value is number => typeof value === 'number'),
        aspectRatio: video.aspectRatio,
        resolution: Math.min(video.media.width || 0, video.media.height || 0) > 0
          && Math.min(video.media.width || 0, video.media.height || 0) <= 540
          ? '480p' as const
          : '720p' as const,
        isSelected: video.isSelected,
        createdAt: video.createdAt.toISOString(),
      },
    }
  })
}

import { AssetType, VisualStyle } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './db'
import { assetImageUrl } from './assets'
import { buildStyleLock } from './visual-styles'

export const storyboardAspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3'])
export const storyboardVideoResolutionSchema = z.enum(['480p', '720p'])

function normalizeStoryboardAspectRatio(value: string) {
  const parsed = storyboardAspectRatioSchema.safeParse(value)
  return parsed.success ? parsed.data : '16:9'
}

export const createStoryboardSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(8000).optional().nullable(),
  imagePrompt: z.string().trim().max(12000).optional().nullable(),
  videoPrompt: z.string().trim().min(1).max(30000),
  duration: z.coerce.number().int().min(4).max(15).default(15),
  aspectRatio: storyboardAspectRatioSchema.default('16:9'),
  generateAudio: z.boolean().default(true),
})

export const updateStoryboardSchema = createStoryboardSchema
  .omit({ projectId: true })
  .partial()

export const generateStoryboardVideoSchema = z.object({
  duration: z.coerce.number().int().min(4).max(15).optional(),
  aspectRatio: storyboardAspectRatioSchema.optional(),
  resolution: storyboardVideoResolutionSchema.optional(),
  generateAudio: z.boolean().optional(),
  model: z.string().trim().min(1).max(120).optional(),
})

export const generateStoryboardVideoGroupSchema = z.object({
  storyboardIds: z.array(z.string().min(1)).min(2).max(4)
    .refine((ids) => new Set(ids).size === ids.length, '组合分镜不能重复'),
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

  return [...aliases]
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
  limit = 4,
): StoryboardAssetMatch[] {
  const maximum = Math.max(1, Math.min(4, limit))
  const characterAssets = assets.filter((asset) => asset.type === AssetType.character)
  const locationAssets = assets.filter((asset) => asset.type === AssetType.location)
  const currentSceneText = [input.title, input.notes, input.imagePrompt, input.videoPrompt]
    .filter(Boolean)
    .join('\n')
  const characterSceneText = stripAssetAliasMentions(
    [input.title, input.imagePrompt, input.videoPrompt].filter(Boolean).join('\n'),
    locationAssets,
  )
  const characters = matchStoryboardAssets(
    characterAssets,
    characterSceneText,
    Math.max(16, characterAssets.length),
    { requireAliasMatch: true },
  )
  const promptLocations = matchStoryboardAssets(
    locationAssets,
    currentSceneText,
    Math.max(16, locationAssets.length),
  )

  let locations = promptLocations
  const script = input.script?.trim()
  if (script) {
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

  const location = locations[0]
  const characterLimit = Math.max(0, maximum - (location ? 1 : 0))
  return [...characters.slice(0, characterLimit), ...(location ? [location] : [])]
    .slice(0, maximum)
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
      episode: { select: { content: true } },
    },
  })
  if (!storyboard) throw new Error(`Storyboard not found: ${storyboardId}`)

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

  await prisma.$transaction([
    prisma.storyboardAsset.deleteMany({ where: { storyboardId } }),
    prisma.storyboardAsset.createMany({
      data: matches.map((match) => ({
        storyboardId,
        assetId: match.id,
        matchScore: match.score,
        matchReason: match.reason,
        referenceOrder: match.referenceOrder,
      })),
    }),
  ])

  return matches
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
  references: Array<{
    referenceOrder: number
    type: AssetType
    name: string
  }>
}) {
  const references = input.references.filter((reference) => reference.type !== AssetType.prop)
  const referenceLines = references.map((reference, index) => (
    reference.type === AssetType.character
      ? `@image${index + 1}：角色“${reference.name}”`
      : `@image${index + 1}：场景“${reference.name}”`
  ))
  const maxLength = Math.max(1600, input.maxLength || 4900)
  const contextLimit = maxLength <= 5000 ? 480 : 1000
  const scriptSceneContext = input.scriptSceneContext?.trim().slice(0, contextLimit)
  const styleLock = truncatePromptText(
    buildStyleLock(input.visualStyle, input.customStylePrompt, 'video'),
    maxLength <= 5000 ? 620 : 1400,
  )
  const header = [
    `剧本名称：${input.title}`,
    input.duration ? `镜头时长：${formatTimelineSecond(input.duration)}秒` : '',
    input.aspectRatio ? `画幅比例：${input.aspectRatio}` : '',
    `统一画风：${styleLock}`,
    '参考素材（顺序与 API 图片数组严格一致，只绑定人物和场景）：',
    ...referenceLines,
    '引用规则：提示词中的角色和场景分别使用上方对应的 @imageN。角色设定卡的三视图只代表同一人，忽略卡片文字、色板、标尺和排版；不得复制人物。道具不绑定参考图。',
    `场景锚点：${scriptSceneContext || '沿用当前分镜的准确地点，不得替换、拼接或擅自转场。'}`,
    '连续性与动作安全：脸型、发型、服装、站位、左右手、道具归属、场景布局和光线连续；动作逐步执行，一次一个主要动作，接触点和持握手唯一，双脚不滑移，肢体、衣物、头发和物体不穿透；无字幕、无背景音乐、无水印、无 UI。',
    '【分镜时间轴】',
  ].filter(Boolean).join('\n')
  const contentBudget = Math.max(160, maxLength - header.length - 2)
  const videoPrompt = compactStoryboardVideoCore(input.videoPrompt, contentBudget)
  return `${header}\n${videoPrompt}`
}

export function buildCombinedStoryboardVideoPrompt(input: {
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  maxLength?: number
  aspectRatio?: string
  references: Array<{
    referenceOrder: number
    type: AssetType
    name: string
  }>
  storyboards: Array<{
    title: string
    duration: number
    videoPrompt: string
    scriptSceneContext?: string | null
  }>
}) {
  const maxLength = Math.max(2400, input.maxLength || 12000)
  const totalDuration = input.storyboards.reduce((total, storyboard) => total + storyboard.duration, 0)
  const references = input.references.filter((reference) => reference.type !== AssetType.prop)
  const referenceLines = references.map((reference, index) => (
    reference.type === AssetType.character
      ? `@image${index + 1}：角色“${reference.name}”`
      : `@image${index + 1}：场景“${reference.name}”`
  ))
  const sceneContext = input.storyboards.map((storyboard, index) => {
    const context = storyboard.scriptSceneContext?.trim()
    return context ? `镜头${index + 1}：${context.slice(0, 260)}` : ''
  }).filter(Boolean).join('\n').slice(0, maxLength <= 5000 ? 760 : 1800)
  const styleLock = truncatePromptText(
    buildStyleLock(input.visualStyle, input.customStylePrompt, 'video'),
    maxLength <= 5000 ? 620 : 1400,
  )
  const header = [
    `剧本名称：${input.storyboards.map((storyboard) => storyboard.title).join(' / ')}`,
    `总时长：${formatTimelineSecond(totalDuration)}秒`,
    `画幅比例：${input.aspectRatio || '16:9'}`,
    `统一画风：${styleLock}`,
    '参考素材（顺序与 API 图片数组严格一致，只绑定人物和场景）：',
    ...referenceLines,
    '引用规则：各镜出现的角色和场景必须使用对应 @imageN。角色设定卡三视图只代表同一人，忽略卡片文字、色板、标尺和排版；不得复制人物。道具不绑定参考图。',
    sceneContext ? `剧本场景锚点：\n${sceneContext}` : '',
    `连续性：共 ${input.storyboards.length} 个同集相邻分镜，严格按时间段顺序执行，不并行、不倒序。前一镜尾帧的人物站位、朝向、神态、服装、左右手、道具归属、场景陈设和光线必须成为后一镜首帧；动作一次一个，接触点唯一，双脚不滑移，人物、衣物和物体不穿透；无字幕、无背景音乐、无水印、无 UI。`,
    '【分镜时间轴】',
  ].filter(Boolean).join('\n')

  let cursor = 0
  const timelineHeaders = input.storyboards.map((storyboard, index) => {
    const start = cursor
    cursor += storyboard.duration
    return `【${formatTimelineSecond(start)}-${formatTimelineSecond(cursor)}秒｜镜头${index + 1}：${storyboard.title}】`
  })
  const fixedTimelineCost = timelineHeaders.reduce((total, title) => total + title.length + 1, 0)
    + Math.max(0, input.storyboards.length - 1) * 2
  const availableCore = Math.max(
    input.storyboards.length * 160,
    maxLength - header.length - fixedTimelineCost - 1,
  )
  const perStoryboardBudget = Math.max(160, Math.floor(availableCore / Math.max(1, input.storyboards.length)))
  const timeline = input.storyboards.map((storyboard, index) => {
    const core = compactStoryboardVideoCore(storyboard.videoPrompt, perStoryboardBudget)
      .replace(/^(?:镜头时长|画幅比例)：[^\n]*(?:\n|$)/gmu, '')
      .trim()
    return `${timelineHeaders[index]}\n${core}`
  }).join('\n\n')
  return `${header}\n${timeline}`
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
        include: { media: true },
        orderBy: { createdAt: 'desc' },
      },
      tasks: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ sceneNumber: 'asc' }, { createdAt: 'asc' }],
  })

  return storyboards.map((storyboard) => ({
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
    videoPrompt: storyboard.videoPrompt,
    duration: storyboard.duration,
    aspectRatio: normalizeStoryboardAspectRatio(storyboard.aspectRatio),
    generateAudio: storyboard.generateAudio,
    selectedVideoId: storyboard.selectedVideoId,
    updatedAt: storyboard.updatedAt.toISOString(),
    assets: storyboard.assetLinks
      .filter((link) => link.asset.type === AssetType.character || link.asset.type === AssetType.location)
      .map((link, referenceIndex) => ({
      id: link.asset.id,
      name: link.asset.name,
      type: link.asset.type,
      referenceOrder: referenceIndex + 1,
      matchReason: link.matchReason,
      highlightTerms: assetAliases(link.asset),
      hasSelectedImage: Boolean(link.asset.selectedImage?.media),
      imageUrl: link.asset.selectedImage?.media
        ? assetImageUrl(link.asset.selectedImage.media.id)
        : null,
      })),
    videos: storyboard.videos.map((video) => ({
      id: video.id,
      mediaId: video.mediaId,
      url: assetImageUrl(video.mediaId),
      prompt: video.prompt,
      model: video.model,
      duration: video.duration,
      sourceStoryboardIds: video.sourceStoryboardIds?.length > 0
        ? video.sourceStoryboardIds
        : [storyboard.id],
      aspectRatio: video.aspectRatio,
      resolution: Math.min(video.media.width || 0, video.media.height || 0) > 0
        && Math.min(video.media.width || 0, video.media.height || 0) <= 540
        ? '480p' as const
        : '720p' as const,
      isSelected: video.isSelected,
      createdAt: video.createdAt.toISOString(),
    })),
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
  }))
}

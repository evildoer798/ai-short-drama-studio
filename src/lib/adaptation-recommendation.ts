export const MIN_EPISODE_MINUTES = 0.5
export const MAX_EPISODE_MINUTES = 3
export const MAX_RECOMMENDED_EPISODES = 60

export type AdaptationRecommendation = {
  targetEpisodeCount: number
  episodeMinutes: number
  estimatedScreenMinutes: number
  characterCount: number
  chapterCount: number
  sceneCueCount: number
  dialogueRatio: number
  capacityLimited: boolean
  reason: string
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function ceilToHalf(value: number) {
  return Math.ceil(value * 2) / 2
}

function recommendedEpisodeMinutes(totalMinutes: number) {
  if (totalMinutes <= 6) return 1
  if (totalMinutes <= 15) return 1.5
  if (totalMinutes <= 30) return 2
  if (totalMinutes <= 60) return 2.5
  return MAX_EPISODE_MINUTES
}

function isChapterHeading(line: string) {
  return /^(?:第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章节回卷幕集]|chapter\s+\d+|episode\s+\d+)(?:\s|[：:]|$)/iu.test(line)
}

function isSceneCue(line: string) {
  return /^(?:场(?:景|次)\s*\d+|(?:内景|外景|内外景)(?:\s|[｜|·.：:]|$)|(?:日|夜)\s*[｜|·.：:]|(?:INT|EXT|INT\/EXT)\.)/iu.test(line)
}

function isDialogueLine(line: string) {
  return /^[^\n：:]{1,24}[：:]/u.test(line)
    || /[“”「」『』]/u.test(line)
    || /(?:^|\s)["'][^"']{2,}["']/u.test(line)
}

export function recommendAdaptationPlan(content: string): AdaptationRecommendation | null {
  const normalized = content.replace(/\r\n?/gu, '\n').trim()
  if (normalized.length < 100) return null

  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean)
  const hanCharacters = normalized.match(/[\p{Script=Han}]/gu)?.length || 0
  const latinWords = normalized.match(/[\p{L}\p{N}]+/gu)?.filter((word) => !/[\p{Script=Han}]/u.test(word)).length || 0
  const characterCount = normalized.replace(/\s/gu, '').length
  const weightedUnits = Math.max(100, hanCharacters + latinWords * 1.6)
  const chapterCount = lines.filter(isChapterHeading).length
  const sceneCueCount = lines.filter(isSceneCue).length
  const dialogueLineCount = lines.filter(isDialogueLine).length
  const dialogueRatio = lines.length > 0 ? dialogueLineCount / lines.length : 0
  const sceneDensity = lines.length > 0 ? sceneCueCount / lines.length : 0

  // Prose can be compressed visually; dialogue-heavy or screenplay-like material needs more screen time.
  const unitsPerScreenMinute = clamp(
    760 - dialogueRatio * 260 - Math.min(120, sceneDensity * 500),
    480,
    760,
  )
  const estimatedScreenMinutes = Math.max(1, Math.round((weightedUnits / unitsPerScreenMinute) * 10) / 10)

  let episodeMinutes = recommendedEpisodeMinutes(estimatedScreenMinutes)
  let targetEpisodeCount = Math.max(1, Math.ceil(estimatedScreenMinutes / episodeMinutes))

  const chapterCapacityFits = chapterCount > 0
    && chapterCount <= MAX_RECOMMENDED_EPISODES
    && estimatedScreenMinutes <= chapterCount * MAX_EPISODE_MINUTES * 1.1
  const chapterCountNearEstimate = chapterCount > 0
    && Math.abs(chapterCount - targetEpisodeCount) / Math.max(1, targetEpisodeCount) <= 0.35
  if (chapterCapacityFits && chapterCountNearEstimate) {
    targetEpisodeCount = chapterCount
    episodeMinutes = clamp(
      ceilToHalf(estimatedScreenMinutes / chapterCount),
      MIN_EPISODE_MINUTES,
      MAX_EPISODE_MINUTES,
    )
  }

  const capacityLimited = targetEpisodeCount > MAX_RECOMMENDED_EPISODES
    || estimatedScreenMinutes > MAX_RECOMMENDED_EPISODES * MAX_EPISODE_MINUTES
  targetEpisodeCount = clamp(targetEpisodeCount, 1, MAX_RECOMMENDED_EPISODES)
  episodeMinutes = clamp(episodeMinutes, MIN_EPISODE_MINUTES, MAX_EPISODE_MINUTES)

  const structure = chapterCount > 0
    ? `识别到 ${chapterCount} 个章节标题`
    : sceneCueCount > 0
      ? `识别到 ${sceneCueCount} 个场景提示`
      : `识别到 ${lines.length} 个内容段落`
  const dialogue = dialogueRatio >= 0.35 ? '对白密集' : dialogueRatio >= 0.18 ? '对白适中' : '叙事为主'
  const capacityNote = capacityLimited ? '；内容超过当前 60 集容量，建议拆分原文' : ''

  return {
    targetEpisodeCount,
    episodeMinutes,
    estimatedScreenMinutes,
    characterCount,
    chapterCount,
    sceneCueCount,
    dialogueRatio,
    capacityLimited,
    reason: `正文约 ${characterCount.toLocaleString('zh-CN')} 字，${structure}，${dialogue}；预计适合约 ${estimatedScreenMinutes} 分钟成片${capacityNote}`,
  }
}

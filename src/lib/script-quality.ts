export const SCRIPT_COLD_OPEN_START = '【倒叙冷开场】'
export const SCRIPT_MAIN_TIMELINE_START = '【回到主线】'
export const SCRIPT_ENDING_HOOK = '【结尾Hook】'

export type ScriptQualityEpisode = {
  episodeNumber: number
  title?: string
  content: string
  sourceChunkIndexes?: number[]
}

export type TextReuseMetrics = {
  leftLength: number
  rightLength: number
  sharedShingles: number
  containment: number
  jaccard: number
  sharedSentenceCount: number
  sharedSentenceChars: number
}

export type ScriptDuplicateFinding = TextReuseMetrics & {
  leftEpisode: number
  rightEpisode: number
}

export type ScriptQualityAudit = {
  duplicatePairs: ScriptDuplicateFinding[]
  missingHooks: Array<{ episodeNumber: number; reason: string }>
  lengthIssues: Array<{
    episodeNumber: number
    characterCount: number
    minimum: number
    maximum: number
  }>
  firstEpisodeColdOpenIssue: string | null
}

function stripMarkedColdOpen(content: string) {
  const start = content.indexOf(SCRIPT_COLD_OPEN_START)
  const end = content.indexOf(SCRIPT_MAIN_TIMELINE_START, start + SCRIPT_COLD_OPEN_START.length)
  if (start < 0 || end < 0) return content
  return `${content.slice(0, start)}\n${content.slice(end + SCRIPT_MAIN_TIMELINE_START.length)}`
}

function normalizeComparableText(content: string) {
  return stripMarkedColdOpen(content)
    .replace(/^\s*【(?:第\s*\d+\s*集|场次[^】]*|回到主线|结尾Hook)】\s*$/gmu, '')
    .replace(/^\s*[^\n：:]{1,32}(?:【OS】)?[：:]\s*/gmu, '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

function normalizedSentences(content: string) {
  return stripMarkedColdOpen(content)
    .split(/[。！？!?；;\n]+/u)
    .map((sentence) => sentence
      .replace(/^\s*【[^】]+】\s*/u, '')
      .replace(/^\s*[^：:]{1,32}(?:【OS】)?[：:]\s*/u, '')
      .toLowerCase()
      .replace(/[^\p{Script=Han}a-z0-9]+/gu, ''))
    .filter((sentence) => sentence.length >= 18)
}

function textShingles(text: string, size = 10) {
  if (!text) return new Set<string>()
  if (text.length <= size) return new Set([text])
  const shingles = new Set<string>()
  for (let index = 0; index <= text.length - size; index++) {
    shingles.add(text.slice(index, index + size))
  }
  return shingles
}

export function textReuseMetrics(left: string, right: string): TextReuseMetrics {
  const normalizedLeft = normalizeComparableText(left)
  const normalizedRight = normalizeComparableText(right)
  const leftShingles = textShingles(normalizedLeft)
  const rightShingles = textShingles(normalizedRight)
  let sharedShingles = 0
  for (const shingle of leftShingles) {
    if (rightShingles.has(shingle)) sharedShingles++
  }

  const leftSentences = new Set(normalizedSentences(left))
  const rightSentences = new Set(normalizedSentences(right))
  let sharedSentenceCount = 0
  let sharedSentenceChars = 0
  for (const sentence of leftSentences) {
    if (!rightSentences.has(sentence)) continue
    sharedSentenceCount++
    sharedSentenceChars += sentence.length
  }

  const smallerSetSize = Math.min(leftShingles.size, rightShingles.size)
  const unionSize = leftShingles.size + rightShingles.size - sharedShingles
  return {
    leftLength: normalizedLeft.length,
    rightLength: normalizedRight.length,
    sharedShingles,
    containment: smallerSetSize > 0 ? sharedShingles / smallerSetSize : 0,
    jaccard: unionSize > 0 ? sharedShingles / unionSize : 0,
    sharedSentenceCount,
    sharedSentenceChars,
  }
}

export function isSuspiciousTextReuse(metrics: TextReuseMetrics) {
  if (Math.min(metrics.leftLength, metrics.rightLength) < 180) return false
  if (metrics.sharedSentenceCount >= 3 && metrics.sharedSentenceChars >= 100) return true
  if (metrics.sharedShingles >= 160 && metrics.containment >= 0.18) return true
  if (metrics.sharedShingles >= 80 && metrics.containment >= 0.32) return true
  return metrics.sharedShingles >= 120 && metrics.jaccard >= 0.16
}

export function endingHookIssue(content: string) {
  const hookIndex = content.lastIndexOf(SCRIPT_ENDING_HOOK)
  if (hookIndex < 0) return `缺少 ${SCRIPT_ENDING_HOOK}`
  if (hookIndex < Math.max(0, content.length - 700)) return `${SCRIPT_ENDING_HOOK} 未位于本集结尾`

  const hookText = content
    .slice(hookIndex + SCRIPT_ENDING_HOOK.length)
    .replace(/[（(]?本集完[）)]?/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
  if (/下集(?:预告|继续)|敬请期待|吸引(?:观众|读者)|设置悬念/u.test(hookText)) {
    return `${SCRIPT_ENDING_HOOK} 使用了说明性套话，必须改为剧情动作、对白或新信息`
  }
  if (hookText.length < 10) return `${SCRIPT_ENDING_HOOK} 内容过短`
  return null
}

export function firstEpisodeColdOpenIssue(content: string) {
  const start = content.indexOf(SCRIPT_COLD_OPEN_START)
  const end = content.indexOf(SCRIPT_MAIN_TIMELINE_START, start + SCRIPT_COLD_OPEN_START.length)
  if (start < 0) return `第一集缺少 ${SCRIPT_COLD_OPEN_START}`
  if (end < 0) return `第一集缺少 ${SCRIPT_MAIN_TIMELINE_START}`
  if (start > 500) return '倒叙冷开场没有出现在第一集最开头'
  const coldOpenLength = normalizeComparableText(content.slice(start, end)).length
  if (coldOpenLength < 45) return '倒叙冷开场过短，未形成有效危机片段'
  if (end > 1_600) return '倒叙冷开场过长，拖慢了第一集进入主线的速度'
  return null
}

export function scriptCharacterCount(content: string) {
  return content
    .replace(/【[^】]+】/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
    .length
}

export function episodeLengthBounds(episodeMinutes: number) {
  return {
    minimum: Math.max(400, Math.round(episodeMinutes * 350)),
    // The screenplay includes visible action and scene directions in addition to spoken time.
    maximum: Math.max(1_300, Math.round(episodeMinutes * 1_550)),
  }
}

export function removeRepeatedOpeningFromLaterEpisode(previousContent: string, laterContent: string) {
  const paragraphs = laterContent.split(/\n{2,}/gu).map((paragraph) => paragraph.trim()).filter(Boolean)
  if (paragraphs.length < 4) return laterContent
  const header = /^(?:\*\*)?【?场次|^(?:\*\*)?场次/u.test(paragraphs[0]) ? paragraphs[0] : null
  const startIndex = header ? 1 : 0
  const previousNormalized = normalizeComparableText(previousContent)
  let lastRepeatedIndex = -1
  let seenRepeated = false
  let unmatchedAfterRepeat = 0

  for (let index = startIndex; index < Math.min(paragraphs.length, startIndex + 40); index++) {
    const paragraph = paragraphs[index]
    if (paragraph.includes(SCRIPT_ENDING_HOOK)) break
    const normalized = normalizeComparableText(paragraph)
    if (normalized.length < 6) continue
    const metrics = textReuseMetrics(paragraph, previousContent)
    const repeated = previousNormalized.includes(normalized)
      || (normalized.length >= 12 && metrics.containment >= 0.52 && metrics.sharedShingles >= 3)
    if (repeated) {
      seenRepeated = true
      unmatchedAfterRepeat = 0
      lastRepeatedIndex = index
      continue
    }
    if (!seenRepeated) continue
    unmatchedAfterRepeat++
    if (unmatchedAfterRepeat >= 2) break
  }

  if (lastRepeatedIndex < startIndex) return laterContent
  const retained = [
    ...(header ? [header] : []),
    ...paragraphs.slice(lastRepeatedIndex + 1),
  ]
  return retained.join('\n\n')
}

export function findDuplicateEpisodes(episodes: ScriptQualityEpisode[]) {
  const findings: ScriptDuplicateFinding[] = []
  for (let leftIndex = 0; leftIndex < episodes.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < episodes.length; rightIndex++) {
      const left = episodes[leftIndex]
      const right = episodes[rightIndex]
      const metrics = textReuseMetrics(left.content, right.content)
      if (!isSuspiciousTextReuse(metrics)) continue
      findings.push({
        leftEpisode: left.episodeNumber,
        rightEpisode: right.episodeNumber,
        ...metrics,
      })
    }
  }
  return findings.sort((left, right) => (
    right.containment - left.containment
    || right.sharedSentenceChars - left.sharedSentenceChars
  ))
}

export function auditScriptEpisodes(
  episodes: ScriptQualityEpisode[],
  episodeMinutes: number,
): ScriptQualityAudit {
  const bounds = episodeLengthBounds(episodeMinutes)
  const ordered = [...episodes].sort((left, right) => left.episodeNumber - right.episodeNumber)
  return {
    duplicatePairs: findDuplicateEpisodes(ordered),
    missingHooks: ordered.flatMap((episode) => {
      const reason = endingHookIssue(episode.content)
      return reason ? [{ episodeNumber: episode.episodeNumber, reason }] : []
    }),
    lengthIssues: ordered.flatMap((episode) => {
      const characterCount = scriptCharacterCount(episode.content)
      return characterCount < bounds.minimum || characterCount > bounds.maximum
        ? [{ episodeNumber: episode.episodeNumber, characterCount, ...bounds }]
        : []
    }),
    firstEpisodeColdOpenIssue: ordered[0]?.episodeNumber === 1
      ? firstEpisodeColdOpenIssue(ordered[0].content)
      : '缺少第一集，无法检查倒叙冷开场',
  }
}

export function scriptAuditPassed(audit: ScriptQualityAudit) {
  return audit.duplicatePairs.length === 0
    && audit.missingHooks.length === 0
    && audit.lengthIssues.length === 0
    && audit.firstEpisodeColdOpenIssue === null
}

export function scriptQualityAuditScore(audit: ScriptQualityAudit) {
  const lengthDeviation = audit.lengthIssues.reduce((total, issue) => {
    const distance = issue.characterCount < issue.minimum
      ? issue.minimum - issue.characterCount
      : issue.characterCount - issue.maximum
    const baseline = Math.max(1, issue.minimum)
    return total + Math.min(50, Math.ceil((distance / baseline) * 20))
  }, 0)
  return audit.duplicatePairs.length * 1_000
    + (audit.firstEpisodeColdOpenIssue ? 500 : 0)
    + audit.missingHooks.length * 100
    + audit.lengthIssues.length * 10
    + lengthDeviation
}

export function scriptQualityAuditWarnings(audit: ScriptQualityAudit) {
  const warnings: string[] = []
  if (audit.duplicatePairs.length > 0) {
    warnings.push(`跨集重复：${audit.duplicatePairs
      .slice(0, 6)
      .map((item) => `${item.leftEpisode}-${item.rightEpisode}`)
      .join('、')}`)
  }
  if (audit.missingHooks.length > 0) {
    warnings.push(`结尾钩子待确认：第 ${audit.missingHooks.map((item) => item.episodeNumber).join('、')} 集`)
  }
  if (audit.lengthIssues.length > 0) {
    warnings.push(`篇幅待确认：第 ${audit.lengthIssues.map((item) => item.episodeNumber).join('、')} 集`)
  }
  if (audit.firstEpisodeColdOpenIssue) {
    warnings.push(`第一集开场待确认：${audit.firstEpisodeColdOpenIssue}`)
  }
  return warnings
}

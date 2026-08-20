export type StoryboardMentionAsset = {
  name: string
  type: 'character' | 'location' | 'prop'
}

export type ActiveStoryboardAssetMention = {
  start: number
  end: number
  query: string
}

const STORYBOARD_VIDEO_SECTION = '【视频分镜】'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionSection(type: StoryboardMentionAsset['type']) {
  return type === 'character' ? '【本分镜人物】' : '【场景】'
}

export function storyboardAssetMention(name: string) {
  return `@${name.trim()}`
}

export function activeStoryboardAssetMention(
  prompt: string,
  cursor: number,
): ActiveStoryboardAssetMention | null {
  const safeCursor = Math.max(0, Math.min(prompt.length, cursor))
  const prefix = prompt.slice(0, safeCursor)
  const start = prefix.lastIndexOf('@')
  if (start < 0) return null
  const previous = start > 0 ? prefix[start - 1] : ''
  if (previous && !/[\s，,；;。.!！?？:：([（【]/u.test(previous)) return null
  const query = prefix.slice(start + 1)
  if (query.length > 60 || /[@\s，,；;。.!！?？:：]/u.test(query)) return null
  return { start, end: safeCursor, query: query.trim() }
}

export function replaceActiveStoryboardAssetMention(input: {
  prompt: string
  mention: ActiveStoryboardAssetMention
  assetName: string
}) {
  const mention = storyboardAssetMention(input.assetName)
  const nextCharacter = input.prompt[input.mention.end] || ''
  const separator = !nextCharacter || !/[\s，,；;。.!！?？:：)）】]/u.test(nextCharacter)
    ? ' '
    : ''
  const prompt = `${input.prompt.slice(0, input.mention.start)}${mention}${separator}${input.prompt.slice(input.mention.end)}`
  return {
    prompt,
    cursor: input.mention.start + mention.length + separator.length,
  }
}

export function insertStoryboardAssetMention(
  prompt: string,
  asset: StoryboardMentionAsset,
) {
  const normalizedPrompt = prompt.replace(/\r\n?/gu, '\n').trim()
  const mention = storyboardAssetMention(asset.name)
  const mentionName = mention.slice(1)
  const mentionPattern = mentionName
    ? new RegExp(`@${escapeRegExp(mentionName)}(?=$|[\\s，,；;。])`, 'u')
    : null
  if (!mentionPattern || mentionPattern.test(normalizedPrompt)) return normalizedPrompt

  const section = mentionSection(asset.type)
  const sectionIndex = normalizedPrompt.indexOf(section)
  if (sectionIndex >= 0) {
    const insertionIndex = sectionIndex + section.length
    return `${normalizedPrompt.slice(0, insertionIndex)}\n${mention}${normalizedPrompt.slice(insertionIndex)}`
  }

  const block = `${section}\n${mention}`
  const videoIndex = normalizedPrompt.indexOf(STORYBOARD_VIDEO_SECTION)
  if (videoIndex >= 0) {
    return `${normalizedPrompt.slice(0, videoIndex).trimEnd()}\n${block}\n${normalizedPrompt.slice(videoIndex)}`
  }
  return [normalizedPrompt, block].filter(Boolean).join('\n')
}

export function removeStoryboardAssetMention(prompt: string, assetName: string) {
  const name = assetName.trim()
  if (!name) return prompt
  const pattern = new RegExp(`@${escapeRegExp(name)}(?=$|[\\s，,；;。])`, 'gu')
  return prompt
    .replace(pattern, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

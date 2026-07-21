type StoryboardSceneSource = {
  notes?: string | null
  videoPrompt?: string | null
}

type SceneAssetSource = {
  type: string
  name: string
}

export function storyboardPromptSection(prompt: string | null | undefined, label: string) {
  if (!prompt) return ''
  const marker = `${label}：`
  const start = prompt.indexOf(marker)
  if (start < 0) return ''
  const valueStart = start + marker.length
  const end = prompt.indexOf('\n\n', valueStart)
  return prompt.slice(valueStart, end < 0 ? undefined : end).replace(/\s+/g, ' ').trim()
}

export function storyboardTimeLocation(storyboard: StoryboardSceneSource) {
  const notesLine = storyboard.notes?.split(/\r?\n/, 1)[0]?.trim() || ''
  const promptLocation = storyboardPromptSection(storyboard.videoPrompt, '时间地点')
  return (notesLine.includes('｜') ? notesLine : promptLocation).replace(/^时间地点[:：]\s*/u, '').trim()
}

export function storyboardLocationName(storyboard: StoryboardSceneSource) {
  return storyboardLocationNames(storyboard)[0] || ''
}

export function storyboardLocationNames(storyboard: StoryboardSceneSource) {
  const timeLocation = storyboardTimeLocation(storyboard)
  return [...new Set(timeLocation
    .split(/[；;\n]+/u)
    .map((segment) => segment.split('｜').map((part) => part.trim()))
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts[1])
    .filter(Boolean))]
}

export function calculateSceneConsistency(
  storyboards: StoryboardSceneSource[],
  assets: SceneAssetSource[],
) {
  const requiredNames = [...new Set(storyboards.flatMap(storyboardLocationNames).filter(Boolean))]
  const assetNames = new Set(
    assets.filter((asset) => asset.type === 'location').map((asset) => asset.name.trim()),
  )
  const matchedNames = requiredNames.filter((name) => assetNames.has(name))
  const missingNames = requiredNames.filter((name) => !assetNames.has(name))

  return {
    total: requiredNames.length,
    matched: matchedNames.length,
    requiredNames,
    matchedNames,
    missingNames,
    exact: requiredNames.length > 0 && missingNames.length === 0,
  }
}

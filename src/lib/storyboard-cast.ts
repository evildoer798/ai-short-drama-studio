function plainCharacterName(value: string) {
  return value.replace(/[（(【\[].*$/u, '').trim()
}

function splitCharacterNames(value: string): string[] {
  const plain = plainCharacterName(value)
  if (!plain) return []
  const punctuationParts = plain.split(/[、，,]/u).map((part) => part.trim()).filter(Boolean)
  if (punctuationParts.length > 1) return punctuationParts.flatMap(splitCharacterNames)
  const relationParts = plain.split(/与/u).map((part) => part.trim()).filter(Boolean)
  if (relationParts.length > 1) return relationParts.flatMap(splitCharacterNames)
  const andParts = plain.split(/和/u).map((part) => part.trim()).filter(Boolean)
  if (andParts.length === 2 && andParts.every((part) => [...part].length >= 2)) {
    return andParts.flatMap(splitCharacterNames)
  }
  return [plain]
}

function storyboardTimeline(value: string) {
  const marker = '【视频分镜】'
  const markerIndex = value.indexOf(marker)
  return markerIndex >= 0 ? value.slice(markerIndex + marker.length).trim() : value
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
  const canonicalName = plainCharacterName(characterName)
  const shortName = canonicalName.split('·')[0]?.trim() || canonicalName
  return [canonicalName, shortName]
    .filter((name) => [...name].length >= 2)
    .some((name) => listedName === name || listedName.includes(name) || name.includes(listedName))
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const BACKGROUND_CHARACTER_CUE = /背景|一旁|围观|路人|同学们|众人|人群|等待|候场|远处|画外/u

function essentialTimelineCharacters(characterNames: string[], timeline: string, maximum = 4) {
  const names = [...new Set(characterNames.flatMap(splitCharacterNames).filter(Boolean))]
  if (names.length === 0) return names
  const foregroundTimeline = timeline
    .split(/[。；;\n]+/u)
    .filter((clause) => !BACKGROUND_CHARACTER_CUE.test(clause))
    .join('；')
  const score = (name: string, index: number) => {
    const escaped = escapePattern(name)
    const speakerCount = [...timeline.matchAll(new RegExp(`${escaped}\\s*[：:]`, 'gu'))].length
    const foregroundCount = [...foregroundTimeline.matchAll(new RegExp(escaped, 'gu'))].length
    const actionCount = [...foregroundTimeline.matchAll(new RegExp(
      `${escaped}[^。；;\\n]{0,18}(?:说|问|答|看向|注视|怒视|抬头|低头|转身|走|抓|握|推|拉|递|接|拿|放|坐|起身|倒下|坠落|离开|进入|靠近|后退|点头|摇头)`,
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

export function visibleStoryboardTimelineCharacters(input: {
  videoPrompt: string
  knownCharacterNames: string[]
  maximum?: number
}) {
  const timeline = storyboardTimeline(input.videoPrompt)
  const visible = listedTimelineCharacters(timeline, '镜内')
  const offscreen = listedTimelineCharacters(timeline, '画外')
  const knownNames = [...new Set(input.knownCharacterNames.map((name) => name.trim()).filter(Boolean))]
  const maximum = input.maximum ?? 4

  if (visible.size > 0) {
    return essentialTimelineCharacters(knownNames.filter((name) => (
      [...visible].some((listedName) => listedNameMatchesCharacter(listedName, name))
    )), timeline, maximum)
  }

  return essentialTimelineCharacters(knownNames.filter((name) => {
    const canonicalName = plainCharacterName(name)
    const shortName = canonicalName.split('·')[0]?.trim() || canonicalName
    const appears = [canonicalName, shortName]
      .filter((candidate) => [...candidate].length >= 2)
      .some((candidate) => timeline.includes(candidate))
    if (!appears) return false
    return ![...offscreen].some((listedName) => listedNameMatchesCharacter(listedName, name))
  }), timeline, maximum)
}

export function characterAppearsInStoryboardFrame(videoPrompt: string, characterName: string) {
  return visibleStoryboardTimelineCharacters({
    videoPrompt,
    knownCharacterNames: [characterName],
    maximum: 1,
  }).length === 1
}

export const STORYBOARD_TIMELINE_DETAIL_LABELS = [
  '镜头与构图',
  '动作顺序',
  '动作物理',
  '表演变化',
  '本段结束状态',
] as const

export type StoryboardTimelineDetailLabel = typeof STORYBOARD_TIMELINE_DETAIL_LABELS[number]

export type StoryboardTimelineSegment = {
  start: number
  end: number
  body: string
}

export type StoryboardTimelineDetailIssue = {
  segmentIndex: number
  range: string
  missing: StoryboardTimelineDetailLabel[]
  insufficient: StoryboardTimelineDetailLabel[]
}

type StoryboardTimelineDetailFields = Partial<Record<StoryboardTimelineDetailLabel | '对白', string>>

type FuseStoryboardTimelineInput = {
  duration: number
  timeline?: string
  camera?: string
  intent?: string
  actionOrder?: string
  actionPhysics?: string
  performance?: string
  dialogue?: string
  openingState?: string
  endingState?: string
  sceneCue?: string
  offset?: number
}

const TIMELINE_MARKER = /^(\d+(?:\.\d+)?)~(\d+(?:\.\d+)?)s[：:]\s*/gmu
const DETAIL_LABEL_PATTERN = /(镜头与构图|动作顺序|动作物理|表演变化|对白|本段结束状态)[：:]/gu
const CAMERA_LANGUAGE = /特写|近景|中近景|中景|全景|远景|俯拍|仰拍|平拍|侧拍|正面|背面|过肩|固定机位|固定镜头|跟拍|推镜|拉镜|摇镜|横移|手持|焦点|景深|构图|摄影机|镜头/iu
const NO_DIALOGUE = /^(?:无对白|全程不说话|no dialogue)[。.]?$/iu
const NATURAL_TIMELINE_NOISE = /^(?:从本段起始状态开始|按画面因果顺序|先承接本段起始姿态|随后(?:连续)?完成(?:主要)?动作|最后稳定停住|先?保持上一镜结束姿态|先?保持站位|最后停在原位置|人物完成连续动作|人物停在本段最后一个动作完成后的位置与姿态|人物位置、身体朝向、视线、接触关系和道具状态)|按顺序继续现场对白|按对白顺序自然同步口型|优先读取(?:触发后的)?面部反应|同时保留说话者口型|镜内角色|身份和位置清楚|只有一人/u
const ESSENTIAL_ENDING_ACTION = /切黑|离开画面|移出画面|离场|松手|放开|失去支撑|坠|跌|倒地|下沉|进入|走出|关门|开门/u
const NATURAL_ACTION_CUE = /走|跑|迈|停|留|转身|转向|回头|抬|低|伸|收|抓|攥|握|扶|推|拉|拽|按|压|递|接|拿|放|坐|站|跪|倒|沉|坠|看|望|扫过|点头|摇头|签|写|盖章|拍照|亲|吻|触碰|打开|关上|离开|移出|说|问|喊|回答|\b(?:walk|run|stop|turn|look|sit|stand|fall|sink|leave|close|open|say|ask)\b/iu
const NATURAL_PERFORMANCE_CUE = /表情|神情|眼神|视线|眉|嘴角|瞳孔|嘴唇|呼吸|气息|紧张|惊|错愕|困惑|震动|僵|笑|哭|警惕|坚定|尴尬|期待|纠结|释然|得意|痛苦/u
const NATURAL_INSTRUCTION_CUE = /仅允许现场|现场建筑招牌|不生成字幕|画面切黑|直接切黑|仅作画外|留在画外|不得入镜|不入镜/u
const DETAIL_MINIMUM_LENGTH: Record<StoryboardTimelineDetailLabel, number> = {
  镜头与构图: 8,
  动作顺序: 16,
  动作物理: 16,
  表演变化: 12,
  本段结束状态: 12,
}

function formatTimelineSecond(value: number) {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(2)).toString()
}

function normalizeFragment(value: string) {
  return value
    .replace(/^[\s；;，,。]+|[\s；;]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function uniqueFragments(values: Array<string | null | undefined>) {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const fragment = normalizeFragment(value || '')
    if (!fragment) continue
    const key = fragment.replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(fragment)
  }
  return output
}

function splitOrderedFragments(value: string) {
  const source = value.replace(/\r/gu, '').trim()
  if (!source) return []
  const fragments = source
    .split(/\n+|[；;。]+/gu)
    .map(normalizeFragment)
    .filter(Boolean)
  return uniqueFragments(fragments)
}

function distributeFragments(fragments: string[], count: number): string[] {
  const result = Array.from({ length: count }, () => [] as string[])
  if (count <= 0) return []
  fragments.forEach((fragment, index) => {
    const target = Math.min(count - 1, Math.floor(index * count / Math.max(1, fragments.length)))
    result[target].push(fragment)
  })
  return result.map((items) => items.join('；'))
}

function extractTimeline(value: string) {
  const section = value.match(/【视频分镜】\s*\n?([\s\S]*)$/u)?.[1]
  return (section || value).trim()
}

export function parseStoryboardTimelineSegments(value: string): StoryboardTimelineSegment[] {
  const timeline = extractTimeline(value)
  const matches = [...timeline.matchAll(TIMELINE_MARKER)]
  return matches.flatMap((match, index) => {
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    const bodyStart = (match.index || 0) + match[0].length
    const bodyEnd = matches[index + 1]?.index ?? timeline.length
    return [{ start, end, body: timeline.slice(bodyStart, bodyEnd).trim() }]
  })
}

export function parseStoryboardTimelineDetailFields(body: string) {
  const matches = [...body.matchAll(DETAIL_LABEL_PATTERN)]
  const fields: StoryboardTimelineDetailFields = {}
  matches.forEach((match, index) => {
    const label = match[1] as keyof StoryboardTimelineDetailFields
    const start = (match.index || 0) + match[0].length
    const end = matches[index + 1]?.index ?? body.length
    fields[label] = normalizeFragment(body.slice(start, end).replace(/[。]+$/u, ''))
  })
  const prefix = matches.length > 0 ? normalizeFragment(body.slice(0, matches[0].index || 0)) : ''
  return { fields, prefix }
}

function timelineDialogueEntries(value: string) {
  if (!value.trim() || NO_DIALOGUE.test(value.trim())) return []
  const marker = /(?:^|(?<=[\n；;。.!?])\s*)([\p{L}\p{N}·•.'’ _-]{1,32})(【OS】)?[：:]\s*/gmu
  const matches = [...value.matchAll(marker)]
  if (matches.length === 0) return splitOrderedFragments(value)
  return matches.flatMap((match, index) => {
    const start = match.index || 0
    const end = matches[index + 1]?.index ?? value.length
    const entry = normalizeFragment(value.slice(start, end))
    return entry && !NO_DIALOGUE.test(entry) ? [entry] : []
  })
}

function normalizedMatchText(value: string) {
  return value.replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase()
}

function assignDialogueToSegments(entries: string[], bodies: string[]) {
  const assigned = Array.from({ length: bodies.length }, () => [] as string[])
  const unassigned: string[] = []
  for (const entry of entries) {
    const quoted = entry.match(/[“"]([^”"\n]+)[”"]/u)?.[1] || entry.replace(/^[^：:]+[：:]/u, '')
    const key = normalizedMatchText(quoted)
    const matchedIndex = key
      ? bodies.findIndex((body) => normalizedMatchText(body).includes(key))
      : -1
    if (matchedIndex >= 0) assigned[matchedIndex].push(entry)
    else unassigned.push(entry)
  }
  unassigned.forEach((entry, index) => {
    assigned[Math.min(bodies.length - 1, Math.floor(index * bodies.length / Math.max(1, unassigned.length)))].push(entry)
  })
  return assigned.map((items) => items.join('；'))
}

function dialogueFromBody(body: string) {
  const quotes = [...body.matchAll(/[“"]([^”"\n]+)[”"]/gu)]
  if (quotes.length === 0) return ''
  return quotes.map((quote) => quote[0]).join('；')
}

function removeDialogueText(value: string, dialogue: string) {
  let result = value.replace(/[“"][^”"\n]+[”"]/gu, '')
  for (const entry of timelineDialogueEntries(dialogue)) {
    const spoken = entry.replace(/^[^：:]+[：:]\s*/u, '').replace(/^[“"]|[”"]$/gu, '').trim()
    if (spoken) result = result.replaceAll(spoken, '')
  }
  return normalizeFragment(result
    .replace(/([\p{L}\p{N}·•.'’ _-]{1,32})(?:语气[^，。；]*[,，]?)?(?:说|问|回答|喊|低声道|开口)[：:]?/gu, '$1')
    .replace(/[：:]\s*(?=[。；;,，]|$)/gu, ''))
}

function extractCamera(body: string, fallback: string) {
  const clauses = body
    .replace(/[“"][^”"\n]+[”"]/gu, '')
    .split(/[。；;]+/u)
    .map(normalizeFragment)
    .filter(Boolean)
  const cameraClause = clauses.find((clause) => CAMERA_LANGUAGE.test(clause)) || ''
  const cameraParts: string[] = []
  for (const part of cameraClause.split(/[，,]+/u).map(normalizeFragment).filter(Boolean)) {
    if (CAMERA_LANGUAGE.test(part)) cameraParts.push(part)
    else if (cameraParts.length > 0) break
  }
  const camera = cameraParts.join('，') || cameraClause
  return normalizeFragment(camera || fallback) || '中景固定机位，主体位置与摄影机轴线保持稳定'
}

function removeCameraClause(value: string, camera: string) {
  const exact = normalizeFragment(camera)
  if (!exact || !value.includes(exact)) return value
  return normalizeFragment(value.replace(exact, ''))
}

function concreteBody(value: string) {
  return normalizeFragment(value.replace(DETAIL_LABEL_PATTERN, ''))
}

function physicsFallback(action: string) {
  const subject = action.match(/(?:先|随后|然后|接着|最后)?\s*([\p{L}\p{N}·•.'’_-]{2,24})(?=抬|低|转|走|跑|伸|收|抓|握|扶|推|拉|坐|站|跪|倒|看|说|停|移|抿|挑|睁|前倾)/u)?.[1]
  const actor = subject ? `${subject}` : '动作执行者'
  return `${actor}沿连续可见路径完成动作，重心和关节随动作自然转移，双脚与地面保持真实接触；接触点、持握手和道具归属前后一致，不瞬移、不穿透、不滑移`
}

function finalConcreteClause(value: string) {
  const clauses = value
    .replace(/[“"][^”"\n]+[”"]/gu, '')
    .split(/[。；;]+/u)
    .map(normalizeFragment)
    .filter((clause) => clause.length >= 4 && !NO_DIALOGUE.test(clause))
  return clauses.at(-1) || ''
}

function endingFallback(action: string, performance: string, isLast: boolean) {
  const state = finalConcreteClause(performance) || finalConcreteClause(action)
  const concrete = state || '人物停在本段最后一个动作完成后的位置与姿态'
  return isLast
    ? `${concrete}；人物位置、身体朝向、视线、接触关系和道具状态固定为本镜最终尾帧`
    : `${concrete}；人物位置、身体朝向、视线、接触关系和道具状态停在此处，下一段从该状态继续`
}

function performanceFallback(intent: string, endingState: string) {
  const emotional = normalizeFragment(intent)
  if (emotional) return `人物的眼神、眉眼、呼吸和身体张力随“${emotional}”逐步变化，并自然落到本段结束状态`
  return `人物的眼神、眉眼、呼吸和身体张力随本段动作逐步变化，并自然落到“${endingState}”`
}

function fieldOrFallback(value: string | undefined, fallback: string) {
  return normalizeFragment(value || '') || normalizeFragment(fallback)
}

function ensureDetailedField(value: string, minimum: number, extension: string) {
  const normalized = normalizeFragment(value)
  if (normalizedMatchText(normalized).length >= minimum) return normalized
  return uniqueFragments([normalized, extension]).join('；')
}

export function fuseStoryboardTimelineDetails(input: FuseStoryboardTimelineInput) {
  const duration = Math.max(0.1, Number(input.duration) || 0.1)
  const parsed = parseStoryboardTimelineSegments(input.timeline || '')
  const rawSegments = parsed.length > 0
    ? parsed
    : [{ start: 0, end: duration, body: normalizeFragment(input.timeline || input.performance || '') }]
  const firstStart = rawSegments[0]?.start || 0
  const offset = Number(input.offset) || 0
  const bodies = rawSegments.map((segment) => segment.body)
  const actionParts = distributeFragments(splitOrderedFragments(input.actionOrder || ''), rawSegments.length)
  const physicsParts = distributeFragments(splitOrderedFragments(input.actionPhysics || ''), rawSegments.length)
  const performanceSource = normalizeFragment(input.performance || '')
  const timelineSource = normalizeFragment(input.timeline || '')
  const performanceParts = distributeFragments(
    performanceSource && normalizedMatchText(performanceSource) !== normalizedMatchText(timelineSource)
      ? splitOrderedFragments(performanceSource)
      : [],
    rawSegments.length,
  )
  const dialogueParts = assignDialogueToSegments(timelineDialogueEntries(input.dialogue || ''), bodies)

  return rawSegments.map((segment, index) => {
    const { fields, prefix } = parseStoryboardTimelineDetailFields(segment.body)
    const bodyWithoutLabels = concreteBody(fields['表演变化'] ? '' : segment.body)
    const bodyDialogue = fields['对白'] || dialogueParts[index] || dialogueFromBody(segment.body)
    const camera = ensureDetailedField(
      fieldOrFallback(fields['镜头与构图'], extractCamera(bodyWithoutLabels, input.camera || '')),
      DETAIL_MINIMUM_LENGTH['镜头与构图'],
      '固定机位，明确主体在画面中的位置、朝向与摄影机轴线',
    )
    const performanceBody = removeCameraClause(removeDialogueText(bodyWithoutLabels, bodyDialogue), camera)
    const action = ensureDetailedField(
      fieldOrFallback(
        fields['动作顺序'],
        actionParts[index] || performanceBody || `从${index === 0 && input.openingState ? input.openingState : '本段起始状态'}开始，按画面因果顺序连续完成本段动作`,
      ),
      DETAIL_MINIMUM_LENGTH['动作顺序'],
      '先承接本段起始姿态，随后连续完成主要动作，最后稳定停住',
    )
    const physics = ensureDetailedField(
      fieldOrFallback(fields['动作物理'], physicsParts[index] || physicsFallback(action)),
      DETAIL_MINIMUM_LENGTH['动作物理'],
      physicsFallback(action),
    )
    const isLast = index === rawSegments.length - 1
    const preliminaryEnding = fieldOrFallback(
      fields['本段结束状态'],
      isLast && input.endingState
        ? input.endingState
        : endingFallback(action, performanceBody, isLast),
    )
    const performance = ensureDetailedField(
      fieldOrFallback(
        fields['表演变化'],
        performanceParts[index] || performanceBody || performanceFallback(input.intent || '', preliminaryEnding),
      ),
      DETAIL_MINIMUM_LENGTH['表演变化'],
      performanceFallback(input.intent || '', preliminaryEnding),
    )
    const ending = ensureDetailedField(
      fieldOrFallback(
        fields['本段结束状态'],
        isLast && input.endingState ? input.endingState : endingFallback(action, performance, isLast),
      ),
      DETAIL_MINIMUM_LENGTH['本段结束状态'],
      endingFallback(action, performance, isLast),
    )
    const dialogue = bodyDialogue && !NO_DIALOGUE.test(bodyDialogue) ? bodyDialogue : '无对白'
    const start = offset + segment.start - firstStart
    const end = offset + segment.end - firstStart
    const lead = uniqueFragments([index === 0 ? input.sceneCue : '', prefix]).join('；')
    const details = [
      lead,
      `镜头与构图：${camera}`,
      `动作顺序：${action}`,
      `动作物理：${physics}`,
      `表演变化：${performance}`,
      `对白：${dialogue}`,
      `本段结束状态：${ending}`,
    ].filter(Boolean).join('；')
    return `${formatTimelineSecond(start)}~${formatTimelineSecond(end)}s：${details.replace(/[。]+$/u, '')}。`
  }).join('\n')
}

export function storyboardTimelineDetailIssues(value: string): StoryboardTimelineDetailIssue[] {
  const segments = parseStoryboardTimelineSegments(value)
  if (segments.length === 0) {
    return [{
      segmentIndex: 0,
      range: '未识别时间段',
      missing: [...STORYBOARD_TIMELINE_DETAIL_LABELS],
      insufficient: [],
    }]
  }
  return segments.flatMap((segment, index) => {
    const { fields } = parseStoryboardTimelineDetailFields(segment.body)
    const missing = STORYBOARD_TIMELINE_DETAIL_LABELS.filter((label) => !normalizeFragment(fields[label] || ''))
    const insufficient = STORYBOARD_TIMELINE_DETAIL_LABELS.filter((label) => {
      const content = normalizeFragment(fields[label] || '')
      return Boolean(content) && normalizedMatchText(content).length < DETAIL_MINIMUM_LENGTH[label]
    })
    return missing.length > 0 || insufficient.length > 0
      ? [{
          segmentIndex: index,
          range: `${formatTimelineSecond(segment.start)}~${formatTimelineSecond(segment.end)}s`,
          missing,
          insufficient,
        }]
      : []
  })
}

type NaturalStoryboardTimelineOptions = {
  maximumCharactersPerSegment?: number
  maximumCharacters?: number
}

function cleanNaturalText(value: string) {
  return normalizeFragment(value)
    .replace(/\.{3,}|…+/gu, '，')
    .replace(/，{2,}/gu, '，')
    .replace(/；{2,}/gu, '；')
    .replace(/([。！？!?])，/gu, '$1')
    .trim()
}

function compactNaturalText(value: string, maximum: number) {
  const source = cleanNaturalText(value)
  if (!source || source.length <= maximum) return source
  const candidate = source.slice(0, Math.max(1, maximum))
  const boundary = Math.max(
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('；'),
    candidate.lastIndexOf('，'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
  )
  const cut = boundary >= Math.floor(maximum * 0.58)
    ? candidate.slice(0, boundary)
    : candidate
  return cut.replace(/[，,；;：:\s]+$/gu, '').trim()
}

function naturalFieldClauses(value: string) {
  return uniqueFragments(cleanNaturalText(value)
    .replace(/[“"][^”"\n]+[”"]/gu, '')
    .split(/[。；;\n]+/u)
    .map((clause) => clause.replace(/^(?:镜内|画外|人数)[：:][^，,]*[，,]?/u, ''))
    .map((clause) => clause.replace(/^(先|随后|然后|接着|最后)[，,]\s*/u, '$1'))
    .map((clause) => clause.replace(/[，,：:\s]+$/u, ''))
    .map(normalizeFragment)
    .filter((clause) => clause && !NATURAL_TIMELINE_NOISE.test(clause)))
}

function naturalCamera(value: string) {
  const cleaned = cleanNaturalText(value)
    .replace(/从主要倾听者肩后拍摄的/gu, '')
    .replace(/主要倾听者正面或清晰侧面(?=(?:中)?近景)/gu, '')
    .replace(/([\p{L}\p{N}·•.'’_-]{2,24})正面或清晰侧面(?=(?:中)?近景)/gu, '$1')
    .replace(/优先读取(?:触发后的)?(?:面部|情绪)反应[^；;。]*/gu, '')
    .replace(/同时保留说话者口型和倾听者侧脸[^；;。]*/gu, '')
    .replace(/捕捉[^；;。]*/gu, '')
    .replace(/焦点在[^；;。]*/gu, '')
    .replace(/明确主体在画面中的位置、朝向与摄影机轴线/gu, '')
  const extracted = extractCamera(cleaned, '中景，固定机位')
  return compactNaturalText(extracted.replace(/[，,；;\s]+$/gu, ''), 38)
}

function naturalAction(value: string) {
  const clauses = naturalFieldClauses(value)
  const actions = clauses.filter((clause) => NATURAL_ACTION_CUE.test(clause))
  return compactNaturalText((actions.length > 0 ? actions : clauses).slice(0, 2).join('；'), 78)
}

const NATURAL_PHYSICS_CUE = /左手|右手|双手|双脚|手腕|手臂|肩膀|膝盖|重心|支撑|持握|抓|握|按|拉|推|拽|牵|接触点|移动路径|靠墙|落地|停步|站稳|道具/u
const GENERIC_PHYSICS_NOISE = /动作执行者沿连续可见路径|重心和关节随动作自然转移|双脚与地面保持真实接触|接触点、持握手和道具归属前后一致|不瞬移、不穿透、不滑移/u

function naturalPhysics(value: string, action: string) {
  const actionKey = normalizedMatchText(action)
  const clause = naturalFieldClauses(value)
    .filter((item) => NATURAL_PHYSICS_CUE.test(item))
    .filter((item) => !GENERIC_PHYSICS_NOISE.test(item))
    .find((item) => {
      const key = normalizedMatchText(item)
      return key.length >= 8 && !actionKey.includes(key)
    }) || ''
  return compactNaturalText(clause, 58)
}

function naturalPerformance(value: string, action: string, camera = '') {
  const actionKey = normalizedMatchText(action)
  const cameraKey = normalizedMatchText(camera)
  const clause = naturalFieldClauses(removeCameraClause(value, camera))
    .filter((item) => !/随本段动作逐步变化|自然落到本段结束状态|眼神、眉眼、呼吸和身体张力/u.test(item))
    .find((item) => {
      const key = normalizedMatchText(item)
      return key.length >= 4 && !actionKey.includes(key) && !cameraKey.includes(key)
    }) || ''
  return compactNaturalText(clause.replace(/^([^；。]*?)初始/u, '$1'), 44)
}

function naturalDialogue(value: string) {
  const source = cleanNaturalText(value)
  if (!source || NO_DIALOGUE.test(source)) return ''
  const entries = timelineDialogueEntries(source)
  if (entries.length === 0) return source
  return entries.map((entry) => {
    const match = entry.match(/^([^：:]{1,40}?)(【OS】)?[：:]\s*([\s\S]+)$/u)
    if (!match) return entry
    const speaker = cleanNaturalText(match[1])
    const spoken = cleanNaturalText(match[3])
      .replace(/^[“"]|[”"]$/gu, '')
      .trim()
    if (!spoken) return ''
    return `${speaker}${match[2] ? '在画外' : ''}：“${spoken}”`
  }).filter(Boolean).join('；')
}

function naturalEnding(value: string, action: string) {
  const ending = naturalFieldClauses(value).find((clause) => ESSENTIAL_ENDING_ACTION.test(clause)) || ''
  if (!ending) return ''
  const endingKey = normalizedMatchText(ending)
  const actionKey = normalizedMatchText(action)
  return endingKey && !actionKey.includes(endingKey)
    ? compactNaturalText(ending, 52)
    : ''
}

function naturalSceneCue(value: string) {
  const source = cleanNaturalText(value)
  return compactNaturalText(
    source.match(/(?:场景为|直接切换到)“[^”]+”/u)?.[0] || source,
    38,
  )
}

function naturalDialogueFromBody(value: string) {
  const entries = [...value.matchAll(/(?:^|[。；]\s*)([^：:。；“”]{1,24})(【OS】)?[：:]\s*[“"]([^”"\n]+)[”"]/gmu)]
    .map((match) => ({
      speaker: cleanNaturalText(match[1]),
      offscreen: Boolean(match[2]),
      spoken: cleanNaturalText(match[3]),
    }))
    .filter((entry) => entry.spoken && !NO_DIALOGUE.test(entry.spoken))
  if (entries.length > 0) {
    return entries.map((entry) => (
      `${entry.speaker}${entry.offscreen ? '在画外' : ''}：“${entry.spoken}”`
    )).join('；')
  }
  return [...value.matchAll(/[“"]([^”"\n]+)[”"]/gmu)]
    .flatMap((match) => {
      const quoteIndex = match.index || 0
      const nearbyPrefix = value.slice(Math.max(0, quoteIndex - 12), quoteIndex)
      if (/(?:场景为|切换到)\s*$/u.test(nearbyPrefix)) return []
      const sentenceStart = Math.max(
        value.lastIndexOf('。', quoteIndex),
        value.lastIndexOf('；', quoteIndex),
        value.lastIndexOf('\n', quoteIndex),
      ) + 1
      const lead = value.slice(sentenceStart, quoteIndex).trim()
      const speaker = /(?:说|问|喊|回答)[：:]?\s*$/u.test(lead)
        ? lead.match(/^([\p{L}\p{N}·•.'’_-]{2,16}?)(?=从|向|低|抬|看|问|说|喊|回答|保持|站|坐|走|跑|微|缓|突然|先|右|左)/u)?.[1] || ''
        : ''
      const spoken = cleanNaturalText(match[1])
      if (!spoken || NO_DIALOGUE.test(spoken)) return []
      return [speaker ? `${speaker}：“${spoken}”` : `“${spoken}”`]
    })
    .join('；')
}

function composeNaturalTimelineBody(input: {
  sceneCue?: string
  camera?: string
  action?: string
  physics?: string
  dialogue?: string
  performance?: string
  ending?: string
}, maximum: number) {
  let sceneCue = input.sceneCue || ''
  let camera = input.camera || ''
  let action = input.action || ''
  let physics = input.physics || ''
  const dialogue = input.dialogue || ''
  let performance = input.performance || ''
  let ending = input.ending || ''
  const compose = () => [
    [sceneCue, camera, action, physics].filter(Boolean).join('，'),
    dialogue,
    performance,
    ending,
  ].filter(Boolean).join('；').replace(/[。]+$/u, '')

  let body = compose()
  if (body.length > maximum) {
    action = compactNaturalText(action, 68)
    physics = compactNaturalText(physics, 44)
    performance = compactNaturalText(performance, 38)
    ending = compactNaturalText(ending, 38)
    body = compose()
  }
  if (body.length > maximum) {
    camera = compactNaturalText(camera, 25)
    sceneCue = compactNaturalText(sceneCue, 24)
    body = compose()
  }
  if (body.length > maximum) {
    const fixedLength = dialogue.length + camera.length + sceneCue.length + 10
    const flexible = Math.max(72, maximum - fixedLength)
    action = compactNaturalText(action, Math.max(30, Math.floor(flexible * 0.4)))
    physics = compactNaturalText(physics, Math.max(18, Math.floor(flexible * 0.2)))
    performance = compactNaturalText(performance, Math.max(18, Math.floor(flexible * 0.2)))
    ending = compactNaturalText(ending, Math.max(18, Math.floor(flexible * 0.2)))
    body = compose()
  }
  if (body.length > maximum) {
    physics = ''
    body = compose()
  }
  return body.length > maximum ? compactNaturalText(body, maximum) : body
}

function naturalSimpleTimelineBody(value: string, maximum: number) {
  const source = cleanNaturalText(value)
    .replace(/(?:^|[。；])\s*无对白\s*(?=[。；]|$)/gu, '')
    .replace(/(?:^|[。；])\s*对白结束后不再重复[^。；]*(?=[。；]|$)/gu, '')
    .replace(/(?:^|[。；])\s*结尾(?=[^。；])/gu, '；')
  const hasInternalClutter = /主要倾听者|优先读取|按对白顺序|镜内角色|镜内[^；。]*两人|身份和位置|只有一人|保持上一镜结束姿态|按顺序继续现场对白|焦点在|捕捉|同时保留说话者口型|上一场景的人物和陈设完全退出/u.test(source)
  if (!hasInternalClutter && source.length <= Math.min(maximum, 110)) {
    return compactNaturalText(source, maximum)
  }
  const dialogue = naturalDialogueFromBody(source)
  const sourceSceneCue = source.match(/(?:场景为|直接切换到)“[^”]+”/u)?.[0] || ''
  const withoutDialogue = source
    .replace(sourceSceneCue, '')
    .replace(/[“"][^”"\n]+[”"]/gu, '；')
    .replace(/(?:说|问|喊|回答)[：:]?\s*(?=[。；]|$)/gu, '')
  const rawCamera = extractCamera(withoutDialogue, '中景，固定机位')
  const camera = naturalCamera(rawCamera)
  const remainder = removeCameraClause(withoutDialogue, rawCamera)
  const clauses = naturalFieldClauses(remainder)
    .map((clause) => clause.replace(/[：:]+$/u, '').trim())
    .filter((clause) => normalizedMatchText(clause).length >= 4)
    .filter((clause) => !NO_DIALOGUE.test(clause))
    .filter((clause) => !/镜内角色|角色数量|身份和位置|只有一人|人物不得|禁止人物|同步口型/u.test(clause))
  const actionClauses = clauses.filter((clause) => (
    NATURAL_ACTION_CUE.test(clause) && !NATURAL_TIMELINE_NOISE.test(clause)
  ))
  const fallbackActions = clauses.filter((clause) => (
    !NATURAL_PERFORMANCE_CUE.test(clause)
    && !NATURAL_INSTRUCTION_CUE.test(clause)
    && !/场景为“|直接切换到“/u.test(clause)
  ))
  const action = compactNaturalText(
    (actionClauses.length > 0 ? actionClauses : fallbackActions).slice(0, 2).join('；'),
    78,
  )
  const actionKey = normalizedMatchText(action)
  const performance = compactNaturalText(clauses.find((clause) => (
    NATURAL_PERFORMANCE_CUE.test(clause)
    && !actionKey.includes(normalizedMatchText(clause))
  )) || '', 44)
  const instructionCandidate = clauses.find((clause) => NATURAL_INSTRUCTION_CUE.test(clause)) || ''
  const instruction = actionKey.includes(normalizedMatchText(instructionCandidate))
    ? ''
    : compactNaturalText(instructionCandidate, 46)
  const sceneCue = naturalSceneCue(sourceSceneCue)
  return composeNaturalTimelineBody({
    sceneCue,
    camera,
    action,
    dialogue,
    performance,
    ending: instruction,
  }, maximum)
}

function renderNaturalTimelineSegment(segment: StoryboardTimelineSegment, maximum: number) {
  const { fields, prefix } = parseStoryboardTimelineDetailFields(segment.body)
  const hasDetailedFields = STORYBOARD_TIMELINE_DETAIL_LABELS.some((label) => Boolean(fields[label]))
  const heading = `${formatTimelineSecond(segment.start)}~${formatTimelineSecond(segment.end)}s：`
  if (!hasDetailedFields) {
    const body = naturalSimpleTimelineBody(segment.body, Math.max(40, maximum - heading.length - 1))
    return `${heading}${body.replace(/[。]+$/u, '')}。`
  }

  const sceneCue = naturalSceneCue(prefix)
  const camera = naturalCamera(fields['镜头与构图'] || '')
  const action = naturalAction(fields['动作顺序'] || '')
  const physics = naturalPhysics(fields['动作物理'] || '', action)
  const dialogue = naturalDialogue(fields['对白'] || '')
  const performance = naturalPerformance(fields['表演变化'] || '', action, camera)
  const ending = naturalEnding(fields['本段结束状态'] || '', action)
  const body = composeNaturalTimelineBody({
    sceneCue,
    camera,
    action,
    physics,
    dialogue,
    performance,
    ending,
  }, Math.max(40, maximum - heading.length - 1))
  return `${heading}${body.replace(/[。]+$/u, '')}。`
}

export function naturalizeStoryboardTimeline(
  value: string,
  options: NaturalStoryboardTimelineOptions = {},
) {
  const parsedSegments = parseStoryboardTimelineSegments(value)
  if (parsedSegments.length === 0) return cleanNaturalText(extractTimeline(value))
  const segments: StoryboardTimelineSegment[] = []
  for (const source of parsedSegments) {
    const segment = { ...source }
    const { fields } = parseStoryboardTimelineDetailFields(segment.body)
    const dialogue = naturalDialogue(fields['对白'] || dialogueFromBody(segment.body))
    const dialogueKey = normalizedMatchText(dialogue)
    const previous = segments.at(-1)
    if (previous && dialogueKey && Math.abs(previous.end - segment.start) < 0.01) {
      const previousFields = parseStoryboardTimelineDetailFields(previous.body).fields
      const previousDialogue = naturalDialogue(previousFields['对白'] || dialogueFromBody(previous.body))
      if (normalizedMatchText(previousDialogue) === dialogueKey) {
        previous.end = segment.end
        continue
      }
    }
    segments.push(segment)
  }
  const maximumCharacters = Math.max(80, options.maximumCharacters || Number.MAX_SAFE_INTEGER)
  const separatorLength = Math.max(0, segments.length - 1)
  const evenlyAvailable = Number.isFinite(maximumCharacters)
    ? Math.floor((maximumCharacters - separatorLength) / segments.length)
    : Number.MAX_SAFE_INTEGER
  const maximumPerSegment = Math.max(
    70,
    Math.min(options.maximumCharactersPerSegment || 180, evenlyAvailable),
  )
  return segments
    .map((segment) => renderNaturalTimelineSegment(segment, maximumPerSegment))
    .join('\n')
    .slice(0, maximumCharacters)
    .replace(/…/gu, '')
    .trim()
}

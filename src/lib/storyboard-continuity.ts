export type ContinuityTransitionType =
  | 'scene_start'
  | 'same_scene_continuous'
  | 'reverse_shot'
  | 'scene_change'
  | 'time_jump'

export type ContinuityReferenceMode = 'spatial' | 'visual'

export type ContinuityScreenPosition = 'left' | 'center' | 'right' | 'unknown'
export type ContinuityMovementDirection =
  | 'screen_left'
  | 'screen_right'
  | 'toward_camera'
  | 'away_from_camera'
  | 'stationary'
  | 'unknown'

export type ContinuityCharacterState = {
  name: string
  screenPosition: ContinuityScreenPosition
  facing: string
  gazeTarget: string
  leftHand: string
  rightHand: string
  contacts: string[]
  heldProps: string[]
  movementDirection: ContinuityMovementDirection
}

export type StoryboardContinuityState = {
  version: 1
  transitionType: ContinuityTransitionType
  scene: string
  cameraAxis: string
  cameraSide: string
  characters: ContinuityCharacterState[]
  completedActions: string[]
  plannedActions: string[]
  summary: string
}

export type InferStoryboardContinuityInput = {
  transitionType: ContinuityTransitionType
  scene: string
  camera: string
  frame: string
  action: string
  propState: string
  characterNames: string[]
}

type StoryboardSequenceRecord = {
  id: string
  episodeId?: string | null
  episodeSceneNumber?: number | null
  episode?: { episodeNumber: number } | null
  sceneNumber: number
  notes?: string | null
  videoPrompt?: string | null
  continuityIn?: unknown
  continuityOut?: unknown
}

export function previousStoryboardInSequence<T extends StoryboardSequenceRecord>(
  storyboards: T[],
  current: Pick<StoryboardSequenceRecord, 'id'>,
) {
  const ordered = [...storyboards].sort((left, right) => {
    const leftEpisode = left.episode?.episodeNumber ?? Number.MAX_SAFE_INTEGER
    const rightEpisode = right.episode?.episodeNumber ?? Number.MAX_SAFE_INTEGER
    return leftEpisode - rightEpisode
      || (left.episodeSceneNumber ?? left.sceneNumber) - (right.episodeSceneNumber ?? right.sceneNumber)
      || left.sceneNumber - right.sceneNumber
      || left.id.localeCompare(right.id)
  })
  const currentIndex = ordered.findIndex((storyboard) => storyboard.id === current.id)
  return currentIndex > 0 ? ordered[currentIndex - 1] : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(stringValue).filter(Boolean))]
    : []
}

function transitionType(value: unknown): ContinuityTransitionType {
  return [
    'scene_start',
    'same_scene_continuous',
    'reverse_shot',
    'scene_change',
    'time_jump',
  ].includes(String(value))
    ? value as ContinuityTransitionType
    : 'scene_start'
}

function screenPosition(value: unknown): ContinuityScreenPosition {
  return ['left', 'center', 'right'].includes(String(value))
    ? value as ContinuityScreenPosition
    : 'unknown'
}

function movementDirection(value: unknown): ContinuityMovementDirection {
  return [
    'screen_left',
    'screen_right',
    'toward_camera',
    'away_from_camera',
    'stationary',
  ].includes(String(value))
    ? value as ContinuityMovementDirection
    : 'unknown'
}

export function parseStoryboardContinuityState(value: unknown): StoryboardContinuityState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  const characters = Array.isArray(state.characters)
    ? state.characters.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
        const character = candidate as Record<string, unknown>
        const name = stringValue(character.name)
        if (!name) return []
        return [{
          name,
          screenPosition: screenPosition(character.screenPosition),
          facing: stringValue(character.facing),
          gazeTarget: stringValue(character.gazeTarget),
          leftHand: stringValue(character.leftHand),
          rightHand: stringValue(character.rightHand),
          contacts: stringArray(character.contacts),
          heldProps: stringArray(character.heldProps),
          movementDirection: movementDirection(character.movementDirection),
        }]
      })
    : []
  return {
    version: 1,
    transitionType: transitionType(state.transitionType),
    scene: stringValue(state.scene),
    cameraAxis: stringValue(state.cameraAxis),
    cameraSide: stringValue(state.cameraSide),
    characters,
    completedActions: stringArray(state.completedActions),
    plannedActions: stringArray(state.plannedActions),
    summary: stringValue(state.summary),
  }
}

function normalizedScene(value: string | null | undefined) {
  return String(value || '')
    .replace(/^.*?[｜|]/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase()
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nearbyCharacterText(name: string, value: string) {
  const match = value.match(new RegExp(`${escapePattern(name)}[^。；;\n]{0,120}`, 'u'))
  return match?.[0] || ''
}

function inferredScreenPosition(name: string, value: string): ContinuityScreenPosition {
  const escaped = escapePattern(name)
  if (new RegExp(`(?:${escaped}.{0,32}(?:画面)?左(?:侧|边)|(?:画面)?左(?:侧|边).{0,32}${escaped})`, 'u').test(value)) return 'left'
  if (new RegExp(`(?:${escaped}.{0,32}(?:画面)?右(?:侧|边)|(?:画面)?右(?:侧|边).{0,32}${escaped})`, 'u').test(value)) return 'right'
  if (new RegExp(`(?:${escaped}.{0,32}(?:画面)?(?:中央|中间|中心)|(?:画面)?(?:中央|中间|中心).{0,32}${escaped})`, 'u').test(value)) return 'center'
  return 'unknown'
}

function inferredMovement(value: string): ContinuityMovementDirection {
  if (/向(?:画面)?左(?:侧|边)?(?:走|移动|退|跑)|从右向左/u.test(value)) return 'screen_left'
  if (/向(?:画面)?右(?:侧|边)?(?:走|移动|退|跑)|从左向右/u.test(value)) return 'screen_right'
  if (/走向镜头|朝镜头走|接近镜头|迎面走来/u.test(value)) return 'toward_camera'
  if (/背对镜头.{0,20}(?:走|离开)|远离镜头|向前走去/u.test(value)) return 'away_from_camera'
  if (/保持原位|停在原地|没有移动|站定/u.test(value)) return 'stationary'
  return 'unknown'
}

function inferredFacing(value: string) {
  if (/背对镜头|背面/u.test(value)) return '背对镜头'
  if (/正对镜头|正面/u.test(value)) return '正对镜头'
  if (/侧身|侧面/u.test(value)) return '侧身'
  return ''
}

function inferredGaze(name: string, value: string, characterNames: string[]) {
  const nearby = nearbyCharacterText(name, value)
  return characterNames.find((candidate) => candidate !== name && (
    new RegExp(`(?:看向|望向|盯着|注视)${escapePattern(candidate)}`, 'u').test(nearby)
  )) || ''
}

function inferredHand(name: string, side: '左' | '右', value: string) {
  const nearby = nearbyCharacterText(name, value)
  return nearby.match(new RegExp(`${side}手[^。；;\n]{0,42}`, 'u'))?.[0] || ''
}

function inferredContactPairs(value: string, characterNames: string[]) {
  const pairs: string[] = []
  for (let leftIndex = 0; leftIndex < characterNames.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < characterNames.length; rightIndex++) {
      const left = characterNames[leftIndex]
      const right = characterNames[rightIndex]
      const contact = /抓住|握住|扶住|挽住|拉住|抱住|按住|搀扶/u
      const related = new RegExp(
        `(?:${escapePattern(left)}[^。；;\n]{0,70}${contact.source}[^。；;\n]{0,40}${escapePattern(right)}|${escapePattern(right)}[^。；;\n]{0,70}${contact.source}[^。；;\n]{0,40}${escapePattern(left)})`,
        'u',
      ).test(value)
      if (related) pairs.push(contactKey(`${left}|${right}`))
    }
  }
  return pairs
}

function inferredProps(name: string, value: string) {
  const nearby = nearbyCharacterText(name, value)
  const props = [...nearby.matchAll(/(?:左手|右手|手中)?(?:提着|拿着|握着|拎着|持有)([^，。；;\n]{1,16})/gu)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  return [...new Set(props)]
}

function inferredCompletedActions(value: string, characterNames: string[]) {
  const actions: string[] = []
  const contacts = inferredContactPairs(value, characterNames)
  if (/甩开|松开|挣脱|解除接触|不再接触/u.test(value)) {
    const releaseContacts = contacts.length > 0
      ? contacts
      : characterNames.flatMap((left, index) => characterNames.slice(index + 1).flatMap((right) => (
          value.includes(left) && value.includes(right) ? [contactKey(`${left}|${right}`)] : []
        )))
    for (const contact of releaseContacts) actions.push(`release:${contact}`)
  }
  for (const name of characterNames) {
    const nearby = nearbyCharacterText(name, value)
    if (/转身/u.test(nearby)) actions.push(`turn:${name}`)
    if (/离开|走出|退出画面/u.test(nearby)) actions.push(`leave:${name}`)
    if (/坠落|跌落|落下/u.test(nearby)) actions.push(`fall:${name}`)
  }
  return [...new Set(actions)]
}

function inferredCameraAxis(value: string) {
  return value.match(/(?:摄影机|镜头|轴线)[^。；;\n]{0,90}(?:左侧|右侧|同侧|轴线)/u)?.[0] || ''
}

export function inferStoryboardContinuityState(
  input: InferStoryboardContinuityInput,
): StoryboardContinuityState {
  const visibleState = [input.frame, input.action, input.propState].filter(Boolean).join('；')
  const contacts = inferredContactPairs(visibleState, input.characterNames)
  const characters = input.characterNames.map((name): ContinuityCharacterState => {
    const nearby = nearbyCharacterText(name, visibleState)
    return {
      name,
      screenPosition: inferredScreenPosition(name, visibleState),
      facing: inferredFacing(nearby),
      gazeTarget: inferredGaze(name, visibleState, input.characterNames),
      leftHand: inferredHand(name, '左', visibleState),
      rightHand: inferredHand(name, '右', visibleState),
      contacts: contacts.filter((contact) => contact.split('|').includes(name)),
      heldProps: inferredProps(name, `${nearby}；${input.propState}`),
      movementDirection: inferredMovement(nearby),
    }
  })
  return {
    version: 1,
    transitionType: input.transitionType,
    scene: input.scene,
    cameraAxis: inferredCameraAxis(input.camera),
    cameraSide: /右侧/u.test(input.camera) ? 'right' : /左侧/u.test(input.camera) ? 'left' : '',
    characters,
    completedActions: inferredCompletedActions(visibleState, input.characterNames),
    plannedActions: inferredCompletedActions(input.action, input.characterNames),
    summary: input.frame.trim().slice(0, 500),
  }
}

function hasExplicitDiscontinuity(value: string) {
  return /(?:切入新场景|场景转换|转场|时间跳转|数日后|翌日|闪回|回忆|梦境|正反打|反打|越轴)/u.test(value)
}

function storyboardTimelineText(value: string | null | undefined) {
  const prompt = String(value || '')
  const markerIndex = prompt.indexOf('【视频分镜】')
  return markerIndex >= 0 ? prompt.slice(markerIndex) : prompt
}

export function isImmediatePreviousStoryboard(
  current: Pick<StoryboardSequenceRecord, 'episodeId' | 'episodeSceneNumber' | 'sceneNumber'>,
  source: Pick<StoryboardSequenceRecord, 'episodeId' | 'episodeSceneNumber' | 'sceneNumber'>,
) {
  if (current.episodeId || source.episodeId) {
    return Boolean(
      current.episodeId
      && current.episodeId === source.episodeId
      && current.episodeSceneNumber
      && source.episodeSceneNumber === current.episodeSceneNumber - 1,
    )
  }
  return source.sceneNumber === current.sceneNumber - 1
}

export function shouldUsePreviousTailFrame(
  previous: StoryboardSequenceRecord | null | undefined,
  current: StoryboardSequenceRecord | null | undefined,
) {
  if (!previous || !current || !isImmediatePreviousStoryboard(current, previous)) return false
  const incoming = parseStoryboardContinuityState(current.continuityIn)
  if (incoming) return incoming.transitionType === 'same_scene_continuous'
  const previousScene = normalizedScene(previous.notes)
  const currentScene = normalizedScene(current.notes)
  if (!previousScene || previousScene !== currentScene) return false
  return !hasExplicitDiscontinuity(`${storyboardTimelineText(current.videoPrompt)}\n${current.notes || ''}`)
}

function contactKey(value: string) {
  return value.split('|').map((part) => part.trim()).filter(Boolean).sort().join('|')
}

function actionKey(value: string) {
  return value.trim().toLocaleLowerCase()
}

function oppositeMovement(left: ContinuityMovementDirection, right: ContinuityMovementDirection) {
  return (left === 'screen_left' && right === 'screen_right')
    || (left === 'screen_right' && right === 'screen_left')
    || (left === 'toward_camera' && right === 'away_from_camera')
    || (left === 'away_from_camera' && right === 'toward_camera')
}

function propOwners(state: StoryboardContinuityState) {
  const owners = new Map<string, string>()
  for (const character of state.characters) {
    for (const prop of character.heldProps) owners.set(prop, character.name)
  }
  return owners
}

export function storyboardContinuityStateIssues(
  previousValue: unknown,
  currentValue: unknown,
  plannedValue: unknown = currentValue,
) {
  const previous = parseStoryboardContinuityState(previousValue)
  const current = parseStoryboardContinuityState(currentValue)
  const planned = parseStoryboardContinuityState(plannedValue)
  if (!previous || !current || !planned || current.transitionType !== 'same_scene_continuous') return []
  const issues: string[] = []
  if (normalizedScene(previous.scene) && normalizedScene(current.scene)
    && normalizedScene(previous.scene) !== normalizedScene(current.scene)) {
    issues.push('承接镜头的场景与上一镜不同')
  }
  if (previous.cameraAxis && current.cameraAxis && previous.cameraAxis !== current.cameraAxis) {
    issues.push('摄影机轴线未经过转场或反打就发生变化')
  }

  const previousCharacters = new Map(previous.characters.map((character) => [character.name, character]))
  for (const character of current.characters) {
    const before = previousCharacters.get(character.name)
    if (!before) continue
    if (before.screenPosition !== 'unknown' && character.screenPosition !== 'unknown'
      && before.screenPosition !== character.screenPosition) {
      issues.push(`${character.name}从画面${before.screenPosition}无过程跳到${character.screenPosition}`)
    }
    if (oppositeMovement(before.movementDirection, character.movementDirection)) {
      issues.push(`${character.name}的移动方向与上一镜相反`)
    }
  }

  const currentContacts = new Set(current.characters.flatMap((character) => character.contacts).map(contactKey))
  for (const action of previous.completedActions) {
    if (!action.startsWith('release:')) continue
    const released = contactKey(action.slice('release:'.length))
    if (released && currentContacts.has(released)) issues.push(`已经解除的接触“${released}”在下一镜恢复`)
  }

  const previousActions = new Set(previous.completedActions.map(actionKey))
  for (const action of planned.plannedActions) {
    const key = actionKey(action)
    if (key && previousActions.has(key) && /^(?:turn|leave|fall|release):/u.test(key)) {
      issues.push(`不可逆动作“${action}”被重复执行`)
    }
  }

  const beforeOwners = propOwners(previous)
  const afterOwners = propOwners(current)
  for (const [prop, owner] of beforeOwners) {
    const nextOwner = afterOwners.get(prop)
    if (nextOwner && nextOwner !== owner) issues.push(`道具“${prop}”从${owner}无过程转移给${nextOwner}`)
  }
  return [...new Set(issues)]
}

export function continuityReferenceInstruction(
  referenceOrder: number,
  mode: ContinuityReferenceMode = 'spatial',
) {
  return mode === 'spatial'
    ? `@image${referenceOrder}：上一镜尾帧，仅用于继承人物站位、身体朝向、视线、接触状态、摄影机轴线和光线，不改变其他参考图的人物身份。`
    : `@image${referenceOrder}：上一镜尾帧，仅继承本镜同名人物的外观、服装、道具和结束情绪；当前场景、站位、轴线和光线严格以本镜文本为准，不得带入尾帧中的旧场景或本镜未出场人物。`
}

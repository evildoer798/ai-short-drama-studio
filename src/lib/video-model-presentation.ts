export type VideoModelGroupId = 'seedance-2.5' | 'seedance-2.0' | 'kling' | 'minimax' | 'grok' | 'veo' | 'gemini-omni' | 'sora' | 'happyhouse' | 'other'

export type PresentableVideoModel = {
  id: string
  priceLabel: string
  available?: boolean | null
  maximumReferenceImages?: number
  maximumReferenceVideos?: number
  supportsAudio?: boolean
  resolutions?: string[]
  defaultResolution?: string
}

const videoModelGroups: Array<{ id: VideoModelGroupId, label: string }> = [
  { id: 'seedance-2.5', label: 'Seedance 2.5' },
  { id: 'seedance-2.0', label: 'Seedance 2.0' },
  { id: 'kling', label: '可灵 Kling' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'grok', label: 'Grok' },
  { id: 'veo', label: 'Google Veo' },
  { id: 'gemini-omni', label: 'Gemini / Omni' },
  { id: 'sora', label: 'Sora' },
  { id: 'happyhouse', label: 'HappyHouse' },
  { id: 'other', label: '其他视频模型' },
]

export function videoModelGroupId(modelId: string): VideoModelGroupId {
  const id = modelId.trim().toLowerCase()
  if (/^(?:sd[5-8]-)?seedance-2\.5(?:-|$)/u.test(id)) return 'seedance-2.5'
  if (/^(?:sd[5-8]-)?seedance-2\.0(?:-|$)/u.test(id)) return 'seedance-2.0'
  if (/^kling-(?:-|\d)/u.test(id)) return 'kling'
  if (/^minimax-(?:-|\w)/u.test(id)) return 'minimax'
  if (/^(?:(?:cy-gv1-)?grok-video|grok-imagine-video)(?:-|$)/u.test(id)) return 'grok'
  if (/^veo-(?:-|\d)/u.test(id)) return 'veo'
  if (/^(?:gemini-|omni-)/u.test(id)) return 'gemini-omni'
  if (/^sora-2(?:-|$)/u.test(id)) return 'sora'
  if (/^happyhouse-(?:1\.0|1\.1)$/u.test(id)) return 'happyhouse'
  return 'other'
}

export function groupVideoModelOptions<T extends PresentableVideoModel>(models: T[]) {
  const unique = new Map<string, T>()
  for (const model of models) {
    const key = model.id.trim().toLowerCase()
    if (!key) continue
    const existing = unique.get(key)
    if (!existing || (existing.available === false && model.available !== false)) {
      unique.set(key, model)
    }
  }

  return videoModelGroups.flatMap((group) => {
    const groupModels = [...unique.values()]
      .filter((model) => videoModelGroupId(model.id) === group.id)
      .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
    return groupModels.length > 0 ? [{ ...group, models: groupModels }] : []
  })
}

export function videoModelOptionText(model: PresentableVideoModel, unavailableLabel = '不可用') {
  return `${model.id} · ${model.priceLabel}${model.available === false ? `（${unavailableLabel}）` : ''}`
}

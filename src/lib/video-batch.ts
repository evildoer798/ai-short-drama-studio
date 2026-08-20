export type SequentialVideoBatchItem = {
  episodeId: string | null
  episodeSceneNumber: number | null
  sceneNumber: number
  duration: number
  sceneKey?: string | null
}

export type StoryboardVideoGroupSize = 1 | 2 | 3 | 4

export function normalizeVideoDuration(
  requestedDuration: number,
  minimumDuration = 1,
  maximumDuration = 15,
  supportedDurations: number[] | null = null,
) {
  const minimum = Math.max(1, Math.round(minimumDuration))
  const maximum = Math.max(minimum, Math.round(maximumDuration))
  const requested = Number.isFinite(requestedDuration)
    ? Math.min(maximum, Math.max(minimum, Math.ceil(requestedDuration)))
    : minimum
  const options = [...new Set(supportedDurations || [])]
    .map((duration) => Math.round(duration))
    .filter((duration) => duration >= minimum && duration <= maximum)
    .sort((left, right) => left - right)

  if (options.length === 0) return requested
  return options.find((duration) => duration >= requested) || options.at(-1)!
}

export function videoDurationOptions(
  minimumDuration = 4,
  maximumDuration = 15,
  supportedDurations: number[] | null = null,
) {
  const minimum = Math.max(1, Math.round(minimumDuration))
  const maximum = Math.max(minimum, Math.round(maximumDuration))
  const supported = [...new Set(supportedDurations || [])]
    .map((duration) => Math.round(duration))
    .filter((duration) => duration >= minimum && duration <= maximum)
    .sort((left, right) => left - right)
  if (supported.length > 0) return supported
  return Array.from({ length: maximum - minimum + 1 }, (_value, index) => minimum + index)
}

function storyboardOrder(item: SequentialVideoBatchItem) {
  return item.episodeSceneNumber || item.sceneNumber
}

function normalizeSceneIdentity(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/^(?:时间地点|场景)[:：]\s*/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function storyboardSceneIdentity(input: {
  notes?: string | null
  locationNames?: string[]
}) {
  const noteLine = input.notes?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || ''
  const locationName = input.locationNames?.map((name) => name.trim()).find(Boolean) || ''
  const noteParts = noteLine.split('｜').map((part) => part.trim()).filter(Boolean)
  const noteLocation = noteParts.length > 1 ? noteParts.slice(1).join('｜') : noteLine
  const label = noteLocation || locationName || '未识别场景'
  const keySource = noteLine || locationName
  return {
    key: keySource ? normalizeSceneIdentity(keySource) : '',
    label,
  }
}

export function orderSingleEpisodeVideoBatch<T extends SequentialVideoBatchItem>(items: T[]) {
  const episodeKeys = new Set(items.map((item) => item.episodeId || 'unassigned'))
  if (episodeKeys.size > 1) {
    throw new Error('批量视频只能选择同一集内的分镜')
  }
  return [...items].sort((left, right) => (
    storyboardOrder(left) - storyboardOrder(right)
  ))
}

export function groupSingleEpisodeVideoBatch<T extends SequentialVideoBatchItem>(
  items: T[],
  maximumStoryboardsPerVideo: StoryboardVideoGroupSize,
  maximumDuration = 15,
) {
  const ordered = orderSingleEpisodeVideoBatch(items)
  const groupSize = Math.max(1, Math.min(4, Math.round(maximumStoryboardsPerVideo)))
  if (groupSize > 1 && ordered.some((item) => !item.episodeId)) {
    throw new Error('组合视频只支持已经归入同一集的分镜')
  }

  const groups: T[][] = []
  let current: T[] = []
  let currentDuration = 0

  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
    currentDuration = 0
  }

  for (const item of ordered) {
    if (item.duration > maximumDuration) {
      throw new Error(`单个分镜时长不能超过 ${maximumDuration} 秒`)
    }
    const previous = current.at(-1)
    const contiguous = !previous || storyboardOrder(item) === storyboardOrder(previous) + 1
    const fitsCount = current.length < groupSize
    const fitsDuration = currentDuration + item.duration <= maximumDuration
    if (!contiguous || !fitsCount || !fitsDuration) flush()
    current.push(item)
    currentDuration += item.duration
  }
  flush()
  return groups
}

export function fitVideoGroupDurations(
  durations: number[],
  maximumDuration = 15,
  supportedDurations: number[] | null = null,
  minimumDuration = 1,
  requestedDuration?: number,
) {
  const sourceDurations = durations.map((duration) => Math.max(0.1, duration))
  const sourceDuration = sourceDurations.reduce((total, duration) => total + duration, 0)
  if (sourceDuration === 0) {
    return { duration: 0, sourceDuration: 0, timelineDurations: [] as number[] }
  }

  if (sourceDuration > maximumDuration) {
    return { duration: sourceDuration, sourceDuration, timelineDurations: sourceDurations }
  }

  const requested = Math.max(sourceDuration, requestedDuration ?? sourceDuration)
  const duration = normalizeVideoDuration(
    requested,
    minimumDuration,
    maximumDuration,
    supportedDurations,
  )
  return { duration, sourceDuration, timelineDurations: sourceDurations }
}

export function estimateVideoGenerationSeconds(
  family: 'Grok' | 'Seedance' | 'Sora' | 'HappyHouse',
  duration: number,
) {
  const durationFactor = Math.max(0.5, duration / 15)
  const base = family === 'Seedance' || family === 'HappyHouse'
    ? { minimum: 4 * 60, maximum: 8 * 60 }
    : { minimum: 60, maximum: 3 * 60 }
  return {
    minimum: Math.round(base.minimum * durationFactor),
    maximum: Math.round(base.maximum * durationFactor),
  }
}

export function estimateSequentialVideoBatchSeconds(
  family: 'Grok' | 'Seedance' | 'Sora' | 'HappyHouse',
  items: Array<{ duration: number }>,
) {
  return items.reduce((total, item) => {
    const estimate = estimateVideoGenerationSeconds(family, item.duration)
    return {
      minimum: total.minimum + estimate.minimum,
      maximum: total.maximum + estimate.maximum,
    }
  }, { minimum: 0, maximum: 0 })
}

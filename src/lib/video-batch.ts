export type SequentialVideoBatchItem = {
  episodeId: string | null
  episodeSceneNumber: number | null
  sceneNumber: number
  duration: number
}

export type StoryboardVideoGroupSize = 1 | 2 | 3 | 4

function storyboardOrder(item: SequentialVideoBatchItem) {
  return item.episodeSceneNumber || item.sceneNumber
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

  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  for (const item of ordered) {
    if (item.duration > maximumDuration) {
      throw new Error(`单个分镜时长不能超过 ${maximumDuration} 秒`)
    }
    const previous = current.at(-1)
    const contiguous = !previous || storyboardOrder(item) === storyboardOrder(previous) + 1
    const fitsCount = current.length < groupSize
    if (!contiguous || !fitsCount) flush()
    current.push(item)
  }
  flush()
  return groups
}

export function fitVideoGroupDurations(durations: number[], maximumDuration = 15) {
  const sourceDurations = durations.map((duration) => Math.max(0.1, duration))
  const sourceDuration = sourceDurations.reduce((total, duration) => total + duration, 0)
  if (sourceDuration === 0) {
    return { duration: 0, sourceDuration: 0, timelineDurations: [] as number[] }
  }

  const duration = Math.min(Math.max(1, Math.floor(maximumDuration)), Math.ceil(sourceDuration))
  if (sourceDuration <= duration) {
    return { duration, sourceDuration, timelineDurations: sourceDurations }
  }

  let allocated = 0
  const timelineDurations = sourceDurations.map((source, index) => {
    if (index === sourceDurations.length - 1) {
      return Number(Math.max(0.1, duration - allocated).toFixed(2))
    }
    const fitted = Number((duration * source / sourceDuration).toFixed(2))
    allocated += fitted
    return fitted
  })
  return { duration, sourceDuration, timelineDurations }
}

export function estimateVideoGenerationSeconds(family: 'Grok' | 'Seedance', duration: number) {
  const durationFactor = Math.max(0.5, duration / 15)
  const base = family === 'Seedance'
    ? { minimum: 4 * 60, maximum: 8 * 60 }
    : { minimum: 60, maximum: 3 * 60 }
  return {
    minimum: Math.round(base.minimum * durationFactor),
    maximum: Math.round(base.maximum * durationFactor),
  }
}

export function estimateSequentialVideoBatchSeconds(
  family: 'Grok' | 'Seedance',
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

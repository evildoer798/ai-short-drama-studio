import { isTextProviderLabel, type TextProviderLabel } from './text-provider-label'

export type StoryboardTaskProgressDetail = {
  phase: 'preparing' | 'generating' | 'retrying' | 'saving' | 'finalizing'
  completedEpisodes: number
  totalEpisodes: number
  completedSegments: number
  totalSegments: number
  activeEpisodeNumbers: number[]
  parallelism: number
  segmentParallelism: number
  currentSegment?: number
  currentSegmentTotal?: number
  activeRoutes: Array<{
    episodeNumber: number
    provider: TextProviderLabel
    model: string
    attempt: number
    total: number
    reason?: string
  }>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteInteger(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback
}

function safeRouteText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) : ''
}

export function textTaskProgressDetail(payload: unknown): StoryboardTaskProgressDetail | null {
  const progress = record(record(payload)?.storyboardProgress)
  if (!progress) return null
  const phase = progress.phase
  if (!['preparing', 'generating', 'retrying', 'saving', 'finalizing'].includes(String(phase))) return null
  return {
    phase: phase as StoryboardTaskProgressDetail['phase'],
    completedEpisodes: finiteInteger(progress.completedEpisodes),
    totalEpisodes: finiteInteger(progress.totalEpisodes),
    completedSegments: finiteInteger(progress.completedSegments),
    totalSegments: finiteInteger(progress.totalSegments),
    activeEpisodeNumbers: Array.isArray(progress.activeEpisodeNumbers)
      ? progress.activeEpisodeNumbers
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .map((value) => Math.max(1, Math.round(value)))
      : [],
    activeRoutes: Array.isArray(progress.activeRoutes)
      ? progress.activeRoutes.flatMap((value) => {
        const route = record(value)
        const provider = route?.provider
        const model = safeRouteText(route?.model, 80)
        if (!route || !isTextProviderLabel(provider) || !model) return []
        const reason = safeRouteText(route.reason, 120)
        return [{
          episodeNumber: Math.max(1, finiteInteger(route.episodeNumber, 1)),
          provider,
          model,
          attempt: Math.max(1, finiteInteger(route.attempt, 1)),
          total: Math.max(1, finiteInteger(route.total, 1)),
          ...(reason ? { reason } : {}),
        }]
      })
      : [],
    parallelism: finiteInteger(progress.parallelism, 1) || 1,
    segmentParallelism: finiteInteger(progress.segmentParallelism, 1) || 1,
    ...(typeof progress.currentSegment === 'number'
      ? { currentSegment: finiteInteger(progress.currentSegment) }
      : {}),
    ...(typeof progress.currentSegmentTotal === 'number'
      ? { currentSegmentTotal: finiteInteger(progress.currentSegmentTotal) }
      : {}),
  }
}

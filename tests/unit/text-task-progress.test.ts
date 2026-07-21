import { describe, expect, it } from 'vitest'
import { textTaskProgressDetail } from '@/lib/text-task-progress'

describe('text task progress details', () => {
  it('exposes safe resumable storyboard progress', () => {
    expect(textTaskProgressDetail({
      storyboardProgress: {
        phase: 'retrying',
        completedEpisodes: 3,
        totalEpisodes: 15,
        completedSegments: 14,
        totalSegments: 61,
        activeEpisodeNumbers: [4, 5],
        parallelism: 4,
        segmentParallelism: 3,
        currentSegment: 2,
        currentSegmentTotal: 4,
        activeRoutes: [{
          episodeNumber: 4,
          provider: 'Cangyuan',
          model: 'gpt-5.5',
          attempt: 2,
          total: 5,
          reason: '上一线路读取超时',
        }],
      },
    })).toEqual({
      phase: 'retrying',
      completedEpisodes: 3,
      totalEpisodes: 15,
      completedSegments: 14,
      totalSegments: 61,
      activeEpisodeNumbers: [4, 5],
      parallelism: 4,
      segmentParallelism: 3,
      currentSegment: 2,
      currentSegmentTotal: 4,
      activeRoutes: [{
        episodeNumber: 4,
        provider: 'Cangyuan',
        model: 'gpt-5.5',
        attempt: 2,
        total: 5,
        reason: '上一线路读取超时',
      }],
    })
  })

  it('does not expose arbitrary task payload fields', () => {
    expect(textTaskProgressDetail({ apiKey: 'secret', storyboardProgress: { phase: 'unknown' } })).toBeNull()
  })
})

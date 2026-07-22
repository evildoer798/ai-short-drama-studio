import { describe, expect, it } from 'vitest'
import {
  estimateSequentialVideoBatchSeconds,
  fitVideoGroupDurations,
  groupSingleEpisodeVideoBatch,
  normalizeVideoDuration,
  orderSingleEpisodeVideoBatch,
} from '@/lib/video-batch'

const shot = (episodeId: string | null, episodeSceneNumber: number, duration = 5) => ({
  id: `${episodeId}-${episodeSceneNumber}`,
  episodeId,
  episodeSceneNumber,
  sceneNumber: episodeSceneNumber,
  duration,
})

describe('sequential video batches', () => {
  it('orders selected storyboards inside one episode', () => {
    const ordered = orderSingleEpisodeVideoBatch([
      shot('episode-1', 3),
      shot('episode-1', 1),
      shot('episode-1', 2),
    ])
    expect(ordered.map((item) => item.episodeSceneNumber)).toEqual([1, 2, 3])
  })

  it('rejects selections that cross episode boundaries', () => {
    expect(() => orderSingleEpisodeVideoBatch([
      shot('episode-1', 1),
      shot('episode-2', 1),
    ])).toThrow('批量视频只能选择同一集内的分镜')
  })

  it('adds generation time because the queue is sequential', () => {
    expect(estimateSequentialVideoBatchSeconds('Seedance', [
      { duration: 15 },
      { duration: 15 },
      { duration: 15 },
    ])).toEqual({ minimum: 720, maximum: 1440 })
    expect(estimateSequentialVideoBatchSeconds('Grok', [
      { duration: 15 },
      { duration: 15 },
    ])).toEqual({ minimum: 120, maximum: 360 })
  })

  it('groups three adjacent atomic shots per video by default', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 5),
      shot('episode-1', 2, 6),
      shot('episode-1', 3, 5),
      shot('episode-1', 4, 4),
    ], 3)

    expect(groups.map((group) => group.map((item) => item.episodeSceneNumber))).toEqual([
      [1, 2, 3],
      [4],
    ])
  })

  it('supports four adjacent shots and compresses their timeline to 15 seconds', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 4),
      shot('episode-1', 2, 4),
      shot('episode-1', 3, 4),
      shot('episode-1', 4, 4),
    ], 4)
    const fitted = fitVideoGroupDurations(groups[0].map((item) => item.duration), 15)

    expect(groups[0]).toHaveLength(4)
    expect(fitted.duration).toBe(15)
    expect(fitted.sourceDuration).toBe(16)
    expect(fitted.timelineDurations).toEqual([3.75, 3.75, 3.75, 3.75])
    expect(fitted.timelineDurations.reduce((total, duration) => total + duration, 0)).toBe(15)
  })

  it('uses the next supported duration and stretches the combined timeline', () => {
    const fitted = fitVideoGroupDurations([4, 4, 4], 15, [6, 10, 15], 6)

    expect(fitted.duration).toBe(15)
    expect(fitted.sourceDuration).toBe(12)
    expect(fitted.timelineDurations).toEqual([5, 5, 5])
    expect(normalizeVideoDuration(4, 6, 15, [6, 10, 15])).toBe(6)
    expect(normalizeVideoDuration(12, 6, 15, [6, 10, 15])).toBe(15)
  })

  it('keeps continuous Seedance durations unchanged', () => {
    expect(fitVideoGroupDurations([4, 4, 4], 15, null, 4)).toMatchObject({
      duration: 12,
      timelineDurations: [4, 4, 4],
    })
  })

  it('fits the combined timeline to the duration selected by the user', () => {
    const fitted = fitVideoGroupDurations([4, 4, 4], 15, null, 4, 10)

    expect(fitted.duration).toBe(10)
    expect(fitted.timelineDurations).toEqual([3.33, 3.33, 3.34])
  })

  it('starts a new video when selected shots are not adjacent', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 4),
      shot('episode-1', 3, 4),
      shot('episode-1', 4, 4),
    ], 3)
    expect(groups.map((group) => group.map((item) => item.episodeSceneNumber))).toEqual([
      [1],
      [3, 4],
    ])
  })

  it('does not combine unassigned storyboards', () => {
    expect(() => groupSingleEpisodeVideoBatch([
      shot(null, 1, 4),
      shot(null, 2, 4),
    ], 2)).toThrow('已经归入同一集')
  })
})

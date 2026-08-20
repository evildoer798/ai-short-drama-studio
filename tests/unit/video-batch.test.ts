import { describe, expect, it } from 'vitest'
import {
  estimateSequentialVideoBatchSeconds,
  fitVideoGroupDurations,
  groupSingleEpisodeVideoBatch,
  normalizeVideoDuration,
  orderSingleEpisodeVideoBatch,
  storyboardSceneIdentity,
  videoDurationOptions,
} from '@/lib/video-batch'

const shot = (episodeId: string | null, episodeSceneNumber: number, duration = 5, sceneKey = 'scene-a') => ({
  id: `${episodeId}-${episodeSceneNumber}`,
  episodeId,
  episodeSceneNumber,
  sceneNumber: episodeSceneNumber,
  duration,
  sceneKey,
})

describe('sequential video batches', () => {
  it('builds a complete slider axis that always reaches 15 seconds', () => {
    expect(videoDurationOptions(4, 15, null)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(videoDurationOptions(6, 15, [15, 6, 10, 15])).toEqual([6, 10, 15])
  })

  it('derives a stable scene label and key from storyboard notes', () => {
    const scene = storyboardSceneIdentity({
      notes: '清晨｜高档小区门口\n接续上一镜尾帧：林晨站在岗亭外。',
      locationNames: ['高档小区门口'],
    })
    expect(scene.label).toBe('高档小区门口')
    expect(scene.key).toBe('清晨高档小区门口')
  })

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

  it('starts a new video before the real timeline would exceed 15 seconds', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 5),
      shot('episode-1', 2, 6),
      shot('episode-1', 3, 5),
      shot('episode-1', 4, 4),
    ], 3)

    expect(groups.map((group) => group.map((item) => item.episodeSceneNumber))).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('never compresses four 4-second shots into one 15-second video', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 4),
      shot('episode-1', 2, 4),
      shot('episode-1', 3, 4),
      shot('episode-1', 4, 4),
    ], 4)
    const fitted = fitVideoGroupDurations(groups[0].map((item) => item.duration), 15)

    expect(groups.map((group) => group.map((item) => item.episodeSceneNumber))).toEqual([
      [1, 2, 3],
      [4],
    ])
    expect(fitted.duration).toBe(12)
    expect(fitted.sourceDuration).toBe(12)
    expect(fitted.timelineDurations).toEqual([4, 4, 4])
  })

  it('uses the next supported model duration without stretching the story timeline', () => {
    const fitted = fitVideoGroupDurations([4, 4, 4], 15, [6, 10, 15], 6)

    expect(fitted.duration).toBe(15)
    expect(fitted.sourceDuration).toBe(12)
    expect(fitted.timelineDurations).toEqual([4, 4, 4])
    expect(normalizeVideoDuration(4, 6, 15, [6, 10, 15])).toBe(6)
    expect(normalizeVideoDuration(12, 6, 15, [6, 10, 15])).toBe(15)
  })

  it('keeps continuous Seedance durations unchanged', () => {
    expect(fitVideoGroupDurations([4, 4, 4], 15, null, 4)).toMatchObject({
      duration: 12,
      timelineDurations: [4, 4, 4],
    })
  })

  it('does not let a user-selected duration compress the source timeline', () => {
    const fitted = fitVideoGroupDurations([4, 4, 4], 15, null, 4, 10)

    expect(fitted.duration).toBe(12)
    expect(fitted.timelineDurations).toEqual([4, 4, 4])
  })

  it('combines adjacent short storyboards across scene changes when the total fits 15 seconds', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 4, 'lobby'),
      shot('episode-1', 2, 4, 'lobby'),
      shot('episode-1', 3, 4, 'subway'),
    ], 4)

    expect(groups.map((group) => group.map((item) => item.episodeSceneNumber))).toEqual([
      [1, 2, 3],
    ])
    expect(groups[0].reduce((total, item) => total + item.duration, 0)).toBe(12)
  })

  it('keeps an exact 15-second same-scene block unchanged', () => {
    const groups = groupSingleEpisodeVideoBatch([
      shot('episode-1', 1, 4),
      shot('episode-1', 2, 4),
      shot('episode-1', 3, 4),
      shot('episode-1', 4, 3),
    ], 4)

    expect(groups).toHaveLength(1)
    expect(groups[0].reduce((total, item) => total + item.duration, 0)).toBe(15)
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

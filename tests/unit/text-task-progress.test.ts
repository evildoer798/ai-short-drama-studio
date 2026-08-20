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
        reviewRound: 2,
        maximumReviewRounds: 3,
        modifiedShots: 5,
        remainingIssues: 2,
        fatalIssues: 1,
        warning: '仍有 1 项导演建议',
        suggestions: ['第 4 集分镜 2：保持人物站位后再继续动作'],
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
      reviewRound: 2,
      maximumReviewRounds: 3,
      modifiedShots: 5,
      remainingIssues: 2,
      fatalIssues: 1,
      warning: '仍有 1 项导演建议',
      suggestions: ['第 4 集分镜 2：保持人物站位后再继续动作'],
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

  it('exposes completed script repair warnings through the shared progress detail', () => {
    expect(textTaskProgressDetail({
      scriptQualityProgress: {
        phase: 'finalizing',
        completedEpisodes: 10,
        totalEpisodes: 10,
        completedSegments: 10,
        totalSegments: 10,
        activeEpisodeNumbers: [5, 10],
        activeRoutes: [],
        parallelism: 1,
        segmentParallelism: 1,
        reviewRound: 3,
        maximumReviewRounds: 3,
        modifiedShots: 6,
        remainingIssues: 2,
        fatalIssues: 0,
        warning: '已保存问题最少的剧本，可继续下一步',
      },
    })).toEqual(expect.objectContaining({
      phase: 'finalizing',
      completedEpisodes: 10,
      remainingIssues: 2,
      fatalIssues: 0,
      warning: '已保存问题最少的剧本，可继续下一步',
    }))
  })
})

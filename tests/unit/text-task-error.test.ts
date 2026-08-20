import { describe, expect, it } from 'vitest'
import { readableTextTaskError } from '../../src/lib/text-task-error'

describe('text task error messages', () => {
  it('hides Cloudflare HTML for gateway errors', () => {
    expect(readableTextTaskError('TEXT_API_FAILED: 502 <html>Bad gateway</html>')).toBe(
      '文本模型网关暂时中断（502/504）。系统已自动重试，小说原文仍已保存，请稍后重新生成。',
    )
  })

  it('keeps useful application errors', () => {
    expect(readableTextTaskError('模型没有返回可解析的 JSON 结果')).toBe('模型没有返回可解析的 JSON 结果')
  })

  it('turns fetch aborts into a resumable timeout message', () => {
    expect(readableTextTaskError('The operation was aborted due to timeout')).toContain('继续重试')
  })

  it('explains that an interrupted task can resume from its checkpoint', () => {
    expect(readableTextTaskError('TEXT_TASK_INTERRUPTED: stopped')).toContain('检查点仍然保留')
  })

  it('explains how to repair a storyboard and asset scene mismatch', () => {
    expect(readableTextTaskError(
      'SCENE_CONSISTENCY_MISMATCH: 以下分镜场景尚未生成同名资产：翡翠山庄34号客厅',
    )).toContain('翡翠山庄34号客厅')
  })

  it('does not misidentify which provider moderated a request', () => {
    const message = readableTextTaskError(
      'TEXT_API_FAILED: 400 Your prompt or reference material was rejected by content moderation.',
    )
    expect(message).toContain('备用线路')
    expect(message).not.toContain('沧元审核')
  })

  it('turns legacy forty-shot checkpoint validation dumps into a concise recovery action', () => {
    const message = readableTextTaskError(
      '已保存 0/1 集。[{"code":"too_big","maximum":40,"path":["episodeReviews",0,"currentShots"]}]',
    )
    expect(message).toContain('旧版检查点容量')
    expect(message).toContain('请重新生成')
    expect(message).not.toContain('too_big')
  })

  it('turns missing asset type validation into a resumable checkpoint message', () => {
    const message = readableTextTaskError(
      `[{"expected":"'character' | 'location' | 'prop'","received":"undefined","code":"invalid_type","path":["assets",0,"type"],"message":"Required"}]`,
    )

    expect(message).toContain('资产条目缺少类别字段')
    expect(message).toContain('检查点仍然保留')
    expect(message).not.toContain('invalid_type')
  })
})

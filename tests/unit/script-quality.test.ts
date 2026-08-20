import { describe, expect, it } from 'vitest'
import {
  auditScriptEpisodes,
  endingHookIssue,
  findDuplicateEpisodes,
  firstEpisodeColdOpenIssue,
  isSuspiciousTextReuse,
  removeRepeatedOpeningFromLaterEpisode,
  scriptQualityAuditScore,
  scriptQualityAuditWarnings,
  textReuseMetrics,
} from '../../src/lib/script-quality'

const sharedScene = [
  '苏文菁放下酒杯，走到林晨面前，平静说出推荐信背后的交换条件。',
  '林晨握紧玻璃杯，听见叔叔公司的贷款月底到期，掌心被杯壁硌得发疼。',
  '苏文菁打开书房抽屉，露出已经签名盖章的推荐信，要求林晨立刻作出选择。',
  '门锁发出一声闷响，林晨抬头看向楼梯，意识到自己已经没有轻易退出的机会。',
].join('。')

describe('script quality audit', () => {
  it('detects when one episode repeats a long completed scene from another episode', () => {
    const left = `【场次1】雨夜客厅\n${'林晨沿着雨幕抵达别墅。'.repeat(12)}${sharedScene}\n【结尾Hook】门外突然响起第二个人的脚步声。`
    const right = `【场次1】雨夜客厅\n${sharedScene}${'苏文菁转身走向书房，交易继续升级。'.repeat(10)}\n【结尾Hook】抽屉里还压着另一封署名陌生的信。`
    const metrics = textReuseMetrics(left, right)
    expect(isSuspiciousTextReuse(metrics)).toBe(true)
    expect(findDuplicateEpisodes([
      { episodeNumber: 1, content: left },
      { episodeNumber: 2, content: right },
    ])).toEqual([expect.objectContaining({ leftEpisode: 1, rightEpisode: 2 })])
  })

  it('excludes the explicitly marked first-episode flashforward from duplicate comparison', () => {
    const futureCrisis = '林晨推开地下室铁门，发现失踪的文件箱已经被烧毁，走廊尽头传来逼近的脚步声。'.repeat(3)
    const first = [
      '【倒叙冷开场】',
      futureCrisis,
      '【回到主线】',
      '林晨在雨夜接到最后一张外卖订单，骑车驶向陌生别墅。'.repeat(12),
      '【结尾Hook】订单备注里第一次出现了林晨的全名。',
    ].join('\n')
    const later = [
      '【场次1】地下室走廊',
      futureCrisis,
      '林晨没有后退，伸手按下墙边唯一亮着的红色按钮。'.repeat(10),
      '【结尾Hook】铁门另一侧传来苏文菁的声音。',
    ].join('\n')
    expect(firstEpisodeColdOpenIssue(first)).toBeNull()
    expect(findDuplicateEpisodes([
      { episodeNumber: 1, content: first },
      { episodeNumber: 18, content: later },
    ])).toEqual([])
  })

  it('requires a real ending hook and a marked first-episode cold open', () => {
    expect(endingHookIssue('林晨关上门。')).toContain('缺少')
    expect(endingHookIssue('林晨关上门。\n【结尾Hook】敬请期待下一集。')).toContain('说明性套话')
    expect(endingHookIssue('林晨关上门。\n【结尾Hook】门缝下缓缓滑进一张写着他全名的照片。')).toBeNull()
    expect(firstEpisodeColdOpenIssue('【场次1】雨夜，林晨接单。\n【结尾Hook】手机响了。')).toContain('缺少')
  })

  it('reports duplicate pairs, hook failures, cold-open failures, and duration outliers together', () => {
    const audit = auditScriptEpisodes([
      { episodeNumber: 1, content: `${'林晨沿雨夜走向别墅门廊。'.repeat(10)}${sharedScene}\n【结尾Hook】门外有人敲门。` },
      { episodeNumber: 2, content: `${sharedScene}${'苏文菁在客厅等待林晨回答。'.repeat(10)}\n【结尾Hook】抽屉突然自己弹开。` },
    ], 1.5)
    expect(audit.duplicatePairs).toHaveLength(1)
    expect(audit.firstEpisodeColdOpenIssue).not.toBeNull()
    expect(audit.lengthIssues.length).toBeGreaterThan(0)
  })

  it('removes a repeated opening scene from the later episode and keeps its first new action', () => {
    const previous = [
      '【场次2】夜晚，仓库派对。',
      '陈蕊拉着林晨穿过人群，把林晨介绍给朋友。',
      '银发男生起哄，陈蕊把韩国女生拉开。',
      '林晨抓住陈蕊的手，劝陈蕊不要继续。',
      '陈蕊质问学习到底有什么用。',
      '【结尾Hook】陈蕊的话说到一半，突然停住。',
    ].join('\n\n')
    const later = [
      '【场次1】夜晚，仓库派对。',
      '陈蕊拉着林晨穿过人群，把林晨介绍给朋友。',
      '银发男生起哄，陈蕊把韩国女生拉开。',
      '林晨抓住陈蕊的手，劝陈蕊不要继续。',
      '陈蕊质问学习到底有什么用。',
      '陈蕊抓起桌上的啤酒，第一次说出自己无法毕业的真相。',
      '花衬衫男生递来违禁品，林晨立即挡在两人之间。',
      '【结尾Hook】林晨拉着陈蕊冲出派对。',
    ].join('\n\n')
    const trimmed = removeRepeatedOpeningFromLaterEpisode(previous, later)
    expect(trimmed).toContain('【场次1】夜晚，仓库派对。')
    expect(trimmed).toContain('陈蕊抓起桌上的啤酒')
    expect(trimmed).toContain('花衬衫男生递来违禁品')
    expect(trimmed).not.toContain('银发男生起哄')
  })

  it('scores repair candidates and summarizes residual findings without blocking output', () => {
    const lengthOnly = {
      duplicatePairs: [],
      missingHooks: [],
      lengthIssues: [{ episodeNumber: 5, characterCount: 500, minimum: 700, maximum: 3000 }],
      firstEpisodeColdOpenIssue: null,
    }
    const missingHook = {
      duplicatePairs: [],
      missingHooks: [{ episodeNumber: 5, reason: '缺少结尾钩子' }],
      lengthIssues: [],
      firstEpisodeColdOpenIssue: null,
    }

    expect(scriptQualityAuditScore(lengthOnly)).toBeLessThan(scriptQualityAuditScore(missingHook))
    expect(scriptQualityAuditWarnings(lengthOnly)).toEqual(['篇幅待确认：第 5 集'])
  })
})

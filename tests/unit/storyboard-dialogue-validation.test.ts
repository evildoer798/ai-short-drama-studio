import { describe, expect, it } from 'vitest'
import {
  repairExactFinalStoryboardDialogueDuplicates,
  validateFinalStoryboardDialogue,
} from '@/lib/storyboard-dialogue-validation'

function document(number: number, timeline: string) {
  return {
    id: `shot-${number}`,
    number,
    title: `分镜${number}`,
    videoPrompt: `【风格基调】\n写实。\n【视频分镜】\n${timeline}`,
  }
}

describe('final storyboard dialogue validation', () => {
  it('detects exact dialogue repeated across adjacent final prompts', () => {
    const issues = validateFinalStoryboardDialogue([
      document(7, '0~5s：林夏：“我这不是备胎是什么？三年感情喂了狗，及时止损。”'),
      document(8, '0~5s：林夏：“我这不是备胎是什么？三年感情喂了狗，及时止损。”'),
    ], '林夏：我这不是备胎是什么？三年感情喂了狗，及时止损。')

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'exact_duplicate', shotNumbers: [7, 8] })
  })

  it('detects dialogue repeated far apart across the full episode', () => {
    const issues = validateFinalStoryboardDialogue([
      document(1, '0~5s：顾玉荣：“什么叫无关紧要！那我打你电话你干嘛不接！？”'),
      document(2, '0~5s：林夏：“我当骚扰电话了。”'),
      document(13, '0~5s：顾玉荣：“什么叫无关紧要！那我打你电话你干嘛不接！？”'),
    ], '顾玉荣：什么叫无关紧要！那我打你电话你干嘛不接！？\n林夏：我当骚扰电话了。')

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'exact_duplicate', shotNumbers: [1, 13] })
  })

  it('detects contained repetition inside one final prompt', () => {
    const issues = validateFinalStoryboardDialogue([
      document(7, [
        '0~5s：林夏：“三年感情喂了狗，及时止损。”',
        '5~10s：林夏：“我这不是备胎是什么？三年感情喂了狗，及时止损。”',
      ].join('\n')),
    ], '林夏：我这不是备胎是什么？三年感情喂了狗，及时止损。')

    expect(issues.some((issue) => issue.kind === 'overlap_duplicate')).toBe(true)
  })

  it('removes only the later exact duplicate and leaves a valid prompt', () => {
    const repaired = repairExactFinalStoryboardDialogueDuplicates([
      document(19, '0~5s：陈浩：“这个美女好像在朝我们走来诶！”'),
      document(20, '0~5s：近景；陈浩：“这个美女好像在朝我们走来诶！”；众人看向前方。'),
    ], '陈浩：这个美女好像在朝我们走来诶！')

    expect(repaired.changedDocumentIds).toEqual(['shot-20'])
    expect(repaired.issues).toEqual([])
    expect(repaired.documents[1].videoPrompt).not.toContain('这个美女好像在朝我们走来诶')
    expect(repaired.documents[1].videoPrompt).toContain('众人看向前方')
  })

  it('allows a line to repeat when the locked script explicitly repeats it', () => {
    const issues = validateFinalStoryboardDialogue([
      document(1, '0~5s：林夏：“等等，别走。”'),
      document(2, '0~5s：林夏：“等等，别走。”'),
    ], '林夏：等等，别走。\n林夏：等等，别走。')

    expect(issues).toEqual([])
  })
})

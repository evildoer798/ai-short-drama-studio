import { describe, expect, it } from 'vitest'
import {
  continuityReferenceInstruction,
  isImmediatePreviousStoryboard,
  previousStoryboardInSequence,
  shouldUsePreviousTailFrame,
  storyboardContinuityStateIssues,
  type StoryboardContinuityState,
} from '@/lib/storyboard-continuity'
import { buildStoryboardVideoPrompt } from '@/lib/storyboards'
import { AssetType, VisualStyle } from '@prisma/client'

function state(patch: Partial<StoryboardContinuityState> = {}): StoryboardContinuityState {
  return {
    version: 1,
    transitionType: 'same_scene_continuous',
    scene: '庄园走廊',
    cameraAxis: '摄影机固定在走廊门侧轴线',
    cameraSide: 'right',
    characters: [],
    completedActions: [],
    plannedActions: [],
    summary: '',
    ...patch,
  }
}

describe('storyboard tail-frame continuity', () => {
  it('only accepts the immediately preceding storyboard in the same episode', () => {
    const current = { episodeId: 'episode-1', episodeSceneNumber: 5, sceneNumber: 105 }
    expect(isImmediatePreviousStoryboard(current, {
      episodeId: 'episode-1', episodeSceneNumber: 4, sceneNumber: 104,
    })).toBe(true)
    expect(isImmediatePreviousStoryboard(current, {
      episodeId: 'episode-1', episodeSceneNumber: 3, sceneNumber: 103,
    })).toBe(false)
    expect(isImmediatePreviousStoryboard(current, {
      episodeId: 'episode-2', episodeSceneNumber: 4, sceneNumber: 204,
    })).toBe(false)
  })

  it('uses the previous episode final storyboard for the next episode opening', () => {
    const storyboards = [
      { id: 'ep-2-shot-2', episodeId: 'ep-2', episodeSceneNumber: 2, sceneNumber: 202, episode: { episodeNumber: 2 } },
      { id: 'ep-1-shot-8', episodeId: 'ep-1', episodeSceneNumber: 8, sceneNumber: 108, episode: { episodeNumber: 1 } },
      { id: 'ep-2-shot-1', episodeId: 'ep-2', episodeSceneNumber: 1, sceneNumber: 201, episode: { episodeNumber: 2 } },
      { id: 'ep-1-shot-7', episodeId: 'ep-1', episodeSceneNumber: 7, sceneNumber: 107, episode: { episodeNumber: 1 } },
    ]

    expect(previousStoryboardInSequence(storyboards, { id: 'ep-2-shot-1' })?.id).toBe('ep-1-shot-8')
    expect(previousStoryboardInSequence(storyboards, { id: 'ep-2-shot-2' })?.id).toBe('ep-2-shot-1')
    expect(previousStoryboardInSequence(storyboards, { id: 'ep-1-shot-7' })).toBeNull()
  })

  it('enables same-scene continuous motion but disables reverse shots and scene changes', () => {
    const previous = {
      id: 'shot-4', episodeId: 'episode-1', episodeSceneNumber: 4, sceneNumber: 104,
      notes: '夜晚｜庄园走廊', continuityOut: state(),
    }
    const current = {
      id: 'shot-5', episodeId: 'episode-1', episodeSceneNumber: 5, sceneNumber: 105,
      notes: '夜晚｜庄园走廊', continuityIn: state(),
    }
    expect(shouldUsePreviousTailFrame(previous, current)).toBe(true)
    expect(shouldUsePreviousTailFrame(previous, {
      ...current,
      continuityIn: state({ transitionType: 'reverse_shot' }),
    })).toBe(false)
    expect(shouldUsePreviousTailFrame(previous, {
      ...current,
      notes: '夜晚｜庄园门外',
      continuityIn: null,
    })).toBe(false)
    expect(shouldUsePreviousTailFrame(previous, {
      ...current,
      continuityIn: null,
      videoPrompt: '【风格基调】优先使用正反打。\n【视频分镜】0~15s：克莱尔继续注视高台。',
    })).toBe(true)
    expect(shouldUsePreviousTailFrame(previous, {
      ...current,
      continuityIn: null,
      videoPrompt: '【视频分镜】0~15s：反打达米安的正面近景。',
    })).toBe(false)
  })

  it('catches side jumps, movement reversals, restored contact, repeated actions and prop transfers', () => {
    const previous = state({
      characters: [
        {
          name: '克莱尔·摩根', screenPosition: 'right', facing: '侧身', gazeTarget: '达米安·克劳',
          leftHand: '左手已松开', rightHand: '右手提医药箱', contacts: [],
          heldProps: ['医药箱'], movementDirection: 'away_from_camera',
        },
        {
          name: '达米安·克劳', screenPosition: 'left', facing: '背对镜头', gazeTarget: '',
          leftHand: '', rightHand: '', contacts: [], heldProps: [], movementDirection: 'away_from_camera',
        },
      ],
      completedActions: ['release:克莱尔·摩根|达米安·克劳', 'turn:克莱尔·摩根'],
    })
    const current = state({
      characters: [
        {
          name: '克莱尔·摩根', screenPosition: 'left', facing: '正对镜头', gazeTarget: '达米安·克劳',
          leftHand: '左手抓住达米安右臂', rightHand: '',
          contacts: ['克莱尔·摩根|达米安·克劳'], heldProps: [], movementDirection: 'toward_camera',
        },
        {
          name: '达米安·克劳', screenPosition: 'right', facing: '正对镜头', gazeTarget: '',
          leftHand: '', rightHand: '右手提医药箱', contacts: ['克莱尔·摩根|达米安·克劳'],
          heldProps: ['医药箱'], movementDirection: 'toward_camera',
        },
      ],
      plannedActions: ['turn:克莱尔·摩根'],
    })
    const issues = storyboardContinuityStateIssues(previous, current)
    expect(issues.join('\n')).toContain('无过程跳到')
    expect(issues.join('\n')).toContain('移动方向与上一镜相反')
    expect(issues.join('\n')).toContain('已经解除的接触')
    expect(issues.join('\n')).toContain('被重复执行')
    expect(issues.join('\n')).toContain('无过程转移')
  })

  it('declares the tail frame once in the scene section of a structured prompt', () => {
    const prompt = buildStoryboardVideoPrompt({
      title: '走廊承接',
      videoPrompt: [
        '【风格基调】海外真人短剧。',
        '【人物及初始站位】克莱尔·摩根站在画面右侧。',
        '【场景】夜晚庄园走廊。',
        '【视频分镜】0~15s：克莱尔·摩根沿走廊向前走。',
      ].join('\n'),
      visualStyle: VisualStyle.overseas_live_action,
      maxLength: 4900,
      references: [
        { referenceOrder: 1, type: AssetType.character, name: '克莱尔·摩根' },
        { referenceOrder: 2, type: AssetType.location, name: '庄园走廊' },
        { referenceOrder: 3, type: 'continuity', name: '上一镜尾帧' },
      ],
    })
    const instruction = continuityReferenceInstruction(3)
    expect(prompt.split(instruction)).toHaveLength(2)
    expect(prompt.indexOf('【场景】')).toBeLessThan(prompt.indexOf(instruction))
    expect(prompt.indexOf(instruction)).toBeLessThan(prompt.indexOf('【视频分镜】'))
  })

  it('uses visual-only continuity across scene or episode boundaries', () => {
    const instruction = continuityReferenceInstruction(5, 'visual')
    expect(instruction).toContain('同名人物的外观、服装、道具和结束情绪')
    expect(instruction).toContain('不得带入尾帧中的旧场景')
    expect(instruction).toContain('本镜未出场人物')
    expect(instruction).not.toContain('继承人物站位')
  })
})

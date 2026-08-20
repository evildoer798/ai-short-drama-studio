import { describe, expect, it } from 'vitest'
import {
  characterAppearsInStoryboardFrame,
  visibleStoryboardTimelineCharacters,
} from '@/lib/storyboard-cast'

describe('storyboard cast recognition', () => {
  it('recognizes only characters actually present in a legacy timeline without in-frame labels', () => {
    const videoPrompt = [
      '【本分镜人物】',
      '林夏、顾玉荣、陆野、陈浩、吕嘉豪。',
      '【视频分镜】',
      '0~7s：林夏固定机位近景，接听顾玉荣电话。',
      '7~15s：顾玉荣回应，林夏皱眉追问。',
    ].join('\n')
    const knownCharacterNames = ['林夏', '顾玉荣', '陆野', '陈浩', '吕嘉豪']

    expect(visibleStoryboardTimelineCharacters({ videoPrompt, knownCharacterNames }))
      .toEqual(['林夏', '顾玉荣'])
    expect(characterAppearsInStoryboardFrame(videoPrompt, '陆野')).toBe(false)
  })

  it('does not count background characters that wait without dialogue or action', () => {
    const videoPrompt = [
      '【视频分镜】',
      '0~15s：林夏质问顾玉荣；陆野在背景等待，不参与动作。',
    ].join('\n')

    expect(visibleStoryboardTimelineCharacters({
      videoPrompt,
      knownCharacterNames: ['林夏', '顾玉荣', '陆野'],
    })).toEqual(['林夏', '顾玉荣'])
  })

  it('uses an explicit in-frame list as the source of truth', () => {
    const videoPrompt = [
      '【视频分镜】',
      '0~15s：镜内：林夏、顾玉荣；画外：陆野；陆野通过电话说话。',
    ].join('\n')

    expect(visibleStoryboardTimelineCharacters({
      videoPrompt,
      knownCharacterNames: ['林夏', '顾玉荣', '陆野', '陈浩', '吕嘉豪'],
    })).toEqual(['林夏', '顾玉荣'])
  })

  it('matches the canonical name when an asset name contains a note', () => {
    const videoPrompt = '【视频分镜】\n0~15s：顾玉荣接起电话，随后看向林夏。'

    expect(characterAppearsInStoryboardFrame(videoPrompt, '顾玉荣（顾老师）')).toBe(true)
  })
})

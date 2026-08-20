import { describe, expect, it } from 'vitest'
import {
  storyboardRevisionContentHash,
  storyboardRevisionRestoreData,
  storyboardRevisionSnapshot,
} from '@/lib/storyboard-revisions'

const source = {
  title: '原分镜',
  notes: '宿舍走廊',
  imagePrompt: null,
  directorPrompt: '分镜1：\n景别机位运动：中景固定。\n画面内容：夜晚，宿舍走廊。\n动作对白：林夏开口。',
  videoPrompt: '【视频分镜】\n0~5s：林夏开口。',
  duration: 15,
  aspectRatio: '16:9',
  generateAudio: true,
  continuityIn: { position: 'left' },
  continuityOut: null,
}

describe('storyboard revisions', () => {
  it('creates a stable content hash for an immutable snapshot', () => {
    const snapshot = storyboardRevisionSnapshot(source)
    expect(storyboardRevisionContentHash(snapshot)).toBe(storyboardRevisionContentHash({ ...snapshot }))
    expect(storyboardRevisionContentHash({ ...snapshot, title: '修改后' })).not.toBe(
      storyboardRevisionContentHash(snapshot),
    )
  })

  it('restores every user-editable storyboard field', () => {
    expect(storyboardRevisionRestoreData(storyboardRevisionSnapshot(source))).toMatchObject({
      title: source.title,
      notes: source.notes,
      directorPrompt: source.directorPrompt,
      videoPrompt: source.videoPrompt,
      duration: 15,
      aspectRatio: '16:9',
      generateAudio: true,
    })
  })
})

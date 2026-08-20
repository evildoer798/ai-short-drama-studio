import { describe, expect, it } from 'vitest'
import { parseCompletedScreenplay } from '@/lib/screenplay-import'

describe('parseCompletedScreenplay', () => {
  it('imports a completed episodic screenplay without rewriting episode bodies', () => {
    const source = [
      '剧本摘要',
      '自定义集数',
      '3',
      '## 第1集：公开背叛',
      '### 场1-1',
      '夜 外 黑松庄园广场',
      '克莱尔：达米安，艾玛在哪？',
      '## 第2集：断崖清算',
      '### 场2-1',
      '夜 内 议会临时关押区',
      '△ 克莱尔打开铁门。',
      '## 第3集：白狼觉醒',
      '### 场3-1',
      '夜 外 月光悬崖',
      '△ 克莱尔坠入崖下海面。',
    ].join('\r\n')

    expect(parseCompletedScreenplay(source)).toEqual({
      episodes: [
        {
          episodeNumber: 1,
          title: '公开背叛',
          content: '### 场1-1\n夜 外 黑松庄园广场\n克莱尔：达米安，艾玛在哪？',
        },
        {
          episodeNumber: 2,
          title: '断崖清算',
          content: '### 场2-1\n夜 内 议会临时关押区\n△ 克莱尔打开铁门。',
        },
        {
          episodeNumber: 3,
          title: '白狼觉醒',
          content: '### 场3-1\n夜 外 月光悬崖\n△ 克莱尔坠入崖下海面。',
        },
      ],
    })
  })

  it('does not classify prose or an incomplete episode sequence as a completed screenplay', () => {
    expect(parseCompletedScreenplay('第一章\n这是一段尚未分集的小说正文。')).toBeNull()
    expect(parseCompletedScreenplay([
      '## 第1集：第一集',
      '### 场1-1',
      '第一集内容',
      '## 第3集：第三集',
      '### 场3-1',
      '第三集内容',
    ].join('\n'))).toBeNull()
  })

  it('requires every detected episode to contain a screenplay scene heading', () => {
    expect(parseCompletedScreenplay([
      '## 第1集：第一集',
      '### 场1-1',
      '第一集内容',
      '## 第2集：第二集',
      '这只是剧情梗概，没有场次。',
    ].join('\n'))).toBeNull()
  })
})

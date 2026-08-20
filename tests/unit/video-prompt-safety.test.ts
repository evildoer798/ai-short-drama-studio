import { describe, expect, it } from 'vitest'
import {
  hasAnthropomorphicAssetDescription,
  prepareVideoPromptForProvider,
  readableVideoModerationError,
  readableVideoProviderError,
  readableVideoReferenceError,
  readableVideoTaskError,
  shouldOmitVideoLocationReference,
} from '@/lib/video-prompt-safety'

describe('hasAnthropomorphicAssetDescription', () => {
  it('ignores negative constraints that prohibit animal features', () => {
    expect(hasAnthropomorphicAssetDescription(
      '狼族与 Alpha 仅是身份，未明确变身时必须是完整真人外观，禁止狼头人身、兽耳、长吻、全身兽毛或兽爪。',
    )).toBe(false)
  })

  it('detects a positive anthropomorphic appearance description', () => {
    expect(hasAnthropomorphicAssetDescription(
      '议会长老为拟人狼形态，尖耳、长吻、灰白色狼毛，双足站立。',
    )).toBe(true)
  })

  it('does not mistake a wolf-head accessory for the actor having a wolf head', () => {
    expect(hasAnthropomorphicAssetDescription(
      '40岁白人男性，完整真人外观，左手佩戴银色狼头戒指，西装笔挺。',
    )).toBe(false)
  })
})

describe('prepareVideoPromptForProvider', () => {
  it('softens graphic wording without changing scene, dialogue, action outcome, or continuity', () => {
    const source = [
      '【人物及初始站位】',
      '@image1：角色“克莱尔·摩根”；@image2：角色“达米安·克劳”。',
      '【视频分镜】',
      '0~3s：克莱尔死死抠住崖边，指尖渗血。克莱尔：“Why...”',
      '3~10s：达米安：“Twenty years ago, Gideon and I sealed your power. You were only a tool.”',
      '10~15s：崖边石块突然断裂，克莱尔身体连续向下坠落，不得再次回到崖边。伴随碎石坠落声，画面切黑。',
    ].join('\n')

    const result = prepareVideoPromptForProvider(source)

    expect(result.adjusted).toBe(true)
    expect(result.replacementCount).toBeGreaterThanOrEqual(3)
    expect(result.prompt).toContain('@image1：角色“克莱尔·摩根”')
    expect(result.prompt).toContain('@image2：角色“达米安·克劳”')
    expect(result.prompt).toContain('0~3s：')
    expect(result.prompt).toContain('3~10s：')
    expect(result.prompt).toContain('10~15s：')
    expect(result.prompt).toContain('克莱尔：“Why...”')
    expect(result.prompt).toContain('Twenty years ago, Gideon and I sealed your power. You were only a tool.')
    expect(result.prompt.indexOf('3~10s：')).toBeLessThan(result.prompt.indexOf('10~15s：'))
    expect(result.prompt).toContain('指尖因持续用力而发红')
    expect(result.prompt).toContain('月光悬崖')
    expect(result.prompt).toContain('身体沿月光悬崖垂直方向持续下落并离开画面')
    expect(result.prompt).toContain('不得再次回到崖边')
    expect(result.prompt).toContain('画面切黑')
    expect(result.prompt).not.toMatch(/指尖渗血|死死抠住|碎石坠落声/u)
  })

  it('keeps an ordinary prompt byte-for-byte unchanged', () => {
    const source = '0~5s：@image1 站在窗边轻轻回头，用自然美式英语说：“Good morning.”'
    expect(prepareVideoPromptForProvider(source)).toEqual({
      prompt: source,
      adjusted: false,
      replacementCount: 0,
    })
  })

  it('removes repeated static prompt lines without deleting repeated timeline dialogue', () => {
    const source = [
      '【风格基调】',
      '项目统一画风：真人写实。',
      '项目统一画风：真人写实。',
      '【人物及初始站位】',
      '达米安：高大冷漠，西装，拥着西耶娜。',
      '达米安：高大冷漠，西装，拥着西耶娜。',
      '【场景】',
      '庄园走廊。',
      '【视频分镜】',
      '0~5s：达米安说：“Wait.”',
      '5~10s：达米安再次说：“Wait.”',
    ].join('\n')

    const result = prepareVideoPromptForProvider(source)

    expect(result.adjusted).toBe(true)
    expect(result.replacementCount).toBe(0)
    expect(result.prompt.match(/项目统一画风：真人写实。/gu)).toHaveLength(1)
    expect(result.prompt.match(/达米安：高大冷漠，西装，拥着西耶娜。/gu)).toHaveLength(1)
    expect(result.prompt).toContain('0~5s：达米安说：“Wait.”')
    expect(result.prompt).toContain('5~10s：达米安再次说：“Wait.”')
  })

  it('preserves the rejected eight-second cliff story instead of replacing it with a fantasy fade', () => {
    const source = [
      '克莱尔·摩根位于岩石平台边缘，双手保持支撑，身体面向岩壁。',
      '达米安·克劳站在克莱尔后上方的较高岩面。',
      '达米安·克劳说：“You were just a tool.” 对白结束后，克莱尔手部支撑开始松动。',
      '达米安·克劳保持画外，不出现身体、脸、倒影、镜像或背景复制。',
      '克莱尔沿垂直方向连续向下移出画面，白狼虚影闪现，画面直接切黑。',
    ].join('\n')

    const result = prepareVideoPromptForProvider(source)

    expect(result.prompt).toContain('岩石平台边缘')
    expect(result.prompt).toContain('手部支撑开始松动')
    expect(result.prompt).toContain('You were just a tool.')
    expect(result.prompt).toContain('沿垂直方向连续向下移出画面')
    expect(result.prompt).toContain('画面直接切黑')
    expect(result.prompt).not.toMatch(/白狼银光包围|柔和淡出|月光石台中央/u)
  })
})

describe('readableVideoModerationError', () => {
  it('maps the provider moderation payload to a concise Chinese explanation', () => {
    const message = readableVideoModerationError(
      'VIDEO_API_ERROR: HTTP 400: {"code":"sensitive_words_detected","message":"Your prompt or reference material was rejected by content moderation."}',
    )
    expect(message).toContain('内容审核拒绝')
    expect(message).toContain('不是服务器、OSS 或 API Key 故障')
    expect(message).not.toContain('VIDEO_API_ERROR')
  })

  it('does not hide unrelated provider errors', () => {
    expect(readableVideoModerationError('VIDEO_API_ERROR: HTTP 403: no access')).toBeNull()
  })
})

describe('readableVideoReferenceError', () => {
  it('separates an OSS reference download failure from moderation errors', () => {
    const message = readableVideoReferenceError(
      'VIDEO_TASK_FAILED: {"fail_reason":"could not fetch Seedance image reference"}',
    )
    expect(message).toContain('无法下载 OSS 参考图')
    expect(message).toContain('不是内容审核或 API Key 权限问题')
  })
})

describe('readableVideoProviderError', () => {
  it('explains the four-image limit returned by the provider', () => {
    expect(readableVideoProviderError(
      'status_code=400, {"error":{"message":"参考图最多4张，当前5张，请减少后重试"}}',
    )).toContain('最多支持 4 张参考图')
  })

  it('summarizes a repeated generic upstream failure', () => {
    const rawError = 'VIDEO_TASK_FAILED: {"message":"视频生成失败，上游未提供具体原因。本次参考素材已成功上传","fail_reason":"视频生成失败，上游未提供具体原因。本次参考素材已成功上传"}'
    const message = readableVideoProviderError(rawError)

    expect(message).toBe('上游未完成视频生成，参考素材上传正常。系统会自动重试最多 3 次；多次失败通常是提示词或参考图语义冲突。')
    expect(message).not.toContain('VIDEO_TASK_FAILED')
    expect(message).not.toContain('fail_reason')
  })

  it('explains a face-locked model without blaming the assets or key', () => {
    expect(readableVideoProviderError(
      'Reference images contain real human faces, which this model does not support.',
    )).toContain('不支持真人面孔参考图')
  })

  it('explains an upstream adapter failure and the automatic key failover', () => {
    const message = readableVideoProviderError(
      "All cookies failed: field 'generate' not found in type: 'mutation_root'",
    )
    expect(message).toContain('供应商')
    expect(message).toContain('备用 API Key')
  })

  it('separates provider execution-pool credits from the user API key balance', () => {
    const message = readableVideoProviderError(
      'All cookies failed: insufficient credits (need 4536, have 1244)',
    )
    expect(message).toContain('供应商内部执行账号')
    expect(message).toContain('不是你的 API Key 余额不足')
  })
})

describe('readableVideoTaskError', () => {
  it('把用户取消显示为可理解的状态', () => {
    expect(readableVideoTaskError('VIDEO_TASK_CANCELLED: 用户取消了该任务。'))
      .toBe('视频生成已取消，未保存该任务的生成结果。')
  })

  it('never exposes unknown raw provider payloads in the interface', () => {
    const rawError = 'VIDEO_TASK_FAILED: {"message":"opaque internal failure","metadata":{"debug":"very long internal details"}}'

    expect(readableVideoTaskError(rawError)).toBe('视频生成失败，服务暂未提供可用原因。请稍后重新生成。')
  })
})

describe('shouldOmitVideoLocationReference', () => {
  it('retains the exact storyboard location reference for scene continuity', () => {
    expect(shouldOmitVideoLocationReference('月光悬崖')).toBe(false)
    expect(shouldOmitVideoLocationReference('纽约公寓客厅')).toBe(false)
  })
})

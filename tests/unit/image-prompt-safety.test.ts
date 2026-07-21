import { describe, expect, it } from 'vitest'
import {
  containsImagePolicyRisk,
  prepareAssetImagePrompt,
} from '@/lib/image-prompt-safety'

describe('prepareAssetImagePrompt', () => {
  it('keeps ordinary asset prompts unchanged', () => {
    const prompt = '真人写实角色身份卡。成年女性，深色职业西装，白色背景三视图。'
    expect(prepareAssetImagePrompt({
      prompt,
      assetName: '角色甲',
      assetType: 'character',
    })).toEqual({
      prompt,
      adjusted: false,
      removedSegments: 0,
    })
  })

  it('removes temporary graphic story states while preserving identity details', () => {
    const result = prepareAssetImagePrompt({
      prompt: '真人写实角色身份卡。成年外卖员，短黑发，荧光绿马甲。车祸后左腿重伤，裤管渗血。白色背景三视图，服装一致。',
      assetName: '外卖员',
      assetType: 'character',
    })

    expect(result.adjusted).toBe(true)
    expect(result.removedSegments).toBeGreaterThan(0)
    expect(result.prompt).toContain('成年外卖员，短黑发，荧光绿马甲')
    expect(result.prompt).not.toMatch(/车祸|重伤|渗血/)
  })

  it('detects common Chinese and English policy-risk details', () => {
    expect(containsImagePolicyRisk('嘴角叼着一支烟')).toBe(true)
    expect(containsImagePolicyRisk('graphic blood and wound')).toBe(true)
    expect(containsImagePolicyRisk('普通职业装三视图')).toBe(false)
  })
})

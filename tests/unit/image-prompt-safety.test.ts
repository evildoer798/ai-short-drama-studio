import { describe, expect, it } from 'vitest'
import {
  containsImagePolicyRisk,
  prepareAssetImagePrompt,
  prepareImagePolicyFallbackPrompt,
  prepareImagePolicyRetryPrompt,
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
    expect(containsImagePolicyRisk('酒柜内摆放酒瓶')).toBe(true)
    expect(containsImagePolicyRisk('普通职业装三视图')).toBe(false)
  })

  it('neutralizes alcohol display terms without deleting the scene details', () => {
    const result = prepareAssetImagePrompt({
      prompt: '雨夜独栋别墅，花岗岩外墙湿润，酒柜内酒瓶半透明，壁炉假火映亮玻璃茶几，窗内暖光照亮皮质沙发。',
      assetName: '翡翠山庄34号·雨夜',
      assetType: 'location',
    })

    expect(result.adjusted).toBe(true)
    expect(result.prompt).toContain('花岗岩外墙湿润')
    expect(result.prompt).toContain('深色装饰陈列柜带半透明玻璃门')
    expect(result.prompt).toContain('墙面暖色装饰灯光')
    expect(result.prompt).not.toMatch(/酒柜|酒瓶|壁炉|假火/)
  })

  it('converts scene meta-instructions into a positive provider prompt', () => {
    const result = prepareAssetImagePrompt({
      prompt: [
        '不能出现其他人, 无人, 纯场景, 超写实真人影视风格。',
        '场景必须绝对真空与匿名，提示词必须以“不能出现其他人, 无人, 纯场景,”开头。',
        '雨夜皇后大桥，湿润桥面反射城市灯光，35mm电影镜头。no humans, empty, landscape only。',
      ].join('\n'),
      assetName: '皇后大桥·雨夜',
      assetType: 'location',
    })

    expect(result.adjusted).toBe(true)
    expect(result.prompt).toContain('建筑与环境为画面主体')
    expect(result.prompt).toContain('雨夜皇后大桥')
    expect(result.prompt).not.toMatch(/提示词必须以|不能出现其他人|no humans|empty/iu)
  })

  it('builds a compact positive retry prompt after a provider false positive', () => {
    const result = prepareImagePolicyRetryPrompt({
      prompt: '不能出现其他人, 无人, 纯场景, 雨夜皇后大桥，桥面湿润，城市灯光倒影。杜绝游戏CG感、错误透视。',
      assetName: '皇后大桥·雨夜',
      assetType: 'location',
    })

    expect(result).toContain('资产名称：皇后大桥·雨夜')
    expect(result).toContain('雨夜皇后大桥')
    expect(result).toContain('建筑环境是唯一视觉主体')
    expect(result).not.toMatch(/不能出现其他人|杜绝|no humans|empty/iu)
    expect(result.length).toBeLessThanOrEqual(1400)
  })

  it('builds an ultra-safe final fallback while retaining scene identity', () => {
    const result = prepareImagePolicyFallbackPrompt({
      prompt: '不能出现其他人, 无人, 纯场景, 雨夜独栋别墅，酒柜内酒瓶半透明，壁炉假火映亮玻璃茶几，落地窗透出暖黄灯光。杜绝错误透视。',
      assetName: '翡翠山庄34号·雨夜',
      assetType: 'location',
    })

    expect(result).toContain('翡翠山庄34号·雨夜')
    expect(result).toContain('根据名称和项目世界观设计建筑或自然环境')
    expect(result).not.toContain('落地窗透出暖黄灯光')
    expect(result).not.toMatch(/不能出现其他人|杜绝|酒柜|酒瓶|壁炉|假火|no humans|empty/iu)
    expect(containsImagePolicyRisk(result)).toBe(false)
    expect(result.length).toBeLessThanOrEqual(900)
  })
})

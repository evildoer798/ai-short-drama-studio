import { AssetType } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  buildDefaultPrompt,
  createAssetSchema,
  deriveAssetMetadata,
  detectUploadedImageMimeType,
  normalizeTags,
} from '@/lib/assets'

describe('asset validation', () => {
  it('accepts supported asset types', () => {
    const parsed = createAssetSchema.parse({
      projectId: 'project_1',
      type: 'character',
      name: '林见月',
      description: '年轻女主，冷静，雨夜登场',
      tags: ['女主', '现代'],
    })

    expect(parsed.type).toBe(AssetType.character)
  })

  it('rejects unsupported asset types', () => {
    expect(() => createAssetSchema.parse({
      projectId: 'project_1',
      type: 'voice',
      name: '旁白',
      description: '低沉男声',
      tags: [],
    })).toThrow()
  })

  it.each(['character', 'location', 'prop'] as const)('accepts a prompt-only %s asset', (type) => {
    const parsed = createAssetSchema.parse({
      projectId: 'project_1',
      type,
      prompt: '名称：测试资产。写实电影光影。',
      generateImmediately: true,
    })

    expect(parsed.prompt).toContain('测试资产')
  })

  it('rejects an asset without a prompt or legacy metadata', () => {
    expect(() => createAssetSchema.parse({
      projectId: 'project_1',
      type: 'character',
    })).toThrow('提示词不能为空')
  })

  it('deduplicates tags case-insensitively', () => {
    expect(normalizeTags(['Hero', ' hero ', '夜景'])).toEqual(['Hero', '夜景'])
  })

  it('builds default prompts with the asset description', () => {
    const prompt = buildDefaultPrompt({
      type: AssetType.location,
      name: '旧剧院',
      description: '荒废多年，霓虹灯半亮',
    })

    expect(prompt).toContain('location design')
    expect(prompt).toContain('旧剧院')
    expect(prompt).toContain('荒废多年')
  })

  it('derives character and location names from prompt labels', () => {
    expect(deriveAssetMetadata({
      type: AssetType.character,
      prompt: '角色 3：陈蕊（Jessica）\n18 岁，耶鲁学生。',
    }).name).toBe('陈蕊')
    expect(deriveAssetMetadata({
      type: AssetType.location,
      prompt: '场景名称：翡翠山庄客厅\n夜晚，暖黄落地灯。',
    }).name).toBe('翡翠山庄客厅')
  })

  it.each([
    ['JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['WebP', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), 'image/webp'],
  ])('recognizes an uploaded %s image from its file signature', (_label, bytes, expected) => {
    expect(detectUploadedImageMimeType(bytes)).toBe(expected)
  })

  it('rejects a renamed non-image upload', () => {
    expect(detectUploadedImageMimeType(new TextEncoder().encode('not an image'))).toBeNull()
  })
})

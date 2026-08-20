import { AssetType } from '@prisma/client'
import { z } from 'zod'

export const assetTypeSchema = z.nativeEnum(AssetType)

export const createAssetSchema = z.object({
  projectId: z.string().min(1),
  type: assetTypeSchema,
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  prompt: z.string().trim().min(1).max(8000).optional().nullable(),
  videoPrompt: z.string().trim().max(8000).optional().nullable(),
  generateImmediately: z.boolean().default(false),
}).superRefine((input, context) => {
  if (input.prompt || (input.name && input.description)) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['prompt'],
    message: '提示词不能为空',
  })
})

export const updateAssetSchema = z.object({
  type: assetTypeSchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  prompt: z.string().trim().max(8000).optional().nullable(),
  videoPrompt: z.string().trim().max(8000).optional().nullable(),
})

export const generateImagesSchema = z.object({
  prompt: z.string().trim().min(1).max(8000).optional(),
  count: z.coerce.number().int().min(1).max(4).default(1),
})

export const selectImageSchema = z.object({
  imageId: z.string().min(1),
})

export const assetImageUploadMaxBytes = 20 * 1024 * 1024

export function detectUploadedImageMimeType(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export function normalizeTags(tags: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

const fallbackAssetNames: Record<AssetType, string> = {
  [AssetType.character]: '新角色',
  [AssetType.location]: '新场景',
  [AssetType.prop]: '新道具',
}

const explicitNamePatterns: Record<AssetType, RegExp[]> = {
  [AssetType.character]: [
    /(?:姓名|角色名|人物名)\s*[:：]\s*([^\n，,。；;（(]{1,80})/i,
    /角色\s*\d*\s*[:：]\s*([^\n，,。；;（(]{1,80})/i,
  ],
  [AssetType.location]: [
    /(?:场景名称|场景名|地点名称|地点)\s*[:：]\s*([^\n，,。；;（(]{1,80})/i,
  ],
  [AssetType.prop]: [
    /(?:道具名称|道具名|物品名称)\s*[:：]\s*([^\n，,。；;（(]{1,80})/i,
  ],
}

function cleanDerivedName(value: string) {
  return value
    .trim()
    .replace(/^["'“”‘’《》【】\s]+|["'“”‘’《》【】\s]+$/g, '')
    .slice(0, 80)
}

export function deriveAssetMetadata(input: { type: AssetType, prompt: string }) {
  const prompt = input.prompt.trim()
  const explicitName = explicitNamePatterns[input.type]
    .map((pattern) => prompt.match(pattern)?.[1])
    .find(Boolean)
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  const fallbackCandidate = firstLine
    .replace(/^(?:请帮我|帮我|请|你现在要)?\s*(?:生成|创建|设计)(?:一张|一个|一位|一幅)?\s*/i, '')
    .split(/[。；;]/)[0]
    .slice(0, 32)
  const name = cleanDerivedName(explicitName || fallbackCandidate)
    || fallbackAssetNames[input.type]

  return {
    name,
    description: prompt,
    tags: [] as string[],
  }
}

export function buildDefaultPrompt(input: {
  type: AssetType
  name: string
  description: string
}) {
  const directive = {
    [AssetType.character]: '白色背景人物设定板，正面、侧面、背面全身三视图，面部与服装细节清晰。',
    [AssetType.location]: '电影级场景设定图，前中后景、材质、光源、色调、焦段、光圈和景深清晰。',
    [AssetType.prop]: '干净背景道具设定板，完整轮廓、尺寸、材质、正侧背视图和关键局部清晰。',
  }[input.type]

  return `资产名称：${input.name}。${input.description}。${directive}构图准确，主体清晰，真实材质与自然光影。`
}

export function assetImageUrl(mediaId: string) {
  return `/api/media/${encodeURIComponent(mediaId)}`
}

export function mediaDownloadUrl(mediaId: string) {
  return `${assetImageUrl(mediaId)}?download=1`
}

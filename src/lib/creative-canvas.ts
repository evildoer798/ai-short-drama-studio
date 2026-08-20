import { CanvasNodeType, Prisma, TaskStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './db'
import { HttpError } from './http'
import { readableCanvasAudioError } from './cangyuan-audio'
import {
  readableVideoModerationError,
  readableVideoReferenceError,
} from './video-prompt-safety'

export const CANVAS_IMAGE_MAX_BYTES = 30 * 1024 * 1024
export const CANVAS_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const CANVAS_AUDIO_MAX_BYTES = 50 * 1024 * 1024
export const CANVAS_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'video/mp4',
  'audio/aac',
  'audio/ogg',
])

export const canvasInclude = {
  nodes: {
    include: {
      media: true,
      imageTasks: { orderBy: { createdAt: 'desc' as const }, take: 1 },
      videoTasks: { orderBy: { createdAt: 'desc' as const }, take: 1 },
      audioTasks: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  edges: { orderBy: [{ targetNodeId: 'asc' as const }, { referenceOrder: 'asc' as const }] },
} satisfies Prisma.CreativeCanvasInclude

export type CanvasRecord = Prisma.CreativeCanvasGetPayload<{ include: typeof canvasInclude }>

export const createCanvasSchema = z.object({
  name: z.string().trim().min(1).max(80).default('未命名画布'),
})

const positionSchema = z.object({
  id: z.string().min(1),
  positionX: z.number().finite().min(-100_000).max(100_000),
  positionY: z.number().finite().min(-100_000).max(100_000),
})

export const updateCanvasSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  viewport: z.object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    zoom: z.number().finite().min(0.1).max(4),
  }).optional(),
  nodes: z.array(positionSchema).max(300).optional(),
})

const canvasNodePositionSchema = {
  positionX: z.number().finite().min(-100_000).max(100_000),
  positionY: z.number().finite().min(-100_000).max(100_000),
}

export const createCanvasNodeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(CanvasNodeType.image),
    title: z.string().trim().min(1).max(100).default('图片生成'),
    ...canvasNodePositionSchema,
  }),
  z.object({
    type: z.literal(CanvasNodeType.video),
    title: z.string().trim().min(1).max(100).default('视频生成'),
    ...canvasNodePositionSchema,
  }),
  z.object({
    type: z.literal(CanvasNodeType.audio),
    title: z.string().trim().min(1).max(100).default('生成参考音频'),
    ...canvasNodePositionSchema,
  }),
])

export const updateCanvasNodeSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().max(12_000).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  duration: z.number().int().min(3).max(30).optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3']).optional(),
  resolution: z.enum(['480p', '720p', '1080p', '2k', '4k', '1K', '2K', '4K']).optional(),
  generateAudio: z.boolean().optional(),
})

export const createCanvasEdgeSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
})

export const generateCanvasVideoSchema = z.object({
  prompt: z.string().trim().min(1).max(12_000),
  model: z.string().trim().min(1).max(120),
  duration: z.number().int().min(3).max(30),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '21:9', '3:4', '4:3']),
  resolution: z.enum(['480p', '720p', '1080p', '2k', '4k']),
  generateAudio: z.boolean().default(true),
})

export const generateCanvasImageSchema = z.object({
  prompt: z.string().trim().min(1).max(12_000),
  model: z.string().trim().min(1).max(120),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '3:4', '4:3']),
  resolution: z.enum(['1K', '2K', '4K']),
  count: z.number().int().min(1).max(4).default(1),
})

export const generateCanvasAudioSchema = z.object({
  prompt: z.string().trim().min(2).max(5_000),
  model: z.literal('gemini-music').default('gemini-music'),
})

export function canvasImageSize(aspectRatio: string, resolution: string) {
  const longEdge = resolution === '4K' ? 4096 : resolution === '2K' ? 2048 : 1024
  const ratios: Record<string, [number, number]> = {
    '16:9': [16, 9],
    '9:16': [9, 16],
    '1:1': [1, 1],
    '3:4': [3, 4],
    '4:3': [4, 3],
  }
  const [ratioWidth, ratioHeight] = ratios[aspectRatio] || ratios['1:1']
  if (ratioWidth === ratioHeight) return { width: longEdge, height: longEdge, size: `${longEdge}x${longEdge}` }
  const landscape = ratioWidth > ratioHeight
  const shortEdge = Math.max(512, Math.round(longEdge * Math.min(ratioWidth, ratioHeight) / Math.max(ratioWidth, ratioHeight)))
  const width = landscape ? longEdge : shortEdge
  const height = landscape ? shortEdge : longEdge
  return { width, height, size: `${width}x${height}` }
}

export function canvasMediaUrl(mediaId: string) {
  return `/api/media/${mediaId}`
}

export function canvasMediaThumbnailUrl(mediaId: string) {
  return `${canvasMediaUrl(mediaId)}?thumbnail=1`
}

type CanvasNodePlacement = {
  positionX: number
  positionY: number
  width?: number
  height?: number
}

const VIDEO_NODE_WIDTH = 360
const VIDEO_NODE_HEIGHT = 560
const VIDEO_NODE_GAP = 60

export function nextCanvasVideoNodePosition(
  source: CanvasNodePlacement,
  nodes: CanvasNodePlacement[],
) {
  const sourceWidth = source.width || VIDEO_NODE_WIDTH
  const step = Math.max(sourceWidth, VIDEO_NODE_WIDTH) + VIDEO_NODE_GAP
  const collides = (positionX: number, positionY: number) => nodes.some((node) => {
    const width = node.width || VIDEO_NODE_WIDTH
    const height = node.height || VIDEO_NODE_HEIGHT
    return !(
      positionX + VIDEO_NODE_WIDTH + VIDEO_NODE_GAP <= node.positionX
      || node.positionX + width + VIDEO_NODE_GAP <= positionX
      || positionY + VIDEO_NODE_HEIGHT + VIDEO_NODE_GAP <= node.positionY
      || node.positionY + height + VIDEO_NODE_GAP <= positionY
    )
  })

  for (let column = 1; column <= nodes.length + 1; column += 1) {
    const positionX = source.positionX + step * column
    if (!collides(positionX, source.positionY)) {
      return { positionX, positionY: source.positionY }
    }
  }

  return {
    positionX: source.positionX + step,
    positionY: source.positionY + VIDEO_NODE_HEIGHT + VIDEO_NODE_GAP,
  }
}

export function nextCanvasVideoVersionTitle(sourceTitle: string, existingTitles: string[]) {
  const base = sourceTitle.replace(/\s*·\s*版本\s*\d+\s*$/u, '').trim() || '视频生成'
  const titles = new Set(existingTitles)
  let version = 2
  while (titles.has(`${base} · 版本 ${version}`)) version += 1
  return `${base} · 版本 ${version}`
}

type CanvasTaskRecord = CanvasRecord['nodes'][number]['videoTasks'][number]
  | CanvasRecord['nodes'][number]['imageTasks'][number]
  | CanvasRecord['nodes'][number]['audioTasks'][number]

export function serializeCanvasTask(task: CanvasTaskRecord | undefined) {
  if (!task) return null
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    error: task.model === 'gemini-music'
      ? readableCanvasAudioError(task.error)
      : readableCanvasVideoError(task.error),
    model: task.model,
    createdAt: task.createdAt.toISOString(),
    completedAt: task.completedAt?.toISOString() || null,
  }
}

export function serializeCanvas(canvas: CanvasRecord) {
  return {
    id: canvas.id,
    name: canvas.name,
    viewport: {
      x: canvas.viewportX,
      y: canvas.viewportY,
      zoom: canvas.viewportZoom,
    },
    createdAt: canvas.createdAt.toISOString(),
    updatedAt: canvas.updatedAt.toISOString(),
    nodes: canvas.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      position: { x: node.positionX, y: node.positionY },
      size: { width: node.width, height: node.height },
      prompt: node.prompt || '',
      model: node.model || '',
      duration: node.duration,
      aspectRatio: node.aspectRatio,
      resolution: node.resolution,
      generateAudio: node.generateAudio,
      media: node.media ? {
        id: node.media.id,
        kind: node.media.kind,
        mimeType: node.media.mimeType,
        width: node.media.width,
        height: node.media.height,
        url: canvasMediaUrl(node.media.id),
        thumbnailUrl: canvasMediaThumbnailUrl(node.media.id),
        directUrl: `${canvasMediaUrl(node.media.id)}?direct=1`,
        downloadUrl: `${canvasMediaUrl(node.media.id)}?download=1`,
      } : null,
      latestTask: serializeCanvasTask(
        node.type === CanvasNodeType.image
          ? node.imageTasks[0]
          : node.type === CanvasNodeType.video ? node.videoTasks[0] : node.audioTasks[0],
      ),
    })),
    edges: canvas.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      referenceOrder: edge.referenceOrder,
    })),
  }
}

export type SerializedCanvas = ReturnType<typeof serializeCanvas>

export function insertCanvasPromptReference(input: {
  prompt: string
  selectionStart: number
  selectionEnd: number
  referenceOrder: number
  referenceType?: 'image' | 'video' | 'audio'
}) {
  const start = Math.max(0, Math.min(input.prompt.length, Math.round(input.selectionStart)))
  const end = Math.max(start, Math.min(input.prompt.length, Math.round(input.selectionEnd)))
  const before = input.prompt.slice(0, start)
  const after = input.prompt.slice(end)
  const label = input.referenceType === 'video' ? '视频' : input.referenceType === 'audio' ? '音频' : '图片'
  const token = `@${label}${input.referenceOrder}`
  const leadingSpace = before && !/\s$/u.test(before) ? ' ' : ''
  const trailingSpace = after && !/^\s/u.test(after) ? ' ' : ''
  const insertion = `${leadingSpace}${token}${trailingSpace}`

  return {
    prompt: `${before}${insertion}${after}`,
    selection: before.length + insertion.length,
  }
}

export async function loadCanvas(canvasId: string, userId: string) {
  const canvas = await prisma.creativeCanvas.findFirst({
    where: { id: canvasId, userId },
    include: canvasInclude,
  })
  if (!canvas) throw new HttpError(404, 'CANVAS_NOT_FOUND', '画布不存在')
  return canvas
}

export function normalizeCanvasVideoPrompt(
  prompt: string,
  references: number | { images: number, videos: number, audios: number },
) {
  const counts = typeof references === 'number'
    ? { images: references, videos: 0, audios: 0 }
    : references
  const types = [
    { regex: /@(?:图片|Image)\s*(\d+)/giu, count: counts.images, label: '图片', canonical: 'Image' },
    { regex: /@(?:视频|Video)\s*(\d+)/giu, count: counts.videos, label: '视频', canonical: 'Video' },
    { regex: /@(?:音频|Audio)\s*(\d+)/giu, count: counts.audios, label: '音频', canonical: 'Audio' },
  ] as const
  let normalized = prompt
  for (const type of types) {
    const indexes = [...prompt.matchAll(type.regex)].map((match) => Number(match[1]))
    const invalidIndex = indexes.find((index) => !Number.isInteger(index) || index < 1 || index > type.count)
    if (invalidIndex !== undefined) {
      throw new HttpError(
        422,
        'CANVAS_REFERENCE_INVALID',
        `提示词中的 @${type.label}${invalidIndex} 没有对应的连线${type.label}`,
      )
    }
    normalized = normalized.replace(type.regex, `@${type.canonical}$1`)
  }
  return normalized.trim()
}

export function normalizeCanvasImagePrompt(prompt: string, referenceCount: number) {
  return normalizeCanvasVideoPrompt(prompt, referenceCount)
}

export function canvasTaskStatus(value: string): value is TaskStatus {
  return Object.values(TaskStatus).includes(value as TaskStatus)
}

export function readableCanvasVideoError(value: string | null | undefined) {
  const error = value?.trim() || ''
  const referenceError = readableVideoReferenceError(error)
  if (referenceError) return referenceError
  const moderationError = readableVideoModerationError(error)
  if (moderationError) return moderationError
  if (/Video generation failed without a specific reason|no failure detail/iu.test(error)) {
    return '上游模型已接收提示词和参考图，但在生成阶段无明确原因失败。素材本身已通过检查；系统会自动重试并切换可用 Key。'
  }
  if (/real human faces|real person'?s face|source media without real faces/iu.test(error)) {
    return '所选“卡人脸”模型拒绝了写实人脸参考图。系统已为下次生成切换到普通 Seedance 2.0，请重新生成。'
  }
  if (/Adobe video submit failed with status 408/iu.test(error)) {
    return '视频服务上游返回 408，未生成成片。任务已停止，不会自动重复提交。'
  }
  if (/no access to model|HTTP\s*403/iu.test(error)) {
    return '当前视频 API Key 没有所选模型权限，请更换模型或检查沧元授权。'
  }
  return error || '视频生成失败'
}

export function canvasVideoFaceFallbackModel(model: string, error: string) {
  if (!/^sd5-seedance-2\.0(?:-fast)?$/iu.test(model)) return null
  if (!/real human faces|real person'?s face|source media without real faces/iu.test(error)) return null
  return model.endsWith('-fast') ? 'seedance-2.0-fast' : 'seedance-2.0'
}

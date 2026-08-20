import { CanvasNodeType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  generateCanvasVideoSchema,
  loadCanvas,
  nextCanvasVideoNodePosition,
  nextCanvasVideoVersionTitle,
  normalizeCanvasVideoPrompt,
  serializeCanvas,
} from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasNodeAccess } from '@/lib/permissions'
import { enqueueCanvasVideoTask } from '@/lib/queue'
import { normalizeVideoDuration } from '@/lib/video-batch'
import { resolveVideoModelDefinition } from '@/lib/video-models'

export async function POST(request: NextRequest, context: { params: Promise<{ nodeId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { nodeId } = await context.params
    const node = await requireCanvasNodeAccess(nodeId, user.id)
    if (node.type !== CanvasNodeType.video) throw new HttpError(422, 'CANVAS_VIDEO_NODE_REQUIRED', '请选择视频生成节点')
    const body = generateCanvasVideoSchema.parse(await request.json())
    const model = await resolveVideoModelDefinition(body.model)
    if (!model) throw new HttpError(400, 'VIDEO_MODEL_NOT_ALLOWED', '所选视频模型当前不可用，请刷新模型列表')
    if (!model.resolutions.includes(body.resolution)) {
      throw new HttpError(422, 'VIDEO_RESOLUTION_NOT_SUPPORTED', '所选模型不支持该清晰度')
    }
    if (!model.aspectRatios.includes(body.aspectRatio)) {
      throw new HttpError(422, 'VIDEO_ASPECT_RATIO_NOT_SUPPORTED', '所选模型不支持该画幅')
    }
    const references = await prisma.canvasEdge.findMany({
      where: { canvasId: node.canvasId, targetNodeId: node.id },
      include: { sourceNode: { include: { media: true } } },
      orderBy: { referenceOrder: 'asc' },
    })
    const validReferences = references.filter((edge) => (
      (edge.sourceNode.type === CanvasNodeType.image && edge.sourceNode.media?.mimeType.startsWith('image/'))
      || (edge.sourceNode.type === CanvasNodeType.video && edge.sourceNode.media?.mimeType.startsWith('video/'))
      || (edge.sourceNode.type === CanvasNodeType.audio && edge.sourceNode.media?.mimeType.startsWith('audio/'))
    ))
    if (validReferences.length !== references.length) {
      throw new HttpError(422, 'CANVAS_REFERENCE_INVALID', '部分连线素材已失效，请删除失效连线后再试')
    }
    const imageReferences = validReferences.filter((edge) => edge.sourceNode.type === CanvasNodeType.image)
    const videoReferences = validReferences.filter((edge) => edge.sourceNode.type === CanvasNodeType.video)
    const audioReferences = validReferences.filter((edge) => edge.sourceNode.type === CanvasNodeType.audio)
    if (imageReferences.length > model.maximumReferenceImages) {
      throw new HttpError(422, 'CANVAS_REFERENCE_LIMIT', `当前模型最多支持 ${model.maximumReferenceImages} 张参考图`)
    }
    if (videoReferences.length > (model.maximumReferenceVideos || 0)) {
      throw new HttpError(422, 'CANVAS_REFERENCE_LIMIT', `当前模型最多支持 ${model.maximumReferenceVideos || 0} 段参考视频`)
    }
    if (audioReferences.length > (model.maximumReferenceAudios || 0)) {
      throw new HttpError(422, 'CANVAS_REFERENCE_LIMIT', `当前模型最多支持 ${model.maximumReferenceAudios || 0} 段参考音频`)
    }
    if (model.requiresReferenceVideo && videoReferences.length === 0) {
      throw new HttpError(422, 'VIDEO_REFERENCE_REQUIRED', '当前模型是视频转视频模型，请至少连接一个已生成的视频节点')
    }
    const prompt = normalizeCanvasVideoPrompt(body.prompt, {
      images: imageReferences.length,
      videos: videoReferences.length,
      audios: audioReferences.length,
    })
    if (prompt.length > model.maximumPromptCharacters) {
      throw new HttpError(422, 'VIDEO_PROMPT_TOO_LONG', `当前模型提示词最多 ${model.maximumPromptCharacters} 字符`)
    }
    const duration = normalizeVideoDuration(
      body.duration,
      model.minimumDuration,
      model.maximumDuration,
      model.supportedDurations,
    )
    const referenceNodeIds = validReferences.map((edge) => edge.sourceNodeId)
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ lock_acquired: number }>>`
        SELECT 1::int AS lock_acquired
        FROM pg_advisory_xact_lock(hashtext(${`canvas-video:${node.id}`}))
      `
      const active = await tx.canvasVideoTask.findFirst({
        where: { nodeId, status: { in: ['queued', 'processing'] } },
      })
      if (active) return { task: active, reused: true as const, createdNode: false, nodeId: node.id }

      const currentNode = await tx.canvasNode.findUnique({ where: { id: node.id } })
      if (!currentNode) throw new HttpError(404, 'CANVAS_NODE_NOT_FOUND', '画布节点不存在')
      const canvasNodes = await tx.canvasNode.findMany({
        where: { canvasId: node.canvasId },
        select: { id: true, title: true, positionX: true, positionY: true, width: true, height: true },
      })
      let targetNodeId = currentNode.id
      let createdNode = false
      if (currentNode.mediaId) {
        const position = nextCanvasVideoNodePosition(currentNode, canvasNodes)
        const created = await tx.canvasNode.create({
          data: {
            canvasId: node.canvasId,
            type: CanvasNodeType.video,
            title: nextCanvasVideoVersionTitle(currentNode.title, canvasNodes.map((item) => item.title)),
            ...position,
            width: currentNode.width,
            height: currentNode.height,
            prompt: body.prompt,
            model: body.model,
            duration,
            aspectRatio: body.aspectRatio,
            resolution: body.resolution,
            generateAudio: model.supportsAudio && body.generateAudio,
          },
        })
        targetNodeId = created.id
        createdNode = true
        if (validReferences.length > 0) {
          await tx.canvasEdge.createMany({
            data: validReferences.map((edge) => ({
              canvasId: node.canvasId,
              sourceNodeId: edge.sourceNodeId,
              targetNodeId: created.id,
              referenceOrder: edge.referenceOrder,
            })),
          })
        }
      } else {
        await tx.canvasNode.update({
          where: { id: currentNode.id },
          data: {
            prompt: body.prompt,
            model: body.model,
            duration,
            aspectRatio: body.aspectRatio,
            resolution: body.resolution,
            generateAudio: model.supportsAudio && body.generateAudio,
          },
        })
      }
      await tx.creativeCanvas.update({ where: { id: node.canvasId }, data: { updatedAt: new Date() } })
      const task = await tx.canvasVideoTask.create({
        data: {
          canvasId: node.canvasId,
          nodeId: targetNodeId,
          createdById: user.id,
          model: body.model,
          prompt,
          duration,
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
          generateAudio: model.supportsAudio && body.generateAudio,
          referenceNodeIds,
          payload: {
            displayPrompt: body.prompt,
            sourceNodeId: node.id,
            createdOutputNode: createdNode,
            maximumReferenceImages: model.maximumReferenceImages,
            maximumReferenceVideos: model.maximumReferenceVideos || 0,
            maximumReferenceAudios: model.maximumReferenceAudios || 0,
            referenceLabels: validReferences.map((edge, index, all) => {
              const typeIndex = all.slice(0, index + 1)
                .filter((candidate) => candidate.sourceNode.type === edge.sourceNode.type).length
              const label = edge.sourceNode.type === CanvasNodeType.image
                ? '图片'
                : edge.sourceNode.type === CanvasNodeType.video ? '视频' : '音频'
              return {
                token: `@${label}${typeIndex}`,
                nodeId: edge.sourceNodeId,
                title: edge.sourceNode.title,
                type: edge.sourceNode.type,
              }
            }),
          },
        },
      })
      return { task, reused: false as const, createdNode, nodeId: targetNodeId }
    })
    if (!result.reused) {
      try {
        await enqueueCanvasVideoTask(result.task.id)
      } catch (error) {
        await prisma.canvasVideoTask.update({
          where: { id: result.task.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `CANVAS_QUEUE_SUBMIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          },
        })
        throw error
      }
    }
    return NextResponse.json({
      reused: result.reused,
      createdNode: result.createdNode,
      nodeId: result.nodeId,
      task: {
        id: result.task.id,
        status: result.task.status,
        progress: result.task.progress,
        error: result.task.error,
      },
      canvas: serializeCanvas(await loadCanvas(node.canvasId, user.id)),
    }, { status: 202 })
  })
}

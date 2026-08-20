import { CanvasNodeType } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createCanvasNodeSchema, loadCanvas, serializeCanvas } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'
import { requireCanvasAccess } from '@/lib/permissions'
import { env } from '@/lib/env'

export async function POST(request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    await requireCanvasAccess(canvasId, user.id)
    const body = createCanvasNodeSchema.parse(await request.json())
    const isImage = body.type === CanvasNodeType.image
    const isAudio = body.type === CanvasNodeType.audio
    await prisma.canvasNode.create({
      data: {
        canvasId,
        type: body.type,
        title: body.title,
        positionX: body.positionX,
        positionY: body.positionY,
        width: isImage ? 392 : 360,
        height: isImage ? 610 : isAudio ? 430 : 560,
        model: isImage
          ? (env.imageModel() || 'gpt-image-2-1k')
          : isAudio ? env.audioModel() : (env.videoModel() || 'seedance-2.0-mini'),
        aspectRatio: isImage ? '1:1' : '16:9',
        resolution: isImage ? '1K' : '720p',
        generateAudio: !isImage && !isAudio,
      },
    })
    await prisma.creativeCanvas.update({ where: { id: canvasId }, data: { updatedAt: new Date() } })
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(canvasId, user.id)) }, { status: 201 })
  })
}

import { CanvasNodeType, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  CANVAS_AUDIO_MAX_BYTES,
  CANVAS_AUDIO_TYPES,
  loadCanvas,
  serializeCanvas,
} from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireCanvasAccess } from '@/lib/permissions'
import { buildCanvasStorageKey, deleteStorageObject, uploadBuffer } from '@/lib/storage'

function formNumber(form: FormData, key: string, fallback: number) {
  const value = Number(form.get(key))
  return Number.isFinite(value) ? value : fallback
}

export async function POST(request: NextRequest, context: { params: Promise<{ canvasId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { canvasId } = await context.params
    await requireCanvasAccess(canvasId, user.id)
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new HttpError(400, 'AUDIO_REQUIRED', '请选择音频文件')
    if (!CANVAS_AUDIO_TYPES.has(file.type)) {
      throw new HttpError(415, 'AUDIO_TYPE_UNSUPPORTED', '仅支持 MP3、WAV、M4A、AAC 或 OGG')
    }
    if (file.size <= 0 || file.size > CANVAS_AUDIO_MAX_BYTES) {
      throw new HttpError(413, 'AUDIO_TOO_LARGE', '音频不能超过 50MB')
    }

    const mimeType = file.type === 'video/mp4' ? 'audio/mp4' : file.type
    const title = String(form.get('title') || file.name.replace(/\.[^.]+$/, '') || '参考音频').trim().slice(0, 100)
    const nodeId = randomUUID()
    const storageKey = buildCanvasStorageKey({ canvasId, nodeId, mimeType })
    let uploaded = false
    try {
      await uploadBuffer({ key: storageKey, body: Buffer.from(await file.arrayBuffer()), mimeType })
      uploaded = true
      await prisma.$transaction(async (tx) => {
        const node = await tx.canvasNode.create({
          data: {
            id: nodeId,
            canvasId,
            type: CanvasNodeType.audio,
            title: title || '参考音频',
            positionX: formNumber(form, 'positionX', 80),
            positionY: formNumber(form, 'positionY', 80),
            width: 360,
            height: 250,
          },
        })
        const media = await tx.mediaObject.create({
          data: {
            kind: 'audio',
            storageKey,
            mimeType,
            sizeBytes: BigInt(file.size),
          },
        })
        await tx.canvasNode.update({ where: { id: node.id }, data: { mediaId: media.id } })
        await tx.creativeCanvas.update({ where: { id: canvasId }, data: { updatedAt: new Date() } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    } catch (error) {
      if (uploaded) await deleteStorageObject(storageKey).catch(() => undefined)
      throw error
    }
    return NextResponse.json({ canvas: serializeCanvas(await loadCanvas(canvasId, user.id)) }, { status: 201 })
  })
}

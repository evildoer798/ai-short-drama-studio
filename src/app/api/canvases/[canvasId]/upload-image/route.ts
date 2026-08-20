import { CanvasNodeType, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  CANVAS_IMAGE_MAX_BYTES,
  CANVAS_IMAGE_TYPES,
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
    if (!(file instanceof File)) throw new HttpError(400, 'IMAGE_REQUIRED', '请选择图片文件')
    if (!CANVAS_IMAGE_TYPES.has(file.type)) throw new HttpError(415, 'IMAGE_TYPE_UNSUPPORTED', '仅支持 JPG、PNG 或 WebP')
    if (file.size <= 0 || file.size > CANVAS_IMAGE_MAX_BYTES) {
      throw new HttpError(413, 'IMAGE_TOO_LARGE', '图片不能超过 30MB')
    }

    const title = String(form.get('title') || file.name.replace(/\.[^.]+$/, '') || '图片').trim().slice(0, 100)
    const nodeId = randomUUID()
    const storageKey = buildCanvasStorageKey({ canvasId, nodeId, mimeType: file.type })
    let uploaded = false
    try {
      await uploadBuffer({ key: storageKey, body: Buffer.from(await file.arrayBuffer()), mimeType: file.type })
      uploaded = true
      await prisma.$transaction(async (tx) => {
        const node = await tx.canvasNode.create({
          data: {
            id: nodeId,
            canvasId,
            type: CanvasNodeType.image,
            title: title || '图片',
            positionX: formNumber(form, 'positionX', 80),
            positionY: formNumber(form, 'positionY', 80),
            width: 320,
            height: 280,
          },
        })
        const media = await tx.mediaObject.create({
          data: {
            kind: 'image',
            storageKey,
            mimeType: file.type,
            sizeBytes: BigInt(file.size),
            width: Math.max(1, Math.round(formNumber(form, 'width', 1))),
            height: Math.max(1, Math.round(formNumber(form, 'height', 1))),
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

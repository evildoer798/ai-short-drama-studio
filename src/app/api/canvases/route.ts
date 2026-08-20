import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createCanvasSchema, canvasMediaUrl } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'

export async function GET() {
  return routeHandler(async () => {
    const user = await requireUser()
    const canvases = await prisma.creativeCanvas.findMany({
      where: { userId: user.id },
      include: {
        _count: { select: { nodes: true, imageTasks: true, videoTasks: true, audioTasks: true } },
        nodes: {
          where: { mediaId: { not: null } },
          select: { mediaId: true, type: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({
      canvases: canvases.map((canvas) => ({
        id: canvas.id,
        name: canvas.name,
        nodeCount: canvas._count.nodes,
        taskCount: canvas._count.imageTasks + canvas._count.videoTasks + canvas._count.audioTasks,
        coverUrl: canvas.nodes[0]?.mediaId ? canvasMediaUrl(canvas.nodes[0].mediaId) : null,
        coverType: canvas.nodes[0]?.type || null,
        createdAt: canvas.createdAt.toISOString(),
        updatedAt: canvas.updatedAt.toISOString(),
      })),
    })
  })
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = createCanvasSchema.parse(await request.json())
    const canvas = await prisma.creativeCanvas.create({
      data: { userId: user.id, name: body.name },
    })
    return NextResponse.json({ canvas: { id: canvas.id, name: canvas.name } }, { status: 201 })
  })
}

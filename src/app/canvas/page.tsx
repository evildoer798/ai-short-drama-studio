import { redirect } from 'next/navigation'
import { CanvasWorkspace } from '@/components/CanvasWorkspace'
import { getCurrentUser } from '@/lib/auth'
import { canvasMediaUrl, canvasInclude, serializeCanvas } from '@/lib/creative-canvas'
import { prisma } from '@/lib/db'

export default async function CanvasPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>
}) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')

  const requestedId = (await searchParams).id
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
  const selectedId = canvases.some((canvas) => canvas.id === requestedId)
    ? requestedId
    : canvases[0]?.id
  const selected = selectedId ? await prisma.creativeCanvas.findFirst({
    where: { id: selectedId, userId: user.id },
    include: canvasInclude,
  }) : null

  return (
    <CanvasWorkspace
      user={{ id: user.id, name: user.name, email: user.email }}
      initialCanvases={canvases.map((canvas) => ({
        id: canvas.id,
        name: canvas.name,
        nodeCount: canvas._count.nodes,
        taskCount: canvas._count.imageTasks + canvas._count.videoTasks + canvas._count.audioTasks,
        coverUrl: canvas.nodes[0]?.mediaId ? canvasMediaUrl(canvas.nodes[0].mediaId) : null,
        coverType: canvas.nodes[0]?.type || null,
        updatedAt: canvas.updatedAt.toISOString(),
      }))}
      initialCanvas={selected ? serializeCanvas(selected) : null}
    />
  )
}

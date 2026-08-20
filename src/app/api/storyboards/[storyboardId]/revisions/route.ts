import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { HttpError, routeHandler } from '@/lib/http'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { getProjectStoryboards, syncStoryboardAssetLinks } from '@/lib/storyboards'
import {
  createStoryboardRevision,
  storyboardRevisionRestoreData,
  storyboardRevisionSnapshotSchema,
} from '@/lib/storyboard-revisions'

const restoreRevisionSchema = z.object({ revisionId: z.string().trim().min(1) })

function stableRevisionWhere(storyboard: Awaited<ReturnType<typeof requireStoryboardAccess>>) {
  return {
    projectId: storyboard.projectId,
    OR: [
      { storyboardId: storyboard.id },
      ...(storyboard.episodeId && storyboard.episodeSceneNumber
        ? [{
            episodeId: storyboard.episodeId,
            episodeSceneNumber: storyboard.episodeSceneNumber,
          }]
        : []),
    ],
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    const revisions = await prisma.storyboardRevision.findMany({
      where: stableRevisionWhere(storyboard),
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({
      revisions: revisions.map((revision) => {
        const snapshot = storyboardRevisionSnapshotSchema.parse(revision.snapshot)
        return {
          id: revision.id,
          source: revision.source,
          reason: revision.reason,
          contentHash: revision.contentHash,
          createdAt: revision.createdAt.toISOString(),
          title: snapshot.title,
          duration: snapshot.duration,
          promptPreview: (snapshot.videoPrompt || '').replace(/\s+/gu, ' ').slice(0, 180),
        }
      }),
    })
  })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const { revisionId } = restoreRevisionSchema.parse(await request.json())
    const revision = await prisma.storyboardRevision.findFirst({
      where: { id: revisionId, ...stableRevisionWhere(storyboard) },
    })
    if (!revision) throw new HttpError(404, 'STORYBOARD_REVISION_NOT_FOUND', '分镜历史版本不存在')

    await prisma.$transaction(async (tx) => {
      await createStoryboardRevision(tx, storyboard, {
        source: 'before_restore',
        reason: `恢复到版本 ${revision.id} 前的当前稿`,
        createdById: user.id,
      })
      await tx.storyboard.update({
        where: { id: storyboard.id },
        data: storyboardRevisionRestoreData(revision.snapshot),
      })
    })
    await syncStoryboardAssetLinks(storyboard.id)
    const storyboards = await getProjectStoryboards(storyboard.projectId)
    return NextResponse.json({
      storyboard: storyboards.find((item) => item.id === storyboard.id),
    })
  })
}

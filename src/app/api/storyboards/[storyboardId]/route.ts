import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { requireStoryboardAccess, requireWritableProject } from '@/lib/permissions'
import { HttpError, routeHandler } from '@/lib/http'
import {
  getProjectStoryboards,
  syncStoryboardAssetLinks,
  updateStoryboardSchema,
} from '@/lib/storyboards'
import { sanitizeStoryboardPromptSceneSection } from '@/lib/storyboard-scene'
import {
  repairExactFinalStoryboardDialogueDuplicates,
  type FinalStoryboardDialogueDocument,
} from '@/lib/storyboard-dialogue-validation'
import { createStoryboardRevision, storyboardRevisionSnapshot } from '@/lib/storyboard-revisions'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    const body = updateStoryboardSchema.parse(await request.json())
    if (body.baseUpdatedAt !== storyboard.updatedAt.toISOString()) {
      throw new HttpError(
        409,
        'STORYBOARD_VERSION_CONFLICT',
        '该分镜已在其他页面更新。请刷新页面后再编辑，旧内容没有覆盖服务器新版本。',
      )
    }
    const fallbackSceneName = storyboard.assetLinks.find((link) => link.asset.type === 'location')
      ?.asset.name
      || storyboard.notes?.split(/\r?\n/u, 1)[0]?.split('｜').at(-1)?.trim()
      || ''
    const videoPrompt = body.videoPrompt === undefined
      ? undefined
      : sanitizeStoryboardPromptSceneSection(
          body.videoPrompt,
          fallbackSceneName,
          '',
          storyboard.assetLinks
            .filter((link) => link.asset.type === 'character')
            .map((link) => link.asset.name),
        )

    const neighboringStoryboards = body.videoPrompt !== undefined && storyboard.episodeId
      ? await prisma.storyboard.findMany({
          where: {
            episodeId: storyboard.episodeId,
            episodeSceneNumber: {
              gte: Math.max(1, (storyboard.episodeSceneNumber || 1) - 1),
              lte: (storyboard.episodeSceneNumber || 1) + 1,
            },
          },
          orderBy: { episodeSceneNumber: 'asc' },
        })
      : []
    const dialogueDocuments: FinalStoryboardDialogueDocument[] = neighboringStoryboards.map((item) => ({
      id: item.id,
      number: item.episodeSceneNumber || item.sceneNumber,
      title: item.title,
      videoPrompt: item.id === storyboard.id ? videoPrompt || '' : item.videoPrompt || '',
    }))
    const dialogueRepair = dialogueDocuments.length > 0
      ? repairExactFinalStoryboardDialogueDuplicates(
          dialogueDocuments,
          storyboard.episode?.content || '',
        )
      : { documents: dialogueDocuments, changedDocumentIds: [], issues: [] }
    if (dialogueRepair.issues.length > 0) {
      throw new HttpError(
        422,
        'STORYBOARD_FINAL_DIALOGUE_INVALID',
        `相邻分镜存在重复台词：${dialogueRepair.issues.slice(0, 3).map((issue) => issue.message).join('；')}。请将这句台词只保留在一个分镜中。`,
      )
    }
    const repairedPrompts = new Map(dialogueRepair.documents.map((item) => [item.id, item.videoPrompt]))

    await prisma.$transaction(async (tx) => {
      const currentUpdate = {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        ...(body.imagePrompt !== undefined ? { imagePrompt: body.imagePrompt || null } : {}),
        ...(body.directorPrompt !== undefined ? { directorPrompt: body.directorPrompt || null } : {}),
        ...(videoPrompt !== undefined ? { videoPrompt: repairedPrompts.get(storyboard.id) || null } : {}),
        ...(body.duration !== undefined ? { duration: body.duration } : {}),
        ...(body.aspectRatio !== undefined ? { aspectRatio: body.aspectRatio } : {}),
        ...(body.generateAudio !== undefined ? { generateAudio: body.generateAudio } : {}),
      }
      const beforeSnapshot = storyboardRevisionSnapshot(storyboard)
      const afterSnapshot = storyboardRevisionSnapshot({ ...storyboard, ...currentUpdate })
      if (JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot)) {
        await createStoryboardRevision(tx, storyboard, {
          source: 'manual_edit',
          reason: '人工保存分镜前自动留存',
          createdById: user.id,
          validationReport: { dialogueIssues: [], autoRepairedExactDuplicates: dialogueRepair.changedDocumentIds },
        })
      }
      await tx.storyboard.update({ where: { id: storyboardId }, data: currentUpdate })

      for (const neighbor of neighboringStoryboards) {
        if (neighbor.id === storyboard.id) continue
        const repairedPrompt = repairedPrompts.get(neighbor.id)
        if (repairedPrompt === undefined || repairedPrompt === (neighbor.videoPrompt || '')) continue
        await createStoryboardRevision(tx, neighbor, {
          source: 'adjacent_dialogue_auto_repair',
          reason: `保存分镜 ${storyboard.episodeSceneNumber || storyboard.sceneNumber} 时删除相邻分镜重复台词`,
          createdById: user.id,
          validationReport: { dialogueIssues: [], autoRepairedExactDuplicates: dialogueRepair.changedDocumentIds },
        })
        await tx.storyboard.update({
          where: { id: neighbor.id },
          data: { videoPrompt: repairedPrompt || null },
        })
      }
    })

    if (body.videoPrompt !== undefined) {
      await Promise.all([
        storyboardId,
        ...dialogueRepair.changedDocumentIds.filter((id) => id !== storyboardId),
      ].map((id) => syncStoryboardAssetLinks(id)))
    }
    const storyboards = await getProjectStoryboards(storyboard.projectId)
    return NextResponse.json({
      storyboard: storyboards.find((item) => item.id === storyboardId),
    })
  })
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ storyboardId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { storyboardId } = await context.params
    const storyboard = await requireStoryboardAccess(storyboardId, user.id)
    await requireWritableProject(storyboard.projectId, user.id)
    await prisma.storyboard.delete({ where: { id: storyboardId } })
    return new NextResponse(null, { status: 204 })
  })
}

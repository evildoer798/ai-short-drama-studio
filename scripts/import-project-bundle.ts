import { PrismaClient, TaskStatus } from '@prisma/client'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Bundle = Record<string, any>

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function without<T extends Record<string, any>>(value: T, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

function mappedUserId(map: Map<string, string>, sourceId: string) {
  const targetId = map.get(sourceId)
  if (!targetId) throw new Error(`No target user mapping for ${sourceId}`)
  return targetId
}

const inputPath = resolve(argument('--input') || 'project-bundle.json')
const ownerEmail = (argument('--owner-email') || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase()
const projectName = argument('--project-name')?.trim()
if (!ownerEmail) throw new Error('--owner-email is required')

const bundle = JSON.parse(await readFile(inputPath, 'utf8'), (_key, value) => (
  value && typeof value === 'object' && typeof value.$bigint === 'string'
    ? BigInt(value.$bigint)
    : value
)) as Bundle
if (bundle.format !== 'imaideo-project-bundle' || bundle.version !== 1) {
  throw new Error('Unsupported project bundle format')
}

const prisma = new PrismaClient()

try {
  const result = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.findUnique({ where: { email: ownerEmail } })
    if (!owner) throw new Error(`Target owner not found: ${ownerEmail}`)

    const sourceOwnerMember = bundle.projectMembers.find((member: any) => member.role === 'owner')
    const sourceOwnerId = sourceOwnerMember?.userId || bundle.projectMembers[0]?.userId
    if (!sourceOwnerId) throw new Error('Source project owner is missing')

    const userMap = new Map<string, string>([[sourceOwnerId, owner.id]])
    for (const sourceUser of bundle.users) {
      if (sourceUser.id === sourceOwnerId) continue
      const matches = await tx.user.findMany({
        where: {
          OR: [
            ...(sourceUser.username ? [{ username: sourceUser.username }] : []),
            { email: sourceUser.email },
          ],
        },
      })
      if (matches.length > 1) throw new Error(`Ambiguous target user: ${sourceUser.email}`)
      const targetUser = matches[0] || await tx.user.create({ data: sourceUser })
      userMap.set(sourceUser.id, targetUser.id)
    }

    const existingWorkspace = await tx.workspace.findUnique({ where: { id: bundle.workspace.id } })
    if (!existingWorkspace) await tx.workspace.create({ data: bundle.workspace })

    for (const member of bundle.workspaceMembers) {
      const userId = mappedUserId(userMap, member.userId)
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: bundle.workspace.id, userId } },
        update: { role: member.role },
        create: { ...member, id: member.userId === sourceOwnerId ? undefined : member.id, userId },
      })
    }

    const sourceProject = bundle.project
    const existingProject = await tx.project.findUnique({ where: { id: sourceProject.id } })
    if (!existingProject) {
      await tx.project.create({
        data: {
          ...sourceProject,
          name: projectName || sourceProject.name,
          selectedRenderId: null,
        },
      })
    }

    for (const member of bundle.projectMembers) {
      const userId = mappedUserId(userMap, member.userId)
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: sourceProject.id, userId } },
        update: { role: member.role },
        create: { ...member, id: member.userId === sourceOwnerId ? undefined : member.id, userId },
      })
    }

    if (bundle.mediaObjects.length) {
      await tx.mediaObject.createMany({ data: bundle.mediaObjects, skipDuplicates: true })
    }
    for (const source of bundle.novelSources) {
      await tx.novelSource.upsert({
        where: { projectId: source.projectId },
        update: without(source, ['id', 'projectId', 'createdAt']),
        create: source,
      })
    }
    if (bundle.scriptEpisodes.length) {
      await tx.scriptEpisode.createMany({ data: bundle.scriptEpisodes, skipDuplicates: true })
    }
    if (bundle.assets.length) {
      await tx.asset.createMany({
        data: bundle.assets.map((asset: any) => ({
          ...asset,
          selectedImageId: null,
          createdById: mappedUserId(userMap, asset.createdById),
        })),
        skipDuplicates: true,
      })
    }
    if (bundle.storyboards.length) {
      await tx.storyboard.createMany({
        data: bundle.storyboards.map((storyboard: any) => ({ ...storyboard, selectedVideoId: null })),
        skipDuplicates: true,
      })
    }
    if (bundle.scriptComments.length) {
      await tx.scriptComment.createMany({
        data: bundle.scriptComments.map((comment: any) => ({
          ...comment,
          createdById: mappedUserId(userMap, comment.createdById),
        })),
        skipDuplicates: true,
      })
    }
    if (bundle.assetImages.length) {
      await tx.assetImage.createMany({ data: bundle.assetImages, skipDuplicates: true })
    }
    if (bundle.storyboardAssets.length) {
      await tx.storyboardAsset.createMany({ data: bundle.storyboardAssets, skipDuplicates: true })
    }
    if (bundle.storyboardVideos.length) {
      await tx.storyboardVideo.createMany({ data: bundle.storyboardVideos, skipDuplicates: true })
    }
    if (bundle.projectRenders.length) {
      await tx.projectRender.createMany({ data: bundle.projectRenders, skipDuplicates: true })
    }
    if (bundle.generationTasks.length) {
      await tx.generationTask.createMany({
        data: bundle.generationTasks.map((task: any) => {
          const active = task.status === TaskStatus.queued || task.status === TaskStatus.processing
          return {
            ...task,
            status: active ? TaskStatus.failed : task.status,
            progress: active ? 0 : task.progress,
            error: active ? 'Imported from local project; original task was not running.' : task.error,
            completedAt: active ? new Date() : task.completedAt,
            createdById: mappedUserId(userMap, task.createdById),
          }
        }),
        skipDuplicates: true,
      })
    }

    for (const asset of bundle.assets) {
      if (!asset.selectedImageId) continue
      await tx.asset.update({ where: { id: asset.id }, data: { selectedImageId: asset.selectedImageId } })
    }
    for (const storyboard of bundle.storyboards) {
      if (!storyboard.selectedVideoId) continue
      await tx.storyboard.update({ where: { id: storyboard.id }, data: { selectedVideoId: storyboard.selectedVideoId } })
    }
    if (sourceProject.selectedRenderId) {
      await tx.project.update({
        where: { id: sourceProject.id },
        data: { selectedRenderId: sourceProject.selectedRenderId },
      })
    }

    return {
      projectId: sourceProject.id,
      projectName: projectName || sourceProject.name,
      mappedUsers: Object.fromEntries(userMap),
    }
  }, { maxWait: 10_000, timeout: 120_000 })

  const imported = await prisma.project.findUnique({
    where: { id: result.projectId },
    select: {
      id: true,
      name: true,
      _count: {
        select: {
          members: true,
          scriptEpisodes: true,
          assets: true,
          storyboards: true,
          renders: true,
          tasks: true,
        },
      },
    },
  })

  console.log(JSON.stringify({ ok: true, imported, mappedUsers: result.mappedUsers }, null, 2))
} finally {
  await prisma.$disconnect()
}

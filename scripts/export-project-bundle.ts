import { PrismaClient } from '@prisma/client'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

const prisma = new PrismaClient()
const requestedProjectId = argument('--project-id')
const outputPath = resolve(argument('--output') || 'project-bundle.json')

try {
  const availableProjects = await prisma.project.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
  const projectId = requestedProjectId || (availableProjects.length === 1 ? availableProjects[0].id : undefined)
  if (!projectId) {
    throw new Error(`Use --project-id. Available projects: ${JSON.stringify(availableProjects)}`)
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project not found: ${projectId}`)
  const workspace = await prisma.workspace.findUnique({ where: { id: project.workspaceId } })
  if (!workspace) throw new Error(`Workspace not found: ${project.workspaceId}`)

  const [
    workspaceMembers,
    projectMembers,
    novelSources,
    scriptEpisodes,
    assets,
    storyboards,
    generationTasks,
  ] = await Promise.all([
    prisma.workspaceMember.findMany({ where: { workspaceId: project.workspaceId } }),
    prisma.projectMember.findMany({ where: { projectId } }),
    prisma.novelSource.findMany({ where: { projectId } }),
    prisma.scriptEpisode.findMany({ where: { projectId }, orderBy: { episodeNumber: 'asc' } }),
    prisma.asset.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.storyboard.findMany({ where: { projectId }, orderBy: { sceneNumber: 'asc' } }),
    prisma.generationTask.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
  ])

  const episodeIds = scriptEpisodes.map((episode) => episode.id)
  const assetIds = assets.map((asset) => asset.id)
  const storyboardIds = storyboards.map((storyboard) => storyboard.id)

  const [
    scriptComments,
    assetImages,
    storyboardAssets,
    storyboardVideos,
    projectRenders,
  ] = await Promise.all([
    prisma.scriptComment.findMany({ where: { episodeId: { in: episodeIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.assetImage.findMany({ where: { assetId: { in: assetIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.storyboardAsset.findMany({ where: { storyboardId: { in: storyboardIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.storyboardVideo.findMany({ where: { storyboardId: { in: storyboardIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.projectRender.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
  ])

  const mediaIds = unique([
    ...assetImages.map((image) => image.mediaId),
    ...storyboardVideos.map((video) => video.mediaId),
    ...projectRenders.map((render) => render.mediaId),
  ])
  const userIds = unique([
    ...workspaceMembers.map((member) => member.userId),
    ...projectMembers.map((member) => member.userId),
    ...assets.map((asset) => asset.createdById),
    ...scriptComments.map((comment) => comment.createdById),
    ...generationTasks.map((task) => task.createdById),
  ])

  const [users, mediaObjects] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.mediaObject.findMany({ where: { id: { in: mediaIds } }, orderBy: { createdAt: 'asc' } }),
  ])

  const bundle = {
    format: 'imaideo-project-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    users,
    workspace,
    workspaceMembers,
    project,
    projectMembers,
    novelSources,
    scriptEpisodes,
    scriptComments,
    assets,
    assetImages,
    mediaObjects,
    storyboards,
    storyboardAssets,
    storyboardVideos,
    projectRenders,
    generationTasks,
  }

  await writeFile(outputPath, JSON.stringify(bundle, (_key, value) => (
    typeof value === 'bigint' ? { $bigint: value.toString() } : value
  ), 2), { encoding: 'utf8', mode: 0o600 })

  console.log(JSON.stringify({
    ok: true,
    outputPath,
    project: { id: project.id, name: project.name },
    counts: {
      users: users.length,
      episodes: scriptEpisodes.length,
      comments: scriptComments.length,
      assets: assets.length,
      images: assetImages.length,
      media: mediaObjects.length,
      storyboards: storyboards.length,
      storyboardAssets: storyboardAssets.length,
      videos: storyboardVideos.length,
      renders: projectRenders.length,
      tasks: generationTasks.length,
    },
  }, null, 2))
} finally {
  await prisma.$disconnect()
}

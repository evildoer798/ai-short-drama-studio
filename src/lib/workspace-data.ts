import { AssetType } from '@prisma/client'
import { prisma } from './db'
import { assetImageUrl } from './assets'
import { getProjectStoryboards } from './storyboards'
import { visualStyleOptions } from './visual-styles'

export async function getWorkspaceData(userId: string, input?: {
  projectId?: string | null
  type?: string | null
  q?: string | null
}) {
  const projects = await prisma.project.findMany({
    where: {
      members: {
        some: { userId },
      },
    },
    include: {
      workspace: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const requestedProjectId = input?.projectId?.trim()
  const activeProjectId = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)?.id
    : projects[0]?.id

  if (!activeProjectId) {
    return {
      projects: [],
      activeProjectId: null,
      assets: [],
      storyboards: [],
      styleOptions: visualStyleOptions(),
    }
  }

  const type = input?.type && Object.values(AssetType).includes(input.type as AssetType)
    ? input.type as AssetType
    : undefined
  const q = input?.q?.trim()

  const assets = await prisma.asset.findMany({
    where: {
      projectId: activeProjectId,
      ...(type ? { type } : {}),
      ...(q
        ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { tags: { has: q } },
          ],
        }
        : {}),
    },
    include: {
      createdBy: {
        select: { id: true, name: true, email: true },
      },
      selectedImage: {
        include: { media: true },
      },
      images: {
        include: { media: true },
        orderBy: { createdAt: 'desc' },
      },
      tasks: {
        where: { type: 'image_generation' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { updatedAt: 'desc' },
  })

  const storyboards = await getProjectStoryboards(activeProjectId)

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      workspaceName: project.workspace.name,
      visualStyle: project.visualStyle,
      customStylePrompt: project.customStylePrompt,
    })),
    activeProjectId,
    styleOptions: visualStyleOptions(),
    storyboards,
    assets: assets.map((asset) => ({
      id: asset.id,
      projectId: asset.projectId,
      type: asset.type,
      name: asset.name,
      description: asset.description,
      tags: asset.tags,
      prompt: asset.prompt,
      videoPrompt: asset.videoPrompt,
      selectedImageId: asset.selectedImageId,
      selectedImageUrl: asset.selectedImage?.media ? assetImageUrl(asset.selectedImage.media.id) : null,
      latestTask: asset.tasks[0]
        ? {
          id: asset.tasks[0].id,
          type: asset.tasks[0].type,
          status: asset.tasks[0].status,
          progress: asset.tasks[0].progress,
          error: asset.tasks[0].error,
          assetId: asset.id,
          projectId: asset.projectId,
          model: asset.tasks[0].model,
          createdAt: asset.tasks[0].createdAt.toISOString(),
        }
        : null,
      createdBy: asset.createdBy,
      updatedAt: asset.updatedAt.toISOString(),
      images: asset.images.map((image) => ({
        id: image.id,
        mediaId: image.mediaId,
        url: assetImageUrl(image.mediaId),
        prompt: image.prompt,
        variant: image.variant,
        isSelected: image.isSelected,
        createdAt: image.createdAt.toISOString(),
      })),
    })),
  }
}

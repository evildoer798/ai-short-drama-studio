import { AssetType, ProjectRole } from '@prisma/client'
import { prisma } from './db'
import { HttpError } from './http'

export async function requireProjectAccess(projectId: string, userId: string) {
  const membership = await prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId,
      },
    },
    include: {
      project: {
        include: {
          workspace: true,
        },
      },
    },
  })

  if (!membership) {
    throw new HttpError(403, 'PROJECT_FORBIDDEN', 'Project access denied')
  }

  return membership
}

export async function requireWritableProject(projectId: string, userId: string) {
  const membership = await requireProjectAccess(projectId, userId)
  if (![ProjectRole.owner, ProjectRole.admin, ProjectRole.member].includes(membership.role)) {
    throw new HttpError(403, 'PROJECT_READONLY', 'Project is read only')
  }
  return membership
}

export async function requireAssetAccess(assetId: string, userId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      project: true,
      images: {
        include: { media: true },
        orderBy: { createdAt: 'desc' },
      },
      selectedImage: {
        include: { media: true },
      },
    },
  })

  if (!asset) {
    throw new HttpError(404, 'ASSET_NOT_FOUND', 'Asset not found')
  }

  await requireProjectAccess(asset.projectId, userId)
  return asset
}

export async function requireStoryboardAccess(storyboardId: string, userId: string) {
  const storyboard = await prisma.storyboard.findUnique({
    where: { id: storyboardId },
    include: {
      project: true,
      episode: {
        select: { id: true, episodeNumber: true, title: true, content: true },
      },
      assetLinks: {
        include: {
          asset: {
            include: {
              selectedImage: { include: { media: true } },
            },
          },
        },
        orderBy: { referenceOrder: 'asc' },
      },
      videos: {
        include: { media: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!storyboard) {
    throw new HttpError(404, 'STORYBOARD_NOT_FOUND', 'Storyboard not found')
  }

  await requireProjectAccess(storyboard.projectId, userId)
  return storyboard
}

export async function requireScriptEpisodeAccess(episodeId: string, userId: string) {
  const episode = await prisma.scriptEpisode.findUnique({
    where: { id: episodeId },
    include: {
      comments: { orderBy: { createdAt: 'asc' } },
      project: true,
    },
  })
  if (!episode) {
    throw new HttpError(404, 'SCRIPT_EPISODE_NOT_FOUND', '分集剧本不存在')
  }
  await requireProjectAccess(episode.projectId, userId)
  return episode
}

export async function requireScriptCommentAccess(commentId: string, userId: string) {
  const comment = await prisma.scriptComment.findUnique({
    where: { id: commentId },
    include: { episode: true },
  })
  if (!comment) {
    throw new HttpError(404, 'SCRIPT_COMMENT_NOT_FOUND', '评论不存在')
  }
  await requireProjectAccess(comment.episode.projectId, userId)
  return comment
}

export function isAssetType(value: unknown): value is AssetType {
  return value === AssetType.character || value === AssetType.location || value === AssetType.prop
}

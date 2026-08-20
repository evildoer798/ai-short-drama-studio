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

export async function requireCanvasAccess(canvasId: string, userId: string) {
  const canvas = await prisma.creativeCanvas.findUnique({ where: { id: canvasId } })
  if (!canvas) throw new HttpError(404, 'CANVAS_NOT_FOUND', '画布不存在')
  if (canvas.userId !== userId) throw new HttpError(403, 'CANVAS_FORBIDDEN', '无权访问该画布')
  return canvas
}

export async function requireCanvasNodeAccess(nodeId: string, userId: string) {
  const node = await prisma.canvasNode.findUnique({
    where: { id: nodeId },
    include: {
      canvas: true,
      media: true,
      incomingEdges: { orderBy: { referenceOrder: 'asc' } },
      outgoingEdges: true,
      imageTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
      videoTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
      audioTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })
  if (!node) throw new HttpError(404, 'CANVAS_NODE_NOT_FOUND', '画布节点不存在')
  if (node.canvas.userId !== userId) throw new HttpError(403, 'CANVAS_FORBIDDEN', '无权访问该画布')
  return node
}

export async function requireCanvasVideoTaskAccess(taskId: string, userId: string) {
  const task = await prisma.canvasVideoTask.findUnique({
    where: { id: taskId },
    include: { canvas: true, node: { include: { media: true } } },
  })
  if (!task) throw new HttpError(404, 'CANVAS_TASK_NOT_FOUND', '画布视频任务不存在')
  if (task.createdById !== userId || task.canvas.userId !== userId) {
    throw new HttpError(403, 'CANVAS_FORBIDDEN', '无权访问该任务')
  }
  return task
}

export async function requireDirectorProductionAccess(productionId: string, userId: string) {
  const production = await prisma.directorProduction.findUnique({
    where: { id: productionId },
    include: { project: true, sourceEpisode: true },
  })
  if (!production) throw new HttpError(404, 'DIRECTOR_PRODUCTION_NOT_FOUND', '导演制作不存在')
  await requireProjectAccess(production.projectId, userId)
  return production
}

export async function requireDirectorShotAccess(shotId: string, userId: string) {
  const shot = await prisma.directorShot.findUnique({
    where: { id: shotId },
    include: { production: true },
  })
  if (!shot) throw new HttpError(404, 'DIRECTOR_SHOT_NOT_FOUND', '导演镜头不存在')
  await requireProjectAccess(shot.production.projectId, userId)
  return shot
}

export async function requireDirectorVideoTaskAccess(taskId: string, userId: string) {
  const task = await prisma.directorVideoTask.findUnique({
    where: { id: taskId },
    include: {
      shot: { include: { production: true } },
      videoVersion: { include: { media: true } },
    },
  })
  if (!task) throw new HttpError(404, 'DIRECTOR_VIDEO_TASK_NOT_FOUND', '导演视频任务不存在')
  await requireProjectAccess(task.shot.production.projectId, userId)
  return task
}

export async function requireDirectorKeyframeAccess(keyframeId: string, userId: string) {
  const keyframe = await prisma.directorKeyframe.findUnique({
    where: { id: keyframeId }, include: { production: true },
  })
  if (!keyframe) throw new HttpError(404, 'DIRECTOR_KEYFRAME_NOT_FOUND', '导演关键帧不存在')
  await requireProjectAccess(keyframe.production.projectId, userId)
  return keyframe
}

export async function requireDirectorStateAssetAccess(stateAssetId: string, userId: string) {
  const stateAsset = await prisma.directorCharacterStateAsset.findUnique({
    where: { id: stateAssetId }, include: { production: true },
  })
  if (!stateAsset) throw new HttpError(404, 'DIRECTOR_STATE_ASSET_NOT_FOUND', '角色状态资产不存在')
  await requireProjectAccess(stateAsset.production.projectId, userId)
  return stateAsset
}

export function isAssetType(value: unknown): value is AssetType {
  return value === AssetType.character || value === AssetType.location || value === AssetType.prop
}

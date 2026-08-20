import { DirectorStage, DirectorStageStatus, Prisma } from '@prisma/client'
import { prisma } from './db'
import { readableDirectorStageError } from './director-system'
import { isIdentityMasterStateId, syncDirectorCharacterStateAssets } from './director-state-assets'

const mediaUrl = (mediaId: string) => `/api/media/${mediaId}`

export async function getDirectorHomeData(userId: string) {
  const [workspaces, projects, productions] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        workspace: { select: { id: true, name: true } },
      },
    }),
    prisma.project.findMany({
      where: { members: { some: { userId } } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        visualStyle: true,
        scriptEpisodes: {
          orderBy: { episodeNumber: 'asc' },
          select: { id: true, episodeNumber: true, title: true, locked: true },
        },
        _count: { select: { assets: true } },
      },
    }),
    prisma.directorProduction.findMany({
      where: { project: { members: { some: { userId } } }, status: { not: 'archived' } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, name: true, currentStage: true, status: true, updatedAt: true,
        project: { select: { id: true, name: true } },
        sourceEpisode: { select: { episodeNumber: true, title: true } },
        _count: { select: { shots: true } },
        stageVersions: {
          where: { status: DirectorStageStatus.confirmed },
          select: { stage: true },
        },
      },
    }),
  ])
  return {
    workspaces: workspaces.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      role: membership.role,
    })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      visualStyle: project.visualStyle,
      assetCount: project._count.assets,
      episodes: project.scriptEpisodes,
    })),
    productions: productions.map((production) => ({
      ...production,
      updatedAt: production.updatedAt.toISOString(),
      confirmedStages: production.stageVersions.map((version) => version.stage),
      shotCount: production._count.shots,
    })),
  }
}

export async function getDirectorProductionData(productionId: string) {
  const latestLira = await prisma.directorStageVersion.findFirst({
    where: { productionId, stage: DirectorStage.lira, output: { not: Prisma.DbNull } },
    orderBy: { version: 'desc' },
    select: { output: true },
  })
  if (latestLira?.output) await syncDirectorCharacterStateAssets(productionId, latestLira.output)
  const production = await prisma.directorProduction.findUniqueOrThrow({
    where: { id: productionId },
    include: {
      project: { select: { id: true, name: true, visualStyle: true, customStylePrompt: true } },
      sourceEpisode: { select: { id: true, episodeNumber: true, title: true, content: true } },
      stageVersions: { orderBy: [{ stage: 'asc' }, { version: 'desc' }] },
      keyframes: {
        orderBy: [{ shotKey: 'asc' }, { frameType: 'asc' }],
        include: {
          selectedImageVersion: { include: { media: true } },
          imageVersions: { include: { media: true }, orderBy: { version: 'desc' } },
          imageTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
      characterStateAssets: {
        orderBy: [{ assetName: 'asc' }, { stateName: 'asc' }],
        include: {
          selectedImageVersion: { include: { media: true } },
          imageVersions: { include: { media: true }, orderBy: { version: 'desc' } },
          imageTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
      shots: {
        orderBy: { order: 'asc' },
        include: {
          selectedVideoVersion: { include: { media: true } },
          videoVersions: { include: { media: true }, orderBy: { version: 'desc' } },
          videoTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  })
  const latestStages = new Map<string, typeof production.stageVersions[number]>()
  for (const version of production.stageVersions) {
    if (!latestStages.has(version.stage)) latestStages.set(version.stage, version)
  }
  return {
    id: production.id,
    name: production.name,
    currentStage: production.currentStage,
    status: production.status,
    settings: production.settings,
    sourceSnapshot: production.sourceSnapshot,
    createdAt: production.createdAt.toISOString(),
    updatedAt: production.updatedAt.toISOString(),
    project: production.project,
    sourceEpisode: production.sourceEpisode,
    stages: [DirectorStage.acting, DirectorStage.lira, DirectorStage.cinedance].map((stage) => {
      const version = latestStages.get(stage)
      return version ? {
        id: version.id,
        stage: version.stage,
        version: version.version,
        status: version.status,
        output: version.output,
        feedback: version.feedback,
        error: version.error ? readableDirectorStageError(new Error(version.error)) : null,
        skillName: version.skillName,
        skillVersion: version.skillVersion,
        confirmedAt: version.confirmedAt?.toISOString() || null,
        updatedAt: version.updatedAt.toISOString(),
      } : { stage, version: 0, status: 'draft', output: null, feedback: null, error: null }
    }),
    keyframes: production.keyframes.map((frame) => ({
      id: frame.id,
      shotKey: frame.shotKey,
      title: frame.title,
      frameType: frame.frameType,
      prompt: frame.prompt,
      aspectRatio: frame.aspectRatio,
      selectedImageVersionId: frame.selectedImageVersionId,
      activeTask: frame.imageTasks[0] ? {
        id: frame.imageTasks[0].id,
        status: frame.imageTasks[0].status,
        progress: frame.imageTasks[0].progress,
        error: frame.imageTasks[0].error,
      } : null,
      versions: frame.imageVersions.map((version) => ({
        id: version.id,
        version: version.version,
        model: version.model,
        prompt: version.prompt,
        mediaId: version.mediaId,
        url: mediaUrl(version.mediaId),
        createdAt: version.createdAt.toISOString(),
      })),
    })),
    characterStateAssets: production.characterStateAssets.map((asset) => ({
      id: asset.id,
      stateId: asset.stateId,
      isIdentityMaster: isIdentityMasterStateId(asset.stateId),
      assetId: asset.assetId,
      assetName: asset.assetName,
      stateName: asset.stateName,
      prompt: asset.prompt,
      imageModelRoute: asset.imageModelRoute,
      soulIdRequired: asset.soulIdRequired,
      selectedImageVersionId: asset.selectedImageVersionId,
      activeTask: asset.imageTasks[0] ? {
        id: asset.imageTasks[0].id,
        status: asset.imageTasks[0].status,
        progress: asset.imageTasks[0].progress,
        error: asset.imageTasks[0].error,
      } : null,
      versions: asset.imageVersions.map((version) => ({
        id: version.id,
        version: version.version,
        model: version.model,
        prompt: version.prompt,
        mediaId: version.mediaId,
        url: mediaUrl(version.mediaId),
        createdAt: version.createdAt.toISOString(),
      })),
    })),
    shots: production.shots.map((shot) => ({
      id: shot.id,
      order: shot.order,
      title: shot.title,
      scriptExcerpt: shot.scriptExcerpt,
      duration: shot.duration,
      aspectRatio: shot.aspectRatio,
      performance: shot.performance,
      visualPlan: shot.visualPlan,
      motionPlan: shot.motionPlan,
      continuityIn: shot.continuityIn,
      continuityOut: shot.continuityOut,
      generationPrompt: shot.generationPrompt,
      selectedVideoVersionId: shot.selectedVideoVersionId,
      activeTask: shot.videoTasks[0] ? {
        id: shot.videoTasks[0].id,
        status: shot.videoTasks[0].status,
        progress: shot.videoTasks[0].progress,
        error: shot.videoTasks[0].error,
      } : null,
      versions: shot.videoVersions.map((version) => ({
        id: version.id,
        version: version.version,
        name: version.name,
        model: version.model,
        duration: version.duration,
        aspectRatio: version.aspectRatio,
        decision: version.decision,
        reviewNote: version.reviewNote,
        mediaId: version.mediaId,
        url: mediaUrl(version.mediaId),
        downloadUrl: `${mediaUrl(version.mediaId)}?download=1`,
        createdAt: version.createdAt.toISOString(),
      })),
    })),
  }
}

export async function createDirectorSourceSnapshot(projectId: string, sourceEpisodeId?: string | null) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true, name: true, visualStyle: true, customStylePrompt: true,
      assets: {
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        select: {
          id: true, type: true, name: true, description: true, tags: true, prompt: true,
          selectedImage: { select: { mediaId: true } },
          actingProfile: true,
          voiceProfile: true,
        },
      },
      scriptEpisodes: {
        where: sourceEpisodeId ? { id: sourceEpisodeId } : undefined,
        orderBy: { episodeNumber: 'asc' },
        take: sourceEpisodeId ? undefined : 1,
        select: { id: true, episodeNumber: true, title: true, logline: true, content: true, locked: true },
      },
    },
  })
  return {
    capturedAt: new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      visualStyle: project.visualStyle,
      customStylePrompt: project.customStylePrompt,
    },
    episodes: project.scriptEpisodes,
    assets: project.assets.map((asset) => ({
      ...asset,
      selectedImage: asset.selectedImage ? {
        mediaId: asset.selectedImage.mediaId,
        url: mediaUrl(asset.selectedImage.mediaId),
      } : null,
    })),
  }
}

import { assetImageUrl } from './assets'
import { prisma } from './db'
import { deriveProjectStage, type ProjectHubData } from './projects'
import { getVisualStylePreset, visualStyleOptions } from './visual-styles'

function latestDate(values: Array<Date | null | undefined>) {
  return new Date(Math.max(...values.filter(Boolean).map((value) => value!.getTime())))
}

export async function getProjectHubData(userId: string): Promise<ProjectHubData> {
  const [workspaceMemberships, projects] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.project.findMany({
      where: { members: { some: { userId } } },
      include: {
        workspace: { select: { name: true } },
        members: {
          where: { userId },
          select: { role: true },
        },
        novelSource: { select: { updatedAt: true } },
        _count: {
          select: {
            assets: true,
            storyboards: true,
            scriptEpisodes: true,
            renders: true,
          },
        },
        assets: {
          where: { selectedImageId: { not: null } },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: {
            updatedAt: true,
            selectedImage: { select: { mediaId: true } },
          },
        },
        scriptEpisodes: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { updatedAt: true },
        },
        storyboards: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { updatedAt: true },
        },
        renders: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
        tasks: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { updatedAt: true, status: true },
        },
      },
    }),
  ])

  const projectItems = projects.map((project) => {
    const cover = project.assets[0]?.selectedImage
    const stage = deriveProjectStage({
      hasNovel: Boolean(project.novelSource),
      episodeCount: project._count.scriptEpisodes,
      storyboardCount: project._count.storyboards,
      assetCount: project._count.assets,
      renderCount: project._count.renders,
    })
    const lastActivityAt = latestDate([
      project.updatedAt,
      project.novelSource?.updatedAt,
      project.assets[0]?.updatedAt,
      project.scriptEpisodes[0]?.updatedAt,
      project.storyboards[0]?.updatedAt,
      project.renders[0]?.createdAt,
      project.tasks[0]?.updatedAt,
    ])

    return {
      id: project.id,
      name: project.name,
      workspaceName: project.workspace.name,
      role: project.members[0].role,
      visualStyle: project.visualStyle,
      visualStyleLabel: getVisualStylePreset(project.visualStyle).label,
      coverUrl: cover ? assetImageUrl(cover.mediaId) : null,
      stage,
      episodeCount: project._count.scriptEpisodes,
      assetCount: project._count.assets,
      storyboardCount: project._count.storyboards,
      renderCount: project._count.renders,
      activeTask: project.tasks[0]?.status === 'queued' || project.tasks[0]?.status === 'processing',
      lastActivityAt: lastActivityAt.toISOString(),
    }
  }).sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))

  return {
    workspaces: workspaceMemberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      role: membership.role,
      memberCount: membership.workspace._count.members,
    })),
    projects: projectItems,
    styleOptions: visualStyleOptions(),
  }
}

import { PrismaClient } from '@prisma/client'
import { buildStoryboardGenerationPrompt } from '../src/lib/preproduction-prompts'
import { matchStoryboardAssets } from '../src/lib/storyboards'

const prisma = new PrismaClient()

async function main() {
  const projectId = process.argv[2]
  if (!projectId) throw new Error('projectId is required')

  const [tasks, episodes, project, assets] = await Promise.all([
    prisma.generationTask.findMany({
      where: { projectId, type: 'storyboard_generation' },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        status: true,
        progress: true,
        model: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        error: true,
        payload: true,
      },
    }),
    prisma.scriptEpisode.findMany({
      where: { projectId },
      orderBy: { episodeNumber: 'asc' },
      select: {
        episodeNumber: true,
        title: true,
        content: true,
        _count: { select: { storyboards: true } },
      },
    }),
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.asset.findMany({
      where: { projectId },
      select: { id: true, type: true, name: true, description: true, tags: true },
    }),
  ])

  const promptStats = episodes.slice(0, 3).map((episode) => {
    const relatedAssets = matchStoryboardAssets(
      assets,
      `${episode.title}\n${episode.content}`,
      28,
    )
    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: episode.episodeNumber,
      episodeTitle: episode.title,
      script: episode.content,
      assets: relatedAssets,
      allAssetNames: assets,
      visualStyle: project.visualStyle,
      customStylePrompt: project.customStylePrompt,
    })
    return {
      episodeNumber: episode.episodeNumber,
      promptChars: prompt.length,
      relatedAssets: relatedAssets.length,
      relatedDescriptionChars: relatedAssets.reduce((sum, asset) => sum + asset.description.length, 0),
      allAssetNameChars: assets.reduce((sum, asset) => sum + asset.name.length, 0),
    }
  })

  console.log(JSON.stringify({
    tasks: tasks.map((task) => ({
      ...task,
      payload: task.payload && typeof task.payload === 'object'
        ? Object.keys(task.payload as Record<string, unknown>)
        : [],
      error: task.error?.slice(0, 500) || null,
      elapsedSeconds: task.startedAt && task.completedAt
        ? Math.round((task.completedAt.getTime() - task.startedAt.getTime()) / 1000)
        : null,
    })),
    episodes: episodes.map((episode) => ({
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      scriptChars: episode.content.length,
      shots: episode._count.storyboards,
    })),
    promptStats,
  }, null, 2))
}

main()
  .finally(async () => prisma.$disconnect())

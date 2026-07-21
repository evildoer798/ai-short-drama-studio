import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { HttpError, routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import {
  buildStoryboardGenerationPrompt,
  STORYBOARD_SYSTEM_PROMPT,
} from '@/lib/preproduction-prompts'
import { matchStoryboardAssets } from '@/lib/storyboards'
import { textStoryboardParallelism } from '@/lib/text-api-pool'

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireProjectAccess(projectId, user.id)

    const requestedEpisodeId = new URL(request.url).searchParams.get('episodeId')
    const [project, episode, assets] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { visualStyle: true, customStylePrompt: true },
      }),
      prisma.scriptEpisode.findFirst({
        where: {
          projectId,
          ...(requestedEpisodeId ? { id: requestedEpisodeId } : {}),
        },
        orderBy: { episodeNumber: 'asc' },
      }),
      prisma.asset.findMany({
        where: { projectId },
        select: { id: true, type: true, name: true, description: true, tags: true },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      }),
    ])

    if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
    if (!episode) throw new HttpError(404, 'EPISODE_NOT_FOUND', '分集剧本不存在')

    const relatedAssets = matchStoryboardAssets(
      assets,
      `${episode.title}\n${episode.logline || ''}\n${episode.content}`,
      28,
    )
    const prompt = buildStoryboardGenerationPrompt({
      episodeNumber: episode.episodeNumber,
      episodeTitle: episode.title,
      script: episode.content,
      assets: relatedAssets.map((asset) => ({
        type: asset.type,
        name: asset.name,
        description: asset.description,
      })),
      allAssetNames: assets.map((asset) => ({ type: asset.type, name: asset.name })),
      visualStyle: project.visualStyle,
      customStylePrompt: project.customStylePrompt,
    })

    return NextResponse.json({
      system: STORYBOARD_SYSTEM_PROMPT,
      prompt,
      provider: env.textApiBaseUrl(),
      model: env.textModel(),
      mode: env.textApiMode(),
      episode: {
        id: episode.id,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
      },
      relatedAssetCount: relatedAssets.length,
      totalAssetCount: assets.length,
      parallelism: textStoryboardParallelism({
        requested: env.textStoryboardConcurrency(),
        keyCount: env.textApiKeys().length * env.textPrimaryConcurrencyPerKey(),
        pendingEpisodeCount: 60,
      }),
    })
  })
}

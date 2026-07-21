import { NextRequest, NextResponse } from 'next/server'
import { GenerationTaskType } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { buildDefaultPrompt, createAssetSchema, deriveAssetMetadata, normalizeTags } from '@/lib/assets'
import { requireWritableProject } from '@/lib/permissions'
import { getWorkspaceData } from '@/lib/workspace-data'
import { routeHandler } from '@/lib/http'
import { buildStyledAssetPrompt } from '@/lib/visual-styles'
import { env } from '@/lib/env'
import { enqueueImageGenerationTask } from '@/lib/queue'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const searchParams = request.nextUrl.searchParams
    const data = await getWorkspaceData(user.id, {
      projectId: searchParams.get('projectId'),
      type: searchParams.get('type'),
      q: searchParams.get('q'),
    })
    return NextResponse.json(data)
  })
}

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await requireUser()
    const body = createAssetSchema.parse(await request.json())
    const membership = await requireWritableProject(body.projectId, user.id)
    const metadata = deriveAssetMetadata({
      type: body.type,
      prompt: body.prompt || body.description || body.name || '',
    })
    const name = body.name || metadata.name
    const description = body.description || metadata.description
    const tags = normalizeTags(body.tags.length > 0 ? body.tags : metadata.tags)
    const assetPrompt = body.prompt || buildDefaultPrompt({ type: body.type, name, description })

    const asset = await prisma.asset.create({
      data: {
        projectId: body.projectId,
        type: body.type,
        name,
        description,
        tags,
        prompt: assetPrompt,
        videoPrompt: body.videoPrompt || null,
        createdById: user.id,
      },
    })

    let task = null
    if (body.generateImmediately) {
      const prompt = buildStyledAssetPrompt({
        asset,
        visualStyle: membership.project.visualStyle,
        customStylePrompt: membership.project.customStylePrompt,
      })
      task = await prisma.generationTask.create({
        data: {
          type: GenerationTaskType.image_generation,
          status: 'queued',
          projectId: asset.projectId,
          assetId: asset.id,
          createdById: user.id,
          model: env.imageModel(),
          prompt,
          requestedCount: 1,
        },
      })
      await enqueueImageGenerationTask(task.id)
    }

    return NextResponse.json({ asset, task }, { status: 201 })
  })
}

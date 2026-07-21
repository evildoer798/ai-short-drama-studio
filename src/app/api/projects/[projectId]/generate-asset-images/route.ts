import { NextResponse } from 'next/server'
import { AssetType } from '@prisma/client'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { routeHandler } from '@/lib/http'
import { submitAssetImageTask } from '@/lib/image-task-submission'
import { requireWritableProject } from '@/lib/permissions'

const batchSchema = z.object({
  count: z.coerce.number().int().min(1).max(4).default(1),
})

const typePriority = {
  [AssetType.character]: 3,
  [AssetType.location]: 2,
  [AssetType.prop]: 1,
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    const membership = await requireWritableProject(projectId, user.id)
    const body = batchSchema.parse(await request.json().catch(() => ({})))
    const [totalAssets, pendingAssets] = await Promise.all([
      prisma.asset.count({ where: { projectId } }),
      prisma.asset.findMany({
        where: { projectId, images: { none: {} } },
        select: {
          id: true,
          projectId: true,
          type: true,
          name: true,
          description: true,
          prompt: true,
        },
      }),
    ])
    pendingAssets.sort((left, right) => (
      typePriority[right.type] - typePriority[left.type]
      || left.name.localeCompare(right.name, 'zh-CN')
    ))

    const tasks = []
    const failures: Array<{ assetId: string; name: string }> = []
    let submitted = 0
    let reused = 0
    for (const asset of pendingAssets) {
      try {
        const result = await submitAssetImageTask({
          asset,
          createdById: user.id,
          visualStyle: membership.project.visualStyle,
          customStylePrompt: membership.project.customStylePrompt,
          count: body.count,
        })
        tasks.push(result.task)
        if (result.reused) reused++
        else submitted++
      } catch {
        failures.push({ assetId: asset.id, name: asset.name })
      }
    }

    return NextResponse.json({
      tasks,
      submitted,
      reused,
      skippedWithImages: totalAssets - pendingAssets.length,
      failures,
      totalAssets,
    }, { status: tasks.length > 0 ? 202 : 200 })
  })
}

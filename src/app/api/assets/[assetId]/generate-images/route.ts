import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { generateImagesSchema } from '@/lib/assets'
import { requireAssetAccess } from '@/lib/permissions'
import { routeHandler } from '@/lib/http'
import { submitAssetImageTask } from '@/lib/image-task-submission'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const asset = await requireAssetAccess(assetId, user.id)
    const body = generateImagesSchema.parse(await request.json())
    const result = await submitAssetImageTask({
      asset,
      createdById: user.id,
      visualStyle: asset.project.visualStyle,
      customStylePrompt: asset.project.customStylePrompt,
      promptOverride: body.prompt,
      count: body.count,
    })
    return NextResponse.json(result, { status: 202 })
  })
}

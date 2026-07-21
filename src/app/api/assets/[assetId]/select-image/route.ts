import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { selectImageSchema } from '@/lib/assets'
import { HttpError, routeHandler } from '@/lib/http'
import { requireAssetAccess } from '@/lib/permissions'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    await requireAssetAccess(assetId, user.id)
    const body = selectImageSchema.parse(await request.json())

    const image = await prisma.assetImage.findFirst({
      where: {
        id: body.imageId,
        assetId,
      },
    })
    if (!image) {
      throw new HttpError(404, 'IMAGE_NOT_FOUND', 'Image not found')
    }

    await prisma.$transaction([
      prisma.assetImage.updateMany({
        where: { assetId },
        data: { isSelected: false },
      }),
      prisma.assetImage.update({
        where: { id: image.id },
        data: { isSelected: true },
      }),
      prisma.asset.update({
        where: { id: assetId },
        data: { selectedImageId: image.id },
      }),
    ])

    return NextResponse.json({ ok: true })
  })
}

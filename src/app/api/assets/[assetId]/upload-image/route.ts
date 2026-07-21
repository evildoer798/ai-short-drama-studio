import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  assetImageUploadMaxBytes,
  assetImageUrl,
  detectUploadedImageMimeType,
} from '@/lib/assets'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireAssetAccess, requireWritableProject } from '@/lib/permissions'
import {
  buildStorageKey,
  deleteStorageObject,
  uploadBuffer,
} from '@/lib/storage'

function safeUploadName(value: string) {
  return value.replace(/[\r\n]/g, ' ').trim().slice(0, 180) || '本地图片'
}

function retryableTransactionError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === 'P2002' || error.code === 'P2034')
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { assetId } = await context.params
    const asset = await requireAssetAccess(assetId, user.id)
    await requireWritableProject(asset.projectId, user.id)

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      throw new HttpError(400, 'ASSET_IMAGE_REQUIRED', '请选择要上传的图片')
    }
    if (file.size === 0) {
      throw new HttpError(400, 'ASSET_IMAGE_EMPTY', '图片文件为空')
    }
    if (file.size > assetImageUploadMaxBytes) {
      throw new HttpError(413, 'ASSET_IMAGE_TOO_LARGE', '图片不能超过 20MB')
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const mimeType = detectUploadedImageMimeType(buffer)
    if (!mimeType) {
      throw new HttpError(415, 'ASSET_IMAGE_UNSUPPORTED', '只支持 JPG、PNG 或 WebP 图片')
    }
    const selectAsPrimary = formData.get('selectAsPrimary') !== 'false'
    const storageKey = buildStorageKey({
      projectId: asset.projectId,
      assetId,
      mimeType,
    })
    await uploadBuffer({ key: storageKey, body: buffer, mimeType })

    try {
      let created: Awaited<ReturnType<typeof persistUploadedImage>> | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          created = await persistUploadedImage({
            assetId,
            storageKey,
            mimeType,
            sizeBytes: buffer.byteLength,
            prompt: `用户上传：${safeUploadName(file.name)}`,
            selectAsPrimary,
          })
          break
        } catch (error) {
          if (!retryableTransactionError(error) || attempt === 2) throw error
        }
      }
      if (!created) throw new Error('ASSET_IMAGE_PERSIST_FAILED')

      return NextResponse.json({
        image: {
          id: created.id,
          mediaId: created.mediaId,
          url: assetImageUrl(created.mediaId),
          prompt: created.prompt,
          variant: created.variant,
          isSelected: created.isSelected,
          createdAt: created.createdAt.toISOString(),
        },
      }, { status: 201 })
    } catch (error) {
      await deleteStorageObject(storageKey).catch(() => undefined)
      throw error
    }
  })
}

async function persistUploadedImage(input: {
  assetId: string
  storageKey: string
  mimeType: string
  sizeBytes: number
  prompt: string
  selectAsPrimary: boolean
}) {
  return prisma.$transaction(async (tx) => {
    const [latestVariant, currentAsset] = await Promise.all([
      tx.assetImage.aggregate({
        where: { assetId: input.assetId },
        _max: { variant: true },
      }),
      tx.asset.findUnique({
        where: { id: input.assetId },
        select: { selectedImageId: true },
      }),
    ])
    if (!currentAsset) throw new HttpError(404, 'ASSET_NOT_FOUND', '资产不存在')
    const shouldSelect = input.selectAsPrimary || !currentAsset.selectedImageId
    if (shouldSelect) {
      await tx.assetImage.updateMany({
        where: { assetId: input.assetId },
        data: { isSelected: false },
      })
    }

    const media = await tx.mediaObject.create({
      data: {
        kind: 'image',
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
      },
    })
    const image = await tx.assetImage.create({
      data: {
        assetId: input.assetId,
        mediaId: media.id,
        prompt: input.prompt,
        variant: (latestVariant._max.variant || 0) + 1,
        isSelected: shouldSelect,
      },
    })
    if (shouldSelect) {
      await tx.asset.update({
        where: { id: input.assetId },
        data: { selectedImageId: image.id },
      })
    }
    return image
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

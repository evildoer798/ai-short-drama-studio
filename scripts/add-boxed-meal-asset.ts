import { readFile } from 'node:fs/promises'
import { AssetType, MediaKind, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { buildStorageKey, uploadBuffer } from '@/lib/storage'
import { syncStoryboardAssetLinks } from '@/lib/storyboards'

const projectId = process.argv[2]?.trim()
const imagePath = process.argv[3]?.trim()

if (!projectId || !imagePath) {
  throw new Error('Usage: npx tsx scripts/add-boxed-meal-asset.ts <projectId> <imagePath>')
}

const canonicalName = '90年代白色塑料盒饭（盒饭、饭盒、盒餐、塑料饭盒）'
const description = '90年代普通食堂使用的白色长方形一次性塑料饭盒。固定分格与菜品布局：大格白米饭，小格红烧肉、深绿色蔬菜和少量咸菜；白色微哑光塑料，边缘有轻微使用痕迹。'
const tags = ['90年代', '白色塑料盒', '盒饭', '饭盒', '盒餐', '塑料饭盒', '食堂盒饭', '外卖盒']
const prompt = '90年代中国普通食堂白色长方形一次性塑料盒饭，固定分格结构与菜品布局，大格白米饭，小格红烧肉、深绿色蔬菜和少量咸菜，白色微哑光塑料，轻微使用痕迹，写实影视道具参考图。'
const videoPrompt = '当分镜出现盒饭、饭盒、盒餐或塑料饭盒时，必须使用本资产主图作为道具参考；全片保持同一个白色塑料盒、相同分格、菜品位置、颜色、份量和使用痕迹。禁止变成铁盒、不锈钢盒、彩色现代便当盒或其他包装。'

async function main() {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: {
        orderBy: { createdAt: 'asc' },
        select: { userId: true, role: true },
      },
      storyboards: { select: { id: true } },
    },
  })
  if (!project) throw new Error(`PROJECT_NOT_FOUND: ${projectId}`)
  const creatorId = project.members.find((member) => member.role === 'owner')?.userId
    || project.members[0]?.userId
  if (!creatorId) throw new Error(`PROJECT_MEMBER_NOT_FOUND: ${projectId}`)

  let asset = await prisma.asset.findFirst({
    where: {
      projectId,
      type: AssetType.prop,
      OR: [
        { name: canonicalName },
        { name: { contains: '白色塑料盒饭' } },
      ],
    },
    include: { selectedImage: true },
  })

  if (asset) {
    asset = await prisma.asset.update({
      where: { id: asset.id },
      data: { name: canonicalName, description, tags, prompt, videoPrompt },
      include: { selectedImage: true },
    })
  } else {
    asset = await prisma.asset.create({
      data: {
        projectId,
        type: AssetType.prop,
        name: canonicalName,
        description,
        tags,
        prompt,
        videoPrompt,
        createdById: creatorId,
      },
      include: { selectedImage: true },
    })
  }

  if (!asset.selectedImageId) {
    const body = await readFile(imagePath)
    const storageKey = buildStorageKey({ projectId, assetId: asset.id, mimeType: 'image/png' })
    await uploadBuffer({ key: storageKey, body, mimeType: 'image/png' })
    await prisma.$transaction(async (tx) => {
      const media = await tx.mediaObject.create({
        data: {
          kind: MediaKind.image,
          storageKey,
          mimeType: 'image/png',
          sizeBytes: BigInt(body.byteLength),
        },
      })
      const image = await tx.assetImage.create({
        data: {
          assetId: asset!.id,
          mediaId: media.id,
          prompt: '系统导入：90年代白色塑料盒饭连续性主参考图',
          variant: 1,
          isSelected: true,
        },
      })
      await tx.asset.update({
        where: { id: asset!.id },
        data: { selectedImageId: image.id },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  for (const storyboard of project.storyboards) {
    await syncStoryboardAssetLinks(storyboard.id)
  }
  const linkedStoryboardCount = await prisma.storyboardAsset.count({
    where: { assetId: asset.id },
  })
  const result = await prisma.asset.findUnique({
    where: { id: asset.id },
    select: { id: true, name: true, selectedImageId: true },
  })
  console.log(JSON.stringify({
    projectId,
    asset: result,
    synchronizedStoryboards: project.storyboards.length,
    linkedStoryboardCount,
  }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

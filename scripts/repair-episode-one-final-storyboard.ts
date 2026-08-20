import { readFile } from 'node:fs/promises'
import { AssetType, MediaKind, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { buildStorageKey, uploadBuffer } from '@/lib/storage'
import { createStoryboardRevision } from '@/lib/storyboard-revisions'
import { syncStoryboardAssetLinks } from '@/lib/storyboards'

const projectId = process.argv[2]?.trim()
const signImagePath = process.argv[3]?.trim()
const locationImagePath = process.argv[4]?.trim()

if (!projectId || !signImagePath || !locationImagePath) {
  throw new Error('Usage: npx tsx scripts/repair-episode-one-final-storyboard.ts <projectId> <signImagePath> <locationImagePath>')
}

type AssetSpec = {
  type: AssetType
  name: string
  description: string
  tags: string[]
  prompt: string
  videoPrompt: string
  imagePath: string
  imageLabel: string
}

async function ensureAssetWithImage(spec: AssetSpec, creatorId: string) {
  let asset = await prisma.asset.findFirst({
    where: { projectId, type: spec.type, name: spec.name },
    include: { selectedImage: true },
  })
  if (asset) {
    asset = await prisma.asset.update({
      where: { id: asset.id },
      data: {
        description: spec.description,
        tags: spec.tags,
        prompt: spec.prompt,
        videoPrompt: spec.videoPrompt,
      },
      include: { selectedImage: true },
    })
  } else {
    asset = await prisma.asset.create({
      data: {
        projectId,
        type: spec.type,
        name: spec.name,
        description: spec.description,
        tags: spec.tags,
        prompt: spec.prompt,
        videoPrompt: spec.videoPrompt,
        createdById: creatorId,
      },
      include: { selectedImage: true },
    })
  }

  if (!asset.selectedImageId) {
    const body = await readFile(spec.imagePath)
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
          prompt: `系统导入：${spec.imageLabel}`,
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
  return asset.id
}

const repairedPrompt = `【风格基调】
1990年代中国工厂家属院现实主义短剧，真人写实，夜晚冷灰路灯与饭馆暖光形成对抗。无背景音乐，只保留数钱声、木牌挂钩碰撞声、街道环境声和现场对白。15秒，16:9。禁止字幕、UI、水印和后期叠字；唯一画面文字来自实体道具“两元盒饭价格牌”，必须严格复刻参考图中的“明日盒饭 / 两块！”。
【本分镜人物】
许小梅蹲在许桂芳的三轮盒饭摊旁数钱；许桂芳站在她身侧，听完刚露出笑意。赵金虎位于街对面自己的饭馆门口，手持“两元盒饭价格牌”。三人空间分属两边，不得站到同一摊位。
关键道具：90年代白色塑料盒饭（盒饭、饭盒、盒餐、塑料饭盒）；两元盒饭价格牌（明日盒饭两块、价格牌、低价牌、新牌、牌子）。
【场景】
夜晚｜盒饭竞争街景（许桂芳盒饭摊对面赵金虎饭馆）。同一条窄街完整同框：画面左侧固定为许桂芳的旧蓝色三轮盒饭摊和成摞白色塑料盒饭；道路居中形成清晰分界；画面右侧固定为赵金虎的砖墙饭馆门面和暖黄入口。两处隔街正对，必须一眼看出正在争夺同一批盒饭顾客。
【视频分镜】
0~5s：中近景。许小梅蹲在左侧三轮盒饭摊旁快速数完钱，抬头兴奋看向许桂芳：“妈，二十盒卖了五十块，刨掉米肉菜和煤火，净赚十二块！”许桂芳听完刚露出笑意。
5~8s：硬切广角关系镜头。左前景清楚看到许桂芳、许小梅、旧蓝色三轮车和成摞白色塑料盒饭；越过道路中线，右侧同框看到赵金虎饭馆门面与站在门口的赵金虎。保持两边同时可见至少3秒，明确饭摊与饭馆隔街竞争。
8~11s：切到赵金虎饭馆门口中景。赵金虎“啪”地把“两元盒饭价格牌”挂在门旁挂钩上；木牌正面朝向摄影机，无遮挡，占画面宽度至少三分之一。随后插入正面特写并稳定停留，牌面必须清楚可读：“明日盒饭 / 两块！”。
11~15s：从许桂芳盒饭摊一侧越肩拍向街对面。左侧前景保留三轮车边缘和白色塑料盒饭，右侧清楚看到赵金虎站在饭馆门口、价格牌挂在他身旁。赵金虎冲许桂芳扬下巴：“明天，你一份也别想卖出去。”结尾保持饭摊、道路、饭馆和价格牌的对峙构图。`

async function main() {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      members: { orderBy: { createdAt: 'asc' }, select: { userId: true, role: true } },
    },
  })
  if (!project) throw new Error(`PROJECT_NOT_FOUND: ${projectId}`)
  const creatorId = project.members.find((member) => member.role === 'owner')?.userId
    || project.members[0]?.userId
  if (!creatorId) throw new Error(`PROJECT_MEMBER_NOT_FOUND: ${projectId}`)

  const signAssetId = await ensureAssetWithImage({
    type: AssetType.prop,
    name: '两元盒饭价格牌（明日盒饭两块、价格牌、低价牌、新牌、牌子）',
    description: '90年代饭馆门口使用的旧白色木质价格牌，正面两行黑色手写字：“明日盒饭”“两块！”。',
    tags: ['价格牌', '低价牌', '新牌', '牌子', '明日盒饭', '两块', '竞争道具'],
    prompt: '90年代旧白色木质价格牌，正面两行黑色手写中文：明日盒饭、两块！正视图，文字清晰。',
    videoPrompt: '牌面始终正对镜头并保持可读，严格复刻“明日盒饭 / 两块！”；不得改字、漏字、增加其他文字或变成现代灯箱。',
    imagePath: signImagePath,
    imageLabel: '明日盒饭两块价格牌连续性主参考图',
  }, creatorId)
  const locationAssetId = await ensureAssetWithImage({
    type: AssetType.location,
    name: '盒饭竞争街景（许桂芳盒饭摊对面赵金虎饭馆）',
    description: '同一条90年代工厂家属院窄街：左侧是许桂芳旧蓝色三轮盒饭摊，右侧隔街正对赵金虎砖墙饭馆门面，道路中线清晰分隔两家生意。',
    tags: ['盒饭竞争街景', '盒饭摊', '赵金虎饭馆', '隔街对面', '工厂家属院门口'],
    prompt: '90年代工厂家属院窄街夜景，左侧旧蓝色三轮盒饭摊与白色塑料盒饭，右侧隔街正对砖墙饭馆门面，明确商业竞争关系，写实电影广角建立镜头。',
    videoPrompt: '全镜保持左侧盒饭摊、中央道路、右侧饭馆的固定空间关系；两家隔街正对，禁止合并到同一门面或把两处拍成无关地点。',
    imagePath: locationImagePath,
    imageLabel: '盒饭摊与饭馆隔街竞争关系场景主参考图',
  }, creatorId)

  const storyboard = await prisma.storyboard.findFirst({
    where: { projectId, episode: { episodeNumber: 1 } },
    orderBy: [{ episodeSceneNumber: 'desc' }, { sceneNumber: 'desc' }],
  })
  if (!storyboard) throw new Error(`EPISODE_ONE_STORYBOARD_NOT_FOUND: ${projectId}`)

  await prisma.$transaction(async (tx) => {
    await createStoryboardRevision(tx, storyboard, {
      source: 'production_repair',
      reason: '修复盒饭价格牌不可见及饭馆与盒饭摊竞争关系不清',
      createdById: creatorId,
      validationReport: {
        repaired: ['diegetic_sign_visibility', 'business_rivalry_spatial_relationship'],
      },
    })
    await tx.storyboard.update({
      where: { id: storyboard.id },
      data: {
        title: '许小梅报账，赵金虎隔街挂出两元盒饭牌',
        notes: '盒饭竞争街景（许桂芳盒饭摊对面赵金虎饭馆）',
        videoPrompt: repairedPrompt,
      },
    })
  })
  const matches = await syncStoryboardAssetLinks(storyboard.id)
  console.log(JSON.stringify({
    projectId,
    storyboardId: storyboard.id,
    signAssetId,
    locationAssetId,
    matchedAssets: matches.map((match) => ({ id: match.id, name: match.name, type: match.type })),
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

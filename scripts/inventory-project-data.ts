import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { PrismaClient } from '@prisma/client'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const prisma = new PrismaClient()

const s3 = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION?.trim() || 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim() === 'true',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
})

async function listStorageObjects() {
  const bucket = required('S3_BUCKET')
  const objects: Array<{ key: string, size: number }> = []
  let continuationToken: string | undefined

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }))
    for (const object of page.Contents || []) {
      if (!object.Key) continue
      objects.push({ key: object.Key, size: object.Size || 0 })
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  return {
    bucket,
    objectCount: objects.length,
    totalBytes: objects.reduce((total, object) => total + object.size, 0),
    objects,
  }
}

try {
  const [
    users,
    projects,
    mediaSize,
    storage,
  ] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, username: true, name: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.project.findMany({
      select: {
        id: true,
        name: true,
        workspaceId: true,
        visualStyle: true,
        novelSource: { select: { id: true, title: true, updatedAt: true } },
        _count: {
          select: {
            members: true,
            scriptEpisodes: true,
            assets: true,
            storyboards: true,
            renders: true,
            tasks: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.mediaObject.aggregate({ _sum: { sizeBytes: true } }),
    listStorageObjects(),
  ])

  const counts = {
    users: await prisma.user.count(),
    workspaces: await prisma.workspace.count(),
    workspaceMembers: await prisma.workspaceMember.count(),
    projects: await prisma.project.count(),
    projectMembers: await prisma.projectMember.count(),
    novelSources: await prisma.novelSource.count(),
    scriptEpisodes: await prisma.scriptEpisode.count(),
    scriptComments: await prisma.scriptComment.count(),
    assets: await prisma.asset.count(),
    assetImages: await prisma.assetImage.count(),
    mediaObjects: await prisma.mediaObject.count(),
    storyboards: await prisma.storyboard.count(),
    storyboardAssetLinks: await prisma.storyboardAsset.count(),
    storyboardVideos: await prisma.storyboardVideo.count(),
    projectRenders: await prisma.projectRender.count(),
    generationTasks: await prisma.generationTask.count(),
  }

  console.log(JSON.stringify({
    counts,
    users,
    projects,
    mediaBytesInDatabase: (mediaSize._sum.sizeBytes || 0n).toString(),
    storage,
  }, null, 2))
} finally {
  await prisma.$disconnect()
}

import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { prisma } from '../src/lib/db'
import { env } from '../src/lib/env'
import { getS3Client } from '../src/lib/storage'

const videos = await prisma.storyboardVideo.findMany({
  include: { media: true },
  orderBy: { createdAt: 'desc' },
})

let present = 0
const missing: Array<{ videoId: string, storageKey: string, reason: string }> = []

for (const video of videos) {
  try {
    const result = await getS3Client().send(new HeadObjectCommand({
      Bucket: env.s3Bucket(),
      Key: video.media.storageKey,
    }))
    if (result.ContentLength == null || result.ContentLength <= 0) {
      throw new Error('object is empty')
    }
    present += 1
  } catch (error) {
    missing.push({
      videoId: video.id,
      storageKey: video.media.storageKey,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

console.log(JSON.stringify({ total: videos.length, present, missing }, null, 2))
await prisma.$disconnect()

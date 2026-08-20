import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function publicEndpoint(endpoint: string) {
  return endpoint
    .replace(/-internal(?=\.)/i, '')
    .replace(/:\/\/s3\.(oss-[^.]+\.aliyuncs\.com)/i, '://$1')
}

function safeLocalPath(root: string, key: string) {
  const target = path.resolve(root, ...key.split('/').filter(Boolean))
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe object key: ${key}`)
  }
  return target
}

async function sha256(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function main() {
  const destination = path.resolve(process.argv[2] || '')
  if (!process.argv[2]) throw new Error('Usage: backup-object-storage.ts <destination>')
  await mkdir(destination, { recursive: true })

  const bucket = required('S3_BUCKET')
  const client = new S3Client({
    region: process.env.S3_REGION?.trim() || 'cn-hangzhou',
    endpoint: publicEndpoint(required('S3_ENDPOINT')),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim() !== 'false',
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    },
  })

  const objects: _Object[] = []
  let continuationToken: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1_000,
    }))
    objects.push(...(page.Contents || []).filter((item) => item.Key && !item.Key.endsWith('/')))
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  let cursor = 0
  let completed = 0
  const manifest: Array<Record<string, unknown>> = []
  async function worker() {
    while (true) {
      const index = cursor++
      const object = objects[index]
      if (!object?.Key) return
      const target = safeLocalPath(destination, object.Key)
      const expectedSize = Number(object.Size || 0)
      await mkdir(path.dirname(target), { recursive: true })
      let reused = false
      try {
        reused = (await stat(target)).size === expectedSize
      } catch {
        reused = false
      }
      if (!reused) {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
        if (!response.Body) throw new Error(`Object body missing: ${object.Key}`)
        const temporary = `${target}.part`
        const input = response.Body instanceof Readable
          ? response.Body
          : Readable.fromWeb(response.Body.transformToWebStream() as never)
        await pipeline(input, createWriteStream(temporary))
        const downloadedSize = (await stat(temporary)).size
        if (downloadedSize !== expectedSize) {
          throw new Error(`Size mismatch for ${object.Key}: ${downloadedSize} != ${expectedSize}`)
        }
        await rename(temporary, target)
      }
      manifest[index] = {
        key: object.Key,
        size: expectedSize,
        etag: object.ETag || null,
        lastModified: object.LastModified?.toISOString() || null,
        sha256: await sha256(target),
      }
      completed += 1
      if (completed % 20 === 0 || completed === objects.length) {
        console.log(`OSS_BACKUP_PROGRESS ${completed}/${objects.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, objects.length)) }, () => worker()))
  const totalBytes = manifest.reduce((sum, item) => sum + Number(item.size || 0), 0)
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
    bucket,
    objectCount: objects.length,
    totalBytes,
    completedAt: new Date().toISOString(),
    objects: manifest,
  }, null, 2))
  console.log(`OSS_BACKUP_COMPLETE objects=${objects.length} bytes=${totalBytes}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

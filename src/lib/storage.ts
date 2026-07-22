import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import { env } from './env'

let client: S3Client | null = null
let publicClient: S3Client | null = null
let bucketReady = false

export function getS3Client() {
  client ??= new S3Client({
    region: env.s3Region(),
    endpoint: env.s3Endpoint(),
    forcePathStyle: env.s3ForcePathStyle(),
    credentials: {
      accessKeyId: env.s3AccessKeyId(),
      secretAccessKey: env.s3SecretAccessKey(),
    },
  })
  return client
}

export function publicStorageEndpoint(endpoint: string) {
  return endpoint.replace(/-internal(?=\.)/i, '')
}

function getS3PublicClient() {
  publicClient ??= new S3Client({
    region: env.s3Region(),
    endpoint: publicStorageEndpoint(env.s3Endpoint()),
    forcePathStyle: env.s3ForcePathStyle(),
    credentials: {
      accessKeyId: env.s3AccessKeyId(),
      secretAccessKey: env.s3SecretAccessKey(),
    },
  })
  return publicClient
}

async function ensureBucket() {
  if (bucketReady) return
  const s3 = getS3Client()
  const bucket = env.s3Bucket()
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  bucketReady = true
}

export function extensionForMime(mimeType: string) {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  return 'png'
}

export function buildStoryboardStorageKey(input: {
  projectId: string
  storyboardId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'projects',
    input.projectId,
    'storyboards',
    input.storyboardId,
    `${Date.now()}-${randomUUID()}.${ext}`,
  ].join('/')
}

export function buildStorageKey(input: {
  projectId: string
  assetId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'projects',
    input.projectId,
    'assets',
    input.assetId,
    `${Date.now()}-${randomUUID()}.${ext}`,
  ].join('/')
}

export async function uploadBuffer(input: {
  key: string
  body: Buffer
  mimeType: string
}) {
  await ensureBucket()
  await getS3Client().send(new PutObjectCommand({
    Bucket: env.s3Bucket(),
    Key: input.key,
    Body: input.body,
    ContentType: input.mimeType,
  }))
}

export async function downloadBuffer(storageKey: string) {
  const response = await getS3Client().send(new GetObjectCommand({
    Bucket: env.s3Bucket(),
    Key: storageKey,
  }))
  if (!response.Body) {
    throw new Error(`MEDIA_OBJECT_EMPTY: ${storageKey}`)
  }
  return Buffer.from(await response.Body.transformToByteArray())
}

export async function streamStorageObject(storageKey: string, range?: string) {
  const response = await getS3Client().send(new GetObjectCommand({
    Bucket: env.s3Bucket(),
    Key: storageKey,
    ...(range ? { Range: range } : {}),
  }))
  if (!response.Body) {
    throw new Error(`MEDIA_OBJECT_EMPTY: ${storageKey}`)
  }

  return {
    body: response.Body.transformToWebStream(),
    contentLength: response.ContentLength,
    contentRange: response.ContentRange,
    contentType: response.ContentType,
    etag: response.ETag,
    lastModified: response.LastModified,
  }
}

export async function deleteStorageObject(storageKey: string) {
  await getS3Client().send(new DeleteObjectCommand({
    Bucket: env.s3Bucket(),
    Key: storageKey,
  }))
}

export function attachmentContentDisposition(filename: string) {
  const cleaned = filename.replace(/[\r\n"]/g, '').trim() || 'download'
  const ascii = cleaned.normalize('NFKD').replace(/[^\x20-\x7E]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`
}

export async function signedMediaUrl(storageKey: string, options?: {
  downloadFilename?: string
  mimeType?: string
}) {
  return getSignedUrl(
    getS3PublicClient(),
    new GetObjectCommand({
      Bucket: env.s3Bucket(),
      Key: storageKey,
      ...(options?.downloadFilename
        ? { ResponseContentDisposition: attachmentContentDisposition(options.downloadFilename) }
        : {}),
      ...(options?.mimeType ? { ResponseContentType: options.mimeType } : {}),
    }),
    { expiresIn: 60 * 10 },
  )
}

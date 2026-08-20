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
let writeClient: S3Client | null = null
let publicClient: S3Client | null = null
let bucketReady = false
let bucketReadyPromise: Promise<void> | null = null

function s3ClientConfig(endpoint = env.s3Endpoint()) {
  return {
    region: env.s3Region(),
    endpoint,
    forcePathStyle: env.s3ForcePathStyle(),
    credentials: {
      accessKeyId: env.s3AccessKeyId(),
      secretAccessKey: env.s3SecretAccessKey(),
    },
  }
}

export function getS3Client() {
  client ??= new S3Client(s3ClientConfig())
  return client
}

function getS3WriteClient() {
  // Keep uploads isolated from long-lived media reads. A saturated read socket
  // pool must never block a user from uploading a small image.
  writeClient ??= new S3Client(s3ClientConfig())
  return writeClient
}

export function publicStorageEndpoint(endpoint: string) {
  return endpoint
    .replace(/-internal(?=\.)/i, '')
    .replace(/:\/\/s3\.(oss-[^.]+\.aliyuncs\.com)/i, '://$1')
}

function getS3PublicClient() {
  publicClient ??= new S3Client(s3ClientConfig(publicStorageEndpoint(env.s3Endpoint())))
  return publicClient
}

async function ensureBucket() {
  if (bucketReady) return
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      const s3 = getS3WriteClient()
      const bucket = env.s3Bucket()
      try {
        await s3.send(
          new HeadBucketCommand({ Bucket: bucket }),
          { abortSignal: AbortSignal.timeout(10_000) },
        )
      } catch {
        await s3.send(
          new CreateBucketCommand({ Bucket: bucket }),
          { abortSignal: AbortSignal.timeout(20_000) },
        )
      }
      bucketReady = true
    })().finally(() => {
      bucketReadyPromise = null
    })
  }
  await bucketReadyPromise
}

export function extensionForMime(mimeType: string) {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('aac')) return 'aac'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('m4a') || mimeType.includes('mp4a')) return 'm4a'
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

export function buildStoryboardReferenceMontageStorageKey(input: {
  projectId: string
  storyboardId: string
  taskId: string
  groupIndex: number
}) {
  return [
    'projects',
    input.projectId,
    'storyboards',
    input.storyboardId,
    'reference-montages',
    `${input.taskId}-${input.groupIndex + 1}.mp4`,
  ].join('/')
}

export function buildCanvasStorageKey(input: {
  canvasId: string
  nodeId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'canvases',
    input.canvasId,
    input.nodeId,
    `${Date.now()}-${randomUUID()}.${ext}`,
  ].join('/')
}

export function buildDirectorStorageKey(input: {
  productionId: string
  shotId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'director-productions',
    input.productionId,
    'shots',
    input.shotId,
    `${Date.now()}-${randomUUID()}.${ext}`,
  ].join('/')
}

export function buildDirectorReferenceMontageStorageKey(input: {
  productionId: string
  shotId: string
  taskId: string
  groupIndex: number
}) {
  return [
    'director-productions',
    input.productionId,
    'shots',
    input.shotId,
    'reference-montages',
    `${input.taskId}-${input.groupIndex + 1}.mp4`,
  ].join('/')
}

export function buildDirectorKeyframeStorageKey(input: {
  productionId: string
  keyframeId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'director-productions',
    input.productionId,
    'keyframes',
    input.keyframeId,
    `${Date.now()}-${randomUUID()}.${ext}`,
  ].join('/')
}

export function buildDirectorStateAssetStorageKey(input: {
  productionId: string
  stateAssetId: string
  mimeType: string
}) {
  const ext = extensionForMime(input.mimeType)
  return [
    'director-productions',
    input.productionId,
    'character-states',
    input.stateAssetId,
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
  await getS3WriteClient().send(
    new PutObjectCommand({
      Bucket: env.s3Bucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.mimeType,
    }),
    { abortSignal: AbortSignal.timeout(60_000) },
  )
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
  await getS3WriteClient().send(
    new DeleteObjectCommand({
      Bucket: env.s3Bucket(),
      Key: storageKey,
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  )
}

export function attachmentContentDisposition(filename: string) {
  const cleaned = filename.replace(/[\r\n"]/g, '').trim() || 'download'
  const ascii = cleaned.normalize('NFKD').replace(/[^\x20-\x7E]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`
}

export async function signedMediaUrl(storageKey: string, options?: {
  downloadFilename?: string
  mimeType?: string
  expiresInSeconds?: number
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
    { expiresIn: options?.expiresInSeconds ?? 60 * 10 },
  )
}

import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required in .env.cloudflare`)
  return value
}

function clientFor(prefix: '' | 'SOURCE_') {
  return new S3Client({
    endpoint: required(`${prefix}S3_ENDPOINT`),
    region: process.env[`${prefix}S3_REGION`]?.trim() || (prefix ? 'us-east-1' : 'auto'),
    forcePathStyle: process.env[`${prefix}S3_FORCE_PATH_STYLE`]?.trim() === 'true',
    credentials: {
      accessKeyId: required(`${prefix}S3_ACCESS_KEY_ID`),
      secretAccessKey: required(`${prefix}S3_SECRET_ACCESS_KEY`),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

const source = clientFor('SOURCE_')
const target = clientFor('')
const sourceBucket = required('SOURCE_S3_BUCKET')
const targetBucket = required('S3_BUCKET')

await source.send(new HeadBucketCommand({ Bucket: sourceBucket }))
await target.send(new HeadBucketCommand({ Bucket: targetBucket }))

let continuationToken: string | undefined
let copied = 0
let skipped = 0
let bytes = 0

do {
  const page = await source.send(new ListObjectsV2Command({
    Bucket: sourceBucket,
    ContinuationToken: continuationToken,
  }))

  for (const object of page.Contents || []) {
    if (!object.Key) continue
    const downloaded = await source.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key: object.Key,
    }))
    if (!downloaded.Body) throw new Error(`Source object is empty: ${object.Key}`)
    const body = Buffer.from(await downloaded.Body.transformToByteArray())
    const digest = sha256(body)

    const existing = await target.send(new HeadObjectCommand({
      Bucket: targetBucket,
      Key: object.Key,
    })).catch(() => null)
    if (
      existing?.ContentLength === body.byteLength
      && existing.Metadata?.sha256 === digest
    ) {
      skipped += 1
      console.log(`[skip ${skipped}] ${object.Key}`)
      continue
    }

    await target.send(new PutObjectCommand({
      Bucket: targetBucket,
      Key: object.Key,
      Body: body,
      ContentType: downloaded.ContentType || 'application/octet-stream',
      CacheControl: downloaded.CacheControl,
      ContentDisposition: downloaded.ContentDisposition,
      ContentEncoding: downloaded.ContentEncoding,
      ContentLanguage: downloaded.ContentLanguage,
      Metadata: { sha256: digest },
    }))

    const verification = await target.send(new GetObjectCommand({
      Bucket: targetBucket,
      Key: object.Key,
    }))
    if (!verification.Body) throw new Error(`Target object is empty: ${object.Key}`)
    const verifiedBody = Buffer.from(await verification.Body.transformToByteArray())
    if (verifiedBody.byteLength !== body.byteLength || sha256(verifiedBody) !== digest) {
      throw new Error(`Target verification failed: ${object.Key}`)
    }

    copied += 1
    bytes += body.byteLength
    console.log(`[${copied}] ${object.Key}`)
  }

  continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
} while (continuationToken)

console.log(JSON.stringify({
  ok: true,
  copied,
  skipped,
  bytes,
  sourceBucket,
  targetBucket,
}, null, 2))

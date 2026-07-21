import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required in .env.cloudflare`)
  return value
}

const bucket = required('S3_BUCKET')
const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION?.trim() || 'auto',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim() === 'true',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
})

const key = `_healthcheck/${Date.now()}-${randomUUID()}.txt`
const expected = Buffer.from('ai-short-drama-studio-r2-ok', 'utf8')

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }))
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: expected,
    ContentType: 'text/plain; charset=utf-8',
  }))
  const downloaded = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!downloaded.Body) throw new Error('R2 returned an empty object body')
  const actual = Buffer.from(await downloaded.Body.transformToByteArray())
  if (!actual.equals(expected)) throw new Error('R2 upload/download verification mismatch')
  console.log(JSON.stringify({ ok: true, bucket, endpoint: required('S3_ENDPOINT') }, null, 2))
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined)
}

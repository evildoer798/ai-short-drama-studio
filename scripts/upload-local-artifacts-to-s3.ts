import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function contentType(path: string) {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.html') return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

async function walk(root: string, directory = root): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name === 'migration') continue
    if (entry.isDirectory()) paths.push(...await walk(root, path))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

const root = resolve(argument('--root') || 'artifacts')
const prefix = (argument('--prefix') || `archives/${basename(root)}`).replace(/^\/+|\/+$/g, '')
const bucket = required('S3_BUCKET')
const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION?.trim() || 'cn-hangzhou',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.trim() === 'true',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

await client.send(new HeadBucketCommand({ Bucket: bucket }))

let copied = 0
let skipped = 0
let bytes = 0
for (const path of await walk(root)) {
  const info = await stat(path)
  const key = `${prefix}/${relative(root, path).split(sep).join('/')}`
  const body = await readFile(path)
  const digest = sha256(body)
  const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(() => null)
  if (existing?.ContentLength === info.size && existing.Metadata?.sha256 === digest) {
    skipped += 1
    console.log(`[skip ${skipped}] ${key}`)
    continue
  }

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType(path),
    Metadata: { sha256: digest, source: 'local-artifacts' },
  }))
  const verification = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!verification.Body) throw new Error(`Target object is empty: ${key}`)
  const verifiedBody = Buffer.from(await verification.Body.transformToByteArray())
  if (verifiedBody.byteLength !== body.byteLength || sha256(verifiedBody) !== digest) {
    throw new Error(`Target verification failed: ${key}`)
  }
  copied += 1
  bytes += body.byteLength
  console.log(`[${copied}] ${key}`)
}

console.log(JSON.stringify({ ok: true, root, prefix, bucket, copied, skipped, bytes }, null, 2))

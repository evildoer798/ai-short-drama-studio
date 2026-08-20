import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FRAME_RATE = 24
const IMAGE_SECONDS = 1

type ReferenceMontageImage = {
  bytes: Buffer
  mimeType: string
}

export type ReferenceMontageProbe = {
  codec: string
  pixelFormat: string
  width: number
  height: number
  frameRate: number
  duration: number
  audioStreams: number
}

function imageExtension(mimeType: string) {
  if (/jpe?g/i.test(mimeType)) return 'jpg'
  if (/webp/i.test(mimeType)) return 'webp'
  if (/gif/i.test(mimeType)) return 'gif'
  if (/portable-pixmap|x-portable-pixmap/i.test(mimeType)) return 'ppm'
  return 'png'
}

function evenDimension(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function parseRate(value: unknown) {
  const [numerator, denominator] = String(value || '0/1').split('/').map(Number)
  return denominator ? numerator / denominator : 0
}

async function run(binary: string, args: string[]) {
  try {
    return await execFileAsync(binary, args, { maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const detail = error as Error & { stderr?: string }
    throw new Error(`REFERENCE_MONTAGE_TOOL_FAILED: ${detail.stderr?.trim() || detail.message}`)
  }
}

export async function probeReferenceMontage(filePath: string): Promise<ReferenceMontageProbe> {
  const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ])
  const payload = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  const streams = payload.streams || []
  const video = streams.find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error('REFERENCE_MONTAGE_INVALID: 缺少视频流')
  return {
    codec: String(video.codec_name || ''),
    pixelFormat: String(video.pix_fmt || ''),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    frameRate: parseRate(video.avg_frame_rate || video.r_frame_rate),
    duration: Number(video.duration || payload.format?.duration || 0),
    audioStreams: streams.filter((stream) => stream.codec_type === 'audio').length,
  }
}

export async function createReferenceMontage(input: {
  images: ReferenceMontageImage[]
  width: number
  height: number
}) {
  if (input.images.length === 0) throw new Error('REFERENCE_MONTAGE_EMPTY: 没有可打包的参考图')
  const width = evenDimension(input.width)
  const height = evenDimension(input.height)
  const directory = await mkdtemp(path.join(tmpdir(), 'imaideo-reference-'))
  const outputPath = path.join(directory, 'reference.mp4')
  try {
    const imagePaths: string[] = []
    for (const [index, image] of input.images.entries()) {
      const imagePath = path.join(directory, `image-${String(index).padStart(3, '0')}.${imageExtension(image.mimeType)}`)
      await writeFile(imagePath, image.bytes)
      imagePaths.push(imagePath)
    }
    const concatLines = imagePaths.flatMap((imagePath) => [
      `file '${imagePath.replace(/\\/g, '/')}'`,
      `duration ${IMAGE_SECONDS}`,
    ])
    concatLines.push(`file '${imagePaths.at(-1)!.replace(/\\/g, '/')}'`)
    const concatPath = path.join(directory, 'images.txt')
    await writeFile(concatPath, `${concatLines.join('\n')}\n`, 'utf8')
    await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-map', '0:v:0',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x15191b,setsar=1,fps=${FRAME_RATE}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-an', '-t', String(input.images.length * IMAGE_SECONDS),
      '-movflags', '+faststart', outputPath,
    ])
    const probe = await probeReferenceMontage(outputPath)
    const expectedDuration = input.images.length * IMAGE_SECONDS
    if (
      probe.codec !== 'h264'
      || probe.pixelFormat !== 'yuv420p'
      || probe.width !== width
      || probe.height !== height
      || Math.abs(probe.frameRate - FRAME_RATE) > 0.01
      || probe.audioStreams !== 0
      || Math.abs(probe.duration - expectedDuration) > 0.2
    ) {
      throw new Error(`REFERENCE_MONTAGE_INVALID: ${JSON.stringify(probe)}`)
    }
    return { bytes: await readFile(outputPath), probe }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

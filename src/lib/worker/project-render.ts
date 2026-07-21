import { TaskStatus } from '@prisma/client'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prisma } from '@/lib/db'
import { buildProjectRenderFilter } from '@/lib/project-renders'
import {
  buildProjectRenderStorageKey,
  downloadBuffer,
  extensionForMime,
  uploadBuffer,
} from '@/lib/storage'

const require = createRequire(import.meta.url)
const ffprobePath = (require('ffprobe-static') as { path?: string }).path

type ProbeResult = {
  duration: number
  hasAudio: boolean
}

function taskPayload(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function runProcess(input: {
  binary: string
  args: string[]
  onStderr?: (chunk: string) => void
}) {
  return new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      input.onStderr?.(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`媒体处理失败 (${code}): ${stderr.slice(-2000)}`))
    })
  })
}

async function probeVideo(filePath: string, fallbackDuration: number): Promise<ProbeResult> {
  if (!ffprobePath) throw new Error('FFPROBE_NOT_AVAILABLE')
  const result = await runProcess({
    binary: ffprobePath,
    args: [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      filePath,
    ],
  })
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string }>
  }
  const duration = Number(parsed.format?.duration)
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : fallbackDuration,
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio')),
  }
}

function renderDimensions(aspectRatio: string) {
  return aspectRatio === '9:16'
    ? { width: 720, height: 1280 }
    : { width: 1280, height: 720 }
}

async function removeTemporaryDirectory(directory: string) {
  const tempRoot = path.resolve(tmpdir())
  const target = path.resolve(directory)
  if (!target.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside temporary directory: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}

export async function processProjectRenderTask(
  taskId: string,
  options: { willRetryOnFailure?: boolean } = {},
) {
  const task = await prisma.generationTask.findUnique({ where: { id: taskId } })
  if (!task) throw new Error(`Project render task not found: ${taskId}`)
  const payload = taskPayload(task.payload)
  if (task.status === TaskStatus.completed) return payload

  const checkpointRenderId = typeof payload.projectRenderId === 'string'
    ? payload.projectRenderId
    : ''
  if (checkpointRenderId) {
    const existing = await prisma.projectRender.findFirst({
      where: { id: checkpointRenderId, projectId: task.projectId },
    })
    if (existing) {
      await prisma.generationTask.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.completed,
          progress: 100,
          completedAt: new Date(),
          error: null,
        },
      })
      return existing
    }
  }

  await prisma.generationTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.processing,
      progress: 2,
      startedAt: new Date(),
      error: null,
    },
  })

  let directory: string | null = null
  try {
    if (!ffmpegPath) throw new Error('FFMPEG_NOT_AVAILABLE')
    const sourceVideoIds = Array.isArray(payload.sourceVideoIds)
      ? payload.sourceVideoIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : []
    const aspectRatio = payload.aspectRatio === '9:16' ? '9:16' : '16:9'
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : '项目成片'
    if (sourceVideoIds.length === 0) throw new Error('PROJECT_RENDER_SOURCE_REQUIRED')

    const records = await prisma.storyboardVideo.findMany({
      where: {
        id: { in: sourceVideoIds },
        storyboard: { projectId: task.projectId },
      },
      include: {
        media: true,
        storyboard: {
          select: { id: true, title: true, sceneNumber: true, selectedVideoId: true },
        },
      },
    })
    const byId = new Map(records.map((record) => [record.id, record]))
    const ordered = sourceVideoIds.map((id) => byId.get(id))
    if (ordered.some((record) => !record)) {
      throw new Error('PROJECT_RENDER_SOURCE_NOT_FOUND')
    }
    const videos = ordered.filter((record): record is (typeof records)[number] => Boolean(record))
    const stale = videos.find((video) => video.storyboard.selectedVideoId !== video.id)
    if (stale) {
      throw new Error(`PROJECT_RENDER_SOURCE_NOT_SELECTED: ${stale.storyboard.title}`)
    }

    directory = await mkdtemp(path.join(tmpdir(), 'shortdrama-render-'))
    const localFiles: string[] = []
    const probes: ProbeResult[] = []
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index]
      const bytes = await downloadBuffer(video.media.storageKey)
      const filePath = path.join(directory, `clip-${String(index + 1).padStart(3, '0')}.${extensionForMime(video.media.mimeType)}`)
      await writeFile(filePath, bytes)
      localFiles.push(filePath)
      probes.push(await probeVideo(filePath, video.duration))
      await prisma.generationTask.update({
        where: { id: taskId },
        data: { progress: 4 + Math.round(((index + 1) / videos.length) * 16) },
      })
    }

    const dimensions = renderDimensions(aspectRatio)
    const totalDuration = probes.reduce((total, clip) => total + clip.duration, 0)
    const outputPath = path.join(directory, 'project-render.mp4')
    const args = [
      '-y',
      ...localFiles.flatMap((filePath) => ['-i', filePath]),
      '-filter_complex', buildProjectRenderFilter({ clips: probes, ...dimensions }),
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      '-nostats',
      outputPath,
    ]
    let progressText = ''
    let lastProgress = 20
    let progressWrite = Promise.resolve()
    await runProcess({
      binary: ffmpegPath,
      args,
      onStderr: (chunk) => {
        progressText = `${progressText}${chunk}`.slice(-4000)
        const matches = [...progressText.matchAll(/out_time_(?:ms|us)=(\d+)/g)]
        const currentMicroseconds = Number(matches.at(-1)?.[1] || 0)
        const nextProgress = Math.min(90, 20 + Math.round((currentMicroseconds / 1_000_000 / totalDuration) * 70))
        if (nextProgress < lastProgress + 3) return
        lastProgress = nextProgress
        progressWrite = progressWrite.then(async () => {
          await prisma.generationTask.update({
            where: { id: taskId },
            data: { progress: nextProgress },
          })
        }).catch(() => undefined)
      },
    })
    await progressWrite

    await prisma.generationTask.update({ where: { id: taskId }, data: { progress: 92 } })
    const output = await readFile(outputPath)
    const mimeType = 'video/mp4'
    const storageKey = buildProjectRenderStorageKey({ projectId: task.projectId, mimeType })
    await uploadBuffer({ key: storageKey, body: output, mimeType })

    const render = await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUniqueOrThrow({
        where: { id: task.projectId },
        select: { selectedRenderId: true },
      })
      const media = await tx.mediaObject.create({
        data: {
          kind: 'video',
          storageKey,
          mimeType,
          sizeBytes: BigInt(output.byteLength),
          width: dimensions.width,
          height: dimensions.height,
        },
      })
      const created = await tx.projectRender.create({
        data: {
          projectId: task.projectId,
          mediaId: media.id,
          title,
          duration: totalDuration,
          aspectRatio,
          clipCount: videos.length,
          sourceVideoIds,
        },
      })
      if (!project.selectedRenderId) {
        await tx.project.update({
          where: { id: task.projectId },
          data: { selectedRenderId: created.id },
        })
      }
      return created
    })

    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.completed,
        progress: 100,
        completedAt: new Date(),
        payload: { ...payload, projectRenderId: render.id },
      },
    })
    return render
  } catch (error) {
    const willRetry = options.willRetryOnFailure === true
    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: willRetry ? TaskStatus.queued : TaskStatus.failed,
        completedAt: willRetry ? null : new Date(),
        error: willRetry ? null : error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  } finally {
    if (directory) await removeTemporaryDirectory(directory)
  }
}

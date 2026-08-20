import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createReferenceMontage } from '@/lib/reference-montage'

const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const ppm = Buffer.concat([
  Buffer.from('P6\n2 2\n255\n', 'ascii'),
  Buffer.from([18, 42, 48, 18, 42, 48, 18, 42, 48, 18, 42, 48]),
])

describe.runIf(ffmpegAvailable)('reference montage encoding', () => {
  it('creates a silent H.264 yuv420p video with exact dimensions, frame rate, and duration', async () => {
    const result = await createReferenceMontage({
      images: [
        { bytes: ppm, mimeType: 'image/x-portable-pixmap' },
        { bytes: ppm, mimeType: 'image/x-portable-pixmap' },
      ],
      width: 640,
      height: 360,
    })
    expect(result.bytes.byteLength).toBeGreaterThan(1024)
    expect(result.probe).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 640,
      height: 360,
      frameRate: 24,
      audioStreams: 0,
    })
    expect(result.probe.duration).toBeCloseTo(2, 1)
  }, 30_000)
})

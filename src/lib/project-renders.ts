import { z } from 'zod'

export const projectRenderAspectRatioSchema = z.enum(['16:9', '9:16'])

export const createProjectRenderSchema = z.object({
  title: z.string().trim().min(1).max(120).default('项目成片'),
  aspectRatio: projectRenderAspectRatioSchema.default('16:9'),
  sourceVideoIds: z.array(z.string().min(1)).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, '镜头不能重复'),
})

export const selectProjectRenderSchema = z.object({
  renderId: z.string().min(1),
})

export function buildProjectRenderFilter(input: {
  clips: Array<{ duration: number, hasAudio: boolean }>
  width: number
  height: number
}) {
  const filters = input.clips.flatMap((clip, index) => {
    const duration = clip.duration.toFixed(3)
    const video = [
      `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease`,
      `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'fps=24',
      'setsar=1',
      'format=yuv420p',
      `trim=duration=${duration}`,
      'setpts=PTS-STARTPTS',
    ].join(',')
    const audio = clip.hasAudio
      ? [
        'aresample=48000:async=1:first_pts=0',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `apad=pad_dur=${duration}`,
        `atrim=duration=${duration}`,
        'asetpts=PTS-STARTPTS',
      ].join(',')
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`
    return [
      `[${index}:v:0]${video}[v${index}]`,
      clip.hasAudio ? `[${index}:a:0]${audio}[a${index}]` : audio,
    ]
  })
  const inputs = input.clips.map((_, index) => `[v${index}][a${index}]`).join('')
  filters.push(`${inputs}concat=n=${input.clips.length}:v=1:a=1[outv][outa]`)
  return filters.join(';')
}

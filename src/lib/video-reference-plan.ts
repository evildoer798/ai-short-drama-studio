// Each overflow image gets its own silent reference video. Keeping this as a
// shared constant prevents the UI, API routes, and worker from drifting apart.
export const REFERENCE_MONTAGE_IMAGES_PER_VIDEO = 1

export type VideoReferencePlan = {
  imageMediaIds: string[]
  videoGroups: string[][]
  rejectedMediaIds: string[]
  totalCapacity: number
}

export function planVideoReferences(
  referenceMediaIds: string[],
  maximumReferenceImages: number,
  maximumReferenceVideos = 0,
): VideoReferencePlan {
  const uniqueMediaIds = [...new Set(referenceMediaIds.filter(Boolean))]
  const imageLimit = Math.max(0, Math.floor(maximumReferenceImages))
  const videoLimit = Math.max(0, Math.floor(maximumReferenceVideos))
  const videoCapacity = videoLimit * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
  const imageMediaIds = uniqueMediaIds.slice(0, imageLimit)
  const overflow = uniqueMediaIds.slice(imageLimit)
  const packed = overflow.slice(0, videoCapacity)
  const videoGroups = Array.from(
    { length: Math.ceil(packed.length / REFERENCE_MONTAGE_IMAGES_PER_VIDEO) },
    (_value, index) => packed.slice(
      index * REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
      (index + 1) * REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
    ),
  )

  return {
    imageMediaIds,
    videoGroups,
    rejectedMediaIds: overflow.slice(videoCapacity),
    totalCapacity: imageLimit + videoCapacity,
  }
}

export function referenceMontagePrompt(prompt: string, maximumCharacters: number) {
  const instruction = '每段参考视频仅包含一张静态资产图且无声音，仅用于人物身份、服装、场景和道具参考，不代表动作或时间顺序。'
  const combined = `${prompt.trim()}\n\n${instruction}`
  if (combined.length > maximumCharacters) {
    throw new Error(`VIDEO_PROMPT_TOO_LONG_WITH_REFERENCE_MONTAGE: 加入参考视频说明后提示词最多 ${maximumCharacters} 字符`)
  }
  return combined
}

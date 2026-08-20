import { AssetType, VisualStyle } from '@prisma/client'
import sharp from 'sharp'

const CHARACTER_SHEET_CUE = /人物设定板|角色设定板|三视图|正面[^\n。]{0,80}侧面[^\n。]{0,80}背面|turnaround|character\s*sheet/iu

export type CharacterReferenceCrop = {
  left: number
  top: number
  width: number
  height: number
  centerX: number
}

export function shouldPrepareSingleCharacterReference(input: {
  model: string
  visualStyle: VisualStyle
  assetType: AssetType
  prompt?: string | null
  description?: string | null
}) {
  if (input.visualStyle !== VisualStyle.anime_3d || input.assetType !== AssetType.character) return false
  if (!/seedance-2\.0/iu.test(input.model)) return false
  return CHARACTER_SHEET_CUE.test(`${input.prompt || ''}\n${input.description || ''}`)
}

export function detectPrimaryFrontFigureCrop(input: {
  data: Uint8Array
  width: number
  height: number
  channels: number
}): CharacterReferenceCrop | null {
  const { data, width, height, channels } = input
  if (width < 320 || height < 320 || channels < 3) return null
  const yStart = Math.floor(height * 0.05)
  const yEnd = Math.floor(height * 0.68)
  const xStart = Math.floor(width * 0.18)
  const xEnd = Math.floor(width * 0.55)
  const radius = Math.max(2, Math.floor(width * 0.02))
  const scores = new Float64Array(width)
  const smoothed = new Float64Array(width)

  for (let x = xStart; x < xEnd; x += 1) {
    let score = 0
    for (let y = yStart; y < yEnd; y += 2) {
      const index = (y * width + x) * channels
      const red = data[index]
      const green = data[index + 1]
      const blue = data[index + 2]
      const minimum = Math.min(red, green, blue)
      const maximum = Math.max(red, green, blue)
      const average = (red + green + blue) / 3
      if (minimum < 235 && (maximum - minimum > 8 || average < 210)) score += 1
    }
    scores[x] = score
  }

  let maximumScore = 0
  for (let x = xStart + radius; x < xEnd - radius; x += 1) {
    let score = 0
    for (let sampleX = x - radius; sampleX <= x + radius; sampleX += 1) {
      score += scores[sampleX]
    }
    smoothed[x] = score
    maximumScore = Math.max(maximumScore, score)
  }
  if (maximumScore <= 0) return null

  const threshold = maximumScore * 0.75
  let centerX = -1
  for (let x = xStart + radius + 1; x < xEnd - radius - 1; x += 1) {
    if (smoothed[x] >= threshold && smoothed[x] >= smoothed[x - 1] && smoothed[x] >= smoothed[x + 1]) {
      centerX = x
      break
    }
  }
  if (centerX < 0) centerX = Math.floor(width * 0.3)

  const cropWidth = Math.round(width * (width / height < 1.2 ? 0.20 : 0.15))
  const cropHeight = Math.min(height, Math.round(height * 0.66))
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(centerX - cropWidth / 2)))
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(height * 0.04)))
  return { left, top, width: cropWidth, height: cropHeight, centerX }
}

export async function prepareSingleCharacterReference(input: {
  sourceUrl: string
  fetchImpl?: typeof fetch
}) {
  const response = await (input.fetchImpl || fetch)(input.sourceUrl)
  if (!response.ok) throw new Error(`VIDEO_CHARACTER_REFERENCE_DOWNLOAD_FAILED: ${response.status}`)
  const source = Buffer.from(await response.arrayBuffer())
  const image = sharp(source, { failOn: 'none' })
  const { data, info } = await image.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const crop = detectPrimaryFrontFigureCrop({
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  })
  if (!crop) return { url: input.sourceUrl, transformed: false, crop: null }
  const output = await image
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(512, 768, { fit: 'contain', background: '#ffffff' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer()
  return {
    url: `data:image/jpeg;base64,${output.toString('base64')}`,
    transformed: true,
    crop,
  }
}

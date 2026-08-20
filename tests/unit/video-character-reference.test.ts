import { AssetType, VisualStyle } from '@prisma/client'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  detectPrimaryFrontFigureCrop,
  prepareSingleCharacterReference,
  shouldPrepareSingleCharacterReference,
} from '@/lib/video-character-reference'

describe('single-person video character references', () => {
  it('only preprocesses Seedance character sheets in the semi-realistic 3D style', () => {
    const common = {
      model: 'seedance-2.0',
      visualStyle: VisualStyle.anime_3d,
      assetType: AssetType.character,
    }

    expect(shouldPrepareSingleCharacterReference({
      ...common,
      prompt: '白色背景人物设定板，正面、侧面、背面三视图。',
    })).toBe(true)
    expect(shouldPrepareSingleCharacterReference({
      ...common,
      prompt: '单人正面肖像。',
    })).toBe(false)
    expect(shouldPrepareSingleCharacterReference({
      ...common,
      model: 'happyhouse-1.1',
      prompt: '人物设定板。',
    })).toBe(false)
  })

  it('selects the first strong full-body figure instead of later turnaround views', () => {
    const width = 1000
    const height = 1000
    const channels = 3
    const data = new Uint8Array(width * height * channels).fill(255)
    for (const [left, right] of [[250, 360], [500, 590]]) {
      for (let y = 80; y < 700; y += 1) {
        for (let x = left; x < right; x += 1) {
          const index = (y * width + x) * channels
          data[index] = 55
          data[index + 1] = 65
          data[index + 2] = 75
        }
      }
    }

    const crop = detectPrimaryFrontFigureCrop({ data, width, height, channels })

    expect(crop).not.toBeNull()
    expect((crop?.centerX || 0) / width).toBeGreaterThan(0.2)
    expect((crop?.centerX || 0) / width).toBeLessThan(0.4)
  })

  it('returns a compact portrait data URI containing one detected front figure', async () => {
    const source = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: '#ffffff' },
    }).composite([
      { input: { create: { width: 110, height: 620, channels: 3, background: '#39424c' } }, left: 250, top: 80 },
      { input: { create: { width: 90, height: 620, channels: 3, background: '#59636d' } }, left: 500, top: 80 },
    ]).png().toBuffer()
    const prepared = await prepareSingleCharacterReference({
      sourceUrl: 'https://example.test/character-sheet.png',
      fetchImpl: async () => new Response(new Uint8Array(source), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    })

    expect(prepared.transformed).toBe(true)
    expect(prepared.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    const output = Buffer.from(prepared.url.split(',')[1], 'base64')
    const metadata = await sharp(output).metadata()
    expect(metadata.width).toBe(512)
    expect(metadata.height).toBe(768)
  })
})

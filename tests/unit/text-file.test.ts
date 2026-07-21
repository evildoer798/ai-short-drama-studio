import { describe, expect, it } from 'vitest'
import { decodeTextFile, titleFromTextFile } from '../../src/lib/text-file'

describe('TXT import', () => {
  it('decodes UTF-8 and normalizes line endings', () => {
    const bytes = new TextEncoder().encode('\uFEFF第一行\r\n第二行')
    expect(decodeTextFile(bytes.buffer)).toBe('第一行\n第二行')
  })

  it('decodes UTF-16LE with a byte-order mark', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])
    expect(decodeTextFile(bytes.buffer)).toBe('中文')
  })

  it('derives a clean title from the file name', () => {
    expect(titleFromTextFile('我的短剧.txt')).toBe('我的短剧')
  })
})

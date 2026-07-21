const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16_LE_BOM = [0xff, 0xfe]
const UTF16_BE_BOM = [0xfe, 0xff]

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

export function decodeTextFile(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let text: string

  if (startsWith(bytes, UTF8_BOM)) {
    text = new TextDecoder('utf-8').decode(bytes.subarray(UTF8_BOM.length))
  } else if (startsWith(bytes, UTF16_LE_BOM)) {
    text = new TextDecoder('utf-16le').decode(bytes.subarray(UTF16_LE_BOM.length))
  } else if (startsWith(bytes, UTF16_BE_BOM)) {
    text = new TextDecoder('utf-16be').decode(bytes.subarray(UTF16_BE_BOM.length))
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('gb18030').decode(bytes)
    }
  }

  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

export function titleFromTextFile(fileName: string) {
  return fileName.replace(/\.txt$/i, '').trim() || '未命名剧本'
}

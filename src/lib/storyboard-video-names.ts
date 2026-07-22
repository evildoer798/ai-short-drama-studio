import { z } from 'zod'

const forbiddenFilenameCharacters = /[\\/:*?"<>|\u0000-\u001f\u007f]/u
const forbiddenFilenameCharactersGlobal = /[\\/:*?"<>|\u0000-\u001f\u007f]/gu

export const renameStoryboardVideoSchema = z.object({
  name: z.string()
    .trim()
    .min(1, '请输入视频名称')
    .max(120, '视频名称最多 120 个字符')
    .refine((value) => !forbiddenFilenameCharacters.test(value), '视频名称不能包含 \\ / : * ? " < > | 或控制字符'),
})

function compactFilenamePart(value: string) {
  return value
    .replace(forbiddenFilenameCharactersGlobal, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
}

function timestampPart(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('')
}

export function buildStoryboardVideoDisplayName(input: {
  customName?: string | null
  episodeNumber?: number | null
  storyboardNumber: number
  storyboardTitle?: string | null
  sourceCount?: number
  createdAt: Date | string
}) {
  const customName = compactFilenamePart(input.customName || '')
  if (customName) return customName.slice(0, 120)

  const episode = input.episodeNumber
    ? `第${String(input.episodeNumber).padStart(2, '0')}集`
    : '未分集'
  const storyboard = `分镜${String(input.storyboardNumber).padStart(2, '0')}`
  const source = (input.sourceCount || 1) > 1 ? `组合${input.sourceCount}镜` : ''
  const stamp = timestampPart(input.createdAt)
  const title = compactFilenamePart(input.storyboardTitle || '').slice(0, 36)

  return [episode, storyboard, source, title, stamp]
    .filter(Boolean)
    .join('-')
    .slice(0, 120)
}

export function buildStoryboardVideoDownloadFilename(input: {
  displayName: string
  extension?: string
}) {
  const extension = compactFilenamePart(input.extension || 'mp4').replace(/^\.+/, '') || 'mp4'
  const displayName = compactFilenamePart(input.displayName) || '分镜视频'
  const withoutDuplicateExtension = displayName.replace(new RegExp(`\\.${extension}$`, 'iu'), '')
  return `${withoutDuplicateExtension.slice(0, 120)}.${extension}`
}

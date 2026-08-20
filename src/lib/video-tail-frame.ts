export function proxiedMediaSource(source: string, baseUrl: string) {
  try {
    const base = new URL(baseUrl)
    const url = new URL(source, base)
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/media/')) return source
    url.searchParams.set('proxy', '1')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return source
  }
}

export async function captureVideoTailFrame(source: string) {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  // Canvas capture needs a same-origin response. Normal playback is redirected
  // straight to OSS so it cannot exhaust the web process socket pool.
  video.src = proxiedMediaSource(source, window.location.href)
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('无法读取上一镜视频'))
  })
  if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('上一镜还没有可截取的画面')
  }
  video.currentTime = Math.max(0, video.duration - 0.08)
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve()
    video.onerror = () => reject(new Error('无法定位上一镜尾帧'))
  })
  const frame = document.createElement('canvas')
  frame.width = video.videoWidth
  frame.height = video.videoHeight
  const context = frame.getContext('2d')
  if (!context) throw new Error('浏览器无法截取视频画面')
  context.drawImage(video, 0, 0, frame.width, frame.height)
  const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, 'image/png'))
  video.removeAttribute('src')
  video.load()
  if (!blob) throw new Error('尾帧截图失败')
  return { blob, width: frame.width, height: frame.height }
}

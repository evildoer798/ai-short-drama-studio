import { createHmac } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const baseUrl = process.env.VERIFY_BASE_URL || 'http://web:14000'
const email = (process.env.VERIFY_USER_EMAIL || '2992656728@qq.com').toLowerCase()

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const authSecret = required('AUTH_SECRET')

function sessionToken(userId: string) {
  const body = Buffer.from(JSON.stringify({
    userId,
    exp: Date.now() + 10 * 60 * 1000,
  })).toString('base64url')
  const signature = createHmac('sha256', authSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}

async function fetchRange(mediaId: string, cookie: string, download = false) {
  const response = await fetch(
    `${baseUrl}/api/media/${encodeURIComponent(mediaId)}${download ? '?download=1' : ''}`,
    {
      headers: {
        Cookie: cookie,
        Range: 'bytes=0-1023',
      },
      redirect: 'manual',
    },
  )
  const body = Buffer.from(await response.arrayBuffer())
  if (response.status !== 206 || body.byteLength !== 1024) {
    throw new Error(`Media range failed: status=${response.status} bytes=${body.byteLength}`)
  }
  return {
    status: response.status,
    bytes: body.byteLength,
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
    contentDisposition: response.headers.get('content-disposition'),
  }
}

try {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) throw new Error(`Verification user not found: ${email}`)
  if (user.mustChangePassword) throw new Error(`Verification user must change password: ${email}`)

  const project = await prisma.project.findUnique({
    where: { id: 'cmrbi8gzq0007p2qgtrroj915' },
  })
  if (!project) throw new Error('Migrated project not found')

  const [assetImage, storyboardVideo, render] = await Promise.all([
    prisma.assetImage.findFirst({
      where: { asset: { projectId: project.id } },
      include: { media: true },
    }),
    prisma.storyboardVideo.findFirst({
      where: { storyboard: { projectId: project.id } },
      include: { media: true },
    }),
    prisma.projectRender.findFirst({
      where: { projectId: project.id },
      include: { media: true },
    }),
  ])
  if (!assetImage || !storyboardVideo || !render) {
    throw new Error('Verification media is incomplete')
  }

  const cookie = `shortdrama_session=${sessionToken(user.id)}`
  const projectsResponse = await fetch(`${baseUrl}/api/projects`, {
    headers: { Cookie: cookie },
  })
  const projectsBody = await projectsResponse.text()
  if (!projectsResponse.ok || !projectsBody.includes(project.id)) {
    throw new Error(`Project API verification failed: ${projectsResponse.status}`)
  }

  const image = await fetchRange(assetImage.mediaId, cookie)
  const video = await fetchRange(storyboardVideo.mediaId, cookie)
  const renderPreview = await fetchRange(render.mediaId, cookie)
  const renderDownload = await fetchRange(render.mediaId, cookie, true)
  if (!renderDownload.contentDisposition?.startsWith('attachment;')) {
    throw new Error('Render download is missing attachment Content-Disposition')
  }

  console.log(JSON.stringify({
    ok: true,
    projectApiStatus: projectsResponse.status,
    image,
    video,
    renderPreview,
    renderDownload,
  }, null, 2))
} finally {
  await prisma.$disconnect()
}

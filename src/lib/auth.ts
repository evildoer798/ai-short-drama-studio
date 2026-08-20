import 'server-only'

import { cookies } from 'next/headers'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { compare, hash } from 'bcryptjs'
import { AccountRole } from '@prisma/client'
import { prisma } from './db'
import { env } from './env'
import { HttpError } from './http'
import { normalizeLoginIdentifier } from './auth-validation'

const COOKIE_NAME = 'shortdrama_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14

type SessionPayload = {
  userId: string
  exp: number
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function sign(value: string) {
  return createHmac('sha256', env.authSecret()).update(value).digest('base64url')
}

function encodeSession(payload: SessionPayload) {
  const body = base64url(JSON.stringify(payload))
  return `${body}.${sign(body)}`
}

function decodeSession(token: string): SessionPayload | null {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null

  const expected = sign(body)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (!payload.userId || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export async function createSessionCookie(userId: string) {
  const cookieStore = await cookies()
  cookieStore.set({
    name: COOKIE_NAME,
    value: encodeSession({
      userId,
      exp: Date.now() + MAX_AGE_SECONDS * 1000,
    }),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearSessionCookie() {
  const cookieStore = await cookies()
  cookieStore.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}

export async function getCurrentUser() {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (!token) return null
  const payload = decodeSession(token)
  if (!payload) return null

  return prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      username: true,
      name: true,
      mustChangePassword: true,
      role: true,
    },
  })
}

export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in')
  if (user.mustChangePassword) {
    throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录需要先修改密码')
  }
  return user
}

export async function requireAdmin() {
  const user = await requireUser()
  if (user.role !== AccountRole.admin) {
    throw new HttpError(403, 'ADMIN_REQUIRED', '仅管理员可以访问费用后台')
  }
  return user
}

export async function verifyPasswordLogin(identifier: string, password: string) {
  const normalized = normalizeLoginIdentifier(identifier)
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { username: normalized },
        { email: normalized },
      ],
    },
  })
  if (!user) return null
  const ok = await compare(password, user.passwordHash)
  if (!ok) return null
  return user
}

export async function changeUserPassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  })
  if (!user || !await compare(currentPassword, user.passwordHash)) return false

  const passwordHash = await hash(newPassword, 12)
  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      passwordHash: user.passwordHash,
    },
    data: {
      passwordHash,
      mustChangePassword: false,
    },
  })

  if (result.count !== 1) {
    throw new HttpError(409, 'PASSWORD_CHANGED', '密码已在其他位置修改，请重新登录')
  }
  return true
}

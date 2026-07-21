import { NextRequest, NextResponse } from 'next/server'
import { changeUserPassword, getCurrentUser } from '@/lib/auth'
import { changePasswordSchema } from '@/lib/auth-validation'
import { HttpError, routeHandler } from '@/lib/http'

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const user = await getCurrentUser()
    if (!user) {
      throw new HttpError(401, 'UNAUTHENTICATED', '登录已过期，请重新登录')
    }

    const body = changePasswordSchema.parse(await request.json())
    const changed = await changeUserPassword(user.id, body.currentPassword, body.newPassword)
    if (!changed) {
      throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', '初始密码不正确')
    }

    return NextResponse.json({ ok: true })
  })
}

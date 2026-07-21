import { NextRequest, NextResponse } from 'next/server'
import { createSessionCookie, verifyPasswordLogin } from '@/lib/auth'
import { loginSchema } from '@/lib/auth-validation'
import { HttpError, routeHandler } from '@/lib/http'

export async function POST(request: NextRequest) {
  return routeHandler(async () => {
    const body = loginSchema.parse(await request.json())
    const user = await verifyPasswordLogin(body.identifier, body.password)
    if (!user) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', '用户名、邮箱或密码不正确')
    }

    await createSessionCookie(user.id)
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        mustChangePassword: user.mustChangePassword,
      },
    })
  })
}

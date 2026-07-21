import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/auth'
import { routeHandler } from '@/lib/http'

export async function POST() {
  return routeHandler(async () => {
    await clearSessionCookie()
    return NextResponse.json({ ok: true })
  })
}

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'

export async function GET() {
  return routeHandler(async () => {
    const user = await getCurrentUser()
    return NextResponse.json({ user })
  })
}

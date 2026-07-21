import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { getVideoModelOptions } from '@/lib/video-models'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    await requireUser()
    const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1'
    return NextResponse.json(await getVideoModelOptions({ forceRefresh }), {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  })
}

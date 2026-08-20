import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { env } from '@/lib/env'
import { discoverImageApiModels, isImageModelId } from '@/lib/image-api-pool'
import { routeHandler } from '@/lib/http'

export async function GET(request: NextRequest) {
  return routeHandler(async () => {
    await requireUser()
    const fallback = env.imageModel()
    let modelIds: string[] = []
    try {
      const snapshot = await discoverImageApiModels({
        baseUrl: env.openAICompatBaseUrl(),
        forceRefresh: request.nextUrl.searchParams.get('refresh') === '1',
      })
      modelIds = snapshot.modelIds.filter(isImageModelId)
    } catch {
      modelIds = []
    }
    if (fallback && !modelIds.includes(fallback)) modelIds.unshift(fallback)
    return NextResponse.json({
      models: [...new Set(modelIds)].map((id) => ({ id, label: id })),
    }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  })
}

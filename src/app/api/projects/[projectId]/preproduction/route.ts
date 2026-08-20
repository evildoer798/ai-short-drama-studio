import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { routeHandler } from '@/lib/http'
import { requireProjectAccess } from '@/lib/permissions'
import { getPreproductionData } from '@/lib/preproduction'

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { projectId } = await context.params
    await requireProjectAccess(projectId, user.id)
    return NextResponse.json(await getPreproductionData(projectId), {
      headers: {
        'Cache-Control': 'private, max-age=15, stale-while-revalidate=60',
      },
    })
  })
}

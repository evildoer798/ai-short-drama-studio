import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError, routeHandler } from '@/lib/http'
import { requireDirectorProductionAccess } from '@/lib/permissions'

export async function POST(_request: Request, context: { params: Promise<{ productionId: string }> }) {
  return routeHandler(async () => {
    const user = await requireUser()
    const { productionId } = await context.params
    const production = await requireDirectorProductionAccess(productionId, user.id)
    if (production.currentStage !== 'review' && production.currentStage !== 'completed') {
      throw new HttpError(409, 'DIRECTOR_REVIEW_LOCKED', '请先确认 CINEDANCE 阶段')
    }
    const [shotCount, selectedCount] = await Promise.all([
      prisma.directorShot.count({ where: { productionId } }),
      prisma.directorShot.count({ where: { productionId, selectedVideoVersionId: { not: null } } }),
    ])
    if (!shotCount || selectedCount !== shotCount) {
      throw new HttpError(409, 'DIRECTOR_REVIEW_INCOMPLETE', `还有 ${shotCount - selectedCount} 个镜头没有选定成片`)
    }
    await prisma.directorProduction.update({
      where: { id: productionId }, data: { currentStage: 'completed', status: 'completed' },
    })
    return NextResponse.json({ currentStage: 'completed', status: 'completed' })
  })
}

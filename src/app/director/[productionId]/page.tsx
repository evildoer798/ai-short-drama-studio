import { notFound, redirect } from 'next/navigation'
import { DirectorWorkspace } from '@/components/director/DirectorWorkspace'
import { getCurrentUser } from '@/lib/auth'
import { getDirectorProductionData } from '@/lib/director-data'
import { prisma } from '@/lib/db'

export default async function DirectorProductionPage({ params }: { params: Promise<{ productionId: string }> }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  const { productionId } = await params
  const canAccess = await prisma.directorProduction.count({
    where: { id: productionId, project: { members: { some: { userId: user.id } } } },
  })
  if (!canAccess) notFound()
  const production = await getDirectorProductionData(productionId)
  return <DirectorWorkspace user={{ name: user.name, email: user.email }} initialProduction={production} />
}

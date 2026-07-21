import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getWorkspaceData } from '@/lib/workspace-data'
import { AssetWorkspace } from '@/components/AssetWorkspace'

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')

  const { projectId } = await params
  const data = await getWorkspaceData(user.id, { projectId })
  if (data.activeProjectId !== projectId) notFound()

  return <AssetWorkspace user={user} initialData={data} />
}

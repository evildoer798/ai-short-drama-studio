import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { getProjectHubData } from '@/lib/project-hub-data'
import { ProjectHub } from '@/components/ProjectHub'

export default async function Home() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')

  const data = await getProjectHubData(user.id)

  return (
    <ProjectHub
      user={user}
      initialData={data}
    />
  )
}

import { redirect } from 'next/navigation'
import { DirectorHome } from '@/components/director/DirectorHome'
import { getCurrentUser } from '@/lib/auth'
import { getDirectorHomeData } from '@/lib/director-data'

export default async function DirectorPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  const data = await getDirectorHomeData(user.id)
  return <DirectorHome user={{ name: user.name, email: user.email }} initialData={data} />
}

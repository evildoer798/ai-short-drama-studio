import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { ChangePasswordForm } from '@/components/ChangePasswordForm'

export default async function ChangePasswordPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!user.mustChangePassword) redirect('/')

  return <ChangePasswordForm accountName={user.username || user.email} />
}

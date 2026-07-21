import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { LoginForm } from '@/components/LoginForm'

export default async function LoginPage() {
  const user = await getCurrentUser()
  if (user?.mustChangePassword) redirect('/change-password')
  if (user) redirect('/')

  return <LoginForm />
}

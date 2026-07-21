'use client'

import { FormEvent, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'

export function ChangePasswordForm({ accountName }: { accountName: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')

    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }

    setLoading(true)
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    setLoading(false)

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      setError(payload?.error?.message || '修改密码失败')
      return
    }

    window.location.href = '/'
  }

  return (
    <main className="loginShell">
      <section className="loginPanel">
        <div className="brandMark">
          <KeyRound size={26} />
        </div>
        <div>
          <h1>设置你的新密码</h1>
          <p className="loginIntro">账号 {accountName} 首次登录，需要先修改初始密码。</p>
        </div>
        <form className="loginForm" onSubmit={submit}>
          <label>
            初始密码
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            新密码
            <input
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
            />
          </label>
          <label>
            再次输入新密码
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
            />
          </label>
          <p className="passwordRules">至少 10 位，并且不能与初始密码相同。</p>
          {error ? <p className="errorText">{error}</p> : null}
          <button className="primaryButton" disabled={loading} type="submit">
            {loading ? <Loader2 className="spin" size={18} /> : <KeyRound size={18} />}
            {loading ? '正在保存' : '保存并进入工作台'}
          </button>
        </form>
      </section>
    </main>
  )
}

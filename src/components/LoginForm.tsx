'use client'

import { FormEvent, useState } from 'react'
import { Film, LogIn } from 'lucide-react'

export function LoginForm() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    })

    setLoading(false)
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      setError(payload?.error?.message || '登录失败')
      return
    }

    const payload = await response.json()
    window.location.href = payload.user?.mustChangePassword ? '/change-password' : '/'
  }

  return (
    <main className="loginShell">
      <section className="loginPanel">
        <div className="brandMark">
          <Film size={28} />
        </div>
        <div>
          <h1>AI 短剧工作台</h1>
          <p className="loginIntro">使用团队账号进入项目</p>
        </div>
        <form className="loginForm" onSubmit={submit}>
          <label>
            用户名或邮箱
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              type="text"
              autoComplete="username"
              placeholder="请输入用户名"
              required
            />
          </label>
          <label>
            密码
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="请输入密码"
              required
            />
          </label>
          {error ? <p className="errorText">{error}</p> : null}
          <button className="primaryButton" disabled={loading} type="submit">
            <LogIn size={18} />
            {loading ? '正在登录' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

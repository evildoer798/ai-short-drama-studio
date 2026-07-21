import { describe, expect, it } from 'vitest'
import {
  changePasswordSchema,
  loginSchema,
  normalizeLoginIdentifier,
} from '@/lib/auth-validation'

describe('authentication validation', () => {
  it('accepts a username or email login identifier', () => {
    expect(loginSchema.parse({ identifier: 'jennifer', password: 'secret' }).identifier).toBe('jennifer')
    expect(loginSchema.parse({ identifier: 'member@example.com', password: 'secret' }).identifier).toBe('member@example.com')
  })

  it('keeps compatibility with the previous email-only login request', () => {
    expect(loginSchema.parse({ email: 'admin@example.com', password: 'secret' }).identifier).toBe('admin@example.com')
  })

  it('normalizes identifiers for case-insensitive login', () => {
    expect(normalizeLoginIdentifier('  Jennifer  ')).toBe('jennifer')
  })

  it('requires a new password with at least ten characters', () => {
    expect(() => changePasswordSchema.parse({
      currentPassword: 'Initial-Password',
      newPassword: 'short',
    })).toThrow('新密码至少需要 10 位')
  })

  it('rejects reusing the initial password', () => {
    expect(() => changePasswordSchema.parse({
      currentPassword: 'Initial-Password',
      newPassword: 'Initial-Password',
    })).toThrow('新密码不能与初始密码相同')
  })
})

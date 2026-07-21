import { z } from 'zod'

export const loginSchema = z.object({
  identifier: z.string().trim().max(254).optional(),
  email: z.string().trim().max(254).optional(),
  password: z.string().min(1, '请输入密码').max(128),
}).transform((input, context) => {
  const identifier = input.identifier || input.email
  if (!identifier) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '请输入用户名或邮箱',
      path: ['identifier'],
    })
    return z.NEVER
  }
  return { identifier, password: input.password }
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入初始密码').max(128),
  newPassword: z.string()
    .min(10, '新密码至少需要 10 位')
    .max(128, '新密码不能超过 128 位'),
}).refine(
  ({ currentPassword, newPassword }) => currentPassword !== newPassword,
  { message: '新密码不能与初始密码相同', path: ['newPassword'] },
)

export function normalizeLoginIdentifier(identifier: string) {
  return identifier.trim().toLowerCase()
}

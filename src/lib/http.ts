import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

export class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message?: string) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    )
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: error.issues[0]?.message || 'Invalid request' } },
      { status: 400 },
    )
  }

  const message = error instanceof Error ? error.message : 'Unexpected error'
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message } },
    { status: 500 },
  )
}

export async function routeHandler<T>(fn: () => Promise<T | Response>) {
  try {
    return await fn()
  } catch (error) {
    return jsonError(error)
  }
}

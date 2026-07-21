import { TaskStatus } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  canAutoRecoverTextTask,
  isRecoverableTextTaskFailure,
  shouldMarkTextTaskInterrupted,
  TEXT_TASK_AUTO_RECOVERY_LIMIT,
  TEXT_TASK_STALE_AFTER_MS,
} from '@/lib/text-task-recovery'

describe('text task recovery', () => {
  const now = Date.UTC(2026, 6, 19, 12, 0, 0)

  it('marks an old processing task when its queue job has failed', () => {
    expect(shouldMarkTextTaskInterrupted({
      status: TaskStatus.processing,
      updatedAt: new Date(now - TEXT_TASK_STALE_AFTER_MS - 1),
      queueState: 'failed',
      now,
    })).toBe(true)
  })

  it('does not interrupt a live queue job or a recently updated task', () => {
    expect(shouldMarkTextTaskInterrupted({
      status: TaskStatus.processing,
      updatedAt: new Date(now - TEXT_TASK_STALE_AFTER_MS - 1),
      queueState: 'active',
      now,
    })).toBe(false)
    expect(shouldMarkTextTaskInterrupted({
      status: TaskStatus.processing,
      updatedAt: new Date(now - 10_000),
      queueState: 'failed',
      now,
    })).toBe(false)
  })

  it('automatically resumes transient failures but not invalid input or exhausted retries', () => {
    expect(isRecoverableTextTaskFailure('TEXT_API_FAILED: 504 upstream timeout')).toBe(true)
    expect(isRecoverableTextTaskFailure('SCENE_CONSISTENCY_MISMATCH: 缺少旧屋客厅')).toBe(true)
    expect(isRecoverableTextTaskFailure('TEXT_API_FAILED: 401 invalid key')).toBe(false)
    expect(isRecoverableTextTaskFailure('SCENE_CONSISTENCY_MISSING: 没有标准场景名')).toBe(false)

    expect(canAutoRecoverTextTask({
      status: TaskStatus.failed,
      error: 'TEXT_WORKER_INTERRUPTED',
      payload: { textAutoRecovery: { attempts: TEXT_TASK_AUTO_RECOVERY_LIMIT - 1 } },
    })).toBe(true)
    expect(canAutoRecoverTextTask({
      status: TaskStatus.failed,
      error: 'TEXT_WORKER_INTERRUPTED',
      payload: { textAutoRecovery: { attempts: TEXT_TASK_AUTO_RECOVERY_LIMIT } },
    })).toBe(false)
  })
})

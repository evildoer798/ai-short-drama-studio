import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { recordCompletedTextUsage, type BillableTextUsage } from './billing'

type TextBillingContext = {
  taskId: string
  userId: string
}

const textBillingStorage = new AsyncLocalStorage<TextBillingContext>()

export function runWithTextBillingContext<T>(
  context: TextBillingContext,
  operation: () => Promise<T>,
) {
  return textBillingStorage.run(context, operation)
}

export async function recordTextUsageFromContext(input: {
  baseUrl: string
  model: string
  usage: BillableTextUsage
}) {
  const context = textBillingStorage.getStore()
  if (!context) return null
  let hostname = ''
  try {
    hostname = new URL(input.baseUrl).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
  if (hostname !== 'ai.cangyuansuanli.cn' && !hostname.endsWith('.cangyuansuanli.cn')) return null
  return recordCompletedTextUsage({
    idempotencyKey: `generation-task:${context.taskId}:text:${randomUUID()}`,
    userId: context.userId,
    sourceTaskId: context.taskId,
    model: input.model,
    usage: input.usage,
  })
}

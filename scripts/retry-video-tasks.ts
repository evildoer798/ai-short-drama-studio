import { prisma } from '../src/lib/db'
import { processVideoGenerationTask } from '../src/lib/worker/video-generation'

const RETRY_DELAY_MS = 30_000
const MAX_ATTEMPTS = 3

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function runTask(taskId: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`[video-retry] ${taskId} attempt ${attempt}/${MAX_ATTEMPTS}`)
    try {
      await processVideoGenerationTask(taskId, {
        willRetryOnFailure: attempt < MAX_ATTEMPTS,
      })
      console.log(`[video-retry] ${taskId} completed`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[video-retry] ${taskId} failed: ${message}`)
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }
  return false
}

async function main() {
  const taskIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean)
  if (taskIds.length === 0) throw new Error('Pass at least one GenerationTask id')

  let failed = false
  for (const taskId of taskIds) {
    if (!await runTask(taskId)) failed = true
  }
  if (failed) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

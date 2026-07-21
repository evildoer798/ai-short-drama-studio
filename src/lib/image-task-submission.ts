import { GenerationTaskType, TaskStatus, type Asset, type VisualStyle } from '@prisma/client'
import { prisma } from './db'
import { env } from './env'
import { enqueueImageGenerationTask } from './queue'
import { buildStyledAssetPrompt } from './visual-styles'

export async function submitAssetImageTask(input: {
  asset: Pick<Asset, 'id' | 'projectId' | 'type' | 'name' | 'description' | 'prompt'>
  createdById: string
  visualStyle: VisualStyle
  customStylePrompt?: string | null
  promptOverride?: string | null
  count?: number
}) {
  const activeTask = await prisma.generationTask.findFirst({
    where: {
      assetId: input.asset.id,
      type: GenerationTaskType.image_generation,
      status: { in: [TaskStatus.queued, TaskStatus.processing] },
      updatedAt: { gte: new Date(Date.now() - 30 * 60_000) },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (activeTask) return { task: activeTask, reused: true }

  const prompt = buildStyledAssetPrompt({
    asset: input.asset,
    visualStyle: input.visualStyle,
    customStylePrompt: input.customStylePrompt,
    promptOverride: input.promptOverride,
  })
  const task = await prisma.generationTask.create({
    data: {
      type: GenerationTaskType.image_generation,
      status: TaskStatus.queued,
      projectId: input.asset.projectId,
      assetId: input.asset.id,
      createdById: input.createdById,
      model: env.imageModel(),
      prompt,
      requestedCount: Math.max(1, Math.min(4, input.count || 1)),
    },
  })

  try {
    await enqueueImageGenerationTask(task.id)
    return { task, reused: false }
  } catch (error) {
    await prisma.generationTask.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.failed,
        completedAt: new Date(),
        error: '后台生图队列暂时不可用，请稍后重试。',
      },
    })
    throw error
  }
}

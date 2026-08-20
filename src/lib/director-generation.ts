import { DirectorStage, DirectorStageStatus, Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { prisma } from './db'
import { env } from './env'
import { extractJsonValue, generateTextWithFallback, type GenerateTextInput } from './openai-text'
import {
  buildDirectorStagePrompt,
  buildDirectorStageRepairPrompt,
  DIRECTOR_SKILL_VERSIONS,
} from './director-prompts'
import {
  directorStageSchema,
  parseDirectorStageOutput,
  readableDirectorStageError,
  type DirectorEditableStage,
} from './director-system'
import { syncDirectorCharacterStateAssets } from './director-state-assets'

function asInputJson(value: unknown) {
  return value as Prisma.InputJsonValue
}

export async function processDirectorStageVersion(stageVersionId: string) {
  const version = await prisma.directorStageVersion.findUnique({
    where: { id: stageVersionId },
    include: {
      production: {
        include: {
          project: { select: { name: true, visualStyle: true, customStylePrompt: true } },
          sourceEpisode: { select: { title: true, content: true } },
        },
      },
    },
  })
  if (!version) throw new Error(`DIRECTOR_STAGE_VERSION_NOT_FOUND: ${stageVersionId}`)
  const stage = directorStageSchema.parse(version.stage) as DirectorEditableStage
  if (version.status === DirectorStageStatus.ready || version.status === DirectorStageStatus.confirmed) {
    return version.output
  }

  await prisma.directorStageVersion.update({
    where: { id: version.id },
    data: { status: DirectorStageStatus.generating, error: null },
  })

  try {
    const previousRows = await prisma.directorStageVersion.findMany({
      where: {
        productionId: version.productionId,
        stage: { in: [DirectorStage.acting, DirectorStage.lira] },
        status: DirectorStageStatus.confirmed,
      },
      orderBy: [{ stage: 'asc' }, { version: 'desc' }],
    })
    const previousOutputs: Partial<Record<DirectorEditableStage, unknown>> = {}
    for (const row of previousRows) {
      if ((row.stage === DirectorStage.acting || row.stage === DirectorStage.lira) && !previousOutputs[row.stage]) {
        previousOutputs[row.stage] = row.output
      }
    }
    const generatedPrompt = buildDirectorStagePrompt(stage, {
      productionName: version.production.name,
      project: {
        ...version.production.project,
        visualStyle: version.production.project.visualStyle.toString(),
      },
      episode: version.production.sourceEpisode,
      sourceSnapshot: version.production.sourceSnapshot,
      previousOutputs,
      feedback: version.feedback || '',
    })
    await prisma.directorStageVersion.update({
      where: { id: version.id },
      data: { promptSnapshot: `${generatedPrompt.system}\n\n---\n\n${generatedPrompt.prompt}` },
    })
    const primaryKey = env.textApiKeys()[0]
    const fallbackBaseUrl = env.textFallbackApiBaseUrl()
    const fallbackKey = env.textFallbackApiKey()
    const primaryInput: GenerateTextInput = {
      baseUrl: env.textApiBaseUrl(),
      apiKey: primaryKey,
      model: env.textModel(),
      mode: env.textApiMode(),
      system: generatedPrompt.system,
      prompt: generatedPrompt.prompt,
      responseFormat: 'json_object',
      maxOutputTokens: stage === 'cinedance' ? 30000 : 24000,
      temperature: 0.2,
      reasoningEffort: env.textReasoningEffort() || undefined,
      timeoutMs: 8 * 60_000,
      maxAttempts: 3,
    }
    const fallbackInput: GenerateTextInput | null = fallbackBaseUrl && fallbackKey ? {
      baseUrl: fallbackBaseUrl,
      apiKey: fallbackKey,
      model: env.textFallbackModel(),
      mode: env.textFallbackApiMode(),
      system: generatedPrompt.system,
      prompt: generatedPrompt.prompt,
      maxOutputTokens: stage === 'cinedance' ? 30000 : 24000,
      temperature: 0.2,
      reasoningEffort: env.textFallbackReasoningEffort() || undefined,
      timeoutMs: 8 * 60_000,
      maxAttempts: 2,
    } : null
    const result = await generateTextWithFallback(
      primaryInput,
      fallbackInput,
      { primary: '主文本模型', fallback: '备用文本模型' },
    )
    const generatedValue = extractJsonValue(result)
    let output: ReturnType<typeof parseDirectorStageOutput>
    try {
      output = parseDirectorStageOutput(stage, generatedValue)
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      const repairPrompt = buildDirectorStageRepairPrompt({
        stage,
        invalidOutput: generatedValue,
        issues: error.issues.slice(0, 80).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
      console.warn(`director stage ${version.id} requires structural repair`, error.issues.map((issue) => issue.path.join('.')))
      const repaired = await generateTextWithFallback(
        { ...primaryInput, prompt: repairPrompt, maxAttempts: 2, temperature: 0 },
        fallbackInput ? { ...fallbackInput, prompt: repairPrompt, maxAttempts: 2, temperature: 0 } : null,
        { primary: '主文本模型结构修复', fallback: '备用文本模型结构修复' },
      )
      output = parseDirectorStageOutput(stage, extractJsonValue(repaired))
    }
    await prisma.directorStageVersion.update({
      where: { id: version.id },
      data: {
        status: DirectorStageStatus.ready,
        output: asInputJson(output),
        error: null,
      },
    })
    if (stage === 'lira') await syncDirectorCharacterStateAssets(version.productionId, output)
    return output
  } catch (error) {
    const message = readableDirectorStageError(error)
    await prisma.directorStageVersion.update({
      where: { id: version.id },
      data: { status: DirectorStageStatus.failed, error: message.slice(0, 8000) },
    })
    throw error
  }
}

export function directorSkillMetadata(stage: DirectorEditableStage) {
  return DIRECTOR_SKILL_VERSIONS[stage]
}

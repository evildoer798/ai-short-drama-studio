export type PreparedVideoPrompt = {
  prompt: string
  adjusted: boolean
  replacementCount: number
}

function dedupeStaticPromptLines(value: string) {
  const seenBySection = new Map<string, Set<string>>()
  const output: string[] = []
  let section = 'unstructured'
  let removedCount = 0

  for (const sourceLine of value.split('\n')) {
    const line = sourceLine.trim()
    const heading = line.match(/^【([^】]+)】$/u)
    if (heading) {
      section = heading[1]
      output.push(sourceLine)
      continue
    }
    if (!line || section === '视频分镜') {
      output.push(sourceLine)
      continue
    }

    const key = line.replace(/\s+/gu, ' ').replace(/[。；;]+$/gu, '')
    const seen = seenBySection.get(section) || new Set<string>()
    if (seen.has(key)) {
      removedCount += 1
      continue
    }
    seen.add(key)
    seenBySection.set(section, seen)
    output.push(sourceLine)
  }

  return { prompt: output.join('\n'), removedCount }
}

const providerSensitiveRewrites: ReadonlyArray<readonly [RegExp, string]> = [
  [/指尖(?:不断)?渗血/gu, '指尖因持续用力而发红'],
  [/死死(?:地)?抠住/gu, '用力抓住'],
  [/漆黑(?:的)?深渊/gu, '夜色笼罩的悬崖下方'],
  [/黑暗(?:的)?深渊/gu, '夜色笼罩的悬崖下方'],
  [/整个人坠入黑暗/gu, '身体从月光悬崖持续向下坠落并离开画面'],
  [/身体(?:迅速|连续)?向下坠落/gu, '身体沿月光悬崖垂直方向持续下落并离开画面'],
  [/碎石坠落声/gu, '碎石向下滚落声'],
  [/bleeding fingertips/giu, 'whitened, trembling fingers'],
  [/fingertips? (?:are )?bleeding/giu, 'fingers are pale and trembling'],
  [/clings? desperately/giu, 'grips firmly'],
  [/plunges? into (?:the )?(?:dark )?abyss/giu, 'falls continuously downward from the moonlit cliff and exits frame'],
]

const anthropomorphicAppearancePattern = /狼头(?!戒指|项链|吊坠|徽章|图案|纹样|雕像|装饰|纹章|印记|标志)|兽头(?!戒指|项链|吊坠|徽章|图案|纹样|雕像|装饰|纹章|印记|标志)|人形狼|尖耳|长吻|全身(?:狼毛|兽毛)|兽爪|四足姿态/iu
const negatedAnthropomorphicAppearancePattern = /(?:禁止|严禁|不要|不得|避免|杜绝|排除|不可|不能|不出现|未明确变身|without|never|avoid|exclude|prohibit(?:ed)?|\bno\b|\bnot\b)/iu

export function hasAnthropomorphicAssetDescription(value: string) {
  return value
    .split(/[\n。；;]/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => (
      anthropomorphicAppearancePattern.test(segment)
      && !negatedAnthropomorphicAppearancePattern.test(segment)
    ))
}

export function prepareVideoPromptForProvider(value: string): PreparedVideoPrompt {
  const deduped = dedupeStaticPromptLines(value)
  let prompt = deduped.prompt
  let replacementCount = 0

  for (const [pattern, replacement] of providerSensitiveRewrites) {
    prompt = prompt.replace(pattern, () => {
      replacementCount += 1
      return replacement
    })
  }

  return {
    prompt,
    adjusted: replacementCount > 0 || deduped.removedCount > 0,
    replacementCount,
  }
}

export function readableVideoModerationError(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (!/sensitive_words_detected|content moderation|prompt or reference material was rejected/iu.test(error)) {
    return null
  }
  return '视频服务的内容审核拒绝了当前提示词或参考素材。系统已自动降低容易误判的危险和受伤措辞，请重新点击生成。本次失败发生在提交阶段，不是服务器、OSS 或 API Key 故障。'
}

export function readableVideoReferenceError(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (!/could not fetch Seedance image reference/iu.test(error)) return null
  return 'Seedance 已接受任务，但无法下载 OSS 参考图。系统已改用标准阿里云 OSS 公网地址，请刷新后重新生成；这不是内容审核或 API Key 权限问题。'
}

export function readableVideoProviderError(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (/参考图最多\s*4\s*张|当前\s*5\s*张|reference images?.*(?:maximum|max(?:imum)?)[^0-9]*4/iu.test(error)) {
    return '当前视频线路最多支持 4 张参考图。本次提交了 5 张，供应商已拒绝；系统现已限制为 4 张，同场景承接时由上一镜尾帧替代场景图。'
  }
  if (/视频生成失败[，,：:\s]*上游未提供具体原因|Video generation failed without a specific reason|no failure detail/iu.test(error)) {
    return '上游未完成视频生成，参考素材上传正常。系统会自动重试最多 3 次；多次失败通常是提示词或参考图语义冲突。'
  }
  if (/real human faces[\s\S]*does not support|real person's face[\s\S]*cannot be used/iu.test(error)) {
    return '所选视频模型不支持真人面孔参考图。请改用未标注“真人受限”的 Seedance 模型；人物资产、提示词和 API Key 本身没有问题。'
  }
  if (/All cookies failed|field ['"]generate['"] not found in type|upstream adapter unavailable/iu.test(error)) {
    if (/insufficient credits|requires more credits than any account currently has available/iu.test(error)) {
      return '视频供应商内部执行账号的当前额度不足，无法完成所选模型、时长和清晰度组合。这不是你的 API Key 余额不足；请改用 Seedance 2.0 Mini、480p或缩短时长。系统不会对同一配置连续重试。'
    }
    return '视频供应商的当前模型线路内部接口失效。系统会自动切换备用 API Key 重试；如果全部线路仍失败，请改用 Seedance 2.0 Mini 或稍后再试。人物资产和提示词无需修改。'
  }
  return null
}

export function readableVideoTaskError(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (/VIDEO_TASK_CANCELLED/iu.test(error)) {
    return '视频生成已取消，未保存该任务的生成结果。'
  }
  const knownError = readableVideoProviderError(error)
    || readableVideoReferenceError(error)
    || readableVideoModerationError(error)
  if (knownError) return knownError

  if (/invalid_prompt[\s\S]*maximum length of 4096|Prompt exceeds the maximum length of 4096/iu.test(error)) {
    return '视频提示词超过模型长度限制。系统已自动精简，请重新生成。'
  }
  if (/model grok-video not found/iu.test(error)) {
    return '当前线路没有所选 Grok 模型。请刷新模型列表后重新选择。'
  }
  if (/seconds must be one of:\s*6,\s*10,\s*15/iu.test(error)) {
    return '所选 Grok 模型仅支持 6、10 或 15 秒。请调整时长后重新生成。'
  }
  if (/Adobe video submit failed with status 408/iu.test(error)) {
    return 'Seedance 上游暂时超时，未生成视频。请稍后重新生成。'
  }

  return '视频生成失败，服务暂未提供可用原因。请稍后重新生成。'
}

export function shouldOmitVideoLocationReference(locationName: string) {
  void locationName
  return false
}

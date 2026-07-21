export function readableTextTaskError(error: string | null) {
  if (!error) return '任务执行失败'
  if (/TEXT_TASK_INTERRUPTED|TEXT_WORKER_INTERRUPTED/i.test(error)) {
    return '后台改编进程已经停止，已完成的检查点仍然保留。请重新点击生成，系统会从未完成步骤继续。'
  }
  if (/SCENE_CONSISTENCY_MISSING/i.test(error)) {
    return '分镜缺少可核对的标准场景名。请返回分镜拆解，把时间地点改为“时间｜标准场景名”后再提取资产。'
  }
  if (/SCENE_CONSISTENCY_MISMATCH/i.test(error)) {
    const missing = error.split('SCENE_CONSISTENCY_MISMATCH:')[1]?.trim()
    return `场景资产尚未与全部分镜逐字一致。${missing || '请重新执行一次按分镜提取资产。'}`
  }
  if (/TEXT_PROVIDERS_FAILED/i.test(error)) {
    return 'DeepSeek 本次未完成请求。系统已保留全部检查点，再次运行会从未完成步骤继续。'
  }
  if (/content moderation|prompt or reference material was rejected|content policy/i.test(error)) {
    return '某条文字线路触发了内容审核；系统已按配置尝试备用线路。已完成的分片和检查点仍然保留，重新运行会从未完成部分继续。'
  }
  if (/timeout|timed?\s*out|aborted/i.test(error)) {
    return '文本模型响应超时。系统会从已经完成的分集继续重试，不会重复丢失资产草稿。'
  }
  if (/TEXT_API_FAILED:\s*(502|504)/i.test(error)) {
    return '文本模型网关暂时中断（502/504）。系统已自动重试，小说原文仍已保存，请稍后重新生成。'
  }
  if (/TEXT_API_FAILED:\s*503/i.test(error)) {
    return '文本模型服务暂时不可用（503）。小说和已编辑内容已保存，请稍后直接重试。'
  }
  if (/TEXT_API_FAILED:\s*429/i.test(error)) {
    return '文本模型当前请求过多，请稍后重试。'
  }
  return error
}

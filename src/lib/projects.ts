import { ProjectRole, VisualStyle } from '@prisma/client'
import { z } from 'zod'

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, '请输入剧本项目名称').max(80, '项目名称最多 80 个字符'),
  workspaceId: z.string().trim().min(1, '请选择工作区'),
  visualStyle: z.nativeEnum(VisualStyle).default(VisualStyle.photorealistic),
  shareWithWorkspace: z.boolean().default(true),
})

export const renameProjectSchema = z.object({
  name: z.string().trim().min(1, '请输入剧本名称').max(80, '剧本名称最多 80 个字符'),
})

export type ProjectStage = {
  index: number
  label: string
}

export function deriveProjectStage(input: {
  hasNovel: boolean
  episodeCount: number
  storyboardCount: number
  assetCount: number
  renderCount: number
}): ProjectStage {
  if (input.renderCount > 0) return { index: 5, label: '成片剪辑' }
  if (input.assetCount > 0) return { index: 4, label: '资产与视频' }
  if (input.storyboardCount > 0) return { index: 3, label: '分镜拆解' }
  if (input.episodeCount > 0) return { index: 2, label: '剧本改编' }
  if (input.hasNovel) return { index: 1, label: '小说已导入' }
  return { index: 0, label: '等待导入' }
}

export function projectRoleForWorkspaceMember(input: {
  workspaceRole: ProjectRole
  isCreator: boolean
}) {
  if (input.isCreator) return ProjectRole.owner
  return input.workspaceRole === ProjectRole.member ? ProjectRole.member : ProjectRole.admin
}

export type ProjectHubWorkspace = {
  id: string
  name: string
  role: ProjectRole
  memberCount: number
}

export type ProjectHubProject = {
  id: string
  name: string
  workspaceName: string
  role: ProjectRole
  visualStyle: VisualStyle
  visualStyleLabel: string
  coverUrl: string | null
  stage: ProjectStage
  episodeCount: number
  assetCount: number
  storyboardCount: number
  renderCount: number
  activeTask: boolean
  lastActivityAt: string
}

export type ProjectHubData = {
  workspaces: ProjectHubWorkspace[]
  projects: ProjectHubProject[]
  styleOptions: Array<{
    id: VisualStyle
    label: string
    shortLabel: string
    description: string
    swatch: [string, string, string]
  }>
}

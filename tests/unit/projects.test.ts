import { ProjectRole, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  createProjectSchema,
  deriveProjectStage,
  projectRoleForWorkspaceMember,
  renameProjectSchema,
} from '@/lib/projects'

describe('project creation', () => {
  it('normalizes a new project and applies collaboration defaults', () => {
    expect(createProjectSchema.parse({
      name: '  雨夜来信  ',
      workspaceId: 'workspace-1',
      visualStyle: VisualStyle.anime_2d,
    })).toEqual({
      name: '雨夜来信',
      workspaceId: 'workspace-1',
      visualStyle: VisualStyle.anime_2d,
      shareWithWorkspace: true,
    })
  })

  it('rejects an empty project name', () => {
    expect(() => createProjectSchema.parse({
      name: '   ',
      workspaceId: 'workspace-1',
    })).toThrow('请输入剧本项目名称')
  })

  it('trims a renamed script and rejects an empty name', () => {
    expect(renameProjectSchema.parse({ name: '  山海回声  ' })).toEqual({ name: '山海回声' })
    expect(() => renameProjectSchema.parse({ name: '   ' })).toThrow('请输入剧本名称')
  })

  it('makes the creator owner and preserves team access levels', () => {
    expect(projectRoleForWorkspaceMember({
      workspaceRole: ProjectRole.member,
      isCreator: true,
    })).toBe(ProjectRole.owner)
    expect(projectRoleForWorkspaceMember({
      workspaceRole: ProjectRole.owner,
      isCreator: false,
    })).toBe(ProjectRole.admin)
    expect(projectRoleForWorkspaceMember({
      workspaceRole: ProjectRole.member,
      isCreator: false,
    })).toBe(ProjectRole.member)
  })
})

describe('project stage summary', () => {
  it('shows the furthest completed production stage', () => {
    expect(deriveProjectStage({
      hasNovel: true,
      episodeCount: 15,
      storyboardCount: 120,
      assetCount: 24,
      videoCount: 1,
    })).toEqual({ index: 5, label: '视频库' })
  })

  it('keeps a new project at the import stage', () => {
    expect(deriveProjectStage({
      hasNovel: false,
      episodeCount: 0,
      storyboardCount: 0,
      assetCount: 0,
      videoCount: 0,
    })).toEqual({ index: 0, label: '等待导入' })
  })
})

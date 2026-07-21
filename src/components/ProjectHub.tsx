'use client'

import Link from 'next/link'
import { FormEvent, useMemo, useState } from 'react'
import {
  ArrowRight,
  BookOpenText,
  Check,
  Clapperboard,
  Clock3,
  ExternalLink,
  Film,
  FolderOpen,
  ImageIcon,
  ListVideo,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Search,
  UsersRound,
  X,
} from 'lucide-react'
import type { ProjectHubData } from '@/lib/projects'

type User = {
  id: string
  email: string
  name: string
}

type ProjectForm = {
  name: string
  workspaceId: string
  visualStyle: ProjectHubData['styleOptions'][number]['id']
  shareWithWorkspace: boolean
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`)
  return payload as T
}

function formatActivity(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

const roleLabels = {
  owner: '负责人',
  admin: '管理员',
  member: '成员',
} as const

export function ProjectHub({ user, initialData }: { user: User, initialData: ProjectHubData }) {
  const [projects, setProjects] = useState(initialData.projects)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(initialData.projects.length === 0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [renamingProjectId, setRenamingProjectId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSubmitting, setRenameSubmitting] = useState(false)
  const [renameError, setRenameError] = useState('')
  const [form, setForm] = useState<ProjectForm>({
    name: '',
    workspaceId: initialData.workspaces[0]?.id || '',
    visualStyle: 'photorealistic',
    shareWithWorkspace: true,
  })
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return projects
    return projects.filter((project) => (
      project.name.toLocaleLowerCase().includes(normalized)
      || project.workspaceName.toLocaleLowerCase().includes(normalized)
      || project.visualStyleLabel.toLocaleLowerCase().includes(normalized)
    ))
  }, [projects, query])

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const payload = await requestJson<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      window.location.assign(`/projects/${payload.project.id}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '新建项目失败，请重试')
      setSubmitting(false)
    }
  }

  async function renameProject(event: FormEvent<HTMLFormElement>, projectId: string) {
    event.preventDefault()
    if (renameSubmitting || !renameDraft.trim()) return
    setRenameSubmitting(true)
    setRenameError('')
    try {
      const payload = await requestJson<{
        project: { id: string, name: string, updatedAt: string }
      }>(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: renameDraft }),
      })
      setProjects((current) => current.map((project) => project.id === projectId
        ? { ...project, name: payload.project.name, lastActivityAt: payload.project.updatedAt }
        : project))
      setRenamingProjectId('')
      setRenameDraft('')
    } catch (caught) {
      setRenameError(caught instanceof Error ? caught.message : '剧本重命名失败，请重试')
    } finally {
      setRenameSubmitting(false)
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.assign('/login')
  }

  return (
    <main className="projectHubShell">
      <header className="projectHubHeader">
        <div className="productIdentity">
          <span className="productIcon"><Clapperboard size={20} /></span>
          <span>
            <strong>AI 短剧工作台</strong>
            <small>剧本项目</small>
          </span>
        </div>
        <div className="projectHubUser">
          <span><strong>{user.name}</strong><small>{user.email}</small></span>
          <button className="iconButton" type="button" onClick={() => void logout()} title="退出登录" aria-label="退出登录">
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <div className="projectHubMain">
        <section className="projectHubTitlebar">
          <div>
            <h1>剧本项目</h1>
            <p>打开已有剧本继续制作，或建立一个独立的新项目。</p>
          </div>
          <button
            className="primaryButton"
            type="button"
            onClick={() => {
              setCreating(true)
              setError('')
            }}
            aria-expanded={creating}
          >
            <Plus size={17} />新建剧本
          </button>
        </section>

        {creating ? (
          <form className="projectCreatePanel" onSubmit={createProject}>
            <div className="projectCreateHeader">
              <div>
                <strong>新建剧本项目</strong>
                <p>项目中的小说、剧本、资产、分镜和视频会独立保存。</p>
              </div>
              {projects.length > 0 ? (
                <button className="iconButton small" type="button" onClick={() => setCreating(false)} title="收起" aria-label="收起新建项目表单">
                  <X size={16} />
                </button>
              ) : null}
            </div>

            <div className="projectCreateFields">
              <label>
                项目名称
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：雨夜来信"
                  maxLength={80}
                  autoFocus
                  required
                />
              </label>
              <label>
                所属工作区
                <select
                  value={form.workspaceId}
                  onChange={(event) => setForm((current) => ({ ...current, workspaceId: event.target.value }))}
                  required
                >
                  {initialData.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name} · {workspace.memberCount} 人
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <fieldset className="projectStylePicker">
              <legend>项目统一画风</legend>
              <div>
                {initialData.styleOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={form.visualStyle === option.id ? 'active' : ''}
                    onClick={() => setForm((current) => ({ ...current, visualStyle: option.id }))}
                    aria-pressed={form.visualStyle === option.id}
                    title={option.description}
                  >
                    <span className="styleSwatch" aria-hidden="true">
                      {option.swatch.map((color) => <i key={color} style={{ backgroundColor: color }} />)}
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="projectShareOption">
              <input
                type="checkbox"
                checked={form.shareWithWorkspace}
                onChange={(event) => setForm((current) => ({ ...current, shareWithWorkspace: event.target.checked }))}
              />
              <span><strong>与工作区成员共享</strong><small>开启后，团队成员可以进入并协作编辑这个剧本。</small></span>
            </label>

            {error ? <p className="projectCreateError" role="alert">{error}</p> : null}
            <div className="projectCreateActions">
              {projects.length > 0 ? (
                <button className="quietButton" type="button" onClick={() => setCreating(false)} disabled={submitting}>取消</button>
              ) : null}
              <button className="primaryButton" type="submit" disabled={submitting || !form.workspaceId || !form.name.trim()}>
                {submitting ? <Loader2 className="spin" size={17} /> : <ArrowRight size={17} />}
                {submitting ? '正在创建' : '创建并进入'}
              </button>
            </div>
          </form>
        ) : null}

        {projects.length > 0 ? (
          <>
            <section className="projectHubFilter" aria-label="筛选项目">
              <label className="projectSearch">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索剧本、工作区或画风"
                  aria-label="搜索剧本项目"
                />
              </label>
              <span>{filteredProjects.length} 个项目</span>
            </section>

            {filteredProjects.length > 0 ? (
              <section className="projectGrid" aria-label="剧本项目列表">
                {filteredProjects.map((project) => (
                  <article className="projectCard" key={project.id}>
                    <Link className="projectCover" href={`/projects/${project.id}`} aria-label={`打开 ${project.name}`}>
                      {project.coverUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={project.coverUrl} alt={`${project.name} 项目素材`} loading="lazy" />
                      ) : (
                        <span className="projectCoverEmpty"><Film size={32} /><small>{project.visualStyleLabel}</small></span>
                      )}
                      {project.activeTask ? <span className="projectBusy"><Loader2 className="spin" size={13} />正在处理</span> : null}
                    </Link>

                    <div className="projectCardBody">
                      <div className="projectCardHeading">
                        <div>
                          {renamingProjectId === project.id ? (
                            <form className="projectRenameForm" onSubmit={(event) => void renameProject(event, project.id)}>
                              <input
                                value={renameDraft}
                                onChange={(event) => setRenameDraft(event.target.value)}
                                maxLength={80}
                                aria-label="剧本名称"
                                autoFocus
                              />
                              <button className="iconButton small" type="submit" disabled={renameSubmitting || !renameDraft.trim()} title="保存名称" aria-label="保存剧本名称">
                                {renameSubmitting ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                              </button>
                              <button
                                className="iconButton small"
                                type="button"
                                disabled={renameSubmitting}
                                onClick={() => {
                                  setRenamingProjectId('')
                                  setRenameDraft('')
                                  setRenameError('')
                                }}
                                title="取消改名"
                                aria-label="取消改名"
                              >
                                <X size={15} />
                              </button>
                            </form>
                          ) : (
                            <Link href={`/projects/${project.id}`}>{project.name}</Link>
                          )}
                          <span>{project.workspaceName} · {roleLabels[project.role]}</span>
                          {renamingProjectId === project.id && renameError ? <small className="projectRenameError" role="alert">{renameError}</small> : null}
                        </div>
                        <div className="projectCardHeadingActions">
                          {renamingProjectId !== project.id ? (
                            <button
                              className="iconButton small"
                              type="button"
                              onClick={() => {
                                setRenamingProjectId(project.id)
                                setRenameDraft(project.name)
                                setRenameError('')
                              }}
                              title="重命名剧本"
                              aria-label={`重命名 ${project.name}`}
                            >
                              <Pencil size={15} />
                            </button>
                          ) : null}
                          <Link
                            className="iconButton small"
                            href={`/projects/${project.id}`}
                            target="_blank"
                            rel="noreferrer"
                            title="在新标签页打开"
                            aria-label={`在新标签页打开 ${project.name}`}
                          >
                            <ExternalLink size={15} />
                          </Link>
                        </div>
                      </div>

                      <div className="projectStageRow">
                        <span>{project.stage.label}</span>
                        <div className="projectStageTrack" aria-label={`制作阶段：${project.stage.label}`}>
                          {Array.from({ length: 6 }, (_, index) => (
                            <i key={index} className={index <= project.stage.index ? 'active' : ''} />
                          ))}
                        </div>
                      </div>

                      <dl className="projectStats">
                        <div><dt><BookOpenText size={14} />分集</dt><dd>{project.episodeCount}</dd></div>
                        <div><dt><ImageIcon size={14} />资产</dt><dd>{project.assetCount}</dd></div>
                        <div><dt><ListVideo size={14} />分镜</dt><dd>{project.storyboardCount}</dd></div>
                        <div><dt><FolderOpen size={14} />成片</dt><dd>{project.renderCount}</dd></div>
                      </dl>

                      <div className="projectCardFooter">
                        <span><Clock3 size={14} />{formatActivity(project.lastActivityAt)}</span>
                        <Link className="projectOpenLink" href={`/projects/${project.id}`}>打开项目<ArrowRight size={15} /></Link>
                      </div>
                    </div>
                  </article>
                ))}
              </section>
            ) : (
              <section className="projectEmptySearch">
                <Search size={24} />
                <strong>没有匹配的剧本</strong>
                <button className="quietButton" type="button" onClick={() => setQuery('')}>清除搜索</button>
              </section>
            )}
          </>
        ) : (
          <section className="projectFirstRun">
            <UsersRound size={22} />
            <span>创建第一个剧本项目后，小说原文、分集剧本和生成素材都会保存在该项目中。</span>
          </section>
        )}
      </div>
    </main>
  )
}

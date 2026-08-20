'use client'

import Link from 'next/link'
import { FormEvent, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  FileText,
  FileUp,
  Film,
  FolderOpen,
  Loader2,
  Plus,
  Sparkles,
} from 'lucide-react'
import type { getDirectorHomeData } from '@/lib/director-data'
import { decodeTextFile, titleFromTextFile } from '@/lib/text-file'
import styles from './director.module.css'

type HomeData = Awaited<ReturnType<typeof getDirectorHomeData>>
type CreateMode = 'new' | 'existing'

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`)
  return payload as T
}

const stageLabels = { acting: '表演设计', lira: '视觉资产', cinedance: '动态镜头', review: '生成与审片', completed: '已完成' } as const

export function DirectorHome({ user, initialData }: { user: { name: string; email: string }; initialData: HomeData }) {
  const [creating, setCreating] = useState(initialData.productions.length === 0)
  const [mode, setMode] = useState<CreateMode>('new')
  const [projectId, setProjectId] = useState(initialData.projects[0]?.id || '')
  const selectedProject = useMemo(() => initialData.projects.find((project) => project.id === projectId), [initialData.projects, projectId])
  const [episodeId, setEpisodeId] = useState(selectedProject?.episodes[0]?.id || '')
  const [existingName, setExistingName] = useState(selectedProject ? `${selectedProject.name} · 导演版` : '')
  const [workspaceId, setWorkspaceId] = useState(initialData.workspaces[0]?.id || '')
  const [newProjectName, setNewProjectName] = useState('')
  const [scriptTitle, setScriptTitle] = useState('')
  const [scriptContent, setScriptContent] = useState('')
  const [newProductionName, setNewProductionName] = useState('')
  const [importedFileName, setImportedFileName] = useState('')
  const [readingFile, setReadingFile] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  function chooseProject(nextId: string) {
    const project = initialData.projects.find((item) => item.id === nextId)
    setProjectId(nextId)
    setEpisodeId(project?.episodes[0]?.id || '')
    setExistingName(project ? `${project.name} · 导演版` : '')
  }

  function chooseMode(nextMode: CreateMode) {
    setMode(nextMode)
    setError('')
  }

  async function importScript(file: File | undefined) {
    if (!file) return
    setError('')
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setError('请选择 .txt 格式的剧本文件')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('TXT 文件不能超过 5MB')
      return
    }

    setReadingFile(true)
    try {
      const content = decodeTextFile(await file.arrayBuffer())
      if (content.length < 100) throw new Error('剧本正文至少需要 100 个字符')
      if (content.length > 500_000) throw new Error('剧本正文不能超过 50 万字符')
      const title = titleFromTextFile(file.name)
      setScriptContent(content)
      setScriptTitle(title)
      setImportedFileName(file.name)
      if (!newProjectName.trim()) setNewProjectName(title)
      if (!newProductionName.trim()) setNewProductionName(`${title} · 导演版`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '剧本文件读取失败')
    } finally {
      setReadingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const body = mode === 'new'
        ? {
            mode: 'new',
            workspaceId,
            projectName: newProjectName,
            scriptTitle,
            scriptContent,
            name: newProductionName,
          }
        : {
            mode: 'existing',
            projectId,
            sourceEpisodeId: episodeId || null,
            name: existingName,
          }
      const result = await requestJson<{ production: { id: string } }>('/api/director/productions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      window.location.assign(`/director/${result.production.id}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建失败')
      setSubmitting(false)
    }
  }

  const newProjectReady = Boolean(
    workspaceId
    && newProjectName.trim()
    && scriptTitle.trim()
    && scriptContent.trim().length >= 100
    && newProductionName.trim(),
  )
  const existingProjectReady = Boolean(projectId && existingName.trim())

  return (
    <main className={styles.homeShell}>
      <header className={styles.homeHeader}>
        <Link className={styles.identity} href="/director"><span><Clapperboard size={19} /></span><strong>导演工作台</strong><small>AI 电影制作</small></Link>
        <nav><Link href="/">剧本项目</Link><span>{user.name}</span></nav>
      </header>
      <section className={styles.homeIntro}>
        <div><p className={styles.contextLine}>独立制作工具</p><h1>从剧本到成片，一次只做一个决定</h1><p>ACTING 负责表演，LIRA 锁定视觉资产，CINEDANCE 完成动态镜头。每个阶段由你确认后才继续。</p></div>
        <button className={styles.primaryButton} type="button" onClick={() => setCreating(true)}><Plus size={17} />开始新制作</button>
      </section>
      {creating ? (
        <form className={styles.importPanel} onSubmit={create}>
          <div className={styles.createModeSwitch} aria-label="制作来源">
            <button type="button" className={mode === 'new' ? styles.active : ''} aria-pressed={mode === 'new'} onClick={() => chooseMode('new')}>
              <FileUp size={17} /><span><strong>上传新剧本</strong><small>建立完全独立的新项目</small></span>
            </button>
            <button type="button" className={mode === 'existing' ? styles.active : ''} aria-pressed={mode === 'existing'} onClick={() => chooseMode('existing')}>
              <FolderOpen size={17} /><span><strong>使用已有项目</strong><small>读取已有剧本与角色资产</small></span>
            </button>
          </div>

          {mode === 'new' ? (
            <>
              <div className={styles.importHeading}><span><FileText size={20} /></span><div><h2>创建独立项目</h2><p>上传或粘贴剧本。新项目不会继承旧项目的角色、分镜和媒体资产。</p></div></div>
              {initialData.workspaces.length ? (
                <div className={styles.formGrid}>
                  {initialData.workspaces.length > 1 ? <label>工作区<select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{initialData.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label> : null}
                  <label className={initialData.workspaces.length > 1 ? '' : styles.wideField}>新项目名称<input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="例如：雨夜来客" maxLength={80} required /></label>
                  <label>剧本标题<input value={scriptTitle} onChange={(event) => setScriptTitle(event.target.value)} placeholder="第一集标题或作品名" maxLength={120} required /></label>
                  <label>制作名称<input value={newProductionName} onChange={(event) => setNewProductionName(event.target.value)} placeholder="例如：雨夜来客 · 导演版" maxLength={100} required /></label>
                  <div className={`${styles.scriptField} ${styles.wideField}`}>
                    <div className={styles.scriptFieldHeading}>
                      <span><strong>剧本正文</strong><small>{scriptContent.trim().length.toLocaleString()} / 500,000 字符</small></span>
                      <input ref={fileInputRef} type="file" accept=".txt,text/plain" hidden onChange={(event) => void importScript(event.target.files?.[0])} />
                      <button className={styles.quietButton} type="button" disabled={readingFile || submitting} onClick={() => fileInputRef.current?.click()}>
                        {readingFile ? <Loader2 className={styles.spin} size={16} /> : <FileUp size={16} />}{readingFile ? '读取中' : importedFileName || '上传 TXT'}
                      </button>
                    </div>
                    <textarea value={scriptContent} onChange={(event) => setScriptContent(event.target.value)} placeholder="上传 TXT，或在这里粘贴完整剧本。ACTING 会从剧本识别角色并建立表演与声音档案。" maxLength={500_000} required />
                    <p>支持 UTF-8、UTF-16、GBK 编码的 TXT，最大 5MB；至少 100 个字符。</p>
                  </div>
                </div>
              ) : <div className={styles.emptyInline}><Film size={20} /><span>当前账号还没有可用工作区。</span><Link href="/">先创建工作区</Link></div>}
            </>
          ) : (
            <>
              <div className={styles.importHeading}><span><FolderOpen size={20} /></span><div><h2>导入现有项目</h2><p>只读取项目、剧本、角色和媒体快照，不会改变原有分镜流程。</p></div></div>
              {initialData.projects.length ? <div className={styles.formGrid}>
                <label>项目<select value={projectId} onChange={(event) => chooseProject(event.target.value)}>{initialData.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.assetCount} 项资产</option>)}</select></label>
                <label>剧本<select value={episodeId} onChange={(event) => setEpisodeId(event.target.value)}><option value="">项目首集</option>{selectedProject?.episodes.map((episode) => <option key={episode.id} value={episode.id}>第 {episode.episodeNumber} 集 · {episode.title}</option>)}</select></label>
                <label className={styles.wideField}>制作名称<input value={existingName} onChange={(event) => setExistingName(event.target.value)} maxLength={100} required /></label>
              </div> : <div className={styles.emptyInline}><Film size={20} /><span>还没有可导入的剧本项目。</span></div>}
            </>
          )}

          {error ? <p className={styles.errorText} role="alert">{error}</p> : null}
          <div className={styles.formActions}>
            {initialData.productions.length ? <button className={styles.quietButton} type="button" onClick={() => setCreating(false)}>取消</button> : null}
            <button className={styles.primaryButton} type="submit" disabled={(mode === 'new' ? !newProjectReady : !existingProjectReady) || submitting}>
              {submitting ? <Loader2 className={styles.spin} size={17} /> : <ArrowRight size={17} />}{submitting ? '正在建立' : '建立并进入 ACTING'}
            </button>
          </div>
        </form>
      ) : null}
      <section className={styles.productionSection}>
        <div className={styles.sectionHeading}><h2>最近制作</h2><span>{initialData.productions.length} 个</span></div>
        {initialData.productions.length ? <div className={styles.productionList}>{initialData.productions.map((production) => (
          <Link className={styles.productionRow} href={`/director/${production.id}`} key={production.id}>
            <span className={styles.productionIcon}>{production.status === 'completed' ? <CheckCircle2 size={19} /> : <Sparkles size={19} />}</span>
            <span className={styles.productionName}><strong>{production.name}</strong><small>{production.project.name}{production.sourceEpisode ? ` · 第 ${production.sourceEpisode.episodeNumber} 集` : ''}</small></span>
            <span className={styles.stagePill}>{stageLabels[production.currentStage]}</span>
            <span className={styles.stageProgress} aria-label={`已确认 ${production.confirmedStages.length} 个阶段`}><i style={{ width: `${Math.min(100, production.confirmedStages.length / 3 * 100)}%` }} /></span>
            <span className={styles.shotCount}>{production.shotCount} 镜</span><ArrowRight size={17} />
          </Link>
        ))}</div> : <div className={styles.emptyState}><Clapperboard size={28} /><strong>上传一份剧本开始第一部制作</strong><p>新项目会保持独立，AI 首先从剧本建立角色表演和声音档案。</p></div>}
      </section>
    </main>
  )
}

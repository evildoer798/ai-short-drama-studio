'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Eye,
  FileUp,
  FilePenLine,
  Film,
  ImageIcon,
  ListVideo,
  Loader2,
  Lock,
  MapPinned,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Unlock,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react'
import { decodeTextFile, titleFromTextFile } from '@/lib/text-file'
import { calculateSceneConsistency } from '@/lib/scene-consistency'
import { readableTextTaskError } from '@/lib/text-task-error'
import type { TextProviderLabel } from '@/lib/text-provider-label'

type AssetType = 'character' | 'location' | 'prop'
type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
type PreproductionMode = 'script' | 'assetPlan' | 'shotPlan'

type TextTask = {
  id: string
  type: 'script_adaptation' | 'script_revision' | 'asset_extraction' | 'storyboard_generation'
  status: TaskStatus
  model: string
  progress: number
  error: string | null
  projectId: string
  createdAt: string
  updatedAt: string
  detail: {
    phase: 'preparing' | 'generating' | 'retrying' | 'saving' | 'finalizing'
    completedEpisodes: number
    totalEpisodes: number
    completedSegments: number
    totalSegments: number
    activeEpisodeNumbers: number[]
    parallelism: number
    segmentParallelism: number
    currentSegment?: number
    currentSegmentTotal?: number
    activeRoutes: Array<{
      episodeNumber: number
      provider: TextProviderLabel
      model: string
      attempt: number
      total: number
      reason?: string
    }>
  } | null
}

type ScriptComment = {
  id: string
  episodeId: string
  quotedText: string
  instruction: string
  startOffset: number | null
  endOffset: number | null
  resolved: boolean
  createdAt: string
  createdBy: { id: string; name: string }
}

type ScriptEpisode = {
  id: string
  projectId: string
  episodeNumber: number
  title: string
  logline: string | null
  content: string
  locked: boolean
  sourceChunkIndexes: number[]
  storyboardCount: number
  updatedAt: string
  comments: ScriptComment[]
}

type PreproductionData = {
  novel: {
    id: string
    projectId: string
    title: string
    content: string
    updatedAt: string
  } | null
  episodes: ScriptEpisode[]
  tasks: TextTask[]
  adaptationSettings: {
    targetEpisodeCount: number
    episodeMinutes: number
    source: 'task' | 'episodes' | 'default'
  }
  textModel: string
}

type PlanningAsset = {
  id: string
  type: AssetType
  name: string
  description: string
  tags: string[]
  prompt: string | null
  images: Array<{ id: string }>
  selectedImageUrl?: string | null
}

type PlanningStoryboard = {
  id: string
  title: string
  sceneNumber: number
  episodeId?: string | null
  episodeSceneNumber?: number | null
  generatedByAI?: boolean
  notes: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  duration: number
  aspectRatio: '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3'
  generateAudio: boolean
  videos: Array<{ id: string }>
  assets: Array<{ id: string; name: string; type: AssetType; hasSelectedImage: boolean }>
}

type StoryboardPromptPreview = {
  system: string
  prompt: string
  provider: string
  model: string
  mode: string
  episode: { id: string; episodeNumber: number; title: string }
  relatedAssetCount: number
  totalAssetCount: number
  parallelism: number
}

export type PreproductionSummary = {
  novelSaved: boolean
  episodeCount: number
  lockedCount: number
  unresolvedCommentCount: number
  assetCount: number
  storyboardCount: number
  activeTask: TextTask | null
  failedTask: TextTask | null
}

type NoticeTone = 'success' | 'error'

const typeLabels: Record<AssetType, string> = {
  character: '角色',
  location: '场景',
  prop: '道具',
}

function TypeIcon({ type, size = 15 }: { type: AssetType; size?: number }) {
  if (type === 'character') return <UserRound size={size} />
  if (type === 'location') return <MapPinned size={size} />
  return <Box size={size} />
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`)
  return payload as T
}

function taskProgressLabel(task: TextTask) {
  if (task.status === 'queued') return '等待文本模型'
  if (task.type === 'script_adaptation') {
    if (task.progress < 5) return '准备小说内容'
    if (task.progress < 42) return '正在分块梳理原文'
    if (task.progress < 48) return '正在规划分集'
    return '正在逐集改写剧本'
  }
  if (task.type === 'script_revision') return '正在按评论修订剧本'
  if (task.type === 'asset_extraction') {
    if (task.progress < 35) return '正在逐集提取资产'
    if (task.progress < 50) return '正在筛选核心资产'
    if (task.progress < 90) return '正在生成资产提示词'
    if (task.progress < 98) return '正在保存资产草稿'
    return '正在自动核对并补齐场景'
  }
  if (!task.detail) return task.progress < 87 ? '正在拆解分镜' : '正在关联分镜资产'
  if (task.detail.phase === 'preparing') return '正在准备分镜断点'
  if (task.detail.phase === 'finalizing') return '正在整理镜头顺序'
  const episodes = task.detail.activeEpisodeNumbers.length > 0
    ? `第 ${task.detail.activeEpisodeNumbers.join('、')} 集`
    : '待处理分集'
  const activeRoute = task.detail.activeRoutes[0]
  const routeLabel = activeRoute ? `${activeRoute.provider} ${activeRoute.model}` : ''
  if (task.detail.phase === 'retrying') {
    const reason = activeRoute?.reason ? `${activeRoute.reason}，` : ''
    const attempt = activeRoute ? `（线路 ${activeRoute.attempt}/${activeRoute.total}）` : ''
    return `${episodes} · ${reason}正在尝试 ${routeLabel || '备用线路'}${attempt}`
  }
  if (task.detail.phase === 'saving') return `${episodes}正在保存镜头`
  const mode = task.detail.parallelism > 1
    ? `${task.detail.parallelism} 集并行`
    : task.detail.segmentParallelism > 1
      ? `单集 ${task.detail.segmentParallelism} 段并行`
      : '集内顺序处理'
  return `${episodes}${routeLabel ? ` · ${routeLabel}` : ''} · ${mode} · 已完成 ${task.detail.completedSegments}/${task.detail.totalSegments} 段`
}

export function PreproductionWorkspace({
  mode,
  projectId,
  assets,
  storyboards,
  onSummary,
  onWorkspaceChanged,
  onNotice,
  onOpenAssetPlan,
  onOpenAssetImages,
  onOpenStoryboardVideos,
}: {
  mode: PreproductionMode
  projectId: string | null
  assets: PlanningAsset[]
  storyboards: PlanningStoryboard[]
  onSummary: (summary: PreproductionSummary) => void
  onWorkspaceChanged: () => Promise<void>
  onNotice: (text: string, tone?: NoticeTone) => void
  onOpenAssetPlan: () => void
  onOpenAssetImages: () => void
  onOpenStoryboardVideos: () => void
}) {
  const [data, setData] = useState<PreproductionData | null>(null)
  const [loading, setLoading] = useState(true)

  async function refreshData() {
    if (!projectId) return
    try {
      const next = await requestJson<PreproductionData>(`/api/projects/${projectId}/preproduction`)
      setData(next)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '前期制作数据加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    setData(null)
    void refreshData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const runningTasks = data?.tasks.filter((task) => task.status === 'queued' || task.status === 'processing') || []
  const latestFailedTask = data?.tasks.find((task) => task.status === 'failed') || null
  const monitoredTasks = runningTasks.length > 0
    ? runningTasks
    : latestFailedTask ? [latestFailedTask] : []
  useEffect(() => {
    if (monitoredTasks.length === 0) return
    const timer = window.setInterval(async () => {
      const updates = await Promise.all(monitoredTasks.map(async (task) => {
        try {
          return (await requestJson<{ task: TextTask }>(`/api/tasks/${task.id}`)).task
        } catch {
          return task
        }
      }))
      const finished = updates.some((task) => {
        const previous = monitoredTasks.find((item) => item.id === task.id)
        return previous?.status !== task.status
          && (task.status === 'completed' || task.status === 'failed')
      })
      setData((current) => current ? {
        ...current,
        tasks: current.tasks.map((task) => updates.find((item) => item.id === task.id) || task),
      } : current)
      if (finished) {
        await refreshData()
        await onWorkspaceChanged()
      }
    }, runningTasks.length > 0 ? 2200 : 6000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoredTasks.map((task) => `${task.id}:${task.status}:${task.progress}`).join('|')])

  const relevantTypes = mode === 'script'
    ? ['script_adaptation', 'script_revision', 'storyboard_generation']
    : mode === 'assetPlan' ? ['asset_extraction'] : ['storyboard_generation']
  const latestRelevantTask = data?.tasks.find((task) => relevantTypes.includes(task.type)) || null
  const activeTask = latestRelevantTask
    && (latestRelevantTask.status === 'queued' || latestRelevantTask.status === 'processing')
    ? latestRelevantTask
    : null
  const failedTask = latestRelevantTask?.status === 'failed' ? latestRelevantTask : null
  const lockedCount = data?.episodes.filter((episode) => episode.locked).length || 0
  const unresolvedCommentCount = data?.episodes.reduce(
    (total, episode) => total + episode.comments.filter((comment) => !comment.resolved).length,
    0,
  ) || 0

  useEffect(() => {
    onSummary({
      novelSaved: Boolean(data?.novel),
      episodeCount: data?.episodes.length || 0,
      lockedCount,
      unresolvedCommentCount,
      assetCount: assets.length,
      storyboardCount: storyboards.filter((storyboard) => storyboard.generatedByAI).length,
      activeTask,
      failedTask,
    })
  }, [activeTask, assets.length, data?.episodes.length, data?.novel, failedTask, lockedCount, onSummary, storyboards, unresolvedCommentCount])

  function addTask(task: TextTask) {
    setData((current) => current ? { ...current, tasks: [task, ...current.tasks] } : current)
  }

  if (loading || !data) {
    return (
      <section className="preproductionLoading">
        <Loader2 className="spin" size={24} />
        <strong>正在读取前期制作数据</strong>
      </section>
    )
  }

  return (
    <section className="preproductionShell">
      {activeTask ? (
        <div className="textTaskBar" role="status">
          <Loader2 className="spin" size={16} />
          <span>
            <strong>{taskProgressLabel(activeTask)}</strong>
            <small>{activeTask.detail?.activeRoutes[0]
              ? `${activeTask.detail.activeRoutes[0].provider} · ${activeTask.detail.activeRoutes[0].model}`
              : activeTask.model} · {activeTask.progress}%</small>
          </span>
          <div className="textTaskProgress"><span style={{ transform: `scaleX(${activeTask.progress / 100})` }} /></div>
        </div>
      ) : failedTask ? (
        <div className="textTaskBar failed" role="alert">
          <CircleAlert size={17} />
          <span><strong>上一次任务未完成</strong><small>{readableTextTaskError(failedTask.error)}</small></span>
        </div>
      ) : null}

      {mode === 'script' ? (
        <ScriptWorkspace
          projectId={projectId!}
          data={data}
          taskRunning={Boolean(activeTask)}
          onData={setData}
          onTask={addTask}
          onNotice={onNotice}
        />
      ) : mode === 'assetPlan' ? (
        <AssetPlanningWorkspace
          projectId={projectId!}
          episodes={data.episodes}
          assets={assets}
          storyboards={storyboards}
          taskRunning={Boolean(activeTask)}
          onTask={addTask}
          onChanged={onWorkspaceChanged}
          onNotice={onNotice}
          onNext={onOpenAssetImages}
        />
      ) : (
        <ShotPlanningWorkspace
          projectId={projectId!}
          episodes={data.episodes}
          storyboards={storyboards}
          taskRunning={Boolean(activeTask)}
          onTask={addTask}
          onChanged={onWorkspaceChanged}
          onNotice={onNotice}
          onNext={onOpenAssetPlan}
          onOpenVideos={onOpenStoryboardVideos}
        />
      )}
    </section>
  )
}

function ScriptWorkspace({
  projectId,
  data,
  taskRunning,
  onData,
  onTask,
  onNotice,
}: {
  projectId: string
  data: PreproductionData
  taskRunning: boolean
  onData: (data: PreproductionData) => void
  onTask: (task: TextTask) => void
  onNotice: (text: string, tone?: NoticeTone) => void
}) {
  const [novelTitle, setNovelTitle] = useState(data.novel?.title || '')
  const [novelContent, setNovelContent] = useState(data.novel?.content || '')
  const [importedFileName, setImportedFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [episodeCount, setEpisodeCount] = useState(data.adaptationSettings.targetEpisodeCount)
  const [episodeMinutes, setEpisodeMinutes] = useState(data.adaptationSettings.episodeMinutes)
  const [novelCollapsed, setNovelCollapsed] = useState(false)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(data.episodes[0]?.id || '')
  const [busy, setBusy] = useState(false)
  const selectedEpisode = data.episodes.find((episode) => episode.id === selectedEpisodeId) || data.episodes[0] || null

  useEffect(() => {
    setNovelTitle(data.novel?.title || '')
    setNovelContent(data.novel?.content || '')
  }, [data.novel?.id, data.novel?.updatedAt])

  useEffect(() => {
    if (data.adaptationSettings.source !== 'task') return
    setEpisodeCount(data.adaptationSettings.targetEpisodeCount)
    setEpisodeMinutes(data.adaptationSettings.episodeMinutes)
  }, [
    data.adaptationSettings.episodeMinutes,
    data.adaptationSettings.source,
    data.adaptationSettings.targetEpisodeCount,
  ])

  useEffect(() => {
    if (!selectedEpisode && data.episodes[0]) setSelectedEpisodeId(data.episodes[0].id)
  }, [data.episodes, selectedEpisode])

  async function saveNovel(showSuccess = true) {
    if (!novelTitle.trim() || novelContent.trim().length < 100) {
      onNotice('请填写作品名称，并粘贴至少 100 个字的小说正文', 'error')
      return null
    }
    try {
      const next = await requestJson<PreproductionData>(`/api/projects/${projectId}/novel`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: novelTitle, content: novelContent }),
      })
      onData(next)
      if (showSuccess) onNotice('小说原文已保存')
      return next
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '小说保存失败', 'error')
      return null
    }
  }

  async function adaptNovel() {
    setBusy(true)
    try {
      const saved = await saveNovel(false)
      if (!saved) return
      const replaceExisting = saved.episodes.length > 0
      if (replaceExisting && !window.confirm('重新改编会替换现有分集剧本和评论。已有分镜不会删除，但会与新剧本脱离。继续吗？')) return
      const payload = await requestJson<{ task: TextTask }>(`/api/projects/${projectId}/adapt-script`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetEpisodeCount: episodeCount, episodeMinutes, replaceExisting }),
      })
      onTask(payload.task)
      onNotice('导演改编任务已提交')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '改编任务提交失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function importTextFile(file: File | undefined) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.txt')) {
      onNotice('请选择 .txt 格式的小说或剧本文件', 'error')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      onNotice('TXT 文件不能超过 5MB', 'error')
      return
    }

    setImporting(true)
    try {
      const content = decodeTextFile(await file.arrayBuffer())
      if (content.length < 100) {
        onNotice('TXT 正文至少需要 100 个字', 'error')
        return
      }
      if (content.length > 500_000) {
        onNotice('当前版本单个项目最多导入 50 万字，请先拆分文件', 'error')
        return
      }
      if (
        novelContent.trim()
        && novelContent.trim() !== content
        && !window.confirm('导入 TXT 会替换当前正文编辑区的内容，继续吗？')
      ) return

      setNovelTitle(titleFromTextFile(file.name))
      setNovelContent(content)
      setImportedFileName(file.name)
      onNotice(`已导入 ${file.name}，共 ${content.length.toLocaleString()} 字，请检查后保存`)
    } catch {
      onNotice('TXT 文件读取失败，请确认文件没有损坏', 'error')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <section className={`scriptWorkspace ${novelCollapsed ? 'novelCollapsed' : ''}`}>
      <aside className={`novelPanel ${novelCollapsed ? 'collapsed' : ''}`} aria-label="小说原文">
        <div className="panelHeading novelPanelHeading">
          {!novelCollapsed ? <span><BookOpenText size={17} /><strong>小说原文</strong></span> : null}
          <span className="novelPanelMeta">
            {!novelCollapsed ? <small>{novelContent.trim().length.toLocaleString()} 字</small> : null}
            <button
              className="iconButton small novelPanelToggle"
              type="button"
              aria-expanded={!novelCollapsed}
              aria-label={novelCollapsed ? '展开小说原文' : '收起小说原文'}
              title={novelCollapsed ? '展开小说原文' : '收起小说原文'}
              onClick={() => setNovelCollapsed((current) => !current)}
            >
              {novelCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </span>
        </div>
        {!novelCollapsed ? <>
        <div className="novelImportBar">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            hidden
            onChange={(event) => void importTextFile(event.target.files?.[0])}
          />
          <button
            className="quietButton"
            type="button"
            disabled={importing || busy || taskRunning}
            onClick={() => fileInputRef.current?.click()}
          >
            {importing ? <Loader2 className="spin" size={16} /> : <FileUp size={16} />}
            {importing ? '读取中' : '导入 TXT'}
          </button>
          <span title={importedFileName || '支持 UTF-8、UTF-16、GBK 编码'}>
            {importedFileName || '小说或剧本 · 最大 50 万字'}
          </span>
        </div>
        <label>
          作品名称
          <input value={novelTitle} maxLength={120} onChange={(event) => setNovelTitle(event.target.value)} placeholder="输入小说名称" />
        </label>
        <label className="novelContentField">
          正文
          <textarea
            data-assistant-target="novel-content"
            value={novelContent}
            onChange={(event) => setNovelContent(event.target.value)}
            placeholder="粘贴小说正文。章节标题、对白引号和段落请尽量保留。"
          />
        </label>
        <button className="quietButton" type="button" disabled={busy} onClick={() => void saveNovel()}>
          <Save size={16} />保存原文
        </button>
        <div className="adaptControls">
          <label>
            目标集数
            <input type="number" min="1" max="60" value={episodeCount} disabled={taskRunning} onChange={(event) => setEpisodeCount(Number(event.target.value))} />
          </label>
          <label>
            每集分钟
            <input type="number" min="0.5" max="10" step="0.5" value={episodeMinutes} disabled={taskRunning} onChange={(event) => setEpisodeMinutes(Number(event.target.value))} />
          </label>
        </div>
        <button
          className="primaryButton"
          data-assistant-target="adapt-script"
          type="button"
          disabled={busy || taskRunning || novelContent.trim().length < 100}
          onClick={() => void adaptNovel()}
        >
          {busy || taskRunning ? <Loader2 className="spin" size={17} /> : <WandSparkles size={17} />}
          {taskRunning ? '导演改编中' : '生成分集剧本'}
        </button>
        <small className="modelFootnote">文本模型：{data.textModel} · {episodeCount} 集通常约 {Math.max(5, Math.ceil(episodeCount * 0.65))}–{Math.max(10, Math.ceil(episodeCount * 1.2))} 分钟，上游繁忙时可能延长</small>
        </> : null}
      </aside>

      <aside className="episodeRail">
        <div className="panelHeading">
          <span><FilePenLine size={17} /><strong>分集</strong></span>
          <small>{data.episodes.filter((episode) => episode.locked).length}/{data.episodes.length} 已锁定</small>
        </div>
        <div className="episodeList">
          {data.episodes.map((episode) => (
            <button
              key={episode.id}
              type="button"
              className={selectedEpisode?.id === episode.id ? 'active' : ''}
              onClick={() => setSelectedEpisodeId(episode.id)}
            >
              <span>{String(episode.episodeNumber).padStart(2, '0')}</span>
              <span><strong>{episode.title}</strong><small>{episode.comments.filter((comment) => !comment.resolved).length} 条待处理评论</small></span>
              {episode.locked ? <Lock size={14} /> : <Unlock size={14} />}
            </button>
          ))}
          {data.episodes.length === 0 ? (
            <div className="railEmpty"><FilePenLine size={28} /><span>生成后在这里逐集审阅</span></div>
          ) : null}
        </div>
      </aside>

      {selectedEpisode ? (
        <ScriptEpisodeEditor
          key={`${selectedEpisode.id}-${selectedEpisode.updatedAt}`}
          projectId={projectId}
          episode={selectedEpisode}
          taskRunning={taskRunning}
          onData={onData}
          onTask={onTask}
          onNotice={onNotice}
        />
      ) : (
        <div className="scriptEmpty"><BookOpenText size={38} /><strong>保存原文后生成分集剧本</strong></div>
      )}
    </section>
  )
}

function ScriptEpisodeEditor({
  projectId,
  episode,
  taskRunning,
  onData,
  onTask,
  onNotice,
}: {
  projectId: string
  episode: ScriptEpisode
  taskRunning: boolean
  onData: (data: PreproductionData) => void
  onTask: (task: TextTask) => void
  onNotice: (text: string, tone?: NoticeTone) => void
}) {
  const [draft, setDraft] = useState({ title: episode.title, logline: episode.logline || '', content: episode.content })
  const [selection, setSelection] = useState({ text: '', start: 0, end: 0 })
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const unresolved = episode.comments.filter((comment) => !comment.resolved)
  const draftDirty = draft.title !== episode.title
    || draft.logline !== (episode.logline || '')
    || draft.content !== episode.content

  async function patchEpisode(patch: Record<string, unknown>, message: string) {
    setBusy(true)
    try {
      const data = await requestJson<PreproductionData>(`/api/script-episodes/${episode.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      onData(data)
      onNotice(message)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '分集保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function addComment() {
    if (!selection.text || !instruction.trim()) return
    setBusy(true)
    try {
      const data = await requestJson<PreproductionData>(`/api/script-episodes/${episode.id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quotedText: selection.text,
          instruction,
          startOffset: selection.start,
          endOffset: selection.end,
        }),
      })
      onData(data)
      setInstruction('')
      setSelection({ text: '', start: 0, end: 0 })
      onNotice('导演评论已添加')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '评论添加失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function deleteComment(commentId: string) {
    try {
      const data = await requestJson<PreproductionData>(`/api/script-comments/${commentId}`, { method: 'DELETE' })
      onData(data)
      onNotice('评论已删除')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '评论删除失败', 'error')
    }
  }

  async function revise() {
    try {
      const payload = await requestJson<{ task: TextTask }>(`/api/script-episodes/${episode.id}/revise`, { method: 'POST' })
      onTask(payload.task)
      onNotice('评论修订任务已提交')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '修订任务提交失败', 'error')
    }
  }

  async function generateEpisodeStoryboards() {
    if (!episode.locked) {
      onNotice('请先锁定本集，再生成分镜', 'error')
      return
    }
    if (draftDirty) {
      onNotice('当前有未保存修改，请先保存并重新锁定本集', 'error')
      return
    }
    const replaceExisting = episode.storyboardCount > 0
    if (replaceExisting && !window.confirm(`第 ${episode.episodeNumber} 集已有分镜。重新生成只会替换本集 AI 分镜及其视频版本，其他集不受影响。继续吗？`)) return

    setBusy(true)
    try {
      const payload = await requestJson<{ task: TextTask }>(`/api/projects/${projectId}/generate-storyboards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeIds: [episode.id], replaceExisting }),
      })
      onTask(payload.task)
      onNotice(`第 ${episode.episodeNumber} 集分镜任务已提交`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '本集分镜任务提交失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="scriptEditorPanel">
        <div className="editorHeader">
          <span><strong>第 {episode.episodeNumber} 集</strong><small>{episode.locked ? '内容已锁定' : '待导演确认'}</small></span>
          <div className="detailActions">
            <button
              className="quietButton"
              type="button"
              disabled={busy || taskRunning}
              onClick={() => void patchEpisode({ ...draft, locked: !episode.locked }, episode.locked ? '本集已解锁' : '本集内容已锁定')}
            >
              {episode.locked ? <Unlock size={16} /> : <Lock size={16} />}{episode.locked ? '解锁' : '锁定本集'}
            </button>
            {episode.locked ? (
              <button
                className="primaryButton compact"
                type="button"
                disabled={busy || taskRunning || draftDirty}
                title={draftDirty ? '先保存修改并重新锁定本集' : episode.storyboardCount > 0 ? '重新生成本集分镜' : '生成本集分镜'}
                onClick={() => void generateEpisodeStoryboards()}
              >
                {busy || taskRunning ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
                {episode.storyboardCount > 0 ? '重做本集分镜' : '生成本集分镜'}
              </button>
            ) : null}
            <button
              className="iconButton"
              title="保存本集"
              type="button"
              disabled={busy}
              onClick={() => void patchEpisode(draft, '分集剧本已保存')}
            >{busy ? <Loader2 className="spin" size={17} /> : <Save size={17} />}</button>
          </div>
        </div>
        <label>
          集名
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label>
          本集核心
          <textarea className="loglineField" value={draft.logline} onChange={(event) => setDraft((current) => ({ ...current, logline: event.target.value }))} rows={2} />
        </label>
        <label className="scriptContentField">
          可拍摄剧本
          <textarea
            value={draft.content}
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
            onSelect={(event) => {
              const target = event.currentTarget
              const text = target.value.slice(target.selectionStart, target.selectionEnd).trim()
              if (text) setSelection({ text, start: target.selectionStart, end: target.selectionEnd })
            }}
          />
        </label>
      </section>

      <aside className="commentPanel">
        <div className="panelHeading">
          <span><MessageSquarePlus size={17} /><strong>导演评论</strong></span>
          <small>{unresolved.length} 待处理</small>
        </div>
        <div className={`selectionQuote ${selection.text ? 'hasSelection' : ''}`}>
          <small>{selection.text ? '已标记文本' : '先在剧本中选中文字'}</small>
          <p>{selection.text || '拖动选择需要修改的句子或段落，再写具体修改意见。'}</p>
        </div>
        <label>
          修改意见
          <textarea
            data-assistant-target="script-comment"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="例如：保留对白不变，把情绪从愤怒改为克制。"
            rows={4}
          />
        </label>
        <button className="quietButton" type="button" disabled={busy || !selection.text || !instruction.trim()} onClick={() => void addComment()}>
          <MessageSquarePlus size={16} />添加评论
        </button>
        <div className="commentList">
          {episode.comments.map((comment) => (
            <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
              <span><strong>{comment.resolved ? '已处理' : '待处理'}</strong><button type="button" title="删除评论" onClick={() => void deleteComment(comment.id)}><Trash2 size={14} /></button></span>
              <blockquote>{comment.quotedText}</blockquote>
              <p>{comment.instruction}</p>
            </article>
          ))}
        </div>
        <button
          className="primaryButton"
          data-assistant-target="revise-script"
          type="button"
          disabled={taskRunning || unresolved.length === 0}
          onClick={() => void revise()}
        >
          {taskRunning ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          按评论修订本集
        </button>
      </aside>
    </>
  )
}

function AssetPlanningWorkspace({
  projectId,
  episodes,
  assets,
  storyboards,
  taskRunning,
  onTask,
  onChanged,
  onNotice,
  onNext,
}: {
  projectId: string
  episodes: ScriptEpisode[]
  assets: PlanningAsset[]
  storyboards: PlanningStoryboard[]
  taskRunning: boolean
  onTask: (task: TextTask) => void
  onChanged: () => Promise<void>
  onNotice: (text: string, tone?: NoticeTone) => void
  onNext: () => void
}) {
  const [filter, setFilter] = useState<AssetType | 'all'>('all')
  const [selectedId, setSelectedId] = useState(assets[0]?.id || '')
  const [deletingId, setDeletingId] = useState('')
  const locked = episodes.length > 0 && episodes.every((episode) => episode.locked)
  const storyboardReadyCount = episodes.filter((episode) => episode.storyboardCount > 0).length
  const storyboardsReady = episodes.length > 0 && storyboardReadyCount === episodes.length
  const sceneConsistency = calculateSceneConsistency(storyboards, assets)
  const locationAssetCount = assets.filter((asset) => asset.type === 'location').length
  const filtered = filter === 'all' ? assets : assets.filter((asset) => asset.type === filter)
  const selected = assets.find((asset) => asset.id === selectedId) || filtered[0] || null

  useEffect(() => {
    if (!selected && filtered[0]) setSelectedId(filtered[0].id)
  }, [filtered, selected])

  async function extractAssets() {
    try {
      const payload = await requestJson<{ task: TextTask }>(`/api/projects/${projectId}/extract-assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshDrafts: true }),
      })
      onTask(payload.task)
      onNotice('资产提取任务已提交，将按已完成分镜锁定角色和场景名称')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '资产提取失败', 'error')
    }
  }

  async function deleteAsset(asset: PlanningAsset) {
    const imageNotice = asset.images.length > 0
      ? `\n该资产已有 ${asset.images.length} 个图片版本，相关图片版本和分镜引用也会移除。`
      : '\n相关分镜引用也会一并移除。'
    if (!window.confirm(`确认删除资产“${asset.name}”？${imageNotice}\n此操作无法撤销。`)) return

    const remaining = filtered.filter((item) => item.id !== asset.id)
    const currentIndex = filtered.findIndex((item) => item.id === asset.id)
    const next = remaining[Math.min(currentIndex, Math.max(0, remaining.length - 1))]
      || assets.find((item) => item.id !== asset.id)
      || null
    setDeletingId(asset.id)
    try {
      await requestJson(`/api/assets/${asset.id}`, { method: 'DELETE' })
      setSelectedId(next?.id || '')
      await onChanged()
      onNotice(`资产“${asset.name}”已删除`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '资产删除失败', 'error')
    } finally {
      setDeletingId('')
    }
  }

  return (
    <section className="assetPlanningWorkspace">
      <aside className="planningRail">
        <div className="panelHeading"><span><Sparkles size={17} /><strong>资产规划</strong></span><small>{assets.length} 项</small></div>
        <div className="planningStatus">
          {locked && storyboardsReady ? <Check size={17} /> : <CircleAlert size={17} />}
          <span><strong>{storyboardsReady ? '分镜已完成' : '分镜尚未完成'}</strong><small>{storyboardReadyCount}/{episodes.length} 集已有分镜</small></span>
        </div>
        <div
          className={`planningStatus ${locationAssetCount > 0 && !sceneConsistency.exact ? 'sceneMismatch' : ''}`}
          title={sceneConsistency.missingNames.length > 0 ? `尚未匹配：${sceneConsistency.missingNames.join('、')}` : undefined}
        >
          {sceneConsistency.exact ? <Check size={17} /> : <CircleAlert size={17} />}
          <span>
            <strong>{sceneConsistency.exact
              ? '场景名称逐字一致'
              : sceneConsistency.total === 0
                ? '分镜地点待修正'
                : locationAssetCount === 0 ? '场景资产待提取' : '场景名称尚未完全一致'}</strong>
            <small>{sceneConsistency.matched}/{sceneConsistency.total} 个分镜标准场景已匹配</small>
          </span>
        </div>
        <button
          className="primaryButton"
          data-assistant-target="extract-assets"
          type="button"
          disabled={!locked || !storyboardsReady || taskRunning}
          onClick={() => void extractAssets()}
        >
          {taskRunning ? <Loader2 className="spin" size={17} /> : <WandSparkles size={17} />}
          {assets.length ? '按分镜重新提取' : '从分镜提取资产'}
        </button>
        <div className="planningFilters">
          {(['all', 'character', 'location', 'prop'] as const).map((type) => (
            <button key={type} type="button" className={filter === type ? 'active' : ''} onClick={() => setFilter(type)}>
              {type === 'all' ? <ImageIcon size={15} /> : <TypeIcon type={type} />}
              <span>{type === 'all' ? '全部资产' : typeLabels[type]}</span>
              <b>{type === 'all' ? assets.length : assets.filter((asset) => asset.type === type).length}</b>
            </button>
          ))}
        </div>
        {assets.length > 0 && sceneConsistency.exact ? (
          <button className="quietButton planningNext" type="button" onClick={onNext}>
            进入资产生图<ChevronRight size={16} />
          </button>
        ) : null}
      </aside>

      <section className="planningAssetList">
        <div className="panelHeading"><span><strong>{filter === 'all' ? '全部资产草稿' : `${typeLabels[filter]}草稿`}</strong></span><small>此步骤不会生成图片</small></div>
        {filtered.map((asset) => (
          <button key={asset.id} type="button" className={selected?.id === asset.id ? 'active' : ''} onClick={() => setSelectedId(asset.id)}>
            <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
            <span><strong>{asset.name}</strong><small>{asset.tags.slice(0, 3).join(' · ') || '待补充标签'}</small></span>
            {asset.images.length > 0 ? <ImageIcon size={15} /> : <FilePenLine size={15} />}
          </button>
        ))}
        {filtered.length === 0 ? <div className="planningEmpty"><ImageIcon size={34} /><strong>尚未提取资产草稿</strong></div> : null}
      </section>

      <aside className="planningInspector">
        {selected ? (
          <AssetPromptEditor
            key={`${selected.id}-${selected.prompt?.length || 0}`}
            asset={selected}
            deleting={deletingId === selected.id}
            onChanged={onChanged}
            onNotice={onNotice}
            onDelete={deleteAsset}
          />
        ) : (
          <div className="planningEmpty"><FilePenLine size={34} /><strong>选择资产查看提示词</strong></div>
        )}
      </aside>
    </section>
  )
}

function AssetPromptEditor({
  asset,
  deleting,
  onChanged,
  onNotice,
  onDelete,
}: {
  asset: PlanningAsset
  deleting: boolean
  onChanged: () => Promise<void>
  onNotice: (text: string, tone?: NoticeTone) => void
  onDelete: (asset: PlanningAsset) => Promise<void>
}) {
  const [draft, setDraft] = useState({
    name: asset.name,
    type: asset.type,
    tags: asset.tags.join('，'),
    description: asset.description,
    prompt: asset.prompt || '',
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await requestJson(`/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          tags: draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        }),
      })
      await onChanged()
      onNotice('资产提示词已保存')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '资产保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="assetPromptEditor">
      <div className="editorHeader">
        <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
        <div className="detailActions">
          <button className="iconButton danger" type="button" title="删除所选资产" disabled={saving || deleting} onClick={() => void onDelete(asset)}>
            {deleting ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
          </button>
          <button className="iconButton" type="button" title="保存资产提示词" disabled={saving || deleting} onClick={() => void save()}>
            {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
          </button>
        </div>
      </div>
      <label>名称<input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
      <div className="twoFields">
        <label>类型<select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as AssetType }))}><option value="character">角色</option><option value="location">场景</option><option value="prop">道具</option></select></label>
        <label>标签<input value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} /></label>
      </div>
      <label>设定摘要<textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} rows={5} /></label>
      <label className="planningPromptField">
        完整生图提示词
        <textarea data-assistant-target="asset-plan-prompt" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} />
      </label>
      <div className="promptChecks">
        {asset.type === 'character' ? <span><Check size={14} />三视图 · 面部 · 配色 · 局部 · 比例</span> : null}
        {asset.type === 'location' ? <span><Check size={14} />无人纯场景 · 四视图 · 摄影参数</span> : null}
        {asset.type === 'prop' ? <span><Check size={14} />材质纹理 · 多角度 · 尺寸参照</span> : null}
      </div>
    </div>
  )
}

function ShotPlanningWorkspace({
  projectId,
  episodes,
  storyboards,
  taskRunning,
  onTask,
  onChanged,
  onNotice,
  onNext,
  onOpenVideos,
}: {
  projectId: string
  episodes: ScriptEpisode[]
  storyboards: PlanningStoryboard[]
  taskRunning: boolean
  onTask: (task: TextTask) => void
  onChanged: () => Promise<void>
  onNotice: (text: string, tone?: NoticeTone) => void
  onNext: () => void
  onOpenVideos: () => void
}) {
  const [episodeId, setEpisodeId] = useState(episodes[0]?.id || '')
  const episodeShots = storyboards.filter((storyboard) => storyboard.episodeId === episodeId)
  const [selectedId, setSelectedId] = useState(episodeShots[0]?.id || '')
  const selected = storyboards.find((storyboard) => storyboard.id === selectedId) || episodeShots[0] || null
  const selectedEpisode = episodes.find((episode) => episode.id === episodeId) || null
  const lockedEpisodes = episodes.filter((episode) => episode.locked)
  const selectedGeneratedCount = episodeShots.filter((storyboard) => storyboard.generatedByAI).length
  const missingLockedEpisodes = lockedEpisodes.filter((episode) => !storyboards.some(
    (storyboard) => storyboard.episodeId === episode.id && storyboard.generatedByAI,
  ))
  const [promptPreview, setPromptPreview] = useState<StoryboardPromptPreview | null>(null)
  const [promptPreviewVisible, setPromptPreviewVisible] = useState(false)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState('')

  useEffect(() => {
    const first = storyboards.find((storyboard) => storyboard.episodeId === episodeId)
    if (!selected || selected.episodeId !== episodeId) setSelectedId(first?.id || '')
  }, [episodeId, selected, storyboards])

  async function loadPromptPreview(targetEpisodeId = episodeId) {
    if (!targetEpisodeId) return
    setPromptPreviewVisible(true)
    setPromptLoading(true)
    setPromptError('')
    try {
      const preview = await requestJson<StoryboardPromptPreview>(
        `/api/projects/${projectId}/storyboard-prompt?episodeId=${encodeURIComponent(targetEpisodeId)}`,
      )
      setPromptPreview(preview)
    } catch (error) {
      setPromptPreview(null)
      setPromptError(error instanceof Error ? error.message : '读取分镜提示词失败')
    } finally {
      setPromptLoading(false)
    }
  }

  async function generate(targetEpisodes: ScriptEpisode[], replaceExisting = false) {
    if (targetEpisodes.length === 0) {
      onNotice('请先锁定至少一集剧本', 'error')
      return
    }
    if (replaceExisting) {
      const episodeLabel = targetEpisodes.map((episode) => `第 ${episode.episodeNumber} 集`).join('、')
      if (!window.confirm(`${episodeLabel}已有 AI 分镜。重新生成只替换所选分集及其视频版本，其他集不受影响。继续吗？`)) return
    }
    try {
      const payload = await requestJson<{ task: TextTask }>(`/api/projects/${projectId}/generate-storyboards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          episodeIds: targetEpisodes.map((episode) => episode.id),
          replaceExisting,
        }),
      })
      onTask(payload.task)
      await onChanged()
      onNotice(`${targetEpisodes.map((episode) => `第 ${episode.episodeNumber} 集`).join('、')}分镜任务已提交`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '分镜拆解失败', 'error')
    }
  }

  return (
    <section className="shotPlanningWorkspace">
      <aside className="shotEpisodeRail">
        <div className="panelHeading"><span><BookOpenText size={17} /><strong>分集</strong></span><small>{episodes.length}</small></div>
        <div className="shotEpisodeList">
          {episodes.map((episode) => {
            const count = storyboards.filter((storyboard) => storyboard.episodeId === episode.id).length
            return (
              <button
                key={episode.id}
                type="button"
                className={episodeId === episode.id ? 'active' : ''}
                onClick={() => {
                  setEpisodeId(episode.id)
                  if (promptPreviewVisible) void loadPromptPreview(episode.id)
                }}
              >
                <span>{String(episode.episodeNumber).padStart(2, '0')}</span>
                <span><strong>{episode.title}</strong><small>{count} 个镜头 · {episode.locked ? '已锁定' : '待锁定'}</small></span>
                {count > 0 ? <Check size={14} aria-label="已有分镜" /> : episode.locked ? <Lock size={14} aria-label="已锁定" /> : <Unlock size={14} aria-label="待锁定" />}
              </button>
            )
          })}
        </div>
        <div className="shotGenerationControls">
          <button className="quietButton" type="button" disabled={!episodeId || promptLoading} onClick={() => void loadPromptPreview()}>
            {promptLoading ? <Loader2 className="spin" size={16} /> : <Eye size={16} />}
            查看本集实际提示词
          </button>
          <button
            className="primaryButton"
            data-assistant-target="generate-storyboards"
            type="button"
            disabled={!selectedEpisode?.locked || taskRunning}
            onClick={() => selectedEpisode && void generate([selectedEpisode], selectedGeneratedCount > 0)}
          >
            {taskRunning ? <Loader2 className="spin" size={17} /> : selectedEpisode?.locked ? <ListVideo size={17} /> : <Lock size={17} />}
            {taskRunning
              ? '导演拆解中'
              : selectedGeneratedCount > 0
                ? '重新生成本集分镜'
                : '生成本集分镜'}
          </button>
          {missingLockedEpisodes.length > 1 ? (
            <button
              className="quietButton"
              type="button"
              disabled={taskRunning}
              onClick={() => void generate(missingLockedEpisodes)}
            >
              <ListVideo size={16} />生成其余 {missingLockedEpisodes.length} 集
            </button>
          ) : null}
          <small className={selectedEpisode?.locked ? 'shotGenerationHint ready' : 'shotGenerationHint'}>
            {!selectedEpisode
              ? '请选择一集剧本'
              : !selectedEpisode.locked
                ? `第 ${selectedEpisode.episodeNumber} 集尚未锁定，请先回到剧本改编确认内容`
                : selectedGeneratedCount > 0
                  ? `第 ${selectedEpisode.episodeNumber} 集已有 ${selectedGeneratedCount} 个 AI 分镜，可单独重新生成`
                  : `第 ${selectedEpisode.episodeNumber} 集已锁定，可以立即生成，不受其他集影响`}
          </small>
        </div>
        {storyboards.length > 0 ? <button className="quietButton" type="button" onClick={onNext}>进入资产规划<ChevronRight size={16} /></button> : null}
      </aside>

      <section className="shotListPanel">
        <div className="panelHeading"><span><Film size={17} /><strong>镜头列表</strong></span><small>{episodeShots.length}</small></div>
        <div className="shotList">
          {episodeShots.map((storyboard) => (
            <button key={storyboard.id} type="button" className={selected?.id === storyboard.id ? 'active' : ''} onClick={() => setSelectedId(storyboard.id)}>
              <span>{String(storyboard.episodeSceneNumber || storyboard.sceneNumber).padStart(2, '0')}</span>
              <span><strong>{storyboard.title}</strong><small>{storyboard.duration}s · {storyboard.assets.length > 0 ? `${storyboard.assets.length} 项已绑定资产` : '待资产规划'}</small></span>
              {storyboard.videos.length > 0 ? <Film size={14} /> : null}
            </button>
          ))}
          {episodeShots.length === 0 ? <div className="planningEmpty"><ListVideo size={34} /><strong>本集尚未拆分镜</strong></div> : null}
        </div>
      </section>

      <section className="shotInspector">
        {promptPreviewVisible ? (
          <StoryboardPromptPreviewPanel
            preview={promptPreview}
            loading={promptLoading}
            error={promptError}
            onClose={() => setPromptPreviewVisible(false)}
            onReload={() => void loadPromptPreview()}
            onNotice={onNotice}
          />
        ) : selected ? (
          <StoryboardPromptEditor key={`${selected.id}-${selected.videoPrompt?.length || 0}`} storyboard={selected} onChanged={onChanged} onNotice={onNotice} onOpenVideos={onOpenVideos} />
        ) : (
          <div className="planningEmpty">
            <Film size={36} />
            <strong>生成后逐镜审阅内容</strong>
            <button className="quietButton" type="button" onClick={() => void loadPromptPreview()}><Eye size={16} />先查看提交模板</button>
          </div>
        )}
      </section>
    </section>
  )
}

function StoryboardPromptPreviewPanel({
  preview,
  loading,
  error,
  onClose,
  onReload,
  onNotice,
}: {
  preview: StoryboardPromptPreview | null
  loading: boolean
  error: string
  onClose: () => void
  onReload: () => void
  onNotice: (text: string, tone?: NoticeTone) => void
}) {
  async function copyPrompt() {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(`${preview.system}\n\n${preview.prompt}`)
      onNotice('本集分镜提示词已复制')
    } catch {
      onNotice('浏览器未允许复制，请直接在提示词区域中选择文本', 'error')
    }
  }

  return (
    <div className="storyboardTemplatePreview">
      <div className="editorHeader">
        <span>
          <strong>本集实际分镜提示词</strong>
          <small>{preview ? `第 ${preview.episode.episodeNumber} 集 · ${preview.episode.title}` : '读取提交内容'}</small>
        </span>
        <div className="promptPreviewActions">
          <button className="iconButton" type="button" title="重新读取" disabled={loading} onClick={onReload}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button>
          <button className="iconButton" type="button" title="复制完整提示词" disabled={!preview} onClick={() => void copyPrompt()}><ClipboardCopy size={17} /></button>
          <button className="iconButton" type="button" title="关闭提示词预览" onClick={onClose}><X size={17} /></button>
        </div>
      </div>
      {loading && !preview ? <div className="planningEmpty compact"><Loader2 className="spin" size={30} /><strong>正在组合剧本与场次设定</strong></div> : null}
      {error ? <p className="errorText">{error}</p> : null}
      {preview ? (
        <>
          <div className="promptPreviewMeta">
            <span><strong>API</strong>{preview.provider}</span>
            <span><strong>模型</strong>{preview.model}</span>
            <span><strong>{preview.totalAssetCount > 0 ? '资产' : '场景来源'}</strong>{preview.totalAssetCount > 0 ? `${preview.relatedAssetCount}/${preview.totalAssetCount} 项相关` : '已锁定剧本场次'}</span>
            <span><strong>调度</strong>最多 {preview.parallelism} 集并行，每集内部串行</span>
          </div>
          <label>导演系统指令<textarea readOnly value={preview.system} rows={3} /></label>
          <label className="promptPreviewField">发送给模型的完整内容<textarea readOnly value={preview.prompt} /></label>
        </>
      ) : null}
    </div>
  )
}

function StoryboardPromptEditor({
  storyboard,
  onChanged,
  onNotice,
  onOpenVideos,
}: {
  storyboard: PlanningStoryboard
  onChanged: () => Promise<void>
  onNotice: (text: string, tone?: NoticeTone) => void
  onOpenVideos: () => void
}) {
  const [draft, setDraft] = useState({
    title: storyboard.title,
    notes: storyboard.notes || '',
    imagePrompt: storyboard.imagePrompt || '',
    videoPrompt: storyboard.videoPrompt || '',
    duration: storyboard.duration,
  })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await requestJson(`/api/storyboards/${storyboard.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      await onChanged()
      onNotice('分镜文本已保存，资产识别已刷新')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '分镜保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="storyboardPromptEditor">
      <div className="editorHeader">
        <span><strong>分镜 {String(storyboard.episodeSceneNumber || storyboard.sceneNumber).padStart(2, '0')}</strong><small>{storyboard.duration}s · {storyboard.aspectRatio}</small></span>
        <button className="iconButton" type="button" title="保存分镜文本" disabled={saving} onClick={() => void save()}>{saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}</button>
      </div>
      <label>标题<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
      <div className="twoFields">
        <label>连续性备注<input value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
        <label>时长（秒）<input type="number" min="4" max="15" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: Number(event.target.value) }))} /></label>
      </div>
      <label>首帧提示词<textarea value={draft.imagePrompt} onChange={(event) => setDraft((current) => ({ ...current, imagePrompt: event.target.value }))} rows={4} /></label>
      <label className="shotPromptField">视频分镜提示词<textarea data-assistant-target="shot-plan-prompt" value={draft.videoPrompt} onChange={(event) => setDraft((current) => ({ ...current, videoPrompt: event.target.value }))} /></label>
      <div className="recognizedAssets">
        <div className="sectionLabel"><strong>已识别人物与场景</strong><span>{storyboard.assets.length}</span></div>
        <div>
          {storyboard.assets.map((asset) => (
            <span key={asset.id} className={`${asset.type} ${asset.hasSelectedImage ? '' : 'missing'}`}><TypeIcon type={asset.type} size={13} />{asset.name}</span>
          ))}
          {storyboard.assets.length === 0 ? <small>保存后会按剧本中的人物和场景重新识别</small> : null}
        </div>
      </div>
      {storyboard.videos.length > 0 ? <button className="quietButton" type="button" onClick={onOpenVideos}><Film size={16} />查看视频版本</button> : null}
    </div>
  )
}

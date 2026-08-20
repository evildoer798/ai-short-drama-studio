'use client'

import { DragEvent, FormEvent, SyntheticEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  BookOpenText,
  Box,
  Boxes,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Download,
  Film,
  GripVertical,
  House,
  History,
  ImageIcon,
  Layers3,
  ListVideo,
  Loader2,
  LogOut,
  MapPinned,
  PackageOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
} from 'lucide-react'
import { readableVideoTaskError } from '@/lib/video-prompt-safety'
import {
  previousStoryboardInSequence,
  shouldUsePreviousTailFrame,
} from '@/lib/storyboard-continuity'
import { captureVideoTailFrame } from '@/lib/video-tail-frame'
import { splitAssetHighlights } from '@/lib/asset-highlights'
import {
  activeStoryboardAssetMention,
  insertStoryboardAssetMention,
  removeStoryboardAssetMention,
  replaceActiveStoryboardAssetMention,
  type ActiveStoryboardAssetMention,
} from '@/lib/storyboard-asset-mentions'
import { readableTextTaskError } from '@/lib/text-task-error'
import {
  estimateVideoGenerationSeconds,
  fitVideoGroupDurations,
  normalizeVideoDuration,
  videoDurationOptions,
} from '@/lib/video-batch'
import { DEFAULT_VIDEO_MODEL_ID, DEFAULT_VIDEO_RESOLUTION } from '@/lib/video-defaults'
import { PreproductionWorkspace, type PreproductionSummary } from './PreproductionWorkspace'
import { CharacterPerformanceProfilesPanel, ShotPerformancePanel } from './ActingDirectorPanels'
import { VideoModelSelectOptions } from './VideoModelSelectOptions'
import {
  planVideoReferences,
  REFERENCE_MONTAGE_IMAGES_PER_VIDEO,
} from '@/lib/video-reference-plan'

type AssetType = 'character' | 'location' | 'prop'
type VisualStyle = 'photorealistic' | 'overseas_live_action' | 'anime_2d' | 'anime_3d' | 'chibi'
type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
type WorkspaceView = 'script' | 'assetPlan' | 'shotPlan' | 'assets' | 'storyboards' | 'videos'
type VideoGenerationPhase = 'saving' | 'capturing_tail' | 'submitting' | 'queued'

type StyleOption = {
  id: VisualStyle
  label: string
  shortLabel: string
  description: string
  swatch: [string, string, string]
}

type ProjectOption = {
  id: string
  name: string
  workspaceName: string
  visualStyle: VisualStyle
  customStylePrompt: string | null
}

type AssetImage = {
  id: string
  mediaId: string
  url: string
  prompt: string
  variant: number
  isSelected: boolean
  createdAt: string
}

type AssetRecord = {
  id: string
  projectId: string
  type: AssetType
  name: string
  description: string
  tags: string[]
  prompt: string | null
  videoPrompt: string | null
  selectedImageId: string | null
  selectedImageUrl: string | null
  latestTask: TaskRecord | null
  updatedAt: string
  createdBy: {
    id: string
    name: string
    email: string
  }
  images: AssetImage[]
}

type TaskRecord = {
  id: string
  type?: 'script_adaptation' | 'script_revision' | 'asset_extraction' | 'storyboard_generation' | 'image_generation' | 'video_generation' | 'project_render'
  model?: string
  status: TaskStatus
  progress?: number
  error?: string | null
  assetId?: string | null
  storyboardId?: string | null
  sourceStoryboardIds?: string[]
  projectId?: string | null
  createdAt?: string
}

type VideoResolution = '480p' | '720p' | '1080p'
type StoryboardAspectRatio = '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3'

type VideoModelOption = {
  id: string
  label: string
  family: 'Grok' | 'Seedance' | 'Sora' | 'HappyHouse'
  description: string
  priceLabel: string
  priceMode: 'flat' | 'per_second'
  priceSource: 'live' | 'reference'
  unitPrice: number
  startingAt: boolean
  minimumDuration: number
  maximumDuration: number
  supportedDurations: number[] | null
  maximumReferenceImages: number
  maximumReferenceVideos?: number
  maximumPromptCharacters: number
  supportsAudio: boolean
  resolutions: VideoResolution[]
  defaultResolution: VideoResolution
  aspectRatios: StoryboardAspectRatio[]
  supportsHumanFaceReferences: boolean
  available: boolean | null
}

type VideoModelsResponse = {
  models: VideoModelOption[]
  defaultModel: string
  warning: string | null
  priceNotice: string
  refreshedAt: string
  priceUpdatedAt: string | null
  refreshIntervalSeconds: number
  stale: boolean
}

type StoryboardAssetReference = {
  id: string
  name: string
  type: AssetType
  referenceOrder: number
  matchReason: string
  isManual?: boolean
  highlightTerms: string[]
  hasSelectedImage: boolean
  imageUrl: string | null
}

type StoryboardVideo = {
  id: string
  mediaId: string
  tailFrameMediaId: string | null
  tailFrameUrl: string | null
  name: string
  url: string
  downloadUrl: string
  prompt: string
  model: string
  duration: number
  sourceStoryboardIds: string[]
  sourceStoryboardNumbers?: number[]
  aspectRatio: string
  resolution: VideoResolution
  isSelected: boolean
  createdAt: string
}

type VideoLibraryEntry = {
  project: { id: string; name: string }
  storyboard: Pick<StoryboardRecord,
    'id' | 'projectId' | 'episodeSceneNumber' | 'episode' | 'title' | 'sceneNumber'>
  video: StoryboardVideo
}

type StoryboardRecord = {
  id: string
  projectId: string
  episodeId: string | null
  episodeSceneNumber: number | null
  generatedByAI: boolean
  episode: { id: string; episodeNumber: number; title: string } | null
  title: string
  sceneNumber: number
  notes: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  continuityIn: unknown | null
  continuityOut: unknown | null
  duration: number
  aspectRatio: StoryboardAspectRatio
  generateAudio: boolean
  selectedVideoId: string | null
  updatedAt: string
  assets: StoryboardAssetReference[]
  videos: StoryboardVideo[]
  latestTask: TaskRecord | null
}

type StoryboardRevisionRecord = {
  id: string
  source: string
  reason: string | null
  contentHash: string
  createdAt: string
  title: string
  duration: number
  promptPreview: string
}

type WorkspaceData = {
  projects: ProjectOption[]
  activeProjectId: string | null
  assets: AssetRecord[]
  storyboards: StoryboardRecord[]
  videoLibrary: VideoLibraryEntry[]
  styleOptions: StyleOption[]
}

type User = {
  id: string
  email: string
  name: string
}

type Toast = {
  tone: 'success' | 'error'
  text: string
}

type JenniferAction =
  | 'focus_novel'
  | 'focus_script_generation'
  | 'open_script_review'
  | 'open_asset_plan'
  | 'focus_asset_extraction'
  | 'open_shot_plan'
  | 'focus_storyboard_generation'
  | 'open_asset_images'
  | 'focus_asset_form'
  | 'focus_image_generation'
  | 'open_storyboards'
  | 'focus_storyboard_prompt'
  | 'focus_video_generation'
  | 'review_video'
  | 'open_video_library'

type JenniferGuidance = {
  key: string
  title: string
  detail: string
  warnings: string[]
  action?: {
    id: JenniferAction
    label: string
    assetId?: string
    assetType?: AssetType
    storyboardId?: string
  }
}

const typeLabels: Record<AssetType | 'all', string> = {
  all: '全部',
  character: '角色',
  location: '场景',
  prop: '道具',
}

const typeOptions: AssetType[] = ['character', 'location', 'prop']

const assetPromptPlaceholders: Record<AssetType, string> = {
  character: '写下姓名、年龄、外形、发型、服装、气质，以及三视图或构图要求…',
  location: '写下场景名称、空间布局、时间、天气、光线、陈设和镜头视角…',
  prop: '写下道具名称、造型、材质、颜色、尺寸、使用痕迹和展示角度…',
}

function TypeIcon({ type, size = 16 }: { type: AssetType, size?: number }) {
  if (type === 'character') return <UserRound size={size} />
  if (type === 'location') return <MapPinned size={size} />
  return <Box size={size} />
}

function parseTags(value: string) {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function imageFor(asset: AssetRecord) {
  return asset.selectedImageUrl || asset.images[0]?.url || null
}

function assetImageFor(asset: AssetRecord) {
  return asset.images.find((image) => image.id === asset.selectedImageId) || asset.images[0] || null
}

function videoPriceEstimate(model: VideoModelOption, duration: number) {
  const amount = videoPriceAmount(model, duration)
  return `本次预计 ¥${amount.toFixed(2)}${model.startingAt ? ' 起' : ''}`
}

function videoPriceAmount(model: VideoModelOption, duration: number) {
  return model.priceMode === 'per_second' ? model.unitPrice * duration : model.unitPrice
}

function usesLiveActionFaces(visualStyle: VisualStyle) {
  return visualStyle === 'photorealistic' || visualStyle === 'overseas_live_action'
}

function prioritizeVideoReferenceAssets(
  candidates: StoryboardAssetReference[],
  limit: number,
  omitLocations = false,
) {
  const maximum = Math.max(0, Math.floor(limit))
  if (maximum === 0) return []
  const ordered = [...candidates].sort((left, right) => left.referenceOrder - right.referenceOrder)
  const characters = ordered.filter((asset) => asset.type === 'character')
  const locations = omitLocations ? [] : ordered.filter((asset) => asset.type === 'location')
  const props = ordered.filter((asset) => asset.type === 'prop')
  if (maximum === 1) return (characters.length > 0 ? characters : props.length > 0 ? props : locations).slice(0, 1)
  if (characters.length >= maximum) return characters.slice(0, maximum)

  const remainingAfterCharacters = maximum - characters.length
  const selectedProps = props.slice(0, remainingAfterCharacters)
  const selected = [
    ...characters,
    ...selectedProps,
    ...locations.slice(0, remainingAfterCharacters - selectedProps.length),
  ]
  if (selected.length < maximum) {
    const selectedIds = new Set(selected.map((asset) => asset.id))
    selected.push(...ordered.filter((asset) => !selectedIds.has(asset.id)).slice(0, maximum - selected.length))
  }
  return selected.slice(0, maximum)
}

function sourceStoryboardIdsForTask(task: TaskRecord) {
  return task.sourceStoryboardIds?.length
    ? task.sourceStoryboardIds
    : task.storyboardId ? [task.storyboardId] : []
}

function preferredStoryboardId(storyboards: StoryboardRecord[]) {
  return storyboards.find((storyboard) => Boolean(storyboard.episodeId))?.id
    || storyboards[0]?.id
    || ''
}

function formatMinuteRange(minimumSeconds: number, maximumSeconds: number) {
  const minimum = Math.max(1, Math.ceil(minimumSeconds / 60))
  const maximum = Math.max(minimum, Math.ceil(maximumSeconds / 60))
  return minimum === maximum ? `约 ${minimum} 分钟` : `约 ${minimum}–${maximum} 分钟`
}

function formatModelRefreshTime(value: string | null) {
  if (!value) return '尚未同步'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '尚未同步'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function directVideoUrl(source: string) {
  return `${source}${source.includes('?') ? '&' : '?'}direct=1`
}

function BufferedVideo({
  source,
  playsInline = false,
}: {
  source: string
  playsInline?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const objectUrlRef = useRef<string | null>(null)
  const directReadyRef = useRef(false)
  const loadingRef = useRef(false)
  const fallbackRef = useRef(false)
  const resumeAtRef = useRef(0)
  const [playbackSource, setPlaybackSource] = useState(source)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    directReadyRef.current = false
    loadingRef.current = false
    fallbackRef.current = false
    setLoading(false)
    setPlaybackSource(source)
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [source])

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  async function prepareDirectPlayback(event: SyntheticEvent<HTMLVideoElement>) {
    if (directReadyRef.current || loadingRef.current || fallbackRef.current) return
    const video = event.currentTarget
    resumeAtRef.current = video.currentTime
    video.pause()
    loadingRef.current = true
    setLoading(true)

    try {
      const response = await fetch(directVideoUrl(source), {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`VIDEO_BUFFER_HTTP_${response.status}`)
      const objectUrl = URL.createObjectURL(await response.blob())
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = objectUrl
      directReadyRef.current = true
      setPlaybackSource(objectUrl)
    } catch {
      fallbackRef.current = true
      window.requestAnimationFrame(() => void video.play())
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  function resumeDirectPlayback() {
    if (!directReadyRef.current || !videoRef.current) return
    videoRef.current.currentTime = Math.min(resumeAtRef.current, videoRef.current.duration || 0)
    void videoRef.current.play()
  }

  return (
    <>
      <video
        ref={videoRef}
        src={playbackSource}
        controls
        playsInline={playsInline}
        preload="metadata"
        onPlay={(event) => void prepareDirectPlayback(event)}
        onLoadedMetadata={resumeDirectPlayback}
      />
      {loading ? (
        <div className="videoBufferingOverlay" aria-live="polite">
          <Loader2 className="spin" size={20} />
          <span>正在加载视频</span>
        </div>
      ) : null}
    </>
  )
}

function HighlightedStoryboardPrompt({
  value,
  assets,
  availableAssets,
  onChange,
  onSelectAsset,
}: {
  value: string
  assets: StoryboardAssetReference[]
  availableAssets: AssetRecord[]
  onChange: (value: string) => void
  onSelectAsset: (assetId: string, videoPrompt: string) => void
}) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<ActiveStoryboardAssetMention | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const linkedAssetIds = useMemo(() => new Set(assets.map((asset) => asset.id)), [assets])
  const candidates = useMemo(() => {
    const query = mention?.query.toLocaleLowerCase() || ''
    const typeOrder: Record<AssetType, number> = { character: 0, location: 1, prop: 2 }
    return availableAssets
      .filter((asset) => asset.type === 'character' || asset.type === 'location' || asset.type === 'prop')
      .filter((asset) => !query || [asset.name, asset.description, ...asset.tags]
        .some((text) => text.toLocaleLowerCase().includes(query)))
      .sort((left, right) => {
        const leftLinked = linkedAssetIds.has(left.id) ? 0 : 1
        const rightLinked = linkedAssetIds.has(right.id) ? 0 : 1
        if (leftLinked !== rightLinked) return leftLinked - rightLinked
        const leftStarts = query && left.name.toLocaleLowerCase().startsWith(query) ? 0 : 1
        const rightStarts = query && right.name.toLocaleLowerCase().startsWith(query) ? 0 : 1
        if (leftStarts !== rightStarts) return leftStarts - rightStarts
        return typeOrder[left.type] - typeOrder[right.type] || left.name.localeCompare(right.name, 'zh-CN')
      })
      .slice(0, 8)
  }, [availableAssets, linkedAssetIds, mention?.query])

  function updateMention(input: HTMLTextAreaElement) {
    const next = input.selectionStart === input.selectionEnd
      ? activeStoryboardAssetMention(input.value, input.selectionStart)
      : null
    setMention(next)
    setActiveIndex(0)
  }

  function renderSegments(text: string, keyPrefix: string) {
    return splitAssetHighlights(text, assets).map((segment, index) => segment.assetId ? (
      <mark
        data-asset-type={segment.assetType}
        key={`${keyPrefix}-${segment.assetId}-${index}`}
      >{segment.text}</mark>
    ) : <span key={`${keyPrefix}-text-${index}`}>{segment.text}</span>)
  }

  function updateMenuPosition() {
    if (!mention || !markerRef.current) {
      setMenuPosition(null)
      return
    }
    const marker = markerRef.current.getBoundingClientRect()
    const width = Math.min(360, Math.max(280, window.innerWidth - 24))
    const estimatedHeight = Math.min(330, 76 + Math.max(1, candidates.length) * 58)
    const opensBelow = window.innerHeight - marker.bottom >= estimatedHeight + 12
    setMenuPosition({
      left: Math.max(12, Math.min(marker.left, window.innerWidth - width - 12)),
      top: opensBelow ? marker.bottom + 6 : Math.max(12, marker.top - estimatedHeight - 6),
      width,
    })
  }

  useLayoutEffect(() => {
    updateMenuPosition()
  }, [mention?.start, mention?.end, mention?.query, candidates.length, value])

  useEffect(() => {
    if (!mention) return
    const reposition = () => updateMenuPosition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [mention, candidates.length])

  function selectAsset(asset: AssetRecord) {
    if (!mention) return
    const result = replaceActiveStoryboardAssetMention({
      prompt: value,
      mention,
      assetName: asset.name,
    })
    onChange(result.prompt)
    setMention(null)
    setMenuPosition(null)
    onSelectAsset(asset.id, result.prompt)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(result.cursor, result.cursor)
    })
  }

  const menu = mention && menuPosition && typeof document !== 'undefined'
    ? createPortal((
      <div
        id="asset-mention-options"
        className="assetMentionPopover"
        role="listbox"
        aria-label="可引用的项目资产"
        style={menuPosition}
      >
        <div className="assetMentionPopoverHeader">
          <span><strong>@ 引用项目资产</strong><small>{mention.query ? `搜索“${mention.query}”` : '输入名称继续筛选'}</small></span>
          <span>{candidates.length} 项</span>
        </div>
        {candidates.length > 0 ? (
          <div className="assetMentionOptions">
            {candidates.map((asset, index) => {
              const preview = imageFor(asset)
              const linked = linkedAssetIds.has(asset.id)
              return (
                <button
                  id={`asset-mention-option-${asset.id}`}
                  className={index === activeIndex ? 'active' : ''}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  key={asset.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectAsset(asset)}
                >
                  <span className="assetMentionThumbnail">
                    {preview ? <img src={preview} alt="" /> : <TypeIcon type={asset.type} size={19} />}
                  </span>
                  <span className="assetMentionOptionCopy">
                    <strong>@{asset.name}</strong>
                    <small>{typeLabels[asset.type]} · {linked ? '已加入本镜，可再次引用' : '选择后加入本镜参考'}</small>
                  </span>
                  <span className={linked ? 'assetMentionStatus linked' : 'assetMentionStatus'}>{linked ? '已选' : '引用'}</span>
                </button>
              )
            })}
          </div>
        ) : <div className="assetMentionEmpty">没有匹配的角色、场景或道具资产</div>}
        <div className="assetMentionPopoverFooter"><span>↑↓ 选择</span><span>Enter 确认</span><span>Esc 关闭</span></div>
      </div>
    ), document.body)
    : null

  const mirrorPrefix = mention ? value.slice(0, mention.end) : value
  const mirrorSuffix = mention ? value.slice(mention.end) : ''

  return (
    <div className="highlightedTextarea">
      <div className="highlightedTextareaMirror" ref={mirrorRef} aria-hidden="true">
        {renderSegments(mirrorPrefix, 'prefix')}
        {mention ? <span className="assetMentionCaretMarker" ref={markerRef} /> : null}
        {mirrorSuffix ? renderSegments(mirrorSuffix, 'suffix') : null}
        {value.endsWith('\n') ? '\u200b' : null}
      </div>
      <textarea
        ref={inputRef}
        data-assistant-target="storyboard-prompt"
        value={value}
        aria-autocomplete="list"
        aria-controls={mention ? 'asset-mention-options' : undefined}
        aria-expanded={Boolean(mention)}
        aria-activedescendant={mention && candidates[activeIndex] ? `asset-mention-option-${candidates[activeIndex].id}` : undefined}
        onChange={(event) => {
          onChange(event.target.value)
          updateMention(event.currentTarget)
        }}
        onFocus={(event) => updateMention(event.currentTarget)}
        onSelect={(event) => updateMention(event.currentTarget)}
        onBlur={() => setMention(null)}
        onKeyDown={(event) => {
          if (!mention || event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            setMention(null)
            return
          }
          if (candidates.length === 0) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((index) => (index + 1) % candidates.length)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length)
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            selectAsset(candidates[activeIndex])
          }
        }}
        onScroll={(event) => {
          if (!mirrorRef.current) return
          mirrorRef.current.scrollTop = event.currentTarget.scrollTop
          mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft
          updateMenuPosition()
        }}
        placeholder="输入景别、机位、动作、对白；输入 @ 可引用带缩略图的项目资产"
        rows={15}
      />
      {menu}
    </div>
  )
}

function buildJenniferGuidance(input: {
  view: WorkspaceView
  preproduction: PreproductionSummary
  assets: AssetRecord[]
  selectedAsset: AssetRecord | null
  assetTask?: TaskRecord
  storyboards: StoryboardRecord[]
  videoLibraryCount: number
  selectedStoryboard: StoryboardRecord | null
  storyboardTask?: TaskRecord | null
  creatingStoryboard: boolean
  styleLabel: string
}): JenniferGuidance {
  const styleWarning = `当前是${input.styleLabel}。切换画风只影响之后生成的内容，已有图片和视频不会自动重做。`

  if (input.view === 'script') {
    if (input.preproduction.activeTask) {
      if (input.preproduction.activeTask.type === 'storyboard_generation') {
        return {
          key: `storyboards-running-${input.preproduction.activeTask.id}`,
          title: '正在生成已锁定剧集的分镜',
          detail: `当前进度 ${input.preproduction.activeTask.progress || 0}%。本次只处理提交时选择的剧集，其他集不会被修改。`,
          warnings: ['任务会逐集保存，切换页面不会中断。', '不要重复提交同一集。'],
          action: { id: 'open_shot_plan', label: '查看分镜进度' },
        }
      }
      const revising = input.preproduction.activeTask.type === 'script_revision'
      return {
        key: `text-running-${input.preproduction.activeTask.id}`,
        title: revising ? '正在按导演评论修订本集' : '导演正在把小说改写为分集剧本',
        detail: `当前进度 ${input.preproduction.activeTask.progress || 0}%。原文会先分块核对剧情和对白，再逐集写作。`,
        warnings: ['长篇小说会产生多次文本模型调用，请不要重复提交。', '任务失败不会删除原文或已有剧本。'],
      }
    }
    if (input.preproduction.failedTask) {
      return {
        key: `text-failed-${input.preproduction.failedTask.id}`,
        title: '文本服务暂时没有完成这次任务',
        detail: readableTextTaskError(input.preproduction.failedTask.error),
        warnings: ['重试会重新调用文本模型。', '无需重新粘贴已经保存的小说。'],
        action: { id: input.preproduction.episodeCount ? 'open_script_review' : 'focus_script_generation', label: input.preproduction.episodeCount ? '继续审阅剧本' : '返回改编设置' },
      }
    }
    if (!input.preproduction.novelSaved) {
      return {
        key: 'save-novel',
        title: '先粘贴并保存小说原文',
        detail: '保留章节、段落和对白引号，导演引擎会按原文顺序建立剧情与对白档案。',
        warnings: ['单个项目当前最多处理 50 万字。', '保存原文不会调用模型。'],
        action: { id: 'focus_novel', label: '填写小说原文' },
      }
    }
    if (input.preproduction.episodeCount === 0) {
      return {
        key: 'adapt-novel',
        title: '设定集数和时长，生成分集剧本',
        detail: '本阶段只确定每集内容和可拍摄剧本，不会提前生成分镜。',
        warnings: ['目标集数越多，文本模型调用次数通常越多。', '生成后仍需逐集审阅和锁定。'],
        action: { id: 'focus_script_generation', label: '检查改编设置' },
      }
    }
    if (input.preproduction.lockedCount < input.preproduction.episodeCount) {
      if (input.preproduction.lockedCount > 0) {
        return {
          key: `review-and-shoot-${input.preproduction.lockedCount}-${input.preproduction.episodeCount}`,
          title: `${input.preproduction.lockedCount} 集已敲定，可以先生成分镜`,
          detail: '每锁定一集，就能单独生成这一集的分镜；其余未确认剧集不会阻塞。',
          warnings: ['未锁定剧集不会进入分镜任务。', '修改已锁定内容会自动解除锁定。'],
          action: { id: 'open_shot_plan', label: '生成已锁定剧集分镜' },
        }
      }
      return {
        key: `review-script-${input.preproduction.lockedCount}-${input.preproduction.episodeCount}`,
        title: `审阅并锁定剩余 ${input.preproduction.episodeCount - input.preproduction.lockedCount} 集`,
        detail: '可直接编辑剧本，也可以选中文字添加导演评论，再让模型只修订评论涉及的细节。',
        warnings: ['有未处理评论的分集不能锁定。', '修改已锁定内容会自动解除锁定。'],
        action: { id: 'open_script_review', label: '继续审阅分集' },
      }
    }
    return {
      key: 'script-locked',
      title: '分集内容已敲定，开始拆解分镜',
      detail: '先按集建立镜头、标准场景名和连续性，再由资产规划逐字复用分镜中的角色与场景。',
      warnings: ['之后解锁并修改剧本时，应重新检查分镜和资产。', styleWarning],
      action: { id: 'open_shot_plan', label: '进入分镜拆解' },
    }
  }

  if (input.view === 'assetPlan') {
    if (input.preproduction.lockedCount < input.preproduction.episodeCount || input.preproduction.episodeCount === 0) {
      return {
        key: 'asset-plan-needs-script',
        title: '先完成并锁定全部分集剧本',
        detail: '资产提取只读取锁定版本，避免剧本仍在变化时反复建立角色和场景。',
        warnings: ['未锁定分集不会进入资产提取。', '先处理所有导演评论。'],
        action: { id: 'open_script_review', label: '返回剧本改编' },
      }
    }
    if (input.preproduction.storyboardCount === 0) {
      return {
        key: 'asset-plan-needs-storyboards',
        title: '先完成全部分集的分镜拆解',
        detail: '资产规划会读取分镜中的人物锁定、标准场景名和固定环境，确保资产图与后续视频使用同一套设定。',
        warnings: ['分镜是场景名称的唯一来源。', styleWarning],
        action: { id: 'open_shot_plan', label: '返回分镜拆解' },
      }
    }
    if (input.preproduction.activeTask) {
      return {
        key: `assets-running-${input.preproduction.activeTask.id}`,
        title: '正在从全剧提取核心角色与场景',
        detail: `当前进度 ${input.preproduction.activeTask.progress || 0}%。结果会先成为可编辑提示词草稿。`,
        warnings: ['单集小道具会被自动排除。', '已有图片的资产不会被自动覆盖。'],
      }
    }
    if (input.preproduction.assetCount === 0) {
      return {
        key: 'extract-assets',
        title: '从剧本和已完成分镜提取资产清单',
        detail: '系统重点提取角色与分镜标准场景，仅保留跨多集反复出现的核心道具。',
        warnings: ['提取会调用文本模型，但不会生成图片。', styleWarning],
        action: { id: 'focus_asset_extraction', label: '开始提取资产' },
      }
    }
    return {
      key: 'review-asset-prompts',
      title: '检查资产提示词后开始生图',
      detail: '场景名称已与分镜锁定；重点确认角色外观、无人场景描述和跨集核心道具。',
      warnings: ['此时仍未调用生图模型。', '场景提示词必须保持无人、无角色姓名。'],
      action: { id: 'open_asset_images', label: '进入资产生图' },
    }
  }

  if (input.view === 'shotPlan') {
    if (input.preproduction.episodeCount === 0 || input.preproduction.lockedCount === 0) {
      return {
        key: 'shots-need-script',
        title: '先确认并锁定至少一集剧本',
        detail: '锁定第一集后即可先生成第一集分镜，不必等待整部剧本全部确认。',
        warnings: ['未锁定剧集不会进入分镜任务。', styleWarning],
        action: { id: 'open_script_review', label: '返回剧本改编' },
      }
    }
    if (input.preproduction.activeTask) {
      return {
        key: `shots-running-${input.preproduction.activeTask.id}`,
        title: '导演正在逐集拆分电影级分镜',
        detail: `当前进度 ${input.preproduction.activeTask.progress || 0}%。系统会核对对白，遗漏时自动修订一次。`,
        warnings: ['本阶段不会生成视频。', '不要重复提交同一套分镜。'],
      }
    }
    if (input.preproduction.storyboardCount === 0) {
      return {
        key: 'generate-storyboards',
        title: `先为已锁定的 ${input.preproduction.lockedCount} 集生成分镜`,
        detail: '可按当前集单独生成，也可一次生成所有尚未拆解的已锁定剧集。',
        warnings: ['每镜只安排一位角色说话。', '生成后请逐镜检查对白和场景连续性。'],
        action: { id: 'focus_storyboard_generation', label: '生成当前集分镜' },
      }
    }
    if (input.preproduction.lockedCount < input.preproduction.episodeCount) {
      return {
        key: `shots-partial-${input.preproduction.lockedCount}-${input.preproduction.episodeCount}`,
        title: '已开始逐集生成分镜',
        detail: `当前已有分镜成果。可以继续确认剩余 ${input.preproduction.episodeCount - input.preproduction.lockedCount} 集，已完成分镜不会被影响。`,
        warnings: ['单集重新生成只替换该集 AI 分镜。', styleWarning],
        action: { id: 'open_script_review', label: '继续确认下一集' },
      }
    }
    return {
      key: 'shots-ready-for-assets',
      title: '分镜文本已就绪，开始规划资产',
      detail: '资产规划将从分镜反向提取角色与标准场景，再生成与镜头一致的视觉提示词。',
      warnings: ['资产规划只调用文本模型，尚不会产生图片费用。', styleWarning],
      action: { id: 'open_asset_plan', label: '进入资产规划' },
    }
  }

  if (input.view === 'assets') {
    const imageGenerating = input.assetTask?.status === 'queued' || input.assetTask?.status === 'processing'
    if (imageGenerating && input.selectedAsset) {
      return {
        key: `image-running-${input.selectedAsset.id}`,
        title: `等待「${input.selectedAsset.name}」完成生图`,
        detail: '任务会在后台继续，完成后图片将自动入库，首张图片会自动成为主图。',
        warnings: ['不要重复提交同一个生图任务，以免产生重复计费。', styleWarning],
        action: { id: 'focus_asset_form', label: '继续创建其他资产' },
      }
    }

    if (input.assets.length === 0) {
      return {
        key: 'create-first-asset',
        title: '先创建第一位核心角色',
        detail: '选择“角色”，把姓名和完整形象设定写进一个提示词，然后直接生成。',
        warnings: ['请在提示词中写清固定姓名，后续分镜会用该名称自动识别资产。', styleWarning],
        action: { id: 'focus_asset_form', label: '填写角色提示词', assetType: 'character' },
      }
    }

    if (input.selectedAsset && input.assetTask?.status === 'failed') {
      return {
        key: `image-failed-${input.selectedAsset.id}`,
        title: `检查「${input.selectedAsset.name}」的提示词后重试`,
        detail: '先确认提示词没有冲突，并保留能稳定复现身份、服装和材质的核心特征。',
        warnings: ['每次重试都会创建新的接口请求并可能产生费用。', styleWarning],
        action: { id: 'focus_image_generation', label: '前往生图', assetId: input.selectedAsset.id },
      }
    }

    if (input.selectedAsset && input.selectedAsset.images.length === 0) {
      return {
        key: `generate-${input.selectedAsset.id}`,
        title: `为「${input.selectedAsset.name}」生成主图`,
        detail: '视频只会使用资产主图作为参考。先生成图片，再挑选身份和风格最稳定的一张。',
        warnings: ['人物主图应清楚展示脸型、发型和固定服装。', styleWarning],
        action: { id: 'focus_image_generation', label: '前往生图', assetId: input.selectedAsset.id },
      }
    }

    if (input.selectedAsset && !input.selectedAsset.selectedImageId) {
      return {
        key: `select-image-${input.selectedAsset.id}`,
        title: `为「${input.selectedAsset.name}」选择主图`,
        detail: '在图片版本中点击最符合角色、场景或道具设定的一张，主图将作为视频参考。',
        warnings: ['更换主图只影响之后生成的视频。', styleWarning],
        action: { id: 'focus_image_generation', label: '查看图片版本', assetId: input.selectedAsset.id },
      }
    }

    const missingType = (['location', 'prop'] as AssetType[]).find((type) => (
      !input.assets.some((asset) => asset.type === type && asset.selectedImageId)
    ))
    if (missingType) {
      return {
        key: `create-${missingType}`,
        title: `补齐第一张${typeLabels[missingType]}主图`,
        detail: missingType === 'location'
          ? '场景主图能固定空间布局、光线和关键陈设，让不同镜头处在同一个环境里。'
          : '道具主图能固定材质、颜色和识别细节，避免镜头之间外观变化。',
        warnings: [`请在提示词中写清${typeLabels[missingType]}名称，并与分镜保持一致。`, styleWarning],
        action: { id: 'focus_asset_form', label: `创建${typeLabels[missingType]}`, assetType: missingType },
      }
    }

    return {
      key: 'start-storyboard',
      title: '资产已就绪，开始写分镜',
      detail: '在分镜提示词中直接使用资产名称，系统会自动绑定对应主图。',
      warnings: ['单条视频最多使用前 4 张已识别的资产主图。', styleWarning],
      action: { id: 'open_storyboards', label: '进入分镜视频' },
    }
  }

  if (input.view === 'videos') {
    const videoCount = input.videoLibraryCount
    return videoCount > 0 ? {
      key: `video-library-${videoCount}`,
      title: `视频库中共有 ${videoCount} 条视频`,
      detail: '可以逐条预览、修改名称并直接下载，所有历史生成版本都会保留。',
      warnings: ['重命名不会修改视频内容。', '下载文件会使用当前保存的名称。'],
    } : {
      key: 'video-library-empty',
      title: '先生成第一条分镜视频',
      detail: '视频生成完成后会自动进入这里，不需要额外合成或导入。',
      warnings: ['视频库会汇总当前账号有权限访问的全部项目。', styleWarning],
      action: { id: 'open_storyboards', label: '进入分镜视频' },
    }
  }

  if (input.storyboards.length === 0 || input.creatingStoryboard || !input.selectedStoryboard) {
    return {
      key: 'write-storyboard',
      title: '写下这一镜的画面与动作',
      detail: '输入景别、机位、动作、对白，并直接写出角色、场景和道具的资产名称。',
      warnings: ['创建分镜时只做一次初始识别；之后请通过 @资产自由增删。', '使用别名时，请写入资产名称括号，例如“陈蕊（Jessica）”。'],
      action: { id: 'focus_storyboard_prompt', label: '填写分镜提示词' },
    }
  }

  const storyboard = input.selectedStoryboard
  const videoGenerating = input.storyboardTask?.status === 'queued' || input.storyboardTask?.status === 'processing'
  if (videoGenerating) {
    return {
      key: `video-running-${storyboard.id}`,
      title: '视频模型正在生成当前分镜',
      detail: `当前进度 ${input.storyboardTask?.progress || 0}%。任务会在后台运行，完成后自动进入视频版本。`,
      warnings: ['生成期间不要重复提交同一条分镜。', '离开当前页面不会中断后台任务。'],
    }
  }

  if (input.storyboardTask?.status === 'failed') {
    return {
      key: `video-failed-${storyboard.id}`,
      title: '检查参考图和分镜后再重试',
      detail: '确认已识别资产都设置了主图，提示词中的时长、动作和对白没有互相冲突。',
      warnings: ['重试视频会再次发起计费请求。', '长对白应拆成多条分镜，避免 15 秒内动作过密。'],
      action: { id: 'focus_video_generation', label: '检查生成设置' },
    }
  }

  const missingReference = storyboard.assets.find((asset) => !asset.hasSelectedImage)
  if (missingReference) {
    return {
      key: `missing-reference-${missingReference.id}`,
      title: `先为「${missingReference.name}」设置主图`,
      detail: '这项资产已经从分镜中识别出来，但缺少可传给视频模型的参考图片。',
      warnings: ['缺少主图时，视频任务会被拦截。', '主图应与当前项目画风一致。'],
      action: { id: 'focus_image_generation', label: '返回资产库', assetId: missingReference.id },
    }
  }

  if (storyboard.assets.length === 0) {
    return {
      key: `no-references-${storyboard.id}`,
      title: '保存分镜并检查资产名称',
      detail: '当前没有识别到资产。请把“苏文菁”这类准确名称写入提示词，然后保存分镜。',
      warnings: ['只写“女人”或“客厅”等泛称无法稳定匹配资产。', '人物需写准确名称或名称括号内的别名；场景需写标准场景名。'],
      action: { id: 'focus_storyboard_prompt', label: '检查分镜提示词' },
    }
  }

  if (storyboard.videos.length === 0) {
    return {
      key: `generate-video-${storyboard.id}`,
      title: `确认参考图后生成 ${storyboard.duration}s 视频`,
      detail: `已识别 ${storyboard.assets.length} 项资产。生成前检查 @1 至 @4 的人物身份与场景是否正确。`,
      warnings: [
        storyboard.assets.length > 4 ? '当前识别超过 4 项，只会使用排序最前的 4 张主图。' : '视频模型最多接收 4 张资产主图。',
        '点击生成会消耗视频 API 额度。',
      ],
      action: { id: 'focus_video_generation', label: '检查并生成视频' },
    }
  }

  const allStoryboardsReady = input.storyboards.length > 0
    && input.storyboards.every((item) => Boolean(item.selectedVideoId))
  if (allStoryboardsReady) {
    return {
      key: 'all-storyboards-ready',
      title: '所有分镜都已选片，可以集中检查视频',
      detail: '视频库会按分集整理所有生成版本，可逐条预览、重命名和下载。',
      warnings: ['旧版本不会被覆盖。', '先播放检查本镜，再下载能减少返工。'],
      action: { id: 'open_video_library', label: '打开视频库' },
    }
  }

  return {
    key: `review-video-${storyboard.id}-${storyboard.selectedVideoId || ''}`,
    title: '播放视频并检查连续性',
    detail: '重点检查人物脸型、发型、固定服装、道具外观、场景布局、口型和对白是否跨镜一致。',
    warnings: ['发现漂移时，先调整资产主图或提示词，再生成新版本。', '选中的版本会作为当前分镜的默认视频保留。'],
    action: { id: 'review_video', label: '播放当前版本' },
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = response.status === 204
    ? null
    : await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) {
    throw new Error(payload?.error?.message || `请求失败 (${response.status})`)
  }
  return payload as T
}

function Toggle({
  checked,
  onChange,
  label,
  icon,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  icon?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`toggleRow ${disabled ? 'disabled' : ''}`}>
      <span className="toggleLabel">{icon}{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggleTrack" aria-hidden="true"><span /></span>
    </label>
  )
}

function JenniferAssistant({
  open,
  guidance,
  onOpenChange,
  onAction,
}: {
  open: boolean
  guidance: JenniferGuidance
  onOpenChange: (open: boolean) => void
  onAction: (guidance: JenniferGuidance) => void
}) {
  return (
    <aside className={`jenniferDock ${open ? 'open' : 'collapsed'}`} aria-label="Jennifer 创作助手">
      {open ? (
        <section className="jenniferPanel">
          <div className="jenniferPortrait" aria-label="Jennifer 形象">
            <span className="jenniferSprite" aria-hidden="true" />
          </div>
          <div className="jenniferContent" aria-live="polite" key={guidance.key}>
            <div className="jenniferHeader">
              <span><strong>Jennifer</strong><small>创作助手</small></span>
              <button className="assistantClose" type="button" title="收起 Jennifer" onClick={() => onOpenChange(false)}>
                <X size={16} />
              </button>
            </div>
            <span className="nextStepLabel"><Sparkles size={13} />下一步</span>
            <h2>{guidance.title}</h2>
            <p>{guidance.detail}</p>
            <ul className="assistantWarnings">
              {guidance.warnings.slice(0, 2).map((warning) => (
                <li key={warning}><CircleAlert size={13} /><span>{warning}</span></li>
              ))}
            </ul>
            {guidance.action ? (
              <button className="assistantAction" type="button" onClick={() => onAction(guidance)}>
                {guidance.action.label}<ArrowRight size={15} />
              </button>
            ) : null}
          </div>
        </section>
      ) : (
        <button className="jenniferLauncher" type="button" onClick={() => onOpenChange(true)}>
          <span className="jenniferMini" aria-hidden="true"><span className="jenniferSprite" /></span>
          <span><strong>Jennifer</strong><small>查看下一步</small></span>
        </button>
      )}
    </aside>
  )
}

export function AssetWorkspace({
  user,
  initialData,
}: {
  user: User
  initialData: WorkspaceData
}) {
  const [view, setView] = useState<WorkspaceView>('script')
  const [projects, setProjects] = useState(initialData.projects)
  const [activeProjectId, setActiveProjectId] = useState(initialData.activeProjectId)
  const [assets, setAssets] = useState(initialData.assets)
  const [storyboards, setStoryboards] = useState(initialData.storyboards)
  const [videoLibrary, setVideoLibrary] = useState(initialData.videoLibrary)
  const [filterType, setFilterType] = useState<AssetType | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState(initialData.assets[0]?.id || '')
  const [selectedStoryboardId, setSelectedStoryboardId] = useState(preferredStoryboardId(initialData.storyboards))
  const [creatingStoryboard, setCreatingStoryboard] = useState(initialData.storyboards.length === 0)
  const [tasks, setTasks] = useState<Record<string, TaskRecord>>(() => {
    const initialTasks: Record<string, TaskRecord> = {}
    initialData.storyboards.forEach((storyboard) => {
      if (storyboard.latestTask) initialTasks[storyboard.latestTask.id] = storyboard.latestTask
    })
    initialData.assets.forEach((asset) => {
      if (asset.latestTask) initialTasks[asset.latestTask.id] = asset.latestTask
    })
    return initialTasks
  })
  const [loading, setLoading] = useState(false)
  const [styleSaving, setStyleSaving] = useState(false)
  const [batchImageSubmitting, setBatchImageSubmitting] = useState(false)
  const [customStyleDraft, setCustomStyleDraft] = useState('')
  const [toast, setToast] = useState<Toast | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [videoModels, setVideoModels] = useState<VideoModelOption[]>([])
  const [defaultVideoModel, setDefaultVideoModel] = useState(DEFAULT_VIDEO_MODEL_ID)
  const [videoPriceNotice, setVideoPriceNotice] = useState('实际扣费以模型广场为准。')
  const [videoModelsRefreshedAt, setVideoModelsRefreshedAt] = useState<string | null>(null)
  const [videoModelsRefreshing, setVideoModelsRefreshing] = useState(false)
  const videoModelRequestId = useRef(0)
  const [preproductionSummary, setPreproductionSummary] = useState<PreproductionSummary>({
    novelSaved: false,
    episodeCount: 0,
    lockedCount: 0,
    unresolvedCommentCount: 0,
    assetCount: initialData.assets.length,
    storyboardCount: initialData.storyboards.length,
    activeTask: null,
    failedTask: null,
  })

  const activeProject = projects.find((project) => project.id === activeProjectId) || null
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0] || null
  const selectedStoryboard = storyboards.find((storyboard) => storyboard.id === selectedStoryboardId) || null

  useEffect(() => {
    setCustomStyleDraft(activeProject?.customStylePrompt || '')
  }, [activeProjectId, activeProject?.customStylePrompt])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('view') !== 'storyboards') return
    const storyboardId = params.get('storyboard') || ''
    if (storyboardId && storyboards.some((storyboard) => storyboard.id === storyboardId)) {
      setSelectedStoryboardId(storyboardId)
      setCreatingStoryboard(false)
    }
    setView('storyboards')
    window.history.replaceState({}, '', window.location.pathname)
    // Initial navigation from the cross-project video library only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const stored = window.localStorage.getItem('jennifer-assistant-open')
    if (stored === 'false' || (stored === null && window.innerWidth <= 1240)) {
      setAssistantOpen(false)
    }
  }, [])

  useEffect(() => {
    void refreshVideoModelOptions()
    const timer = window.setInterval(() => void refreshVideoModelOptions(), 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function showMessage(text: string, tone: Toast['tone'] = 'success') {
    setToast({ text, tone })
    window.setTimeout(() => setToast(null), 3200)
  }

  async function refreshVideoModelOptions(force = false, announce = false) {
    const requestId = ++videoModelRequestId.current
    setVideoModelsRefreshing(true)
    try {
      const suffix = force ? `?refresh=1&t=${Date.now()}` : ''
      const payload = await requestJson<VideoModelsResponse>(`/api/video-models${suffix}`)
      if (requestId !== videoModelRequestId.current) return
      setVideoModels(payload.models)
      setDefaultVideoModel(payload.defaultModel)
      setVideoPriceNotice([payload.warning, payload.priceNotice].filter(Boolean).join(' '))
      setVideoModelsRefreshedAt(payload.priceUpdatedAt || payload.refreshedAt)
      if (announce) showMessage(payload.stale ? '已刷新，部分数据暂沿用上一次结果' : '可用模型和实时价格已更新')
    } catch (error) {
      if (requestId !== videoModelRequestId.current) return
      setVideoPriceNotice('模型与价格暂时无法刷新，已保留当前列表。提交时会再次检查。')
      if (announce) showMessage(error instanceof Error ? error.message : '模型与价格刷新失败', 'error')
    } finally {
      if (requestId === videoModelRequestId.current) setVideoModelsRefreshing(false)
    }
  }

  async function refresh(next?: {
    projectId?: string | null
    type?: AssetType | 'all'
    q?: string
  }) {
    const projectId = next?.projectId ?? activeProjectId
    const type = next?.type ?? filterType
    const q = next?.q ?? query
    const params = new URLSearchParams()
    if (projectId) params.set('projectId', projectId)
    if (type !== 'all') params.set('type', type)
    if (q.trim()) params.set('q', q.trim())

    setLoading(true)
    try {
      const data = await requestJson<WorkspaceData>(`/api/assets?${params.toString()}`)
      setProjects(data.projects)
      setActiveProjectId(data.activeProjectId)
      setAssets(data.assets)
      setStoryboards(data.storyboards)
      setVideoLibrary(data.videoLibrary)
      setTasks((current) => {
        const nextTasks = { ...current }
        data.storyboards.forEach((storyboard) => {
          if (storyboard.latestTask) nextTasks[storyboard.latestTask.id] = storyboard.latestTask
        })
        data.assets.forEach((asset) => {
          if (asset.latestTask) nextTasks[asset.latestTask.id] = asset.latestTask
        })
        return nextTasks
      })
      if (data.assets.length > 0 && !data.assets.some((asset) => asset.id === selectedAssetId)) {
        setSelectedAssetId(data.assets[0].id)
      }
      if (data.storyboards.length > 0 && !data.storyboards.some((item) => item.id === selectedStoryboardId)) {
        setSelectedStoryboardId(preferredStoryboardId(data.storyboards))
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '刷新失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 260)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterType, query, activeProjectId])

  useEffect(() => {
    const activeTasks = Object.values(tasks).filter((task) => (
      task.status === 'queued' || task.status === 'processing'
    ))
    if (activeTasks.length === 0) return

    const timer = window.setInterval(async () => {
      const updates = await Promise.all(activeTasks.map(async (task) => {
        try {
          const payload = await requestJson<{ task: TaskRecord }>(`/api/tasks/${task.id}`)
          return payload.task
        } catch {
          return task
        }
      }))
      setTasks((current) => {
        const next = { ...current }
        updates.forEach((task) => { next[task.id] = task })
        return next
      })
      if (updates.some((task) => task.status === 'completed')) void refresh()
    }, 2200)

    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  async function updateProjectStyle(visualStyle: VisualStyle, customStylePrompt = customStyleDraft) {
    if (!activeProjectId) return
    setStyleSaving(true)
    const previous = projects
    setProjects((current) => current.map((project) => project.id === activeProjectId
      ? { ...project, visualStyle, customStylePrompt: customStylePrompt || null }
      : project))
    try {
      await requestJson(`/api/projects/${activeProjectId}/style`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visualStyle, customStylePrompt: customStylePrompt || null }),
      })
      showMessage('项目画风已更新')
    } catch (error) {
      setProjects(previous)
      showMessage(error instanceof Error ? error.message : '画风更新失败', 'error')
    } finally {
      setStyleSaving(false)
    }
  }

  async function saveAsset(asset: AssetRecord, patch: Partial<AssetRecord> & { tags?: string[] }) {
    try {
      await requestJson(`/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await refresh()
      showMessage('资产已保存')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '保存失败', 'error')
    }
  }

  async function deleteAsset(asset: AssetRecord) {
    if (!window.confirm(`删除资产“${asset.name}”？`)) return
    try {
      await requestJson(`/api/assets/${asset.id}`, { method: 'DELETE' })
      setSelectedAssetId('')
      await refresh()
      showMessage('资产已删除')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '删除失败', 'error')
    }
  }

  async function generateImages(asset: AssetRecord, prompt?: string) {
    try {
      const payload = await requestJson<{ task: TaskRecord; reused?: boolean }>(`/api/assets/${asset.id}/generate-images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt?.trim() || undefined, count: 1 }),
      })
      setTasks((current) => ({ ...current, [payload.task.id]: payload.task }))
      showMessage(payload.reused ? '这个资产已经在排队生成，请等待结果' : '生图任务已提交')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '任务提交失败', 'error')
    }
  }

  async function generateAllAssetImages() {
    if (!activeProjectId || batchImageSubmitting) return
    if (!window.confirm('为当前项目所有尚无图片的资产各生成 1 张图片？已有图片和正在生成的资产不会重复提交。')) return
    setBatchImageSubmitting(true)
    try {
      const payload = await requestJson<{
        tasks: TaskRecord[]
        submitted: number
        reused: number
        skippedWithImages: number
        failures: Array<{ assetId: string; name: string }>
      }>(`/api/projects/${activeProjectId}/generate-asset-images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 1 }),
      })
      setTasks((current) => {
        const next = { ...current }
        payload.tasks.forEach((task) => { next[task.id] = task })
        return next
      })
      await refresh()
      if (payload.submitted === 0 && payload.reused === 0) {
        showMessage('所有资产都已经有图片，无需重复生成')
      } else {
        showMessage(`已提交 ${payload.submitted} 项，复用 ${payload.reused} 项正在执行的任务${payload.failures.length ? `，${payload.failures.length} 项提交失败` : ''}`)
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '批量生图任务提交失败', 'error')
    } finally {
      setBatchImageSubmitting(false)
    }
  }

  async function uploadAssetImage(asset: AssetRecord, file: File) {
    try {
      const formData = new FormData()
      formData.set('file', file)
      formData.set('selectAsPrimary', 'true')
      await requestJson<{ image: AssetImage }>(`/api/assets/${asset.id}/upload-image`, {
        method: 'POST',
        body: formData,
      })
      await refresh()
      showMessage('图片已上传并设为资产主图')
      return true
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '图片上传失败', 'error')
      return false
    }
  }

  async function selectImage(asset: AssetRecord, image: AssetImage) {
    try {
      await requestJson(`/api/assets/${asset.id}/select-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageId: image.id }),
      })
      await refresh()
      showMessage('主图已更新')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '设置主图失败', 'error')
    }
  }

  async function createStoryboard(input: {
    title: string
    videoPrompt: string
    notes: string | null
    duration: number
    aspectRatio: StoryboardAspectRatio
    generateAudio: boolean
  }) {
    if (!activeProjectId) return null
    try {
      const payload = await requestJson<{ storyboard: StoryboardRecord }>('/api/storyboards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, projectId: activeProjectId }),
      })
      await refresh()
      setSelectedStoryboardId(payload.storyboard.id)
      setCreatingStoryboard(false)
      showMessage('分镜已创建并完成初始资产识别；之后可自由增删')
      return payload.storyboard
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '创建分镜失败', 'error')
      return null
    }
  }

  async function saveStoryboard(storyboard: StoryboardRecord, patch: Partial<StoryboardRecord>) {
    try {
      const payload = await requestJson<{ storyboard: StoryboardRecord }>(`/api/storyboards/${storyboard.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...patch, baseUpdatedAt: storyboard.updatedAt }),
      })
      setStoryboards((current) => current.map((item) => (
        item.id === storyboard.id ? payload.storyboard : item
      )))
      showMessage('分镜已保存；本镜已选资产保持不变')
      return payload.storyboard
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '保存分镜失败', 'error')
      return null
    }
  }

  async function updateStoryboardAssetLink(
    storyboardId: string,
    assetId: string,
    action: 'add' | 'remove',
    videoPrompt: string,
  ) {
    try {
      const payload = await requestJson<{ storyboard: StoryboardRecord }>(
        `/api/storyboards/${storyboardId}/assets${action === 'remove' ? `?assetId=${encodeURIComponent(assetId)}` : ''}`,
        {
          method: action === 'remove' ? 'DELETE' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId, videoPrompt }),
        },
      )
      setStoryboards((current) => current.map((item) => (
        item.id === storyboardId ? payload.storyboard : item
      )))
      showMessage(action === 'add'
        ? '已添加 @资产，并加入本镜视频参考'
        : '已移除 @资产；生成时不会自动加回')
      return payload.storyboard
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '更新本镜资产失败', 'error')
      return null
    }
  }

  async function restoreStoryboardRevision(storyboard: StoryboardRecord, revisionId: string) {
    try {
      const payload = await requestJson<{ storyboard: StoryboardRecord }>(
        `/api/storyboards/${storyboard.id}/revisions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revisionId }),
        },
      )
      setStoryboards((current) => current.map((item) => (
        item.id === storyboard.id ? payload.storyboard : item
      )))
      showMessage('已恢复分镜历史版本，恢复前的稿件也已留存')
      return payload.storyboard
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '恢复分镜版本失败', 'error')
      return null
    }
  }

  async function deleteStoryboard(storyboard: StoryboardRecord) {
    if (!window.confirm(`删除“${storyboard.title}”？`)) return
    try {
      await requestJson(`/api/storyboards/${storyboard.id}`, { method: 'DELETE' })
      setSelectedStoryboardId('')
      await refresh()
      showMessage('分镜已删除')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '删除分镜失败', 'error')
    }
  }

  async function generateVideo(storyboard: StoryboardRecord, settings: {
    duration: number
    aspectRatio: StoryboardAspectRatio
    resolution: VideoResolution
    generateAudio: boolean
    model: string
    continuityFrameMediaId?: string
    continuitySourceVideoId?: string
  }, quiet = false): Promise<TaskRecord | null> {
    try {
      const payload = await requestJson<{ task: TaskRecord; reused?: boolean }>(
        `/api/storyboards/${storyboard.id}/generate-video`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings),
        },
      )
      setTasks((current) => ({ ...current, [payload.task.id]: payload.task }))
      if (!quiet) showMessage(payload.reused ? '该分镜已在队列中，请等待完成' : '视频任务已提交')
      return payload.task
    } catch (error) {
      if (!quiet) showMessage(error instanceof Error ? error.message : '视频任务提交失败', 'error')
      return null
    }
  }

  async function generateVideoGroup(storyboardIds: string[], settings: {
    duration: number
    resolution: VideoResolution
    generateAudio?: boolean
    model: string
  }, quiet = false): Promise<TaskRecord | null> {
    try {
      const payload = await requestJson<{ task: TaskRecord }>('/api/storyboards/generate-video-group', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storyboardIds, ...settings }),
      })
      setTasks((current) => ({ ...current, [payload.task.id]: payload.task }))
      if (!quiet) showMessage(`已提交 ${storyboardIds.length} 个分镜的组合视频任务`)
      return payload.task
    } catch (error) {
      if (!quiet) showMessage(error instanceof Error ? error.message : '组合视频任务提交失败', 'error')
      return null
    }
  }

  async function cancelVideoTask(task: TaskRecord): Promise<TaskRecord | null> {
    try {
      const payload = await requestJson<{
        task: TaskRecord
        cancelled: boolean
        providerMayContinue?: boolean
      }>(`/api/tasks/${task.id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '用户在分镜视频页取消生成。' }),
      })
      setTasks((current) => ({ ...current, [payload.task.id]: payload.task }))
      await refresh()
      showMessage(payload.providerMayContinue
        ? '已停止等待并忽略该任务的生成结果'
        : '视频生成已取消')
      return payload.task
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '取消视频生成失败', 'error')
      return null
    }
  }

  async function selectVideo(storyboard: StoryboardRecord, video: StoryboardVideo) {
    try {
      await requestJson(`/api/storyboards/${storyboard.id}/select-video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: video.id }),
      })
      await refresh()
      showMessage('视频版本已选中')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '选择视频失败', 'error')
    }
  }

  async function renameVideo(video: StoryboardVideo, name: string) {
    try {
      const payload = await requestJson<{ video: { id: string; name: string } }>(
        `/api/storyboard-videos/${video.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        },
      )
      setStoryboards((current) => current.map((storyboard) => ({
        ...storyboard,
        videos: storyboard.videos.map((item) => (
          item.id === payload.video.id ? { ...item, name: payload.video.name } : item
        )),
      })))
      setVideoLibrary((current) => current.map((entry) => (
        entry.video.id === payload.video.id
          ? { ...entry, video: { ...entry.video, name: payload.video.name } }
          : entry
      )))
      showMessage('视频名称已保存')
      return payload.video.name
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '视频重命名失败', 'error')
      return null
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const selectedAssetTask = Object.values(tasks)
    .filter((task) => task.assetId === selectedAsset?.id)
    .sort((a, b) => (b.createdAt || b.id).localeCompare(a.createdAt || a.id))[0]
    || selectedAsset?.latestTask
  const selectedStoryboardTask = Object.values(tasks)
    .filter((task) => selectedStoryboard && sourceStoryboardIdsForTask(task).includes(selectedStoryboard.id))
    .sort((a, b) => (b.createdAt || b.id).localeCompare(a.createdAt || a.id))[0]
    || selectedStoryboard?.latestTask
  const activeVideoStoryboardIds = new Set(Object.values(tasks)
    .filter((task) => task.type === 'video_generation'
      && (task.status === 'queued' || task.status === 'processing'))
    .flatMap(sourceStoryboardIdsForTask))
  const activeStyleLabel = initialData.styleOptions.find((option) => option.id === activeProject?.visualStyle)?.label
    || '当前画风'
  const assistantGuidance = buildJenniferGuidance({
    view,
    preproduction: preproductionSummary,
    assets,
    selectedAsset,
    assetTask: selectedAssetTask,
    storyboards,
    videoLibraryCount: videoLibrary.length,
    selectedStoryboard,
    storyboardTask: selectedStoryboardTask,
    creatingStoryboard,
    styleLabel: activeStyleLabel,
  })

  function setJenniferOpen(open: boolean) {
    setAssistantOpen(open)
    window.localStorage.setItem('jennifer-assistant-open', String(open))
  }

  function focusAssistantTarget(selector: string) {
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(selector)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.focus({ preventScroll: true })
    }, 120)
  }

  function handleJenniferAction(guidance: JenniferGuidance) {
    const action = guidance.action
    if (!action) return

    if (action.id === 'focus_novel') {
      setView('script')
      focusAssistantTarget('[data-assistant-target="novel-content"]')
      return
    }
    if (action.id === 'focus_script_generation') {
      setView('script')
      focusAssistantTarget('[data-assistant-target="adapt-script"]')
      return
    }
    if (action.id === 'open_script_review') {
      setView('script')
      focusAssistantTarget('.scriptEditorPanel')
      return
    }
    if (action.id === 'open_asset_plan' || action.id === 'focus_asset_extraction') {
      setFilterType('all')
      setQuery('')
      setView('assetPlan')
      if (action.id === 'focus_asset_extraction') focusAssistantTarget('[data-assistant-target="extract-assets"]')
      return
    }
    if (action.id === 'open_shot_plan' || action.id === 'focus_storyboard_generation') {
      setView('shotPlan')
      if (action.id === 'focus_storyboard_generation') focusAssistantTarget('[data-assistant-target="generate-storyboards"]')
      return
    }
    if (action.id === 'open_asset_images') {
      setFilterType('all')
      setQuery('')
      setView('assets')
      focusAssistantTarget('[data-assistant-target="asset-prompt"]')
      return
    }

    if (action.id === 'focus_asset_form') {
      setView('assets')
      window.setTimeout(() => {
        if (action.assetType) {
          document.querySelector<HTMLButtonElement>(`[data-asset-type="${action.assetType}"]`)?.click()
        }
        focusAssistantTarget('[data-assistant-target="asset-prompt"]')
      }, 60)
      return
    }
    if (action.id === 'focus_image_generation') {
      setView('assets')
      if (action.assetId) setSelectedAssetId(action.assetId)
      focusAssistantTarget('[data-assistant-target="generate-image"]')
      return
    }
    if (action.id === 'open_storyboards') {
      setView('storyboards')
      if (storyboards.length === 0) setCreatingStoryboard(true)
      focusAssistantTarget('[data-assistant-target="storyboard-prompt"]')
      return
    }
    if (action.id === 'focus_storyboard_prompt') {
      setView('storyboards')
      focusAssistantTarget('[data-assistant-target="storyboard-prompt"]')
      return
    }
    if (action.id === 'focus_video_generation') {
      setView('storyboards')
      if (action.storyboardId) {
        setSelectedStoryboardId(action.storyboardId)
        setCreatingStoryboard(false)
      }
      focusAssistantTarget('[data-assistant-target="generate-video"]')
      return
    }
    if (action.id === 'review_video') {
      setView('storyboards')
      focusAssistantTarget('.videoStage video')
      return
    }
    if (action.id === 'open_video_library') {
      setView('videos')
      focusAssistantTarget('.videoLibraryWorkspace')
    }
  }

  return (
    <main className="studioShell">
      <header className="appHeader">
        <div className="productIdentity">
          <span className="productIcon"><Clapperboard size={20} /></span>
          <span>
            <strong>AI 短剧工作台</strong>
            <small>{activeProject?.name || '未选择项目'}</small>
          </span>
        </div>

        <nav className="mainTabs" aria-label="工作区">
          <button
            type="button"
            className={view === 'script' ? 'active' : ''}
            onClick={() => setView('script')}
          >
            <BookOpenText size={16} />剧本改编
          </button>
          <button
            type="button"
            className={view === 'shotPlan' ? 'active' : ''}
            onClick={() => setView('shotPlan')}
          >
            <ListVideo size={16} />分镜拆解
          </button>
          <button
            type="button"
            className={view === 'assetPlan' ? 'active' : ''}
            onClick={() => {
              setFilterType('all')
              setQuery('')
              setView('assetPlan')
            }}
          >
            <Boxes size={16} />资产规划
          </button>
          <button
            type="button"
            className={view === 'assets' ? 'active' : ''}
            onClick={() => {
              setFilterType('all')
              setQuery('')
              setView('assets')
            }}
          >
            <Layers3 size={16} />资产生图
          </button>
          <button
            type="button"
            className={view === 'storyboards' ? 'active' : ''}
            onClick={() => setView('storyboards')}
          >
            <Film size={16} />分镜视频
          </button>
          <button
            type="button"
            className={view === 'videos' ? 'active' : ''}
            onClick={() => setView('videos')}
          >
            <ListVideo size={16} />视频库
          </button>
        </nav>

        <div className="headerActions">
          <button
            className="iconButton"
            type="button"
            onClick={() => window.location.assign('/')}
            title="返回剧本项目"
            aria-label="返回剧本项目"
          >
            <House size={17} />
          </button>
          <select
            value={activeProjectId || ''}
            onChange={(event) => {
              if (event.target.value !== activeProjectId) {
                window.location.assign(`/projects/${event.target.value}`)
              }
            }}
            aria-label="项目"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <span className="userName">{user.name}</span>
          <button className="iconButton" onClick={logout} title="退出登录" type="button">
            <LogOut size={17} />
          </button>
        </div>
      </header>

      {(['assetPlan', 'shotPlan', 'assets', 'storyboards'] as WorkspaceView[]).includes(view) ? <section className="styleBar" aria-label="项目画风">
        <div className="styleBarLabel">
          <WandSparkles size={16} />
          <strong>项目画风</strong>
        </div>
        <div className="styleOptions">
          {initialData.styleOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={activeProject?.visualStyle === option.id ? 'active' : ''}
              aria-pressed={activeProject?.visualStyle === option.id}
              onClick={() => void updateProjectStyle(option.id)}
              disabled={styleSaving}
              title={option.description}
            >
              <span className="styleSwatch" aria-hidden="true">
                {option.swatch.map((color) => <i key={color} style={{ backgroundColor: color }} />)}
              </span>
              <span className="styleNameFull">{option.label}</span>
              <span className="styleNameShort">{option.shortLabel}</span>
            </button>
          ))}
        </div>
        <details className="styleSettings">
          <summary className="iconButton" title="补充画风规则">
            {styleSaving ? <Loader2 className="spin" size={17} /> : <Settings2 size={17} />}
          </summary>
          <div className="styleMenu">
            <label>
              补充画风规则
              <textarea
                value={customStyleDraft}
                onChange={(event) => setCustomStyleDraft(event.target.value)}
                rows={5}
                placeholder="例如：全片使用雨夜冷色调，主光来自街边霓虹。"
              />
            </label>
            <button
              className="primaryButton compact"
              type="button"
              onClick={() => void updateProjectStyle(activeProject?.visualStyle || 'photorealistic')}
            >
              <Save size={16} />保存
            </button>
          </div>
        </details>
      </section> : null}

      {view === 'script' || view === 'assetPlan' || view === 'shotPlan' ? (
        <PreproductionWorkspace
          mode={view}
          projectId={activeProjectId}
          assets={assets}
          storyboards={storyboards}
          onSummary={setPreproductionSummary}
          onWorkspaceChanged={async () => {
            setFilterType('all')
            setQuery('')
            await refresh({ type: 'all', q: '' })
          }}
          onNotice={showMessage}
          onOpenAssetPlan={() => {
            setFilterType('all')
            setQuery('')
            setView('assetPlan')
          }}
          onOpenAssetImages={() => {
            setFilterType('all')
            setQuery('')
            setView('assets')
          }}
          onOpenStoryboardVideos={() => setView('storyboards')}
        />
      ) : view === 'assets' ? (
        <AssetLibrary
          activeProjectId={activeProjectId}
          assets={assets}
          selectedAsset={selectedAsset}
          selectedTask={selectedAssetTask}
          filterType={filterType}
          query={query}
          loading={loading}
          batchSubmitting={batchImageSubmitting}
          onFilterType={setFilterType}
          onQuery={setQuery}
          onSelect={setSelectedAssetId}
          onRefresh={() => void refresh()}
          onCreated={async (asset, task) => {
            if (task) setTasks((current) => ({ ...current, [task.id]: task }))
            await refresh()
            setSelectedAssetId(asset.id)
            showMessage(task ? '资产已创建，生图任务已提交' : '资产已创建')
          }}
          onError={(message) => showMessage(message, 'error')}
          onNotice={showMessage}
          onSave={saveAsset}
          onDelete={deleteAsset}
          onGenerate={generateImages}
          onUploadImage={uploadAssetImage}
          onGenerateAll={generateAllAssetImages}
          onSelectImage={selectImage}
        />
      ) : view === 'storyboards' ? (
        <StoryboardWorkspace
          visualStyle={activeProject?.visualStyle || 'photorealistic'}
          projectAssets={assets}
          storyboards={storyboards}
          selectedStoryboard={selectedStoryboard}
          selectedTask={selectedStoryboardTask}
          videoModels={videoModels}
          defaultVideoModel={defaultVideoModel}
          videoPriceNotice={videoPriceNotice}
          videoModelsRefreshedAt={videoModelsRefreshedAt}
          videoModelsRefreshing={videoModelsRefreshing}
          onRefreshVideoModels={() => void refreshVideoModelOptions(true, true)}
          activeVideoStoryboardIds={activeVideoStoryboardIds}
          creating={creatingStoryboard}
          onCreating={(value) => setCreatingStoryboard(value)}
          onSelect={(id) => {
            setSelectedStoryboardId(id)
            setCreatingStoryboard(false)
          }}
          onCreate={createStoryboard}
          onSave={saveStoryboard}
          onUpdateAssetLink={updateStoryboardAssetLink}
          onRestoreRevision={restoreStoryboardRevision}
          onDelete={deleteStoryboard}
          onGenerate={generateVideo}
          onGenerateGroup={generateVideoGroup}
          onCancelTask={cancelVideoTask}
          onSelectVideo={selectVideo}
          onNotice={showMessage}
        />
      ) : view === 'videos' ? (
        <VideoLibrary
          entries={videoLibrary}
          activeProjectId={activeProjectId}
          onRename={renameVideo}
          onOpenStoryboard={(projectId, storyboardId) => {
            if (projectId && projectId !== activeProjectId) {
              window.location.assign(`/projects/${projectId}?view=storyboards&storyboard=${storyboardId}`)
              return
            }
            setSelectedStoryboardId(storyboardId)
            setCreatingStoryboard(!storyboardId)
            setView('storyboards')
          }}
        />
      ) : null}

      {toast ? (
        <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>
      ) : null}
    </main>
  )
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.round(value))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder}s`
}

function VideoLibrary({
  entries,
  activeProjectId,
  onRename,
  onOpenStoryboard,
}: {
  entries: VideoLibraryEntry[]
  activeProjectId: string | null
  onRename: (video: StoryboardVideo, name: string) => Promise<string | null>
  onOpenStoryboard: (projectId: string, storyboardId: string) => void
}) {
  const [query, setQuery] = useState('')
  const storyboardById = useMemo(
    () => new Map(entries.map((entry) => [entry.storyboard.id, entry.storyboard])),
    [entries],
  )
  const allEntries = entries
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = normalizedQuery ? allEntries.filter(({ project, storyboard, video }) => (
    [
      video.name,
      video.model,
      project.name,
      storyboard.title,
      storyboard.episode?.title,
      storyboard.episode?.episodeNumber ? `第${storyboard.episode.episodeNumber}集` : '',
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
  )) : allEntries
  const groups = useMemo(() => {
    const grouped = new Map<string, {
      key: string
      projectId: string
      projectName: string
      episodeNumber: number | null
      title: string
      entries: VideoLibraryEntry[]
    }>()
    for (const entry of filteredEntries) {
      const episode = entry.storyboard.episode
      const key = `${entry.project.id}:${episode?.id || 'unassigned'}`
      const existing = grouped.get(key) || {
        key,
        projectId: entry.project.id,
        projectName: entry.project.name,
        episodeNumber: episode?.episodeNumber || null,
        title: episode?.title || '未分集视频',
        entries: [],
      }
      existing.entries.push(entry)
      grouped.set(key, existing)
    }
    return [...grouped.values()]
      .sort((left, right) => (
        Number(right.projectId === activeProjectId) - Number(left.projectId === activeProjectId)
        || left.projectName.localeCompare(right.projectName, 'zh-CN')
        || (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (right.episodeNumber ?? Number.MAX_SAFE_INTEGER)
      ))
      .map((group) => ({
        ...group,
        entries: group.entries.sort((left, right) => (
          (left.storyboard.episodeSceneNumber || left.storyboard.sceneNumber)
            - (right.storyboard.episodeSceneNumber || right.storyboard.sceneNumber)
          || right.video.createdAt.localeCompare(left.video.createdAt)
        )),
      }))
  }, [activeProjectId, filteredEntries])
  const totalDuration = allEntries.reduce((total, entry) => total + entry.video.duration, 0)
  const projectCount = new Set(allEntries.map((entry) => entry.project.id)).size

  return (
    <section className="videoLibraryWorkspace" tabIndex={-1}>
      <header className="videoLibraryHeader">
        <div>
          <span><ListVideo size={19} /><strong>视频库</strong></span>
          <small>{allEntries.length} 条视频 · {projectCount} 个项目 · 总时长 {formatSeconds(totalDuration)}</small>
        </div>
        <label className="videoLibrarySearch">
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索视频名称、分镜或模型"
            aria-label="搜索视频"
          />
          {query ? (
            <button type="button" onClick={() => setQuery('')} title="清除搜索" aria-label="清除搜索">
              <X size={15} />
            </button>
          ) : null}
        </label>
      </header>

      {allEntries.length === 0 ? (
        <div className="videoLibraryEmpty">
          <Film size={32} />
          <strong>当前账号还没有生成视频</strong>
          <span>完成任意项目的分镜视频任务后，视频都会自动保存在这里。</span>
          <button className="primaryButton compact" type="button" onClick={() => onOpenStoryboard(activeProjectId || '', '')}>
            <Film size={16} />进入分镜视频
          </button>
        </div>
      ) : groups.length === 0 ? (
        <div className="videoLibraryEmpty compact">
          <Search size={28} />
          <strong>没有匹配的视频</strong>
          <button className="quietButton compact" type="button" onClick={() => setQuery('')}>清除搜索</button>
        </div>
      ) : (
        <div className="videoEpisodeGroups">
          {groups.map((group, groupIndex) => (
            <details className="videoEpisodeGroup" key={group.key} open={groupIndex === 0}>
              <summary>
                <ChevronRight size={17} />
                <span>
                  <strong>{group.projectName}</strong>
                  <small>{group.episodeNumber ? `第 ${group.episodeNumber} 集 · ${group.title}` : '未分集视频'}</small>
                </span>
                <b>{group.entries.length} 条</b>
              </summary>
              <div className="videoLibraryList">
                {group.entries.map(({ project, storyboard, video }) => (
                  <VideoLibraryItem
                    key={video.id}
                    storyboard={storyboard}
                    video={video}
                    projectId={project.id}
                    storyboardById={storyboardById}
                    onRename={onRename}
                    onOpenStoryboard={onOpenStoryboard}
                  />
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

function VideoLibraryItem({
  storyboard,
  video,
  projectId,
  storyboardById,
  onRename,
  onOpenStoryboard,
}: {
  storyboard: VideoLibraryEntry['storyboard']
  video: StoryboardVideo
  projectId: string
  storyboardById: Map<string, VideoLibraryEntry['storyboard']>
  onRename: (video: StoryboardVideo, name: string) => Promise<string | null>
  onOpenStoryboard: (projectId: string, storyboardId: string) => void
}) {
  const [draft, setDraft] = useState(video.name)
  const [saving, setSaving] = useState(false)
  const cleanDraft = draft.trim()
  const invalidName = /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(cleanDraft)
  const nameError = !cleanDraft
    ? '名称不能为空'
    : invalidName ? '名称不能包含 \\ / : * ? " < > |' : ''
  const changed = cleanDraft !== video.name
  const sourceStoryboards = video.sourceStoryboardIds.flatMap((id) => {
    const source = storyboardById.get(id)
    return source ? [source] : []
  })
  const sourceNumbers = (video.sourceStoryboardNumbers?.length
    ? video.sourceStoryboardNumbers
    : (sourceStoryboards.length ? sourceStoryboards : [storyboard])
      .map((source) => source.episodeSceneNumber || source.sceneNumber))
    .join('、')
  const createdAt = new Date(video.createdAt)
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? ''
    : createdAt.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })

  useEffect(() => {
    setDraft(video.name)
  }, [video.name])

  async function saveName() {
    if (!changed || nameError || saving) return
    setSaving(true)
    const savedName = await onRename(video, cleanDraft)
    if (savedName) setDraft(savedName)
    setSaving(false)
  }

  const previewClass = video.aspectRatio === '9:16' || video.aspectRatio === '3:4'
    ? 'portrait'
    : video.aspectRatio === '1:1' ? 'square' : 'landscape'
  const downloadName = video.name.toLocaleLowerCase().endsWith('.mp4')
    ? video.name
    : `${video.name}.mp4`

  return (
    <article className="videoLibraryItem">
      <div className={`videoLibraryPreview ${previewClass}`}>
        <BufferedVideo source={video.url} playsInline />
      </div>
      <div className="videoLibraryDetails">
        <div className="videoSourceHeading">
          <span>
            <strong>分镜 {String(storyboard.episodeSceneNumber || storyboard.sceneNumber).padStart(2, '0')} · {storyboard.title}</strong>
            <small>{video.sourceStoryboardIds.length > 1 ? `组合分镜 ${sourceNumbers}` : `来源分镜 ${sourceNumbers}`}</small>
          </span>
          {video.isSelected ? <em><Check size={13} />当前选用</em> : null}
        </div>

        <label className="videoNameField">
          视频名称
          <span>
            <input
              value={draft}
              maxLength={120}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveName()
                }
              }}
              aria-invalid={Boolean(nameError)}
            />
            <button
              className="iconButton"
              type="button"
              onClick={() => void saveName()}
              disabled={!changed || Boolean(nameError) || saving}
              title="保存视频名称"
              aria-label="保存视频名称"
            >
              {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            </button>
          </span>
          {nameError ? <small className="fieldError">{nameError}</small> : null}
        </label>

        <div className="videoMetadata">
          <span>{formatSeconds(video.duration)}</span>
          <span>{video.resolution}</span>
          <span>{video.aspectRatio}</span>
          <span title={video.model}>{video.model}</span>
          {createdLabel ? <span>{createdLabel}</span> : null}
        </div>

        <div className="videoLibraryActions">
          <button className="quietButton compact" type="button" onClick={() => onOpenStoryboard(projectId, storyboard.id)}>
            <Film size={15} />查看分镜
          </button>
          <a className="primaryButton compact" href={video.downloadUrl} download={downloadName}>
            <Download size={16} />下载视频
          </a>
        </div>
      </div>
    </article>
  )
}

function AssetLibrary({
  activeProjectId,
  assets,
  selectedAsset,
  selectedTask,
  filterType,
  query,
  loading,
  batchSubmitting,
  onFilterType,
  onQuery,
  onSelect,
  onRefresh,
  onCreated,
  onError,
  onNotice,
  onSave,
  onDelete,
  onGenerate,
  onUploadImage,
  onGenerateAll,
  onSelectImage,
}: {
  activeProjectId: string | null
  assets: AssetRecord[]
  selectedAsset: AssetRecord | null
  selectedTask?: TaskRecord
  filterType: AssetType | 'all'
  query: string
  loading: boolean
  batchSubmitting: boolean
  onFilterType: (type: AssetType | 'all') => void
  onQuery: (query: string) => void
  onSelect: (id: string) => void
  onRefresh: () => void
  onCreated: (asset: AssetRecord, task: TaskRecord | null) => Promise<void>
  onError: (message: string) => void
  onNotice: (message: string, tone?: Toast['tone']) => void
  onSave: (asset: AssetRecord, patch: Partial<AssetRecord> & { tags?: string[] }) => Promise<void>
  onDelete: (asset: AssetRecord) => Promise<void>
  onGenerate: (asset: AssetRecord, prompt?: string) => Promise<void>
  onUploadImage: (asset: AssetRecord, file: File) => Promise<boolean>
  onGenerateAll: () => Promise<void>
  onSelectImage: (asset: AssetRecord, image: AssetImage) => Promise<void>
  }) {
  const [form, setForm] = useState({
    type: 'character' as AssetType,
    prompt: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const generatingAssetCount = assets.filter((asset) => (
    asset.latestTask?.status === 'queued' || asset.latestTask?.status === 'processing'
  )).length

  async function createAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeProjectId) return
    setSubmitting(true)
    try {
      const payload = await requestJson<{ asset: AssetRecord, task: TaskRecord | null }>('/api/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProjectId,
          type: form.type,
          prompt: form.prompt,
          generateImmediately: true,
        }),
      })
      setForm({
        type: form.type,
        prompt: '',
      })
      await onCreated(payload.asset, payload.task)
    } catch (error) {
      onError(error instanceof Error ? error.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="assetWorkspace">
      <aside className="composerPanel">
        <div className="panelHeading">
          <span><Sparkles size={17} /><strong>生成资产</strong></span>
        </div>
        <form className="assetForm" onSubmit={createAsset}>
          <div className="typePicker" aria-label="资产类型">
            {typeOptions.map((type) => (
              <button
                key={type}
                data-asset-type={type}
                className={form.type === type ? 'active' : ''}
                type="button"
                onClick={() => setForm((current) => ({ ...current, type }))}
              >
                <TypeIcon type={type} />{typeLabels[type]}
              </button>
            ))}
          </div>
          <label className="assetPromptField">
            {typeLabels[form.type]}提示词
            <textarea
              data-assistant-target="asset-prompt"
              value={form.prompt}
              onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
              rows={10}
              placeholder={assetPromptPlaceholders[form.type]}
              required
            />
          </label>
          <button className="primaryButton" type="submit" disabled={submitting || !form.prompt.trim()}>
            {submitting ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
            {submitting ? `正在生成${typeLabels[form.type]}` : `生成${typeLabels[form.type]}`}
          </button>
        </form>
      </aside>

      <section className="assetBrowser">
        <div className="assetBrowserChrome">
          <div className="assetBrowserHeading">
            <span>
              <span className="assetBrowserHeadingIcon"><Layers3 size={16} /></span>
              <span>
                <strong>项目资产</strong>
                <small>当前显示 {assets.length} 项，选择卡片后在右侧编辑</small>
              </span>
            </span>
            <span className={`assetBrowserStatus ${generatingAssetCount > 0 ? 'busy' : ''}`} role="status">
              {generatingAssetCount > 0 ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {generatingAssetCount > 0 ? `${generatingAssetCount} 项生成中` : '资产已同步'}
            </span>
          </div>
          <div className="browserToolbar">
            <div className="searchBox">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="搜索资产"
              />
            </div>
            <div className="filterTabs">
              {(['all', ...typeOptions] as Array<AssetType | 'all'>).map((type) => (
                <button
                  key={type}
                  className={filterType === type ? 'active' : ''}
                  type="button"
                  onClick={() => onFilterType(type)}
                >
                  {typeLabels[type]}
                </button>
              ))}
            </div>
            <button
              className="quietButton batchAssetButton"
              type="button"
              disabled={batchSubmitting || !activeProjectId}
              onClick={() => void onGenerateAll()}
            >
              {batchSubmitting ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
              {batchSubmitting ? '正在统一入队' : '一键生成全部资产'}
            </button>
            <button className="iconButton" onClick={onRefresh} title="刷新" type="button">
              {loading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            </button>
          </div>
        </div>

        {assets.length > 0 ? (
          <div className="assetGrid">
            {assets.map((asset) => {
              const image = imageFor(asset)
              const downloadableImage = assetImageFor(asset)
              const generating = asset.latestTask?.status === 'queued' || asset.latestTask?.status === 'processing'
              return (
                <div className="assetTileShell" key={asset.id}>
                  <button
                    className={`assetTile ${selectedAsset?.id === asset.id ? 'selected' : ''}`}
                    onClick={() => onSelect(asset.id)}
                    type="button"
                  >
                    <span className="assetThumb">
                      {image ? <img src={image} alt={asset.name} loading="lazy" decoding="async" /> : <ImageIcon size={30} />}
                      {generating ? <span className="assetGenerating"><Loader2 className="spin" size={14} />生成中</span> : null}
                    </span>
                    <span className="assetTileBody">
                      <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
                      <strong title={asset.name}>{asset.name}</strong>
                      <small>{asset.tags.slice(0, 2).join(' · ') || '未添加标签'}</small>
                    </span>
                  </button>
                  {downloadableImage ? (
                    <a
                      aria-label={`下载${asset.name}图片`}
                      className="assetTileDownload"
                      href={`/api/media/${encodeURIComponent(downloadableImage.mediaId)}?download=1`}
                      title="下载图片"
                    >
                      <Download size={16} />
                    </a>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="emptyState">
            <PackageOpen size={38} />
            <strong>还没有匹配的资产</strong>
          </div>
        )}
      </section>

      <aside className="inspectorPanel">
        {selectedAsset ? (
          <AssetDetail
            asset={selectedAsset}
            selectedTask={selectedTask}
            onNotice={onNotice}
            onSave={onSave}
            onDelete={onDelete}
            onGenerate={onGenerate}
            onUploadImage={onUploadImage}
            onSelectImage={onSelectImage}
          />
        ) : (
          <div className="emptyState"><ImageIcon size={38} /><strong>选择一个资产</strong></div>
        )}
      </aside>
    </section>
  )
}

function AssetDetail({
  asset,
  selectedTask,
  onNotice,
  onSave,
  onDelete,
  onGenerate,
  onUploadImage,
  onSelectImage,
}: {
  asset: AssetRecord
  selectedTask?: TaskRecord
  onNotice: (message: string, tone?: Toast['tone']) => void
  onSave: (asset: AssetRecord, patch: Partial<AssetRecord> & { tags?: string[] }) => Promise<void>
  onDelete: (asset: AssetRecord) => Promise<void>
  onGenerate: (asset: AssetRecord, prompt?: string) => Promise<void>
  onUploadImage: (asset: AssetRecord, file: File) => Promise<boolean>
  onSelectImage: (asset: AssetRecord, image: AssetImage) => Promise<void>
}) {
  const [draft, setDraft] = useState({
    name: asset.name,
    type: asset.type,
    description: asset.description,
    tags: asset.tags.join('，'),
    prompt: asset.prompt || '',
    videoPrompt: asset.videoPrompt || '',
  })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [submittingGeneration, setSubmittingGeneration] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setSubmittingGeneration(false)
    setDraft({
      name: asset.name,
      type: asset.type,
      description: asset.description,
      tags: asset.tags.join('，'),
      prompt: asset.prompt || '',
      videoPrompt: asset.videoPrompt || '',
    })
  }, [asset])

  const generating = selectedTask?.status === 'queued' || selectedTask?.status === 'processing'
  const retrying = generating && Boolean(selectedTask?.error)
  const generationBusy = submittingGeneration || generating
  const mainImage = imageFor(asset)
  const mainAssetImage = assetImageFor(asset)

  async function save() {
    setSaving(true)
    await onSave(asset, {
      name: draft.name,
      type: draft.type,
      description: draft.description,
      tags: parseTags(draft.tags),
      prompt: draft.prompt,
      videoPrompt: draft.videoPrompt,
    })
    setSaving(false)
  }

  async function uploadImage(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setUploading(true)
    await onUploadImage(asset, file)
    setUploading(false)
    input.value = ''
  }

  async function generateImage() {
    if (generationBusy) return
    setSubmittingGeneration(true)
    try {
      await onGenerate(asset, draft.prompt)
    } finally {
      setSubmittingGeneration(false)
    }
  }

  return (
    <div className="detailStack">
      <div className="detailHeader">
        <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
        <div className="detailActions">
          {mainAssetImage ? (
            <a
              aria-label={`下载${asset.name}图片`}
              className="iconButton"
              href={`/api/media/${encodeURIComponent(mainAssetImage.mediaId)}?download=1`}
              title="下载当前图片"
            >
              <Download size={17} />
            </a>
          ) : null}
          <button className="iconButton danger" onClick={() => void onDelete(asset)} title="删除资产" type="button">
            <Trash2 size={17} />
          </button>
          <button className="iconButton" onClick={() => void save()} title="保存资产" type="button" disabled={saving}>
            {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
          </button>
        </div>
      </div>

      <div className="assetHeroPreview">
        {mainImage ? (
          <img src={mainImage} alt={asset.name} decoding="async" fetchPriority="high" />
        ) : (
          <span className="assetHeroEmpty">
            <ImageIcon size={38} />
            <strong>{generationBusy ? '图片生成中' : '尚未生成'}</strong>
            <small>{generationBusy ? '完成后会自动显示在这里' : '生成或上传一张资产图片'}</small>
          </span>
        )}
        {asset.selectedImageId ? <span className="selectedMark"><Check size={14} />主图</span> : null}
      </div>

      <label>
        名称
        <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
      </label>
      <div className="twoFields">
        <label>
          类型
          <select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as AssetType }))}>
            {typeOptions.map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}
          </select>
        </label>
        <label>
          标签
          <input value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} />
        </label>
      </div>
      <label>
        形象描述
        <textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} rows={4} />
      </label>
      <label>
        生图提示词
        <textarea value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} rows={6} />
      </label>

      {asset.type === 'character' ? (
        <CharacterPerformanceProfilesPanel
          assetId={asset.id}
          characterName={asset.name}
          onNotice={onNotice}
        />
      ) : null}

      <div className="assetImageActions">
        <input
          ref={uploadInputRef}
          className="visuallyHidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => void uploadImage(event)}
        />
        <button
          className="quietButton"
          disabled={uploading}
          onClick={() => uploadInputRef.current?.click()}
          title="上传 JPG、PNG 或 WebP，最大 20MB"
          type="button"
        >
          {uploading ? <Loader2 className="spin" size={17} /> : <Upload size={17} />}
          {uploading ? '正在上传' : '上传已有图片'}
        </button>
        <button
          className="primaryButton"
          data-assistant-target="generate-image"
          disabled={generationBusy}
          onClick={() => void generateImage()}
          type="button"
        >
          {generationBusy ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          {submittingGeneration
            ? '正在提交'
            : retrying
              ? '自动重试中'
              : generating
                ? '生成中'
                : selectedTask?.status === 'failed' ? '重新生成' : '生成新图片'}
        </button>
      </div>

      <p className="generationEstimate">通常约 1–3 分钟；服务拥堵时会自动重新排队，最长可能接近 10 分钟。关闭页面也会在服务器继续。</p>

      {retrying ? <p className="pendingText">{selectedTask?.error}</p> : null}
      {selectedTask?.status === 'failed' ? <p className="errorText">{selectedTask.error || '生成失败'}</p> : null}

      <div className="variantSection">
        <div className="sectionLabel"><strong>图片版本</strong><span>{asset.images.length}</span></div>
        <div className="imageStrip">
          {asset.images.map((image) => (
            <div className="variantItem" key={image.id}>
              <button
                className={`variantButton ${image.isSelected ? 'chosen' : ''}`}
                onClick={() => void onSelectImage(asset, image)}
                title="设为主图"
                type="button"
              >
                <img src={image.url} alt={`${asset.name} 版本 ${image.variant}`} loading="lazy" decoding="async" />
                {image.isSelected ? <span><Check size={14} /></span> : null}
              </button>
              <a
                aria-label={`下载${asset.name}版本${image.variant}`}
                className="variantDownloadButton"
                href={`/api/media/${encodeURIComponent(image.mediaId)}?download=1`}
                title="下载这个版本"
              >
                <Download size={14} />
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StoryboardWorkspace({
  visualStyle,
  projectAssets,
  storyboards,
  selectedStoryboard,
  selectedTask,
  videoModels,
  defaultVideoModel,
  videoPriceNotice,
  videoModelsRefreshedAt,
  videoModelsRefreshing,
  onRefreshVideoModels,
  activeVideoStoryboardIds,
  creating,
  onCreating,
  onSelect,
  onCreate,
  onSave,
  onUpdateAssetLink,
  onRestoreRevision,
  onDelete,
  onGenerate,
  onGenerateGroup,
  onCancelTask,
  onSelectVideo,
  onNotice,
}: {
  visualStyle: VisualStyle
  projectAssets: AssetRecord[]
  storyboards: StoryboardRecord[]
  selectedStoryboard: StoryboardRecord | null
  selectedTask?: TaskRecord | null
  videoModels: VideoModelOption[]
  defaultVideoModel: string
  videoPriceNotice: string
  videoModelsRefreshedAt: string | null
  videoModelsRefreshing: boolean
  onRefreshVideoModels: () => void
  activeVideoStoryboardIds: Set<string>
  creating: boolean
  onCreating: (value: boolean) => void
  onSelect: (id: string) => void
  onCreate: (input: {
    title: string
    videoPrompt: string
    notes: string | null
    duration: number
    aspectRatio: StoryboardAspectRatio
    generateAudio: boolean
  }) => Promise<StoryboardRecord | null>
  onSave: (storyboard: StoryboardRecord, patch: Partial<StoryboardRecord>) => Promise<StoryboardRecord | null>
  onUpdateAssetLink: (storyboardId: string, assetId: string, action: 'add' | 'remove', videoPrompt: string) => Promise<StoryboardRecord | null>
  onRestoreRevision: (storyboard: StoryboardRecord, revisionId: string) => Promise<StoryboardRecord | null>
  onDelete: (storyboard: StoryboardRecord) => Promise<void>
  onGenerate: (storyboard: StoryboardRecord, settings: {
    duration: number
    aspectRatio: StoryboardAspectRatio
    resolution: VideoResolution
    generateAudio: boolean
    model: string
    continuityFrameMediaId?: string
    continuitySourceVideoId?: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
  onGenerateGroup: (storyboardIds: string[], settings: {
    duration: number
    resolution: VideoResolution
    generateAudio?: boolean
    model: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
  onCancelTask: (task: TaskRecord) => Promise<TaskRecord | null>
  onSelectVideo: (storyboard: StoryboardRecord, video: StoryboardVideo) => Promise<void>
  onNotice: (text: string, tone?: Toast['tone']) => void
}) {
  const episodeGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string
      label: string
      episodeNumber: number
      storyboards: StoryboardRecord[]
    }>()
    for (const storyboard of storyboards) {
      const key = storyboard.episodeId || 'unassigned'
      const episodeNumber = storyboard.episode?.episodeNumber ?? Number.MAX_SAFE_INTEGER
      const label = storyboard.episode
        ? `第 ${storyboard.episode.episodeNumber} 集 · ${storyboard.episode.title}`
        : '未分集镜头'
      const group = groups.get(key) || { key, label, episodeNumber, storyboards: [] }
      group.storyboards.push(storyboard)
      groups.set(key, group)
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        storyboards: [...group.storyboards].sort((left, right) => (
          (left.episodeSceneNumber || left.sceneNumber) - (right.episodeSceneNumber || right.sceneNumber)
        )),
      }))
      .sort((left, right) => left.episodeNumber - right.episodeNumber)
  }, [storyboards])
  const selectedEpisodeKey = selectedStoryboard?.episodeId || (selectedStoryboard ? 'unassigned' : '')
  const initialEpisodeKey = selectedEpisodeKey || episodeGroups[0]?.key || ''
  const [openEpisodeKeys, setOpenEpisodeKeys] = useState<string[]>(initialEpisodeKey ? [initialEpisodeKey] : [])
  const [batchIds, setBatchIds] = useState<string[]>([])
  const [batchModel, setBatchModel] = useState(defaultVideoModel)
  const [batchDuration, setBatchDuration] = useState(15)
  const [batchResolution, setBatchResolution] = useState<VideoResolution>(DEFAULT_VIDEO_RESOLUTION)
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [draggingStoryboardId, setDraggingStoryboardId] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const selectedBatchModel = videoModels.find((model) => model.id === batchModel) || null
  const batchRequiresHumanFaceReferences = usesLiveActionFaces(visualStyle) && storyboards.some((storyboard) => (
    batchIds.includes(storyboard.id)
    && storyboard.assets.some((asset) => asset.type === 'character' && asset.hasSelectedImage)
  ))
  const batchUsesTextOnlyCharacters = Boolean(
    selectedBatchModel
    && batchRequiresHumanFaceReferences
    && !selectedBatchModel.supportsHumanFaceReferences,
  )

  useEffect(() => {
    if (!selectedEpisodeKey) return
    setOpenEpisodeKeys((current) => current.includes(selectedEpisodeKey)
      ? current
      : [...current, selectedEpisodeKey])
  }, [selectedEpisodeKey, selectedStoryboard?.id])

  useEffect(() => {
    const availableEpisodeKeys = new Set(episodeGroups.map((group) => group.key))
    const availableStoryboardIds = new Set(storyboards.map((storyboard) => storyboard.id))
    setOpenEpisodeKeys((current) => current.filter((key) => availableEpisodeKeys.has(key)))
    setBatchIds((current) => current.filter((id) => availableStoryboardIds.has(id)))
  }, [episodeGroups, storyboards])

  useEffect(() => {
    const usableModel = selectedBatchModel && selectedBatchModel.available !== false
      ? selectedBatchModel
      : videoModels.find((model) => model.id === defaultVideoModel && model.available !== false)
        || videoModels.find((model) => model.available !== false)
    if (!usableModel) return
    setBatchModel(usableModel.id)
    setBatchResolution((current) => usableModel.resolutions.includes(current)
      ? current
      : usableModel.defaultResolution)
    setBatchDuration((current) => normalizeVideoDuration(
      current,
      usableModel.minimumDuration,
      usableModel.maximumDuration,
      usableModel.supportedDurations,
    ))
  }, [defaultVideoModel, selectedBatchModel, videoModels])

  const batchEpisode = episodeGroups.find((group) => (
    group.storyboards.some((storyboard) => batchIds.includes(storyboard.id))
  )) || null
  const batchStoryboards = batchEpisode?.storyboards.filter((storyboard) => batchIds.includes(storyboard.id)) || []
  const storyboardNumbers = batchStoryboards.map((storyboard) => (
    storyboard.episodeSceneNumber || storyboard.sceneNumber
  ))
  const nonContiguous = storyboardNumbers.some((number, index) => (
    index > 0 && number !== storyboardNumbers[index - 1] + 1
  ))
  const mixedAspectRatios = new Set(batchStoryboards.map((storyboard) => storyboard.aspectRatio)).size > 1
  const unsupportedRatioCount = selectedBatchModel
    ? batchStoryboards.filter((storyboard) => !selectedBatchModel.aspectRatios.includes(storyboard.aspectRatio)).length
    : 0
  const sourceBatchDuration = batchStoryboards.reduce((total, storyboard) => total + storyboard.duration, 0)
  const fittedBatch = fitVideoGroupDurations(
    batchStoryboards.map((storyboard) => storyboard.duration),
    selectedBatchModel?.maximumDuration || 15,
    selectedBatchModel?.supportedDurations || null,
    selectedBatchModel?.minimumDuration || 1,
    batchDuration,
  )
  const effectiveBatchDuration = batchStoryboards.length > 0 ? fittedBatch.duration : batchDuration
  const batchDurationSteps = videoDurationOptions(
    selectedBatchModel?.minimumDuration || 4,
    selectedBatchModel?.maximumDuration || 15,
    selectedBatchModel?.supportedDurations || null,
  )
  const batchDurationStepIndex = Math.max(0, batchDurationSteps.indexOf(batchDuration))
  const batchValidationError = batchStoryboards.length > 1 && batchStoryboards.some((storyboard) => !storyboard.episodeId)
    ? '组合视频只能使用同一集内已归档的分镜'
    : nonContiguous ? '请选择同一集内连续相邻的分镜'
      : mixedAspectRatios ? '同一条组合视频中的分镜必须使用相同画幅'
        : sourceBatchDuration > (selectedBatchModel?.maximumDuration || 15)
          ? `所选分镜原始时长共 ${sourceBatchDuration} 秒，超过当前模型的 ${(selectedBatchModel?.maximumDuration || 15)} 秒上限`
          : ''
  const batchPrice = selectedBatchModel
    ? videoPriceAmount(selectedBatchModel, effectiveBatchDuration)
    : 0
  const batchTime = selectedBatchModel
    ? estimateVideoGenerationSeconds(selectedBatchModel.family, effectiveBatchDuration)
    : { minimum: 0, maximum: 0 }

  const generatedVideoStoryboardIds = new Set(storyboards.flatMap((storyboard) => (
    storyboard.videos.flatMap((video) => video.sourceStoryboardIds?.length
      ? video.sourceStoryboardIds
      : [storyboard.id])
  )))
  const batchActionError = unsupportedRatioCount > 0
    ? `当前模型不支持其中 ${unsupportedRatioCount} 个分镜的画幅`
    : batchValidationError
  const previousStoryboard = selectedStoryboard
    ? previousStoryboardInSequence(storyboards, selectedStoryboard)
    : previousStoryboardInSequence([
        ...storyboards,
        {
          id: '__new_storyboard__',
          projectId: storyboards[0]?.projectId || '',
          episodeId: null,
          episodeSceneNumber: null,
          generatedByAI: false,
          episode: null,
          title: '',
          sceneNumber: storyboards.length + 1,
          notes: null,
          imagePrompt: null,
          videoPrompt: null,
          continuityIn: null,
          continuityOut: null,
          duration: 15,
          aspectRatio: '16:9',
          generateAudio: true,
          selectedVideoId: null,
          updatedAt: '',
          assets: [],
          videos: [],
          latestTask: null,
        } satisfies StoryboardRecord,
      ], { id: '__new_storyboard__' })
  function toggleEpisode(episodeKey: string) {
    setOpenEpisodeKeys((current) => current.includes(episodeKey)
      ? current.filter((key) => key !== episodeKey)
      : [...current, episodeKey])
  }

  function addStoryboardToBatch(storyboard: StoryboardRecord) {
    if (batchIds.includes(storyboard.id)) return
    if (batchIds.length >= 4) {
      onNotice('一条组合视频最多放入 4 个分镜', 'error')
      return
    }
    const episodeKey = storyboard.episodeId || 'unassigned'
    if (batchEpisode && batchEpisode.key !== episodeKey) {
      onNotice('组合区只能放入同一集的分镜', 'error')
      return
    }
    setBatchIds((current) => [...current, storyboard.id])
  }

  function toggleStoryboard(storyboard: StoryboardRecord) {
    if (batchIds.includes(storyboard.id)) {
      setBatchIds((current) => current.filter((id) => id !== storyboard.id))
      return
    }
    addStoryboardToBatch(storyboard)
  }

  function dropStoryboard(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDropActive(false)
    const storyboardId = event.dataTransfer.getData('application/x-storyboard-id')
      || event.dataTransfer.getData('text/plain')
    const storyboard = storyboards.find((item) => item.id === storyboardId)
    if (storyboard) addStoryboardToBatch(storyboard)
  }

  async function generateBatch() {
    if (!selectedBatchModel || batchStoryboards.length === 0 || unsupportedRatioCount > 0 || batchValidationError) return
    setBatchSubmitting(true)
    const task = batchStoryboards.length === 1
      ? await onGenerate(batchStoryboards[0], {
          duration: effectiveBatchDuration,
          aspectRatio: batchStoryboards[0].aspectRatio,
          resolution: batchResolution,
          generateAudio: selectedBatchModel.supportsAudio && batchStoryboards[0].generateAudio,
          model: selectedBatchModel.id,
        }, true)
      : await onGenerateGroup(batchStoryboards.map((storyboard) => storyboard.id), {
          duration: effectiveBatchDuration,
          resolution: batchResolution,
          generateAudio: selectedBatchModel.supportsAudio && batchStoryboards.some((storyboard) => storyboard.generateAudio),
          model: selectedBatchModel.id,
        }, true)
    setBatchSubmitting(false)
    if (task) {
      setBatchIds([])
      onNotice(`已提交 1 条 ${effectiveBatchDuration} 秒组合视频，共包含 ${batchStoryboards.length} 个分镜`)
    } else {
      onNotice('所选视频任务未能加入队列，请检查资产主图和提示词', 'error')
    }
  }

  return (
    <section className="storyboardWorkspace">
      <div className="batchVideoBar" aria-label="分镜组合视频生成">
        <div className="batchComposer">
          <div className="batchVideoSummary">
            <span><ListVideo size={17} /><strong>15 秒分镜组合区</strong></span>
            <small>{batchEpisode?.label || '从下方拖入分镜'} · {batchStoryboards.length}/4 镜 · 场景可以不同</small>
          </div>
          <div
            className={`storyboardDropzone ${dropActive ? 'dragOver' : ''} ${batchStoryboards.length >= 4 ? 'full' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault()
              setDropActive(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDropActive(true)
            }}
            onDragLeave={() => setDropActive(false)}
            onDrop={dropStoryboard}
          >
            {batchStoryboards.length === 0 ? (
              <div className="dropzoneEmpty">
                <GripVertical size={22} />
                <span><strong>把相邻短分镜拖到这里</strong><small>同一集最多 4 镜，总时长不超过 15 秒，可跨场景</small></span>
              </div>
            ) : (
              <div className="batchStoryboardTokens">
                {batchStoryboards.map((storyboard) => (
                  <div className="batchStoryboardToken" key={storyboard.id}>
                    <GripVertical size={15} />
                    <span>
                      <strong>分镜 {String(storyboard.episodeSceneNumber || storyboard.sceneNumber).padStart(2, '0')} · {storyboard.duration}s</strong>
                      <small title={storyboard.title}>{storyboard.title}</small>
                    </span>
                    <button
                      type="button"
                      title="移出组合区"
                      aria-label={`移出分镜 ${storyboard.episodeSceneNumber || storyboard.sceneNumber}`}
                      onClick={() => setBatchIds((current) => current.filter((id) => id !== storyboard.id))}
                    ><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <span className="batchSlotCount">{sourceBatchDuration || 0}/15s</span>
          </div>
        </div>

        <div className="batchSettingsGrid">
          <div className="batchModelControl">
            <label>
              视频模型
              <select value={batchModel} onChange={(event) => setBatchModel(event.target.value)}>
                {videoModels.length === 0 ? <option value={batchModel}>正在读取模型…</option> : null}
                <VideoModelSelectOptions models={videoModels} />
              </select>
            </label>
            <button
              className="iconButton modelRefreshButton"
              type="button"
              title="立即刷新可用模型与价格"
              aria-label="立即刷新可用模型与价格"
              disabled={videoModelsRefreshing}
              onClick={onRefreshVideoModels}
            >
              <RefreshCw className={videoModelsRefreshing ? 'spin' : ''} size={15} />
            </button>
            <small title={videoPriceNotice}>
              {selectedBatchModel?.priceSource === 'live' ? '实时价' : '参考价'} · {formatModelRefreshTime(videoModelsRefreshedAt)}
            </small>
            {batchUsesTextOnlyCharacters ? <small className="batchVideoError">保留音频，不上传人物脸图；人物将按文字设定生成。</small> : null}
          </div>

          <div className="batchDurationControl durationControl">
            <span>成片时长 <strong>{effectiveBatchDuration}s</strong></span>
            <div className="durationSlider">
              <input
                type="range"
                min={0}
                max={Math.max(0, batchDurationSteps.length - 1)}
                step={1}
                value={batchDurationStepIndex}
                aria-label="组合视频时长"
                aria-valuetext={`${effectiveBatchDuration} 秒`}
                onChange={(event) => {
                  const duration = batchDurationSteps[Number(event.target.value)] || batchDurationSteps[0]
                  setBatchDuration(duration)
                }}
              />
              <div
                className="durationScale"
                style={{ gridTemplateColumns: `repeat(${batchDurationSteps.length}, minmax(0, 1fr))` }}
                aria-hidden="true"
              >
                {batchDurationSteps.map((duration) => (
                  <span className={duration === effectiveBatchDuration ? 'active' : ''} key={duration}>
                    {duration === batchDuration
                      || duration === batchDurationSteps[0]
                      || duration === batchDurationSteps[batchDurationSteps.length - 1]
                      ? `${duration}s`
                      : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <label className="batchResolutionControl">
            清晰度
            <select
              value={batchResolution}
              onChange={(event) => setBatchResolution(event.target.value as VideoResolution)}
            >
              {(selectedBatchModel?.resolutions || [batchResolution]).map((resolution) => (
                <option key={resolution} value={resolution}>{resolution === '1080p' ? 'Full HD 1080p' : resolution === '720p' ? 'HD 720p' : '标准 480p'}</option>
              ))}
            </select>
          </label>

          <div className="batchVideoEstimate" aria-live="polite">
            <strong>预计 ¥{batchPrice.toFixed(2)}</strong>
            <small>{batchStoryboards.length > 0
              ? formatMinuteRange(batchTime.minimum, batchTime.maximum)
              : '放入分镜后生成'}</small>
          </div>

          <button
            className="primaryButton compact batchGenerateButton"
            type="button"
            disabled={batchSubmitting
              || batchStoryboards.length === 0
              || !selectedBatchModel
              || selectedBatchModel.available === false
              || Boolean(batchActionError)}
            onClick={() => void generateBatch()}
          >
            {batchSubmitting ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
            {batchSubmitting ? '正在加入队列' : '生成组合视频'}
          </button>
        </div>
        {batchActionError ? <small className="batchVideoError">{batchActionError}</small> : null}
      </div>

      <aside className="sceneRail">
        <div className="panelHeading">
          <span><Film size={17} /><strong>分镜</strong></span>
          <button className="iconButton small" type="button" title="新建分镜" onClick={() => onCreating(true)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="episodeAccordion">
          {episodeGroups.map((group) => {
            const open = openEpisodeKeys.includes(group.key)
            const selectedCount = group.storyboards.filter((storyboard) => batchIds.includes(storyboard.id)).length
            const contentId = `episode-storyboards-${group.key}`
            return (
              <section className={`episodeGroup ${open ? 'open' : ''}`} key={group.key}>
                <button
                  className="episodeToggle"
                  type="button"
                  aria-expanded={open}
                  aria-controls={contentId}
                  onClick={() => toggleEpisode(group.key)}
                >
                  <ChevronRight className="episodeChevron" size={17} />
                  <span className="episodeTitle" title={group.label}>
                    <strong>{group.label}</strong>
                    <small>{group.storyboards.length} 个分镜{selectedCount > 0 ? ` · 已选 ${selectedCount}` : ''}</small>
                  </span>
                  <span className="episodeCount">{group.storyboards.length}</span>
                </button>
                {open ? (
                  <div className="episodeStoryboardList" id={contentId}>
                    <div className="batchSelectionRow">
                      <span><GripVertical size={14} />拖动或勾选相邻分镜，可跨场景组合</span>
                      {selectedCount > 0 ? (
                        <button className="quietButton compact" type="button" onClick={() => setBatchIds([])}>清空组合</button>
                      ) : <span>最多 4 镜 / 15 秒</span>}
                    </div>
                    <div className="sceneList">
                      {group.storyboards.map((storyboard) => {
                        const task = storyboard.latestTask
                        const active = activeVideoStoryboardIds.has(storyboard.id)
                        const status = active || task?.status === 'queued' || task?.status === 'processing'
                          ? '生成中'
                          : task?.status === 'failed'
                              ? /VIDEO_TASK_CANCELLED/iu.test(task.error || '') ? '已取消' : '失败'
                              : generatedVideoStoryboardIds.has(storyboard.id) ? '已出片' : '草稿'
                        const hasPrompt = Boolean(storyboard.videoPrompt?.trim())
                        const hasReference = storyboard.assets.some((asset) => asset.hasSelectedImage)
                        const selectable = hasPrompt && hasReference && !active
                        const unavailableReason = !hasPrompt
                          ? '请先填写并保存视频提示词'
                          : !hasReference ? '请先为已识别资产选择主图' : active ? '该分镜已在生成队列中' : ''
                        return (
                          <div
                            className={`sceneRow ${batchIds.includes(storyboard.id) ? 'checked' : ''} ${draggingStoryboardId === storyboard.id ? 'dragging' : ''}`}
                            key={storyboard.id}
                            draggable={selectable}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'copy'
                              event.dataTransfer.setData('application/x-storyboard-id', storyboard.id)
                              event.dataTransfer.setData('text/plain', storyboard.id)
                              setDraggingStoryboardId(storyboard.id)
                            }}
                            onDragEnd={() => {
                              setDraggingStoryboardId(null)
                              setDropActive(false)
                            }}
                          >
                            <span className={`sceneDragHandle ${selectable ? '' : 'disabled'}`} title={unavailableReason || '拖到上方组合区'}>
                              <GripVertical size={15} />
                            </span>
                            <label className="sceneBatchCheck" title={unavailableReason || '加入组合视频'}>
                              <input
                                type="checkbox"
                                checked={batchIds.includes(storyboard.id)}
                                disabled={!selectable}
                                aria-label={`选择分镜 ${storyboard.episodeSceneNumber || storyboard.sceneNumber}`}
                                onChange={() => toggleStoryboard(storyboard)}
                              />
                            </label>
                            <button
                              type="button"
                              className={!creating && selectedStoryboard?.id === storyboard.id ? 'active' : ''}
                              onClick={() => onSelect(storyboard.id)}
                            >
                              <span className="sceneNumber">{String(storyboard.episodeSceneNumber || storyboard.sceneNumber).padStart(2, '0')}</span>
                              <span className="sceneMeta"><strong>{storyboard.title}</strong><small>{status} · {storyboard.duration}s</small></span>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            )
          })}
          {episodeGroups.length === 0 ? <div className="storyboardEmpty"><Film size={30} /><strong>暂无分镜</strong></div> : null}
        </div>
      </aside>

      <StoryboardEditor
        key={creating ? 'new' : selectedStoryboard?.id || 'empty'}
        storyboard={creating ? null : selectedStoryboard}
        projectAssets={projectAssets}
        previousStoryboard={previousStoryboard}
        visualStyle={visualStyle}
        selectedTask={creating ? null : selectedTask}
        videoModels={videoModels}
        defaultVideoModel={defaultVideoModel}
        videoPriceNotice={videoPriceNotice}
        nextSceneNumber={storyboards.length + 1}
        onCancelCreate={() => onCreating(false)}
        onCreate={onCreate}
        onSave={onSave}
        onUpdateAssetLink={onUpdateAssetLink}
        onRestoreRevision={onRestoreRevision}
        onDelete={onDelete}
        onGenerate={onGenerate}
        onCancelTask={onCancelTask}
        onSelectVideo={onSelectVideo}
        onNotice={onNotice}
      />
    </section>
  )
}

function StoryboardEditor({
  storyboard,
  projectAssets,
  previousStoryboard,
  visualStyle,
  selectedTask,
  videoModels,
  defaultVideoModel,
  videoPriceNotice,
  nextSceneNumber,
  onCancelCreate,
  onCreate,
  onSave,
  onUpdateAssetLink,
  onRestoreRevision,
  onDelete,
  onGenerate,
  onCancelTask,
  onSelectVideo,
  onNotice,
}: {
  storyboard: StoryboardRecord | null
  projectAssets: AssetRecord[]
  previousStoryboard: StoryboardRecord | null
  visualStyle: VisualStyle
  selectedTask?: TaskRecord | null
  videoModels: VideoModelOption[]
  defaultVideoModel: string
  videoPriceNotice: string
  nextSceneNumber: number
  onCancelCreate: () => void
  onCreate: (input: {
    title: string
    videoPrompt: string
    notes: string | null
    duration: number
    aspectRatio: StoryboardAspectRatio
    generateAudio: boolean
  }) => Promise<StoryboardRecord | null>
  onSave: (storyboard: StoryboardRecord, patch: Partial<StoryboardRecord>) => Promise<StoryboardRecord | null>
  onUpdateAssetLink: (storyboardId: string, assetId: string, action: 'add' | 'remove', videoPrompt: string) => Promise<StoryboardRecord | null>
  onRestoreRevision: (storyboard: StoryboardRecord, revisionId: string) => Promise<StoryboardRecord | null>
  onDelete: (storyboard: StoryboardRecord) => Promise<void>
  onGenerate: (storyboard: StoryboardRecord, settings: {
    duration: number
    aspectRatio: StoryboardAspectRatio
    resolution: VideoResolution
    generateAudio: boolean
    model: string
    continuityFrameMediaId?: string
    continuitySourceVideoId?: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
  onCancelTask: (task: TaskRecord) => Promise<TaskRecord | null>
  onSelectVideo: (storyboard: StoryboardRecord, video: StoryboardVideo) => Promise<void>
  onNotice: (text: string, tone?: Toast['tone']) => void
}) {
  const [draft, setDraft] = useState({
    title: storyboard?.title || `分镜 ${nextSceneNumber}`,
    videoPrompt: storyboard?.videoPrompt || '',
    notes: storyboard?.notes || '',
    duration: storyboard?.duration || 15,
    aspectRatio: storyboard?.aspectRatio || '16:9' as StoryboardAspectRatio,
    resolution: DEFAULT_VIDEO_RESOLUTION as VideoResolution,
    generateAudio: storyboard?.generateAudio ?? true,
    model: selectedTask && (selectedTask.status === 'queued' || selectedTask.status === 'processing')
      ? selectedTask.model || defaultVideoModel
      : defaultVideoModel,
  })
  const [saving, setSaving] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [revisions, setRevisions] = useState<StoryboardRevisionRecord[]>([])
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [assetPickerQuery, setAssetPickerQuery] = useState('')
  const [assetLinkBusyId, setAssetLinkBusyId] = useState<string | null>(null)
  const [generationPhase, setGenerationPhase] = useState<VideoGenerationPhase | null>(null)
  const [cancellingGeneration, setCancellingGeneration] = useState(false)
  const generationLockRef = useRef(false)
  const previousSelectedVideo = previousStoryboard?.videos.find((video) => (
    video.id === previousStoryboard.selectedVideoId
  )) || null
  const spatialContinuity = Boolean(
    storyboard
    && previousStoryboard
    && previousSelectedVideo
    && shouldUsePreviousTailFrame(previousStoryboard, storyboard),
  )
  const [inheritPrevious, setInheritPrevious] = useState(spatialContinuity)
  const [continuityFrame, setContinuityFrame] = useState(() => previousSelectedVideo?.tailFrameMediaId
    ? {
        mediaId: previousSelectedVideo.tailFrameMediaId,
        url: previousSelectedVideo.tailFrameUrl,
      }
    : null)
  const [capturingTail, setCapturingTail] = useState(false)
  const generating = selectedTask?.status === 'queued' || selectedTask?.status === 'processing'
  const generationBusy = generationPhase !== null || generating
  const selectedVideo = storyboard?.videos.find((video) => video.id === storyboard.selectedVideoId)
    || storyboard?.videos[0]
    || null
  const selectedModel = videoModels.find((model) => model.id === draft.model) || null
  const requiresHumanFaceReferences = usesLiveActionFaces(visualStyle) && Boolean(
    storyboard?.assets.some((asset) => asset.type === 'character' && asset.hasSelectedImage),
  )
  const usesTextOnlyCharacters = Boolean(
    selectedModel
    && requiresHumanFaceReferences
    && !selectedModel.supportsHumanFaceReferences,
  )
  const maximumReferenceImages = selectedModel?.maximumReferenceImages || 4
  const maximumReferenceVideos = selectedModel?.maximumReferenceVideos || 0
  const availableAssetReferences = storyboard?.assets.filter((asset) => (
    asset.hasSelectedImage && (asset.type === 'character' || asset.type === 'location' || asset.type === 'prop')
  )) || []
  const selectedCharacterReferences = availableAssetReferences.filter((asset) => asset.type === 'character')
  const totalReferenceCapacity = maximumReferenceImages
    + maximumReferenceVideos * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
  const referenceLimitBlocked = selectedCharacterReferences.length > totalReferenceCapacity
  const continuityBlockedByReferenceLimit = selectedCharacterReferences.length >= totalReferenceCapacity
  const continuityDisabled = !previousSelectedVideo
    || usesTextOnlyCharacters
    || continuityBlockedByReferenceLimit
  const crossEpisodeSource = Boolean(
    storyboard?.episode
    && previousStoryboard?.episode
    && storyboard.episode.episodeNumber !== previousStoryboard.episode.episodeNumber,
  )
  const continuityEnabled = inheritPrevious && !continuityDisabled
  const assetReferenceSlots = Math.max(0, maximumReferenceImages - (continuityEnabled ? 1 : 0))
  const assetReferenceCapacity = assetReferenceSlots
    + maximumReferenceVideos * REFERENCE_MONTAGE_IMAGES_PER_VIDEO
  const eligibleAssetReferences = availableAssetReferences.filter((asset) => (
    (!continuityEnabled || asset.type !== 'location')
  ))
  const plannedAssetReferences = prioritizeVideoReferenceAssets(
    eligibleAssetReferences,
    assetReferenceCapacity,
    continuityEnabled,
  )
  const videoReferencePlan = planVideoReferences(
    plannedAssetReferences.map((asset) => asset.id),
    assetReferenceSlots,
    maximumReferenceVideos,
  )
  const plannedAssetsById = new Map(plannedAssetReferences.map((asset) => [asset.id, asset]))
  const submittedAssetReferences = videoReferencePlan.imageMediaIds
    .map((assetId) => plannedAssetsById.get(assetId)!)
    .filter(Boolean)
  const videoReferenceAssetGroups = videoReferencePlan.videoGroups.map((group) => (
    group.map((assetId) => plannedAssetsById.get(assetId)!).filter(Boolean)
  ))
  const videoReferenceGroupByAssetId = new Map(videoReferenceAssetGroups.flatMap((group, groupIndex) => (
    group.map((asset) => [asset.id, groupIndex + 1] as const)
  )))
  const submittedAssetReferenceOrder = new Map(
    submittedAssetReferences.map((asset, index) => [asset.id, index + 1]),
  )
  const submittedImageReferenceCount = submittedAssetReferences.length
    + (continuityEnabled ? 1 : 0)
  const linkedAssetIds = new Set(storyboard?.assets.map((asset) => asset.id) || [])
  const normalizedAssetPickerQuery = assetPickerQuery.trim().toLocaleLowerCase()
  const pickerAssets = projectAssets
    .filter((asset) => asset.type === 'character' || asset.type === 'location' || asset.type === 'prop')
    .filter((asset) => !linkedAssetIds.has(asset.id))
    .filter((asset) => !normalizedAssetPickerQuery || [
      asset.name,
      asset.description,
      ...asset.tags,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedAssetPickerQuery)))
  const usesTextSceneReference = !continuityEnabled
    && availableAssetReferences.some((asset) => asset.type === 'location')
    && !plannedAssetReferences.some((asset) => asset.type === 'location')
  const previousStoryboardLabel = previousStoryboard
    ? `${previousStoryboard.episode ? `第 ${previousStoryboard.episode.episodeNumber} 集 · ` : ''}分镜 ${String(
        previousStoryboard.episodeSceneNumber || previousStoryboard.sceneNumber,
      ).padStart(2, '0')}`
    : '无上一镜'
  const availableResolutions = selectedModel?.resolutions || [draft.resolution]
  const availableAspectRatios = selectedModel?.aspectRatios || [draft.aspectRatio]
  const durationSteps = videoDurationOptions(
    selectedModel?.minimumDuration || 4,
    selectedModel?.maximumDuration || 15,
    selectedModel?.supportedDurations || null,
  )
  const durationStepIndex = Math.max(0, durationSteps.indexOf(draft.duration))
  const promptDirty = Boolean(storyboard) && draft.videoPrompt !== (storyboard?.videoPrompt || '')
  const generationTime = selectedModel
    ? estimateVideoGenerationSeconds(selectedModel.family, draft.duration)
    : null
  const generationStatusTitle = generationPhase === 'saving'
    ? '正在保存分镜'
    : generationPhase === 'capturing_tail'
      ? '正在截取上一镜尾帧'
      : generationPhase === 'submitting'
        ? '正在提交视频任务'
        : generationPhase === 'queued' || selectedTask?.status === 'queued'
          ? '已加入生成队列'
          : selectedTask?.status === 'processing'
            ? `正在生成视频 ${selectedTask.progress || 0}%`
            : ''
  const generationStatusDetail = generationPhase === 'saving'
    ? '点击已接收，正在保存最新分镜设置，请勿重复点击。'
    : generationPhase === 'capturing_tail'
      ? '正在截取并上传上一镜尾帧，完成后会自动提交视频任务。'
      : generationPhase === 'submitting'
        ? '正在创建后台任务，请勿重复点击。'
        : '任务已进入后台，离开页面不会中断。'

  useEffect(() => {
    const usableModel = selectedModel && selectedModel.available !== false
      ? selectedModel
      : videoModels.find((model) => model.id === defaultVideoModel && model.available !== false)
        || videoModels.find((model) => model.available !== false)
    if (!usableModel) return
    setDraft((current) => {
      const resolution = usableModel.resolutions.includes(current.resolution)
        ? current.resolution
        : usableModel.defaultResolution
      const aspectRatio = usableModel.aspectRatios.includes(current.aspectRatio)
        ? current.aspectRatio
        : usableModel.aspectRatios[0]
      const duration = normalizeVideoDuration(
        current.duration,
        usableModel.minimumDuration,
        usableModel.maximumDuration,
        usableModel.supportedDurations,
      )
      const currentModel = videoModels.find((model) => model.id === current.model)
      const generateAudio = usableModel.supportsAudio && (
        currentModel == null || currentModel.supportsAudio === false || current.generateAudio
      )
      if (usableModel.id === current.model
        && resolution === current.resolution
        && aspectRatio === current.aspectRatio
        && duration === current.duration
        && generateAudio === current.generateAudio) {
        return current
      }
      return { ...current, model: usableModel.id, resolution, aspectRatio, duration, generateAudio }
    })
  }, [defaultVideoModel, selectedModel, videoModels])

  useEffect(() => {
    if (generationPhase && generating) setGenerationPhase(null)
  }, [generationPhase, generating])

  async function save() {
    setSaving(true)
    try {
      const input = {
        title: draft.title,
        videoPrompt: draft.videoPrompt,
        notes: draft.notes || null,
        duration: draft.duration,
        aspectRatio: draft.aspectRatio,
        generateAudio: draft.generateAudio,
      }
      return storyboard
        ? await onSave(storyboard, input)
        : await onCreate(input)
    } finally {
      setSaving(false)
    }
  }

  async function loadRevisions() {
    if (!storyboard) return
    const nextOpen = !revisionOpen
    setRevisionOpen(nextOpen)
    if (!nextOpen) return
    setRevisionLoading(true)
    try {
      const payload = await requestJson<{ revisions: StoryboardRevisionRecord[] }>(
        `/api/storyboards/${storyboard.id}/revisions`,
      )
      setRevisions(payload.revisions)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '读取分镜版本失败', 'error')
    } finally {
      setRevisionLoading(false)
    }
  }

  async function restoreRevision(revision: StoryboardRevisionRecord) {
    if (!storyboard || !window.confirm(`恢复到 ${new Date(revision.createdAt).toLocaleString('zh-CN')} 的版本？当前稿会先自动留存。`)) return
    setRevisionLoading(true)
    try {
      const restored = await onRestoreRevision(storyboard, revision.id)
      if (!restored) return
      setDraft((current) => ({
        ...current,
        title: restored.title,
        videoPrompt: restored.videoPrompt || '',
        notes: restored.notes || '',
        duration: restored.duration,
        aspectRatio: restored.aspectRatio,
        generateAudio: restored.generateAudio,
      }))
      setRevisionOpen(false)
    } finally {
      setRevisionLoading(false)
    }
  }

  async function updateAssetLink(
    assetId: string,
    action: 'add' | 'remove',
    promptOverride?: string,
  ) {
    if (!storyboard || assetLinkBusyId) return
    const asset = projectAssets.find((candidate) => candidate.id === assetId)
    if (!asset || (asset.type !== 'character' && asset.type !== 'location' && asset.type !== 'prop')) return
    const previousPrompt = draft.videoPrompt
    const nextPrompt = promptOverride ?? (action === 'add'
      ? insertStoryboardAssetMention(previousPrompt, asset)
      : removeStoryboardAssetMention(previousPrompt, asset.name))
    setDraft((current) => ({ ...current, videoPrompt: nextPrompt }))
    setAssetLinkBusyId(assetId)
    try {
      const updated = await onUpdateAssetLink(storyboard.id, assetId, action, nextPrompt)
      if (updated) {
        setDraft((current) => ({ ...current, videoPrompt: updated.videoPrompt || nextPrompt }))
      } else {
        setDraft((current) => ({ ...current, videoPrompt: previousPrompt }))
      }
      if (updated && action === 'add' && pickerAssets.length <= 1) {
        setAssetPickerOpen(false)
        setAssetPickerQuery('')
      }
      if (updated && action === 'remove' && generating) {
        onNotice('已从后续生成参考中移除；当前正在生成的任务仍使用提交时的资产')
      }
    } finally {
      setAssetLinkBusyId(null)
    }
  }

  async function generate() {
    if (generationLockRef.current || generating) return
    generationLockRef.current = true
    setGenerationPhase('saving')
    try {
      const saved = await save()
      if (!saved) {
        setGenerationPhase(null)
        return
      }
      let continuityFrameMediaId: string | undefined
      let continuitySourceVideoId: string | undefined
      if (continuityEnabled && previousSelectedVideo) {
        setGenerationPhase('capturing_tail')
        try {
          const frame = await ensureContinuityFrame()
          continuityFrameMediaId = frame.mediaId
          continuitySourceVideoId = previousSelectedVideo.id
        } catch (error) {
          onNotice(
            `${error instanceof Error ? error.message : '尾帧截取失败'}，已按文字连续性继续生成`,
            'error',
          )
        }
      }
      setGenerationPhase('submitting')
      const task = await onGenerate(saved, {
        duration: draft.duration,
        aspectRatio: draft.aspectRatio,
        resolution: draft.resolution,
        generateAudio: draft.generateAudio,
        model: draft.model,
        continuityFrameMediaId,
        continuitySourceVideoId,
      })
      setGenerationPhase(task ? 'queued' : null)
    } catch (error) {
      setGenerationPhase(null)
      onNotice(error instanceof Error ? error.message : '视频任务提交失败', 'error')
    } finally {
      generationLockRef.current = false
    }
  }

  async function cancelGeneration() {
    if (!selectedTask || !generating || cancellingGeneration) return
    if (!window.confirm('取消这个视频生成任务？已经提交到上游的任务可能仍会产生费用，但结果将不再保存。')) return
    setCancellingGeneration(true)
    try {
      await onCancelTask(selectedTask)
      setGenerationPhase(null)
    } finally {
      setCancellingGeneration(false)
    }
  }

  async function ensureContinuityFrame(force = false) {
    if (!previousSelectedVideo) throw new Error('上一镜没有已选中的视频')
    if (continuityFrame && !force) return continuityFrame
    setCapturingTail(true)
    try {
      const captured = await captureVideoTailFrame(previousSelectedVideo.url)
      const form = new FormData()
      form.set('file', new File([captured.blob], '上一镜尾帧.png', { type: 'image/png' }))
      const payload = await requestJson<{ tailFrame: { mediaId: string, url: string } }>(
        `/api/storyboard-videos/${previousSelectedVideo.id}/tail-frame`,
        { method: 'POST', body: form },
      )
      setContinuityFrame(payload.tailFrame)
      return payload.tailFrame
    } finally {
      setCapturingTail(false)
    }
  }

  if (!storyboard && nextSceneNumber === 1 && !draft.videoPrompt && !draft.title) {
    return <div className="storyboardEmpty"><Film size={42} /><strong>新建第一条分镜</strong></div>
  }

  return (
    <>
      <section className="storyEditor">
        <div className="editorHeader">
          <span className="sceneIndex">分镜 {String(storyboard?.sceneNumber || nextSceneNumber).padStart(2, '0')}</span>
          <div className="detailActions">
            {storyboard ? (
              <button className="iconButton danger" type="button" title="删除分镜" onClick={() => void onDelete(storyboard)}>
                <Trash2 size={17} />
              </button>
            ) : (
              <button className="quietButton" type="button" onClick={onCancelCreate}>取消</button>
            )}
            <button className="iconButton" type="button" title="保存分镜" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
            </button>
            {storyboard ? (
              <button className="iconButton" type="button" title="查看版本记录" onClick={() => void loadRevisions()} disabled={revisionLoading}>
                {revisionLoading ? <Loader2 className="spin" size={17} /> : <History size={17} />}
              </button>
            ) : null}
          </div>
        </div>

        {revisionOpen ? (
          <div className="storyboardRevisionPanel">
            <div className="sectionLabel"><strong>版本记录</strong><span>{revisions.length}</span></div>
            {revisions.length > 0 ? revisions.map((revision) => (
              <div className="storyboardRevisionItem" key={revision.id}>
                <span>
                  <strong>{new Date(revision.createdAt).toLocaleString('zh-CN')}</strong>
                  <small>{revision.reason || revision.source} · {revision.duration}s</small>
                  <small>{revision.promptPreview || '无视频提示词'}</small>
                </span>
                <button className="iconButton" type="button" title="恢复这个版本" onClick={() => void restoreRevision(revision)}>
                  <RotateCcw size={16} />
                </button>
              </div>
            )) : <small>尚无历史版本；下次修改前会自动留存。</small>}
          </div>
        ) : null}

        <label>
          标题
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label className="promptField">
          <span className="promptFieldHeading">
            <span>视频生成提示词（可修改）</span>
            <small className={promptDirty ? 'dirty' : ''}>{promptDirty ? '尚未保存' : '已保存'}</small>
          </span>
          <HighlightedStoryboardPrompt
            value={draft.videoPrompt}
            assets={storyboard?.assets || []}
            availableAssets={projectAssets}
            onChange={(videoPrompt) => setDraft((current) => ({ ...current, videoPrompt }))}
            onSelectAsset={(assetId, videoPrompt) => void updateAssetLink(assetId, 'add', videoPrompt)}
          />
          <small className="promptUsageHint">单个生成会先自动保存；批量生成使用最近保存的版本。当前 {draft.videoPrompt.length} 字。</small>
        </label>

        {storyboard ? (
          <ShotPerformancePanel
            storyboardId={storyboard.id}
            duration={draft.duration}
            assets={storyboard.assets}
            onNotice={onNotice}
          />
        ) : null}

        <div className="referenceSection">
          <div className="sectionLabel referenceSectionHeader">
            <span className="referenceSectionTitle">
              <strong>本次视频参考图</strong>
              <small>原图 {submittedImageReferenceCount}/{maximumReferenceImages} 张{maximumReferenceVideos > 0
                ? ` · 参考视频 ${videoReferenceAssetGroups.length}/${maximumReferenceVideos} 段`
                : ''}</small>
            </span>
            {storyboard ? (
              <button
                className={`quietButton compact referenceAssetAddButton ${assetPickerOpen ? 'active' : ''}`}
                type="button"
                aria-expanded={assetPickerOpen}
                onClick={() => setAssetPickerOpen((open) => !open)}
              >
                <Plus size={14} />添加项目资产
              </button>
            ) : null}
          </div>
          {storyboard && assetPickerOpen ? (
            <section className="storyboardAssetPicker" aria-label="添加项目资产到当前分镜">
              <header>
                <span>
                  <strong>从项目资产库添加</strong>
                  <small>点击资产会在提示词中写入 @资产；初始识别完成后，列表只按你的增删决定。</small>
                </span>
                <button
                  className="iconButton small"
                  type="button"
                  title="关闭资产选择"
                  aria-label="关闭资产选择"
                  onClick={() => setAssetPickerOpen(false)}
                ><X size={15} /></button>
              </header>
              <label className="storyboardAssetSearch">
                <Search size={15} />
                <input
                  value={assetPickerQuery}
                  onChange={(event) => setAssetPickerQuery(event.target.value)}
                  placeholder="搜索角色、场景或道具"
                  aria-label="搜索项目资产"
                />
              </label>
              {pickerAssets.length > 0 ? (
                <div className="storyboardAssetPickerList">
                  {pickerAssets.slice(0, 24).map((asset) => {
                    const preview = imageFor(asset)
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        disabled={assetLinkBusyId !== null}
                        onClick={() => void updateAssetLink(asset.id, 'add')}
                      >
                        <span className="storyboardAssetPickerThumb">
                          {preview ? <img src={preview} alt="" /> : <TypeIcon type={asset.type} size={18} />}
                        </span>
                        <span>
                          <strong>{asset.name}</strong>
                          <small>{typeLabels[asset.type]} · {asset.selectedImageId ? '已有主图' : '缺少主图，添加后需先生图'}</small>
                        </span>
                        {assetLinkBusyId === asset.id ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="storyboardAssetPickerEmpty">
                  {assetPickerQuery ? '没有匹配的未添加资产' : '项目中的角色、场景和道具已经全部加入本镜'}
                </div>
              )}
            </section>
          ) : null}
          {storyboard?.assets.length ? (
            <div className="referenceStrip">
              {storyboard.assets.map((asset) => {
                const referenceOrder = submittedAssetReferenceOrder.get(asset.id)
                const videoReferenceGroup = videoReferenceGroupByAssetId.get(asset.id)
                const replacedByTailFrame = continuityEnabled && asset.type === 'location'
                const sceneUsesText = usesTextSceneReference
                  && asset.type === 'location'
                  && asset.hasSelectedImage
                  && !referenceOrder
                return (
                  <div
                    className={`referenceItem removable ${asset.isManual ? 'manual' : ''} ${asset.hasSelectedImage ? referenceOrder || videoReferenceGroup ? '' : 'omitted' : 'missing'}`}
                    key={asset.id}
                    title={replacedByTailFrame
                      ? '启用上一镜尾帧后不再提交场景资产图'
                      : sceneUsesText
                          ? '镜内人物已占满参考图名额，场景按【场景】文字描述生成'
                          : videoReferenceGroup
                            ? `超出原图上限，已自动加入参考视频 ${videoReferenceGroup}`
                          : asset.matchReason}
                  >
                    <span className="referenceImage">
                      {asset.imageUrl ? <img src={asset.imageUrl} alt={asset.name} /> : <ImageIcon size={24} />}
                      {referenceOrder ? <b>@{referenceOrder}</b> : null}
                      {!referenceOrder && videoReferenceGroup ? <b className="videoReferenceBadge">V{videoReferenceGroup}</b> : null}
                    </span>
                    <span>
                      <strong>{asset.name}</strong>
                      <small>{!asset.hasSelectedImage
                        ? '缺少主图'
                        : replacedByTailFrame
                           ? '由上一镜尾帧替代'
                          : sceneUsesText
                              ? '场景由文字控制（人物优先）'
                              : referenceOrder
                                ? `${typeLabels[asset.type]} · ${asset.isManual ? '@手动添加' : '初始识别'}`
                                : videoReferenceGroup
                                  ? `参考视频 ${videoReferenceGroup} · ${typeLabels[asset.type]}`
                                  : '未提交（超出总上限）'}</small>
                    </span>
                    <button
                      className="referenceRemoveAsset"
                      type="button"
                      title={`从本镜视频参考中移除${asset.name}`}
                      aria-label={`从本镜视频参考中移除${asset.name}`}
                      disabled={assetLinkBusyId !== null}
                      onClick={() => void updateAssetLink(asset.id, 'remove')}
                    >
                      {assetLinkBusyId === asset.id ? <Loader2 className="spin" size={13} /> : <X size={13} />}
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="referenceEmpty">本镜暂无参考资产；点击“添加项目资产”写入 @资产</div>
          )}
          {referenceLimitBlocked ? (
            <div className="referenceStrategyNote errorText" role="alert">
              <CircleAlert size={14} />
              <span>你为本镜选择了 {selectedCharacterReferences.length} 个人物资产，超过当前模型可接收的 {totalReferenceCapacity} 项资产总上限。请移除多余资产或拆分分镜。</span>
            </div>
          ) : videoReferenceAssetGroups.length > 0 ? (
            <div className="referenceStrategyNote referenceVideoPackingNote" role="status">
              <Film size={14} />
              <span>前 {submittedAssetReferences.length} 张保留为原图；每张溢出图片已分别生成 1 段无声静态参考视频，共 {videoReferenceAssetGroups.length} 段，仅用于锁定人物、服装、场景和道具，不作为动作时序。</span>
            </div>
          ) : usesTextSceneReference ? (
            <div className="referenceStrategyNote">
              <CircleAlert size={14} />
              <span>{selectedCharacterReferences.length} 个已选人物资产优先使用全部参考图名额；场景将严格按【场景】文字描述生成，不上传场景资产图。</span>
            </div>
          ) : null}
          <div className="continuityReference">
            <Toggle
              checked={inheritPrevious && !continuityDisabled}
              onChange={setInheritPrevious}
              label="承接上一镜"
              icon={<Camera size={15} />}
              disabled={continuityDisabled}
            />
            <div className={`continuityPreview ${inheritPrevious && !continuityDisabled ? 'active' : ''}`}>
              <span className="continuityThumbnail">
                {continuityFrame?.url
                  ? <img src={continuityFrame.url} alt="上一镜尾帧" />
                  : <Camera size={22} />}
                {continuityEnabled ? <b>@{submittedAssetReferences.length + 1}</b> : null}
              </span>
              <span>
                <strong>{previousStoryboardLabel} 尾帧</strong>
                <small>{continuityFrame
                  ? spatialContinuity ? '已锁定站位、朝向与接触状态' : '已准备人物外观与情绪承接'
                  : !previousStoryboard
                    ? '这是项目第一条分镜，没有可承接的视频'
                    : !previousSelectedVideo
                      ? '上一镜尚未选中视频版本'
                        : usesTextOnlyCharacters
                          ? '当前模型不支持真人尾帧参考'
                          : continuityBlockedByReferenceLimit
                            ? `${selectedCharacterReferences.length} 个已选人物资产已占满参考图名额，不能再加入尾帧`
                          : spatialContinuity
                          ? '生成前自动截取，不替换人物资产'
                          : crossEpisodeSource
                            ? '跨集承接：开启后自动截取上一集最后一镜'
                            : '转场承接：仅继承同名人物外观、道具与情绪'}</small>
              </span>
              <button
                className="iconButton small"
                type="button"
                title={continuityFrame ? '重新截取上一镜尾帧' : '立即截取上一镜尾帧'}
                disabled={!inheritPrevious || continuityDisabled || capturingTail || generationBusy}
                onClick={() => void ensureContinuityFrame(true).catch((error) => (
                  onNotice(error instanceof Error ? error.message : '尾帧截取失败', 'error')
                ))}
              >
                {capturingTail ? <Loader2 className="spin" size={15} /> : <Camera size={15} />}
              </button>
            </div>
          </div>
        </div>

        <div className="generationSettings">
          <div className="videoModelControl">
            <label>
              视频模型
              <select
                value={draft.model}
                onChange={(event) => {
                  const next = videoModels.find((model) => model.id === event.target.value)
                  if (!next) return
                  setDraft((current) => ({
                    ...current,
                    model: next.id,
                    generateAudio: next.supportsAudio && (
                      selectedModel == null || selectedModel.supportsAudio === false || current.generateAudio
                    ),
                  }))
                }}
              >
                {videoModels.length === 0 ? <option value={draft.model}>正在读取模型价格…</option> : null}
                <VideoModelSelectOptions models={videoModels} unavailableLabel="当前不可用" />
              </select>
            </label>
            <div className="modelPriceSummary">
              {selectedModel ? (
                <>
                  <span><b>{selectedModel.priceLabel} · {selectedModel.priceSource === 'live' ? '实时价' : '参考价'}</b><strong>{videoPriceEstimate(selectedModel, draft.duration)}</strong></span>
                  <small>{selectedModel.description} 预计耗时 {generationTime
                    ? formatMinuteRange(generationTime.minimum, generationTime.maximum)
                    : '等待模型信息'}。{videoPriceNotice}</small>
                  {usesTextOnlyCharacters ? (
                    <small className="errorText">保留原生音频，但不会上传人物或人脸图片；人物将按提示词中的外形、服装和声音文字设定生成。</small>
                  ) : null}
                </>
              ) : (
                <small>{videoPriceNotice}</small>
              )}
            </div>
          </div>
          <div className="durationControl">
            <span>时长 <strong aria-live="polite">{draft.duration}s</strong></span>
            <div className="durationSlider">
              <input
                type="range"
                min={0}
                max={Math.max(0, durationSteps.length - 1)}
                step={1}
                value={durationStepIndex}
                aria-label="视频时长"
                aria-valuetext={`${draft.duration} 秒`}
                onChange={(event) => {
                  const duration = durationSteps[Number(event.target.value)] || durationSteps[0]
                  setDraft((current) => ({ ...current, duration }))
                }}
              />
              <div
                className="durationScale"
                style={{ gridTemplateColumns: `repeat(${durationSteps.length}, minmax(0, 1fr))` }}
                aria-hidden="true"
              >
                {durationSteps.map((duration) => (
                  <span className={duration === draft.duration ? 'active' : ''} key={duration}>{duration}s</span>
                ))}
              </div>
            </div>
          </div>
          <div className="settingControl">
            <span>清晰度</span>
            <div className="ratioControl" aria-label="清晰度">
              {availableResolutions.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  className={draft.resolution === resolution ? 'active' : ''}
                  onClick={() => setDraft((current) => ({ ...current, resolution }))}
                >{resolution === '1080p' ? 'Full HD 1080p' : resolution === '720p' ? 'HD 720p' : '标准 480p'}</button>
              ))}
            </div>
          </div>
          <label className="aspectRatioControl">
            画幅
            <select
              value={draft.aspectRatio}
              onChange={(event) => setDraft((current) => ({
                ...current,
                aspectRatio: event.target.value as StoryboardAspectRatio,
              }))}
            >
              {availableAspectRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </label>
          <Toggle
            checked={draft.generateAudio}
            onChange={(generateAudio) => setDraft((current) => ({ ...current, generateAudio }))}
            label={selectedModel?.supportsAudio === false ? '当前模型无原生音频' : '对白音频'}
            icon={draft.generateAudio ? <Volume2 size={15} /> : <VolumeX size={15} />}
            disabled={selectedModel?.supportsAudio === false}
          />
        </div>
      </section>

      <aside className="videoPanel">
        <div
          className={`videoStage ${draft.aspectRatio === '9:16' || draft.aspectRatio === '3:4' ? 'portrait' : ''}`}
          style={{ aspectRatio: draft.aspectRatio.replace(':', ' / ') }}
        >
          {selectedVideo ? (
            <BufferedVideo key={selectedVideo.id} source={selectedVideo.url} playsInline />
          ) : (
            <div className="videoPlaceholder"><Clapperboard size={36} /><span>暂无视频</span></div>
          )}
          {generationBusy ? (
            <div className="renderOverlay">
              <Loader2 className="spin" size={25} />
              <strong>{generationStatusTitle}</strong>
              {generating ? (
                <>
                  <div className="progressTrack"><span style={{ width: `${selectedTask?.progress || 4}%` }} /></div>
                  <small>{selectedTask?.progress || 0}%</small>
                </>
              ) : <small>点击已接收，请勿重复点击</small>}
            </div>
          ) : null}
        </div>

        <button
          className="primaryButton generateVideoButton"
          data-assistant-target="generate-video"
          type="button"
          onClick={() => void generate()}
          disabled={saving || generationBusy || referenceLimitBlocked || !draft.videoPrompt.trim() || !draft.model || selectedModel?.available === false}
        >
          {generationBusy ? <Loader2 className="spin" size={17} /> : <Clapperboard size={17} />}
          {generationBusy
            ? generationStatusTitle
            : `使用 ${selectedModel?.label || '所选模型'} 生成 ${draft.duration}s · ${draft.resolution}`}
        </button>

        {generationBusy ? (
          <div className="videoGenerationStatus" role="status" aria-live="polite">
            <span><Loader2 className="spin" size={16} /></span>
            <div>
              <strong>{generationStatusTitle}</strong>
              <small>{generationStatusDetail}</small>
            </div>
            {generating && selectedTask ? (
              <button
                className="cancelGenerationButton"
                type="button"
                onClick={() => void cancelGeneration()}
                disabled={cancellingGeneration}
              >
                {cancellingGeneration ? <Loader2 className="spin" size={14} /> : <X size={14} />}
                {cancellingGeneration ? '正在取消' : '取消生成'}
              </button>
            ) : null}
          </div>
        ) : null}

        {selectedTask?.status === 'failed' ? (
          <p className="errorText videoTaskError" role="alert">
            {readableVideoTaskError(selectedTask.error)}
          </p>
        ) : null}

        <div className="videoVersions">
          <div className="sectionLabel"><strong>视频版本</strong><span>{storyboard?.videos.length || 0}</span></div>
          {storyboard?.videos.map((video, index) => (
            <button
              key={video.id}
              type="button"
              className={video.id === selectedVideo?.id ? 'active' : ''}
              onClick={() => void onSelectVideo(storyboard, video)}
            >
              <Film size={16} />
              <span>
                <strong>版本 {storyboard.videos.length - index}{video.sourceStoryboardIds?.length > 1 ? ` · 组合 ${video.sourceStoryboardIds.length} 镜` : ''}</strong>
                <small>{videoModels.find((model) => model.id === video.model)?.label || video.model} · {video.duration}s · {video.resolution} · {video.aspectRatio}</small>
              </span>
              {video.id === selectedVideo?.id ? <Check size={16} /> : null}
            </button>
          ))}
        </div>
      </aside>
    </>
  )
}

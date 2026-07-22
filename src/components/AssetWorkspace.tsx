'use client'

import { FormEvent, SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpenText,
  Box,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Download,
  Film,
  House,
  ImageIcon,
  Layers3,
  ListVideo,
  Loader2,
  LogOut,
  MapPinned,
  PackageOpen,
  Plus,
  RefreshCw,
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
import { splitAssetHighlights } from '@/lib/asset-highlights'
import { readableTextTaskError } from '@/lib/text-task-error'
import {
  estimateSequentialVideoBatchSeconds,
  estimateVideoGenerationSeconds,
  fitVideoGroupDurations,
  groupSingleEpisodeVideoBatch,
  normalizeVideoDuration,
  type StoryboardVideoGroupSize,
} from '@/lib/video-batch'
import { PreproductionWorkspace, type PreproductionSummary } from './PreproductionWorkspace'

type AssetType = 'character' | 'location' | 'prop'
type VisualStyle = 'photorealistic' | 'anime_2d' | 'anime_3d' | 'chibi'
type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
type WorkspaceView = 'script' | 'assetPlan' | 'shotPlan' | 'assets' | 'storyboards' | 'videos'

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

type VideoResolution = '480p' | '720p'
type StoryboardAspectRatio = '16:9' | '9:16' | '1:1' | '21:9' | '3:4' | '4:3'

type VideoModelOption = {
  id: string
  label: string
  family: 'Grok' | 'Seedance'
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
  maximumPromptCharacters: number
  supportsAudio: boolean
  resolutions: VideoResolution[]
  defaultResolution: VideoResolution
  aspectRatios: StoryboardAspectRatio[]
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
  highlightTerms: string[]
  hasSelectedImage: boolean
  imageUrl: string | null
}

type StoryboardVideo = {
  id: string
  mediaId: string
  name: string
  url: string
  downloadUrl: string
  prompt: string
  model: string
  duration: number
  sourceStoryboardIds: string[]
  aspectRatio: string
  resolution: VideoResolution
  isSelected: boolean
  createdAt: string
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
  duration: number
  aspectRatio: StoryboardAspectRatio
  generateAudio: boolean
  selectedVideoId: string | null
  updatedAt: string
  assets: StoryboardAssetReference[]
  videos: StoryboardVideo[]
  latestTask: TaskRecord | null
}

type WorkspaceData = {
  projects: ProjectOption[]
  activeProjectId: string | null
  assets: AssetRecord[]
  storyboards: StoryboardRecord[]
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

function videoPriceEstimate(model: VideoModelOption, duration: number) {
  const amount = videoPriceAmount(model, duration)
  return `本次预计 ¥${amount.toFixed(2)}${model.startingAt ? ' 起' : ''}`
}

function videoPriceAmount(model: VideoModelOption, duration: number) {
  return model.priceMode === 'per_second' ? model.unitPrice * duration : model.unitPrice
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

function videoTaskErrorMessage(value: string | null | undefined) {
  const error = value?.trim() || ''
  if (/invalid_prompt[\s\S]*maximum length of 4096|Prompt exceeds the maximum length of 4096/iu.test(error)) {
    return '视频提示词超过当前模型的 4096 字符限制。系统已更新自动压缩规则，请重新点击生成。失败请求没有进入生成阶段。'
  }
  if (/model grok-video not found/iu.test(error)) {
    return '当前线路暂未提供所选 Grok 模型，请刷新模型列表后重新选择可用模型。'
  }
  if (/seconds must be one of:\s*6,\s*10,\s*15/iu.test(error)) {
    return 'Grok 仅支持 6、10 或 15 秒。系统现已自动调整时长，请重新点击生成；本次失败未进入视频生成阶段。'
  }
  return error || '视频生成失败'
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
  onChange,
}: {
  value: string
  assets: StoryboardAssetReference[]
  onChange: (value: string) => void
}) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const segments = useMemo(() => splitAssetHighlights(value, assets), [assets, value])

  return (
    <div className="highlightedTextarea">
      <div className="highlightedTextareaMirror" ref={mirrorRef} aria-hidden="true">
        {segments.map((segment, index) => segment.assetId ? (
          <mark
            data-asset-type={segment.assetType}
            key={`${segment.assetId}-${index}`}
          >{segment.text}</mark>
        ) : <span key={`text-${index}`}>{segment.text}</span>)}
        {value.endsWith('\n') ? '\u200b' : null}
      </div>
      <textarea
        data-assistant-target="storyboard-prompt"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (!mirrorRef.current) return
          mirrorRef.current.scrollTop = event.currentTarget.scrollTop
          mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft
        }}
        placeholder="输入景别、机位、动作、对白，并直接使用资产名称"
        rows={15}
      />
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
    const videoCount = input.storyboards.reduce((total, storyboard) => total + storyboard.videos.length, 0)
    return videoCount > 0 ? {
      key: `video-library-${videoCount}`,
      title: `视频库中共有 ${videoCount} 条视频`,
      detail: '可以逐条预览、修改名称并直接下载，所有历史生成版本都会保留。',
      warnings: ['重命名不会修改视频内容。', '下载文件会使用当前保存的名称。'],
    } : {
      key: 'video-library-empty',
      title: '先生成第一条分镜视频',
      detail: '视频生成完成后会自动进入这里，不需要额外合成或导入。',
      warnings: ['视频库只展示当前项目的内容。', styleWarning],
      action: { id: 'open_storyboards', label: '进入分镜视频' },
    }
  }

  if (input.storyboards.length === 0 || input.creatingStoryboard || !input.selectedStoryboard) {
    return {
      key: 'write-storyboard',
      title: '写下这一镜的画面与动作',
      detail: '输入景别、机位、动作、对白，并直接写出角色、场景和道具的资产名称。',
      warnings: ['保存分镜后才会刷新资产识别结果。', '使用别名时，请写入资产名称括号，例如“陈蕊（Jessica）”。'],
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
  const [defaultVideoModel, setDefaultVideoModel] = useState('seedance-2.0-mini')
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
      showMessage('分镜已创建，资产匹配完成')
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
        body: JSON.stringify(patch),
      })
      setStoryboards((current) => current.map((item) => (
        item.id === storyboard.id ? payload.storyboard : item
      )))
      showMessage('分镜已保存，资产匹配已更新')
      return payload.storyboard
    } catch (error) {
      showMessage(error instanceof Error ? error.message : '保存分镜失败', 'error')
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
          onSave={saveAsset}
          onDelete={deleteAsset}
          onGenerate={generateImages}
          onUploadImage={uploadAssetImage}
          onGenerateAll={generateAllAssetImages}
          onSelectImage={selectImage}
        />
      ) : view === 'storyboards' ? (
        <StoryboardWorkspace
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
          onDelete={deleteStoryboard}
          onGenerate={generateVideo}
          onGenerateGroup={generateVideoGroup}
          onSelectVideo={selectVideo}
          onNotice={showMessage}
        />
      ) : view === 'videos' ? (
        <VideoLibrary
          storyboards={storyboards}
          onRename={renameVideo}
          onOpenStoryboard={(storyboardId) => {
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
  storyboards,
  onRename,
  onOpenStoryboard,
}: {
  storyboards: StoryboardRecord[]
  onRename: (video: StoryboardVideo, name: string) => Promise<string | null>
  onOpenStoryboard: (storyboardId: string) => void
}) {
  const [query, setQuery] = useState('')
  const storyboardById = useMemo(
    () => new Map(storyboards.map((storyboard) => [storyboard.id, storyboard])),
    [storyboards],
  )
  const allEntries = useMemo(() => storyboards.flatMap((storyboard) => (
    storyboard.videos.map((video) => ({ storyboard, video }))
  )), [storyboards])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = normalizedQuery ? allEntries.filter(({ storyboard, video }) => (
    [
      video.name,
      video.model,
      storyboard.title,
      storyboard.episode?.title,
      storyboard.episode?.episodeNumber ? `第${storyboard.episode.episodeNumber}集` : '',
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
  )) : allEntries
  const groups = useMemo(() => {
    const grouped = new Map<string, {
      key: string
      episodeNumber: number | null
      title: string
      entries: Array<{ storyboard: StoryboardRecord; video: StoryboardVideo }>
    }>()
    for (const entry of filteredEntries) {
      const episode = entry.storyboard.episode
      const key = episode?.id || 'unassigned'
      const existing = grouped.get(key) || {
        key,
        episodeNumber: episode?.episodeNumber || null,
        title: episode?.title || '未分集视频',
        entries: [],
      }
      existing.entries.push(entry)
      grouped.set(key, existing)
    }
    return [...grouped.values()]
      .sort((left, right) => (
        (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (right.episodeNumber ?? Number.MAX_SAFE_INTEGER)
      ))
      .map((group) => ({
        ...group,
        entries: group.entries.sort((left, right) => (
          (left.storyboard.episodeSceneNumber || left.storyboard.sceneNumber)
            - (right.storyboard.episodeSceneNumber || right.storyboard.sceneNumber)
          || right.video.createdAt.localeCompare(left.video.createdAt)
        )),
      }))
  }, [filteredEntries])
  const totalDuration = allEntries.reduce((total, entry) => total + entry.video.duration, 0)

  return (
    <section className="videoLibraryWorkspace" tabIndex={-1}>
      <header className="videoLibraryHeader">
        <div>
          <span><ListVideo size={19} /><strong>视频库</strong></span>
          <small>{allEntries.length} 条视频 · 总时长 {formatSeconds(totalDuration)}</small>
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
          <strong>当前项目还没有生成视频</strong>
          <span>完成任意分镜视频任务后，视频会自动保存在这里。</span>
          <button className="primaryButton compact" type="button" onClick={() => onOpenStoryboard('')}>
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
                  <strong>{group.episodeNumber ? `第 ${group.episodeNumber} 集` : '未分集'}</strong>
                  <small>{group.title}</small>
                </span>
                <b>{group.entries.length} 条</b>
              </summary>
              <div className="videoLibraryList">
                {group.entries.map(({ storyboard, video }) => (
                  <VideoLibraryItem
                    key={video.id}
                    storyboard={storyboard}
                    video={video}
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
  storyboardById,
  onRename,
  onOpenStoryboard,
}: {
  storyboard: StoryboardRecord
  video: StoryboardVideo
  storyboardById: Map<string, StoryboardRecord>
  onRename: (video: StoryboardVideo, name: string) => Promise<string | null>
  onOpenStoryboard: (storyboardId: string) => void
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
  const sourceNumbers = (sourceStoryboards.length ? sourceStoryboards : [storyboard])
    .map((source) => source.episodeSceneNumber || source.sceneNumber)
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
          <button className="quietButton compact" type="button" onClick={() => onOpenStoryboard(storyboard.id)}>
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
              rows={16}
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

        {assets.length > 0 ? (
          <div className="assetGrid">
            {assets.map((asset) => {
              const image = imageFor(asset)
              const generating = asset.latestTask?.status === 'queued' || asset.latestTask?.status === 'processing'
              return (
                <button
                  key={asset.id}
                  className={`assetTile ${selectedAsset?.id === asset.id ? 'selected' : ''}`}
                  onClick={() => onSelect(asset.id)}
                  type="button"
                >
                  <span className="assetThumb">
                    {image ? <img src={image} alt={asset.name} /> : <ImageIcon size={30} />}
                    {generating ? <span className="assetGenerating"><Loader2 className="spin" size={14} />生成中</span> : null}
                  </span>
                  <span className="assetTileBody">
                    <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
                    <strong title={asset.name}>{asset.name}</strong>
                    <small>{asset.tags.slice(0, 2).join(' · ') || '未添加标签'}</small>
                  </span>
                </button>
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
  onSave,
  onDelete,
  onGenerate,
  onUploadImage,
  onSelectImage,
}: {
  asset: AssetRecord
  selectedTask?: TaskRecord
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
  const uploadInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
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
  const mainImage = imageFor(asset)

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

  return (
    <div className="detailStack">
      <div className="detailHeader">
        <span className={`assetKind ${asset.type}`}><TypeIcon type={asset.type} size={13} />{typeLabels[asset.type]}</span>
        <div className="detailActions">
          <button className="iconButton danger" onClick={() => void onDelete(asset)} title="删除资产" type="button">
            <Trash2 size={17} />
          </button>
          <button className="iconButton" onClick={() => void save()} title="保存资产" type="button" disabled={saving}>
            {saving ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
          </button>
        </div>
      </div>

      <div className="assetHeroPreview">
        {mainImage ? <img src={mainImage} alt={asset.name} /> : <ImageIcon size={38} />}
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
          disabled={generating}
          onClick={() => void onGenerate(asset, draft.prompt)}
          type="button"
        >
          {generating ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          {retrying ? '排队重试中' : generating ? '生成中' : '生成新图片'}
        </button>
      </div>

      <p className="generationEstimate">通常约 1–3 分钟；服务拥堵时会自动重新排队，最长可能接近 10 分钟。关闭页面也会在服务器继续。</p>

      {retrying ? <p className="pendingText">{selectedTask?.error}</p> : null}
      {selectedTask?.status === 'failed' ? <p className="errorText">{selectedTask.error || '生成失败'}</p> : null}

      <div className="variantSection">
        <div className="sectionLabel"><strong>图片版本</strong><span>{asset.images.length}</span></div>
        <div className="imageStrip">
          {asset.images.map((image) => (
            <button
              key={image.id}
              className={`variantButton ${image.isSelected ? 'chosen' : ''}`}
              onClick={() => void onSelectImage(asset, image)}
              title="设为主图"
              type="button"
            >
              <img src={image.url} alt={`${asset.name} 版本 ${image.variant}`} />
              {image.isSelected ? <span><Check size={14} /></span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function StoryboardWorkspace({
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
  onDelete,
  onGenerate,
  onGenerateGroup,
  onSelectVideo,
  onNotice,
}: {
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
  onDelete: (storyboard: StoryboardRecord) => Promise<void>
  onGenerate: (storyboard: StoryboardRecord, settings: {
    duration: number
    aspectRatio: StoryboardAspectRatio
    resolution: VideoResolution
    generateAudio: boolean
    model: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
  onGenerateGroup: (storyboardIds: string[], settings: {
    resolution: VideoResolution
    generateAudio?: boolean
    model: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
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
  const [storyboardsPerVideo, setStoryboardsPerVideo] = useState<StoryboardVideoGroupSize>(3)
  const [batchModel, setBatchModel] = useState(defaultVideoModel)
  const [batchResolution, setBatchResolution] = useState<VideoResolution>('720p')
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const selectedBatchModel = videoModels.find((model) => model.id === batchModel) || null

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
  }, [defaultVideoModel, selectedBatchModel, videoModels])

  const batchEpisode = episodeGroups.find((group) => (
    group.storyboards.some((storyboard) => batchIds.includes(storyboard.id))
  )) || null
  const batchStoryboards = batchEpisode?.storyboards.filter((storyboard) => batchIds.includes(storyboard.id)) || []
  let plannedVideoGroups: StoryboardRecord[][] = []
  let groupingError = ''
  try {
    plannedVideoGroups = groupSingleEpisodeVideoBatch(
      batchStoryboards,
      storyboardsPerVideo,
      selectedBatchModel?.maximumDuration || 15,
    )
  } catch (error) {
    groupingError = error instanceof Error ? error.message : '无法组合所选分镜'
  }
  const mixedRatioGroupCount = plannedVideoGroups.filter((group) => (
    new Set(group.map((storyboard) => storyboard.aspectRatio)).size > 1
  )).length
  const tooManyReferencesGroupCount = plannedVideoGroups.filter((group) => (
    new Set(group.flatMap((storyboard) => storyboard.assets
      .filter((asset) => asset.hasSelectedImage && asset.type !== 'prop')
      .map((asset) => asset.id))).size > (selectedBatchModel?.maximumReferenceImages || 4)
  )).length
  const unsupportedRatioCount = selectedBatchModel
    ? batchStoryboards.filter((storyboard) => !selectedBatchModel.aspectRatios.includes(storyboard.aspectRatio)).length
    : 0
  const batchValidationError = groupingError
    || (mixedRatioGroupCount > 0 ? '同一条组合视频中的分镜必须使用相同画幅' : '')
    || (tooManyReferencesGroupCount > 0
      ? `当前模型最多接收 ${selectedBatchModel?.maximumReferenceImages || 4} 张人物或场景参考图，请减少每条包含的分镜数或更换模型`
      : '')
  const plannedDurations = plannedVideoGroups.map((group) => ({
    duration: fitVideoGroupDurations(
      group.map((storyboard) => storyboard.duration),
      selectedBatchModel?.maximumDuration || 15,
      selectedBatchModel?.supportedDurations || null,
      selectedBatchModel?.minimumDuration || 1,
    ).duration,
  }))
  const batchPrice = selectedBatchModel
    ? plannedDurations.reduce((total, item) => total + videoPriceAmount(selectedBatchModel, item.duration), 0)
    : 0
  const batchTime = selectedBatchModel
    ? estimateSequentialVideoBatchSeconds(selectedBatchModel.family, plannedDurations)
    : { minimum: 0, maximum: 0 }
  const generatedVideoStoryboardIds = new Set(storyboards.flatMap((storyboard) => (
    storyboard.videos.flatMap((video) => video.sourceStoryboardIds?.length
      ? video.sourceStoryboardIds
      : [storyboard.id])
  )))
  const batchActionError = unsupportedRatioCount > 0
    ? `当前模型不支持其中 ${unsupportedRatioCount} 个分镜的画幅`
    : batchValidationError

  function toggleEpisode(episodeKey: string) {
    setOpenEpisodeKeys((current) => current.includes(episodeKey)
      ? current.filter((key) => key !== episodeKey)
      : [...current, episodeKey])
  }

  function toggleStoryboard(storyboard: StoryboardRecord) {
    if (batchIds.includes(storyboard.id)) {
      setBatchIds((current) => current.filter((id) => id !== storyboard.id))
      return
    }
    const episodeKey = storyboard.episodeId || 'unassigned'
    if (batchEpisode && batchEpisode.key !== episodeKey) {
      setBatchIds([storyboard.id])
      return
    }
    setBatchIds((current) => [...current, storyboard.id])
  }

  function toggleReadyStoryboards(group: (typeof episodeGroups)[number]) {
    const readyIds = group.storyboards
      .filter((storyboard) => (
        Boolean(storyboard.videoPrompt?.trim())
        && storyboard.assets.some((asset) => asset.hasSelectedImage)
        && !activeVideoStoryboardIds.has(storyboard.id)
      ))
      .map((storyboard) => storyboard.id)
    const allSelected = readyIds.length > 0 && readyIds.every((id) => batchIds.includes(id))
    setBatchIds(allSelected ? [] : readyIds)
  }

  async function generateBatch() {
    if (!selectedBatchModel || plannedVideoGroups.length === 0 || unsupportedRatioCount > 0 || batchValidationError) return
    setBatchSubmitting(true)
    let submitted = 0
    let coveredStoryboards = 0
    for (const group of plannedVideoGroups) {
      const task = group.length === 1
        ? await onGenerate(group[0], {
            duration: group[0].duration,
            aspectRatio: group[0].aspectRatio,
            resolution: batchResolution,
            generateAudio: selectedBatchModel.supportsAudio && group[0].generateAudio,
            model: selectedBatchModel.id,
          }, true)
        : await onGenerateGroup(group.map((storyboard) => storyboard.id), {
            resolution: batchResolution,
            generateAudio: selectedBatchModel.supportsAudio && group.some((storyboard) => storyboard.generateAudio),
            model: selectedBatchModel.id,
          }, true)
      if (task) {
        submitted += 1
        coveredStoryboards += group.length
      }
    }
    setBatchSubmitting(false)
    if (submitted > 0) {
      setBatchIds([])
      onNotice(`已加入 ${submitted} 条视频任务，共覆盖 ${coveredStoryboards} 个分镜`)
    } else {
      onNotice('所选视频任务未能加入队列，请检查资产主图和提示词', 'error')
    }
  }

  return (
    <section className="storyboardWorkspace">
      <div className="batchVideoBar" aria-label="批量视频生成">
        <div className="batchVideoSummary">
          <strong>组合生成视频</strong>
          <small>{batchEpisode?.label || '请在同一集内勾选分镜'} · 已选 {batchStoryboards.length} 镜 → 生成 {plannedVideoGroups.length} 条</small>
        </div>
        <div className="storyboardsPerVideoControl">
          <span>每条包含</span>
          <div className="ratioControl" aria-label="每条视频包含的分镜数">
            {([1, 2, 3, 4] as StoryboardVideoGroupSize[]).map((count) => (
              <button
                key={count}
                type="button"
                className={storyboardsPerVideo === count ? 'active' : ''}
                onClick={() => setStoryboardsPerVideo(count)}
              >{count} 镜</button>
            ))}
          </div>
          <small>建议每条 3-4 镜；相邻镜头会按比例压入最长 {selectedBatchModel?.maximumDuration || 15} 秒</small>
        </div>
        <div className="batchModelControl">
          <label>
            视频模型
            <select value={batchModel} onChange={(event) => setBatchModel(event.target.value)}>
              {videoModels.length === 0 ? <option value={batchModel}>正在读取模型…</option> : null}
              {videoModels.map((model) => (
                <option key={model.id} value={model.id} disabled={model.available === false}>
                  {model.label} · {model.priceLabel}{model.available === false ? '（不可用）' : ''}
                </option>
              ))}
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
        </div>
        <label>
          清晰度
          <select
            value={batchResolution}
            onChange={(event) => setBatchResolution(event.target.value as VideoResolution)}
          >
            {(selectedBatchModel?.resolutions || [batchResolution]).map((resolution) => (
              <option key={resolution} value={resolution}>{resolution === '720p' ? 'HD 720p' : '标准 480p'}</option>
            ))}
          </select>
        </label>
        <div className="batchVideoEstimate" aria-live="polite">
          <strong>预计 ¥{batchPrice.toFixed(2)}</strong>
          <small>{batchStoryboards.length > 0
            ? `串行耗时 ${formatMinuteRange(batchTime.minimum, batchTime.maximum)}`
            : '勾选分镜后计算'}</small>
        </div>
        <button
          className="primaryButton compact"
          type="button"
          disabled={batchSubmitting
            || plannedVideoGroups.length === 0
            || !selectedBatchModel
            || selectedBatchModel.available === false
            || Boolean(batchActionError)}
          onClick={() => void generateBatch()}
        >
          {batchSubmitting ? <Loader2 className="spin" size={16} /> : <ListVideo size={16} />}
          {batchSubmitting ? '正在加入队列' : `生成 ${plannedVideoGroups.length || 0} 条视频`}
        </button>
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
            const readyStoryboards = group.storyboards.filter((storyboard) => (
              Boolean(storyboard.videoPrompt?.trim())
              && storyboard.assets.some((asset) => asset.hasSelectedImage)
              && !activeVideoStoryboardIds.has(storyboard.id)
            ))
            const selectedCount = group.storyboards.filter((storyboard) => batchIds.includes(storyboard.id)).length
            const allReadySelected = readyStoryboards.length > 0
              && readyStoryboards.every((storyboard) => batchIds.includes(storyboard.id))
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
                      <label title="选择本集内已保存提示词且已有资产主图的分镜">
                        <input
                          type="checkbox"
                          checked={allReadySelected}
                          disabled={readyStoryboards.length === 0}
                          onChange={() => toggleReadyStoryboards(group)}
                        />
                        选择本集可生成镜头
                      </label>
                      <span>{selectedCount}/{group.storyboards.length}</span>
                    </div>
                    <div className="sceneList">
                      {group.storyboards.map((storyboard) => {
                        const task = storyboard.latestTask
                        const active = activeVideoStoryboardIds.has(storyboard.id)
                        const status = active || task?.status === 'queued' || task?.status === 'processing'
                          ? '生成中'
                          : task?.status === 'failed'
                            ? '失败'
                            : generatedVideoStoryboardIds.has(storyboard.id) ? '已出片' : '草稿'
                        const hasPrompt = Boolean(storyboard.videoPrompt?.trim())
                        const hasReference = storyboard.assets.some((asset) => asset.hasSelectedImage)
                        const selectable = hasPrompt && hasReference && !active
                        const unavailableReason = !hasPrompt
                          ? '请先填写并保存视频提示词'
                          : !hasReference ? '请先为已识别资产选择主图' : active ? '该分镜已在生成队列中' : ''
                        return (
                          <div className={`sceneRow ${batchIds.includes(storyboard.id) ? 'checked' : ''}`} key={storyboard.id}>
                            <label className="sceneBatchCheck" title={unavailableReason || '加入组合视频队列'}>
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
        selectedTask={creating ? null : selectedTask}
        videoModels={videoModels}
        defaultVideoModel={defaultVideoModel}
        videoPriceNotice={videoPriceNotice}
        nextSceneNumber={storyboards.length + 1}
        onCancelCreate={() => onCreating(false)}
        onCreate={onCreate}
        onSave={onSave}
        onDelete={onDelete}
        onGenerate={onGenerate}
        onSelectVideo={onSelectVideo}
      />
    </section>
  )
}

function StoryboardEditor({
  storyboard,
  selectedTask,
  videoModels,
  defaultVideoModel,
  videoPriceNotice,
  nextSceneNumber,
  onCancelCreate,
  onCreate,
  onSave,
  onDelete,
  onGenerate,
  onSelectVideo,
}: {
  storyboard: StoryboardRecord | null
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
  onDelete: (storyboard: StoryboardRecord) => Promise<void>
  onGenerate: (storyboard: StoryboardRecord, settings: {
    duration: number
    aspectRatio: StoryboardAspectRatio
    resolution: VideoResolution
    generateAudio: boolean
    model: string
  }, quiet?: boolean) => Promise<TaskRecord | null>
  onSelectVideo: (storyboard: StoryboardRecord, video: StoryboardVideo) => Promise<void>
}) {
  const [draft, setDraft] = useState({
    title: storyboard?.title || `分镜 ${nextSceneNumber}`,
    videoPrompt: storyboard?.videoPrompt || '',
    notes: storyboard?.notes || '',
    duration: storyboard?.duration || 15,
    aspectRatio: storyboard?.aspectRatio || '16:9' as StoryboardAspectRatio,
    resolution: '720p' as VideoResolution,
    generateAudio: storyboard?.generateAudio ?? true,
    model: selectedTask?.model || defaultVideoModel,
  })
  const [saving, setSaving] = useState(false)
  const generating = selectedTask?.status === 'queued' || selectedTask?.status === 'processing'
  const selectedVideo = storyboard?.videos.find((video) => video.id === storyboard.selectedVideoId)
    || storyboard?.videos[0]
    || null
  const selectedModel = videoModels.find((model) => model.id === draft.model) || null
  const availableResolutions = selectedModel?.resolutions || [draft.resolution]
  const availableAspectRatios = selectedModel?.aspectRatios || [draft.aspectRatio]
  const promptDirty = Boolean(storyboard) && draft.videoPrompt !== (storyboard?.videoPrompt || '')
  const generationTime = selectedModel
    ? estimateVideoGenerationSeconds(selectedModel.family, draft.duration)
    : null

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
      const generateAudio = usableModel.supportsAudio && current.generateAudio
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

  async function save() {
    setSaving(true)
    const input = {
      title: draft.title,
      videoPrompt: draft.videoPrompt,
      notes: draft.notes || null,
      duration: draft.duration,
      aspectRatio: draft.aspectRatio,
      generateAudio: draft.generateAudio,
    }
    const result = storyboard
      ? await onSave(storyboard, input)
      : await onCreate(input)
    setSaving(false)
    return result
  }

  async function generate() {
    const saved = await save()
    if (!saved) return
    await onGenerate(saved, {
      duration: draft.duration,
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      generateAudio: draft.generateAudio,
      model: draft.model,
    })
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
          </div>
        </div>

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
            onChange={(videoPrompt) => setDraft((current) => ({ ...current, videoPrompt }))}
          />
          <small className="promptUsageHint">单个生成会先自动保存；批量生成使用最近保存的版本。当前 {draft.videoPrompt.length} 字。</small>
        </label>

        <div className="referenceSection">
          <div className="sectionLabel">
            <strong>已识别人物与场景</strong>
            <span>{storyboard?.assets.length || 0}/{selectedModel?.maximumReferenceImages || 4} 参考图</span>
          </div>
          {storyboard?.assets.length ? (
            <div className="referenceStrip">
              {storyboard.assets.map((asset, index) => (
                <div className={`referenceItem ${asset.hasSelectedImage ? '' : 'missing'}`} key={asset.id} title={asset.matchReason}>
                  <span className="referenceImage">
                    {asset.imageUrl ? <img src={asset.imageUrl} alt={asset.name} /> : <ImageIcon size={24} />}
                    <b>@{index + 1}</b>
                  </span>
                  <span><strong>{asset.name}</strong><small>{asset.hasSelectedImage ? typeLabels[asset.type] : '缺少主图'}</small></span>
                </div>
              ))}
            </div>
          ) : (
            <div className="referenceEmpty">尚未匹配剧本中的人物或场景</div>
          )}
        </div>

        <div className="generationSettings">
          <div className="videoModelControl">
            <label>
              视频模型
              <select
                value={draft.model}
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
              >
                {videoModels.length === 0 ? <option value={draft.model}>正在读取模型价格…</option> : null}
                {videoModels.map((model) => (
                  <option key={model.id} value={model.id} disabled={model.available === false}>
                    {model.label} · {model.priceLabel}{model.available === false ? '（当前不可用）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="modelPriceSummary">
              {selectedModel ? (
                <>
                  <span><b>{selectedModel.priceLabel} · {selectedModel.priceSource === 'live' ? '实时价' : '参考价'}</b><strong>{videoPriceEstimate(selectedModel, draft.duration)}</strong></span>
                  <small>{selectedModel.description} 预计耗时 {generationTime
                    ? formatMinuteRange(generationTime.minimum, generationTime.maximum)
                    : '等待模型信息'}。{videoPriceNotice}</small>
                </>
              ) : (
                <small>{videoPriceNotice}</small>
              )}
            </div>
          </div>
          <div className="durationControl">
            <span>时长 <strong>{draft.duration}s</strong></span>
            {selectedModel?.supportedDurations?.length ? (
              <div className="ratioControl durationOptions" aria-label="视频时长">
                {selectedModel.supportedDurations.map((duration) => (
                  <button
                    key={duration}
                    type="button"
                    className={draft.duration === duration ? 'active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, duration }))}
                  >{duration}s</button>
                ))}
              </div>
            ) : (
              <input
                type="range"
                min={selectedModel?.minimumDuration || 4}
                max={selectedModel?.maximumDuration || 15}
                value={draft.duration}
                onChange={(event) => setDraft((current) => ({ ...current, duration: Number(event.target.value) }))}
              />
            )}
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
                >{resolution === '720p' ? 'HD 720p' : '标准 480p'}</button>
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
          {generating ? (
            <div className="renderOverlay">
              <Loader2 className="spin" size={25} />
              <strong>{selectedTask?.status === 'queued' ? '等待生成' : '正在生成'}</strong>
              <div className="progressTrack"><span style={{ width: `${selectedTask?.progress || 4}%` }} /></div>
              <small>{selectedTask?.progress || 0}%</small>
            </div>
          ) : null}
        </div>

        <button
          className="primaryButton generateVideoButton"
          data-assistant-target="generate-video"
          type="button"
          onClick={() => void generate()}
          disabled={saving || generating || !draft.videoPrompt.trim() || !draft.model || selectedModel?.available === false}
        >
          {generating ? <Loader2 className="spin" size={17} /> : <Clapperboard size={17} />}
          {generating
            ? `${selectedModel?.family || '视频'} 生成中`
            : `使用 ${selectedModel?.label || '所选模型'} 生成 ${draft.duration}s · ${draft.resolution}`}
        </button>

        {selectedTask?.status === 'failed' ? <p className="errorText">{videoTaskErrorMessage(selectedTask.error)}</p> : null}

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

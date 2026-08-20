'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Check, CheckCircle2, ChevronDown, Circle, Clapperboard, Eye, Film,
  ImageIcon, Loader2, Pencil, Play, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles,
  UserRound, Video, XCircle,
} from 'lucide-react'
import { VideoModelSelectOptions } from '@/components/VideoModelSelectOptions'
import type { getDirectorProductionData } from '@/lib/director-data'
import type { ActingStageOutput, CinedanceStageOutput, DirectorEditableStage, LiraStageOutput } from '@/lib/director-system'
import type { PresentableVideoModel } from '@/lib/video-model-presentation'
import { planVideoReferences } from '@/lib/video-reference-plan'
import styles from './director.module.css'

type Production = Awaited<ReturnType<typeof getDirectorProductionData>>
type StageKey = DirectorEditableStage | 'review'
type StageRow = Production['stages'][number]
type SourceAsset = { id: string; type: string; name: string; description: string; selectedImage: { mediaId: string; url: string } | null }
type StateAsset = Production['characterStateAssets'][number]

const stageOrder: StageKey[] = ['acting', 'lira', 'cinedance', 'review']
const stageMeta = {
  acting: { number: '01', short: 'ACTING', title: '表演与声音', description: '角色如何行动、反应和说话' },
  lira: { number: '02', short: 'LIRA', title: '视觉资产', description: '锁定角色状态、场景与关键帧' },
  cinedance: { number: '03', short: 'CINEDANCE', title: '动态镜头', description: '空间、视线、动作、物理与连续性' },
  review: { number: '04', short: 'REVIEW', title: '生成与审片', description: '生成、比较并人工选择成片' },
} as const

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`)
  return payload as T
}

function stageIndex(value: string) {
  if (value === 'completed') return stageOrder.length
  return stageOrder.indexOf(value as StageKey)
}

function outputFor<T>(production: Production, stage: DirectorEditableStage) {
  return production.stages.find((item) => item.stage === stage)?.output as T | null
}

function stageState(production: Production, key: StageKey) {
  const current = stageIndex(production.currentStage)
  const index = stageOrder.indexOf(key)
  if (index < current) return 'confirmed'
  if (index === current) return 'current'
  return 'locked'
}

function StageRail({ production, active, onSelect }: { production: Production; active: StageKey; onSelect: (stage: StageKey) => void }) {
  return <aside className={styles.stageRail} aria-label="制作阶段">
    <div className={styles.railContext}><small>制作流程</small><strong>{production.sourceEpisode ? `第 ${production.sourceEpisode.episodeNumber} 集` : '项目剧本'}</strong></div>
    <ol>{stageOrder.map((key) => {
      const state = stageState(production, key)
      const selectable = state !== 'locked'
      return <li key={key}><button type="button" disabled={!selectable} className={`${styles.stageItem} ${active === key ? styles.active : ''}`} onClick={() => selectable && onSelect(key)}>
        <span className={styles.stageMarker}>{state === 'confirmed' ? <Check size={14} /> : state === 'current' ? <Circle size={11} fill="currentColor" /> : <span>{stageMeta[key].number}</span>}</span>
        <span><small>{stageMeta[key].short}</small><strong>{stageMeta[key].title}</strong><em>{state === 'confirmed' ? '已确认' : state === 'current' ? '进行中' : '等待前序确认'}</em></span>
      </button></li>
    })}</ol>
    <div className={styles.railPromise}><ShieldCheck size={17} /><span><strong>阶段确认锁</strong><small>AI 不会越过你的决定</small></span></div>
  </aside>
}

function AssetStrip({ assets, selected = [], onToggle }: { assets: SourceAsset[]; selected?: string[]; onToggle?: (mediaId: string) => void }) {
  const visual = assets.filter((asset) => asset.selectedImage)
  return <section className={styles.assetStrip} aria-label="项目媒体资产">
    <div className={styles.assetStripHeading}><span><ImageIcon size={15} />项目资产</span><small>{visual.length} 项已锁定参考</small></div>
    <div className={styles.assetStripTrack}>{visual.map((asset) => {
      const mediaId = asset.selectedImage!.mediaId
      const chosen = selected.includes(mediaId)
      return <button type="button" key={asset.id} className={chosen ? styles.assetSelected : ''} onClick={() => onToggle?.(mediaId)} disabled={!onToggle} aria-pressed={chosen}>
        {/* eslint-disable-next-line @next/next/no-img-element */}<img src={asset.selectedImage!.url} alt={asset.name} />
        <span><strong>{asset.name}</strong><small>{asset.type === 'character' ? '角色' : asset.type === 'location' ? '场景' : '道具'}</small></span>
        {chosen ? <i><Check size={12} /></i> : null}
      </button>
    })}</div>
  </section>
}

function ActingResult({ output }: { output: ActingStageOutput }) {
  const [character, setCharacter] = useState(output.characterProfiles[0]?.assetId || '')
  const profile = output.characterProfiles.find((item) => item.assetId === character) || output.characterProfiles[0]
  const voice = output.voiceProfiles.find((item) => item.assetId === profile?.assetId)
  const shots = output.shotPerformances.filter((item) => item.assetId === profile?.assetId)
  return <div className={styles.resultStack}>
    <p className={styles.resultSummary}>{output.summary}</p>
    <div className={styles.characterTabs}>{output.characterProfiles.map((item) => <button type="button" className={item.assetId === profile?.assetId ? styles.active : ''} onClick={() => setCharacter(item.assetId)} key={item.assetId}><UserRound size={15} />{item.assetName}</button>)}</div>
    {profile ? <section className={styles.profileSheet}>
      <div className={styles.profileLead}><span><UserRound size={21} /></span><div><h3>{profile.assetName}</h3><p>{profile.masterPrompt}</p></div><span className={styles.lockChip}><ShieldCheck size={13} />角色真相</span></div>
      <dl className={styles.definitionGrid}><div><dt>身体行为</dt><dd>{profile.physicality}</dd></div><div><dt>心理引擎</dt><dd>{profile.psychologicalEngine}</dd></div><div><dt>眼神生命</dt><dd>{profile.eyeLife}</dd></div><div><dt>说话行为</dt><dd>{profile.vocalBehavior}</dd></div></dl>
      {voice ? <div className={styles.voiceLine}><strong>固定声音</strong><p>{voice.prompt}</p><span>{voice.locked ? '已锁定' : '可调整'}</span></div> : null}
    </section> : null}
    <section className={styles.beatSection}><div className={styles.sectionHeading}><h3>镜头表演节拍</h3><span>{shots.length} 个镜头任务</span></div>{shots.map((shot) => <article className={styles.shotBeat} key={`${shot.shotKey}-${shot.assetId}`}>
      <header><span>{shot.shotKey}</span><strong>{shot.shotTitle}</strong><small>目标：{shot.objective}</small></header>
      <div className={styles.beatTrack}>{shot.beats.map((beat) => <div key={beat.order}><span>{beat.order}</span><strong>{beat.tactic}</strong><p>{beat.visibleBehavior}</p><small>{beat.startSeconds ?? 0}s–{beat.endSeconds ?? '结束'}s{beat.reaction ? ` · 反应：${beat.reaction}` : ''}</small></div>)}</div>
    </article>)}</section>
  </div>
}

function KeyframeCompare({
  frame,
  keyframes = [],
  referenceMediaIds = [],
  onRefresh,
}: {
  frame: LiraStageOutput['keyframes'][number] | null
  keyframes?: Production['keyframes']
  referenceMediaIds?: string[]
  onRefresh?: () => Promise<void>
}) {
  const [busyFrameId, setBusyFrameId] = useState('')
  if (!frame) return <div className={styles.emptyInline}>尚未选择关键帧。</div>
  const currentFrame = frame
  const records = keyframes.filter((item) => item.shotKey === frame.shotKey)
  const byType = (type: 'first' | 'end') => records.find((item) => item.frameType === type)
  async function generate(record: Production['keyframes'][number]) {
    setBusyFrameId(record.id)
    try {
      await requestJson(`/api/director/keyframes/${record.id}/generate-image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ referenceMediaIds }),
      })
      await onRefresh?.()
    } finally { setBusyFrameId('') }
  }
  async function select(versionId: string) {
    await requestJson(`/api/director/image-versions/${versionId}/select`, { method: 'POST' })
    await onRefresh?.()
  }
  function FramePane({ type, prompt }: { type: 'first' | 'end'; prompt: string | null }) {
    const record = byType(type)
    const selected = record?.versions.find((item) => item.id === record.selectedImageVersionId) || record?.versions[0]
    return <article><span>{type === 'first' ? '首帧' : '尾帧'}</span>
      {selected ? <div className={styles.generatedFrame}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={selected.url} alt={`${currentFrame.shotTitle}${type === 'first' ? '首帧' : '尾帧'}`} /><span>版本 {selected.version}</span></div> : <div className={styles.framePlaceholder}><ImageIcon size={24} /><small>{prompt ? (type === 'first' ? '确认空间与角色状态' : '确认动作结果') : '沿用首帧约束'}</small></div>}
      {record ? <div className={styles.frameActions}><button type="button" onClick={() => void generate(record)} disabled={busyFrameId === record.id || Boolean(record.activeTask && ['queued', 'processing'].includes(record.activeTask.status))}>{busyFrameId === record.id || record.activeTask?.status === 'queued' || record.activeTask?.status === 'processing' ? <Loader2 className={styles.spin} size={13} /> : <Sparkles size={13} />}{record.versions.length ? '生成新版本' : '生成关键帧'}</button>{record.versions.length > 1 ? <select value={record.selectedImageVersionId || selected?.id || ''} onChange={(event) => void select(event.target.value)} aria-label={`${type === 'first' ? '首帧' : '尾帧'}版本`}>{record.versions.map((version) => <option key={version.id} value={version.id}>版本 {version.version}</option>)}</select> : null}</div> : null}
      <p>{prompt || '当前镜头不需要独立尾帧。'}</p>
    </article>
  }
  return <section className={styles.keyframeCompare}>
    <div className={styles.compareHeading}><span><Film size={16} />关键帧对照</span><small>{frame.aspectRatio} · {frame.purpose}</small></div>
    <div className={styles.compareFrames}><FramePane type="first" prompt={frame.firstFramePrompt} /><FramePane type="end" prompt={frame.endFramePrompt || null} /></div>
  </section>
}

function CharacterStateAssets({ assets, onRefresh }: { assets: StateAsset[]; onRefresh: () => Promise<void> }) {
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  async function generate(asset: StateAsset) {
    setBusyId(asset.id); setError('')
    try {
      await requestJson(`/api/director/state-assets/${asset.id}/generate-image`, { method: 'POST' })
      await onRefresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '生成失败') } finally { setBusyId('') }
  }
  async function select(versionId: string) {
    setError('')
    try {
      await requestJson(`/api/director/state-image-versions/${versionId}/select`, { method: 'POST' })
      await onRefresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '选择版本失败') }
  }
  const identityMasters = assets.filter((asset) => asset.isIdentityMaster)
  const stateVariants = assets.filter((asset) => !asset.isIdentityMaster)
  const masterByAssetId = new Map(identityMasters.map((asset) => [asset.assetId, asset]))
  const locked = assets.filter((asset) => asset.selectedImageVersionId).length
  return <section className={styles.stateAssetSection}>
    <div className={styles.sectionHeading}><div><h3>角色形象资产</h3><small>先确定人物长什么样，再基于同一人物生成剧情状态</small></div><span>{locked}/{assets.length} 已锁定</span></div>
    <div className={styles.assetFlowGuide}><span><b>1</b>生成并锁定初始形象</span><i>→</i><span><b>2</b>以初始形象生成状态变体</span><i>→</i><span><b>3</b>状态图进入镜头</span></div>
    {error ? <p className={styles.errorText}>{error}</p> : null}
    <div className={styles.identityMasterList}>{identityMasters.map((master) => {
      const selected = master.versions.find((version) => version.id === master.selectedImageVersionId) || master.versions[0]
      const generating = busyId === master.id || Boolean(master.activeTask && ['queued', 'processing'].includes(master.activeTask.status))
      const variants = stateVariants.filter((asset) => asset.assetId === master.assetId)
      const lockedVariants = variants.filter((asset) => asset.selectedImageVersionId).length
      return <article key={master.id} className={master.selectedImageVersionId ? styles.identityMasterLocked : ''}>
        <div className={styles.identityMasterPreview}>{selected ? <img src={selected.url} alt={`${master.assetName} 初始形象`} /> : <div><UserRound size={32} /><span>尚未生成人物初始形象</span></div>}{master.selectedImageVersionId ? <i><ShieldCheck size={13} />身份母版已锁定</i> : null}</div>
        <div className={styles.identityMasterBody}><span className={styles.stepLabel}>第 1 步 · 人物身份</span><h4>{master.assetName} · 初始形象</h4><p>这张图决定该角色的脸、年龄、体型与基础发型。后续 {variants.length} 个状态都以它为唯一身份参考。</p>{master.activeTask?.error ? <p className={styles.errorText}>{master.activeTask.error}</p> : null}<div className={styles.masterStatusLine}><span>{master.selectedImageVersionId ? `${lockedVariants}/${variants.length} 个状态已锁定` : '锁定后开放状态生成'}</span>{master.versions.length > 1 ? <select aria-label={`${master.assetName} 初始形象版本`} value={master.selectedImageVersionId || selected?.id || ''} onChange={(event) => void select(event.target.value)}>{master.versions.map((version) => <option key={version.id} value={version.id}>母版 {version.version}{version.id === master.selectedImageVersionId ? ' · 当前' : ''}</option>)}</select> : null}<button type="button" onClick={() => void generate(master)} disabled={generating}>{generating ? <Loader2 className={styles.spin} size={14} /> : <Sparkles size={14} />}{master.versions.length ? '生成新母版' : '生成初始形象'}</button></div>{master.versions.length > 0 && !master.selectedImageVersionId ? <small className={styles.masterHint}>请选择一个母版版本，才能生成状态图。</small> : null}{master.selectedImageVersionId && master.versions.length > 1 ? <small className={styles.masterHint}>切换母版会解除该角色全部旧状态图的锁定，需要重新生成。</small> : null}</div>
      </article>
    })}</div>
    <div className={styles.variantHeading}><div><h4>状态变体</h4><small>每张图都会自动引用上方当前母版，保持同一个人</small></div><span>{stateVariants.filter((asset) => asset.selectedImageVersionId).length}/{stateVariants.length} 已锁定</span></div>
    <div className={styles.stateAssetGrid}>{stateVariants.map((asset) => {
      const selected = asset.versions.find((version) => version.id === asset.selectedImageVersionId) || asset.versions[0]
      const generating = busyId === asset.id || Boolean(asset.activeTask && ['queued', 'processing'].includes(asset.activeTask.status))
      const master = masterByAssetId.get(asset.assetId)
      const masterReady = Boolean(master?.selectedImageVersionId)
      return <article key={asset.id} className={asset.selectedImageVersionId ? styles.stateAssetLocked : ''}>
        <div className={styles.stateAssetPreview}>{selected ? <img src={selected.url} alt={`${asset.assetName} ${asset.stateName}`} /> : <div><UserRound size={26} /><span>{masterReady ? '等待生成状态图' : '等待初始形象'}</span></div>}{asset.selectedImageVersionId ? <i><ShieldCheck size={13} />已锁定</i> : !masterReady ? <i className={styles.assetBlocked}>前置步骤未完成</i> : null}</div>
        <div className={styles.stateAssetMeta}><span>{asset.stateId}</span><strong>{asset.assetName} · {asset.stateName}</strong><small>{masterReady ? `引用：${asset.assetName} 当前身份母版` : `请先生成 ${asset.assetName} 初始形象`}</small></div>
        {asset.activeTask?.error ? <p className={styles.errorText}>{asset.activeTask.error}</p> : null}
        <div className={styles.stateAssetActions}><button type="button" onClick={() => void generate(asset)} disabled={generating || !masterReady} title={masterReady ? undefined : `请先生成并锁定 ${asset.assetName} 初始形象`}>{generating ? <Loader2 className={styles.spin} size={14} /> : <Sparkles size={14} />}{asset.versions.length ? '基于母版生成新版本' : '基于母版生成'}</button>{asset.versions.length ? <select aria-label={`${asset.assetName} ${asset.stateName}版本`} value={asset.selectedImageVersionId || selected?.id || ''} onChange={(event) => void select(event.target.value)}>{asset.versions.map((version) => <option key={version.id} value={version.id}>版本 {version.version}{version.id === asset.selectedImageVersionId ? ' · 已锁定' : ''}</option>)}</select> : null}</div>
      </article>
    })}</div>
  </section>
}

function LiraResult({ output, assets, stateAssets, keyframes, onRefresh }: { output: LiraStageOutput; assets: SourceAsset[]; stateAssets: StateAsset[]; keyframes: Production['keyframes']; onRefresh: () => Promise<void> }) {
  const [selectedKey, setSelectedKey] = useState(output.keyframes[0]?.shotKey || '')
  const frame = output.keyframes.find((item) => item.shotKey === selectedKey) || output.keyframes[0] || null
  return <div className={styles.resultStack}>
    <p className={styles.resultSummary}>{output.summary}</p><AssetStrip assets={assets} />
    <CharacterStateAssets assets={stateAssets} onRefresh={onRefresh} />
    <details className={styles.advancedPanel}><summary>查看角色状态文字规划<ChevronDown size={15} /></summary><section className={styles.assetTruthTable}><div>{output.characterStates.map((state) => <article key={state.stateId}><span className={styles.stateCode}>{state.stateId}</span><div><strong>{state.assetName} · {state.stateName}</strong><p>{state.wardrobe}</p><small>{state.wearAndContinuity}</small></div><span className={styles.routeChip}>{state.imageModelRoute}{state.soulIdRequired ? ' · Soul ID' : ''}</span></article>)}</div></section></details>
    <div className={styles.keyframeTabs}>{output.keyframes.map((item) => <button type="button" className={item.shotKey === frame?.shotKey ? styles.active : ''} onClick={() => setSelectedKey(item.shotKey)} key={item.shotKey}>{item.shotKey}<small>{item.shotTitle}</small></button>)}</div>
    <KeyframeCompare frame={frame} keyframes={keyframes} onRefresh={onRefresh} />
    <details className={styles.advancedPanel}><summary>查看视觉圣经与高级提示词<ChevronDown size={15} /></summary><dl className={styles.definitionGrid}><div><dt>视觉质感</dt><dd>{output.styleBible.visualRegister}</dd></div><div><dt>光线规则</dt><dd>{output.styleBible.lightingRule}</dd></div><div><dt>材料规则</dt><dd>{output.styleBible.materialRule}</dd></div><div><dt>色板规则</dt><dd>{output.styleBible.paletteRule}</dd></div></dl></details>
  </div>
}

function ContinuityLedger({ shot }: { shot: CinedanceStageOutput['shots'][number] }) {
  const rows = [
    ['角色状态', shot.continuityOut.characterStates.map((item) => `${item.assetId} · ${item.stateId}`).join('；') || '无'],
    ['道具状态', shot.continuityOut.propStates.map((item) => `${item.assetId} · ${item.position}`).join('；') || '无'],
    ['银幕方向', shot.continuityOut.screenDirection],
    ['视线', shot.continuityOut.gazeLines.join('；') || '无'],
    ['光线方向', shot.continuityOut.lightingDirection],
    ['空间地标', shot.continuityOut.geographyFacts.join('；') || '无'],
  ]
  return <section className={styles.ledger}><div className={styles.compareHeading}><span><ShieldCheck size={16} />连续性账本</span><small>本镜结束状态 → 下一镜输入</small></div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd><CheckCircle2 size={14} /></div>)}</dl></section>
}

function CinedanceResult({ output, lira, keyframes, onRefresh }: { output: CinedanceStageOutput; lira: LiraStageOutput | null; keyframes: Production['keyframes']; onRefresh: () => Promise<void> }) {
  const [shotKey, setShotKey] = useState(output.shots[0]?.shotKey || '')
  const shot = output.shots.find((item) => item.shotKey === shotKey) || output.shots[0]
  const frame = lira?.keyframes.find((item) => item.shotKey === shot?.shotKey) || null
  if (!shot) return null
  return <div className={styles.resultStack}>
    <p className={styles.resultSummary}>{output.summary}</p>
    <div className={styles.shotSelector}>{output.shots.map((item) => <button type="button" className={item.shotKey === shot.shotKey ? styles.active : ''} onClick={() => setShotKey(item.shotKey)} key={item.shotKey}><span>{String(item.order).padStart(2, '0')}</span><strong>{item.title}</strong><small>{item.duration}s · {item.optics.diagonalFieldOfView}</small></button>)}</div>
    <KeyframeCompare frame={frame} keyframes={keyframes} onRefresh={onRefresh} />
    <section className={styles.motionPlan}><div className={styles.motionLead}><span>{shot.optics.diagonalFieldOfView}</span><div><h3>{shot.title}</h3><p>{shot.firstFrame}</p></div></div><dl className={styles.definitionGrid}><div><dt>空间站位</dt><dd>{shot.spatialBlocking}</dd></div><div><dt>镜头操作</dt><dd>{shot.camera}</dd></div><div><dt>物理约束</dt><dd>{shot.physics}</dd></div><div><dt>灯光</dt><dd>{shot.lighting}</dd></div></dl><div className={styles.timingTrack}>{shot.actionTiming.map((item, index) => <div key={`${item.from}-${index}`}><span>{item.from}s–{item.to}s</span><p>{item.action}</p></div>)}</div></section>
    <ContinuityLedger shot={shot} />
    <details className={styles.advancedPanel}><summary>查看 Seedance 完整提示词<ChevronDown size={15} /></summary><pre>{shot.generationPrompt}</pre></details>
  </div>
}

function ReviewWorkspace({ production, onRefresh }: { production: Production; onRefresh: () => Promise<void> }) {
  const [shotId, setShotId] = useState(production.shots[0]?.id || '')
  const shot = production.shots.find((item) => item.id === shotId) || production.shots[0]
  const sourceAssets = ((production.sourceSnapshot as { assets?: SourceAsset[] })?.assets || [])
  const stateAssets: SourceAsset[] = production.characterStateAssets.flatMap((asset) => {
    const selected = asset.versions.find((version) => version.id === asset.selectedImageVersionId)
    return selected ? [{ id: asset.id, type: 'character', name: `${asset.assetName} · ${asset.stateName}`, description: asset.prompt, selectedImage: { mediaId: selected.mediaId, url: selected.url } }] : []
  })
  const assets = [...stateAssets, ...sourceAssets]
  const [models, setModels] = useState<PresentableVideoModel[]>([])
  const [model, setModel] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const unresolvedCharacterAssets = production.characterStateAssets.filter((asset) => !asset.selectedImageVersionId).length
  useEffect(() => { void requestJson<{ models: PresentableVideoModel[]; defaultModel: string }>('/api/video-models').then((data) => { setModels(data.models); setModel(data.defaultModel) }).catch(() => undefined) }, [])
  useEffect(() => { const active = production.shots.some((item) => item.activeTask && ['queued', 'processing'].includes(item.activeTask.status)); if (!active) return; const timer = window.setInterval(() => void onRefresh(), 4000); return () => window.clearInterval(timer) }, [production.shots, onRefresh])
  const motion = shot ? shot.motionPlan as CinedanceStageOutput['shots'][number] : null
  const selectedFirstFrame = production.keyframes.find((frame) => frame.shotKey === motion?.shotKey && frame.frameType === 'first')
  const selectedFirstVersion = selectedFirstFrame?.versions.find((version) => version.id === selectedFirstFrame.selectedImageVersionId)
  const lira = outputFor<LiraStageOutput>(production, 'lira')
  const shotStateIds = lira?.keyframes.find((frame) => frame.shotKey === motion?.shotKey)?.characterStateIds || []
  const lockedStateReferences = production.characterStateAssets.filter((asset) => shotStateIds.includes(asset.stateId)).flatMap((asset) => {
    const selected = asset.versions.find((version) => version.id === asset.selectedImageVersionId)
    return selected ? [selected.mediaId] : []
  })
  useEffect(() => {
    setReferences([...new Set([...lockedStateReferences, ...(selectedFirstVersion ? [selectedFirstVersion.mediaId] : [])])])
  }, [shot?.id, selectedFirstVersion?.mediaId, lockedStateReferences.join('|')])
  const selectedModel = models.find((item) => item.id === model)
  const referencePlan = useMemo(() => planVideoReferences(
    references,
    selectedModel?.maximumReferenceImages || 0,
    selectedModel?.maximumReferenceVideos || 0,
  ), [references, selectedModel?.maximumReferenceImages, selectedModel?.maximumReferenceVideos])
  if (!shot || !motion) return <div className={styles.emptyState}><Film size={24} /><strong>还没有可生成的镜头</strong><p>确认 CINEDANCE 后，镜头会出现在这里。</p></div>
  function toggleReference(mediaId: string) {
    setError('')
    setReferences((current) => {
      if (current.includes(mediaId)) return current.filter((id) => id !== mediaId)
      const capacity = selectedModel
        ? planVideoReferences([], selectedModel.maximumReferenceImages || 0, selectedModel.maximumReferenceVideos || 0).totalCapacity
        : 14
      if (current.length >= capacity) {
        setError(`当前模型最多接收 ${capacity} 项图片资产，请先取消一项再选择。`)
        return current
      }
      return [...current, mediaId]
    })
  }
  async function generate() {
    setBusy(true); setError('')
    try {
      await requestJson(`/api/director/shots/${shot.id}/generate-video`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, referenceMediaIds: references, resolution: selectedModel?.defaultResolution || '720p', generateAudio: selectedModel?.supportsAudio ?? true }) })
      await onRefresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '生成失败') } finally { setBusy(false) }
  }
  async function decide(versionId: string, decision: 'selected' | 'rejected' | 'undecided') {
    await requestJson(`/api/director/video-versions/${versionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })
    await onRefresh()
  }
  return <div className={styles.reviewLayout}>
    <div className={styles.reviewShots}>{production.shots.map((item) => <button type="button" className={item.id === shot.id ? styles.active : ''} onClick={() => setShotId(item.id)} key={item.id}><span>{String(item.order).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.duration}s · {item.versions.length} 个版本</small></div>{item.selectedVideoVersionId ? <CheckCircle2 size={15} /> : null}</button>)}</div>
    <div className={styles.reviewMain}>{unresolvedCharacterAssets > 0 ? <section className={styles.assetGateNotice}><ShieldCheck size={17} /><div><strong>先完成人物初始形象与状态图</strong><p>还有 {unresolvedCharacterAssets} 项人物资产未锁定。请返回 LIRA，先确定每个角色的身份母版，再生成状态变体。</p></div></section> : null}<AssetStrip assets={assets} selected={references} onToggle={toggleReference} />
      {selectedModel && references.length > 0 ? <section className={`${styles.referencePackingNotice} ${referencePlan.rejectedMediaIds.length ? styles.referencePackingError : ''}`}><Video size={17} /><div><strong>{referencePlan.videoGroups.length ? `自动提交 ${referencePlan.imageMediaIds.length} 张原图 + ${referencePlan.videoGroups.length} 段参考视频` : `按原图提交 ${referencePlan.imageMediaIds.length} 张参考`}</strong><p>{referencePlan.videoGroups.length ? `前 ${selectedModel.maximumReferenceImages} 张保留原图精度；其余 ${referencePlan.videoGroups.flat().length} 张分别制作成无转场、无音频的静态参考视频，每张图片对应一段视频。视频只表达身份、服装、场景和道具，不作为动作参考。` : `当前模型的原图上限为 ${selectedModel.maximumReferenceImages || 0} 张。选择顺序决定优先级，最重要的角色状态图请放在前面。`}</p></div></section> : null}
      <section className={styles.generationBar}><div><strong>生成 {shot.title}</strong><small>{motion.optics.diagonalFieldOfView} · {shot.duration}s · 实际提交 {referencePlan.imageMediaIds.length} 张原图{referencePlan.videoGroups.length ? ` + ${referencePlan.videoGroups.length} 段参考视频` : ''}</small></div><label>模型<select value={model} onChange={(event) => { setModel(event.target.value); setError('') }}><VideoModelSelectOptions models={models} /></select></label><button className={styles.primaryButton} type="button" onClick={() => void generate()} disabled={!model || busy || unresolvedCharacterAssets > 0 || referencePlan.rejectedMediaIds.length > 0 || Boolean(shot.activeTask && ['queued', 'processing'].includes(shot.activeTask.status))}>{busy || shot.activeTask?.status === 'queued' || shot.activeTask?.status === 'processing' ? <Loader2 className={styles.spin} size={16} /> : <Sparkles size={16} />}{unresolvedCharacterAssets > 0 ? '先完成人物资产' : referencePlan.rejectedMediaIds.length ? '参考资产超出上限' : shot.activeTask?.status === 'processing' ? `生成中 ${shot.activeTask.progress}%` : '生成新版本'}</button></section>
      {error || shot.activeTask?.error ? <p className={styles.errorText}>{error || shot.activeTask?.error}</p> : null}
      <section className={styles.versionGrid}>{shot.versions.length ? shot.versions.map((version) => <article className={`${styles.videoVersion} ${version.decision === 'selected' ? styles.versionSelected : ''}`} key={version.id}><div className={styles.videoFrame}><video src={version.url} controls preload="metadata" />{version.decision === 'selected' ? <span><Check size={13} />已选成片</span> : null}</div><div className={styles.versionMeta}><div><strong>{version.name}</strong><small>{version.model} · {version.duration}s</small></div><div><button type="button" onClick={() => void decide(version.id, 'rejected')} className={version.decision === 'rejected' ? styles.dangerActive : ''}><XCircle size={15} />不采用</button><button type="button" onClick={() => void decide(version.id, 'selected')}><CheckCircle2 size={15} />选为成片</button></div></div></article>) : <div className={styles.emptyState}><Play size={25} /><strong>等待第一个视频版本</strong><p>选择关键参考图并生成。成片由你人工判断，AI 不会替你打分。</p></div>}</section>
      <ContinuityLedger shot={motion} />
    </div>
  </div>
}

export function DirectorWorkspace({ user, initialProduction }: { user: { name: string; email: string }; initialProduction: Production }) {
  const [production, setProduction] = useState(initialProduction)
  const currentKey: StageKey = production.currentStage === 'completed' ? 'review' : production.currentStage as StageKey
  const [activeStage, setActiveStage] = useState<StageKey>(currentKey)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const activeRow = activeStage === 'review' ? null : production.stages.find((item) => item.stage === activeStage) as StageRow | undefined
  const sourceAssets = ((production.sourceSnapshot as { assets?: SourceAsset[] })?.assets || [])
  const acting = outputFor<ActingStageOutput>(production, 'acting')
  const lira = outputFor<LiraStageOutput>(production, 'lira')
  const cinedance = outputFor<CinedanceStageOutput>(production, 'cinedance')
  const [jsonDraft, setJsonDraft] = useState('')

  async function refresh() {
    const result = await requestJson<{ production: Production }>(`/api/director/productions/${production.id}`)
    setProduction(result.production)
    return undefined
  }
  useEffect(() => { const generating = production.stages.some((item) => item.status === 'generating') || production.keyframes.some((frame) => frame.activeTask && ['queued', 'processing'].includes(frame.activeTask.status)) || production.characterStateAssets.some((asset) => asset.activeTask && ['queued', 'processing'].includes(asset.activeTask.status)); if (!generating) return; const timer = window.setInterval(() => void refresh(), 3500); return () => window.clearInterval(timer) })
  useEffect(() => { setActiveStage(currentKey) }, [currentKey])

  async function generateStage() {
    if (activeStage === 'review') return
    setBusy(true); setError('')
    try {
      await requestJson(`/api/director/productions/${production.id}/stages/${activeStage}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feedback }) })
      setFeedback(''); await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '生成失败') } finally { setBusy(false) }
  }
  async function confirmStage() {
    if (activeStage === 'review') return
    setBusy(true); setError('')
    try { await requestJson(`/api/director/productions/${production.id}/stages/${activeStage}/confirm`, { method: 'POST' }); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : '确认失败') } finally { setBusy(false) }
  }
  async function saveJson() {
    if (activeStage === 'review') return
    setBusy(true); setError('')
    try { const output = JSON.parse(jsonDraft); await requestJson(`/api/director/productions/${production.id}/stages/${activeStage}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ output }) }); setEditing(false); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败') } finally { setBusy(false) }
  }
  async function completeProduction() {
    setBusy(true); setError('')
    try {
      await requestJson(`/api/director/productions/${production.id}/complete`, { method: 'POST' })
      await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : '完成制作失败') } finally { setBusy(false) }
  }
  const status = activeRow?.status || (activeStage === 'review' ? 'ready' : 'draft')
  const liraAssetsLocked = activeStage !== 'lira' || (production.characterStateAssets.length > 0 && production.characterStateAssets.every((asset) => asset.selectedImageVersionId))
  const canConfirm = activeStage !== 'review' && stageState(production, activeStage) === 'current' && status === 'ready' && liraAssetsLocked
  const title = stageMeta[activeStage]

  return <main className={styles.workspaceShell}>
    <header className={styles.workspaceHeader}><div className={styles.headerIdentity}><Link href="/director" aria-label="返回制作列表"><ArrowLeft size={17} /></Link><span><Clapperboard size={18} /></span><strong>导演工作台</strong></div><div className={styles.projectCrumb}><small>{production.project.name}</small><strong>{production.name}</strong></div><div className={styles.headerActions}><span>{user.name}</span><Link href={`/projects/${production.project.id}`}>查看原项目</Link></div></header>
    <div className={styles.workspaceGrid}><StageRail production={production} active={activeStage} onSelect={setActiveStage} />
      <section className={styles.workArea}><header className={styles.stageHeader}><div><span>{title.short} · {title.number}</span><h1>{title.title}</h1><p>{title.description}</p></div><span className={`${styles.statusChip} ${status === 'confirmed' ? styles.confirmed : ''}`}>{status === 'generating' ? <Loader2 className={styles.spin} size={13} /> : status === 'confirmed' ? <Check size={13} /> : <Circle size={11} />}{status === 'draft' ? '等待生成' : status === 'generating' ? 'AI 正在工作' : status === 'ready' ? '等待确认' : status === 'confirmed' ? '已确认' : status === 'failed' ? '需要重试' : '可审片'}</span></header>
        {activeStage === 'review' ? <ReviewWorkspace production={production} onRefresh={refresh} /> : status === 'generating' ? <div className={styles.loadingState}><div className={styles.skeletonWide} /><div className={styles.skeletonRows}>{[0, 1, 2].map((item) => <i key={item} />)}</div><strong>{title.short} 正在整理结构化结果</strong><p>可以离开页面，后台会继续处理。</p></div> : activeRow?.error && !activeRow.output ? <div className={styles.errorState}><XCircle size={24} /><strong>AI 返回的结果需要重新整理</strong><p>{activeRow.error}</p><button className={styles.quietButton} type="button" disabled={busy} onClick={() => void generateStage()}>{busy ? <Loader2 className={styles.spin} size={16} /> : <RotateCcw size={16} />}{busy ? '正在重新提交' : '重新生成本阶段'}</button></div> : editing ? <section className={styles.jsonEditor}><div><strong>高级结构编辑</strong><button type="button" onClick={() => setEditing(false)}>取消</button></div><p>这里编辑的是阶段交接数据。保存时会按 {title.short} Schema 完整校验。</p><textarea value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} spellCheck={false} /><button className={styles.primaryButton} type="button" onClick={() => void saveJson()} disabled={busy}><Save size={16} />保存结构</button></section> : activeStage === 'acting' && acting ? <ActingResult output={acting} /> : activeStage === 'lira' && lira ? <LiraResult output={lira} assets={sourceAssets} stateAssets={production.characterStateAssets} keyframes={production.keyframes} onRefresh={refresh} /> : activeStage === 'cinedance' && cinedance ? <CinedanceResult output={cinedance} lira={lira} keyframes={production.keyframes} onRefresh={refresh} /> : <div className={styles.emptyState}><Sparkles size={28} /><strong>从已导入剧本生成 {title.short} 方案</strong><p>AI 完成后会停在这里，等待你修改或确认。</p><button className={styles.primaryButton} type="button" onClick={() => void generateStage()} disabled={busy}>{busy ? <Loader2 className={styles.spin} size={16} /> : <Sparkles size={16} />}生成本阶段</button></div>}
      </section>
      <aside className={styles.decisionPanel}><div className={styles.decisionHeading}><Eye size={17} /><div><strong>本阶段需要你决定</strong><small>确认后才开放下一阶段</small></div></div>{activeStage === 'review' ? <div className={styles.decisionBody}><p>逐镜播放并比较版本。你可以选择成片或标记不采用；AI 不会替你审片。</p><dl><div><dt>镜头</dt><dd>{production.shots.length}</dd></div><div><dt>已选成片</dt><dd>{production.shots.filter((shot) => shot.selectedVideoVersionId).length}</dd></div></dl><button className={styles.primaryButton} type="button" onClick={() => void completeProduction()} disabled={busy || production.shots.length === 0 || production.shots.some((shot) => !shot.selectedVideoVersionId) || production.status === 'completed'}>{production.status === 'completed' ? <CheckCircle2 size={15} /> : <Film size={15} />}{production.status === 'completed' ? '制作已完成' : '确认全部成片'}</button></div> : <div className={styles.decisionBody}>{activeRow?.output ? <>{((activeRow.output as { userDecisions?: string[] }).userDecisions || []).length ? <ul>{((activeRow.output as { userDecisions?: string[] }).userDecisions || []).map((item, index) => <li key={index}><Circle size={9} fill="currentColor" />{item}</li>)}</ul> : <p>检查结果是否符合剧本意图；需要调整时写下修改意见并重新生成。</p>}<label>修改意见<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：第二个节拍反应太强，改为压住情绪后的短暂停顿。" maxLength={4000} /></label></> : <p>点击“生成本阶段”，AI 会使用已确认的前序结果继续。</p>}</div>} {error ? <p className={styles.errorText}>{error}</p> : null}</aside>
    </div>
    {activeStage !== 'review' ? <footer className={styles.confirmationBar}><div><span>{canConfirm ? <CheckCircle2 size={17} /> : <Circle size={15} />}</span><p><strong>{canConfirm ? '结果已就绪，等待你的确认' : status === 'confirmed' ? '这一阶段已经确认' : '完成并检查结果后才能继续'}</strong><small>{canConfirm ? `确认后将进入 ${stageMeta[stageOrder[stageOrder.indexOf(activeStage) + 1]]?.title || '生成与审片'}` : '已确认阶段仍可回看，但不会覆盖当前制作状态。'}</small></p></div><div>{activeRow?.output && status !== 'confirmed' ? <><button className={styles.quietButton} type="button" onClick={() => { setJsonDraft(JSON.stringify(activeRow.output, null, 2)); setEditing(true) }}><Pencil size={15} />修改结构</button><button className={styles.quietButton} type="button" onClick={() => void generateStage()} disabled={busy || status === 'generating'}><RefreshCw size={15} />按意见重生成</button></> : null}<button className={styles.primaryButton} type="button" onClick={() => void confirmStage()} disabled={!canConfirm || busy}>{busy ? <Loader2 className={styles.spin} size={16} /> : <Check size={16} />}确认并继续</button></div></footer> : null}
  </main>
}

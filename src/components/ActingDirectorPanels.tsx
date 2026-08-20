'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, ChevronDown, Loader2, Lock, Mic2, Plus, Save, Trash2, Unlock, UserRound } from 'lucide-react'

type Notice = (text: string, tone?: 'success' | 'error') => void

type TriggeredTic = { behavior: string; trigger: string }

type CharacterActingProfileRecord = {
  id: string
  masterPrompt: string
  physicality: string
  psychologicalEngine: string
  vocalBehavior: string
  signatureTics: TriggeredTic[]
  stressTics: TriggeredTic[]
  concealmentBehavior: string | null
  facialMask: string | null
  maskCrackTrigger: string | null
  pressureTransformation: string | null
  gait: string | null
  eyeLife: string
  softeningTarget: string | null
  version: number
}

type VoiceProfileRecord = {
  id: string
  prompt: string
  ageDescriptor: string | null
  originAccent: string | null
  timbreRegister: string | null
  paceDelivery: string | null
  pressureShift: string | null
  locked: boolean
  version: number
}

type PerformanceBeatRecord = {
  id?: string
  order: number
  startSeconds: number | null
  endSeconds: number | null
  tactic: string
  trigger: string | null
  behavior: string
  reaction: string | null
  gaze: string | null
  posture: string | null
  tempo: string | null
  voiceDelivery: string | null
  entryState: string | null
  exitState: string | null
}

type ShotPerformanceRecord = {
  id?: string
  assetId: string
  assetName: string
  objective: string
  obstacle: string
  stakes: string
  subtext: string | null
  business: string | null
  statusIn: string | null
  statusOut: string | null
  proximityIn: string | null
  proximityOut: string | null
  sceneAdaptation: string | null
  speaks: boolean
  qualityScore: number | null
  qualityReport?: { issues?: Array<{ code: string; message: string }> } | null
  beats: PerformanceBeatRecord[]
}

type CharacterReference = {
  id: string
  name: string
  type: 'character' | 'location' | 'prop'
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null
  if (!response.ok) throw new Error(payload?.message || payload?.error || `请求失败（${response.status}）`)
  return payload as T
}

function ticsToText(tics: TriggeredTic[]) {
  return tics.map((tic) => `${tic.behavior}｜${tic.trigger}`).join('\n')
}

function textToTics(value: string) {
  return value.split(/\r?\n/u).flatMap((line) => {
    const [behavior, ...triggerParts] = line.split(/[｜|]/u)
    const trigger = triggerParts.join('｜').trim()
    return behavior?.trim() && trigger ? [{ behavior: behavior.trim(), trigger }] : []
  })
}

const emptyActingDraft = {
  masterPrompt: '',
  physicality: '',
  psychologicalEngine: '',
  vocalBehavior: '',
  signatureTics: '',
  stressTics: '',
  concealmentBehavior: '',
  facialMask: '',
  maskCrackTrigger: '',
  pressureTransformation: '',
  gait: '',
  eyeLife: '',
  softeningTarget: '',
}

const emptyVoiceDraft = {
  prompt: '',
  ageDescriptor: '',
  originAccent: '',
  timbreRegister: '',
  paceDelivery: '',
  pressureShift: '',
  locked: true,
}

export function CharacterPerformanceProfilesPanel({
  assetId,
  characterName,
  onNotice,
}: {
  assetId: string
  characterName: string
  onNotice: Notice
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [acting, setActing] = useState(emptyActingDraft)
  const [voice, setVoice] = useState(emptyVoiceDraft)
  const [voiceExists, setVoiceExists] = useState(false)
  const [allowVoiceEdit, setAllowVoiceEdit] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void jsonRequest<{ actingProfile: CharacterActingProfileRecord | null; voiceProfile: VoiceProfileRecord | null }>(
      `/api/assets/${assetId}/performance-profiles`,
    ).then((payload) => {
      if (cancelled) return
      const profile = payload.actingProfile
      setActing(profile ? {
        masterPrompt: profile.masterPrompt,
        physicality: profile.physicality,
        psychologicalEngine: profile.psychologicalEngine,
        vocalBehavior: profile.vocalBehavior,
        signatureTics: ticsToText(profile.signatureTics),
        stressTics: ticsToText(profile.stressTics),
        concealmentBehavior: profile.concealmentBehavior || '',
        facialMask: profile.facialMask || '',
        maskCrackTrigger: profile.maskCrackTrigger || '',
        pressureTransformation: profile.pressureTransformation || '',
        gait: profile.gait || '',
        eyeLife: profile.eyeLife,
        softeningTarget: profile.softeningTarget || '',
      } : emptyActingDraft)
      setVoice(payload.voiceProfile ? {
        prompt: payload.voiceProfile.prompt,
        ageDescriptor: payload.voiceProfile.ageDescriptor || '',
        originAccent: payload.voiceProfile.originAccent || '',
        timbreRegister: payload.voiceProfile.timbreRegister || '',
        paceDelivery: payload.voiceProfile.paceDelivery || '',
        pressureShift: payload.voiceProfile.pressureShift || '',
        locked: payload.voiceProfile.locked,
      } : emptyVoiceDraft)
      setVoiceExists(Boolean(payload.voiceProfile))
      setAllowVoiceEdit(!payload.voiceProfile?.locked)
    }).catch((error) => {
      if (!cancelled) onNotice(error instanceof Error ? error.message : '读取角色表演档案失败', 'error')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [assetId, onNotice])

  const actingReady = Boolean(
    acting.masterPrompt.trim()
    && acting.physicality.trim()
    && acting.psychologicalEngine.trim()
    && acting.vocalBehavior.trim()
    && acting.eyeLife.trim(),
  )
  const hasActingInput = Object.values(acting).some((value) => value.trim())
  const canSave = (!hasActingInput || actingReady) && (actingReady || Boolean(voice.prompt.trim()))

  async function saveProfiles() {
    setSaving(true)
    try {
      const payload = await jsonRequest<{ voiceProfile: VoiceProfileRecord | null }>(
        `/api/assets/${assetId}/performance-profiles`,
        {
          method: 'PUT',
          body: JSON.stringify({
            ...(actingReady ? {
              actingProfile: {
                ...acting,
                signatureTics: textToTics(acting.signatureTics),
                stressTics: textToTics(acting.stressTics),
              },
            } : {}),
            ...(voice.prompt.trim() ? { voiceProfile: voice } : {}),
            unlockVoice: allowVoiceEdit,
          }),
        },
      )
      setVoiceExists(Boolean(payload.voiceProfile))
      setAllowVoiceEdit(!payload.voiceProfile?.locked)
      onNotice(`${characterName}的表演导演档案已保存`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '保存角色表演档案失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="actingDirectorPanel" open={panelOpen} onToggle={(event) => setPanelOpen(event.currentTarget.open)}>
      <summary>
        <span><Activity size={16} /><strong>角色表演导演</strong><small>永久行为与声音身份</small></span>
        <ChevronDown className="actingPanelChevron" size={16} />
      </summary>
      {loading ? (
        <div className="actingPanelLoading"><Loader2 className="spin" size={16} />正在读取表演档案…</div>
      ) : (
        <div className="actingPanelBody">
          <div className="actingSectionHeading">
            <span><UserRound size={15} /><strong>CharacterActingProfile</strong></span>
            <small>不写服装、摄影机、灯光或调色</small>
          </div>
          <label>
            永久表演主档案
            <textarea rows={7} value={acting.masterPrompt} onChange={(event) => setActing((current) => ({ ...current, masterPrompt: event.target.value }))} placeholder="150–220词；只描述可观察、可拍摄的行为。" />
          </label>
          <div className="actingTwoColumns">
            <label>身体传记<textarea rows={3} value={acting.physicality} onChange={(event) => setActing((current) => ({ ...current, physicality: event.target.value }))} /></label>
            <label>心理行动引擎<textarea rows={3} value={acting.psychologicalEngine} onChange={(event) => setActing((current) => ({ ...current, psychologicalEngine: event.target.value }))} /></label>
            <label>固定说话行为<textarea rows={3} value={acting.vocalBehavior} onChange={(event) => setActing((current) => ({ ...current, vocalBehavior: event.target.value }))} /></label>
            <label>眼神生命<textarea rows={3} value={acting.eyeLife} onChange={(event) => setActing((current) => ({ ...current, eyeLife: event.target.value }))} placeholder="视线目标、眨眼质量、眼睛先于头部…" /></label>
          </div>
          <details className="actingAdvanced">
            <summary>高级行为锚点</summary>
            <div className="actingTwoColumns">
              <label>标志习惯（每行：行为｜触发条件）<textarea rows={3} value={acting.signatureTics} onChange={(event) => setActing((current) => ({ ...current, signatureTics: event.target.value }))} /></label>
              <label>压力习惯（每行：行为｜触发条件）<textarea rows={3} value={acting.stressTics} onChange={(event) => setActing((current) => ({ ...current, stressTics: event.target.value }))} /></label>
              <label>掩饰行为<textarea rows={2} value={acting.concealmentBehavior} onChange={(event) => setActing((current) => ({ ...current, concealmentBehavior: event.target.value }))} /></label>
              <label>默认面具<textarea rows={2} value={acting.facialMask} onChange={(event) => setActing((current) => ({ ...current, facialMask: event.target.value }))} /></label>
              <label>面具破裂触发器<textarea rows={2} value={acting.maskCrackTrigger} onChange={(event) => setActing((current) => ({ ...current, maskCrackTrigger: event.target.value }))} /></label>
              <label>压力下转化<textarea rows={2} value={acting.pressureTransformation} onChange={(event) => setActing((current) => ({ ...current, pressureTransformation: event.target.value }))} /></label>
              <label>行走方式<input value={acting.gait} onChange={(event) => setActing((current) => ({ ...current, gait: event.target.value }))} /></label>
              <label>唯一软化对象<input value={acting.softeningTarget} onChange={(event) => setActing((current) => ({ ...current, softeningTarget: event.target.value }))} /></label>
            </div>
          </details>

          <div className="actingSectionHeading voiceHeading">
            <span><Mic2 size={15} /><strong>VoiceProfile</strong></span>
            <button className="quietButton compact" type="button" onClick={() => setAllowVoiceEdit((value) => !value)}>
              {voiceExists && voice.locked && !allowVoiceEdit ? <Lock size={14} /> : <Unlock size={14} />}
              {voiceExists && voice.locked && !allowVoiceEdit ? '已锁定' : '允许编辑'}
            </button>
          </div>
          <fieldset className="voiceProfileFields" disabled={voiceExists && voice.locked && !allowVoiceEdit}>
            <label>固定声音提示词<textarea rows={3} value={voice.prompt} onChange={(event) => setVoice((current) => ({ ...current, prompt: event.target.value }))} placeholder="有台词时原样加入音频字段，不按场景改写。" /></label>
            <div className="actingTwoColumns compactFields">
              <label>年龄声线<input value={voice.ageDescriptor} onChange={(event) => setVoice((current) => ({ ...current, ageDescriptor: event.target.value }))} /></label>
              <label>来源与口音<input value={voice.originAccent} onChange={(event) => setVoice((current) => ({ ...current, originAccent: event.target.value }))} /></label>
              <label>音色与音域<input value={voice.timbreRegister} onChange={(event) => setVoice((current) => ({ ...current, timbreRegister: event.target.value }))} /></label>
              <label>语速与表达<input value={voice.paceDelivery} onChange={(event) => setVoice((current) => ({ ...current, paceDelivery: event.target.value }))} /></label>
              <label>压力下变化<input value={voice.pressureShift} onChange={(event) => setVoice((current) => ({ ...current, pressureShift: event.target.value }))} /></label>
              <label className="actingCheckbox"><input type="checkbox" checked={voice.locked} onChange={(event) => setVoice((current) => ({ ...current, locked: event.target.checked }))} />保存后锁定声音身份</label>
            </div>
          </fieldset>
          {hasActingInput && !actingReady ? <small className="actingValidation">主档案、身体传记、行动引擎、说话行为和眼神生命均为必填。</small> : null}
          <button className="primaryButton actingSaveButton" type="button" disabled={!canSave || saving} onClick={() => void saveProfiles()}>
            {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            保存角色表演档案
          </button>
        </div>
      )}
    </details>
  )
}

function emptyBeat(order: number): PerformanceBeatRecord {
  return {
    order,
    startSeconds: null,
    endSeconds: null,
    tactic: '',
    trigger: null,
    behavior: '',
    reaction: null,
    gaze: null,
    posture: null,
    tempo: null,
    voiceDelivery: null,
    entryState: null,
    exitState: null,
  }
}

function emptyPerformance(asset: CharacterReference): ShotPerformanceRecord {
  return {
    assetId: asset.id,
    assetName: asset.name,
    objective: '',
    obstacle: '',
    stakes: '',
    subtext: null,
    business: null,
    statusIn: null,
    statusOut: null,
    proximityIn: null,
    proximityOut: null,
    sceneAdaptation: null,
    speaks: false,
    qualityScore: null,
    beats: [emptyBeat(1)],
  }
}

export function ShotPerformancePanel({
  storyboardId,
  duration,
  assets,
  onNotice,
}: {
  storyboardId: string
  duration: number
  assets: CharacterReference[]
  onNotice: Notice
}) {
  const characters = useMemo(() => assets.filter((asset) => asset.type === 'character'), [assets])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [performances, setPerformances] = useState<ShotPerformanceRecord[]>([])
  const [selectedAssetId, setSelectedAssetId] = useState(characters[0]?.id || '')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void jsonRequest<{ performances: ShotPerformanceRecord[] }>(`/api/storyboards/${storyboardId}/performances`)
      .then((payload) => {
        if (cancelled) return
        setPerformances(payload.performances)
        setSelectedAssetId((current) => current || payload.performances[0]?.assetId || characters[0]?.id || '')
      })
      .catch((error) => {
        if (!cancelled) onNotice(error instanceof Error ? error.message : '读取分镜表演设计失败', 'error')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [characters, onNotice, storyboardId])

  const selectedCharacter = characters.find((character) => character.id === selectedAssetId) || null
  const selectedIndex = performances.findIndex((performance) => performance.assetId === selectedAssetId)
  const selected = selectedIndex >= 0 ? performances[selectedIndex] : null

  function updateSelected(patch: Partial<ShotPerformanceRecord>) {
    if (selectedIndex < 0) return
    setPerformances((current) => current.map((performance, index) => (
      index === selectedIndex ? { ...performance, ...patch } : performance
    )))
  }

  function updateBeat(index: number, patch: Partial<PerformanceBeatRecord>) {
    if (!selected) return
    updateSelected({ beats: selected.beats.map((beat, beatIndex) => beatIndex === index ? { ...beat, ...patch } : beat) })
  }

  function addCharacterPerformance() {
    if (!selectedCharacter || selected) return
    setPerformances((current) => [...current, emptyPerformance(selectedCharacter)])
  }

  function removeSelected() {
    setPerformances((current) => current.filter((performance) => performance.assetId !== selectedAssetId))
  }

  async function savePerformances() {
    setSaving(true)
    try {
      const payload = await jsonRequest<{ performances: ShotPerformanceRecord[] }>(
        `/api/storyboards/${storyboardId}/performances`,
        {
          method: 'PUT',
          body: JSON.stringify({
            performances: performances.map(({ assetName: _assetName, qualityScore: _qualityScore, qualityReport: _qualityReport, ...performance }) => ({
              ...performance,
              beats: performance.beats.map(({ id: _id, ...beat }) => beat),
            })),
          }),
        },
      )
      setPerformances(payload.performances)
      onNotice('分镜表演设计已保存并接入视频提示词')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '保存分镜表演设计失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (characters.length === 0) return null

  return (
    <details className="actingDirectorPanel shotActingPanel" open={panelOpen} onToggle={(event) => setPanelOpen(event.currentTarget.open)}>
      <summary>
        <span><Activity size={16} /><strong>表演导演</strong><small>{performances.length}/{characters.length} 名镜内角色已设计</small></span>
        <ChevronDown className="actingPanelChevron" size={16} />
      </summary>
      {loading ? (
        <div className="actingPanelLoading"><Loader2 className="spin" size={16} />正在读取分镜表演…</div>
      ) : (
        <div className="actingPanelBody">
          <div className="performanceCharacterTabs" role="tablist" aria-label="镜内角色">
            {characters.map((character) => {
              const record = performances.find((performance) => performance.assetId === character.id)
              return (
                <button className={selectedAssetId === character.id ? 'active' : ''} type="button" key={character.id} onClick={() => setSelectedAssetId(character.id)}>
                  <span>{character.name}</span>
                  <small>{record ? record.qualityScore == null ? '待检查' : `${record.qualityScore}/5` : '未设计'}</small>
                </button>
              )
            })}
          </div>
          {!selected ? (
            <div className="actingEmptyState">
              <strong>为{selectedCharacter?.name}建立本镜表演任务</strong>
              <small>角色永久档案保持不变；这里只记录当下目标、阻碍、策略和可见行为。</small>
              <button className="primaryButton compact" type="button" onClick={addCharacterPerformance}><Plus size={15} />添加表演任务</button>
            </div>
          ) : (
            <>
              <div className="actingThreeColumns">
                <label>当下目标<textarea rows={2} value={selected.objective} onChange={(event) => updateSelected({ objective: event.target.value })} placeholder="用指向具体对象的行动动词描述" /></label>
                <label>阻碍<textarea rows={2} value={selected.obstacle} onChange={(event) => updateSelected({ obstacle: event.target.value })} /></label>
                <label>失败代价<textarea rows={2} value={selected.stakes} onChange={(event) => updateSelected({ stakes: event.target.value })} /></label>
              </div>
              <div className="actingTwoColumns">
                <label>身体任务 Business<textarea rows={2} value={selected.business || ''} onChange={(event) => updateSelected({ business: event.target.value })} placeholder="谈话同时正在做什么" /></label>
                <label>潜台词<textarea rows={2} value={selected.subtext || ''} onChange={(event) => updateSelected({ subtext: event.target.value })} placeholder="记录但不要直接表演" /></label>
                <label>地位变化<input value={selected.statusIn || ''} onChange={(event) => updateSelected({ statusIn: event.target.value })} placeholder="进入镜头时" /></label>
                <label><span className="visuallyHidden">地位结束</span><input value={selected.statusOut || ''} onChange={(event) => updateSelected({ statusOut: event.target.value })} placeholder="离开镜头时" /></label>
                <label>人物距离<input value={selected.proximityIn || ''} onChange={(event) => updateSelected({ proximityIn: event.target.value })} placeholder="开始距离" /></label>
                <label><span className="visuallyHidden">结束距离</span><input value={selected.proximityOut || ''} onChange={(event) => updateSelected({ proximityOut: event.target.value })} placeholder="结束距离" /></label>
              </div>
              <label>本镜表演适配<textarea rows={3} value={selected.sceneAdaptation || ''} onChange={(event) => updateSelected({ sceneAdaptation: event.target.value })} placeholder="把永久行为习惯改写为当前姿态、空间和压力下的可见行为；不要写服装、摄影机或灯光。" /></label>
              <label className="actingCheckbox"><input type="checkbox" checked={selected.speaks} onChange={(event) => updateSelected({ speaks: event.target.checked })} />本镜有台词，使用锁定的 VoiceProfile</label>

              <div className="performanceBeatHeading">
                <span><strong>PerformanceBeat</strong><small>建议每条 3–5 秒视频只承担 1–2 个节拍</small></span>
                <button className="quietButton compact" type="button" disabled={selected.beats.length >= 4} onClick={() => updateSelected({ beats: [...selected.beats, emptyBeat(selected.beats.length + 1)] })}><Plus size={14} />添加节拍</button>
              </div>
              <div className="performanceBeatList">
                {selected.beats.map((beat, index) => (
                  <section className="performanceBeat" key={beat.id || beat.order}>
                    <div className="performanceBeatIndex">
                      <strong>{String(index + 1).padStart(2, '0')}</strong>
                      <button className="iconButton small danger" type="button" title="删除节拍" disabled={selected.beats.length === 1} onClick={() => updateSelected({ beats: selected.beats.filter((_, beatIndex) => beatIndex !== index).map((item, order) => ({ ...item, order: order + 1 })) })}><Trash2 size={14} /></button>
                    </div>
                    <div className="performanceBeatFields">
                      <div className="actingThreeColumns beatTiming">
                        <label>开始秒<input type="number" min={0} max={duration} step="0.1" value={beat.startSeconds ?? ''} onChange={(event) => updateBeat(index, { startSeconds: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                        <label>结束秒<input type="number" min={0} max={duration} step="0.1" value={beat.endSeconds ?? ''} onChange={(event) => updateBeat(index, { endSeconds: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                        <label>策略动词<input value={beat.tactic} onChange={(event) => updateBeat(index, { tactic: event.target.value })} placeholder="试探 / 施压 / 讨好" /></label>
                      </div>
                      <label>触发事件<input value={beat.trigger || ''} onChange={(event) => updateBeat(index, { trigger: event.target.value })} placeholder="什么新信息或失败让策略发生变化" /></label>
                      <label>可见行为<textarea rows={2} value={beat.behavior} onChange={(event) => updateBeat(index, { behavior: event.target.value })} /></label>
                      <div className="actingTwoColumns">
                        <label>倾听与反应<textarea rows={2} value={beat.reaction || ''} onChange={(event) => updateBeat(index, { reaction: event.target.value })} /></label>
                        <label>视线生命<textarea rows={2} value={beat.gaze || ''} onChange={(event) => updateBeat(index, { gaze: event.target.value })} /></label>
                        <label>身体与姿态<input value={beat.posture || ''} onChange={(event) => updateBeat(index, { posture: event.target.value })} /></label>
                        <label>节奏与声音<input value={[beat.tempo, beat.voiceDelivery].filter(Boolean).join('；')} onChange={(event) => updateBeat(index, { tempo: event.target.value, voiceDelivery: null })} /></label>
                        <label>起始动作状态<input value={beat.entryState || ''} onChange={(event) => updateBeat(index, { entryState: event.target.value })} /></label>
                        <label>结束动作状态<input value={beat.exitState || ''} onChange={(event) => updateBeat(index, { exitState: event.target.value })} /></label>
                      </div>
                    </div>
                  </section>
                ))}
              </div>
              {selected.qualityReport?.issues?.length ? (
                <div className="actingQualityIssues">
                  <strong>上次检查：{selected.qualityScore}/5</strong>
                  {selected.qualityReport.issues.map((issue) => <small key={issue.code}>{issue.message}</small>)}
                </div>
              ) : null}
              <div className="actingPanelActions">
                <button className="quietButton danger" type="button" onClick={removeSelected}><Trash2 size={15} />移除本角色表演</button>
                <button className="primaryButton" type="button" disabled={saving} onClick={() => void savePerformances()}>{saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}保存并接入生成</button>
              </div>
            </>
          )}
        </div>
      )}
    </details>
  )
}

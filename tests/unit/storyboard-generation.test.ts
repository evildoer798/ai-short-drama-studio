import { AssetType, VisualStyle } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  allocateStoryboardShotTargets,
  assetEpisodeAppearanceCounts,
  compactStoryboardShots,
  enforceStoryboardLocationAssets,
  enforceSupplementalDialogue,
  extractAllStoryboardLocationInventories,
  extractStoryboardLocationInventories,
  filterCoreAssetCandidates,
  fitStoryboardDuration,
  materializeStoryboards,
  normalizeCompactShot,
  packStoryboardVideoClips,
  storyboardRequestedEpisodeIds,
  storyboardRouteFailureReason,
  storyboardTextRoutePlan,
  storyboardMotionRisk,
  stitchStoryboardContinuity,
  suppressNonessentialStoryboardVoiceovers,
  targetStoryboardShotCount,
} from '@/lib/worker/text-generation'

type StoryboardTestShot = {
  t: string
  n: string
  p: string
  h: string
  r: string
  e: string
  l: string
  c: string
  f: string
  s: string
  m: string
  v: string
  a: string
  q: string
  o: string
  g: string
  x: string
  z: string
  d: number
}

const shot = (action: string, overrides: Partial<StoryboardTestShot> = {}): StoryboardTestShot => ({
  t: '镜头',
  n: '夜晚｜客厅',
  p: '承接上一镜稳定尾帧',
  h: '苏文菁与陈蕊保持资产库形象和既定站位',
  r: '黑色窄表带手表只属于苏文菁并固定在左手腕，陈蕊不得佩戴手表',
  e: '米白色沙发和黑色矮几位置固定',
  l: '暖黄落地灯从画面左侧照明',
  c: '中景固定',
  f: '苏文菁位于前景左侧，陈蕊位于背景右侧',
  s: '先保持站位；随后完成动作；最后停在原位置',
  m: '苏文菁双脚稳定着地，右手沿可见路径移动；人物之间无身体接触并保持一米距离',
  v: '人物完成连续动作，视线与眉眼随对白自然变化',
  a: action,
  q: '使用人物固定声线，语气自然克制',
  o: '保留室内空调声，无背景音乐，无字幕',
  g: '苏文菁位于前景左侧，左手腕手表清晰，陈蕊位于背景右侧',
  x: '保持尾帧站位自然进入下一镜',
  z: '禁止手表转移，禁止角色交换位置',
  d: 8,
  ...overrides,
})

describe('duration-aware storyboard generation', () => {
  it('targets only the explicitly selected locked episodes', () => {
    expect(storyboardRequestedEpisodeIds({
      episodeIds: ['episode-2', 'episode-1', 'episode-2', '', 3],
    })).toEqual(['episode-2', 'episode-1'])
    expect(storyboardRequestedEpisodeIds({})).toBeUndefined()
  })

  it('bounds one segment to five short provider routes instead of all fallback keys', () => {
    const routes = storyboardTextRoutePlan({
      primaryKeyCount: 1,
      fallbackKeyCount: 1,
      tertiaryKeyCount: 10,
      preferredTertiaryIndex: 8,
    })

    expect(routes.map((route) => route.provider)).toEqual([
      'primary',
      'fallback',
      'primary',
      'tertiary',
      'tertiary',
    ])
    expect(routes.filter((route) => route.provider === 'tertiary').map((route) => route.tertiaryKeyIndex))
      .toEqual([8, 9])
    expect(routes.every((route) => route.maxAttempts === 1)).toBe(true)
    expect(routes.reduce((total, route) => total + route.timeoutMs, 0)).toBe(315_000)
  })

  it('retries only DeepSeek when fallback providers are disabled', () => {
    const routes = storyboardTextRoutePlan({
      primaryKeyCount: 1,
      fallbackKeyCount: 0,
      tertiaryKeyCount: 0,
    })

    expect(routes.map((route) => route.provider)).toEqual(['primary', 'primary'])
    expect(routes.map((route) => route.timeoutMs)).toEqual([60_000, 60_000])
  })

  it('shows the real reason for switching text routes', () => {
    expect(storyboardRouteFailureReason(new Error('TEXT_API_FAILED: 504 upstream timeout')))
      .toBe('上一线路读取超时')
    expect(storyboardRouteFailureReason(new Error('Zod invalid_type in shots')))
      .toBe('上一结果格式未通过校验')
  })

  it('uses dialogue turns as the minimum shot target', () => {
    expect(targetStoryboardShotCount('苏文菁：下周见。\n陈蕊：哦。')).toBe(2)
  })

  it('allocates at least twenty atomic shots across a short-drama episode', () => {
    const chunks = [
      '场次一。林晨推门进入客厅，抬眼看向窗边。',
      '场次二。林晨停下脚步。苏文菁：坐吧。林晨：好。',
      '场次三。两人隔着茶几坐下，气氛逐渐缓和。',
    ]
    const target = targetStoryboardShotCount(chunks.join('\n'), 20)
    const allocated = allocateStoryboardShotTargets(chunks, target)

    expect(target).toBeGreaterThanOrEqual(20)
    expect(allocated).toHaveLength(3)
    expect(allocated.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(20)
    expect(fitStoryboardDuration(Array.from({ length: target }, () => shot('无对白')), 90)
      .reduce((total, item) => total + item.d, 0)).toBeGreaterThanOrEqual(90)
  })

  it('merges adjacent shots only when speakers do not conflict', () => {
    const compacted = compactStoryboardShots([
      shot('苏文菁抬眼，无对白'),
      shot('苏文菁：下周见。'),
      shot('苏文菁放下平板，无对白'),
      shot('陈蕊：哦。'),
    ], 2)
    expect(compacted).toHaveLength(2)
    expect(compacted[0].a).toContain('下周见')
    expect(compacted[1].a).toContain('陈蕊')
  })

  it('fits normal episodes to 90 seconds and respects the four-second minimum', () => {
    const normal = fitStoryboardDuration(Array.from({ length: 20 }, () => shot('无对白')), 90)
    const dialogueHeavy = fitStoryboardDuration(Array.from({ length: 27 }, () => shot('无对白')), 90)
    expect(normal.reduce((total, item) => total + item.d, 0)).toBe(90)
    expect(dialogueHeavy.reduce((total, item) => total + item.d, 0)).toBe(108)
    expect(dialogueHeavy.every((item) => item.d >= 4)).toBe(true)
  })

  it('restores exact source dialogue while preserving API-generated action', () => {
    const repaired = enforceSupplementalDialogue(
      shot('小张攥紧担架边缘；小张：我付不起，把我留在这里。'),
      { speaker: '小张', os: false, text: '我付不起！把我扔这儿！让我死这儿！' },
    )
    expect(repaired.a).toBe('小张攥紧担架边缘；小张：我付不起！把我扔这儿！让我死这儿！')
    expect(repaired.v).toBe('人物完成连续动作，视线与眉眼随对白自然变化')
  })

  it('clips overlong model fields instead of rejecting the entire storyboard segment', () => {
    const normalized = normalizeCompactShot(shot('角色：保留对白', {
      e: '场'.repeat(3_200),
      z: '禁'.repeat(3_600),
    }))

    expect(normalized.e).toHaveLength(2_800)
    expect(normalized.z).toHaveLength(3_200)
    expect(normalized.a).toBe('角色：保留对白')
  })

  it('removes emotional, descriptive, and invented voiceovers after generation', () => {
    const [reduced] = suppressNonessentialStoryboardVoiceovers([
      shot('林晨垂眼看向湿透的袖口；林晨【OS】：我真的太难过了；旁白：雨夜显得格外压抑'),
    ], [
      '林晨【OS】：我真的太难过了',
      '旁白：雨夜显得格外压抑',
    ].join('\n'))

    expect(reduced.a).toBe('林晨垂眼看向湿透的袖口')
    expect(reduced.q).toContain('不生成配音、旁白、画外音或内心独白')
  })

  it('keeps only an exact source voiceover carrying non-visual objective facts', () => {
    const [reduced] = suppressNonessentialStoryboardVoiceovers([
      shot('林晨握紧车把；林晨【OS】：两个月前，另一个外卖员在这里被抢车；旁白：三年前这里发生过另一件事'),
    ], '林晨【OS】：两个月前，另一个外卖员在这里被抢车')

    expect(reduced.a).toContain('林晨【OS】：两个月前，另一个外卖员在这里被抢车')
    expect(reduced.a).not.toContain('三年前这里发生过另一件事')
    expect(reduced.q).toContain('只保留剧本中无法视觉化的最短关键信息')
  })

  it('packs neighboring atomic shots into 15-second clips capped at two minutes', () => {
    const atomic = Array.from({ length: 17 }, (_, index) => shot(`角色：第${index + 1}句对白`))
    const clips = packStoryboardVideoClips(atomic)
    expect(clips).toHaveLength(8)
    expect(clips.every((item) => item.d === 15)).toBe(true)
    expect(clips.reduce((total, item) => total + item.d, 0)).toBe(120)
    const combined = clips.map((item) => item.a).join('\n')
    let previousIndex = -1
    for (let index = 1; index <= 17; index++) {
      const currentIndex = combined.indexOf(`第${index}句对白`)
      expect(currentIndex).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
    expect(clips[0].c).toContain('子镜头1')
    expect(clips[0].c).toContain('秒')
  })

  it('packs each episode independently without leaking adjacent episode content', () => {
    const episodeOne = packStoryboardVideoClips(Array.from({ length: 4 }, () => shot('第一集角色：第一集对白')))
    const episodeTwo = packStoryboardVideoClips(Array.from({ length: 4 }, () => shot('第二集角色：第二集对白')))
    expect(episodeOne).toHaveLength(2)
    expect(episodeTwo).toHaveLength(2)
    expect(episodeOne.every((item) => item.a.includes('第一集对白') && !item.a.includes('第二集对白'))).toBe(true)
    expect(episodeTwo.every((item) => item.a.includes('第二集对白') && !item.a.includes('第一集对白'))).toBe(true)
  })

  it('never combines shots from different scene assets into one video task', () => {
    const atomic = [
      shot('苏文菁：坐吧。', { n: '夜晚｜翡翠山庄别墅客厅' }),
      shot('陈蕊：哦。', { n: '深夜｜耶鲁学生宿舍卧室' }),
    ]
    const compacted = compactStoryboardShots(atomic, 1)
    const clips = packStoryboardVideoClips(atomic)

    expect(compacted).toHaveLength(2)
    expect(clips).toHaveLength(2)
    expect(clips[0].n).toContain('翡翠山庄别墅客厅')
    expect(clips[0].n).not.toContain('耶鲁学生宿舍卧室')
    expect(clips[1].n).toContain('耶鲁学生宿舍卧室')
  })

  it('keeps more than eight independent scenes by shortening clips within two minutes', () => {
    const atomic = Array.from({ length: 10 }, (_, index) => shot(
      `角色：场景${index + 1}对白`,
      { n: `白天｜独立场景${index + 1}` },
    ))
    const clips = packStoryboardVideoClips(atomic)

    expect(clips).toHaveLength(10)
    expect(clips.every((item) => item.d === 12)).toBe(true)
    expect(clips.reduce((total, item) => total + item.d, 0)).toBe(120)
    for (let index = 0; index < clips.length; index++) {
      expect(clips[index].n).toContain(`独立场景${index + 1}`)
      expect(clips[index].a).toContain(`场景${index + 1}对白`)
    }
  })

  it('forces every next shot to inherit the exact previous tail frame', () => {
    const shots = stitchStoryboardContinuity([
      shot('苏文菁：先坐下。', {
        f: '苏文菁站在画面左侧，左手腕佩戴手表',
        g: '苏文菁站在画面中央偏左，左手腕手表清晰，右手扶住沙发靠背',
      }),
      shot('陈蕊：哦。', {
        p: '错误的重置状态',
        f: '陈蕊仍坐在画面右侧，苏文菁保持上一镜位置',
        r: '手表只属于苏文菁并固定在左手腕，陈蕊双手腕为空',
      }),
    ])

    expect(shots[1].p).toBe(shots[0].g)
    expect(shots[1].p).toContain('右手扶住沙发靠背')
    expect(shots[1].r).toContain('手表只属于苏文菁')
    expect(shots[1].r).toContain('陈蕊双手腕为空')
  })

  it('canonicalizes every shot to the matched scene asset and injects its visual anchor', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('苏文菁：坐吧。', {
        n: '夜晚｜普通客厅',
        e: '沙发位于画面左侧',
      }),
    ], [{
      name: '翡翠山庄别墅客厅',
      description: '米白色长沙发位于左侧，黑色矮几固定在沙发前方，暖黄落地灯从左后方照明',
      tags: ['别墅客厅'],
    }])

    expect(anchored.n).toBe('夜晚｜翡翠山庄别墅客厅')
    expect(anchored.e).toContain('场景资产唯一锚点“翡翠山庄别墅客厅”')
    expect(anchored.e).toContain('黑色矮几固定在沙发前方')
    expect(anchored.z).toContain('禁止将场景“翡翠山庄别墅客厅”替换为其他地点')
  })

  it('selects the exact scene asset when an episode contains multiple locations', () => {
    const [anchored] = enforceStoryboardLocationAssets([
      shot('陈蕊：哦。', { n: '深夜｜耶鲁学生宿舍卧室' }),
    ], [
      { name: '翡翠山庄别墅客厅', description: '暖黄落地灯与米白沙发' },
      { name: '耶鲁学生宿舍卧室', description: '凌乱单人床、书桌与冷白窗光' },
    ])

    expect(anchored.n).toBe('深夜｜耶鲁学生宿舍卧室')
    expect(anchored.e).toContain('凌乱单人床、书桌与冷白窗光')
    expect(anchored.e).not.toContain('暖黄落地灯与米白沙发')
  })

  it('inherits the previous locked scene when a supplemental shot omits its location name', () => {
    const anchored = enforceStoryboardLocationAssets([
      shot('角色：打开文档。', { n: '白天｜公司档案室' }),
      shot('角色：保存成功。', {
        t: '补录镜头：文档保存提示',
        n: '时间承接上一镜',
        e: '屏幕右下角出现保存完成提示',
        f: '手指停在键盘上方',
        v: '角色轻轻呼气并看向屏幕',
        g: '手指离开键盘，屏幕保持亮起',
      }),
    ], [
      { name: '公司档案室', description: '灰色文件柜沿墙排列，办公桌位于窗边' },
      { name: '地下停车场', description: '混凝土立柱与冷白顶灯形成纵深' },
    ])

    expect(anchored[1].n).toContain('公司档案室')
    expect(anchored[1].e).toContain('灰色文件柜沿墙排列')
    expect(anchored[1].e).not.toContain('混凝土立柱')
  })

  it('turns storyboard standard locations into exact asset-planning candidates', () => {
    const locations = extractStoryboardLocationInventories([
      {
        episodeId: 'episode-1',
        notes: '凌晨｜翡翠山庄34号客厅\n接续上一镜尾帧：林晨站在玄关。',
        videoPrompt: '时间地点：凌晨｜翡翠山庄34号客厅\n\n环境锁定：挑空客厅、落地窗与假火壁炉位置固定。\n\n人物锁定：林晨站在玄关。',
      },
      {
        episodeId: 'episode-1',
        notes: '凌晨｜翡翠山庄34号客厅',
        videoPrompt: '时间地点：凌晨｜翡翠山庄34号客厅\n\n环境锁定：挑空客厅与暖黄灯光保持不变。',
      },
    ])

    expect(locations).toHaveLength(1)
    expect(locations[0].name).toBe('翡翠山庄34号客厅')
    expect(locations[0].description).toContain('挑空客厅')
    expect(locations[0].tags).toContain('分镜标准场景')
  })

  it('does not collapse storyboard scene names that only differ by punctuation', () => {
    const locations = extractStoryboardLocationInventories([
      {
        episodeId: 'episode-1',
        notes: '夜晚｜旧屋-客厅',
        videoPrompt: '时间地点：夜晚｜旧屋-客厅\n\n环境锁定：木门与旧沙发位置固定。',
      },
      {
        episodeId: 'episode-1',
        notes: '夜晚｜旧屋客厅',
        videoPrompt: '时间地点：夜晚｜旧屋客厅\n\n环境锁定：窗户与矮桌位置固定。',
      },
    ])

    expect(locations.map((location) => location.name)).toEqual(['旧屋-客厅', '旧屋客厅'])
  })

  it('keeps orphaned legacy storyboard scenes in the global asset plan', () => {
    const locations = extractAllStoryboardLocationInventories([{
      episodeId: null,
      notes: '夜晚｜未绑定分集的旧屋客厅',
      videoPrompt: '时间地点：夜晚｜未绑定分集的旧屋客厅\n\n环境锁定：木门和旧沙发位置固定。',
    }])

    expect(locations).toHaveLength(1)
    expect(locations[0].name).toBe('未绑定分集的旧屋客厅')
    expect(locations[0].description).toContain('木门和旧沙发')
  })

  it('keeps first frame, ordered actions, and final frame when packing a 15-second clip', () => {
    const clips = packStoryboardVideoClips([
      shot('苏文菁：先坐下。', { f: '第一子镜头首帧', s: '先抬眼；随后扶住沙发', g: '第一子镜头尾帧', d: 7 }),
      shot('陈蕊：哦。', { f: '第二子镜头首帧', s: '先看向屏幕；随后轻轻点头', g: '第二子镜头尾帧', d: 8 }),
    ])

    expect(clips).toHaveLength(1)
    expect(clips[0].f).toBe('第一子镜头首帧')
    expect(clips[0].g).toBe('第二子镜头尾帧')
    expect(clips[0].s.indexOf('先抬眼')).toBeLessThan(clips[0].s.indexOf('先看向屏幕'))
  })

  it('keeps physical contact and fast body motion in separate video jobs when capacity allows', () => {
    const clips = packStoryboardVideoClips([
      shot('无对白', { t: '简单反应一', s: '先抬眼；最后稳定停住' }),
      shot('无对白', { t: '简单反应二', s: '先眨眼；最后稳定停住' }),
      shot('无对白', {
        t: '搀扶动作',
        s: '先靠近；随后用右手搀扶对方左臂；最后两人站稳',
        m: '右手沿可见路径接近对方左臂，唯一接触点为前臂，双脚不滑移',
      }),
      shot('无对白', {
        t: '跌倒动作',
        s: '先失去平衡；随后向右侧跌倒；最后膝盖与右手依次缓冲落地',
        m: '重心先向右移动，右膝和右手依次接触地面，身体不得穿过地面',
      }),
    ])

    expect(clips).toHaveLength(3)
    const risky = clips.filter((item) => storyboardMotionRisk(item) >= 4)
    expect(risky).toHaveLength(2)
    expect(risky.every((item) => !item.s.includes('子镜头'))).toBe(true)
  })

  it('materializes every storyboard in the complete locked-continuity format', () => {
    const items = materializeStoryboards({
      shots: stitchStoryboardContinuity([
        shot('苏文菁：先坐下。', { g: '第一镜精确尾帧' }),
        shot('陈蕊：哦。', { p: '会被覆盖', f: '第二镜精确首帧' }),
      ]),
      visualStyle: VisualStyle.photorealistic,
    })
    const requiredSections = [
      '镜头时长：',
      '画幅比例：',
      '时间地点：',
      '接续上一镜尾帧：',
      '人物锁定：',
      '道具锁定：',
      '场景连续性：',
      '景别运镜：',
      '首帧：',
      '对白声音：',
      '尾帧衔接：',
      '禁止项：',
      '主要动作与画面：',
      '动作对白：',
      '动作顺序：',
      '动作物理：',
      '画面描述：',
    ]

    expect(items[0].videoPrompt).toContain('【分镜 1｜8秒｜16:9】')
    for (const section of requiredSections) expect(items[0].videoPrompt).toContain(section)
    expect(items[1].videoPrompt).toContain('接续上一镜尾帧：第一镜精确尾帧')
    expect(items[0].videoPrompt).toContain('下一镜必须逐项承接本镜尾帧')
    expect(items[0].videoPrompt).toContain('负面缺陷词：肢体融合')
    expect(items[0].videoPrompt).toContain('脚底滑移')
    expect(items[0].videoPrompt.indexOf('禁止项：')).toBeLessThan(items[0].videoPrompt.indexOf('动作对白：'))
    expect(items[0].videoPrompt.indexOf('动作对白：')).toBeLessThan(items[0].videoPrompt.indexOf('动作顺序：'))
    expect(items[0].videoPrompt.indexOf('动作顺序：')).toBeLessThan(items[0].videoPrompt.indexOf('动作物理：'))
    expect(items[0].videoPrompt.indexOf('动作物理：')).toBeLessThan(items[0].videoPrompt.lastIndexOf('画面描述：'))
  })

  it('prevents reality and flashback characters from coexisting after a transition', () => {
    const [item] = materializeStoryboards({
      shots: [shot('画外音：【OS】她曾住在山上。', {
        n: '回忆，凌晨｜山间小路',
        h: '回忆中的权知岁独自沿山路下行',
        e: '现实起居室已经完全消失，画面只保留冷蓝色山林',
      })],
      visualStyle: VisualStyle.photorealistic,
    })

    expect(item.videoPrompt).toContain('禁止现实人物、现实陈设与回忆或梦境中的人物、环境同时存在')
    expect(item.videoPrompt).toContain('禁止人物复制')
  })
})

describe('asset planning priority', () => {
  const inventories = [
    {
      episodeId: 'episode-1',
      type: AssetType.prop,
      assets: [
        { type: AssetType.prop, name: '普通咖啡杯' },
        { type: AssetType.prop, name: '关键推荐信' },
      ],
    },
    {
      episodeId: 'episode-2',
      type: AssetType.prop,
      assets: [{ type: AssetType.prop, name: '关键推荐信' }],
    },
  ]

  it('counts distinct episode appearances instead of raw mentions', () => {
    const counts = assetEpisodeAppearanceCounts(inventories)
    expect(counts.get('prop:关键推荐信')).toBe(2)
    expect(counts.get('prop:普通咖啡杯')).toBe(1)
  })

  it('keeps every character and location but removes one-episode props', () => {
    const candidates = [
      { type: AssetType.character, name: '林晨' },
      { type: AssetType.location, name: '翡翠山庄别墅客厅' },
      { type: AssetType.prop, name: '普通咖啡杯' },
      { type: AssetType.prop, name: '关键推荐信' },
    ]
    expect(filterCoreAssetCandidates(candidates, inventories).map((asset) => asset.name)).toEqual([
      '林晨',
      '翡翠山庄别墅客厅',
      '关键推荐信',
    ])
  })
})

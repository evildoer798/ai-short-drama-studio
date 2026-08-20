import { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/db'
import {
  storyboardContinuityStateIssues,
  type ContinuityCharacterState,
  type ContinuityTransitionType,
  type StoryboardContinuityState,
} from '../src/lib/storyboard-continuity'

const projectId = 'cms4pybld000eny3wb1kwwqso'
const scene = '庄园走廊'
const cameraAxis = '走廊南侧180度轴线，摄影机始终位于人物同一侧，出口固定在画面右侧'
const contact = '克莱尔·摩根|达米安·克劳'

function character(
  name: string,
  patch: Partial<ContinuityCharacterState> = {},
): ContinuityCharacterState {
  return {
    name,
    screenPosition: 'unknown',
    facing: '',
    gazeTarget: '',
    leftHand: '',
    rightHand: '',
    contacts: [],
    heldProps: [],
    movementDirection: 'stationary',
    ...patch,
  }
}

function continuity(
  transitionType: ContinuityTransitionType,
  characters: ContinuityCharacterState[],
  patch: Partial<StoryboardContinuityState> = {},
): StoryboardContinuityState {
  return {
    version: 1,
    transitionType,
    scene,
    cameraAxis,
    cameraSide: 'south',
    characters,
    completedActions: [],
    plannedActions: [],
    summary: '',
    ...patch,
  }
}

const commonStyle = [
  '【风格基调】',
  '海外真人短剧，美式真人电影感，夜晚庄园内部的压抑家庭冲突。真实皮肤与服装质感，克制手持呼吸感，浅景深。不要字幕，不要画面文字，不要背景音乐。无旁白、无后期配音感；保留自然美式英语现场对白、脚步、衣料摩擦和走廊环境声。人物外观、声线、服装和医药箱跨镜一致。',
].join('\n')

const items = [
  {
    id: 'cms5zapkt0007m30urk5vytou',
    title: '走廊寻女与议会决定',
    prompt: [
      commonStyle,
      '【人物及初始站位】',
      '克莱尔·摩根：40岁女医生，低调礼服；右手提医药箱，独自从画面左侧进入，沿走廊向画面右侧快步寻找女儿。',
      '达米安·克劳：43岁，深色西装；开始时不入镜，随后与西耶娜从画面右侧的侧厅门出现。',
      '西耶娜：年轻明艳，挽着达米安·克劳；始终只有一名西耶娜。守卫留在远处出口，不参与本段对话。',
      '空间轴线：摄影机固定在走廊南侧，同段不越轴；广场入口在画面左侧，庄园出口在画面右侧。结尾站位固定为克莱尔·摩根在画面左侧、达米安·克劳在中央、西耶娜在画面右侧。',
      '【场景】',
      '夜晚庄园走廊，深色木墙、地毯、古典壁灯和侧厅门；暖色壁灯照亮人物侧脸，出口方向保持在画面右侧。',
      '【视频分镜】',
      '0~4s：后侧中景沿同一轴线跟拍。克莱尔·摩根独自从左向右快步走，右手医药箱随步伐轻摆，左右查看但不转身。她用自然美式英语低声自语：“Where is Emma? She would never miss a celebration this important.”',
      '4~8s：克莱尔·摩根接近侧厅门时减速。达米安·克劳和西耶娜此时才从右侧门内出现；克莱尔·摩根停在画面左侧，左手仍空着，问：“Damian, where is Emma?”',
      '8~12s：三人中景，不换轴。达米安·克劳站中央，西耶娜在他右侧；达米安·克劳冷淡回答：“You have not heard? The Council just decided.”',
      '12~15s：克莱尔·摩根清晰侧脸近景，身体仍在原位，右手仍提医药箱，左手未接触任何人。她皱眉追问：“Decided what?” 尾帧保持三人站位，等待达米安·克劳回答。',
    ].join('\n'),
    continuityIn: continuity('scene_change', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向画面右侧', rightHand: '右手提医药箱',
        heldProps: ['医药箱'], movementDirection: 'screen_right',
      }),
    ], { summary: '切入庄园走廊，克莱尔·摩根独自从左向右进入。' }),
    continuityOut: continuity('scene_change', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手空着', rightHand: '右手提医药箱', heldProps: ['医药箱'],
      }),
      character('达米安·克劳', {
        screenPosition: 'center', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        rightHand: '右臂自然下垂',
      }),
      character('西耶娜', {
        screenPosition: 'right', facing: '侧身面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
      }),
    ], { summary: '三人在侧厅门外停住，克莱尔左手尚未接触达米安。' }),
  },
  {
    id: 'cms5zapkz0009m30u0vdiqoou',
    title: '血月祭品与母亲恳求',
    prompt: [
      commonStyle,
      '【人物及初始站位】',
      '克莱尔·摩根：画面左侧，面对达米安·克劳；右手提医药箱，左手空着。',
      '达米安·克劳：画面中央，面对克莱尔·摩根；右臂自然下垂。',
      '西耶娜：画面右侧，挽着达米安·克劳，冷眼旁观。三人位置严格承接上一镜，不交换左右。',
      '动作归属：只有克莱尔·摩根可以用左手抓住达米安·克劳的右臂；右手全程提医药箱。达米安·克劳本段不得提前甩手。',
      '【场景】',
      '同一夜晚庄园走廊、同一南侧轴线和暖色壁灯；侧厅门、地毯和出口方位不变。',
      '【视频分镜】',
      '0~5s：从上一镜三人尾帧开始，双人中近景不越轴。达米安·克劳冷漠说：“The Council chose Emma as the sacrifice for the coming Blood Moon.” 克莱尔·摩根瞳孔骤缩，身体轻晃，但双脚仍在原位。',
      '5~10s：镜头保留完整手部动作。克莱尔·摩根右手继续提医药箱，只伸出左手，沿清晰路径抓住达米安·克劳的右臂；她抬眼说：“She is your daughter! She has not even shifted yet.”',
      '10~15s：克莱尔·摩根左手继续抓住同一条右臂，指节发白，右手医药箱不换手。她急促地说：“You have to stop them!” 达米安·克劳保持冷漠，不得在本段甩开。尾帧必须仍处于左手抓右臂的接触状态。',
    ].join('\n'),
    continuityIn: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手空着', rightHand: '右手提医药箱', heldProps: ['医药箱'],
      }),
      character('达米安·克劳', {
        screenPosition: 'center', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        rightHand: '右臂自然下垂',
      }),
      character('西耶娜', { screenPosition: 'right', facing: '侧身', gazeTarget: '克莱尔·摩根' }),
    ], { summary: '严格承接分镜4尾帧，三人未交换左右。' }),
    continuityOut: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手抓住达米安·克劳右臂', rightHand: '右手提医药箱',
        contacts: [contact], heldProps: ['医药箱'],
      }),
      character('达米安·克劳', {
        screenPosition: 'center', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        rightHand: '右臂被克莱尔·摩根左手抓住', contacts: [contact],
      }),
      character('西耶娜', { screenPosition: 'right', facing: '侧身', gazeTarget: '克莱尔·摩根' }),
    ], { summary: '克莱尔左手抓住达米安右臂，右手仍提医药箱。' }),
  },
  {
    id: 'cms5zapl5000bm30uqxgsx5wp',
    title: '嫌恶甩开与牺牲辩解',
    prompt: [
      commonStyle,
      '【人物及初始站位】',
      '克莱尔·摩根：画面左侧，左手仍抓住达米安·克劳右臂，右手提医药箱；双脚站稳。',
      '达米安·克劳：画面中央，右臂仍被抓住；神情嫌恶。西耶娜：画面右侧，不触碰克莱尔·摩根。',
      '动作锁：首帧必须仍在接触；达米安·克劳只甩开一次。甩开完成后双方保持无接触，禁止再次抓住或重复甩手。',
      '【场景】',
      '同一夜晚庄园走廊、同一南侧轴线；人物左右位置、侧厅门和暖色壁灯承接上一镜。',
      '【视频分镜】',
      '0~4s：从上一镜接触尾帧开始，双人中景完整显示手臂。达米安·克劳用右臂向外完成一次明确甩手；克莱尔·摩根左手被甩开，向后退一步恢复重心。右手始终提医药箱。',
      '4~9s：双方已经解除接触。达米安·克劳站回中央，冷冷说：“You are being selfish. She is unfit. She still cannot shift.” 克莱尔·摩根停在画面左侧，不再伸手。',
      '9~15s：不改变站位。达米安·克劳继续说：“Her sacrifice will secure a more stable future for Blackpine.” 克莱尔·摩根清晰侧脸由震惊转为压抑怒火。尾帧：她退后一步、左手空着垂在身侧、右手提医药箱；双方无接触。',
    ].join('\n'),
    continuityIn: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手抓住达米安·克劳右臂', rightHand: '右手提医药箱',
        contacts: [contact], heldProps: ['医药箱'],
      }),
      character('达米安·克劳', {
        screenPosition: 'center', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        rightHand: '右臂被克莱尔·摩根左手抓住', contacts: [contact],
      }),
      character('西耶娜', { screenPosition: 'right', facing: '侧身', gazeTarget: '克莱尔·摩根' }),
    ], {
      plannedActions: [`release:${contact}`],
      summary: '首帧仍保持克莱尔左手抓住达米安右臂。',
    }),
    continuityOut: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手空着垂在身侧', rightHand: '右手提医药箱', heldProps: ['医药箱'],
      }),
      character('达米安·克劳', {
        screenPosition: 'center', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        rightHand: '右臂已经收回',
      }),
      character('西耶娜', { screenPosition: 'right', facing: '侧身', gazeTarget: '克莱尔·摩根' }),
    ], {
      completedActions: [`release:${contact}`],
      summary: '甩开只发生一次；克莱尔退后一步，双方已经解除接触。',
    }),
  },
  {
    id: 'cms5zapla000dm30uiizyurw7',
    title: '压抑怒火与转身离开',
    prompt: [
      commonStyle,
      '【人物及初始站位】',
      '克莱尔·摩根：画面左侧，退后一步站稳；左手空着，右手提医药箱，面对达米安·克劳。',
      '达米安·克劳：画面中央。西耶娜：画面右侧挽着达米安·克劳。三人与上一镜均无接触。',
      '动作锁：克莱尔·摩根说完话前不得转身。达米安·克劳与西耶娜先从她身边向画面左侧离开；两人离开后，克莱尔·摩根只转身一次，再朝画面右侧出口走。',
      '【场景】',
      '同一夜晚庄园走廊、同一南侧轴线；广场方向固定在画面左侧，出口固定在画面右侧。',
      '【视频分镜】',
      '0~6s：克莱尔·摩根保持原站位和朝向，先不转身。中近景读取她压抑怒火的侧脸，她一字一顿说：“If I do not go to her, she could be taken tonight.”',
      '6~10s：达米安·克劳不回应，拥着西耶娜从克莱尔·摩根身边经过，继续向画面左侧的广场方向离开。西耶娜只回头看一次。克莱尔·摩根留在原地，双方不接触。',
      '10~15s：达米安·克劳和西耶娜离开画面后，克莱尔·摩根才攥紧左拳、深吸气，只转身一次面向画面右侧出口，随后向右并远离摄影机大步走。镜头从背后偏左跟随。尾帧保持她的后侧身影继续朝出口前进，不得正对镜头走回来。',
    ].join('\n'),
    continuityIn: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'left', facing: '面向达米安·克劳', gazeTarget: '达米安·克劳',
        leftHand: '左手空着垂在身侧', rightHand: '右手提医药箱', heldProps: ['医药箱'],
      }),
      character('达米安·克劳', { screenPosition: 'center', facing: '面向克莱尔·摩根' }),
      character('西耶娜', { screenPosition: 'right', facing: '侧身' }),
    ], {
      plannedActions: ['turn:克莱尔·摩根', 'leave:达米安·克劳', 'leave:西耶娜'],
      summary: '三人无接触；克莱尔说话前仍面对达米安。',
    }),
    continuityOut: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'right', facing: '背对镜头朝出口', gazeTarget: '守卫',
        leftHand: '左手攥拳', rightHand: '右手提医药箱', heldProps: ['医药箱'],
        movementDirection: 'screen_right',
      }),
      character('达米安·克劳', { screenPosition: 'unknown', facing: '已经离开画面' }),
      character('西耶娜', { screenPosition: 'unknown', facing: '已经离开画面' }),
    ], {
      completedActions: ['turn:克莱尔·摩根', 'leave:达米安·克劳', 'leave:西耶娜'],
      summary: '克莱尔只转身一次，后侧跟拍向画面右侧出口前进。',
    }),
  },
  {
    id: 'cms5zaplg000fm30uz3gp9x41',
    title: '同向走向出口与守卫挡路',
    prompt: [
      commonStyle,
      '【人物及初始站位】',
      '克莱尔·摩根：承接上一镜尾帧，位于画面右侧，背对或后侧面对摄影机，继续向画面右侧出口走；左手攥拳，右手提医药箱。',
      '守卫：唯一一名守卫，提前站在出口前方，面向走来的克莱尔·摩根。达米安·克劳和西耶娜已经离开，不得再次入镜。',
      '方向锁：摄影机仍在走廊南侧，从克莱尔·摩根背后或后侧跟拍；她只能沿上一镜同一方向接近守卫，禁止正对摄影机迎面走回来，禁止交换左右位置。',
      '【场景】',
      '同一夜晚庄园走廊，出口与守卫固定在画面右侧前方；暖色壁灯、木墙和地毯方位不变。',
      '【视频分镜】',
      '0~5s：从上一镜行走尾帧无缝开始，后侧中景轻微跟拍。克莱尔·摩根继续向右并远离摄影机走向出口；守卫在前方上前一步，抬手示意停下。克莱尔·摩根减速停在守卫面前，全程不回头。',
      '5~10s：同轴双人中景，守卫在前方，克莱尔·摩根保持后侧或清晰侧脸。守卫用自然美式英语说：“Dr. Morgan, the Elders issued an order. You may not leave the estate until the ceremony.”',
      '10~15s：克莱尔·摩根原地转为清晰侧脸看向守卫，不改变脚下位置，不向镜头走。她右手仍握医药箱提手，手指收紧；左手缓慢松开。尾帧保持两人对峙和出口方位，无对白。',
    ].join('\n'),
    continuityIn: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'right', facing: '背对镜头朝出口', gazeTarget: '守卫',
        leftHand: '左手攥拳', rightHand: '右手提医药箱', heldProps: ['医药箱'],
        movementDirection: 'screen_right',
      }),
      character('守卫', {
        screenPosition: 'right', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        movementDirection: 'stationary',
      }),
    ], {
      completedActions: ['turn:克莱尔·摩根'],
      summary: '承接分镜7后侧行走尾帧，继续同方向朝出口。',
    }),
    continuityOut: continuity('same_scene_continuous', [
      character('克莱尔·摩根', {
        screenPosition: 'right', facing: '清晰侧脸面向守卫', gazeTarget: '守卫',
        leftHand: '左手放松', rightHand: '右手握紧医药箱提手', heldProps: ['医药箱'],
        movementDirection: 'stationary',
      }),
      character('守卫', {
        screenPosition: 'right', facing: '面向克莱尔·摩根', gazeTarget: '克莱尔·摩根',
        movementDirection: 'stationary',
      }),
    ], { summary: '克莱尔停在守卫面前，右手仍持医药箱，双方原地对峙。' }),
  },
]

for (let index = 1; index < items.length; index++) {
  const issues = storyboardContinuityStateIssues(
    items[index - 1].continuityOut,
    items[index].continuityIn,
  )
  if (issues.length > 0) {
    throw new Error(`Storyboard ${index + 4} continuity invalid: ${issues.join('; ')}`)
  }
}

const existing = await prisma.storyboard.findMany({
  where: { id: { in: items.map((item) => item.id) }, projectId },
  select: { id: true },
})
if (existing.length !== items.length) {
  throw new Error(`Expected ${items.length} storyboards, found ${existing.length}`)
}

await prisma.$transaction(items.map((item) => prisma.storyboard.update({
  where: { id: item.id },
  data: {
    title: item.title,
    notes: scene,
    duration: 15,
    videoPrompt: item.prompt,
    continuityIn: item.continuityIn as unknown as Prisma.InputJsonObject,
    continuityOut: item.continuityOut as unknown as Prisma.InputJsonObject,
  },
})))

console.log(JSON.stringify({
  ok: true,
  projectId,
  updatedStoryboardIds: items.map((item) => item.id),
  paidTasksCreated: 0,
}, null, 2))

await prisma.$disconnect()

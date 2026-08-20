---
name: Imaideo Guided Director Studio
description: A guided filmmaking workspace for consistent characters and credible performances.
colors:
  studio-canvas: "oklch(0.965 0.007 205)"
  clean-panel: "oklch(0.995 0.003 205)"
  muted-panel: "oklch(0.944 0.011 205)"
  strong-panel: "oklch(0.905 0.018 205)"
  primary-ink: "oklch(0.225 0.025 220)"
  secondary-ink: "oklch(0.445 0.024 215)"
  quiet-line: "oklch(0.855 0.018 205)"
  strong-line: "oklch(0.73 0.035 205)"
  cinema-teal: "oklch(0.52 0.115 178)"
  cinema-teal-deep: "oklch(0.42 0.105 178)"
  cinema-teal-soft: "oklch(0.92 0.045 178)"
  coral-warning: "oklch(0.59 0.17 28)"
  coral-soft: "oklch(0.93 0.045 28)"
  amber-attention: "oklch(0.68 0.135 78)"
  indigo-reference: "oklch(0.5 0.14 270)"
  success: "oklch(0.48 0.12 150)"
  danger: "oklch(0.53 0.18 26)"
typography:
  headline:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0"
rounded:
  field: "6px"
  control: "7px"
  surface: "8px"
  detail: "10px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.cinema-teal-deep}"
    textColor: "{colors.clean-panel}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.cinema-teal}"
    textColor: "{colors.clean-panel}"
    rounded: "{rounded.control}"
    height: "40px"
  button-quiet:
    backgroundColor: "{colors.clean-panel}"
    textColor: "{colors.secondary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "40px"
  field-default:
    backgroundColor: "{colors.clean-panel}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "9px 10px"
    height: "40px"
  surface-card:
    backgroundColor: "{colors.clean-panel}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.surface}"
    padding: "16px"
---

# Design System: Imaideo Guided Director Studio

## Overview

**Creative North Star: “引导式导演工作台”**

这套系统像一张整理妥当的导演工作桌：剧本、角色、状态资产、关键帧和镜头版本都在眼前，但一次只要求创作者做当前最重要的决定。它保持电影制作工具的专业可信，同时把术语、模型能力和长提示词放进渐进展开的高级层，让非专业创作者始终知道自己在哪里、正在确认什么、下一步会发生什么。

整体采用冷灰摄影棚中性色和少量电影青绿。层级由明度、边界、留白和真实媒体内容建立；静态工作区不依赖装饰性阴影。界面明确拒绝密集参数后台、节点连线画布和聊天框主导的 AI 助手形态。

**Key Characteristics:**

- 当前阶段与下一步始终清晰。
- 真实角色、场景、关键帧和视频版本是页面主角。
- ACTING、LIRA、CINEDANCE 有稳定而可辨认的职责边界。
- 默认路径简单，高级控制完整但安静。
- 人工确认和人工审片拥有最终决定权。

## Colors

冷灰摄影棚中性色承担绝大多数面积，电影青绿只标记主操作、当前选择和已确认状态。珊瑚、琥珀和靛青仅用于错误、注意与参考关系，不能成为装饰色。

### Primary

- **电影青绿**（`{colors.cinema-teal}`）：当前阶段、主操作、选中态和关键进度。
- **深电影青绿**（`{colors.cinema-teal-deep}`）：主按钮静止态和高对比操作文字。
- **柔电影青绿**（`{colors.cinema-teal-soft}`）：已确认、选中或聚焦内容的低强度底色。

### Secondary

- **珊瑚警示**（`{colors.coral-warning}` / `{colors.coral-soft}`）：需要人工处理的问题和失败反馈。
- **琥珀注意**（`{colors.amber-attention}`）：尚未阻塞但需要留意的连续性或输入状态。
- **靛青参考**（`{colors.indigo-reference}`）：引用关系、参考素材和辅助信息，不与主操作竞争。

### Neutral

- **摄影棚画布**（`{colors.studio-canvas}`）：全局背景。
- **洁净面板**（`{colors.clean-panel}`）：主工作区、表单和媒体检查面。
- **静音面板**（`{colors.muted-panel}`）：侧栏、工具条、未选中阶段和二级区块。
- **强调面板**（`{colors.strong-panel}`）：分隔层级、占位和禁用背景。
- **主墨色**（`{colors.primary-ink}`）：标题、正文和高价值数据。
- **次墨色**（`{colors.secondary-ink}`）：说明、标签和非主导信息。
- **安静边界**（`{colors.quiet-line}` / `{colors.strong-line}`）：静态分层与交互反馈。

**The Ten Percent Teal Rule.** 电影青绿在单个屏幕中不超过约 10% 的可见面积；它的稀缺性负责指路。

**The State Before Decoration Rule.** 每一种彩色出现都必须表达操作、选择、状态或风险，否则禁止使用。

## Typography

**Display Font:** Segoe UI（回退到 Microsoft YaHei、system-ui、sans-serif）
**Body Font:** Segoe UI（回退到 Microsoft YaHei、system-ui、sans-serif）
**Label/Mono Font:** 沿用同一字体族；数字依靠 tabular numerals，而不是引入第二套字体。

**Character:** 单一人文无衬线字体保持中文界面自然、熟悉和可信。层级依靠字号、字重和空间，而不是装饰字体或夸张大小。

### Hierarchy

- **Headline**（750，24px，1.2）：页面标题和关键确认结果；同屏只出现一次。
- **Title**（750，16px，1.35）：阶段标题、资产名称和审片版本标题。
- **Body**（400，14px，1.5）：主要说明、结构化结果和表单内容；长文限制在 65–75ch。
- **Label**（650，12px，1.35）：字段、状态和辅助操作；保持正常字距，不使用遍布全页的全大写标签。

**The One Family Rule.** 工作区只使用一套界面字体；专业感来自一致和精确，不来自字体表演。

## Elevation

系统默认扁平，通过摄影棚画布、洁净面板、静音面板和边界强度建立层级。静态卡片、分区和输入框不得使用阴影。阴影只允许出现在真正脱离文档流的浮层，例如菜单、提示、Toast 和可拖动预览。

### Shadow Vocabulary

- **浮层低位**（`0 4px 8px oklch(0.24 0.025 220 / 0.16)`）：菜单和轻量浮层。
- **反馈浮层**（`0 4px 8px oklch(0.24 0.025 220 / 0.2)`）：Toast 和短暂状态反馈。

**The Flat Workbench Rule.** 静态工作区永远扁平；如果一个元素不浮动，就不能用阴影假装浮动。

## Components

### Buttons

- **Shape:** 精确小圆角（7px），标准高度 40px；紧凑版本 36px。
- **Primary:** 深电影青绿背景、洁净面板文字、700 字重；只用于“确认并继续”等阶段主动作。
- **Hover / Focus:** 悬停提升到电影青绿；键盘焦点使用清晰焦点环；按下仅下移 1px。
- **Secondary / Ghost:** 洁净面板背景与安静边界，默认使用次墨色，悬停才提升到主墨色。

### Chips

- **Style:** 只用于阶段状态、模型能力、引用类型和人工决定；背景来自中性色或柔电影青绿。
- **State:** 文字与图形共同表达状态，不允许只使用彩色圆点。圆形胶囊只保留给短状态，不用于普通按钮。

### Cards / Containers

- **Corner Style:** 主表面 8px，复杂详情 10px；禁止 24px 以上的大圆角。
- **Background:** 洁净面板承载主要内容，静音面板承载次级信息。
- **Shadow Strategy:** 静态表面无阴影；通过边界和明度分层。
- **Border:** 安静边界为默认，悬停或选中时提升到强边界或电影青绿。
- **Internal Padding:** 紧凑区块 12px，常规工作区 16px，首次引导最多 24px。

### Inputs / Fields

- **Style:** 6px 小圆角、安静边界、洁净面板背景，标准高度 40px；多行字段行高 1.58。
- **Focus:** 边界切换为电影青绿并保留 3px 可见焦点环。
- **Error / Disabled:** 错误同时显示珊瑚底色、图标和具体文本；禁用状态仍需保持文字可读。

### Navigation

- 顶部栏保留产品身份、项目上下文和全局操作；阶段导航使用清晰的顺序轨道，不采用节点连线画布。
- 当前阶段同时使用位置、文字、图标和电影青绿表达；已完成与未开始阶段必须可区分。
- 桌面端保留完整阶段导航；移动端收束为当前阶段、返回和确认操作，不复制整套制作面板。

### Stage Confirmation Bar

固定在当前工作区底部的阶段确认条是签名组件。左侧说明本阶段已经确认或仍缺什么，右侧只保留“修改”“重新生成”和唯一主动作“确认并继续”；高级参数不进入该条。

## Do's and Don'ts

### Do:

- **Do** 让当前阶段、AI 结果、修改入口和“确认并继续”成为默认首屏结构。
- **Do** 让真实角色图、场景图、关键帧和视频版本承担主要视觉重量。
- **Do** 对 ACTING、LIRA、CINEDANCE 使用一致的工作区骨架和各自明确的输出标签。
- **Do** 为加载、空状态、错误、已确认、需修改和版本过多提供完整状态。
- **Do** 保持正文至少 14px，并让状态同时拥有文字、图标或结构提示。

### Don't:

- **Don't** 做成密集参数堆叠的管理后台；高级参数必须渐进展开。
- **Don't** 做成依赖节点连线才能理解和操作的画布；流程必须线性可读。
- **Don't** 做成只有聊天框、缺少可视化制作状态的 AI 助手。
- **Don't** 用装饰性渐变文字、玻璃卡片、巨型圆角或无意义阴影营造“AI 工具感”。
- **Don't** 用重复的等尺寸卡片网格代替真实的信息层级，也不要把卡片嵌套进卡片。
- **Don't** 只靠颜色传达阶段、风险、选中或完成状态。

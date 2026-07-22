# AI Short Drama Studio

AI Short Drama Studio 是一个面向小型创作团队的私有化 AI 短剧生产工作台。它将小说或长文本逐步转换为可编辑的分集剧本、电影级分镜、角色与场景资产及分镜视频，并通过后台任务、检查点和多线路模型容灾降低长任务中断带来的损失。

本项目适合三类使用方式：

- 编剧与导演共同审阅小说改编结果，逐集确认内容后继续制作。
- 美术人员维护角色、场景和核心道具资产，统一项目视觉风格。
- 小团队在一台云服务器上协作生成、审阅和下载图片与视频。

> 安全说明：仓库不包含任何真实 API Key、对象存储密钥、服务器密码或生产环境配置。所有敏感配置只应写入已被 Git 忽略的 `.env` 和 `.env.production`。

## 核心工作流

项目采用逐级确认的生产流程，每一步都可以单独编辑、重试和继续：

1. **项目管理**
   - 从项目首页新建项目并自定义名称。
   - 在多个小说或剧本项目之间切换。
   - 每个项目独立保存原文、剧本、分镜、资产和视频。

2. **小说改编**
   - 粘贴小说内容或上传 TXT 文件。
   - 设置目标集数和单集时长。
   - 长文本先分块分析，再生成统一人物名册、世界观与分集规划。
   - 支持倒叙式开场、快速进入主线、集尾 Hook、跨集连续性检查和重复内容检查。
   - 每一集可独立编辑、添加导演评论、按评论修订并锁定。

3. **逐集分镜**
   - 已锁定的单集可立即生成分镜，不必等待全部剧本完成。
   - 分镜按集折叠展示，集与集之间互不混排。
   - 分镜包含时间地点、人物锁定、场景锁定、道具锁定、镜头运动、动作顺序、对白、配音、声音、首尾帧、镜间衔接和禁止项。
   - 自动核对原剧本对白，避免漏句或错误加入画外音。
   - 以约 3 至 4 个镜头组成一条最长 15 秒的视频提示词，同时保证每集整体时长接近目标时长。

4. **资产规划**
   - 每完成一集分镜，就能立即规划该集资产，不必等待全剧分镜完成。
   - 可选择单集规划，也可对全部已完成分镜进行累计核对。
   - 重点提取角色与标准场景，只保留跨集高频或剧情关键道具。
   - 场景名称与分镜逐字对齐，避免同一地点被拆成多个不一致资产。
   - 识别出的角色和场景在提示词中重点标记。

5. **资产图片**
   - 角色、场景和道具均可只填写提示词后直接生图。
   - 支持上传已有图片作为资产版本。
   - 支持查看多个版本并选择主图。
   - 支持单个删除、批量管理和一键生成全部待生成资产。
   - 项目级视觉风格会自动拼接到所有资产提示词中。

6. **分镜视频**
   - 按集选择一个或多个分镜组合生成视频。
   - 视频提示词可在提交前编辑。
   - 自动把识别出的角色和场景主图作为参考素材，并以 `@image1` 等引用方式写入多模态提示词。
   - 支持文生视频、单图生视频、多参考图和首尾帧模式，具体能力由所选模型决定。
   - 模型选择器展示模型名称、时长、分辨率和价格说明。
   - 视频异步提交、轮询、下载并保存到对象存储。

7. **视频库**
   - 按分集查看当前项目生成的全部视频版本。
   - 支持逐条预览、搜索和跳转回来源分镜。
   - 支持修改视频名称，并使用保存后的名称下载 MP4 文件。

## 一致性与质量控制

项目包含多层约束，减少常见的 AI 影视生成问题：

- **人物统一**：使用统一人物名册和规范化名称，防止同一角色在不同集被改名。
- **场景统一**：分镜和资产共享标准场景名与固定环境事实。
- **镜间连续**：后一镜明确继承上一镜尾帧中的人物站位、服装、光线和道具归属。
- **道具归属**：关键道具绑定到指定角色，禁止在镜头间转移或消失。
- **动作可执行**：复杂动作拆成明确顺序，限制不合理位移、穿模和突然切换。
- **神态变化**：提示模型根据剧情节奏调整眼神、呼吸、停顿和细微表情，避免全程单一表情。
- **对白完整**：逐句提取和复核剧本对白，缺失时生成补充镜头。
- **画外音抑制**：非必要内容不转换为画外音，优先通过可见动作和对白推进剧情。
- **剧本去重**：完成改编前检查相邻集及全剧重复片段。
- **视觉风格锁定**：角色、场景、道具和视频共享同一项目风格提示词。

## 视觉风格

内置项目级风格包括：

- 真人写实
- 2D 动漫
- 3D CG 动漫
- Q 版风格

还可以为项目填写自定义风格要求。风格规则会进入资产提示词、分镜图片提示词和视频提示词，而不是依赖使用者反复粘贴。

## 长任务与容灾

小说改编、资产规划和分镜拆解均由后台 Worker 执行：

- 长文本按块或按集处理，不把整本小说塞进一次请求。
- 每个已完成分片都会写入数据库检查点。
- 任务失败后可从未完成位置续跑，不重复覆盖已完成内容。
- 页面显示当前阶段、完成集数、完成分片、使用线路、模型和换线原因。
- 可通过 `TEXT_PRIMARY_ONLY` 强制所有文字任务只使用主线路，避免无效换线拉长等待时间。
- 单个分镜分片限制尝试次数和最长等待时间，避免依次等待大量失效 Key。
- 429、502、503、504、超时、格式校验失败和内容审核失败会显示不同原因。

当前推荐将 DeepSeek `deepseek-chat` 设为唯一文字线路，并启用 JSON 输出、关闭不必要的思考模式。分镜任务可在同一集内并行处理最多 3 个独立分段，完成后再统一执行镜间连续性拼接与对白校验。

服务地址和密钥只存在于本地或服务器环境变量中，不写入 README 或版本库。

## 系统架构

```text
Browser
   |
   v
Next.js Web/API
   |-----------------------> PostgreSQL
   |                          用户、项目、剧本、分镜、任务、媒体索引
   |
   |-----------------------> S3-compatible Object Storage
   |                          资产图片、分镜视频
   |
   v
Redis + BullMQ
   |
   v
Background Worker
   |---- Text providers
   |---- Image provider
   `---- Video provider
```

### 技术栈

| 模块 | 技术 |
| --- | --- |
| Web 与 API | Next.js 16、React 19、TypeScript |
| 数据库 | PostgreSQL、Prisma |
| 任务队列 | Redis、BullMQ |
| 对象存储 | S3 兼容接口，可使用 MinIO、OSS、R2 等 |
| 部署 | Docker Compose、反向代理 |
| 测试 | Vitest |

## 目录结构

```text
ai-short-drama-studio/
├─ prisma/                 数据模型与数据库配置
├─ public/                 静态资源
├─ scripts/                配置、探测、部署、迁移和验证脚本
├─ src/
│  ├─ app/                 页面与 API Routes
│  ├─ components/          工作台组件
│  ├─ lib/                 模型调用、提示词、队列、存储和业务逻辑
│  └─ scripts/             数据初始化脚本
├─ tests/unit/             单元测试
├─ docker-compose.yml      本地 Docker 环境
├─ docker-compose.production.yml
├─ Dockerfile
└─ .env.example            无真实凭据的配置模板
```

## 运行要求

- Windows、macOS 或 Linux
- Node.js 20 或更高版本
- npm
- Docker Desktop 或 Docker Engine + Compose
- 至少 2 核 CPU、2 GB 内存用于三人轻量测试
- 生产环境建议使用独立对象存储，避免图片和视频占满系统盘

2 核 2 GB 服务器可以运行三人内测，但应限制 Worker 并发。视频生成本身由外部模型服务完成，本机主要承担任务调度、文件传输和数据库读写。

## 本地启动

### 方式一：Docker Compose

1. 创建本地环境文件：

```powershell
Copy-Item .env.example .env
```

2. 编辑 `.env`，至少填写：

- 登录签名密钥
- 数据库与 Redis 配置
- 对象存储配置
- DeepSeek 文字线路
- 图片模型配置
- 视频模型配置
- 初始管理员账号

3. 构建并启动：

```powershell
docker compose up -d --build
```

4. 查看容器状态：

```powershell
docker compose ps
```

5. 在浏览器打开本机 `14000` 端口。

### 方式二：本地开发

先启动 PostgreSQL、Redis 和对象存储，再执行：

```powershell
npm install
npx prisma generate
npm run db:push
npm run seed
npm run dev
```

开发模式会同时启动 Web 服务与后台 Worker。

## 环境变量

### 应用与登录

| 变量 | 说明 |
| --- | --- |
| `AUTH_SECRET` | Cookie 与登录会话签名密钥 |
| `APP_URL` | 应用对外地址 |
| `SEED_ADMIN_EMAIL` | 初始化管理员账号 |
| `SEED_ADMIN_PASSWORD` | 初始化管理员密码，首次登录后应立即修改 |
| `SEED_WORKSPACE_NAME` | 初始工作区名称 |
| `SEED_PROJECT_NAME` | 初始项目名称 |

### 数据库与队列

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口 |
| `REDIS_PASSWORD` | Redis 密码，可为空 |

### 对象存储

| 变量 | 说明 |
| --- | --- |
| `S3_ENDPOINT` | S3 兼容服务地址 |
| `S3_REGION` | Bucket 所在区域 |
| `S3_BUCKET` | Bucket 名称 |
| `S3_ACCESS_KEY_ID` | RAM 或 S3 Access Key ID |
| `S3_SECRET_ACCESS_KEY` | Access Key Secret |
| `S3_FORCE_PATH_STYLE` | MinIO 通常为 `true`，云 OSS 通常为 `false` |

### 文字模型

三组文字配置分别使用 `TEXT_`、`TEXT_FALLBACK_` 和 `TEXT_TERTIARY_` 前缀：

| 后缀 | 说明 |
| --- | --- |
| `API_BASE_URL` | OpenAI-compatible 服务根地址 |
| `API_KEY` | 当前线路默认 Key |
| `API_KEY_1` 至 `API_KEY_10` | 可选密钥池 |
| `API_MODE` | `chat_completions`、`responses` 或 `auto` |
| `MODEL` | 模型 ID 或推理接入点 ID |
| `REASONING_EFFORT` | 可选推理强度；不支持时留空 |

当前部署使用 `TEXT_PRIMARY_ONLY=true`，因此只有 `TEXT_` 主线路会参与实际任务；另外两组仅作为可选兼容配置保留。

并发控制：

| 变量 | 说明 |
| --- | --- |
| `TEXT_PRIMARY_CONCURRENCY_PER_KEY` | 每个主线路 Key 的最大并发 |
| `TEXT_ANALYSIS_CONCURRENCY` | 原文分析并发 |
| `TEXT_EPISODE_CONCURRENCY` | 分集改编并发 |
| `TEXT_ASSET_CONCURRENCY` | 资产规划并发 |
| `TEXT_STORYBOARD_CONCURRENCY` | 分镜拆解并发 |
| `TEXT_STORYBOARD_SEGMENT_CONCURRENCY` | 单集内部同时生成的分段数，建议 2 至 3 |

### 图片与视频模型

图片配置使用 `OPENAI_COMPAT_` 和 `IMAGE_` 前缀；视频配置使用 `VIDEO_` 前缀。请根据供应商文档填写模型、时长、画幅、分辨率和异步模式。实际地址、Key 与价格均不应提交到 Git。

## 隐藏输入 API Key

项目提供 DeepSeek 交互式配置脚本。脚本使用隐藏输入，先发送一个最小测试请求，只有验证成功才更新 `.env` 和 `.env.production`。

```powershell
npm run configure:deepseek-api
```

该脚本会测试 DeepSeek Key 与模型是否可用，并把 DeepSeek 设置为主线路。设置 `TEXT_PRIMARY_ONLY=true` 后，运行时不会调用其他文字供应商；脚本和日志均不会输出完整密钥。

## 用户与权限

- 支持账号密码登录和退出。
- 支持首次登录后修改密码。
- 工作区和项目通过成员关系控制访问。
- 项目数据、资产和视频按项目隔离。
- 管理员可通过初始化脚本创建测试账号。

生产环境不要继续使用示例密码，也不要多人共用同一账号。

## 对象存储说明

对象存储不是数据库。它负责保存体积较大的二进制文件：

- 角色、场景和道具图片
- 用户上传的资产参考图
- AI 生成的分镜视频
- AI 生成并可独立下载的 MP4 分镜视频

PostgreSQL 只保存对象 Key、媒体类型、版本关系和业务关联。这样可以更换 MinIO、OSS 或其他 S3 兼容服务，而不必重写剧本和分镜数据。

迁移素材时应遵循：

1. 先复制对象，不删除旧文件。
2. 核对对象数量、大小和抽样下载。
3. 确认数据库中的对象 Key 在新 Bucket 中仍可解析。
4. 切换生产环境配置并重启 Web 与 Worker。
5. 稳定运行一段时间后再清理旧存储。

## 生产部署

1. 从模板创建 `.env.production`。
2. 填写生产数据库、Redis、对象存储、模型和管理员配置。
3. 确保服务器已安装 Docker，并开放 Web 所需端口。
4. 执行部署脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-aliyun.ps1 `
  -Server "<server-ip>" `
  -Domain "<your-domain>"
```

部署脚本会创建时间戳 Release、构建容器、执行数据库同步、健康检查并切换 `current` 软链接。生产环境文件不会进入部署压缩包的 Git 历史。

### 生产服务

- `web`：页面、登录与 API。
- `worker`：文字、图片、视频和合成任务。
- `postgres`：持久化业务数据。
- `redis`：任务队列与状态。
- `caddy` 或其他反向代理：HTTPS 与域名入口。

部署后至少检查：

```powershell
docker compose -f docker-compose.production.yml ps
docker logs --tail 100 imaideo-web-1
docker logs --tail 100 imaideo-worker-1
```

## 常用命令

```powershell
# 类型检查
npm run typecheck

# 完整单元测试
npm test

# 生产构建
npm run build

# 测试文字主线路
npm run test:text-api

# 测试 DeepSeek 文字线路
npm run test:text-api

# 创建或更新团队测试账号
npm run provision:users
```

## 主要 API 路由

### 项目与前期制作

- `GET/POST /api/projects`
- `GET/PATCH /api/projects/:projectId`
- `PUT /api/projects/:projectId/novel`
- `POST /api/projects/:projectId/adapt-script`
- `GET /api/projects/:projectId/preproduction`
- `POST /api/projects/:projectId/generate-storyboards`
- `POST /api/projects/:projectId/extract-assets`

### 剧本与评论

- `PATCH /api/script-episodes/:episodeId`
- `POST /api/script-episodes/:episodeId/comments`
- `POST /api/script-episodes/:episodeId/revise`
- `DELETE /api/script-comments/:commentId`

### 资产

- `GET/POST /api/assets`
- `PATCH/DELETE /api/assets/:assetId`
- `POST /api/assets/:assetId/generate-images`
- `POST /api/assets/:assetId/upload-image`
- `POST /api/assets/:assetId/select-image`
- `POST /api/projects/:projectId/generate-asset-images`

### 分镜与视频

- `GET/POST /api/storyboards`
- `PATCH/DELETE /api/storyboards/:storyboardId`
- `POST /api/storyboards/:storyboardId/generate-video`
- `POST /api/storyboards/generate-video-group`
- `POST /api/storyboards/:storyboardId/select-video`
- `PATCH /api/storyboard-videos/:videoId`
- `GET /api/video-models`

### 任务与媒体

- `GET /api/tasks/:taskId`
- `GET /api/media/:mediaId`

## 测试与发布检查

提交代码前建议依次执行：

```powershell
npm run typecheck
npm test
npm run build
```

发布前还应检查：

- `.env` 与 `.env.production` 没有进入 Git。
- README 和示例配置没有真实密钥或私人服务地址。
- 对象存储可以上传、读取和下载。
- DeepSeek 文字线路连通且结构化 JSON 测试通过。
- Worker 可以从失败检查点恢复任务。
- 手机上可以正常加载对象存储图片。
- 视频库中的视频可以从公网入口按保存名称下载。

## 常见问题

### 任务长时间没有进度

先查看页面显示的线路、尝试次数和换线原因，再检查 Worker 日志。任务检查点会保留，修复线路后重新提交即可从未完成位置继续。

### 图片在电脑上正常、手机上不显示

通常是对象存储 URL 只在内网可访问，或签名 URL、跨域和 HTTPS 配置不一致。生产环境应让浏览器通过应用媒体接口或公网可访问的对象存储地址读取图片。

### 视频生成完成但没有下载链接

检查供应商任务是否返回最终文件地址，再确认 Worker 已成功把文件下载到对象存储并创建 `MediaObject` 记录。

### 分镜出现角色或场景误识别

先核对标准角色名和标准场景名，再检查分镜提示词中的资产匹配。系统只应重点标记已识别的人物和场景，不应把职业、动作或泛化描述当成新角色。

### 服务器内存不足

降低 Worker 并发，限制容器内存，并把图片和视频放到外部对象存储。2 GB 内存环境应避免同时执行大量文件上传和下载。

## 安全清单

- 永远不要提交 `.env`、`.env.production` 或云厂商凭据。
- API Key 只在服务端 Worker 中使用，不发送给浏览器。
- 使用 RAM 子账号并仅授予指定 Bucket 的最小读写权限。
- 为数据库、Redis、管理员账号和服务器 SSH 使用不同密码。
- 生产环境必须启用 HTTPS。
- 定期轮换模型 Key 和对象存储 Key。
- GitHub 仓库建议保持私有，确认无敏感内容后再考虑公开。
- 日志中只记录线路名、模型名和状态，不记录完整密钥。

## 当前边界

- 不同视频供应商对多参考图、原生音频、首尾帧和最长时长的支持不同。
- 模型价格可能变化，应以供应商实时价格为准。
- AI 分镜可以降低穿帮概率，但不能保证每次生成完全没有形变、穿模或连续性错误。
- 2 核 2 GB 服务器适合小团队测试，不适合大量用户同时进行图片、视频和合成任务。

## 授权

当前仓库用于团队内部开发与测试。若计划对外公开或商业分发，请在发布前补充明确的开源或商业授权条款，并再次完成依赖许可证与敏感信息审计。

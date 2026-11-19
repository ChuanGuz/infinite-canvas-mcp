# AI MCP 无限画布 (Infinite Canvas MCP & Seamless AI Handoff System) — 架构设计说明书

## 1. 项目愿景与核心目标

本项目旨在构建一个**可接入任意支持 MCP (Model Context Protocol) 的 AI 助手（Claude、Codex、Cursor、Antigravity 等）的“无限画布知识沉淀与跨 AI 无缝交接系统”**。

在实际研发过程中，AI 与开发者会不断产生新的功能实现、架构决策、双方约定的工程做法（Conventions）以及踩坑经验。本项目通过 **MCP 协议 + 结构化阶段演进模型 + 可视化无限画布** 实现以下核心闭环：

1. **多画布与画布分组管理**：支持按业务域、产品线或知识库创建**画布分组（Canvas Groups）**，并在分组下新建或切换多个**无限画布（Canvases）**。
2. **边做边学、自动分类上墙**：当 AI 接入 MCP 后，在项目推进中学到的每一部分内容、完成的每个模块、约定的每条规范，都会自动分类（如：`功能实现`、`约定做法`、`架构设计`、`问题修复`、`决策待办`），并自动计算坐标放置到画布对应区域。
3. **按项目阶段（Stage）自动分区整理**：
   - 项目每推进一个阶段（Stage 1、Stage 2、Stage 3...），AI 自动触发（或按指令执行）**阶段性整理（Stage Consolidation）**。
   - 每个阶段在无限画布上拥有独立的**阶段泳道/大区（Stage Zone）**。
   - 每个阶段大区内部，按不同类别（如“功能实现”、“我们之间规定的做法/规范”、“核心技术点”）自动聚类到对应的**分类容器（Category Cluster）**中，形成清晰的阶段快照。
4. **项目收尾终局蒸馏（Final Distillation）**：
   - 到项目结尾或里程碑收官时，AI 执行**终局总整理（Final Project Distillation）**，将全周期所有阶段中**最终确定下来的优秀用法、黄金约定、核心可复用实现**提炼到画布的**“终局精华区（Final Best Practices Zone）”**，并同步沉淀到全局**跨项目经验库（Cross-Project Experience Pool）**。
5. **跨会话 / 跨 AI 无缝交接（Seamless Handoff）**：
   - 任何时候新开会话或更换另一个 AI，新 AI 只需调用一个 MCP 工具（`get_handoff_context`）或读取自动同步生成的交接文档（`HANDOFF.md` / MCP Resource），即可完整掌握项目当前阶段、历史阶段成果、双方规定的所有做法与最终最佳实践，直接无缝接手开发。
6. **跨项目经验吸取与复用（Cross-Project Experience Reuse）**：
   - 在开启新项目画布时，AI 可检索历史项目的“终局精华区 / 经验库”，将适用的工程约定、架构模式与优秀用法一键引入新画布。

---

## 2. 系统总体架构

系统采用 **TypeScript / Node.js 全栈单仓架构**（零外部数据库依赖，开箱即用，同时支持 MCP Stdio 与 Web 实时画布服务）：

```
E:\idm\无限画布
├── ARCHITECTURE.md              # 架构设计规范（本文档）
├── package.json                 # 项目依赖与脚本配置
├── tsconfig.json                # TypeScript 编译配置
├── data/                        # 本地持久化数据目录
│   ├── store.json               # 核心结构化数据库（画布分组、画布、阶段、分类容器、节点、连线、跨项目经验池）
│   └── handoffs/                # 自动实时生成的 Markdown 交接文档镜像（每个画布一份 HANDOFF-<slug>.md）
├── src/
│   ├── types/
│   │   └── schema.ts            # 核心领域模型与 Zod 校验 Schema
│   ├── core/
│   │   ├── storage.ts           # 原子化持久化存储引擎 + Markdown 交接文档自动同步器
│   │   ├── classifier.ts        # 智能自动分类器（基于语义特征/标签/规则将知识项自动归入对应类别）
│   │   ├── layout.ts            # 无限画布空间自动布局算法（阶段大区 -> 分类子容器 -> 节点卡片网格排布）
│   │   ├── engine.ts            # 核心业务引擎（分组、画布、阶段推进、阶段整理、终局蒸馏、跨项目经验迁移）
│   │   └── handoff.ts           # 跨 AI 无缝交接上下文生成器（结构化 JSON + 高可读性 HANDOFF.md）
│   ├── mcp/
│   │   ├── server.ts            # 标准 MCP Server（支持 stdio 接入 Claude/Codex/Cursor/Antigravity 等）
│   │   └── tools.ts             # MCP 工具集定义与处理器（12+ 核心 AI 协同工具 & Resources）
│   ├── server/
│   │   └── app.ts               # Express + SSE/WebSocket 实时可视化后端服务（默认端口 3456）
│   └── web/                     # 现代化无限画布前端工作台（原生模块化 ES + Canvas/SVG 混合无限视口）
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── tests/
    └── engine.test.ts           # 全链路自动化测试（覆盖分类、阶段整理、终局蒸馏、跨AI交接、跨项目复用、MCP工具）
```

---

## 3. 核心领域模型设计 (`src/types/schema.ts`)

### 3.1 画布分组与画布 (`CanvasGroup` & `Canvas`)
- **`CanvasGroup`（画布分组）**：
  - `id`, `name`, `description`, `color`, `icon`, `createdAt`, `updatedAt`
- **`Canvas`（无限画布）**：
  - `id`, `groupId`（所属分组 ID）, `title`, `projectKey`, `description`, `status` (`active` | `completed` | `archived`)
  - `currentStageNumber`: 当前所处阶段序号（从 1 开始）
  - `viewport`: `{ x, y, zoom }`
  - `stages`: `StageZone[]`（按阶段演进的画布大区）
  - `finalZone`: `FinalDistillationZone | null`（项目结尾终局整理精华区）
  - `nodes`: `CanvasNode[]`（所有知识/功能/规范卡片节点）
  - `edges`: `CanvasEdge[]`（节点与阶段间的演进、依赖、提炼连线）

### 3.2 五大标准知识分类 (`NodeCategory`)
AI 记录或整理的每一项内容，自动归入以下核心分类（同时支持自定义扩展标签）：
1. **`feature_impl`（功能实现）**：具体模块实现、接口逻辑、组件功能、代码落地点。
2. **`convention_practice`（规定做法与约定）**：开发者与 AI 之间约定的代码规范、工作流要求、禁止事项、沟通与提交约定。
3. **`architecture_design`（架构与模型设计）**：系统分层、数据结构、模块边界与技术选型。
4. **`pitfall_fix`（踩坑与问题修复）**：Bug 根因、环境陷阱、避坑指南。
5. **`best_practice`（最终确定的好用法）**：经过实践检验、在阶段收尾或项目结尾确认保留并推广的黄金用法。

### 3.3 阶段大区与分类子容器 (`StageZone` & `CategoryCluster`)
- **`StageZone`（阶段区域）**：
  - `id`, `stageNumber` (`1, 2, 3...`), `title`（如 `阶段 1：基础架构与原型`）, `summary`, `status` (`in_progress` | `consolidated`)
  - `bounds`: `{ x, y, width, height }`（在无限画布上的大区坐标）
  - `clusters`: `Record<NodeCategory, CategoryCluster>`（该阶段内按类别划分的整理区块）
  - `consolidatedAt`: 阶段整理完成时间戳
- **`FinalDistillationZone`（结尾终局整理区）**：
  - 位于画布右侧或顶部的黄金汇总大区，包含：
    - `confirmedPractices`: 最终确定的好用法与核心约定节点列表
    - `coreImplementations`: 核心功能实现架构总结
    - `reusablePatterns`: 已同步至全局经验库的可复用模式 ID 列表
    - `handoffSummary`: 终局交接摘要

---

## 4. 无限画布自动空间布局算法 (`src/core/layout.ts`)

为确保 AI 通过 MCP 自动写入和阶段整理时，画布始终井然有序、视觉直观：
- **水平时间轴 + 垂直分类矩阵布局**：
  - **X 轴（从左向右）代表项目阶段演进**：
    - `Stage 1 Zone` 位于 `X = 0`
    - `Stage 2 Zone` 位于 `X = 1500`
    - `Stage N Zone` 位于 `X = (N - 1) * 1500`
    - `Final Distillation Zone（结尾总整理精华区）` 位于所有阶段右侧，高亮金/青色边框。
  - **Y 轴（阶段内部从上到下）代表不同分类容器（Category Clusters）**：
    - 顶部泳道：`convention_practice`（我们之间规定的做法与约定）
    - 中上泳道：`architecture_design`（架构与模型设计）
    - 中部泳道：`feature_impl`（本阶段功能实现）
    - 底部泳道：`pitfall_fix` & `best_practice`（踩坑修复与本阶段好用法）
  - **阶段整理重排（Stage Consolidation Layout）**：
    - 当 AI 触发“阶段整理”时，引擎自动将该阶段内所有散落或新增的节点按类别归拢、去重合并、生成阶段小结卡片，并建立与上一阶段同类别容器的演进连线。

---

## 5. 标准 MCP 工具集与资源设计 (`src/mcp/tools.ts`)

MCP Server 暴露以下高语义工具，供任意 AI 在开发过程中调用：

1. **`manage_canvas_group`**：创建、列出或更新画布分组（如“游戏研发组”、“AI 工具链组”）。
2. **`create_or_switch_canvas`**：在指定分组下新开画布，或切换当前活动画布。
3. **`record_project_learning`**：
   - AI 在项目中每完成/学到一部分内容时调用。
   - 支持传入 `title`, `content`, `category`（若不传则由 `classifier.ts` 自动识别分类）, `tags`, `relatedFiles`, `importance`。
   - 自动放入当前阶段的对应分类容器，并实时推送到前端画布。
4. **`consolidate_current_stage`（阶段分类整理）**：
   - 每过一个阶段后由 AI 调用。
   - 自动对该阶段下的“不同功能实现”、“我们之间规定的做法”、“架构与修复”进行分类聚类、提炼各分类阶段小结、重排画布坐标，并可选择自动开启下一阶段（`advanceToNextStage: true`）。
5. **`advance_project_stage`**：显式进入项目下一阶段（开辟新的阶段大区与分类容器）。
6. **`finalize_project_distillation`（项目结尾总整理）**：
   - 在项目结尾或大版本收官时调用。
   - 自动扫描全周期所有阶段，将高价值/已验证的“我们规定的好做法”、“核心功能实现模式”汇总到画布的**终局精华区（Final Distillation Zone）**，同时自动沉淀到**全局跨项目经验库**。
7. **`get_handoff_context`（跨 AI / 跨会话无缝交接）**：
   - 新会话或新 AI 接入时第一个调用的工具。
   - 返回结构化交接包 + Markdown 全景文档（包含：项目背景、当前所处阶段、必须遵守的“我们规定的做法”、已完成各阶段的功能实现索引、未决事项、以及终局最佳实践）。
8. **`query_cross_project_experiences`（从不同项目中吸取经验）**：
   - 按关键词、分类或标签检索其他项目沉淀下来的“好用法 / 规定做法 / 架构模式”。
9. **`apply_experience_to_canvas`（将历史项目经验应用到当前新项目）**：
   - 将其他项目中验证过的好用法一键导入当前画布的“规定做法”或“架构设计”区，实现跨项目能力继承。

---

## 6. 制作与阶段性 GitHub 云端上传计划

严格遵循“分阶段开发并隔一段时间进行一次 GitHub 云端上传”的要求，工程执行分为 3 个递进阶段，每完成一个阶段立即运行验证并推送至 GitHub 云端仓库：

- **Stage 1（架构落地 + 核心存储/自动分类/阶段整理/终局蒸馏/交接引擎 + 单元测试）** -> 完成后进行第 1 次 GitHub 云端上传。
- **Stage 2（标准 MCP Server `stdio` + REST/SSE 实时同步服务 + 跨项目经验复用接口）** -> 完成后进行第 2 次 GitHub 云端上传。
- **Stage 3（交互式无限画布 Web 工作台 + 多分组/多画布/阶段泳道/一键交接文档预览 + 全链路验收）** -> 完成后进行第 3 次 GitHub 云端上传。
- **Stage 4（全中文内容规范 + 极简护眼 UI 重构 + 一键连接/一键复制给 AI + 独立桌面应用 `无限画布.exe`）** -> 完成后进行第 4 次 GitHub 云端上传。

---

## 7. Stage 4 专项升级设计：全中文规范、极简护眼界面、一键连接 MCP 与独立桌面程序 (`无限画布.exe`)

### 7.1 强制全中文呈现规范（All-Chinese Content Policy）
1. **界面与数据全面中文化**：
   - 界面上所有按钮、状态、阶段标题、分类名称、提示语 100% 使用自然、直白的简体中文，严禁暴露 `feature_impl`、`consolidated`、UUID 等英文枚举或技术编号。
   - 默认示例数据库（`data/store.json` 与 `data/handoffs/*.md`）所有分组、画布、阶段、卡片标题、要点、跨项目经验必须 100% 为纯正中文。若检测到旧版含英文示例的默认种子数据，自动升级/重置为全中文种子数据。
2. **MCP 工具契约强制中文输入与中文输出**：
   - 在 `src/mcp/tools.ts` 所有 MCP 工具描述与参数说明中明确加入强制规则：**“【强制中文规范】所有写入画布的标题（title）、内容（content）、阶段总结与好用法必须使用简体中文，方便用户在画布中直接阅读。”**
   - 在 `classifier.ts` / `engine.ts` / `handoff.ts` 中生成的阶段汇总节点、终局精华提炼节点、以及 `HANDOFF.md` 交接文档全部采用清晰的中文结构化排版。

### 7.2 极简、“不费眼”的视觉与交互方案（Low-Fatigue Eye-Care Design）
1. **柔和护眼纸感配色**：
   - 采用温暖护眼的羊皮纸/米灰底色（画布背景 `#F4F1EA`、面板背景 `#FAF8F3`、柔和深灰墨色文字 `#262927`、次级文字 `#5C625E`），搭配低饱和度莫兰迪色标区分 5 类卡片，长时间观看不刺眼、不疲劳。
   - 字体采用 `15px–17px` 舒适大字号与充足行距（`1.65`），卡片留白充足。
2. **卡片表面极简减负**：
   - 画布上的卡片表面只显示 **3 样核心信息**：① 中文类别标签（如 `我们的规定做法`、`功能实现`、`最终好用法`）；② 醒目中文标题；③ 1~2 条最核心的中文结论要点。
   - 不在卡片表面堆砌文件路径、ID、时间戳或长篇大论；点击卡片时才在右侧清爽详情栏查看完整内容。
3. **顶部与侧边栏极简化**：
   - 左侧栏只保留直观的 **【画布分组与画布切换】** 和 **【跨项目好用法库（点一下即可用入当前项目）】**。
   - 顶部栏只保留最核心的阶段跳转胶囊与 4 个大白话主按钮：
     - `＋ 记一条`
     - `✨ 整理本阶段`（弹窗内可一键勾选“整理后直接开启下一阶段”）
     - `🏆 项目结尾总整理`
     - `🔗 一键连接 MCP / 复制给 AI`

### 7.3 极简 MCP 连接体验：原生支持 Codex、Claude、Gemini、DeepSeek 四种类型（点一下自动连接 / 点一下复制发给对应 AI）
专门针对 **Codex (`codex`)、Claude (`claude`)、Gemini (`gemini`)、DeepSeek (`deepseek`)** 四种主流 AI 提供专属的一键连接与一键复制卡片：
1. **四种 AI 专属一键连接/复制面板（`Codex` / `Claude` / `Gemini` / `DeepSeek`）**：
   - 在顶部工具栏点击 `🔗 一键连接 AI (Codex / Claude / Gemini / DeepSeek)`（或直接在顶部快捷栏点选），展示清晰不费眼的 **4 张 AI 专属卡片**：
     1) **Codex（OpenAI Codex CLI / 客户端）**：
        - `⚡ 一键自动接入本机 Codex`（自动写入 `~/.codex/config.toml` 的 `[mcp_servers.infinite_canvas]`）
        - `📋 点一下复制发给 Codex`（复制针对 Codex 优化的中文连接+当前画布交接指令与 TOML/命令配置）
     2) **Claude（Claude Code / Claude Desktop）**：
        - `⚡ 一键自动接入本机 Claude`（自动写入 `~/.claude.json` 或 `%APPDATA%\Claude\claude_desktop_config.json`）
        - `📋 点一下复制发给 Claude`（复制针对 Claude 优化的 `claude mcp add` 命令 / JSON 配置 + 当前画布中文交接指令）
     3) **Gemini（Gemini CLI / Google Antigravity）**：
        - `⚡ 一键自动接入本机 Gemini`（自动写入 `~/.gemini/settings.json` 的 `mcpServers.infinite-canvas`）
        - `📋 点一下复制发给 Gemini`（复制针对 Gemini CLI / Antigravity 优化的 MCP 配置 + 当前画布中文交接指令）
     4) **DeepSeek（DeepSeek 客户端 / 支持 MCP 或 HTTP/提示词交接的 DeepSeek 工具）**：
        - `⚡ 一键生成/写入 DeepSeek 接入配置`（生成通用 MCP JSON & DeepSeek 本地 HTTP API 调用配置 `deepseek-mcp-config.json`）
        - `📋 点一下复制发给 DeepSeek`（复制专为 DeepSeek 定制的中文全量交接指令 + MCP/本地 REST 接口调用说明，即使在纯网页版 DeepSeek 对话框里粘贴也能直接无缝接手当前项目！）
2. **后端接口支持（`GET /api/mcp/connect-bundle` & `POST /api/mcp/quick-connect`）**：
   - `GET /api/mcp/connect-bundle` 返回 `providers: { codex, claude, gemini, deepseek }` 四种类型的专属一键复制中文指令（`aiPrompt`）、专属配置块（`configSnippet`）、一键终端命令（`cliCommand`）及本机检测状态。
   - `POST /api/mcp/quick-connect` 支持传入 `provider: "codex" | "claude" | "gemini" | "deepseek" | "all"`，一键自动写入对应 AI 的本机配置。

### 7.4 独立桌面应用窗口、真全屏无顶栏覆盖模式与核心交互设计准则
1. **核心交互与设计准则（已接入无限画布经验库）**：
   - **《简约直观优先，拒绝多余解释》**：无论是设计程序、游戏、人物还是交互，简约直观都是非常大的优势；尤其对于程序交互界面，简约直观的优势尤为明显。界面元素严禁堆砌多余的汉字解释、小字统计或标语式说明文案（如去掉阶段头部的 `我们规定的做法：1 条；架构与模型设计：1 条…`、去掉 `记录、探索、验证，让知识在这里积累。`、去掉弹窗里的 `让每一份项目知识都有自己的归属。` 等一切非必要小字），窗口控制只保留原本直观的 `−`、`□`、`×` 符号，操作按钮只用最凝练的直白短词（`＋ 记一条`、`阶段整理`、`下一阶段`、`总整理`、`Codex`、`Claude`、`Gemini`、`DeepSeek`、`交接文档`）。
2. **真全屏无标题栏覆盖模式（消除顶部多余文字与 `−  □  ×` 按钮栏）**：
   - **清空系统顶栏多余文字**：HTML `<title>` 与 `document.title` 保持空白零宽字符（`\uFEFF`），并在 `Launcher.cs` 中通过 Win32 `SetWindowTextW(hwnd, "")` 强制清空系统标题栏文字，窗口模式下只保留原本简洁的 `−`、`□`、`×`。
   - **点击放大（`□`）或全屏时进入 100% 屏幕覆盖的“真全屏”**：
     - 当用户在窗口顶栏点击 `□`（最大化/全屏）时，`Launcher.cs` 的 Win32 监控循环检测到 `IsZoomed(hwnd)`，自动移除窗口的 `WS_CAPTION | WS_THICKFRAME` 系统标题栏边框并将其 100% 铺满当前显示器物理全屏区域（`rcMonitor`），**看不见顶部任何文字，也看不见 `−`、`□`、`×` 按钮，直接全屏覆盖**（按 `Esc` 或 `F11` 可退回带 `− □ ×` 的常规窗口模式）。
     - `F11` / `Esc` 由启动器的键盘钩子统一处理，仅在应用窗口处于前台时消费快捷键，并忽略长按重复。启动器通知浏览器隐藏或恢复自身绘制的窗框，再应用原生边界；恢复位置稳定后才重新接受最大化检测，避免浏览器异步恢复旧矩形导致反复切换。网页不增加全屏按钮，也不再次处理这些快捷键。
     - 浏览器加速键通过带专属标记的 `SendInput` 发送；钩子放行此标记，避免重复切换，仅向当前前台应用发送。自动化测试直接验证快捷键状态逻辑，并通过 Chromium 自动化接口同步浏览器全屏状态后检查原生窗口与客户区边界，不依赖测试环境的全局 F11 或前台焦点。
3. **自举接入无限画布应用（Dogfooding）**：
   - 将本准则（“程序/游戏/人物/交互设计简约直观优先，程序交互界面尤甚，拒绝多余解释文字”、“平等交流用你不用您”、“视觉架构先行再交由 Codex 实现并阶段性同步 GitHub”）直接作为核心规定做法与跨项目好用法写入《无限画布》默认数据库与跨项目经验库中。
   - `src/core/storage.ts` 的 `CORE_CONVENTIONS` 保留用户原文；默认示例同时创建重要程度为 5 的 `convention_practice` 节点和带来源引用的 `best_practice` 经验。现有工作台可运行 `node --import tsx scripts/record-design-principles.ts` 增量同步并重建交接文档，重复运行不会重置项目或复制记录，也不会提前结项。


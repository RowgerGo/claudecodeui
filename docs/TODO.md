# 待实现任务清单

## Codex 网页聊天支持 `/compact` 和 `/goal`

基于 `custom` 的 `7e82bb8a` 和项目内置的 Codex CLI `0.170.0`。交付目标是让用户在同一聊天中手动压缩上下文，并让 Codex 在浏览器关闭后仍能围绕目标继续工作。按以下三个提交实施，每项通过其验收条件后勾选。

### 提交 1 · 接入 Codex 会话命令

- [x] **1.1 在命令菜单和输入框识别两个命令**

  1. 为命令列表请求增加可选的 `provider`，在 Codex 的聊天菜单、快捷设置命令列表和帮助中登记 `/compact` 和 `/goal`。复用两个界面已有的命令来源。涉及显示的命令说明、状态和错误文案走现有 i18n。 [命令注册](../server/modules/commands/commands.routes.ts) · [共享命令列表](../src/shared/hooks/useProjectSlashCommands.ts) · [前端 API](../src/shared/api.ts)
  2. 让菜单点击、键盘选中和直接输入共用同一个命令处理函数。直接输入按行首完整命令名匹配，在排队和轮内引导之前分发。保留 Tab 补全以及自定义命令展开时跳过再次解析的行为。 [命令菜单](../src/modules/chat/hooks/useSlashCommands.ts) · [输入提交](../src/modules/chat/hooks/useChatComposerState.ts)

  **验收条件**　Codex 的两个菜单都能找到新命令。直接发送多行目标保留原文，输入 `/goalkeeper` 仍按普通文本发送。普通轮运行时输入 `/goal pause` 进入命令处理函数一次，`chat.send`、`chat.steer` 和队列写入各为零。切换其他提供方可继续使用其已有的同名自定义命令。

- [x] **1.2 实现会话控制消息、独立回执和请求去重**

  1. 在聊天 WebSocket 增加 `chat.compact` 和 `chat.goal`。请求携带应用 `sessionId`、`requestId`，目标操作另带动作与对应参数。服务端从会话记录解析提供方、工作目录和原生线程 ID，校验参数后交给 Codex 运行时。把消息及回执类型加入前后端共享类型，并补充 WebSocket 协议文档。 [WebSocket 网关](../server/modules/websocket/services/chat-websocket.service.ts) · [后端类型](../server/shared/types.ts) · [前端类型](../src/shared/types.ts) · [传输协议](architecture/01-websocket-transport.md)
  2. 按会话和请求 ID 在第一次原生调用前登记操作。同一请求重发时返回进行中或已知结果。将请求受理、拒绝和实际执行结果分别回显，错误只更新对应操作。浏览器用原请求 ID 核对丢失的回执，服务重启后无法确认结果时保留「待确认」。 [运行注册表](../server/modules/websocket/services/chat-run-registry.service.ts) · [网页事件处理](../src/modules/chat/hooks/useChatRealtimeHandlers.ts)

  **验收条件**　丢弃第一次回执后重发相同请求 ID，只观察到一次原生写操作。非 Codex 会话或非法参数收到对应请求的错误，原生调用数为零。模拟操作被拒绝时，原聊天仍能流式输出，未提交的目标文本及附件仍在原会话草稿中。

### 提交 2 · 完成手动上下文压缩

- [ ] **2.1 在空闲线程上发起一次压缩**

  1. `/compact` 接受零个参数。尚无可压缩历史时直接提示，空白聊天无需分配线程。已有历史时由后端取得原生线程，使用同一会话的连接，必要时恢复原线程并沿用模型、目录和权限设置。
  2. 将忙碌检查和占用会话放进同一次调度操作，同时检查当前轮、已受理的压缩和原生目标状态。首版仅允许空闲且目标未激活的线程手动压缩。先订阅通知，再调用 `thread/compact/start({ threadId })`。保护也适用于相反方向，压缩进行时先拒绝会立即开轮的目标创建、替换或恢复。0.170.0 的压缩处理会先停止该线程已有的任务。 [运行时](../server/modules/providers/list/codex/codex-runtime.provider.ts) · [原生压缩实现](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/core/src/session/handlers.rs#L271-L278)

  **验收条件**　空白聊天、带多余参数、当前轮忙碌或目标为 `active` 时均不发出压缩 RPC。空闲会话双击只触发一次压缩。在两个标签页同时压缩和恢复目标，只有先获准的操作进入 Codex，另一方收到可理解的提示，现有轮次没有被替换。

- [ ] **2.2 展示压缩进度，并让刷新后的历史与实时页面一致**

  1. `thread/compact/start` 返回 `{}` 时记录「已受理」。按 `threadId`、`turnId`、`item.id` 关联 `contextCompaction` 的 `item/started` 和 `item/completed`。用同一行显示进度，在匹配轮次成功结束后标记完成。对中断、原生错误和子进程退出收尾并释放对应运行位置。 [官方压缩协议测试](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/tests/suite/v2/compaction.rs#L534-L560)
  2. 将实时条目和历史中的 `context_compacted` 等压缩记录映射到现有 `CompactionInfo`。按原生 ID 合并，旧记录缺 ID 时按对应轮次和边界去重。手动和自动压缩都走现有压缩行，只显示原生实际提供的摘要及用量。 [Codex 历史读取](../server/modules/providers/list/codex/codex-sessions.provider.ts) · [压缩行合并](../src/modules/chat/hooks/useChatMessages.ts) · [压缩行渲染](../src/modules/chat/transcript/MessageComponent.tsx)

  **验收条件**　在 RPC 已应答、压缩尚未完成时页面仍显示进行中。分别模拟成功、失败、中断和进程退出，运行位置均能释放，只有成功场景显示完成。手动压缩和自动压缩各测一次，刷新后每次压缩各有一行，继续聊天仍使用原线程。

### 提交 3 · 完成持久目标和自动续轮

- [ ] **3.1 接入目标查询、创建、编辑、暂停、恢复和清除**

  1. 实现以下命令映射。设置与清除由用户显式操作触发时传入 `origin: "user"`。暂停、恢复只提交新状态。无目标、预算或账号限制、Goals 功能关闭等情况，按原生结果返回。 [原生目标协议](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal)

     | 网页命令 | 实现 |
     | --- | --- |
     | `/goal` | 用 `thread/goal/get` 获取目标，空白聊天直接显示「尚无目标」。 |
     | `/goal <目标>` | 通过 `thread/goal/set` 激活目标。新聊天先取得应用会话 ID，按当前目录、模型、推理强度及权限设置创建持久原生线程，保存映射后再设置目标。 |
     | `/goal edit` | 读取现有目标，预填编辑框，保存时原地更新文本并保留状态和预算。 |
     | `/goal pause`、`/goal resume` | 调用 `thread/goal/set`，分别提交 `paused` 或 `active`。 |
     | `/goal clear` | 调用 `thread/goal/clear`，按结果显示「已清除」或「尚无目标」。 |

  2. 输入新目标时，如已有未完成目标，显示旧目标和新目标供确认。确认替换后按 0.170.0 原生客户端的顺序清除再设置。把两步纳入同一会话操作，提交前核对被替换的目标。如果清除成功但设置失败，重读实际状态并保留新目标草稿。 [原生编辑与替换](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/app/thread_goal_actions.rs#L132-L207)

  **验收条件**　以目标作为新聊天的第一条输入，产生一条应用会话、一条持久原生线程、一次目标设置，CloudCLI 主动发送的 `turn/start` 为零。查询空白聊天创建的会话数为零。分别验证取消替换、编辑后保留预算、暂停后恢复，以及替换第二步失败后页面显示真实目标状态。

- [ ] **3.2 让同一会话连接接收多个原生轮次**

  1. 将 App Server 连接的生命周期和单轮运行记录分开。普通聊天、目标操作和压缩复用当前会话已持有的连接。先挂线程通知，再打开或恢复线程。目标为活动状态时跨轮保留连接，包括普通聊天中由 Codex 工具创建目标的情况。原生 `set(active)` 可自行开轮，续轮由 Codex 发起。 [App Server 客户端](../server/modules/providers/list/codex/codex-app-server.client.ts) · [Codex 运行时](../server/modules/providers/list/codex/codex-runtime.provider.ts) · [原生目标处理](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L149-L250)
  2. 每个原生 `turnId` 分别进入现有运行注册表，各自推流、结算一次并绑定自己的引导和停止操作。让用户消息、排队消息、手动压缩和自动续轮在同一会话协调。若原生续轮已先启动，保留待投递消息，在可用时只发送一次。目标暂停或清除时，等已在运行的轮次结算后再回收空闲连接。 [运行注册表](../server/modules/websocket/services/chat-run-registry.service.ts) · [排队调度](../server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts)

  **验收条件**　让目标实际经过 A、B 两个不同的原生轮次，B 的文本可见，发给 B 的引导和停止只命中 B。A 结束时排队的用户消息恰好投递一次。运行中执行 `/goal pause` 或 `/goal clear` 后，当前轮可以收尾，之后自动新开轮数为零。另一个会话继续正常工作。

- [ ] **3.3 展示目标状态并恢复断线会话**

  1. 将 `thread/goal/updated` 和 `thread/goal/cleared` 按线程映射为应用会话事件，允许事件缺少 `turnId`。在聊天输入框附近展示目标、状态、已用 token 和可选预算。覆盖 `active`、`paused`、`blocked`、`usageLimited`、`budgetLimited`、`complete` 六种状态，按钮和斜杠命令调用同一操作。
  2. 在 `chat.subscribe` 恢复目标快照、当前轮和已有事件回放。用会话标识和事件顺序避免旧查询覆盖新事件。网页断开只移除订阅，后端继续执行。服务进程重启后先从 Codex 读回目标，按实际状态提供恢复操作。 [会话订阅](../server/modules/websocket/services/chat-websocket.service.ts) · [客户端事件处理](../src/modules/chat/hooks/useChatRealtimeHandlers.ts)

  **验收条件**　关闭所有浏览器标签页，服务端仍能完成 A 并接收 B。重新打开时看到正确目标和 B 的输出或历史。双标签页暂停与清除后状态一致。切换会话后迟到的旧快照只属于原会话。重启服务并打开已暂停的目标，仍显示暂停，查询本身启动的轮次数为零。

- [ ] **3.4 运行自动化测试并完成真实网页验收**

  1. 用可控制通知顺序的 App Server 替身测试命令去重、压缩乱序或失败、目标自动开轮、回执丢失和进程退出。扩展现有的 [Codex 运行时测试](../server/modules/providers/tests/codex-runtime.test.ts)、[运行注册表测试](../server/modules/websocket/tests/chat-run-registry.test.ts)、[命令输入测试](../src/modules/chat/tests/slashCommandArguments.test.ts) 和 [压缩行测试](../src/modules/chat/tests/compactionRows.test.ts)。
  2. 运行 `npm test`、`NODE_ENV=test npm run test:client`、`npm run typecheck`、`npm run lint` 和 `npm run build`。在隔离的 CloudCLI 实例使用内置 Codex 和浏览器，核对新聊天、旧会话续聊、双标签页并发、刷新、关页、服务重启、排队、引导和停止。

  **验收条件**

  - 关闭网页后目标至少自动续一轮，记录可对应到同一线程的两个不同轮次。
  - 有正在执行的轮次或活动目标时，手动压缩的 RPC 次数为零，原任务仍可继续。
  - 本节单独记录提交、CLI 版本、各场景的预期与实测，以及自动化测试结果。类型检查和构建通过，lint 无新增问题。

## Codex 聊天支持排队和轮内引导

目标是在 Codex 执行期间，让用户决定一条新消息何时生效。「排队」等当前轮结束后再开始下一轮。「引导」把补充要求送进当前轮，影响接下来的工作，已经执行的命令和文件修改仍然有效。初始默认值为「排队」，用户可以更改默认值，也可以在发送时临时选择。

主聊天使用项目内置的 Codex CLI 0.170.0，通过本机 App Server 执行。在线聊天窗口可在快捷设置的「Codex 运行中发送消息」中切换默认行为。

### 1. 迁移主聊天，保留新旧会话和运行参数

- [x] **实现步骤**
  1. 在 [Codex 运行入口](../server/modules/providers/list/codex/codex-runtime.provider.ts)接入现有的 [App Server 客户端](../server/modules/providers/list/codex/codex-app-server.client.ts)。由 CloudCLI 后端启动本机子进程，通过标准输入输出握手，并在整轮运行期间持有连接。
  2. 新会话调用 `thread/start`，已有会话从项目保存的映射取得原生线程 ID，再调用 `thread/resume`。两条路径都通过 `turn/start` 发送首条输入，记录本轮的线程 ID 和轮次 ID。保留当前的工作目录、模型、推理强度、沙箱与审批策略，以及文本、图片和文件的处理方式。
  3. 把运行记录绑定到应用会话。正常完成、主动停止和子进程异常退出时，清理对应轮次的资源。每轮从开始就采用 App Server，以便用户执行到一半才决定发送引导。
- **验收条件**
  - 新建会话后连聊两轮，只有一个侧栏会话、一个原生线程和两个轮次。打开迁移前由 `exec` 创建的会话再发一条，仍使用原线程 ID，刷新后可看到前后两段历史。
  - 分别发送纯文本、仅图片、带文件三种消息，核对 Codex 收到的输入。指定工作目录、模型、推理强度和权限模式，核对实际请求参数。并行打开两个会话，停止其中一个后另一个仍能输出。

### 2. 接回流式输出、工具状态和停止操作

- [x] **实现步骤**
  1. 将 App Server 的消息增量、工具开始与结束、用量更新和轮次结束事件转换为网页现有的聊天事件。用同一条目 ID 更新文本或工具卡，并通过现有运行注册表发送，以便断线后回放。
  2. 将网页的停止操作接到目标轮次的 `turn/interrupt`。按主聊天现有权限设置处理工具请求，核对沙箱限制和拒绝结果。统一处理正常结束、中断、模型错误和子进程退出。
- **验收条件**
  - 用一轮含文本、工具调用和最终回复的对话验证。执行时能看到进度，同一工具只有一张卡，结束后能看到回复和可用的用量数据，刷新后消息顺序正确。
  - 分别测试正常完成、手动停止、模拟模型错误和子进程退出。各轮仅产生一次结束事件，页面退出「处理中」，下一条消息可正常发送。在受限权限下尝试对应受限操作，结果符合所选策略。

### 3. 将引导准确送达指定轮次

- [x] **实现步骤**
  1. 接通现有 `chat.steer` 和 Codex 运行时的 `steer`。让请求携带用户发送时看到的目标轮次，服务端核对会话归属，通过本轮已有连接调用 `turn/steer`，传入 `threadId`、`expectedTurnId`、输入和 `clientUserMessageId`。接通后启用 Codex 的 `supportsSteering`。
  2. 复用输入框生成的消息 ID，区分「服务端已接受」和「Codex 已回显该用户消息」。按会话和消息 ID 合并重复请求及回显。若确认目标轮次已结束且消息未被接受，把它放回原会话队列；若回执丢失，按第 5 项核对状态。
- **验收条件**
  - 保持轮次 A 运行，发送引导「这次只改前端」。协议记录显示一次指向 A 的 `turn/steer`，期间没有新增 `turn/start`。随后可在 A 的事件中找到该消息 ID，实时页面与刷新后的历史各显示这条消息一次。
  - 模拟 A 结束、B 已启动后才收到发往 A 的请求。B 收到的引导数为零。确认拒绝后，该消息只进入原会话队列一次。重复提交同一消息 ID，Codex 最多收到一次引导。

### 4. 增加默认发送方式和单次覆盖

- [x] **实现步骤**
  1. 在[界面偏好](../src/shared/uiPreferences.ts)和[快捷设置](../src/modules/quick-settings-panel/QuickSettingsPanelView.tsx)中增加 Codex「运行中发送消息」选项。新用户及缺少该字段的已有配置均取「排队」，沿用现有偏好保存机制。
  2. 在[发送菜单](../src/modules/chat/composer/ComposerSendMenu.tsx)和[输入框提交逻辑](../src/modules/chat/hooks/useChatComposerState.ts)中，让常规发送采用用户偏好，菜单允许单条覆盖。显示本次会执行的动作，并给出对应语言的提示。空闲会话、斜杠命令、只有后台任务的会话沿用各自的发送路径。
- **验收条件**
  - 默认设置下，A 运行中发送 B，A 完成前只有一次 `turn/start`；A 完成后 B 恰好启动一次新轮。将默认改为「引导」并刷新页面，再在运行中按常用发送键，消息进入当前轮。
  - 分别在默认排队时手动选引导、默认引导时手动选排队。每条消息的实际去向符合选择，下一条恢复使用原偏好。空闲时正常开始新轮，斜杠命令可用，其他提供方的菜单和默认行为保持原有表现。

### 5. 处理弱网、刷新和引导回执丢失

- [x] **实现步骤**
  1. 保留网页与后台任务各自的生命周期。浏览器断开时只移除网页连接，后端继续读取 Codex 事件。重连复用[会话订阅和回放](../server/modules/websocket/services/chat-websocket.service.ts)，按序号补收仍在运行的事件；已结束的轮次从持久化历史恢复。
  2. 保存核对待确认消息所需的会话、轮次、消息 ID 和输入。刷新或重连时先与后端记录、事件或历史核对。能确认未发送的恢复输入，已送达的合并显示，状态仍未知的保留「待确认」。已接受但确认未送达便被停止的消息恢复为草稿。
  3. 让打开的 Codex 会话保持订阅，接收队列自动开启的下一轮。浏览器已断开时，保留等待保存的草稿。若确定引导被拒绝，保留待排队的消息直到队列写入有明确结果。
- **验收条件**
  - 长任务运行时断开网页网络。在任务仍运行时重连，能继续看到同一轮输出；在任务已结束后重连，能从历史看到最终结果，状态恢复空闲。离线超过事件缓存范围时，仍能恢复已持久化的对话内容。
  - 分别在发送前断网、服务端已接收但网页尚未收到回执时断网，并各做一次页面刷新。前一种可找回输入；后一种恢复后核对到原消息，只有一条聊天记录、一次实际投递。对仍未知的结果，页面保留可辨认的状态，自动重发次数为零。

### 6. 完成迁移回归和网页端验收

- [x] **实现步骤**
  1. 用可控制事件顺序的 App Server 测试替身覆盖上述协议分支，记录轮次、消息 ID 和调用次数。扩展现有的[运行注册表测试](../server/modules/websocket/tests/chat-run-registry.test.ts)、[输入框引导测试](../src/modules/chat/tests/composerSteering.test.ts)和[发送菜单测试](../src/modules/chat/tests/composerSendMenuSteer.test.tsx)。
  2. 运行 `npm test`、`npm run test:client`、`npm run typecheck`、`npm run lint` 和 `npm run build`。在测试实例使用实际 Codex 和网页各走一遍排队、引导、停止、断线重连，以及迁移前会话的续聊。
- **验收条件**
  - 自动化覆盖第 1 至 5 项的关键分支，测试、类型检查、构建通过，lint 无新增问题。
  - 在测试记录中写明 CLI 版本、各场景的预期和实际结果。排队产生下一轮、引导留在原轮、消息只投递一次，这三项均能从界面表现和协议事件互相核实。

### 验收记录

在本机隔离的 CloudCLI 实例中，使用 Chromium 和项目内置的 Codex CLI 0.170.0（GPT‑6.2 Sol）核对界面、App Server 事件和会话历史。

| 场景 | 预期 | 实测结果 |
| --- | --- | --- |
| 当前轮运行时排队 | A 结束后只启动一次 B，网页接收 B 的实时输出 | A 的 `turn/completed` 之后出现唯一一次 B 的 `turn/start`，网页收到 B 的 `turn_started` 并显示回复 |
| 当前轮运行时引导 | 消息进入 A，刷新后只显示一次 | 观察到一次指向 A 的 `turn/steer`，原生回显和历史保存了相同消息 ID，刷新后引导文本只有一条 |
| 引导已发送但回执丢失 | 重连到同一轮且消息不重复 | 人为丢弃回执并断开网页连接，重连后接回原轮，从回显和历史确认同一消息 |
| 发送前断线，离线时轮次结束 | 未发送文本可编辑，已完成回复在重连后恢复 | 断开 WebSocket 后按 Enter 并刷新，草稿仍在输入框，期间没有发送 `chat.steer`。Codex 在离线期间完成，重连后网页从历史显示最终回复 |
| 默认偏好和单次覆盖 | 刷新保留偏好，菜单只覆盖当前消息 | 默认设为引导并刷新，菜单仍可选择排队，其后按 Enter 继续引导 |
| 停止和并行会话 | 只停止所选会话中的目标轮次 | 观察到指定轮次的一次 `turn/interrupt` 和一次中断结束事件，另一个会话继续执行并正常完成 |
| 旧会话续聊 | 恢复原生线程并保留旧历史 | 用 0.170.0 的 `codex exec` 建立旧会话，网页通过 App Server 按原线程 ID 恢复，刷新后可见新旧回复 |
| 附件与工作目录 | 图片和普通文件都能送达，续聊保持线程 | 纯图片发送使用 `localImage`，下一轮读到了上传文本中的唯一标记，两个轮次共用线程 ID，工作目录和模型与选择一致 |

自动化测试补充验证了旧轮引导不会投到新轮、消息 ID 去重、权限请求拒绝、崩溃处理和已确认未读的草稿恢复。

- 后端全量测试通过 1,073 项。既有的真实分叉测试缺少所需的 rollout 样本，跳过 1 项。
- 前端全量测试通过 1,195 项。运行时清除了宿主进程设置的 `NODE_ENV`，以启用 React 的测试工具。
- 类型检查和生产构建通过。Lint 保留基线的 147 项告警。

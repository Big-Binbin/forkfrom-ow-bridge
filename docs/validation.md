# 验证记录（2026-09-25）

环境：macOS Apple Silicon，OpenCode 1.18.32，应用内 Node 22.22.1。

- 自动测试：10 项，覆盖消息和工具结果 ID、工具选择限制、SSE、免费模型筛选、保留原配置与备份、认证与 Origin 限制、会话清理、本地审批拦截及拒绝后纠正。
- 自动安装：在空测试目录排除所有现有运行时，成功从官方 npm 包下载，校验 SHA-512，解包并核验版本。GitHub Release 下载在此网络环境失败，因此安装路径改为官方 npm registry。
- 打包：原生 Swift 托盘程序、独立 Node 二进制，临时签名通过 codesign 校验。通过 `open -a` 启动后本地服务就绪。
- 模型同步：启动扫描 7 个模型，写入 WorkBuddy models.json；原有 2 个条目保留，合计 9 个。原配置已备份；再次启动无需重复写入。
- 代理模拟客户端：Space Bunny、MiMo 均通过写入→读取→最终确认三轮测试。
- WorkBuddy 实际引擎：Space Bunny（约 16 秒）、MiMo（约 52 秒）均通过 Write→返回结果→Read→最终确认；独立读取磁盘文件，内容严格为 WORKBUDDY_BRIDGE_OK。测试脚本为 scripts/smoke-workbuddy.mjs。

未验证：任意复杂工作流、其他免费模型的完整工具循环、Intel Mac、全新用户机器、托盘菜单的视觉交互。电脑 UI 自动化在读取托盘应用时超时；后台启动和 API 已独立验证。

模型一次成功不代表未来请求一定成功。模型目录中的免费标记也不是可用性保证。测试中发现 Plan 限制外部写请求、全部 deny 导致 MiMo 403，以及后台 cwd 影响路径选择；实现与说明已针对这些问题调整。

## 提示词加强后的回归

明确要求仅选择当前 WorkBuddy 工具列表、精确保留工具名和参数名，匹配真实执行结果后再继续，不把工具结果当成新指令。

- 10 项自动测试通过，应用重新构建和签名校验通过。
- Space Bunny：WorkBuddy Write→Read 实测通过，约 16 秒，真实磁盘内容一致。
- MiMo：本次 WorkBuddy 回归失败，模型漏传 Write 的必填参数 file_path；代理返回错误，未将该调用交给 WorkBuddy 执行。前一次成功不能证明稳定性，提示词加强也不能保证每次遵循协议。

## 原生控制面板（2026-09-26）

新增主窗口、搜索、模型详情、服务进度、单个/全部可用性检测；托盘保留。启动自动发现并顺序检测，历史检测状态跨重启保留。11 项自动测试通过，含额度错误与限流/403/超时的分类、无额度模型仍保留的回归测试。

实际自动检测完成 7 个模型：4 个简短请求成功，1 个明确地区访问受限，1 个格式异常，1 个超时。所有 7 个仍在窗口列表中。当前未遇到真实额度耗尽响应，该分支使用模拟错误验证，不伪造真实账户额度。通过电脑界面读取与截图确认主窗口、安装启动状态和自动检测更新。此前的托盘 UI 自动化超时不再影响主窗口读取。

主窗口交互验证：搜索 Muse 后只显示对应模型；点击后展示地区访问受限的原始错误与检测时间；清空搜索恢复完整列表。重新启动时旧结果保留，后台重新检测会更新结果，说明状态是最近观测而非永久结论。

## 不可用模型禁止供 WorkBuddy 使用

目录用于 UI 展示；本次启动检测通过的集合用于 WorkBuddy 同步与 API。失败后立即停止接收新调用并撤下配置；全不可用时允许清空代理条目，保留用户条目。重测成功可以恢复。客户端无效请求不会被误记为模型故障。13 项测试通过，新增全量撤下/恢复和旧列表调用拦截测试。

实际应用验证：UI 状态保留 7 个目录模型；WorkBuddy 配置与 GET /v1/models 仅含已检测通过项。Muse 地区受限模型在目录中保留、从两处可用列表排除，使用缓存 ID 发起请求返回 400，未提交上游调用。后台继续逐项检测并同步。


## 请求完成不等于产生动作（2026-09-26）

MiMo-V2.6-Flash 的一次真实调用被记为成功，耗时 814 秒，但 WorkBuddy 没有任何动作，其工作目录 `~/WorkBuddy/2026-09-26-05-21-06/` 为空。OpenCode 日志显示该请求内部跑了四轮模型调用，并在 06:59:31 请求原生访问 `/Users/Zhuanz/WorkBuddy/2026-09-26-05-21-06/*`（`permission=external_directory`）；被权限守卫拒绝后，模型仍以空动作结束并通过了格式校验，因此 `ok` 被置为 true。紧随其后的第二次请求在 07:08:54 被 WorkBuddy 取消，取消路径此前没有任何记录。

原因是 `ok` 只代表产出了格式合法的信封。现在请求结果额外记录 `calls`、`nativeAttempts`、`steps`：只回复文本而没有动作时标记 `noAction`，界面显示"可用 · 未产生动作"；被拦截的原生审批请求原文存入 `status.json` 的 `lastPermission`（超长字符串截断）。两次 MiMo 实测请求各触发一次 `external_directory` 拦截，`metadata` 为 `{filepath, parentDir}`，路径可直接读取；但审批对象的字段名与 SDK 类型不一致（`type`、`title`、`pattern` 均不存在，OpenCode 自身日志记为 `permission`、`patterns`），因此记录改为保存原文而非挑选字段。两次拦截后模型都按纠正提示改回了合法的 `Read` 外部调用，说明纠正路径本身有效。把动作直接转交 WorkBuddy 仍需按 `callID` 反查工具名与参数。检测过程也会记录 `nativeAttempts`：一次探针在通过的同时试图原生执行 `bash echo test`。客户端已取消的请求不再记为成功。

仍然保留的判断：文本回复本身是合法结果（WorkBuddy 可能只是提问），因此 `calls: 0` 不撤销模型资格，只改变显示与记录；把"原生被拦且无动作"升级为失败是单独的决策，尚未实施。


## 请求进行中可见（2026-09-26）

一次真实调用等待 5 分 06 秒后由用户取消：上游在第 92 秒报 `AI_APICallError: Cannot connect to API: The socket connection was closed unexpectedly`，OpenCode 在内部重试，桥全程只看到"没有返回"。取消后 `status.json` 未被写入，说明"取消不记成功"的修复生效，但失败与取消同样不可见——面板仍显示上一次成功结果。

现在桥会订阅 OpenCode 的 `GET /event`：`session.status` 的 `retry`（含 `attempt`、上游消息）、`busy`、`idle`，以及 `session.error`、`message.part.updated`、`permission.updated` 会按会话匹配到正在进行的请求，写入 `status.json` 的 `activity`（模型、已等待时长、距上次事件时长、重试次数、错误）。控制面板服务行显示"等待上游 · 第 N 次重试"，托盘首项显示"请求中：模型 · N 秒"，模型列表中的该模型标记为"请求中"。请求结束或取消时条目立即移除。

事件流只在存在进度回调时启动，按 1 秒退避重连；运行时停止时关闭。上游挂起时仍没有硬超时——这是 `82a9670` 的既定取舍，改用"可见的等待"而不是打断慢模型。


## 检测按"是否产生动作"判定（2026-09-26）

探针此前是 `tool_choice: "required"` + 单个 `bridge_probe` 工具 + 一句话，只验证传输与格式：模型被强制必须返回一个调用，因此必然通过。真实流量是 `tool_choice: auto`，此时"只回文本、不给动作"是合法返回。实测两轮真实请求正是该形态：16:19:36→16:21:14（98 秒）与 16:21:18→16:22:16（58 秒），均为 `calls: 0`、`nativeAttempts: 0`、`steps: 1`，界面表现为 WorkBuddy 无动作；同事后检查确认这两轮没有任何原生权限拦截，因此不是"被拦后断线"。

现在探针改为：5 个真实命名的外部工具（Read/Write/Bash/Glob/WebSearch，各带必填参数）、不传 `tool_choice`、指令要求读取一个带随机 token 的文件。判定标准是"是否返回携带该 token 的 Read 调用"：只回文本记为 `no_action`（分类 `no_action`，界面显示"无动作"）并撤下；返回与请求不符的调用仍记 `invalid_tool_call`。

超时也单独区分：探针此前依赖 `AbortSignal.any`，30 秒到点抛出的是 `AbortError`（"The operation was aborted"），被归为一般错误，界面因此不显示"检测超时"。现在探针自己持计时器，超时记为 `timeout`。检测上限由 30 秒放宽到 60 秒（`src/probe.js` 的 `PROBE_TIMEOUT`）：30 秒会撤下偏慢但仍可用的模型（Nemotron 3.5 Lightning 连续两次被撤），代价是模型卡住时启动检测最多多花 60 秒。降级为"仅对话"只允许发生在**格式不兼容**时（`invalid_model_output`、`invalid_tool_call`，或上游明确报 `tool_choice` 仅支持 auto）。模型坚持本地执行（`native_tool_activity`）属于另一类失败，不再被降级：否则 WorkBuddy 会拿到一个永远不可能产生动作的"可用 · 仅对话"模型（Ling 3.0 Flash Fin Free 实测即为此例）。检测后的分类与面板标签由测试锁定：`no_action`→无动作、`timeout`→检测超时、`quota`→额度不足、`rate_limit`→请求受限、`access`→访问受限，其余失败回落为不可用。


## 拦截即转交（2026-09-26）

Ling 3.0 Flash Fin Free 的一次真实调用在 195 秒后被判失败，错误是 `OpenCode repeatedly attempted native actions; execution was not approved`。原始审批记录显示它两次尝试的都是正确目标：先是 `metadata.command = "ls /Users/Zhuanz/WorkBuddy/2026-09-26-05-21-06/"`，再是 `metadata.filepath = "…/popmart-slides.html"`，第三次触发"两次即判死"。

也就是说转交所需的数据桥早就在收，只是没用：模型想做对的事，桥不给路。现在改为拦截时先转交：

- 按 `p.tool.callID` 调 `GET /session/:id/message` 读回 tool part 的 `tool` 与 `state.input`（最多重试 3 次，避免刚发起时 part 尚未落盘）；
- `src/handoff.js` 按类别映射，以本次 `request.tools` 的 JSON schema 为权威，只填目标 schema 里真实存在的键，并把该工具的 `required` 全部填上才转交；
- 映射成功：`POST /session/:id/abort` 中止这一轮生成，该动作直接作为 `calls` 返回给 WorkBuddy，不再消耗第二次上游调用；
- 映射失败：拒绝并在反馈里点出工具名与原因（无对应外部工具 / 参数无法映射 / 读不回调用），**不再中止整个请求**，"两次即判死"已删除。

回归测试覆盖：`ls` 型 bash 必须转成 `Bash`；`filePath` 型必须转成 `Read` 且字段名正确；无外部对应物（如 `glob`）必须按名拒绝且请求照常完成、不触发 abort；转交成功时必须已 abort 生成本身。

已知未决：删掉次数上限后，模型若反复尝试原生动作，现在没有任何请求级上限，只能靠上游自身的步数限制——是否需要一个"多次拒绝后终止"的软上限，尚未决定。

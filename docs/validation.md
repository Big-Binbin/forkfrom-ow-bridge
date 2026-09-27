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

原因是 `ok` 只代表产出了格式合法的信封。请求结果记录 `calls`、`nativeAttempts`、`steps`、`handoff` 作为"最近一次调用"的观测，但不参与能力判定。曾据此标记过 `noAction` 并显示"可用 · 未产生动作"，该标记已移除（2026-09-26）：任务收尾时只回文本是正常行为，一次工作的结果不该出现在能力标签上。被拦截的原生审批请求原文存入 `status.json` 的 `lastPermission`（超长字符串截断）。两次 MiMo 实测请求各触发一次 `external_directory` 拦截，`metadata` 为 `{filepath, parentDir}`，路径可直接读取；但审批对象的字段名与 SDK 类型不一致（`type`、`title`、`pattern` 均不存在，OpenCode 自身日志记为 `permission`、`patterns`），因此记录改为保存原文而非挑选字段。两次拦截后模型都按纠正提示改回了合法的 `Read` 外部调用，说明纠正路径本身有效。把动作直接转交 WorkBuddy 仍需按 `callID` 反查工具名与参数。检测过程也会记录 `nativeAttempts`：一次探针在通过的同时试图原生执行 `bash echo test`。客户端已取消的请求不再记为成功。

仍然保留的判断：文本回复本身是合法结果（WorkBuddy 可能只是提问），因此 `calls: 0` 既不撤销模型资格，也不改变显示；把"原生被拦且无动作"升级为失败是单独的决策，尚未实施。


## 请求进行中可见（2026-09-26）

一次真实调用等待 5 分 06 秒后由用户取消：上游在第 92 秒报 `AI_APICallError: Cannot connect to API: The socket connection was closed unexpectedly`，OpenCode 在内部重试，桥全程只看到"没有返回"。取消后 `status.json` 未被写入，说明"取消不记成功"的修复生效，但失败与取消同样不可见——面板仍显示上一次成功结果。

现在桥会订阅 OpenCode 的 `GET /event`：`session.status` 的 `retry`（含 `attempt`、上游消息）、`busy`、`idle`，以及 `session.error`、`message.part.updated`、`permission.updated` 会按会话匹配到正在进行的请求，写入 `status.json` 的 `activity`（模型、已等待时长、距上次事件时长、重试次数、错误）。控制面板服务行显示"等待上游 · 第 N 次重试"，托盘首项显示"请求中：模型 · N 秒"，模型列表中的该模型标记为"请求中"。请求结束或取消时条目立即移除。

事件流只在存在进度回调时启动，按 1 秒退避重连；运行时停止时关闭。上游挂起时仍没有硬超时——这是 `82a9670` 的既定取舍，改用"可见的等待"而不是打断慢模型。


## 检测按"是否产生动作"判定（2026-09-26）

探针此前是 `tool_choice: "required"` + 单个 `bridge_probe` 工具 + 一句话，只验证传输与格式：模型被强制必须返回一个调用，因此必然通过。真实流量是 `tool_choice: auto`，此时"只回文本、不给动作"是合法返回。实测两轮真实请求正是该形态：16:19:36→16:21:14（98 秒）与 16:21:18→16:22:16（58 秒），均为 `calls: 0`、`nativeAttempts: 0`、`steps: 1`，界面表现为 WorkBuddy 无动作；同事后检查确认这两轮没有任何原生权限拦截，因此不是"被拦后断线"。

现在探针改为：5 个真实命名的外部工具（Read/Write/Bash/Glob/WebSearch，各带必填参数）、不传 `tool_choice`、指令要求读取一个带随机 token 的文件。判定标准是"是否返回携带该 token 的 Read 调用"：只回文本的模型按**仅对话**发布（工具关闭，界面显示"可用 · 仅对话"），不再作为失败撤下——文本回复只说明它承担不了动作，不说明它不可用（2026-09-26 修正）；返回与请求不符的调用仍记 `invalid_tool_call`。

超时也单独区分：探针此前依赖 `AbortSignal.any`，30 秒到点抛出的是 `AbortError`（"The operation was aborted"），被归为一般错误，界面因此不显示"检测超时"。现在探针自己持计时器，超时记为 `timeout`。探针在语义没命中时（`no_action`、动作与请求不符的 `probe_mismatch`）重试一次再判定，两次重试共用单个 60 秒预算，因此检测耗时不翻倍；格式不兼容与超时不重试。此举针对的是探针的随机性：Ling 3.0 Flash Fin Free 曾在一轮判为仅对话、下一轮直接通过。

检测上限由 30 秒放宽到 60 秒（`src/probe.js` 的 `PROBE_TIMEOUT`）：30 秒会撤下偏慢但仍可用的模型（Nemotron 3.5 Lightning 连续两次被撤），代价是模型卡住时启动检测最多多花 60 秒。降级为"仅对话"只允许发生在**格式不兼容**时（`invalid_model_output`、`invalid_tool_call`，或上游明确报 `tool_choice` 仅支持 auto）。模型坚持本地执行（`native_tool_activity`）属于另一类失败，不再被降级：否则 WorkBuddy 会拿到一个永远不可能产生动作的"可用 · 仅对话"模型（Ling 3.0 Flash Fin Free 实测即为此例）。检测后的分类与面板标签由测试锁定：`timeout`→检测超时、`quota`→额度不足、`rate_limit`→请求受限、`access`→访问受限，其余失败回落为不可用；只回文本、未产生动作的模型按"可用 · 仅对话"发布。


## 拦截即转交（2026-09-26）

Ling 3.0 Flash Fin Free 的一次真实调用在 195 秒后被判失败，错误是 `OpenCode repeatedly attempted native actions; execution was not approved`。原始审批记录显示它两次尝试的都是正确目标：先是 `metadata.command = "ls /Users/Zhuanz/WorkBuddy/2026-09-26-05-21-06/"`，再是 `metadata.filepath = "…/popmart-slides.html"`，第三次触发"两次即判死"。

也就是说转交所需的数据桥早就在收，只是没用：模型想做对的事，桥不给路。现在改为拦截时先转交：

- 按 `p.tool.callID` 调 `GET /session/:id/message` 读回 tool part 的 `tool` 与 `state.input`（最多重试 3 次，避免刚发起时 part 尚未落盘）；
- `src/handoff.js` 按类别映射，以本次 `request.tools` 的 JSON schema 为权威，只填目标 schema 里真实存在的键，并把该工具的 `required` 全部填上才转交；
- 映射成功：`POST /session/:id/abort` 中止这一轮生成，该动作直接作为 `calls` 返回给 WorkBuddy，不再消耗第二次上游调用；
- 映射失败：拒绝并在反馈里点出工具名与原因（无对应外部工具 / 参数无法映射 / 读不回调用），**不再中止整个请求**，"两次即判死"已删除。

回归测试覆盖：`ls` 型 bash 必须转成 `Bash`；`filePath` 型必须转成 `Read` 且字段名正确；无外部对应物（如 `glob`）必须按名拒绝且请求照常完成、不触发 abort；转交成功时必须已 abort 生成本身。

实测发现两处缺陷并修正：（1）拦截瞬间工具 part 仍是 `pending`、`input` 为空，参数实际在审批 `metadata` 里（`filepath`/`command`），现在 `handoffInput()` 用 metadata 兜底、真实参数优先；（2）响应落地前刚冒出的权限请求没被处理，其 tool part 被误判为"异常原生活动"并杀死整个请求，现在接受响应前会先处理一次仍挂起的权限请求（拒绝或转交），消除该竞态。

已知未决：删掉次数上限后，模型若反复尝试原生动作，现在没有任何请求级上限，只能靠上游自身的步数限制——是否需要一个"多次拒绝后终止"的软上限，尚未决定。


## 信封读取遗漏了 StructuredOutput 工具调用（2026-09-26）

Space Bunny 的一次真实调用被 WorkBuddy 报错 `Invalid model response envelope`。恢复的 sqlite 数据表明模型没有过错：它调用了 `StructuredOutput`，`state.status=completed`，`state.input` 里 `content` 与 `calls` 齐全；而整个会话里 `structured` 字段一次都没有出现。

原因是读取路径只认两个来源——`info.structured`，或拼接 `type: "text"` 的 part——却从不读 `StructuredOutput` 工具调用的 `input`，尽管同一段代码明确容忍该工具、纠正提示也明确要求模型用它返回信封。于是信封只落在工具调用里时 `text` 为空字符串，`JSON.parse` 抛错并被报成格式错误。该缺陷自 `23f1d94` 起一直存在，且是间歇性的：模型改用文本输出信封时不会触发。

现在信封按三个来源依次读取：`info.structured` → 已完成的 `StructuredOutput` 调用 `state.input` → 文本 part；三者皆空时报错直接说明"三者都为空"，不再是含糊的 `Invalid model response envelope`。回归测试用只含该工具 part、没有 `info.structured` 的响应锁定。


## 信封字段的空值不再判成格式错误（2026-09-26）

同一 bug 形态的另外两处：`{"content":null,"calls":[]}` 会落到 `Invalid model response envelope`；而 `{"content":"…","calls":null,"reasoning":"…"}` 只因为多带一个字段就不再满足归一化条件，同样硬失败。两者都是模型给出了合法语义却被报成格式错误，与上面那条遗漏 `StructuredOutput` 同源。

归一化改为"两个字段互相补默认值"：`calls` 为空（`null` 或缺失）且 `content` 是字符串时，`calls` 取 `[]`；`content` 为空且 `calls` 是数组时，`content` 取 `''`。因此"只有一边缺"的两种写法都被接受，无害的多余字段（如 `reasoning`）不再影响归一化；而两者都缺（`{}`）仍然非法——那等于什么都没说。防线保留在"工具调用被拍平进信封"这一种形状上：`{"content":"x","name":"write_file","arguments":{}}` 继续报错，否则那个动作会被当成纯文本静默丢掉（这条由已有测试锁定）。落空时的报错现在带上形状（如 `content=number, calls=array`），不再只有一句含糊的 `Invalid model response envelope`。


## 格式纠偏也覆盖坏掉的工具调用项（2026-09-26）

Space Bunny 的一轮请求在跑了约 5 分钟（Edit ×5、Bash ×3、Read 全部成功）之后以 `Invalid tool call` 失败：模型交出的 `calls` 数组里有一个元素不是对象。该错误此前不进入格式纠偏——`complete()` 只对 `invalid_model_output` 重试一次——于是一个笔误级别的偏差作废了整轮工作，用户必须重新催一次。会话随请求结束被删除，原始报文已无法恢复（留存的全部 `calls` 数组形状都是正常的）。

现在格式纠偏覆盖两类：整个信封不合法（`invalid_model_output`）与工具调用项不合法（`invalid_tool_call`），都只重试一次。原生动作（`native_tool_activity`）与输出截断（`output_truncated`）仍然不重试。回归测试锁定两点：第一次交 `{"calls":[null]}`、第二次交合法信封时必须成功；始终返回坏调用的假服务器仍以失败结束，且总共只请求两次。


## 格式兜底：失败时交给另一路模型重排（2026-09-26）

"出错就整轮作废"的根因是：桥对形状只有一条机械路径，遇到没预想到的写法就直接报错。现在加了一条**只在失败时触发、只触发一次**的镜像路径：

- **触发**：一次纠正重试之后信封仍不合法（`invalid_model_output` / `invalid_tool_call`）；或模型尝试原生动作、静态表映射不出来、随后又只回了文本（`meta.handoffMiss`）。
- **材料**：模型这一轮产出的全部内容——`info.structured`、所有 part（含 `StructuredOutput` 的 `state.input`、`status`、文本）、`finish`、`error.name`，加上被拦下的原生动作（name + 参数）与接收方工具清单（名称 + schema）。全部截断到有界长度（`src/repair.js`）。
- **执行**：另起一路会话，`agent: buddy-chat`（纯文本任务，不给工具），用 `REPAIR_SYSTEM` 要求它**只重排、不得发明**：不得凭空造动作、参数值或文件内容，材料里没有完整动作就返回空 `calls`。
- **校验**：结果拿回后仍走**接收方自己的规则**——信封用同一个 `decode`，动作用 `handoff.js` 新增的 `validateAction`（工具名必须在本次请求的清单里、参数必须落在 schema 内、必填必须齐全）。校验不过就丢弃，报**原始错误**，绝不循环。
- **不触发**：检测（`meta.probe`）从不兜底——探针必须测模型本身的能力，而不是翻译的功劳；额度/限流/访问受限/超时等上游失败也不触发。
- **留痕**：结果记入 `status.json` 的 `repaired: { envelope|action: { ok, model, ms, reason } }`，面板详情显示"这一轮由格式兜底救回"。没有这个字段就无法区分"真修好了"和"掩盖了问题"。

回归测试覆盖三种情形：不可读信封经翻译后必须成功（并确认翻译跑在独立会话、用的是 `buddy-chat`）；翻译给出清单外的工具名必须被拒且报原始错误；静态表映射不出的被拦动作必须被翻译成合法外部调用并带 `meta.handoff`。


## 参数解析失败的调用被误判成原生活动（2026-09-26）

Big Pickle 的一轮请求跑了约 3 分钟，最后以 `Unexpected native tool activity; response rejected` 失败，而记录显示 `nativeAttempts: 0`——桥一次审批都没看到。恢复的数据给出了原因：

```json
{"type":"tool","tool":"invalid","callID":"call_function_…",
 "state":{"status":"completed","input":{"tool":"StructuredOutput",
   "error":"Invalid input for tool StructuredOutput: JSON parsing failed: Text: {\"content\": \"数据全部核对完毕…\", \"invoke name=\"calls\": .\nError message: JSON Parse error: Unexpected EOF"}}}
```

模型把 Anthropic 风格的调用语法混进了信封（`invoke name="calls"`），JSON 提前结束；OpenCode 因此把这个调用记为工具名 `invalid`——**参数没解析成功，什么都没执行**。而"意外原生活动"那道检查只豁免 `StructuredOutput`，看到 `invalid` 就当作模型偷偷跑了原生工具，直接把整轮判死，还报了一个与真实原因无关的错误。

现在 `invalid` 与 `StructuredOutput` 一样被豁免；当响应里只有这种坏调用、没有可用文本时，报错改为如实说明"模型交的调用参数不是合法 JSON"（`invalid_model_output`），于是**纠正重试与新加的格式兜底都能接管**。注意 OpenCode 把原始文本截断在错误消息里（本次仅 249 字符），`calls` 的正文已丢失，所以这一类的兜底通常只能恢复文本内容，真正的动作要靠纠正重试让模型重发。回归测试锁定：坏调用必须走格式路径并交由兜底（且兜底收到的材料里含该解析错误），而不再报 `native_tool_activity`。


## 兜底是判断，不是填表（2026-09-26）

第一版兜底要求翻译为每个调用交出 `grounds`（逐字引用），桥再做子串核验。**这是错的**：那等于再给模型加一个必须精确遵守的形状，而当天所有故障恰恰都是模型没遵守形状（混入 `invoke` 语法、参数截断、`calls:[null]`、`tool:"invalid"`）——用一个新形状去修形状问题，是同一个错误的复制。该机制当天即被移除，文件甚至一度因提示词里的多行字符串而语法错误。

现在的分工回到"skill 是给模型的指导，不是程序契约"：

- **给知识**：`CLIENT_CONVENTIONS` 按本次请求里出现的工具选择性注入用法（`Bash` 是单条 POSIX 命令、`Read` 用绝对路径与 1-based 行号、`Edit` 的 `old_string` 必须精确匹配、`Write` 是整体覆盖……），并用 `CONVENTION_ALIASES` 认各家对同一工具的拼法差异（`write_file` / `Write` / `create_file` 同族）。**权威始终是本次请求发来的 schema**，知识块只是用法提示。
- **给材料**：新增外部对话尾部（最后 6 条消息、含工具结果与用户诉求、有界截断）。此前材料只有响应侧，任何推测都只能瞎猜。
- **让模型判断**：提示词要求"只提出对话确实支持的动作；材料不支持时宁可不给动作"，并明确告知"推测出来的调用会立刻在用户目录里执行、不会有人确认"。
- **硬校验仍是硬校验**：翻译结果照旧过 `decode` / `validateAction`——名字必须在本次清单里、参数必须过 schema。这与翻译是怎么得出的无关。

回归测试锁定：材料里必须真的带上外部对话尾部与工作链提示（并按别名命中对应工具的用法）。


## 无可推测时，让模型带着失败原因再说一次（2026-09-26）

兜底能翻案的只有"材料里确实有依据"的情况。当材料不足（典型是 OpenCode 把原始文本截断在错误消息里，`calls` 正文已丢），翻译既不该瞎编、也不该就地判死——现在改为**回到主模型再说一次**：

- 该轮只针对信封类失败（`invalid_model_output` / `invalid_tool_call`），且**最多一次**；
- 提示词带上真实失败原因（`error.message`），要求它**写具体**：完整的路径、完整的命令、要改的原文与替换文本；若本来就没有动作，就把结论写完整；
- 顺序是：纠正重试 → 兜底 → **带原因的显式重试** → 才报原始错误。因此一次请求最多三轮上游调用，且只发生在已经失败的路径上；
- **检测不做这一步**：探针仍然只做一次格式纠正，保证检测时长与判定不被额外轮次干扰（回归测试锁定）。

回归测试：主模型前两轮都交坏信封、且没有可用翻译模型时，必须发出第三轮并把 `Invalid model response envelope` 写进提示词，且第三轮的成功结果正常返回。


## 输出被截断也走同一条链（2026-09-26）

Big Pickle 的一轮跑了 4.4 分钟后报 `Model output was truncated`。实测数据证明 `info.finish === "length"` 是**活的**（库里共出现 14 次），所以截断不是偶发：每次都在判死整轮。该轮的 token 也说明了原因：`output 18591 + reasoning 13409`——**输出预算大半烧在推理上**，信封还没成形就到顶了。

现在截断检查从"直接抛"挪进了同一个 try/catch，与信封失败共用那条链（最多三轮、只在失败路径上）：

1. **纠正**：提示词按原因分叉——截断时要求"**写紧凑**：content 只写结论、calls 只放必要参数、推理压到最少"（而不是笼统的"格式错了"）；
2. **兜底**：材料里若留下半截信封，翻译可以补齐（依据来自对话与残片）；
3. **显式重试**：带上真实原因，要求紧凑重发。

先前那条"`info.finish` 可能是死代码"的怀疑**据此更正**：字段确实会被写入，只是极少（14 次里多数藏在 WAL）。检测仍不做兜底，探针最多两轮。


## 静默看门狗：五分钟没有任何输出就中止（2026-09-26）

一次真实请求卡在 `longcat-2.5-preview-free`（当日目录刷新后新出现的 preview 模型）上：会话在 01:27:56 建立、只打出 step 0 的一条 stream 起始行，此后 **7.7 分钟零写入**（WAL 的 mtime 停在 01:28:01），而请求状态一直是 `busy`。上游没有回包，桥却会一直等下去——因为按设计，节奏由客户端掌握，桥本来不设总时长上限。

现在加了一个**按静默判断**的看门狗（`SILENCE_LIMIT_MS = 300000`）：

- **只由内容事件刷新**：`message.part.updated`（文本或推理片段）与 `permission.updated` 才算"活着"。**`session.status` 心跳不算**——这正是这次卡死时面板 `sinceEventMs` 永远是 0 的原因（心跳在刷新它），也是看门狗必须用内容而不是状态来判断的原因。
- **只作用于能观测进度的请求**：探针没有事件流、且已有 60 秒自己的截止时间，因此不参与。
- **每一轮独立计时**：重试是新的一次请求，从零开始算，不是接着上一轮。
- **中止即报错**：抛出 `upstream_silent`（504，文案"上游 N 秒没有任何输出，已中止；请切换模型或重试"），随 `server.js` 的 `{error:{message,type,code}}` 交给 WorkBuddy，在其错误面板的 `Server detail` 里可见。
- **不撤下模型**：`upstream_silent` 已加入 `record()` 的"只记录、不改发布集合"名单。一次上游卡住是上游的事，不该让模型从客户端列表里消失。

回归测试：`/message` 永不返回时必须在看门狗窗口后以 `upstream_silent` 失败（测试把窗口压到 60 毫秒）；并且 `session.status` 心跳不刷新存活时间、而 `message.part.updated` 会。


## 转换指导与材料完整性（2026-09-27）

本次先查阅 Git 提交记录、本文历史故障记录、`docs/mimo-diagnostic.md`、既有测试，以及本机 WorkBuddy 留存的 `fb8e5f8e-9213-42f7-a4dc-4d955951bb95.jsonl`。运行时 session/message/part 表当前均为空，应用日志未保留完整历史响应，因此没有声称恢复了已删除的上游原始报文。

可复核证据：

- WorkBuddy 记录中有一次 Write 参数为 `filePath` 与 `content`，正文 46,649 字符；对应工具结果明确报 `file_path` 缺失。另一次 Write 正文为 30,554 字符。只统计字段及长度，不把用户正文提交到仓库。
- 将这些真实参数封装成现有 StructuredOutput part 形态，本地回放旧 `rawMaterial()`：`parts[0].input.calls[0]` 变成字符串 `[object]`。这是材料函数的深度裁剪复现，不等同于证明该历史调用当时经过了辅助模型。
- 工具清单转换只取 name/parameters，确实丢弃客户端的 description；此前通用 Skill 指导却固定要求 name/args，可能与实际定义不同。

修改：

- 保留客户端工具 description；指导明确以本次定义为准，通用用法只作补充。去掉 cmd→POSIX、apply_patch→普通 Edit 等不可靠的通用指导别名（未改动原生转交映射表）。
- 明确修复格式与等价字段映射、保留动作与内容，不把 Write 擅自换成 Edit；完整内容缺失时交回，不凭片段重写整个文件。执行、校验与审批归 WorkBuddy。
- 保留响应 parts 原形（含 state、input、error 等）、完整文本对话和调用 ID；去掉深度/字符串/历史条数裁剪，同时不再重复拼接 parts 中的 text。代价是辅助模型的输入可能更大，仍可能触及其上下文上限，本次不增加新的截断规则。
- 两种转换模式都可用简单的 `{"unrepairable":true}` 表示材料不足，不增加举证表格或其他必填元数据。沿用原有回退流程：信封模式回原模型最后一次纠正；动作模式保留原模型回复。
- 向信封转换提供实际 adapterError，便于定位失败原因。

验证：先写回归用例，旧实现出现 `[object]` 和无法辨别材料不足的失败；修改后 71 项测试通过。用真实历史 Write 参数在本地重新回放，46,649、30,554、197 字符的正文及参数均完整保留。测试夹具使用等长合成文本，不携带用户正文。

真实模型检查（隔离 OpenCode 1.18.32，`opencode/space-bunny-free`，合成数据，未执行任何外部工具）：

- filePath→file_path：10,725 ms，正确转换，保留相对路径和完整正文。
- 正文缺失：1,312 ms，返回 unrepairable，记录为 insufficient material，没有编造正文。

复核脚本与结果在工作目录 `work/repair-review/`，不依赖生产代理或写入 WorkBuddy 配置。以上验证不能替代完整幻灯片任务实测，也不证明所有免费模型均有相同表现。


## 补不了时携带具体诊断重发（2026-09-27）

WorkBuddy 历史记录显示 HTTP/流级格式错误会结束当前请求，需要用户点继续；工具参数错误则可以作为工具结果进入后续模型请求。因此，本次没有声称通过普通文本或 HTTP 错误就能要求 WorkBuddy 进程自动重发，也没有伪造工具调用来触发它。

辅助转换现在可在 unrepairable 中附带简短 reason，说明具体工具、缺失参数或源文本；转换校验失败也保留实际校验错误。代理在当前隔离会话内把这些诊断交回原模型，要求完整补发，而不是笼统要求再试。输出截断时缩短说明、保留完整参数，必要时只交付一个完整步骤。原生动作转换失败后，原本直接返回文本的路径也会在既有三轮上限内请求补发一次。没有新增超时或提高重试次数，检测不使用此兜底。

回归：先观察到具体缺失项未出现在重发请求、动作转换失败后只有一轮请求；修复后两者通过，完整测试共 72 项通过。既有原生工具拒绝、客户端取消、工具选择和截断纠正测试继续通过。本次是模拟后端的路径验证，未声称所有真实模型都能正确补全。

## 取消固定 OpenCode 版本（2026-09-27）

安装逻辑不再硬编码 1.18.32：优先复用应用目录内可运行且版本一致的安装（兼容原有按版本分目录的布局），其次复制发现的本机版本；首次需要下载时读取官方平台包的 npm `latest`。仍验证包名、版本字符串、官方 tarball 地址、SHA-512 与解包后实际版本。服务健康检查对比所启动二进制的实际版本，状态也记录实际版本；不在每次启动时强制升级。

75 项测试通过，新增覆盖旧缓存离线复用、非固定版本复制、latest 安装、二进制版本不符、非官方地址及哈希不符。版本/执行用例的合成二进制为 POSIX 脚本，Windows 下跳过这两项；没有声称完成 Windows 实机验证。

空目录实测：官方 `opencode-darwin-arm64/latest` 当时返回 1.18.32，成功下载、SHA-512 校验、解包、启动，健康接口报告 1.18.32 且 buddy-bridge agent 存在。目录为 `work/runtime-unpinned/`，测试后停止隔离服务，未改生产 WorkBuddy 配置。未来版本与代理协议的兼容性仍需观察，本次只验证当前官方版本。

## 2026-09-27 权限监控偶发失败

18:58:56 的本机状态记录显示 Ling 请求在 4154ms 后因 permission_monitor_error 结束，nativeAttempts=0。旧代码吞掉权限查询的底层异常，无法从历史记录确认此次查询失败的原始原因。

本地 HTTP 测试复现单次 ECONNRESET 导致整个推理被 Permission monitor unavailable 中止。修改后查询失败保留错误类型并继续现有轮询，不批准原生动作；回归覆盖断连及异常响应后正常完成、恢复后转交待审批动作、持续查询失败时客户端取消和推理连接错误仍传播。77 项测试通过。未重放用户的真实任务。

后续真实卡住请求确认 `/permission` 持续 HTTP 400：`Expected JSON value, got undefined at [0]["metadata"]["path"]`，并非一次短暂断连。运行中 OpenCode 的 `/doc` 声明 `permission.asked` / `permission.replied`，旧代理只识别 `permission.updated`。新增审批事件缓存，在列表查询失败时按 session 使用缓存处理转交/拒绝，成功回复和结束会话后清理。日志补充上游错误详情。78 项测试通过，包含持续 400 时从审批事件转交工具的场景；真实用户任务仍需重新继续验证。

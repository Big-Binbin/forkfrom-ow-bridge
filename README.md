# Buddy Bridge

跨平台托盘应用，通过隔离的 OpenCode 为 WorkBuddy 提供免费模型。0.2.0 使用 Electron 共用界面和现有 Node.js 代理核心。

## 下载

[下载最新版本](https://github.com/louchi1984-coder/buddy-bridge/releases/latest)

| 系统 | 安装包 |
|---|---|
| macOS 13+，Apple Silicon（M 系列） | [Mac ARM64 ZIP](https://github.com/louchi1984-coder/buddy-bridge/releases/latest/download/Buddy-Bridge-0.2.0-mac-arm64.zip) |
| Windows x64 | [Windows 安装程序](https://github.com/louchi1984-coder/buddy-bridge/releases/latest/download/Buddy-Bridge-0.2.0-win-x64.exe) |

请先安装 WorkBuddy。无需另装 Node.js 或 npm，应用按需从官方 npm 下载 OpenCode。安装包尚未签名／公证，系统可能提示未知开发者；Windows 安装与联调尚待实机验收。免费模型及额度由上游决定。

## 使用

- macOS：解压 `Buddy-Bridge-0.2.0-mac-arm64.zip`，双击 Buddy Bridge.app。
- Windows x64：运行 `Buddy-Bridge-0.2.0-win-x64.exe` 安装，再从桌面启动。Windows 包已构建，尚需实机验收。
- 首次启动自动准备 OpenCode、扫描免费模型、检测可用性；找到有效 WorkBuddy 配置后自动导入。
- macOS 保持使用 `~/.workbuddy/models.json`。Windows 自动识别默认配置、已保存位置和 WorkBuddy 配置目录环境变量。找不到时点击“导入 WorkBuddy”选择已有的 `models.json`；首次使用请先在 WorkBuddy 保存一个自定义模型。Windows 托盘菜单“选择 WorkBuddy 配置…”可更换位置，切换时清理旧文件中的本应用条目。不会在猜测的位置新建模型配置。
- 后续重新扫描或检测不会改 WorkBuddy；点击“导入 WorkBuddy”更新，界面会反馈结果。
- 关闭窗口继续在托盘运行；从托盘退出时删除本应用导入的模型，保留用户手动配置。
- 图片输入、推理声明和档位、输入输出上限读取 OpenCode 目录；工具转换能力通过模拟工具请求检测。
- 系统代理开关支持 Mac 和 Windows 的手动 HTTP/HTTPS 代理。

使用问题在抖音/视频号 @娄老师说的对

## 开发与打包

```sh
npm ci
npm test
npm run desktop
npm run build:mac
npm run build:win
```

运行核心服务：`npm start`。开发依赖 Node.js 22+；打包后的应用不要求用户另装 Node。

Windows ARM64：`npm run build:win:arm64`。Linux 的 `npm run build:linux` 为实验性入口，系统代理和 WorkBuddy 集成尚未验证。平台路径、架构、退出清理与实机验收见 [跨平台说明](docs/cross-platform.md)。

## 代理行为和限制

首次需要下载 OpenCode 时获取官方 npm 的 `latest` 版本；已有可用运行时直接复用，不在每次启动时强制升级。状态记录实际运行版本。使用隔离配置，不批准原生执行工具。WorkBuddy 负责执行外部工具；代理校验模型返回的调用名称、参数和格式。工具检测仅反映单次请求的结果，复杂流程可能仍失败。

所有可用模型在本地 API 中公开。只通过普通对话检测的模型关闭工具调用；不可用模型仍显示在列表，但不会提供给 WorkBuddy。检测提供多个外部工具且不强制调用：只回复文本、不产生动作的模型按**仅对话**发布（工具关闭，界面显示"可用 · 仅对话"），不会通过检测后浪费真实轮次；真实超时单独记为"检测超时"。语义没命中（只回文本、或动作与请求不符）会重试一次再判定，共用同一个 60 秒预算；格式不兼容与超时不重试。

模型名称是 `OC · ` 加 OpenCode 原名。导入和退出只修改 `buddyBridgeOwner` 属于本应用的条目，并在实际写入前备份；手动配置保留。配置路径默认 `~/.workbuddy/models.json`，Windows 的 `~` 对应用户目录。

图片接受 PNG/JPEG/WebP/GIF 的 base64 data URL，不接受远程图片链接或本地文件路径，整个请求上限 8 MB。图片作为附件转发，不调用 OpenCode 原生读取工具。

推理声明与可调档位分开处理。支持推理但无档位的模型也勾选推理，保持 OpenCode 默认模式，不提供开关或档位；有档位的填写 `supportedEfforts`，默认优先 medium。`reasoning_effort` 或 `reasoning.effort` 映射为 OpenCode variant，声明了可调档位的模型遇到不支持的档位时返回 400；支持推理但没有 variants 的模型兼容 WorkBuddy 默认附带的推理档位，使用 OpenCode 默认模式，不转发不存在的档位。不转发思考过程文本。

输入上限优先读取 `limit.input`，缺少时 WorkBuddy 配置回退 `limit.context`；详情仍分别展示上下文与独立输入上限。输出上限读取 `limit.output`。

代理兼容工具调用中的空/省略 content、纯文本回答省略 calls、OpenAI 风格 tool_calls 和 JSON 字符串参数；未知工具仍拒绝，已知工具缺少必填参数交给 WorkBuddy 校验。工具执行错误原样保留在外部会话中，由 WorkBuddy 决策；一次请求的格式/工具转换失败不会取消已检测通过的模型资格，额度、访问等可用性错误和重新检测结果仍生效。

格式不合格、坏调用项或输出截断会进入纠正与辅助转换流程。主模型每个请求最多三轮，检测不使用辅助转换；WorkBuddy 取消或断开请求时，代理停止 OpenCode 会话。当前另有连续 5 分钟未观测到内容事件时的静默中止机制。

支持 Chat Completions 和 SSE；SSE 会等待完整回复校验后输出，不是逐 token 实时流。
请求结果记录 `calls`、`nativeAttempts`、`steps`、`handoff`、`repaired` 作为"最近一次调用"的观测，但不参与能力判定（能力标签只由检测决定）。格式兜底只在失败时触发一次：把原模型响应、完整外部文本对话、真实工具描述与参数定义交给另一路模型转换。指导要求保留原动作、文件正文和命令，按客户端定义转换字段名；材料不足时返回 `{"unrepairable":true,"reason":"具体缺失项"}`。信封转换失败后，把具体诊断交回原模型作最后一次纠正；动作转换失败也在现有轮次内请求原模型补齐后重发。已有正常工具调用的参数错误仍交给 WorkBuddy 的工具反馈循环。检测过程从不兜底。转换材料不再截断字符串或嵌套对象，因此长对话会使用更多上下文，仍受辅助模型的上下文上限约束。被拦截的原生审批请求原文保存在 `status.json` 的 `lastPermission`，用于诊断模型为什么没有把动作交给 WorkBuddy。

请求进行中会订阅 OpenCode 的 `GET /event` 事件流，把当前模型、已等待时长和上游重试次数实时写入 `status.json` 的 `activity`；控制面板服务行与托盘据此显示"等待上游 · 第 N 次重试"，不再出现整轮无输出。请求结束或取消时条目立即移除。事件流按需启动，断开后按 1 秒退避重连，运行时停止时一并关闭。

被拦下的原生动作会**先尝试转交**：按 `callID` 反查该次工具调用，把 bash/read/write/edit/glob/grep/skill 类动作按本次 WorkBuddy 提供的工具 schema 映射成外部调用（`bash`→`Bash`；`read` 的 `filePath`→`file_path`；write/edit 连带 `content`、`old_string`、`new_string`；`glob`→`Glob` 或 `LS`；`grep`→`Grep`；`skill`→`Skill`；参数名候选由目标 schema 决定，未声明的键一律丢弃），映射成功就中止这一轮生成并直接作为 `calls` 返回，不再要求模型重述。映射失败才回退到拒绝并指出工具名；反复尝试不再中止整个请求。暂不支持 Responses API、Anthropic Messages API；`temperature`、`max_tokens` 等参数不透传。模型免费额度和可用性由上游控制。

## 验证

`npm test` 覆盖协议校验、导入与退出清理、目录能力映射、图片转发、推理档位和系统代理解析。Windows 目标已构建，但 Windows 上的安装、代理读取和 WorkBuddy 联调仍需实机验证。产物未做商用发布签名/公证。

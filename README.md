# Buddy Bridge

macOS 原生窗口与托盘应用：将本机 OpenCode 包装为 OpenAI Chat Completions 接口，供 WorkBuddy 使用。独立实现，未复制 OpenCode-Wrap 的代码。

## 启动与选择模型

1. 双击 `dist/Buddy Bridge.app`。打开模型控制面板，菜单栏出现分支图标，无终端窗口。关闭窗口后仍在托盘运行。托盘提供重新扫描、检测全部、导入 WorkBuddy 和模型状态，无需打开控制面板；读取或检测期间禁用冲突操作。
2. 首次启动自动准备 OpenCode 1.18.32：优先复制已有同版本运行时，否则从官方 npm 包下载并校验 SHA-512。无需 npm 或管理员权限。
3. 每次启动先清理上次导入的模型，自动读取免费目录、检测全部；整轮检测完成后，一次性将可用模型导入 `~/.workbuddy/models.json`。
4. 在 WorkBuddy 模型列表选择 `OC · …`。已打开的列表可能需要关闭后重新打开。

接口：`http://127.0.0.1:41980/v1`。连接地址和 Key 不在应用界面展示，自动同步即可使用。同步的模型使用完整 `/v1/chat/completions` 地址，无需手填。

只更新带 `buddyBridgeOwner: buddy-bridge-v1` 的条目；保留已有模型，发生 ID 冲突时保留用户条目。即使全部不可用，也会清空代理管理的条目（保留用户手动配置）。写入前备份原文件为 `models.json.buddy-bridge-时间戳.bak`，使用原子替换；解析错误或扫描结果为空时不覆盖。

主窗口支持模型详情、检测全部、读取免费模型和导入 WorkBuddy。可用模型排列在上方，待检测模型居中，不可用模型排列在下方；详情不提供单独检测按钮。模型行显示最近检测或实际调用的完整请求耗时（非首字延迟），失败请求标为失败耗时，尚无记录时显示 —。读取免费模型会清空界面列表、更新隔离 OpenCode 服务的目录，随后逐个加入模型并自动检测，不更改 WorkBuddy 配置。检测全部时，尚未完成的模型显示旋转图标，区分等待检测和检测中。每次启动自动扫描目录并顺序发送简短请求检测（单个最多 30 秒，会消耗少量免费额度）。状态区分未检测、可用、额度不足、限流、访问受限、超时和其他异常，展示原始错误和最近检测时间。再次读取、检测或实际调用只更新应用状态和 `/v1/models`，不写 WorkBuddy 配置。点击“导入 WorkBuddy”才用当前可用模型覆盖本应用管理的条目；即使未重新导入，不可用模型的缓存调用也会被代理拒绝。检测结果跨重启保留用于展示，每次启动重新验证。正常退出时自动清理本应用写入的模型，保留手动配置；关闭窗口仍在托盘运行，不算退出。强制杀进程或断电时无法执行退出清理，下次启动会清理残留。额度只根据明确的上游错误判断，不提供剩余额度数字。检测通过只证明简短对话可用，不代表复杂工具工作流已验证。

## 执行方式

WorkBuddy 的历史消息、工具定义、工具结果发送给 OpenCode 专用 agent，回复转换成 OpenAI `tool_calls`，由 WorkBuddy 执行。每轮 OpenCode 使用独立会话并完整重放外部历史，结束后删除临时会话。

使用官方 `permission: ask` 审批机制，代理不批准任何 OpenCode 本地操作。遇到本地操作申请，最多拒绝并纠正两次，然后终止请求。`StructuredOutput` 仅用于返回结构化数据，不执行客户端工具。工具名、必需参数及 `tool_choice` 在返回客户端前验证。

没有使用 Plan 作为最终后端：实测 Plan 会把外部写入请求也当成它禁止的操作。也没有使用全部 `deny`：MiMo 在该设置下返回 403。没有伪造请求头或修改 OpenCode 的鉴权机制。

## 当前范围

- macOS 当前架构构建；此处产物为 Apple Silicon，macOS 13+。
- 文本消息、工具调用和 SSE；不支持图片、Responses API、Anthropic Messages API。
- SSE 在完整回复校验后输出，有等待心跳；不是逐 token 实时显示。
- 任意复杂 WorkBuddy 工作流的兼容性仍需实际验证。`temperature`、`max_tokens` 等生成参数当前不透传。
- 免费模型和额度由上游控制。目录中的零价格不保证持续免费或随时可用。
- 双击启动，不自动开机启动。应用未做 Apple 公证；当前为本地临时签名。

运行时、日志、随机本地 Key 和状态位于 `~/Library/Application Support/Buddy Bridge/`。只监听 `127.0.0.1`，所有 HTTP 接口需 Bearer Key，并拒绝浏览器 Origin。客户端对话会发送给所选模型服务。

## 开发

无 npm 依赖。Node 22+，构建需要 macOS Swift 编译器。

```sh
npm test
NODE_BINARY=/path/to/standalone/node npm run build:mac
```

构建须使用独立的官方 Node 二进制，如 nvm 安装的版本；Homebrew 动态链接版本不能直接打包给其他电脑。

隔离运行：

```sh
BUDDY_DATA_DIR=/absolute/test-data BUDDY_NO_SYNC=1 BUDDY_PORT=41982 npm start
BUDDY_DATA_DIR=/absolute/test-data BUDDY_TEST_MODEL=opencode/space-bunny-free node scripts/smoke-live.mjs
```

托盘“重新同步”读取当前服务目录；重新启动代理会从上游刷新目录。

## 参考

- [OpenCode 权限](https://opencode.ai/docs/permissions/)
- [OpenCode 服务 API](https://opencode.ai/docs/server/)
- [OpenCode-Wrap](https://github.com/Fast-Editor/OpenCode-Wrap)
- [opencode-llm-proxy](https://github.com/KochC/opencode-llm-proxy)
- [opencode-bridge](https://github.com/crazyboy24/opencode-bridge)

实际 WorkBuddy 引擎的回归验证：

```sh
node scripts/smoke-workbuddy.mjs
BUDDY_TEST_MODEL=opencode/mimo-v2.6-flash-free node scripts/smoke-workbuddy.mjs
```

运行前先等待托盘显示“运行中”。测试只创建一个临时文件，限制工具为 Read/Write；检查真实工具结果和磁盘内容。详见 `docs/validation.md`。

WorkBuddy 使用与名称相同的短模型 ID（`OC · ` 加 OpenCode 目录原名），避免界面拼接完整上游 ID。代理将短 ID 映射到原始 OpenCode 模型；旧的完整 ID 调用仍受可用性检查。

模型名称直接读取 OpenCode 目录的 name，缺失时使用原始 ID，不维护固定简称表。

控制面板的“使用系统代理”开关默认关闭，选择保存在应用 settings.json。开启后读取 macOS 的 HTTP/HTTPS 代理，供 OpenCode 目录刷新和模型请求使用；本地连接始终绕过代理。切换会重新读取并检测，不改 WorkBuddy 配置。当前支持静态 HTTP/HTTPS 系统代理；仅 SOCKS 或 PAC 配置会明确报错。关闭表示应用不主动使用系统代理，不能绕过 VPN 的 TUN 接管。

如果结构化输出不兼容，代理会额外检测普通文字对话。成功时标记“可连接 · 仅对话”，不自动导入；模型详情可单独追加导入 WorkBuddy，不覆盖其他条目。此模式不强制 JSON 格式，不转换或执行任何工具调用，配置 supportsToolCall=false；收到工具请求时明确拒绝。正常退出仍清理这些模型。

# Buddy Bridge

macOS 托盘应用：将本机 OpenCode 包装为 OpenAI Chat Completions 接口，供 WorkBuddy 使用。独立实现，未复制 OpenCode-Wrap 的代码。

## 启动与选择模型

1. 双击 `dist/Buddy Bridge.app`。菜单栏出现分支图标，无终端窗口。
2. 首次启动自动准备 OpenCode 1.18.32：优先复制已有同版本运行时，否则从官方 npm 包下载并校验 SHA-512。无需 npm 或管理员权限。
3. 每次启动先更新 OpenCode 模型目录，根据价格字段筛选免费且支持工具的文本模型，再同步 `~/.workbuddy/models.json`。
4. 在 WorkBuddy 模型列表选择 `OC · …`。已打开的列表可能需要关闭后重新打开。

接口：`http://127.0.0.1:41980/v1`。托盘菜单可复制接口和本地 API Key。同步的模型使用完整 `/v1/chat/completions` 地址，无需手填。

只更新带 `buddyBridgeOwner: buddy-bridge-v1` 的条目；保留已有模型，发生 ID 冲突时保留用户条目。写入前备份原文件为 `models.json.buddy-bridge-时间戳.bak`，使用原子替换；解析错误或扫描结果为空时不覆盖。

菜单模型状态区分“未测试”“最近成功”“最近失败”。发现免费模型不代表其当前额度、服务状态或兼容性已验证。

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

# Buddy Bridge

跨平台托盘应用，通过隔离的 OpenCode 为 WorkBuddy 提供免费模型。0.2.0 使用 Electron 共用界面和现有 Node.js 代理核心。

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

OpenCode 固定为 1.18.32，使用隔离配置，不批准原生执行工具。WorkBuddy 负责执行外部工具；代理校验模型返回的调用名称、参数和格式。工具检测仅反映单次请求的结果，复杂流程可能仍失败。

所有可用模型在本地 API 中公开。只通过普通对话检测的模型关闭工具调用；不可用模型仍显示在列表，但不会提供给 WorkBuddy。

模型名称是 `OC · ` 加 OpenCode 原名。导入和退出只修改 `buddyBridgeOwner` 属于本应用的条目，并在实际写入前备份；手动配置保留。配置路径默认 `~/.workbuddy/models.json`，Windows 的 `~` 对应用户目录。

图片接受 PNG/JPEG/WebP/GIF 的 base64 data URL，不接受远程图片链接或本地文件路径，整个请求上限 8 MB。图片作为附件转发，不调用 OpenCode 原生读取工具。

推理声明与可调档位分开处理。支持推理但无档位的模型也勾选推理，保持 OpenCode 默认模式，不提供开关或档位；有档位的填写 `supportedEfforts`，默认优先 medium。`reasoning_effort` 或 `reasoning.effort` 映射为 OpenCode variant，声明了可调档位的模型遇到不支持的档位时返回 400；支持推理但没有 variants 的模型兼容 WorkBuddy 默认附带的推理档位，使用 OpenCode 默认模式，不转发不存在的档位。不转发思考过程文本。

输入上限优先读取 `limit.input`，缺少时 WorkBuddy 配置回退 `limit.context`；详情仍分别展示上下文与独立输入上限。输出上限读取 `limit.output`。

支持 Chat Completions 和 SSE；SSE 会等待完整回复校验后输出，不是逐 token 实时流。暂不支持 Responses API、Anthropic Messages API；`temperature`、`max_tokens` 等参数不透传。模型免费额度和可用性由上游控制。

## 验证

`npm test` 覆盖协议校验、导入与退出清理、目录能力映射、图片转发、推理档位和系统代理解析。Windows 目标已构建，但 Windows 上的安装、代理读取和 WorkBuddy 联调仍需实机验证。产物未做商用发布签名/公证。

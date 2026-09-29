# 跨平台说明（0.2.5）

> **Windows x64 portable 已经 Windows 实机验证；macOS（Apple Silicon）有实际使用验证。Windows ARM64 与 Linux 均未正式测试。下方旧版本记录保留历史验证边界，以最新发布记录为准。**

## 结构

- `desktop/main.cjs`：Electron 窗口、托盘、受限 IPC、后台服务生命周期。
- `desktop/preload.cjs`：仅暴露状态订阅和固定的管理操作；渲染进程不接触本地 API Key。
- `desktop/renderer.js`、`index.html`、`style.css`：Mac 和 Windows 共用的控制面板。
- `src/`：保留模型目录、能力声明、工具兼容性检测、图片转发、推理档位及 WorkBuddy 导入逻辑。
- `src/platform.js`：数据目录和 OpenCode 包名选择。
- `src/system-proxy.js`：macOS scutil 和 Windows 当前用户 Internet Settings 的手动 HTTP/HTTPS 代理。

后台使用 Electron 内置 Node 启动，不要求最终用户另装 Node。窗口启用 sandbox 和 contextIsolation、关闭 nodeIntegration，禁止导航和打开新窗口；管理请求仅在主进程发送。后台服务仍只监听本机，并要求随机 Key。

## 数据目录

| 系统 | 应用数据 | WorkBuddy 配置 |
|---|---|---|
| macOS | `~/Library/Application Support/Buddy Bridge` | `~/.workbuddy/models.json` |
| Windows | `%APPDATA%\Buddy Bridge` | `%USERPROFILE%\.workbuddy\models.json` |
| Linux（实验性） | `$XDG_CONFIG_HOME/Buddy Bridge` 或 `~/.config/Buddy Bridge` | `~/.workbuddy/models.json` |

OW Bridge 沿用旧版数据目录和内部应用标识，因此代理开关、运行时和本地 Key 可继续使用。自定义路径仍可通过 `BUDDY_DATA_DIR`、`BUDDY_MODELS_FILE` 指定。Windows x64 已有实机验证；其他架构和非默认配置路径仍需分别确认。

## 运行时安装与退出

启动时发现本地可用 OpenCode，并查询 npm 官方对应平台包的 `latest`；本地版本不低于最新版本时复用，旧版本则更新。查询失败时可复用本地版本，下载新版本失败目前仍会报错。下载后校验 SHA-512，只提取指定二进制文件；Windows 使用 opencode.exe。解压采用 Node tar，不依赖系统 curl/tar。

正常退出通过 IPC 请求后台清理本应用导入的 WorkBuddy 模型，再结束 OpenCode。后台与 Electron 失去 IPC 连接时也会执行清理。强杀或断电无法保证退出清理，下一次启动会清除旧的受管理配置。测试覆盖退出发生在检测中的场景。

Windows 支持手动系统代理，包括统一端口和按协议指定端口；不支持仅 PAC/SOCKS。Linux 构建脚本预留，但系统代理读取和 WorkBuddy 实机集成尚未支持/验证。

## 构建

```sh
npm ci
npm test
npm run desktop
npm run build:mac
npm run build:win
```

额外目标：`npm run build:win:arm64`；Linux 实验目标：`npm run build:linux`。产物输出到 `release/`。GitHub Actions 工作流提供 macOS 和 Windows 原生 runner 构建及测试，需在仓库实际运行后才能证明通过。

`macos/App.swift` 与 `scripts/build-mac.sh` 是迁移前的原生界面参考，不再作为 0.2.0 发布入口。

## 早期版本验证记录（历史）

- 本机核心与平台单元/生命周期测试通过。
- 本机完成 OpenCode 自动下载、校验、解压和版本验证。
- macOS 应用及 Windows x64 NSIS 安装包已在当前 Mac 构建成功。
- Mac 已实际验证自动扫描/检测/导入、手动导入反馈、模型详情及点击外部收起、正常退出后受管理模型为 0 且后台/OpenCode 子进程消失。
- 已核对 npm Windows x64 包含 bin/opencode.exe，与安装器路径一致。
- Windows 安装包构建成功不等于 Windows 上已安装或已验证 WorkBuddy 联调。本机无 Windows 实机/虚拟机，仍需完成下列实机验收。
- macOS 未做 Apple 公证；Windows 未配置发布者签名。

Windows 验收：安装并双击启动 → 自动准备 OpenCode → 扫描和检测 → 导入后在 WorkBuddy 检查名称/能力 → 启用系统代理 → 关闭窗口后托盘可操作 → 退出后受管理模型删除、后台进程退出 → 中文用户名路径下重试以上流程。

## v0.2.2 发布检查（2026-09-28）

macOS 本机 86 项自动化测试通过，Mac 发布包内代码与当前源码核对一致。README 展示本机实际运行截图。

Windows CI 首次运行曾遇到状态文件原子替换的 `EPERM` 文件占用错误，导致生命周期测试超时。该偶发问题尚未修复，实机验收需重点检查状态刷新、导入和退出清理；重跑成功也不等于问题已经消失。所有非 macOS 版本仍标为未正式测试。

## v0.2.3 Windows 修复与验证（2026-09-29）

- Windows x64 portable 已由用户确认验证；Windows 工作区的 Codex 测试记录为 93 项通过、0 失败、0 跳过。
- 实机交接记录：核心服务与 Electron GUI 启动，扫描模型、导入隔离配置，5 个模型通过本地 API 返回 HTTP 200。当前记录不等于所有 WorkBuddy 工作流均已逐项验收。
- 文件替换遇到 EPERM/EACCES/EBUSY 时有限重试；不会因此保证长期占用也能成功。
- 增加 Windows OpenCode 可执行文件发现，拒绝将 .cmd/.bat/.ps1 当作二进制，避免重写已有效的同版本运行时。
- 旧 OpenCode 1.17.8 曾被上游以 HTTP 426 拒绝；启动查询官方 latest 并更新旧运行时。查询失败可用本地版本，但下载新版本失败尚不回退。
- 兼容 BOM 配置，按五分钟时限清理残留同步锁；尚未校验持锁进程。
- 本次发布 Windows x64 portable ZIP，不需要 NSIS 安装器。其他平台继续提供 v0.2.2 历史包，Windows ARM64/Linux 保留未正式测试标记。

## v0.2.4 Mac 签名修复（2026-09-29）

旧 v0.2.2 Mac ZIP 与 GitHub 哈希一致，但 codesign 深度校验报错 `code has no resources but signature indicates they must be present`。旧配置 `identity: null` 跳过应用签名，留下 Electron 可执行文件的 linker 临时签名。

改为 electron-builder 的 `identity: "-"`，使用 ad-hoc 签名处理应用与嵌套组件；未启用 hardened runtime 和公证，不需要 Apple 证书。Mac 构建命令现在会解压最终 ZIP 并执行 `codesign --verify --deep --strict`，失败则构建命令失败。临时签名不代表 Gatekeeper 信任，下载后的首次打开办法见 README。

本次只发布 Mac ARM64 v0.2.4 包；Windows x64 继续推荐已验证的 v0.2.3 portable，Windows ARM64/Linux 仍未正式测试。

本次验证：93 项自动测试通过；最终 ZIP 解压后的深度严格签名校验通过；签名后的 Electron 44.4.5 ARM64 运行时启动通过。Gatekeeper 评估仍为 rejected（未公证），未声称通过下载隔离环境的默认放行，也未重新执行完整 WorkBuddy 工作流。

## v0.2.5 Windows 首次下载（2026-09-29）

同步 Windows Codex 的 runtime/main 修改和 undici 依赖：版本查询与下载使用系统代理，官方 npm 失败时尝试 npmmirror。首次默认自动读取代理仅对 Windows 开启；没有可用配置时直连，已明确保存的开关优先，Mac 默认行为不变。启动时读取一次的代理配置也交给 OpenCode。

保留 SHA-512 和版本校验；官方元数据可用时，镜像 tarball 必须匹配官方校验值。若元数据本身来自第三方镜像，则信任该镜像提供的校验值。未加入“代理失效后绕过代理直连”策略，未修复任务栏图标。仅 PAC/SOCKS 仍不支持。

原 Windows 修改记录为 94 项测试通过；补充官方元数据成功、tarball 转镜像，以及镜像字节不匹配拒绝安装的测试。v0.2.5 发布 Windows x64 portable，Mac 保留已修复签名的 v0.2.4，Windows ARM64/Linux 仍未正式测试。

# 跨平台说明（0.2.2）

> **仅 macOS（Apple Silicon）经过实际使用测试。Windows x64 / ARM64 与 Linux 均未正式测试，构建成功不等于实机可用。**

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

OW Bridge 沿用旧版数据目录和内部应用标识，因此代理开关、运行时和本地 Key 可继续使用。自定义路径仍可通过 `BUDDY_DATA_DIR`、`BUDDY_MODELS_FILE` 指定。Windows WorkBuddy 路径与真实客户端读取行为仍需 Windows 实机确认。

## 运行时安装与退出

OpenCode 优先复用应用目录内已有的可用版本，或复制发现的本机版本；需要下载时从 npm 官方对应平台包的 `latest` 获取，不固定版本，也不在每次启动时强制升级。下载后校验 SHA-512，只提取指定二进制文件；Windows 使用 opencode.exe。解压采用 Node tar，不依赖系统 curl/tar。

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

## 验证边界

- 本机核心与平台单元/生命周期测试通过。
- 本机完成 OpenCode 自动下载、校验、解压和版本验证。
- macOS 应用及 Windows x64 NSIS 安装包已在当前 Mac 构建成功。
- Mac 已实际验证自动扫描/检测/导入、手动导入反馈、模型详情及点击外部收起、正常退出后受管理模型为 0 且后台/OpenCode 子进程消失。
- 已核对 npm Windows x64 包含 bin/opencode.exe，与安装器路径一致。
- Windows 安装包构建成功不等于 Windows 上已安装或已验证 WorkBuddy 联调。本机无 Windows 实机/虚拟机，仍需完成下列实机验收。
- macOS 未做 Apple 公证；Windows 未配置发布者签名。

Windows 验收：安装并双击启动 → 自动准备 OpenCode → 扫描和检测 → 导入后在 WorkBuddy 检查名称/能力 → 启用系统代理 → 关闭窗口后托盘可操作 → 退出后受管理模型删除、后台进程退出 → 中文用户名路径下重试以上流程。

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

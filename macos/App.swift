import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    let dataURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Buddy Bridge")
    var item: NSStatusItem!
    var process: Process?
    var timer: Timer?
    var status: [String: Any] = [:]
    var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second double-click activates the existing menu application.
        let peers = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.buddy.bridge")
        if peers.contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { NSApp.terminate(nil); return }
        try? FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Buddy Bridge")
        launch()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshMenu() }
        refreshMenu()
    }
    func launch() {
        guard process?.isRunning != true, let resources = Bundle.main.resourceURL else { return }
        let child = Process()
        child.executableURL = resources.appendingPathComponent("node")
        child.arguments = [resources.appendingPathComponent("src/main.js").path]
        child.currentDirectoryURL = dataURL
        var env = ProcessInfo.processInfo.environment
        env["BUDDY_DATA_DIR"] = dataURL.path
        child.environment = env
        let logURL = dataURL.appendingPathComponent("app.log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let file = try? FileHandle(forWritingTo: logURL) { _ = try? file.seekToEnd(); child.standardOutput = file; child.standardError = file }
        child.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self else { return }
            if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
            else { self.refreshMenu() }
        } }
        do { try child.run(); process = child }
        catch { status = ["message": "启动失败：\(error.localizedDescription)", "phase": "error"] }
    }
    func add(_ menu: NSMenu, _ title: String, _ action: Selector?) {
        let row = NSMenuItem(title: title, action: action, keyEquivalent: "")
        row.target = self; menu.addItem(row)
    }
    func refreshMenu() {
        if let bytes = try? Data(contentsOf: dataURL.appendingPathComponent("status.json")),
           let decoded = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] { status = decoded }
        let phase = status["phase"] as? String ?? "starting"
        item.button?.title = phase == "ready" ? "" : phase == "error" ? "!" : "·"
        item.button?.toolTip = status["message"] as? String ?? "Buddy Bridge"
        let menu = NSMenu()
        add(menu, "Buddy Bridge", nil)
        add(menu, status["message"] as? String ?? "正在启动…", nil)
        if let result = status["lastRequest"] as? [String: Any], result["ok"] as? Bool == false {
            add(menu, "最近请求失败：\((result["error"] as? String ?? "未知错误").prefix(70))", nil)
        }
        menu.addItem(.separator())
        add(menu, "重新同步模型到 WorkBuddy", #selector(refreshModels))
        add(menu, "复制接口地址", #selector(copyEndpoint))
        add(menu, "复制本地 API Key", #selector(copyKey))
        let modelsMenu = NSMenu()
        let results = status["modelResults"] as? [String: [String: Any]] ?? [:]
        for model in status["models"] as? [[String: Any]] ?? [] {
            let result = results[model["id"] as? String ?? ""]
            let label = result == nil ? "未测试" : result?["ok"] as? Bool == true ? "最近成功" : "最近失败"
            add(modelsMenu, "\(model["name"] as? String ?? "") · \(label)", nil)
        }
        let modelsItem = NSMenuItem(title: "免费模型列表", action: nil, keyEquivalent: "")
        modelsItem.submenu = modelsMenu; menu.addItem(modelsItem)
        menu.addItem(.separator())
        add(menu, "打开 WorkBuddy", #selector(openWorkBuddy))
        add(menu, "查看日志与状态文件", #selector(openLogs))
        add(menu, "重启代理并刷新免费模型", #selector(restart))
        add(menu, "退出", #selector(quit))
        item.menu = menu
    }
    @objc func refreshModels() {
        guard let key = try? String(contentsOf: dataURL.appendingPathComponent("api-key"), encoding: .utf8) else { return }
        let endpoint = status["endpoint"] as? String ?? "http://127.0.0.1:41980/v1"
        let base = String(endpoint.dropLast(3))
        guard let url = URL(string: base + "/admin/refresh") else { return }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 60
        request.setValue("Bearer \(key.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                    let alert = NSAlert(); alert.messageText = "模型刷新失败"; alert.informativeText = error?.localizedDescription ?? "请查看日志，原有配置已保留。"; alert.runModal()
                }
                self?.refreshMenu()
            }
        }.resume()
    }
    func copy(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
    @objc func copyEndpoint() { copy(status["endpoint"] as? String ?? "http://127.0.0.1:41980/v1") }
    @objc func copyKey() { if let s = try? String(contentsOf: dataURL.appendingPathComponent("api-key"), encoding: .utf8) { copy(s) } }
    @objc func openLogs() { NSWorkspace.shared.open(dataURL) }
    @objc func openWorkBuddy() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/WorkBuddy.app")) }
    @objc func restart() {
        if let child = process, child.isRunning {
            child.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.process = nil; self?.launch() } }
            child.terminate()
        } else { process = nil; launch() }
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        timer?.invalidate(); quitting = true
        if let child = process, child.isRunning {
            child.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { NSApp.reply(toApplicationShouldTerminate: true) }
            return .terminateLater
        }
        return .terminateNow
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

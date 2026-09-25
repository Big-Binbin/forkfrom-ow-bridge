import Cocoa
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    let dataURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Buddy Bridge")
    var item: NSStatusItem!
    var process: Process?
    var timer: Timer?
    @Published var status: [String: Any] = [:]
    var window: NSWindow?
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
        showWindow()
    }
    @objc func showWindow() {
        if window == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 710), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            panel.title = "Buddy Bridge"
            panel.minSize = NSSize(width: 880, height: 620)
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: Dashboard(app: self))
            panel.center()
            window = panel
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func probeModel(_ model: String?) {
        guard let key = try? String(contentsOf: dataURL.appendingPathComponent("api-key"), encoding: .utf8),
              let endpoint = status["endpoint"] as? String,
              let url = URL(string: String(endpoint.dropLast(3)) + "/admin/probe") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: model.map { ["model": $0] } ?? [:])
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                if error != nil || (response as? HTTPURLResponse)?.statusCode != 202 {
                    let alert = NSAlert(); alert.messageText = "暂时无法检测"; alert.informativeText = error?.localizedDescription ?? "请等待服务启动后重试。"; alert.runModal()
                }
                self?.refreshMenu()
            }
        }.resume()
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
           let decoded = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            if NSDictionary(dictionary: decoded).isEqual(to: status) && item.menu != nil { return }
            status = decoded
        }
        let phase = status["phase"] as? String ?? "starting"
        item.button?.title = phase == "ready" ? "" : phase == "error" ? "!" : "·"
        item.button?.toolTip = status["message"] as? String ?? "Buddy Bridge"
        let menu = NSMenu()
        add(menu, "打开控制面板", #selector(showWindow))
        add(menu, status["message"] as? String ?? "正在启动…", nil)
        if let result = status["lastRequest"] as? [String: Any], result["ok"] as? Bool == false {
            add(menu, "最近请求失败：\((result["error"] as? String ?? "未知错误").prefix(70))", nil)
        }
        menu.addItem(.separator())
        add(menu, "重新同步模型到 WorkBuddy", #selector(refreshModels))
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
struct Dashboard: View {
    @ObservedObject var app: AppDelegate
    @State private var search = ""
    @State private var selected: String?
    var models: [[String: Any]] { app.status["models"] as? [[String: Any]] ?? [] }
    var results: [String: [String: Any]] { app.status["modelResults"] as? [String: [String: Any]] ?? [:] }
    var probe: [String: Any] { app.status["probe"] as? [String: Any] ?? [:] }
    var ready: Bool { app.status["phase"] as? String == "ready" }
    var checking: Bool { probe["running"] as? Bool == true }
    let accent = Color(red: 0.15, green: 0.43, blue: 0.36)
    func label(_ id: String) -> String {
        if checking && probe["current"] as? String == id { return "检测中" }
        guard let r = results[id] else { return "未检测" }
        switch r["category"] as? String {
        case "available": return (app.status["availableModels"] as? [String] ?? []).contains(id) ? "最近可用" : "待复测"
        case "quota": return "额度不足"
        case "rate_limit": return "请求限流"
        case "access": return "访问受限"
        case "timeout": return "检测超时"
        case "error": return "调用异常"
        default: return r["ok"] as? Bool == true ? "最近可用" : "调用异常"
        }
    }
    func tint(_ id: String) -> Color {
        if label(id) == "最近可用" { return accent }
        if label(id) == "未检测" || label(id) == "检测中" { return .secondary }
        return .orange
    }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 30, weight: .semibold)).foregroundColor(accent)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Buddy Bridge").font(.system(size: 20, weight: .semibold))
                    Text("让 WorkBuddy 连接 OpenCode").font(.caption).foregroundColor(.secondary)
                }
                Label("模型与服务", systemImage: "square.grid.2x2.fill").font(.headline).foregroundColor(accent)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(accent.opacity(0.09)).cornerRadius(9)
                Spacer()
                Button("打开 WorkBuddy", action: app.openWorkBuddy)
                Button("日志与状态文件", action: app.openLogs)
                Text("关闭窗口后，代理仍在托盘运行。\n退出请使用托盘菜单。").font(.caption).foregroundColor(.secondary).lineSpacing(4)
            }.padding(24).frame(width: 205).frame(maxHeight: .infinity).background(Color(nsColor: .controlBackgroundColor))
            Divider()
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("免费模型").font(.system(size: 28, weight: .semibold))
                        Text("自动发现，保留每一个模型的状态。").foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("重新扫描", action: app.restart).disabled(checking || !ready)
                    Button(checking ? "正在检测…" : "检测全部") { app.probeModel(nil) }.disabled(!ready || checking).buttonStyle(.borderedProminent).tint(accent)
                }
                HStack(spacing: 10) {
                    if !ready && app.status["phase"] as? String != "error" { ProgressView().controlSize(.small) }
                    else { Circle().fill(ready ? accent : Color.orange).frame(width: 8, height: 8) }
                    Text(app.status["message"] as? String ?? "正在准备运行环境…").font(.callout)
                    Spacer()
                    if app.status["phase"] as? String == "error" { Button("重试", action: app.restart) }
                }.padding(12).background(accent.opacity(0.07)).cornerRadius(9)
                HStack(spacing: 22) {
                    metric("已发现", models.count)
                    metric("最近可用", models.filter { label($0["id"] as? String ?? "") == "最近可用" }.count)
                    metric("待检测", models.filter { results[$0["id"] as? String ?? ""] == nil }.count)
                    Spacer()
                    TextField("搜索名称或模型 ID", text: $search).textFieldStyle(.roundedBorder).frame(width: 210)
                }
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(models.filter { search.isEmpty || "\($0["name"] ?? "") \($0["id"] ?? "")".localizedCaseInsensitiveContains(search) }, id: \.selfID) { model in
                            let id = model["id"] as? String ?? ""
                            Button { selected = id } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: "cube.transparent").font(.title2).foregroundColor(accent)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(model["name"] as? String ?? id).font(.system(size: 14, weight: .medium)).foregroundColor(.primary)
                                    }
                                    Spacer()
                                    Text(label(id)).font(.caption).foregroundColor(tint(id)).padding(.horizontal, 9).padding(.vertical, 5).background(tint(id).opacity(0.1)).cornerRadius(6)
                                }.padding(13).background(selected == id ? accent.opacity(0.08) : Color(nsColor: .controlBackgroundColor)).cornerRadius(9)
                            }.buttonStyle(.plain)
                        }
                    }
                    if models.isEmpty { Text("正在安装或扫描模型，完成后将在这里显示。").foregroundColor(.secondary).padding(.vertical, 50) }
                }
                if let id = selected {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(id).font(.system(size: 12, weight: .medium, design: .monospaced)).textSelection(.enabled)
                            Spacer()
                            Button("检测此模型") { app.probeModel(id) }.disabled(!ready || checking)
                        }
                        if let error = results[id]?["error"] as? String { Text(error).font(.caption).foregroundColor(.orange).textSelection(.enabled).lineLimit(4) }
                        Text("最近检测：" + (results[id]?["time"] as? String ?? "尚未检测")).font(.caption).foregroundColor(.secondary)
                    }.padding(12).background(Color(nsColor: .controlBackgroundColor)).cornerRadius(9)
                }
                let sync = app.status["sync"] as? [String: Any]
                Text(sync?["error"] as? String ?? (ready ? "仅检测通过的模型同步到 WorkBuddy · 选择 OC · 开头的模型" : "准备完成后将自动同步到 WorkBuddy"))
                    .font(.caption).foregroundColor(sync?["error"] != nil ? .orange : .secondary)
                Text("启动后自动发送简短请求检测，会使用少量免费额度，不代表工具流程已验证。不可用模型仅在本窗口保留，不供 WorkBuddy 使用；剩余额度暂不可查询。").font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
        }.frame(minWidth: 880, minHeight: 620)
    }
    func metric(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text(String(value)).font(.system(size: 23, weight: .semibold, design: .rounded)); Text(title).font(.caption).foregroundColor(.secondary) }
    }
}
extension Dictionary where Key == String, Value == Any {
    var selfID: String { self["id"] as? String ?? "" }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

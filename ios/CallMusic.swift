import Foundation
import AVFoundation
import os

/// 电话里放歌 · iOS 原生版(参考实现)。和 web/phone-music-player.js 是同一套规矩:
///   AI 调 phone_music → 服务器把指令挂在 /api/music/pending 的 music 上 → 你的通话引擎每 2.5 秒问一次时交给 handle(_:)
///   AI 在说话 → 歌压到三成;用户在说话 → 压到两成;快到点的两秒淡出;一首放完接下一首(定了秒数就循环到点)
///   用户说「停」= 停,「暂停」= 暂停,暂停着说「继续」= 接着放;暂停以后用户开口说完、两边静下来 1.5 秒,也自己接着放
///
/// 歌和 AI 的声音走同一个 AVAudioEngine(开了 voice processing 的那个),iPhone 打电话那套回声消除会把歌从麦里减掉,
/// 所以放歌时麦照开。状态回报服务器用 reportState("seq:playing|idle|her",her = 用户停的)。
///
/// 怎么接(你的通话引擎里):
///   1. 引擎建好 / 每次重搭后:music.attach(engine);要停引擎前:music.suspend();重搭好:music.resumeAfterRebuild()
///   2. 问 /api/music/pending 时带上 ms=music.reportState;回来的 json["music"] 交给 music.handle(_:)
///   3. 每 1/4 秒:music.tick(ai:user:userSince:quiet:)
///   4. 识别出用户的一句话:music.userSaid(text);屏幕按钮:music.userAction("pause" / "resume" / "stop")
///   5. 挂断:music.reset()
/// 下载歌要带口令:设好 baseURL 和 token(或者自己给 makeRequest)。
@MainActor
final class CallMusic {
    struct Track { let title: String; let url: String }

    /// 状态变了(给界面用):["type":"music","state":"playing|paused|idle","title":…,"pos":…,"dur":…]
    var onEvent: (([String: Any]) -> Void)?
    /// 要提示用户的一句话(「音乐没放出来」「音乐停了」)
    var onNote: ((String) -> Void)?

    /// 服务器地址和访问口令。曲目 url 是相对路径(/media/library/… 或 /api/qq/…)
    var baseURL: URL?
    var token: String?
    /// 想自己管认证(比如用你 App 已有的登录)就给这个
    var makeRequest: ((String) async -> URLRequest?)?

    private static let log = Logger(subsystem: "phone-music", category: "CallMusic")

    private weak var engine: AVAudioEngine?
    private let player = AVAudioPlayerNode()
    private let mixer = AVAudioMixerNode()

    private(set) var seqDone = 0
    private(set) var state = "idle"
    private(set) var on = false
    private(set) var paused = false
    private var list: [Track] = []
    private var idx = 0, errs = 0
    private var base: Float = 0.6
    private var seconds: Double = 0
    private var deadline: Date?
    private var leftMs: Double = 0
    private var pausedAtMs: Double = 0
    private var pauseArmed = false
    private var quietSince: Double = 0
    private var token_ = 0
    private var file: AVAudioFile?
    private var trackStart: Double = 0     // 这一段从歌的第几秒开始放的
    private var heldPos: Double = 0        // 引擎重搭 / 暂停时记下的位置
    private var cur: Float = 0
    private var cache: [String: URL] = [:]
    private lazy var selfBox = WeakBox(self)

    private static let stopRe = try! NSRegularExpression(pattern: "^\\s*(?:停|停下|停停|别放了|不要放了|不放了|关掉|关了|关掉音乐|把歌关了|stop|stop it|stop the music|turn it off)[\\s。.!！~～,，]*$", options: [.caseInsensitive])
    private static let pauseRe = try! NSRegularExpression(pattern: "^\\s*(?:暂停|暂停一下|先暂停|停一下|先停一下|pause|pause it)[\\s。.!！~～,，]*$", options: [.caseInsensitive])
    private static let resumeRe = try! NSRegularExpression(pattern: "^\\s*(?:继续|继续放|继续吧|接着放|接着放吧|放吧|resume|continue|play)[\\s。.!！~～,，]*$", options: [.caseInsensitive])
    private static func hit(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    var title: String { list.isEmpty ? "" : list[idx % list.count].title }
    /// 播放器接没接到引擎上。没接的时候碰它(stop / 音量 / lastRenderTime)AVFAudio 会直接抛异常崩掉
    private var attached: Bool { player.engine != nil && mixer.engine != nil }
    private func setVol(_ v: Float) { if attached { mixer.outputVolume = v } }
    var reportState: String { "\(seqDone):\(state)" }

    // MARK: 接到引擎上(每次引擎重搭都来一次)

    func attach(_ e: AVAudioEngine) {
        engine = e
        if player.engine == nil { e.attach(player); e.attach(mixer) }
        e.connect(mixer, to: e.mainMixerNode, format: nil)
        setVol(cur)
    }

    /// 引擎要停(换声音设备):记下放到哪儿
    func suspend() {
        guard on || paused else { return }
        heldPos = position()
        token_ += 1
        if attached { player.stop() }
    }

    /// 引擎重搭好了:从原处接着放
    func resumeAfterRebuild() {
        if on { playTrack(from: heldPos) }
        else if paused, let f = file, let e = engine {   // 暂停着的:排好位置,等用户说继续
            e.connect(player, to: mixer, format: f.processingFormat)
            schedule(f, from: heldPos, token: token_)
        }
    }

    func reset() {
        stop(nil, quiet: true)
        seqDone = 0; state = "idle"
        for (_, u) in cache { try? FileManager.default.removeItem(at: u) }
        cache = [:]
    }

    // MARK: 指令

    func handle(_ cmd: [String: Any]) {
        let seq = (cmd["seq"] as? NSNumber)?.intValue ?? 0
        guard seq > seqDone else { return }
        seqDone = seq
        let action = cmd["action"] as? String ?? ""
        if action == "stop" { stop("ai"); return }
        guard action == "play", let raw = cmd["list"] as? [[String: Any]], !raw.isEmpty else { return }
        if let age = (cmd["age_ms"] as? NSNumber)?.doubleValue, age > 120000 { return }   // 过时的指令不放
        stop(nil, quiet: true)
        list = raw.compactMap { d in
            guard let u = d["url"] as? String, !u.isEmpty else { return nil }
            return Track(title: d["title"] as? String ?? "", url: u)
        }
        guard !list.isEmpty else { return }
        let v = Float((cmd["volume"] as? NSNumber)?.doubleValue ?? 0.6)
        base = v > 0 ? min(1, v) : 0.6
        seconds = (cmd["seconds"] as? NSNumber)?.doubleValue ?? 0
        deadline = seconds > 0 ? Date().addingTimeInterval(seconds) : nil
        idx = 0; errs = 0; on = true; paused = false; state = "playing"
        playTrack(from: 0)
    }

    /// 屏幕上的按钮
    func userAction(_ a: String) {
        switch a {
        case "pause": pause()
        case "resume": resume()
        case "stop": stop("her")
        default: break
        }
    }

    /// 用户说的话(识别出来的字)。返回认出的口令,没认出 = nil(这句照常交给 AI)
    @discardableResult
    func userSaid(_ t: String) -> String? {
        if (on || paused) && Self.hit(Self.stopRe, t) { stop("her"); return "stop" }
        if on && Self.hit(Self.pauseRe, t) { pause(); return "pause" }
        if paused && Self.hit(Self.resumeRe, t) { resume(); return "resume" }
        return nil
    }

    // MARK: 每 1/4 秒:压低 / 抬起 / 到点 / 暂停着等用户说完

    /// ai = AI 在出声;user = 用户在说;userSince = 用户这一句从什么时候开始说(ms,没在说 = nil);quiet = 两边都静、没有回话在路上
    func tick(ai: Bool, user: Bool, userSince: Double?, quiet: Bool) {
        if paused {
            if !pauseArmed, let s = userSince, s > pausedAtMs { pauseArmed = true }
            guard pauseArmed else { return }
            if !quiet { quietSince = 0; return }
            let now = Self.nowMs()
            if quietSince == 0 { quietSince = now }
            else if now - quietSince >= 1500 { resume() }
            return
        }
        guard on else { return }
        if let d = deadline, Date() >= d { stop("done"); return }
        var target = base
        if ai { target = base * 0.3 } else if user { target = base * 0.2 }
        if let d = deadline {
            let left = d.timeIntervalSinceNow
            if left < 2 { target = min(target, base * Float(max(0, left / 2))) }
        }
        // 压低快、回来慢
        cur += (target - cur) * (target < cur ? 0.75 : 0.28)
        if abs(target - cur) < 0.004 { cur = target }
        setVol(cur)
    }

    // MARK: 放

    private func playTrack(from offset: Double) {
        guard on, !list.isEmpty else { return }
        token_ += 1
        let tk = token_
        let t = list[idx % list.count]
        cur = 0
        setVol(0)
        emit()
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard let local = await self.download(t.url) else {
                if tk == self.token_ { self.next(error: true) }
                return
            }
            guard tk == self.token_, self.on else { return }
            // 引擎还没起来(刚接通):等一会儿
            for _ in 0..<40 {
                if let e = self.engine, e.isRunning { break }
                try? await Task.sleep(nanoseconds: 250_000_000)
                if tk != self.token_ { return }
            }
            guard let e = self.engine, e.isRunning else { self.next(error: true); return }
            do {
                let f = try AVAudioFile(forReading: local)
                self.file = f
                e.disconnectNodeOutput(self.player)
                e.connect(self.player, to: self.mixer, format: f.processingFormat)
                guard self.schedule(f, from: offset, token: tk) else { self.next(error: false); return }
                self.player.play()
                self.errs = 0
                self.emit()
            } catch {
                Self.log.info("music open failed: \(String(describing: error), privacy: .public)")
                if tk == self.token_ { self.next(error: true) }
            }
        }
    }

    @discardableResult
    private func schedule(_ f: AVAudioFile, from offset: Double, token tk: Int) -> Bool {
        let sr = f.processingFormat.sampleRate
        let start = AVAudioFramePosition(max(0, offset) * sr)
        guard start < f.length else { return false }
        trackStart = Double(start) / sr
        player.scheduleSegment(f, startingFrame: start, frameCount: AVAudioFrameCount(f.length - start), at: nil,
                               completionCallbackType: .dataPlayedBack, completionHandler: Self.doneBlock(tk, selfBox))
        return true
    }

    /// 完成回调在音频线程上来:不直接抓 self(MainActor),绕一个弱引用盒子回主线程
    final class WeakBox: @unchecked Sendable {
        weak var value: CallMusic?
        init(_ v: CallMusic) { value = v }
    }
    nonisolated private static func doneBlock(_ tk: Int, _ box: WeakBox) -> AVAudioPlayerNodeCompletionHandler {
        return { _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { box.value?.trackDone(tk) } }
        }
    }

    func trackDone(_ tk: Int) {
        guard tk == token_, on, !paused else { return }
        next(error: false)
    }

    private func next(error: Bool) {
        guard on else { return }
        if error {
            errs += 1
            if errs >= list.count { onNote?("音乐没放出来"); stop(nil); return }
        }
        idx += 1
        let more = deadline.map { Date() < $0.addingTimeInterval(-1.5) } ?? (idx < list.count)
        if more { playTrack(from: 0) } else { stop("done") }
    }

    private func pause() {
        guard on else { return }
        heldPos = position()
        on = false; paused = true; pausedAtMs = Self.nowMs(); pauseArmed = false; quietSince = 0
        leftMs = deadline.map { max(0, $0.timeIntervalSinceNow * 1000) } ?? 0
        deadline = nil
        state = "her"
        cur = 0
        setVol(0)
        if attached { player.pause() }
        emit()
    }

    private func resume() {
        guard paused, !list.isEmpty else { return }
        paused = false; on = true; state = "playing"; quietSince = 0
        if seconds > 0 {
            if leftMs < 1000 { stop("done"); return }
            deadline = Date().addingTimeInterval(leftMs / 1000)
        }
        cur = 0
        setVol(0)
        if attached, let e = engine, e.isRunning { player.play() } else { playTrack(from: heldPos) }
        emit()
    }

    /// why:her = 用户停的;ai = AI 让停的;done = 放完/到点;nil = 别的(出错、换歌、挂断)
    func stop(_ why: String?, quiet: Bool = false) {
        token_ += 1
        let wasOn = on || paused
        on = false; paused = false; pauseArmed = false; deadline = nil; leftMs = 0
        state = why == "her" ? "her" : "idle"
        if attached { player.stop() }
        cur = 0
        setVol(0)
        if wasOn && why == "her" { onNote?("音乐停了") }
        if wasOn || !quiet { emit() }
    }

    // MARK: 给界面的

    func position() -> Double {
        // 播放器还没接到引擎上(没在打电话)时读 lastRenderTime,AVFAudio 会直接抛异常崩掉。
        // 先确认接着引擎、引擎在跑、真在放,才去问它放到哪儿
        if on, player.engine != nil, engine?.isRunning == true, player.isPlaying,
           let nt = player.lastRenderTime, let pt = player.playerTime(forNodeTime: nt), pt.sampleRate > 0 {
            return trackStart + Double(pt.sampleTime) / pt.sampleRate
        }
        return paused ? heldPos : trackStart
    }
    var duration: Double {
        guard let f = file, f.processingFormat.sampleRate > 0 else { return 0 }
        return Double(f.length) / f.processingFormat.sampleRate
    }

    func snapshot() -> [String: Any] {
        ["type": "music", "state": on ? "playing" : paused ? "paused" : "idle", "title": title,
         "pos": position(), "dur": duration, "at": Self.nowMs()]
    }

    private func emit() { onEvent?(snapshot()) }

    // MARK: 下载(带口令;一通电话里同一首只下一次)

    private func request(for path: String) async -> URLRequest? {
        if let make = makeRequest { return await make(path) }
        guard let url = URL(string: path, relativeTo: baseURL) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 60)
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func download(_ path: String) async -> URL? {
        if let u = cache[path], FileManager.default.fileExists(atPath: u.path) { return u }
        guard let req = await request(for: path) else { return nil }
        do {
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            let ext = (path.split(separator: "?").first.map { ($0 as NSString).pathExtension } ?? "").lowercased()
            let dst = FileManager.default.temporaryDirectory.appendingPathComponent("music-\(UUID().uuidString).\(ext.isEmpty ? "mp3" : ext)")
            try FileManager.default.moveItem(at: tmp, to: dst)
            cache[path] = dst
            return dst
        } catch {
            Self.log.info("music download failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }
}

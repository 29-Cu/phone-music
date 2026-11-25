# iOS 原生播放端

`CallMusic.swift` 是从一个在用的 iOS 通话 App 里拆出来的,不是完整的 App,而是一块可以放进你自己通话引擎里的零件。把它放进工程以后,你那边要做的事都写在文件开头。

> 说明:拆出来以后改过几处,比如认证改成了可以注入、完成回调改成了弱引用。这个仓库没有 Mac,没有在 Xcode 里编译过这一份。要是编译报错,大概率出在 `WeakBox` / `MainActor.assumeIsolated` 那几行,按你的 Swift 版本调整即可。

## 前提

- 你的通话已经跑在 `AVAudioEngine` 上,AI 的声音由引擎里的某个节点放出来;
- 音频会话是 `.playAndRecord` + `.voiceChat`,或者开了 `inputNode.setVoiceProcessingEnabled(true)`。这样系统的回声消除会把歌从麦里减掉,放歌时麦不用关;
- 歌接在**同一个引擎**上(`attach(engine)`)。不要另起一个 `AVAudioPlayer`,不然回声消除管不到它。

## 接法

```swift
let music = CallMusic()
music.baseURL = URL(string: "https://你的服务器")
music.token = "<访问口令>"
music.onEvent = { snap in /* 更新界面:snap["state"], snap["title"] … */ }
music.onNote = { msg in /* 弹一行字 */ }

// 引擎建好 / 每次重搭以后
music.attach(engine)

// 每 2.5 秒问服务器一次
// GET /api/music/pending?call_id=…&ms=\(music.reportState)
if let m = json["music"] as? [String: Any] { music.handle(m) }

// 每 0.25 秒
music.tick(ai: aiIsSpeaking, user: userIsSpeaking, userSince: userSpeechStartMs, quiet: lineIsQuiet)

// 识别出一句话
music.userSaid(text)

// 换声音设备(引擎要停、要重搭)
music.suspend()  // 停之前
music.resumeAfterRebuild()  // 重搭好以后

// 挂断
music.reset()
```

## 真机上踩过的坑

- 播放器节点没接到引擎上的时候,去碰 `stop()`、`outputVolume`、`lastRenderTime`,AVFAudio 会直接抛异常闪退。所以代码里到处都先看 `attached`。
- 引擎刚起来那一下可能还没在跑。`playTrack` 会最多等 10 秒。
- 换耳机、换蓝牙设备时引擎会重搭。先 `suspend()` 记下位置,重搭好再 `resumeAfterRebuild()` 从原处接着放。
- 下载要带口令。同一通电话里同一首只下一次,挂断时 `reset()` 会清掉临时文件。

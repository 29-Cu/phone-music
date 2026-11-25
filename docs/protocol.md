# 协议:播放端怎么和服务器说话

写自己的播放端(安卓、桌面、别的通话 App)只需要这一页。所有 `/api` 和 `/media` 请求都要带口令:`Authorization: Bearer <token>`,或者在地址后面加 `?t=<token>`(给 `<audio>` 这种带不了请求头的用)。

## 一通电话

播放端自己起一个 `call_id`(4~80 个字母、数字或 `_.:-`),接通后**每 2.5 秒**来问一次:

```
GET /api/music/pending?call_id=<id>&ms=<seq>:<state>
```

- `ms` 是播放端现在的状态:`seq` = 处理过的最后一条指令号(没处理过就是 0),`state` 是 `playing`(在放)、`idle`(没在放:放完了、到点了、AI 让停的、出错了)或 `her`(**用户自己**停的 / 暂停的)。
- 第一次来问就算接通。**60 秒**(`PHONE_MUSIC_STALE_SEC`)没来问,AI 调工具时会被告知"播放端不在"。
- 用户自己停 / 暂停时,最好马上补问一次,不用等下一个 2.5 秒,AI 那边就能立刻知道。

回来的:

```json
{ "call_id": "c1", "music": { "seq": 3, "action": "play", "title": "QQ 音乐歌单「我喜欢」",
  "list": [ { "title": "晴天 - 周杰伦", "url": "/api/qq/0039MnYb0qxYhV.mp3" }, { "title": "…", "url": "…" } ],
  "seconds": 1800, "volume": 0.6, "total": 1260, "ts": 1700000000000, "age_ms": 1200 } }
```

- 没有 `music` = AI 从来没放过。`music` 一直是**最新那一条**,`seq` 比你处理过的大才算新指令。
- `action: "stop"`:停。
- `action: "play"`:
  - `list`:按顺序放。`url` 是相对服务器的路径,取的时候带上口令。服务器支持 `Range`。
  - `seconds`:放多久。`0` = 整张单放完就停;`> 0` = 到点为止,单子放完了就从头再绕(循环就是靠这个,最长 8 小时)。
  - `volume`:0.1~1,这是"没人说话时"的音量。
  - `age_ms` 超过 **120 秒**的不要放:多半是手机从后台回来拿到的旧指令。
  - 一首放不出来就跳下一首;整张单都放不出来,就停下并提示用户。

挂断时:`POST /api/music/end?call_id=<id>`。

## 放的规矩(网页版和 iOS 版都这样)

| 情况 | 音量 |
|---|---|
| 没人说话 | `volume` |
| AI 在出声 | `volume × 0.3` |
| 用户在说话 | `volume × 0.2` |
| 按住说话按着 | 0 |
| 离到点不到 2 秒 | 线性淡到 0 |

压低要快(约 0.06 秒),回来要慢(约 0.25 秒)。每一首都从 0 淡进来。

**用户说的话**(识别成字以后,整句只有这些才算,别的照常交给 AI):

- 「停 / 停下 / 别放了 / 关掉 / stop …」→ 停,状态报 `her`;
- 「暂停 / 停一下 / pause …」→ 暂停,停在原处,状态报 `her`;
- 暂停着说「继续 / 接着放 / resume …」→ 接着放;
- 暂停着,用户**在暂停以后**又开口说了一句(说"暂停"的那一句不算),然后两边都静下来 **1.5 秒**(AI 也回完了)→ 自己接着放。AI 自己说话不算。
- 定了时长的,暂停的那段时间不算进去。

完整的正则见 `web/phone-music-player.js` 顶部。

## 给 AI 的那一句

`GET /api/music/fact?call_id=<id>`(不给 call_id = 最近那一通)→ `{ "text": "电话里还在放「雨」,大概还剩 12 分钟。" }`。规则:

- 用户停的(同一个 seq 报了 `her`)→「……她那头停掉了,现在没在放声音」;
- 播放端报 `idle`、而且离下指令超过 8 秒 →「已经停了」;
- 按 `seconds`(没有就按 `total`)估还剩多久;剩不到 20 秒,播放端还报 `playing` 就是"快放完了",否则当作已经放完。

## AI 那边

- `GET /api/tool` → 工具定义 `{ name, description, input_schema }`(按服务器开了哪些音源现拼的)。
- `POST /api/tool`,body 就是工具参数 → `{ text }`。`?call_id=` 可选,不给就是最近那一通电话。

## 曲库页

- `GET /api/library` → `{ tracks:[{ id, title, url, added_by:"user"|"ai", license, duration, … }] }`
- `POST /api/library/upload?name=<文件名>&title=<可选>`,body = 文件原始字节(最多 80MB)
- `POST /api/library/<id>` `{ "title": "新名字" }`;`DELETE /api/library/<id>`

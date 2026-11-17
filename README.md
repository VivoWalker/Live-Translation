# ja-live-subs

浏览器里看日语视频时的**实时双语字幕**：本机识别日语语音，DeepSeek 翻译，字幕直接叠在网页上。

参考 [VocaLume](https://github.com/clark970417-eng/VocaLume) 的思路做的精简原型，只保留三件事：**日语识别 → 翻译 → 浏览器字幕**。

![演示页](docs/demo-page.png)

---

## 1. 两种运行方式

| 模式 | 需要本地程序 | 识别 | 翻译 | 适用 |
| --- | --- | --- | --- | --- |
| **浏览器内（默认）** | 不需要，装扩展即可 | SenseVoiceSmall int8，WASM，跑在扩展的 offscreen 页 | 扩展直接调 DeepSeek | 日常使用 |
| 本地服务 | 要开 `python -m server.app` | SenseVoice（默认）或 Whisper int8，ONNX Runtime，多线程 | 服务端调 DeepSeek | 更低 ASR 延迟 / 试用 Whisper / 调试 |

两条路产出完全一样的事件流，字幕层（两行滚动）和翻译提示词共用一套逻辑。

### 为什么能不用本地程序

sherpa-onnx 有官方的 **WebAssembly 构建**，SenseVoice 的 .onnx 可以在浏览器里推理。做法是：

1. 扩展里带 12 MB 的 WASM 运行时（`extension/wasm/`）。
2. 第一次使用时把 SenseVoice int8（约 240 MB）下载到浏览器 **Cache Storage**，之后离线可用。
3. 运行时用 Emscripten 打包成一个 `.data` 包，`Module._dataPackageMetadata` 指定文件切分，`Module.locateFile` 指向缓存的 blob —— 模型不落磁盘、不进 IndexedDB 的 5 MB 限制。
4. 16 kHz PCM 交给 WASM 识别，VAD 切句、partial/final 稳定、DeepSeek 翻译都在扩展里完成。

实测（本机，Chrome/Edge 157，单线程 WASM）：

| 指标 | 浏览器内（WASM） | 本地服务（2 线程） |
| --- | --- | --- |
| 首次加载 | ~1.5 s（模型已缓存） | ~1.0 s |
| 单次解码 7.7 s 音频 | 906 ms，RTF 0.118 | 97 ms，RTF 0.013 |
| 连续流式（含窗口重解） | RTF 0.25–0.44，平均 320–560 ms/次 | RTF 0.06–0.08 |
| 句末 → final | +0.3–0.5 s | +0.05 s |
| 句末 → 译文（DeepSeek） | 0.76–1.18 s | 0.52–1.37 s |

WASM 版明显更吃 CPU（1/4–1/2 核，取决于窗口长度和机器负载），换来「装个扩展就能用」。预览解码变慢时会自动拉长间隔（0.6 s → 2.4 s），保证 final 不堆积。想要更低延迟就在弹窗里切「本地服务」。

## 2. 架构

```text
┌─ Chrome/Edge 扩展 ──────────────────────────────────────────┐
│ popup        选标签页、模式、DeepSeek Key                    │
│ background   采集生命周期、事件中继、注入内容脚本            │
│ offscreen    tabCapture → 原生采样率播放 + 16 kHz PCM        │
│              ├─ 浏览器内模式: SenseVoice WASM + VAD + 翻译   │
│              └─ 服务模式: WebSocket 到本机 Python            │
│ content      Shadow DOM 双语字幕（两行滚动、可拖动、全屏）   │
└─────────────────────────────────────────────────────────────┘
```

* **音频**：`tabCapture` 抓标签页声音 → 一路以**原生采样率**接回扬声器（tabCapture 会让标签页静音，必须回放），另一路进 16 kHz 上下文做识别。两条独立 AudioContext，避免识别用的 16 kHz 把播放音质削掉。
* **字幕阅读**：partial 只更新实时日语预览；译文有独立的阅读计时，按字数保留 3–24 秒（默认约 6 字/秒），同时最多显示两条译文。后续短句不会提前顶掉长句；等待的译文获得展示空间后才开始计时，排队时可点「回到实时」跳到最新一句。
* **翻译**：只翻译 final；partial 仅更新日语识别预览，不调用 DeepSeek。上下文（上一句）只放在 system 消息里，避免模型把两句合并。

## 3. 安装

### 3.1 扩展（推荐路径）

1. `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展 → 选 `extension/`。
2. 点图标 → 填 **DeepSeek Key**（只存在 `chrome.storage.local`）→ 选「浏览器内」→「开始字幕」。
3. 首次会下载约 240 MB 模型（弹窗会显示进度），之后走缓存。
4. 字幕叠加在网页底部，右上角出现「字幕已开启」提示。

模型应在浏览器重启后保留。每次启动仍需把本地模型加载进 WASM 内存；“识别模型已缓存，正在加载…”表示本地加载，不是重新下载。弹窗会显示模型是否已保存，写入失败时会明确提醒。

0.3.2 修复了扩展缓存键被解析成 `chrome-extension://`、导致 Cache API 写入失败的问题。现在使用合法的 HTTPS 缓存索引（仅本地索引，不会访问该地址），并申请 `unlimitedStorage` 保护约 240 MB 的模型免受配额和回收影响。更新后在原有扩展条目点击“重新加载”，保持原目录和扩展 ID；卸载或改换扩展 ID 后，旧缓存可能不再可见。旧版本没保存成功的模型仍需下载一次。

0.3.3 移除了浏览器内模式和本地服务的预览翻译，避免一句话的前半部分和完整句子先后提交给 DeepSeek。日语预览仍实时显示，译文等 VAD 判定停顿、确认最终分段后再生成；连续长语音仍保留 12 秒分段上限，停顿后只翻译尚未提交的剩余音频。旧客户端发送的 `partial_translation` 配置不再启用预览翻译。更新后重新加载扩展并重新开始字幕；本地服务模式还需重启 Python 服务。

0.4.0 更新字幕框交互：鼠标移入时底板加深，显示「移动」手柄与「字幕样式」；只有手柄会拖动字幕框，方向键也可微调位置。可以调整字号、宽度、颜色、日语原文、离开时的背景浓度和阅读速度，设置在扩展内保存、跨网站复用。移开后工具栏收起、底板淡化，文字保留描边与阴影以保证亮色画面上的可读性。阅读计时在悬停、键盘操作或页面不可见时暂停，字幕进出采用缓动动画，并遵循系统「减少动态效果」设置。更新后重新加载扩展并刷新视频页。

### 3.2 本地服务（可选）

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade 'pip>=26.2'
.venv\Scripts\pip install -r requirements.txt
copy config.example.json config.local.json   # 填 deepseek_api_key
.\.venv\Scripts\python -m server.app          # http://127.0.0.1:8765/
```

服务同时提供演示页（`getDisplayMedia` 选标签页），不装扩展也能看效果。

服务启动时会生成并显示**本地服务访问令牌**。在演示页或扩展的「本地服务」模式里填入该令牌；浏览器内模式只需要 DeepSeek Key，不检查本地服务。服务重启后随机令牌会变化；如需固定令牌，可设置 `JLSUBS_ACCESS_TOKEN`（至少 32 个随机 ASCII 字符），也可在仅本机保存的 `config.local.json` 中配置 `access_token`。不要把它和 DeepSeek Key 混用，也不要把密钥写入网页静态文件。

Linux/macOS 可用 `.venv/bin/python -m pip` 安装，随后运行 `.venv/bin/python -m server.app`。服务默认只接受本机 Host、同源网页或 Chrome 扩展来源，所有 WebSocket 客户端都必须认证。需要额外 HTTP 主机名时显式传入 `--allow-host example.com`；远程使用应部署 HTTPS，不要把原始服务端口直接公开。

生产启动只公开演示页所需静态资源。调试 `engine-test.html`、扩展资产等需要显式加 `--dev-assets`；`key.local.js` 始终不会通过 HTTP 提供。浏览器模型下载和缓存都验证固定 SHA-256，更新模型时必须同步审核并更新摘要。

### 3.3 试用 Whisper（本地服务，实验性）

Whisper 复用已有的 sherpa-onnx，支持 CPU 推理，无需安装 PyTorch、faster-whisper 或额外的运行依赖。默认识别器仍为 SenseVoice；扩展选择「本地服务」后使用服务启动时指定的识别器。

先按 3.2 安装 Python 依赖，再下载多语言 **base int8** 和 Silero VAD（不需要 SenseVoice 权重）：

```powershell
python tools/download_whisper.py
python -m server.app --asr whisper --threads 2
```

请在已激活的 `.venv` 中执行；也可直接使用 `.venv\Scripts\python`（Windows）或 `.venv/bin/python`（Linux/macOS）。脚本从 sherpa-onnx 官方 GitHub Release 下载约 **198 MiB** 压缩包，只保留约 **153 MiB** 的 int8 编码器、解码器和词表。模型、压缩包和 VAD 均校验代码中固定的 SHA-256；再次运行会校验并复用已有文件。模型保存在被 Git 忽略的 `models/` 中，服务启动时不会自动下载。

也可以在 `config.local.json` 写入 `"asr": "whisper"`，或设置 `JLSUBS_ASR=whisper`。自备 sherpa-onnx 的多语言 int8 模型时，通过 `--model-dir 路径` 或 `JLSUBS_WHISPER_MODEL_DIR` 指定目录，目录中需要匹配的 `<size>-encoder.int8.onnx`、`<size>-decoder.int8.onnx`、`<size>-tokens.txt`。`--model-dir` 优先于环境变量；未指定目录时查找 `models/whisper-base`。不要使用 `.en` 英语专用模型。

服务固定 `language=ja`、`task=transcribe` 获取日语，再交给已有翻译器生成中文。`/health`、WebSocket `ready` 和扩展连接提示会显示实际使用的模型（例如 `whisper-base-int8`）。访问令牌、认证和音频限制与 SenseVoice 相同。

Whisper 是离线识别模型；这里通过 VAD 分句并重解窗口生成预览。预览至少等待 2 秒语音、间隔至少 2 秒，解码较慢时进一步降低频率；最终字幕仍由 VAD 句尾触发。CPU 较慢或同时连接多个音源时仍可能积压，应优先减少连接数或使用 SenseVoice。

用同一段音频比较识别耗时：

```bash
python tools/test_asr.py testdata/ja_nanami.mp3 --asr whisper --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr sensevoice --threads 2
```

本次云环境中，7.70 秒日语样本的 Whisper base int8 解码约 1.41 秒（RTF 0.183），SenseVoice 约 0.38 秒（RTF 0.049），均使用 2 线程。单个短样本只用于确认接入和成本，不能代表识别准确率；音乐、重叠语音和长时间直播仍需进一步评估。

另外以实时速度发送仓库内约 50 秒的 `ja_long.wav`，前后加入静音，Whisper 输出 15 条最终字幕和 9 次预览；本地 mock 翻译器收到全部 15 条最终字幕。此测试验证音频、认证、VAD、识别和翻译调度链路，未连接真实 DeepSeek API。

真实 Chromium 演示页的 AudioWorklet → WebSocket → Whisper → 字幕显示也已跑通。不过分句后的短音频中观察到「午後」被识别成「5個」，因此本次接入保持实验性，不作为默认模型替换。

## 4. 字幕为什么不会「跳」

原先是单行覆盖：下一句一开口，上一句译文就被顶掉。现在固定两行：

```text
上一句（变暗）  午後から雨が降るそうです。
                听说下午会下雨。
当前句          こんにちは。今日は東京の天気についてお話しします。
                你好。今天来聊聊东京的天气。
```

上一句会一直留到新句译文出现为止；晚到的译文按 `id` 回填到对应行，不会丢。

## 5. 协议（服务模式）

客户端 → 服务端：第一条消息必须是 `{"type":"auth","token":"<访问令牌>"}`，认证成功后服务端发送 `ready`，再接受 `{"type":"config","target":"zh"}` 和二进制 float32 PCM 帧。认证等待最多 5 秒；每帧不超过 64 KiB，排队音频不超过 256 KiB，持续发送不超过 2 倍实时速率，最多 8 个连接。正常客户端使用 100 ms（6400 字节）的帧。服务端事件为 `ready / partial / final / translation / stats / error`。

命令行模拟器读取环境变量 `JLSUBS_ACCESS_TOKEN`，例如先在当前终端设置服务显示的令牌，再运行 `python tools/simulate.py testdata/ja_nanami.mp3 --speed 1`。令牌不会出现在 WebSocket URL 或 HTTP 查询日志中。

## 6. 目录

```text
ja-live-subs/
├─ extension/
│  ├─ manifest.json         MV3，权限：tabCapture/offscreen/scripting/tabs…
│  ├─ background.js         采集生命周期、内容脚本注入、事件中继
│  ├─ popup.*               模式、Key、状态
│  ├─ offscreen.*           tabCapture + 双 AudioContext + 引擎调用
│  ├─ asr-engine.js         浏览器内 SenseVoice（WASM）+ VAD + 分段 + 翻译
│  ├─ caption-overlay.js    扩展与演示页共用的样式设置、阅读计时和动画
│  ├─ wasm/                 sherpa-onnx WASM 运行时（12 MB）
│  └─ content.js            双语字幕层
├─ server/                  Python 服务（可选模式 + 演示页）
├─ web/                     演示页与测试页
├─ tools/                   simulate / browser_check / content_check / extension_e2e
└─ tests/                   unittest：文本处理 + DeepSeek 请求契约 + 缓存
```

## 7. 验证记录

当前安全回归测试（不使用真实 API Key、无需下载模型）：

```sh
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

JavaScript 测试需要 Node.js 22 或更新版本，覆盖启动取消、旧会话结果丢弃、模式转发和损坏模型拒绝。浏览器演示测试 `node tools/browser_check.mjs` 需设置 `JLS_CHROME` 和 `JLSUBS_ACCESS_TOKEN`；完整扩展测试仍需浏览器允许加载未打包扩展。

已有本地模型时，可额外运行跨浏览器进程缓存回归测试：

```sh
JLS_CHROME=/path/to/chrome node tools/cache_check.mjs --model-dir /path/to/sensevoice-onnx --vad-model /path/to/silero_vad.onnx
```

该测试使用临时 Chrome 配置和真实模型文件验证摘要、磁盘缓存及关闭后重开时零模型下载；WASM 识别接口使用桩，测试不连接翻译 API。它同时复现旧 `chrome-extension://` 缓存键的 TypeError，不会修改用户的浏览器配置。

下面为原型早期验证记录，不代表本次修改已重复验证真实计费 API 或真实标签页采集：

| 检查 | 结果 |
| --- | --- |
| 单元测试 | 8/8 通过（DeepSeek 请求契约/重试/缓存用本地 stub 校验） |
| 服务模式流式 | 50 s 音频 15 句，逐句 523–1372 ms，均值 852 ms |
| 浏览器内引擎（真实 DeepSeek） | **PASS**：7.7 s 音频，partial→final→译文，译文 758/1090 ms |
| 演示页（无头 Chrome） | **PASS**：AudioWorklet → WS → 字幕 |
| 扩展（Edge 真实加载） | **PASS 6/6**：加载、SW、offscreen 引擎、内容脚本 ping、中继渲染、错误可读 |
| `tabCapture` 全链路 | 只能人工确认：Chrome 只用真实点击授予 activeTab，脚本 `openPopup()`/`userGesture` 都会被拒 |

## 8. 已知限制

* **WASM 更吃 CPU**：约 1/4 核（窗口重解导致），比本地服务高 3–4 倍；老机器建议切服务模式。
* **内存**：模型包 + 解码缓冲约 500–700 MB 峰值，标签页多时注意。
* **识别上限**：SenseVoice 对 BGM、重叠人声、方言、专名会掉字；同音字（止まる→泊まる）、词中插逗号、句尾问号都是已知毛病。
* **模型来源**：首次从 HuggingFace / GitHub Releases 下载，需要能访问；之后离线。
* **DRM 内容**（Netflix 等）可能只给静音轨。

### 排查

| 现象 | 处理 |
| --- | --- |
| 弹窗显示「服务未启动」 | 切回「浏览器内」模式，或先启动 `server.app` |
| 卡在「下载识别模型」 | 网络问题；代理下请确认能访问 huggingface.co |
| 有日文没译文 | Key 未填或额度用尽；弹窗会显示「未填写 DeepSeek API Key」 |
| 字幕不出现 | 刷新页面后重试（内容脚本需注入）；`chrome://` 页面无法采集 |
| 声音变小/发闷 | 已修复（播放走原生采样率）；若仍异常请反馈 |

## 9. 许可

SenseVoice（FunAudioLLM，Apache-2.0）、Whisper（OpenAI，MIT）、sherpa-onnx（Apache-2.0）、Silero VAD（MIT）、DeepSeek API 按其服务条款。WASM 运行时来自 sherpa-onnx 官方构建。

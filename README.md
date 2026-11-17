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
* **字幕阅读**：partial 只更新实时日语预览；译文有独立的阅读计时，按字数留出至少 3–24 秒（默认约 6 字/秒），同时最多显示两条译文。退场按出现顺序进行，后面的短句会延长停留，等前句先退出；等待的译文获得展示空间后才开始计时，排队时可点「回到实时」跳到最新一句。
* **翻译**：只翻译 final；partial 仅更新日语识别预览，不调用 DeepSeek。system 只含固定要求；user 用 JSON 的 `previous` / `current` 标明上一句与当前句，明确上一句仅辅助理解、只翻译当前句。

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

0.4.1 修复等待翻译时日语原文消失的问题：识别完成后保留同一字幕行，中文回来时只让译文渐入，阅读时长从译文实际显示起算。上下句使用相同字号，滚动条隐藏但仍支持滚轮和键盘阅读，避免高度动画触发横向重排。停止字幕时取消动画；识别异常、初始化失败和正常加载后均回收对应 stream、临时模型 URL 和脚本节点。

0.4.2 增加会话内译文 LRU、进行中请求合并和 DeepSeek usage 统计。字幕按出现顺序退场：前一句较长时，后一句较短也会等待前句退场后再消失，两次退场至少间隔 600 ms；每句仍保留自己的最低阅读时间，可用「回到实时」跳过积压。

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

### 3.4 DeepSeek 译文复用与统计

浏览器和 Python 服务使用相同的固定系统提示词语义及 `user = {"previous": "上一句", "current": "当前句"}` 消息结构。上一句仅辅助理解指代和语气，只翻译当前句；不累积整段历史、不填充文字来凑缓存长度。默认模型和参数保持 `deepseek-chat`、`temperature=0.2`、`max_tokens=512`、非流式；Python 仍支持 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`。原请求本来就有固定前缀，移动上下文本身不保证服务端缓存命中。

译文缓存只存在于当前会话内存，最多 500 条，键与译文合计最多 1 MiB UTF-8 数据，每项最多 32 KiB；超大项不缓存。键包含 API 地址、模型、提示词版本、目标语言、上一句、当前句及实际提示词、温度、输出上限等请求参数。不同上下文不混用。只有非空且 `finish_reason=stop` 的完整成功响应可缓存；失败、取消、超时、截断及无法确认结束的响应均不缓存。同一键的进行中请求共用一次调用；每个有效最终分段仍只接收一次字幕事件，命中本地缓存同样推进翻译上下文。

浏览器停止、重启或修改翻译配置时清空译文缓存、进行中记录及统计，不写 Cache Storage / localStorage；持久化的识别模型缓存不受影响。Python 每个 WebSocket 使用独立 pipeline、LRU、任务和计数，仅复用底层 HTTP 连接，断开或切换目标语言时清理。每会话最多 32 个进行中请求，统计只有固定数量的饱和计数器，不累计逐条台词日志。

在 offscreen 页的 `JLSEngine.stats().translation`，或已认证 WebSocket 的 `{"type":"stats"}` 响应 `translation` 中查看 `api_requests`、`local_cache_hits`、`merged_requests`、`request_ms`、`avg_request_ms`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens` 和 `completion_tokens`。API 次数包含实际发出的重试，耗时按每次实际请求累计，本地命中和合并不重复计入服务端 usage。若某字段有任何已结束请求缺失，累计总数显示 `null`；`usage_reported_tokens` 保留已知部分，`usage_unavailable_requests` 标出缺失次数，`usage_pending_requests` 标出仍待返回的请求。显式返回的零与不可用不同。诊断不输出 Key、完整台词、上下文或缓存键。

使用已有凭据做少量真实验证（该模式直接调用传输层，绕过本地缓存和合并）：

```sh
python tools/test_translate.py --engine deepseek --probe-cache --report /tmp/deepseek-usage.json
```

需要代理的环境先按既有方式配置 `DEEPSEEK_BASE_URL`。工具只输出场景编号、usage、请求次数和耗时。2026-11-17 经环境代理实测 3 次：固定前缀不同台词的输入命中/未命中分别为 0/129、0/127，完全相同请求为 0/129；输出分别为 6、5、6 tokens，耗时约 1205、850、1072 ms。本次未观察到 DeepSeek 服务端缓存收益；本地 LRU 和合并减少的是实际 API 调用，实际节省取决于同一上下文中的重复情况，不承诺比例。小样本不代表长期命中率，也未做大样本质量评测。

### 3.5 学マス、声优与动画歌曲专名

浏览器识别固定为日语，与本地服务一致。默认启用本地专名词表，优先覆盖陽高真白直播、学マス生放送，兼顾 BanG Dream! / Love Live! 的部分声优、角色、团体与歌曲；在显示日语和发送最终分段翻译前统一纠正。例如 `日高真白` → `陽高真白`，`月村手鞠` → `月村手毬`。含歧义的歌名需要邻近音乐语境，不从短名猜人，也不增加 DeepSeek 请求。

扩展弹窗可选择「学マス + 动漫声优」「动漫声优」或关闭，下一次开始生效；本地服务用 `--asr-domain gakumas|anime|off` 或配置 `asr_domain`，另可用 `--asr-terms` 指定自定义词表。首批 169 条、448 个别名，浏览器和 Python SenseVoice / Whisper 共用一份数据。词表纠错没有重新训练模型权重；尚无这些节目的标注音频，不承诺未经测量的准确率提升。编辑方法、误改保护和测试见 [日语领域识别说明](docs/asr-domain.md)。

## 4. 字幕为什么不会「跳」

原先是单行覆盖：下一句一开口，上一句译文就被顶掉。现在固定两行：

```text
上一句（先到）  午後から雨が降るそうです。
                听说下午会下雨。
当前句          こんにちは。今日は東京の天気についてお話しします。
                你好。今天来聊聊东京的天气。
```

等待翻译时日语留在原行；译文按长度计时，并按先后顺序退场。晚到的译文按 `id` 回填，后一句较短也不会先于前一句消失。

## 5. 协议（服务模式）

客户端 → 服务端：第一条消息必须是 `{"type":"auth","token":"<访问令牌>"}`，认证成功后服务端发送 `ready`，再接受 `{"type":"config","target":"zh"}` 和二进制 float32 PCM 帧。认证等待最多 5 秒；每帧不超过 64 KiB，排队音频不超过 256 KiB，持续发送不超过 2 倍实时速率，最多 8 个连接。正常客户端使用 100 ms（6400 字节）的帧。服务端事件为 `ready / partial / final / translation / translation_cancelled / stats / error`；`translation_cancelled` 带原句 `id`，让界面结束被取消请求的等待状态。

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

`JLS_CHROME=/usr/bin/chromium node tools/content_check.mjs` 使用真实浏览器和本地消息桩验证字幕交互、延迟译文、无滚动条重排及原文连续显示。加 `--stress` 会模拟 10,000 条字幕和 100 次销毁重建，比较强制 GC 后的 JS 堆、DOM 和监听器数量；加 `--wasm` 会再用真实 SenseVoice 模型执行 24 次初始化、音频识别、翻译和停止，并检查末段内存是否稳定。`--wasm` 需要本地 `models/sensevoice-onnx` 与 `models/silero`，或已设置的 `DSH_HOME` 模型目录；翻译请求由本地桩响应，不使用真实 API Key。可用 `--report /tmp/caption-memory.json` 保存指标。短时加速压测用于发现持续增长，不代表无限时长下的内存保证；WASM 线性内存的高水位保留也应与泄漏区分。

`--continuous` 在同一个 WASM 会话中连续识别 64 段真实音频，约 10 分钟 PCM 以加速方式发送，检查不中途停止时的 PCM 缓冲、JS 堆和 WASM 内存。该参数也需要上述本地模型，可以与 `--stress --wasm` 合用。

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

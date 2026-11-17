# 开发与验证

[返回项目首页](../README.md)

## 架构

```text
Chrome / Edge 扩展
├── popup       模式、语言、凭据、专名词表与状态
├── background  会话生命周期、事件中继、内容脚本注入
├── offscreen   标签页采集、音频回放、16 kHz PCM
│   ├── 浏览器模式   SenseVoice WASM → VAD / 识别 → 翻译
│   └── 服务模式     WebSocket → Python SenseVoice / Whisper → 翻译
└── content     共享字幕层、阅读队列、样式与拖动
```

采集后的声音用原生采样率 AudioContext 回放，识别另用 16 kHz 上下文。浏览器内的 Emscripten 运行时在 offscreen 窗口中加载，模型下载后由浏览器缓存管理；加载时仍需把模型放入 WASM 内存。下载与缓存读取均验证固定 SHA-256。

日语 partial 更新预览，final 触发翻译。字幕层以分段 ID 回填，等待翻译期间保留原文；译文从实际展示起计时，按长度留出 3–24 秒最低阅读时间。后句可为退场顺序延长停留，两次退场至少间隔 600 ms。悬停、键盘操作及页面不可见时暂停阅读计时，遵循系统减少动态效果设置。

## 目录

```text
extension/                  Manifest V3 扩展与浏览器识别引擎
├── asr-engine.js           WASM 生命周期、分段、翻译与会话状态
├── asr-domain.js           本地专名纠错实现
├── asr-terms.json          浏览器 / Python 共用词表
├── caption-overlay.js      扩展 / 演示页共用字幕层
└── wasm/                   第三方 sherpa-onnx 运行时
server/                     Python ASR、翻译、认证与 WebSocket
web/                        本地服务演示页与开发测试页
tools/                      模型下载、音频模拟及浏览器检查
tests/                      Python / JavaScript 回归与共享契约
docs/                       安装、领域词表与验证说明
LICENSES/                   第三方许可文本
```

## 本地测试

使用 Python 3.11+、Node.js 22+，在虚拟环境中安装依赖：

```sh
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m unittest discover -s tests
node --test tests/*.test.mjs
```

测试覆盖固定提示词契约、上下文隔离、LRU 与请求合并、usage 缺失、失败重试、取消和配置切换；也覆盖词表正反例、识别输出到翻译的传递、字幕退场顺序及状态容量限制。单元测试不需要真实模型下载或 API Key。

当前版本验证记录（2026-11-17）：59 项 Python、54 项 JavaScript 测试通过。两段普通日语音频在词表开关下输出一致；词表文本测试及普通音频回归均不能证明目标直播中的专名准确率提升。

## 浏览器与长时间状态检查

指定可用的 Chromium 路径，测试使用本地页面与消息桩：

```sh
JLS_CHROME=/path/to/chromium node tools/content_check.mjs
JLS_CHROME=/path/to/chromium node tools/content_check.mjs --stress --report /tmp/caption-memory.json
```

`--stress` 模拟 10,000 条字幕和 100 次销毁重建，对比强制 GC 后的 JS 堆、DOM 与监听器。真实模型已按本地服务指南准备后，还可运行：

```sh
JLS_CHROME=/path/to/chromium node tools/content_check.mjs --wasm
JLS_CHROME=/path/to/chromium node tools/content_check.mjs --wasm --wasm-cycles 2
JLS_CHROME=/path/to/chromium node tools/content_check.mjs --continuous
```

`--wasm` 默认执行 24 轮初始化、真实识别与停止，可用 `--wasm-cycles` 调整；`--continuous` 在一个会话内连续识别 64 段音频，约 10 分钟 PCM 以加速方式发送。也可通过 `DSH_HOME` 指向兼容的模型目录。翻译使用本地桩，不消耗真实 API Key。

最近的功能改动已通过 14 项真实 Chromium 字幕交互检查及 2 轮真实 SenseVoice WASM 启停识别。更早改动曾执行更长的加速压力测试；这里不把这些历史检查描述成每次提交都会自动运行。短时检查可发现持续增长，不能保证无限运行下的内存表现；WASM 线性内存高水位保留也不等同于泄漏。

跨浏览器进程的模型缓存检查：

```sh
JLS_CHROME=/path/to/chromium node tools/cache_check.mjs --model-dir /path/to/sensevoice-onnx --vad-model /path/to/silero_vad.onnx
```

该工具使用临时浏览器配置与真实模型文件检查摘要、持久化和重开后的零模型下载；识别接口为桩，不连接翻译 API。`tools/browser_check.mjs` 用于服务演示页，需配置 `JLS_CHROME` 和 `JLSUBS_ACCESS_TOKEN`；完整扩展检查还要求浏览器允许加载未打包扩展。真实 `tabCapture` 链路需要用户点击授权，页面桩检查不代替这一步。

## 服务协议

连接 `/ws` 后，第一条消息必须为 `{"type":"auth","token":"<访问令牌>"}`。认证成功后服务端发出 `ready`，客户端可发送 `{"type":"config","target":"zh"}`，以及 16 kHz、单声道、小端 float32 PCM 二进制帧。目标语言支持 `zh` / `en`。

| 约束 | 限制 |
| --- | --- |
| 认证等待 | 5 秒 |
| 单帧音频 | 最多 64 KiB |
| 排队音频 | 最多 256 KiB |
| 持续发送速度 | 最多 2 倍实时速率 |
| 连接数 | 最多 8 个，含等待认证的连接 |

正常客户端使用 100 ms、6400 字节的帧。服务端事件包括 `ready`、`partial`、`final`、`translation`、`translation_cancelled`、`stats` 和 `error`；取消事件带原句 `id`，供字幕层结束等待。模型与访问令牌配置见 [本地服务](local-service.md)，翻译统计见 [翻译与用量](translation.md)。

命令行模拟器从环境变量读取访问令牌：

```sh
python tools/simulate.py testdata/ja_nanami.mp3 --speed 1
```

## 复现性能数据

用同一音频、相同线程数和机器比较识别器，不把 API 网络耗时混入纯识别耗时：

```sh
python tools/test_asr.py testdata/ja_nanami.mp3 --asr sensevoice --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr whisper --threads 2
```

早期本地检查中，7.7 秒日语样本的 Whisper base int8 解码约 1.41 秒，SenseVoice 约 0.38 秒，均为 2 线程。不同硬件、预热状态、采集节奏和模型都会影响结果；该记录只确认接入与耗时，不代表准确率或性能保证。Whisper 曾完成 50 秒音频的服务链路及 Chromium 演示检查，但仍保持实验性。DeepSeek 的真实 usage 对照单独记录在 [翻译文档](translation.md)。

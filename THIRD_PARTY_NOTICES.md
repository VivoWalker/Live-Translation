# 第三方组件与许可

Live Translation 的 [MIT License](LICENSE) 适用于项目原创代码与文档。以下第三方运行时、模型、依赖及服务保留各自的许可和声明；项目的 MIT 授权不替代这些条款，也不授予商标、角色、人声或第三方录音的额外权利。

## 随扩展分发的运行时

| 组件 | 本仓库中的位置 / 用途 | 许可与来源 |
| --- | --- | --- |
| sherpa-onnx | `extension/wasm/` 中的 ASR / VAD JavaScript 绑定、生成的加载器及 WASM 模块 | [Apache-2.0](LICENSES/Apache-2.0.txt) · [上游](https://github.com/k2-fsa/sherpa-onnx) |
| ONNX Runtime | sherpa-onnx 使用的推理运行时 | [MIT，Microsoft Corporation](LICENSES/ONNX-Runtime-MIT.txt) · [上游](https://github.com/microsoft/onnxruntime) |
| Emscripten | WebAssembly 构建工具与生成的 JavaScript 运行时支持 | [MIT / Illinois-NCSA 上游许可文本](LICENSES/Emscripten.txt) · [上游](https://github.com/emscripten-core/emscripten) |

WASM 与其绑定来自 sherpa-onnx 官方构建，不属于本项目原创代码。分发这些文件时，应同时保留本声明及适用许可文本；升级构建或改变其中组件时，也应同步核对上游的依赖声明。

## 识别模型与语音活动检测

识别模型由用户下载到浏览器缓存或本地 `models/` 目录，没有作为模型权重提交到本仓库。

| 组件 | 使用方式 | 许可与来源 |
| --- | --- | --- |
| SenseVoice 源码 | 模型来源项目；本仓库通过 sherpa-onnx 运行其 ONNX 导出 | [MIT 源码许可](LICENSES/SenseVoice-code-MIT.txt) · [FunAudioLLM / SenseVoice](https://github.com/FunAudioLLM/SenseVoice) |
| SenseVoiceSmall 模型权重 | 浏览器及 Python 默认识别模型 | [上游模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)声明使用独立的 [FunASR 模型许可](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，[本地文本快照](LICENSES/FunASR-MODEL_LICENSE.txt) |
| SenseVoice ONNX 转换 | 固定的 `2024-07-17` 导出、int8 模型与配套词表 | [csukuangfj / sherpa-onnx SenseVoice 发布目录](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17)，源自 FunAudioLLM / FunASR；权重许可独立于推理框架 |
| Whisper | 可选的多语言 base int8 编码器、解码器与词表 | [MIT，OpenAI](LICENSES/Whisper-MIT.txt) · [上游](https://github.com/openai/whisper) · [ONNX 发布](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |
| Whisper Large V3 Turbo | 可选 CTranslate2 格式权重 | [OpenAI Whisper MIT](https://github.com/openai/whisper) · [参考转换制品](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo) |
| Parakeet TDT-CTC 0.6B Japanese | 可选 NeMo `.nemo` 权重 | [NVIDIA 模型卡，CC BY 4.0](https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja) |
| Qwen3-ASR-1.7B | 可选 Transformers 本地权重 | [Qwen 模型卡，Apache-2.0](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) |
| Community-1 | 可选录播说话人模型 | [pyannote 模型卡，CC BY 4.0 与权重获取条款](https://huggingface.co/pyannote/speaker-diarization-community-1) |
| Silero VAD | 浏览器与 Python 的语音分段 | [MIT，Silero Team](LICENSES/Silero-VAD-MIT.txt) · [上游](https://github.com/snakers4/silero-vad) |

SenseVoice **源码许可与模型权重许可不同**。2026-11-18 复核的模型卡分别标注 SenseVoice 权重为自定义条款、Parakeet 与 Community-1 为 CC BY 4.0、Qwen3-ASR 为 Apache-2.0、Turbo 参考转换为 MIT。Community-1 的权重需要按上游条款申请访问。使用具体模型版本时以其随附条款为准。扩展发布 ZIP 仅打包提交中的代码、运行时及许可文本，模型继续由用户按需取得。

## Python 与开发依赖

Python 运行依赖由 `requirements.txt` 安装，开发依赖由 `requirements-dev.txt` 安装，各依赖及其传递依赖的完整许可随其分发包提供。主要项目包括：

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)：Apache-2.0。
- [NumPy](https://github.com/numpy/numpy)：BSD-3-Clause，及其分发包附带的第三方声明。
- [aiohttp](https://github.com/aio-libs/aiohttp)：当前安装版本声明 Apache-2.0 AND MIT，及其依赖声明。
- [websockets](https://github.com/python-websockets/websockets)：BSD-3-Clause。
- [SoundFile](https://github.com/bastibe/python-soundfile)：BSD-3-Clause；系统或 wheel 中的 libsndfile 保留自己的 LGPL 许可。
- [edge-tts](https://github.com/rany2/edge-tts)：LGPL-3.0；相关在线语音服务另有条款。
- Parakeet 的可选组使用 NeMo 与 PyTorch。 [NeMo，Apache-2.0](https://github.com/NVIDIA/NeMo) · [PyTorch，BSD-3-Clause](https://github.com/pytorch/pytorch)
- Turbo 的可选组使用 faster-whisper 与 CTranslate2。 [faster-whisper，MIT](https://github.com/SYSTRAN/faster-whisper) · [CTranslate2，MIT](https://github.com/OpenNMT/CTranslate2)
- Qwen3-ASR 的可选组使用 Qwen ASR 和 Transformers。 [Qwen ASR，Apache-2.0](https://github.com/QwenLM/Qwen3-ASR) · [Transformers，Apache-2.0](https://github.com/huggingface/transformers)
- 说话人分离与评估使用 pyannote.audio 和 pyannote.metrics。 [pyannote.audio](https://github.com/pyannote/pyannote-audio) · [pyannote.metrics](https://github.com/pyannote/pyannote-metrics)
- Benchmark 可选用 Janome（Apache-2.0，附带词典声明）、SacreBLEU（Apache-2.0）与 psutil（BSD-3-Clause）。 [Janome](https://github.com/mocobeta/janome) · [SacreBLEU](https://github.com/mjpost/sacrebleu) · [psutil](https://github.com/giampaolo/psutil)

本文件列出直接使用的主要组件，不替代依赖分发包提供的完整清单。重新打包包含运行环境的发行物时，应一并保留所携带依赖的许可文本。

## 服务、名称与媒体

- DeepSeek 翻译接口适用 [DeepSeek 的服务条款](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html)及计费规则，不属于本项目 MIT 授权内容。
- 可选的公共 Google 翻译端点适用服务方条款；本项目不为服务可用性或使用权限作额外授权。
- 词表中的人名、角色名、团体名、歌曲名与作品名称用于识别和事实性标识，不表示与相关个人或权利方存在合作、授权或背书关系。
- 测试音频和示例中的人声、录音及第三方内容不因代码采用 MIT 而获得额外的再利用授权。
- 本地对照使用 JSUT Basic5000 的研究用途样本。音频保留原作者使用条款，评估仓库只记录来源、配置和汇总结果。 [JSUT 来源及音频使用条款](https://huggingface.co/datasets/FluidInference/JSUT-basic5000/blob/cd13cc9c9fe70d8d4f62ffe6fbbb872aef79835c/README_en.txt)

本声明保留实际使用的组件来源；未将第三方内容重新署名为本项目原创。

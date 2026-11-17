# 本地服务

[返回项目首页](../README.md)

本地服务使用 Python、sherpa-onnx 与 ONNX Runtime 在 CPU 上识别日语，默认 SenseVoice，可切换实验性 Whisper。扩展选择「本地服务」后，将标签页音频发送到配置的 WebSocket 地址；默认服务只监听本机。

## 安装依赖

使用 Python 3.11 或更新版本，建议在独立虚拟环境中安装。先进入仓库目录。

### Windows PowerShell

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
Copy-Item config.example.json config.local.json
```

### Linux / macOS

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
cp config.example.json config.local.json
```

把 `config.local.json` 中的 `deepseek_api_key` 替换为自己的 Key。它已被 Git 忽略；也可改用环境变量 `DEEPSEEK_API_KEY`。API Key 只用于翻译，本地服务访问令牌用于客户端认证，两者不同。

以下命令中的 `python` 指已激活虚拟环境的解释器。未激活时，Windows 使用 `.\.venv\Scripts\python`，Linux / macOS 使用 `.venv/bin/python` 替换。

## 准备识别模型

### SenseVoice · 默认

从下表来源下载文件，按目录结构放入仓库。浏览器扩展的模型缓存独立管理，Python 服务不会直接读取浏览器缓存。

| 文件 | 放置位置 | 来源 |
| --- | --- | --- |
| `model.int8.onnx` | `models/sensevoice-onnx/` | [SenseVoice ONNX](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx) |
| `tokens.txt` | `models/sensevoice-onnx/` | [配套词表](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt) |
| `silero_vad.onnx` | `models/silero/` | [Silero VAD](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx) |

```text
models/
├── sensevoice-onnx/
│   ├── model.int8.onnx
│   └── tokens.txt
└── silero/
    └── silero_vad.onnx
```

这些是浏览器下载器使用的固定 SHA-256。手动准备 Python 模型时可据此核对文件：

```text
model.int8.onnx   c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
tokens.txt       f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
silero_vad.onnx  9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6
```

例如 PowerShell 使用 `Get-FileHash 文件路径 -Algorithm SHA256`，Linux 使用 `sha256sum 文件路径`，macOS 使用 `shasum -a 256 文件路径`。

模型路径可通过 `--model-dir` 或 `JLSUBS_MODEL_DIR` 指定；显式参数优先。VAD 仍需放在上述位置。服务也保留了对 `DSH_HOME/speech-to-text/sensevoice/models/` 现有模型目录的兼容查找。模型许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

### Whisper · 实验性

下载器使用 Python 标准库，从 sherpa-onnx 官方 GitHub Release 下载多语言 base 模型和 VAD：

```sh
python tools/download_whisper.py
python -m server.app --asr whisper --threads 2
```

下载约 198 MiB 压缩包，仅保留约 153 MiB 的 int8 编码器、解码器与词表；模型默认放在 `models/whisper-base/`，VAD 放在 `models/silero/`。压缩包、模型及 VAD 均校验固定 SHA-256，再次运行会校验并复用已有文件。服务启动不会自动下载模型。

Whisper 复用 sherpa-onnx，默认 CPU 推理，无需 PyTorch。配置保持 `language=ja`、`task=transcribe`；模型负责识别日语，现有翻译器负责中文或英文翻译。它仍是实验选项，清晰短样本不能代表音乐和直播场景的准确率。

自备模型时用 `--model-dir` 或 `JLSUBS_WHISPER_MODEL_DIR` 指定目录，放入同一前缀的 `<size>-encoder.int8.onnx`、`<size>-decoder.int8.onnx`、`<size>-tokens.txt`。不支持 `.en` 英语专用模型；一个目录只放一套完整模型。

## 启动与连接

默认 SenseVoice：

```sh
python -m server.app --threads 2
```

服务启动后：

1. 在终端找到本地服务访问令牌。
2. 扩展中选择「本地服务」，地址使用 `ws://127.0.0.1:8765/ws`，填写访问令牌并开始字幕。
3. 也可直接打开 `http://127.0.0.1:8765/` 使用演示页，选择要共享的音源。

默认随机令牌在服务重启后变化。需要固定时，使用 `JLSUBS_ACCESS_TOKEN` 或配置 `access_token`，至少 32 个随机 ASCII 字符。令牌通过第一条 WebSocket 消息发送，不放在 URL 查询参数中。

## 配置

| 项目 | 配置 / 参数 | 默认 |
| --- | --- | --- |
| 识别器 | `asr` / `--asr` / `JLSUBS_ASR` | `sensevoice` |
| 线程 | `asr_threads` / `--threads` / `JLSUBS_ASR_THREADS` | 配置示例为 2；无配置为 4 |
| 识别模型路径 | `model_dir` / `--model-dir` | 按所选引擎查找 `models/` |
| 专名纠错 | `asr_domain` / `--asr-domain` | `gakumas`；可选 `anime` / `off` |
| 自定义词表 | `asr_terms` / `--asr-terms` | 内置词表 |
| 翻译器 | `translator` / `--translator` / `JLSUBS_TRANSLATOR` | 配置示例为 `deepseek`；无配置为 `auto` |
| DeepSeek Key | `deepseek_api_key` / `DEEPSEEK_API_KEY` | 用户提供 |
| DeepSeek 模型 | `DEEPSEEK_MODEL` | `deepseek-chat` |
| DeepSeek 地址 | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| 监听地址 | `host` / `--host` | `127.0.0.1` |
| 端口 | `port` / `--port` | `8765` |

`auto` 在配置 Key 时使用 DeepSeek，否则使用公共 Google 翻译端点，仅供本地试用；`mock` 用于离线检查流程。显式选择 `deepseek` 时必须提供 Key。译文语言由扩展或演示页选择，支持简体中文与英文。

服务默认校验本机 Host、同源网页和扩展来源，所有 WebSocket 客户端均需认证。额外受信 HTTP 主机名使用 `--allow-host example.com`；远程部署需配合 HTTPS 与相应网络访问控制。开发测试页只在 `--dev-assets` 下公开，`config.local.json` 与 `key.local.js` 不通过静态路由提供。

## 用同一音频比较模型

安装 `requirements-dev.txt` 后可运行：

```sh
python tools/test_asr.py testdata/ja_nanami.mp3 --asr sensevoice --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr whisper --threads 2
```

Whisper 的预览至少等待 2 秒语音，间隔至少 2 秒；解码慢时进一步降低预览频率。最终字幕仍由句尾分段触发，较慢的 CPU 或多个音源可能产生积压。

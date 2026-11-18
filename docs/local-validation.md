# Windows 与 RTX 5070 Laptop 验收

使用同一套音频、模型版本和参数记录 CPU、CUDA 与浏览器结果。先验证 SenseVoice 浏览器模式和 CPU 对照，再逐个加载 CUDA 模型。保存报告到 Git 忽略的 `out/`。 [云端验收](phase2-validation.md)

## Python 与 CUDA

在仓库目录打开 PowerShell。确认已安装 Python 3.12 和当前支持 RTX 5070 Laptop 的 NVIDIA 驱动。

```powershell
py -3.12 -m venv .venv
$Python = ".\.venv\Scripts\python.exe"
& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt -r requirements/benchmark.txt
& $Python -m pip check
nvidia-smi
```

每种实验后端使用独立虚拟环境，分别安装模型依赖。使用 PyTorch 的 CUDA 后端时，选择官方支持 Blackwell 的构建，例如带 CUDA 12.8 的兼容版本。安装后验证驱动、版本和设备能力。若 Parakeet 的 NeMo 依赖无法在原生 Windows 解析，可在启用 GPU 支持的 WSL2 中使用独立环境。CTranslate2 所需 CUDA 和 cuDNN 由该后端的版本决定。 [PyTorch 安装](https://pytorch.org/get-started/locally/) · [WSL CUDA](https://docs.nvidia.com/cuda/wsl-user-guide/index.html) · [CTranslate2](https://opennmt.net/CTranslate2/installation.html)

```powershell
& $Python -c "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(), torch.cuda.get_device_capability())"
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv -l 1
```

在另一个终端观察推理过程。记录空闲、加载、第一段、预热后和长段的显存。Windows WDDM 可能只提供全卡显存，报告中注明采样量与测量范围。Benchmark 在支持时采集进程显存和 RSS。

## 模型加载

将 Silero VAD 放在 `models/silero/silero_vad.onnx`。SenseVoice 需要 `model.int8.onnx` 和配套 `tokens.txt`，用已记录的 SHA-256 核对。Whisper Base 下载器会校验多语种 ONNX 文件。CUDA 模型仅使用已检查来源、版本和许可的本地权重。 [文件、摘要与来源](local-service.md) · [模型对照](model-comparison.md) · [第三方许可](../THIRD_PARTY_NOTICES.md)

| 后端 | 安装与部署参数 |
| --- | --- |
| SenseVoice | 基线依赖。使用 `--asr sensevoice --model-dir models/sensevoice-onnx` |
| Whisper Base | `python tools/download_whisper.py` 后使用 `--asr whisper --model-dir models/whisper-base` |
| Parakeet 日语 | 安装 `requirements/parakeet.txt`。使用 `--asr parakeet --model-dir <本地 .nemo> --asr-device cuda --asr-precision float16` |
| Whisper Turbo | 安装 `requirements/whisper-turbo.txt`。使用 `--asr whisper-turbo --model-dir <本地 CT2 目录> --asr-device cuda --asr-precision float16` |
| Qwen3-ASR | 安装 `requirements/qwen3-asr.txt`。使用 `--asr qwen3-asr --model-dir <本地权重目录> --asr-device cuda --asr-precision bfloat16` |

逐个更换 `python -m server.app` 的启动参数。严格验收时追加 `--asr-fallback off`。检查 `/health` 和扩展状态的实际 backend、device、precision 与 Agent 状态。CUDA 试验阶段先使用一个 GPU 后端，并用 `--translator mock` 排除网络时延。直播的第二模型可先选择 CPU Whisper Base，保持默认预算。

## Chrome / Edge

1. 打开 `chrome://extensions` 或 `edge://extensions`，开启开发者模式，加载仓库的 `extension/`。保留同一目录可复用缓存。
2. 开一个有日语声音的普通网页。点击工具栏扩展图标并开始浏览器模式。先留空 Key 验证日语字幕，再按需验证翻译。
3. 确认音频持续播放。用连续短句检验日语预览、final、译文回填和上下句顺序。停止后换语言或页面再开始，旧句不应出现在新会话。
4. 启动本地服务，使用 `ws://127.0.0.1:8765/ws` 和 `out/access-token` 中的令牌。分别请求本地快速与增强模式，检查实际模型、回退与复查提示。
5. 测试词库手动、自动命中、未知标题和保守回退。在没有用户授权的环境中保持远程音频关闭。工作台可在同源页面复测 AudioWorklet 和 WebSocket。 [工作台与自动检查](development.md)

## 授权样本与参考

从允许保存并用于评估的来源取得音频。记录权利方、出处、原录音 ID、许可或授权、使用范围和日期。遵守平台条款与参与者同意。样本、凭据、私有节目清单和审核库留在本机。

覆盖单人、多人、抢话、音乐、快语速、普通词与同音专名。按原始录音或节目分组划分开发、审核和独立测试，避免相邻段、重复片段和同一录音进入多个集合。用节目官方资料核对演员、角色、歌曲和昵称。由人工独立听写，保留可核验的日语表记、实体及审核人。有争议的段落保留待核验状态。标记合成与真人语料。 [清单格式](../testdata/benchmark/README.md) · [审核和训练数据约定](agentic-asr.md)

## 评估命令

先按 Benchmark 文档生成 v2 清单。对同一清单跑固定词表、动态词表、Agent 和多轮翻译组。独立 ASR 可用下列命令。每组使用不同的输出路径。

```powershell
& $Python tools/benchmark.py asr out/manifest.json --model sensevoice=models/sensevoice-onnx --threads 2 --repeat 3 --output out/cpu-sensevoice.json
& $Python tools/benchmark.py asr out/manifest.json --model whisper-turbo=models/whisper-turbo --device cuda --precision float16 --threads 2 --repeat 3 --output out/gpu-turbo.json
& $Python tools/benchmark_vad.py out/manifest.json --output out/vad.json
$env:JLSUBS_ACCESS_TOKEN = (Get-Content out/access-token -Raw).Trim()
& $Python tools/benchmark.py stream out/manifest.json --domain auto --agent on --context-turns 3 --score --output out/live-agent.json
Remove-Item Env:JLSUBS_ACCESS_TOKEN
```

专名准确率同时看 CER、实体 Precision、Recall 和 F1，以及同音普通词的误改。复查效果结合有人工参考的前后 CER、误改率与新增等待 P50/P95、复查超时率。用目标 GPU 重新测 RTF、显存、最终字幕及端到端时延。真实翻译需要独立参考及明确的 API 使用权限。 [五组对照与分母](benchmark.md)

## 排查与回滚

| 现象 | 操作 |
| --- | --- |
| CUDA 不可用或显存不足 | 查看驱动、运行时版本和设备探针。只加载一个 CUDA 模型，记录失败，再用已验证的 CPU 配置对照 |
| 服务拒绝连接 | 确认地址、服务终端及令牌文件。远程服务要求 WSS 和显式音频授权 |
| 日语正常，译文缺失 | 检查 Key、额度和翻译器状态。用 `--translator mock` 验证译文回填链路 |
| 第二模型未加载或复查超时 | 查看实际状态及 `stats.agent`。停用 `--agent` 或用离线修订命令 |
| 专名误改 | 暂时关闭词库或只启用已验证的企划。把问题加入独立审核 |
| 升级后需要恢复 | 用稳定提交创建独立工作树，在旧配置启动 CPU SenseVoice 或通过浏览器重新加载稳定版目录。保留现有模型与审核备份 |

使用 `git revert <SHA>` 可在维护分支回滚具体功能。复查可用 `--no-agent` 关闭，日语识别可独立验证。 [版本控制](version-control.md)

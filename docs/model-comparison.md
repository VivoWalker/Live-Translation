# 日语 ASR 模型与运行条件

下表记录模型卡、下载制品和本项目调用的接口。下载体积按公开仓库元数据计算。显存受设备、精度、音频长度和运行时影响，需在目标机器实测。

| CLI | 运行时与权重 | 下载体积 | 可用能力 |
| --- | --- | --- | --- |
| `sensevoice` | sherpa-onnx CPU / WASM int8，FunASR 模型许可 | int8 约 239 MB | 本项目默认，滚动预览 |
| `whisper` | sherpa-onnx CPU int8，OpenAI Whisper 模型 MIT | 取决于现有 ONNX 导出 | 多语种 base 已接入，滚动预览 |
| `parakeet` | NVIDIA `parakeet-tdt_ctc-0.6b-ja`，NeMo `ASRModel.restore_from`，CC BY 4.0 | 2.49 GB | 日语，CPU FP32 / CUDA FP16、FP32，滚动预览 |
| `whisper-turbo` | OpenAI Large V3 Turbo，faster-whisper / CTranslate2 本地转换，MIT | 参考转换 1.62 GB | 日语、提示词、分块时间戳，CPU INT8 / CUDA FP16、INT8-FP16 |
| `qwen3-asr` | Qwen3-ASR-1.7B，`qwen-asr==0.0.6` Transformers 本地后端，Apache-2.0 | 约 4.70 GB | 日语和提示词，CPU FP32、BF16 / CUDA BF16、FP16、FP32 |

保留 ReazonSpeech NeMo V2 和 Kotoba-Whisper V2.0 供后续对照。两者公开模型卡均声明 Apache-2.0，参考权重分别为 2.48 GB 和 1.51 GB。前者的 ReazonSpeech 接口可返回带时间戳的结果，后者提供 Transformers ASR pipeline。

所有服务端适配器均在 VAD 分段上执行离线推理。服务按能力决定是否调用滚动预览，较重的 Turbo 与 Qwen 默认只转写最终段。预览等待队列中有最终任务时会跳过，已经开始的原生推理会执行到完成。Qwen 的时间戳需要另外加载对齐模型，本项目默认单模型工作。

作为直播第二模型时，CPU Turbo 和 Qwen 默认不加载，离线修订允许更长的预算。需要验证实时可行性时，可用 `--agent-budget-ms` 显式试跑，观察达到 deadline 的比例和复查附加时延。部署进程报告实际后端和第二模型状态。 [Agent 复查](agentic-asr.md) · [Windows / RTX 本地验收](local-validation.md)

RTX 5070 Laptop 8 GB 的优先试验顺序为单独运行 Parakeet 或 Turbo，再用短片段验证 Qwen 的 BF16 峰值。CUDA PyTorch、CTranslate2 所需 CUDA/cuDNN 与驱动兼容性应从安装环境验证。重量模型适配器属于实验配置，只有相同数据和硬件的实测结果才能支持准确率或资源结论。

Parakeet 的 CPU 测试使用 NeMo 2.5.3、PyTorch/torchaudio 2.8.0 CPU 与 PyArrow 23.0.1。安装前可按设备选择匹配的 PyTorch 和 torchaudio 构建。 [PyTorch 安装方式](https://pytorch.org/get-started/locally/)

[SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) · [NVIDIA 日语 Parakeet](https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja) · [OpenAI Whisper](https://github.com/openai/whisper) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [Turbo 转换](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo) · [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) · [Qwen 1.7B 权重](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) · [ReazonSpeech](https://huggingface.co/reazon-research/reazonspeech-nemo-v2) · [Kotoba-Whisper](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0)

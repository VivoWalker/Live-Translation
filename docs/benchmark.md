# 本地 Benchmark

安装基线与评估依赖，并准备具有合法来源、按同一规则校对的音频。本地研究样本与私有清单可放在 Git 忽略的 `out/` 目录。

```sh
python -m pip install -r requirements.txt -r requirements/benchmark.txt
python tools/import_benchmark.py out/clips --output out/manifest.json --name "研究样本" \
  --labels out/checked-transcripts.txt --source "来源" --license "本地评估授权"
python tools/benchmark.py asr out/manifest.json --threads 2 \
  --model sensevoice=/path/to/sensevoice-onnx --model whisper=/path/to/whisper-base --output out/asr.json
python tools/benchmark_vad.py out/manifest.json --output out/vad.json
```

每个模型单独启动进程，使用相同文件、音频转换、线程数、词包和预热次数。报告包含清单及音频的 SHA-256、实际设备、精度、模型、加载时间和 CPU/GPU 环境。默认关闭词包，启用时用 `--packs` 审计选项。默认报告只保留指标。明确需要比较具体输出时可加 `--include-text`。 [清单格式](../testdata/benchmark/README.md)

## 指标

| 指标 | 定义 |
| --- | --- |
| 原始 CER | 对适配器返回的原始转录计算 Unicode 码点编辑距离。另报告实际字幕表记的 CER |
| 规范化 CER | NFKC 后去掉 Unicode 空白，保留标点、大小写和书写内容 |
| WER | 按 Janome 0.5.0 词元切分规范化日语，汇总编辑数与参考词元数 |
| 实体 | 对预设术语表执行最长不重叠字面匹配，按出现次数报告 Precision、Recall 和 F1 |
| ASR RTF | 识别阶段耗时之和除以音频时长，预热和载入独立统计 |
| 内存 | RSS 每 0.5 秒采样。可用时以 `nvidia-smi` 采样进程显存 |
| VAD | 在同一最终识别路径扫描 9 组静音与时长设置，报告输出数、强制切分和以音频采样点计的检测延迟 |
| 翻译 | 使用 SacreBLEU chrF 对独立中英译文评估，并报告缺失比例 |
| DER | 零宽容边界，整段音频计分，保留重叠说话 |

没有可核验参考转录的样本仍可做速度和链路测试。对应的准确率字段为 `null`。

## 端到端与稳定性

先启动本地服务并配置同一访问令牌。可使用 mock 翻译验证链路。要测在线服务延迟时，应明确启用对应服务商并使用允许传输的台词。默认连接 loopback。

```sh
python tools/benchmark.py stream out/manifest.json --server-pid 12345 --output out/stream.json
python tools/benchmark.py translation out/manifest.json --target zh --predictions out/zh.json
python tools/benchmark.py diarization out/manifest.json --predictions out/turns.json
```

每条音频通过新认证会话按 100 ms PCM 实时送入。主机停顿后从实际发送时刻继续定速。finalization 延迟从发送包含音频端点的帧到接收 final，翻译延迟从接收 final 到收到同一 ID 的译文，P50/P95 使用最近秩。丢失率比较服务器统计的 final 与完整接收的 final，无法取得最终统计的连接单独报告关闭状态。译文缺失率以实际收到的 final 为分母。报告记录积压、异常后新会话恢复和服务进程 RSS。浏览器持续运行使用独立的 Chromium 检查。 [浏览器验证](development.md)

译文预测文件是按片段 ID 索引的 JSON 字符串对象。说话人预测按同样 ID 索引区间数组。录播 DER 需要安装说话人评估依赖。测试样本的领域、硬件、词包或流程变化后，应以新的报告为准。

## 实测样本

本地评估选用了 JSUT Basic5000 的 `BASIC5000_4501` 至 `BASIC5000_4512`，共 12 条单人真人朗读。使用同一版本的发布转录及音频、2 线程、1 次预热和关闭词包。环境为 Xeon Platinum 8573C、3 个逻辑 CPU、Python 3.12.14。数据和参考不随项目再发布。 [固定样本版本与使用条款](https://huggingface.co/datasets/FluidInference/JSUT-basic5000/tree/cd13cc9c9fe70d8d4f62ffe6fbbb872aef79835c)

| CPU 模型 | 后端原始 CER | 规范化字幕 CER | Janome WER | RTF | 解码 P95 | 采样 RSS 峰值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SenseVoice INT8 | 14.50% | 13.31% | 19.32% | 0.108 | 1.09 s | 497.5 MiB |
| Whisper Base INT8 | 37.57% | 37.57% | 45.41% | 0.396 | 4.19 s | 608.3 MiB |
| Parakeet 日语 FP32 | 15.38% | 15.38% | 18.84% | 0.213 | 2.22 s | 5731.5 MiB |
| Whisper Turbo INT8 | 16.27% | 16.27% | 22.22% | 3.014 | 19.46 s | 2115.1 MiB |

在同一批音频上，0.4、0.6、0.8 秒静音配置的检测延迟 P50 分别为 460、660、840 ms。8 秒上限产生一次强制切分，12 和 16 秒配置各生成 12 条 final。此结果保留默认 0.4 / 12 秒作为对照。直播专名、背景音乐、抢话、多轮翻译与说话人准确率需要对应的留出数据。

使用 SenseVoice CPU、1 倍发送速率和 mock 翻译完成 12 个 WebSocket 会话，收到 12 条 final 和 12 条译文。finalization P50/P95 为 1,010/1,683 ms，mock 译文回填为 0.3/3.7 ms。观察到的最终字幕丢失、译文缺失和队列溢出均为 0。服务采样 RSS 峰值约 412 MiB。

# Phase 2 云端验收

验证日期为 2026-11-18。以 GitHub `main` 的 `15831d40cbcef34d873ddf9c2ecadeb13761471c` 为基线，在独立工作树 `feature/agentic-asr-phase2` 开发。原工作树保留在 `feat/domain-lexicon-packs`。

## 基线与环境

Python 3.12.14、Node.js 24.22.1、npm 11.9.0、Chromium 156。项目虚拟环境主要依赖为 sherpa-onnx 2.0.1、NumPy 2.5.5、aiohttp 3.14.5、websockets 17.4 和 SoundFile 0.14.0。评估另装 Janome 0.5.0、SacreBLEU 2.6.0 和 psutil 7.2.2。基础依赖通过 `pip check`。CPU 为 Xeon Platinum 8573C，环境报告 3 个逻辑 CPU，CPU 配额为 2 核。未检测到 NVIDIA GPU。

| 修改前检查 | 结果 |
| --- | --- |
| Python unittest | 86 通过，测试耗时 5.48 秒 |
| Node.js 单元测试 | 68 通过，约 3.16 秒 |
| Chromium 页面和模拟扩展 Runtime | 18 通过，约 18.04 秒 |
| Benchmark 指标单元测试 | 4 通过，测试耗时 0.02 秒 |

允许回环网络后完成真实 HTTP、WebSocket 和 Chromium 检查。普通隔离执行环境的初次 Chromium 运行因监听 loopback 被拒绝，属于环境限制。

交付验收通过 114 项 Python 和 75 项 JavaScript。Python 分项含 Agent 12 项、审核 6 项、WebSocket 6 项、Benchmark 7 项、安全 18 项。最终轻量 Chromium 页面检查通过 19 项，另外通过 AudioWorklet 工作台链路。验收同时执行了 JS 语法、工作流静态检查、扩展 ZIP 完整性和文档链接检查。

## 功能与验证范围

| Phase | 验证结果 |
| --- | --- |
| 0–1 | 建立独立分支和阶段提交。Actions 配置通过 actionlint。包含 Python、Node、Chromium、每周 Mock 压测和经检查的标签制品 |
| 2 | 实时自适应复查和离线对照。Mock 100/450 ms 用例完成。2/20 秒慢模型超过预算时立即回退且保持推理槽。验证并发、异常和停止后隔离 |
| 3–4 | Python/JavaScript 共用专名证据、上下文和节目选择契约。文本用例覆盖同音普通词、歌名、昵称、跨企划、未知标题及未核验候选 |
| 5 | SQLite 迁移、备份与拒绝保留。候选在合成人工参考测试夹具上完成 CER/F1 门控。训练索引严格按录音组划分 |
| 6 | v2 清单、无参考性能报告、五组对照、真实 CPU ASR 和 Mock 评估。独立目标直播参考和精度增益待实测 |
| 7 | 测试原生解码变慢、输出堵塞、音频溢出、断线恢复、迟到预览及乱序译文。Chromium 工作台通过停止、重启、语言切换 |
| 8–9 | 缺失 Parakeet 权重时回退到真实 CPU SenseVoice。缺失第二权重和关闭翻译时仍输出日语。验证远程音频授权、访问令牌及固定翻译消息结构 |
| 10 | 更新服务、模型、Benchmark、审核和发布文档，并提供 Windows GPU 验收步骤 |
| 11–12 | 详细提交历史可按下文命令复核 |

Chromium 完成 22 项界面、Mock Runtime、资源和真实 WASM 检查。真实 SenseVoice WASM 运行 2 轮启停。连续加速播放 595.5 秒演示音频，输出 128 条 final 与 128 条 Mock 译文，WASM 线性内存保持 512 MiB。工作台另通过真实 Chromium AudioWorklet、认证 WebSocket、Mock ASR/翻译的会话验收。云端管理员策略禁用加载未打包扩展，工具栏 `tabCapture` 验收留待可加载扩展的浏览器。 [Chrome/Edge 安装](local-validation.md)

## 实测性能

CPU 和真实流式对照使用仓库合成演示音频 `web/static/sample-ja.wav`，SHA-256 为 `dd230cf96c465e5bc9158e8b7229cea546e8142f64a889cb5a6bfc99e8ab4950`，时长约 7.7 秒。无参考转录，CER、WER 与 Entity F1 留空。独立模型测试使用 2 线程、1 次预热、3 次解码及相同音频。P50/P95 均使用最近秩。

| CPU 模型 | RTF | 解码 P50/P95 | 采样 RSS 峰值 |
| --- | ---: | ---: | ---: |
| SenseVoice INT8 | 0.0673 | 526.1 / 535.2 ms | 361.9 MiB |
| Whisper Base INT8 | 0.2364 | 1759.1 / 2020.8 ms | 456.6 MiB |

| 同一服务的流式组 | ASR RTF | Final P50/P95 | 译文 P50/P95 | 端到端 P50/P95 |
| --- | ---: | ---: | ---: | ---: |
| 无词表 | 0.254 | 720.6 / 739.8 ms | 0.3 / 2.8 ms | 723.5 / 740.1 ms |
| 固定词表 | 0.217 | 559.5 / 749.7 ms | 0.0 / 0.5 ms | 560.0 / 749.7 ms |
| 动态词表 | 0.228 | 564.8 / 715.4 ms | 0.1 / 0.3 ms | 564.9 / 715.7 ms |
| 动态词表和 Agent | 0.216 | 577.6 / 693.1 ms | 0.2 / 0.3 ms | 577.8 / 693.4 ms |
| Agent 和多轮上下文 | 0.203 | 555.0 / 755.9 ms | 0.3 / 0.4 ms | 555.3 / 756.3 ms |

五组在真实 SenseVoice、已加载的 CPU Whisper Base 和 Mock 翻译下各收到 2 条 final 及 2 条对应译文，合计译文缺失和最终字幕丢失均为 0/10，队列溢出为 0。直播两组 Agent 分别为 0/2 次复查，超时率和采纳率分母为零。复查启用时的 final 额外等待 P95 分别为 1.0 ms、0.4 ms。服务 RSS 峰值约 529.8 MiB。真实模型离线修订工具也完成了该样本。此样本只验证连通与延迟测量。

Mock WebSocket 用 250 ms 的后端、80 ms 的等待预算，收到 3 条 final 和 3 条译文。复查触发 1/3，超时 1/1，等待 P95 81.7 ms。最终字幕 P50/P95 为 109.1/188.9 ms。第一次超时后的长执行得到正确记录，后续复查按策略跳过。

| 加速 Mock 音频量 | Final 与译文 | 实际运行时间 | 初末 RSS 差 |
| --- | ---: | ---: | ---: |
| 10 分钟 | 644 / 644 | 1.95 秒 | +1.46 MiB |
| 30 分钟 | 1984 / 1984 | 5.82 秒 | +1.46 MiB |
| 60 分钟 | 3993 / 3993 | 11.99 秒 | +1.60 MiB |

三组压测各包含一段无静音长语音和连续短句，观察到的重复 final、错配译文和溢出均为 0。译文缓存最高 500 条，60 分钟组峰值音频队列 32 KiB，进程 CPU 4.60 秒。该压测用桩替代 Silero、ASR 和翻译，用加速喂入验证队列及内存状态。

## 余项

- 云端可继续扩充公开授权的多人语料，做更长的真实时钟 WebSocket 压测和实际翻译供应商对照。本轮未调用真实 DeepSeek。
- 用 Windows / RTX 5070 Laptop 验证 CUDA 推理和进程显存，完成 Chrome/Edge 工具栏采集。真实声优直播的重叠语音、背景音乐、专名准确率与复查净收益需要授权样本与独立标注。
- 监督微调、自动模型发布、实时说话人识别和高级持续学习留作后续工作。当前仅提供严格的人工标注索引和手动批准的词表发布流程。 [本地验收](local-validation.md)

```sh
git status --short --branch
git log --reverse --oneline 15831d40cbcef34d873ddf9c2ecadeb13761471c..HEAD
```

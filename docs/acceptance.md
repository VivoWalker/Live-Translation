# Live Translation 开发验收

验收日期为 2026-11-18。开发分支为 `feature/agentic-asr-improvements`，基线为 `7112fe9d199a97a1ccfd39b003ae5f57837dc6d7`，代码验收点为 `b18a9d0`。提交留在本地开发分支。

## A 阶段状态

| Phase | 状态 | 已交付和验证边界 |
| --- | --- | --- |
| 0 Git 与基线 | Completed | 从干净工作区创建开发分支。基线虚拟环境通过 60 项 Python、58 项 JavaScript。系统 Python 因缺少 sherpa_onnx 有 5 个模块导入错误。 |
| 1 翻译生命周期 | Completed | 每段独立任务与快照，有界并发、乱序回填、限次重试、过载状态、超时及会话取消均有回归。 |
| 2 音频与 WebSocket | Partially Completed | 有界音频、优先事件、Silero 参数及重叠、真实 WASM 和 WebSocket 通过。管理员策略阻止实装扩展的标签页采集验收。 |
| 3 多模型 ASR | Partially Completed | SenseVoice、Whisper Base、Parakeet、Turbo、Qwen 适配与 CPU 实跑已完成。CUDA、RTX 5070 Laptop 8 GB 和后备实验候选待验证。 |
| 4 动态领域术语 | Completed | 五词包兼容、标题自动选择、节目目录、已核验词条、规范名保护和审计出处已实现。 |
| 5 Agent 与学习 | Partially Completed | 复查预算、独立模型证据、超时回退、人工审核和留出门槛已实现。目标直播的纠错收益、音乐与重叠语音判别待评估。Slow Loop 微调及模型自动发布已延后。 |
| 6 多轮翻译 | Completed | 默认保留上一句协议，可选 3–5 句与中英译名。两种真实提示格式均已发起请求，译文质量需独立参考。 |
| 7 说话人分离 | Partially Completed | 录播命令、匿名标签、重叠表示和 DER 指标已实现。运行真实 Community-1 权重需取得模型访问，实时分离已延后。 |
| 8 Benchmark | Partially Completed | 四模型 A/B、九组 VAD、独立端到端计时与回归已跑。已有 12 条 JSUT 真人朗读，60–120 条目标直播及中英和说话人参考仍待合法建集。 |
| 9 体验和配置 | Partially Completed | 弹窗三模式、领域设置、Agent、分段和回退提示已验证。模型由本地服务启动参数选择，说话人分离入口为本地录播命令。 |
| 10 文档 | Completed | 更新架构、配置、模型、许可、审核、Benchmark、回滚和变更日志。 |
| 11 隐私和资源 | Completed | 访问令牌文件、远程音频明确授权、日志脱敏、翻译响应上限和默认日语回退已验证。Google 公共翻译可显式启用。 |
| 12 最终核验 | Completed | 执行可运行的回归及实测，保留受阻项与每阶段历史。 |

## B 本地提交

下表从基线列到代码验收点。验收报告作为随后独立的文档提交。

| SHA | Conventional Commit | 文件数 | 相关验证 |
| --- | --- | ---: | --- |
| `d06987c` | `docs(architecture): record the verified development baseline` | 1 | 基线 Python 60、JS 58 |
| `ace8788` | `fix(streaming): preserve translation jobs and final context by segment` | 8 | Python 61、JS 60 |
| `2bbe3c9` | `fix(ws): bound audio and prioritize finalized subtitle delivery` | 20 | Python 64、JS 62；Chromium WASM 连续运行 |
| `592c373` | `feat(asr): add optional Japanese backends and bounded decode scheduling` | 14 | Python 69、JS 62；Turbo CPU 转写 |
| `44d9e25` | `feat(domain): select verified program terminology per session` | 15 | Python 71、JS 64 |
| `b775424` | `feat(agent): verify selected hypotheses and gate local review candidates` | 9 | Python 75、JS 64 |
| `20d1626` | `feat(translation): add bounded conversation history and target glossaries` | 12 | Python 76、JS 65 |
| `1578a6a` | `feat(diarization): add optional offline speaker annotation` | 5 | Python 78、JS 65；本地接口桩 |
| `c8e66df` | `feat(benchmark): add reproducible local ASR and streaming evaluation` | 11 | Python 82、JS 65；四模型 A/B、Silero 扫描 |
| `309b1ac` | `feat(extension): expose recognition modes and advanced capture settings` | 13 | Python 83、JS 66 |
| `0ea8079` | `docs(architecture): document model deployment and evaluation results` | 5 | 文档相对链接和差异检查 |
| `245688e` | `fix(privacy): require remote audio opt-in and keep tokens out of logs` | 23 | Python 86、JS 68；DeepSeek 真实请求 |
| `da8891e` | `fix(asr): record compatible NeMo runtime and allow CPU BF16 for Qwen` | 3 | 26 项 ASR 测试；Parakeet 和 Qwen CPU 实跑 |
| `7efbe0c` | `fix(web): isolate translations across target language acknowledgements` | 5 | 17 项服务安全测试；Chromium 演示页语言切换 |
| `ded107c` | `test(benchmark): pace realtime frames and probe translation context` | 5 | 4 项指标测试；12 次真实 WebSocket 和 8 次提示对照 |
| `b18a9d0` | `test(browser): verify advanced settings and demo caption lifecycle` | 3 | 21 项 Chromium 检查；演示页播放、回填、语言切换和停止 |

<details>
<summary>各提交涉及的文件</summary>

- `d06987c` `docs/version-control.md`
- `ace8788` `CHANGELOG.md`、`docs/translation.md`、`extension/asr-engine.js`、`server/app.py`、`server/streaming.py`、`tests/extension.test.mjs`、`tests/test_translation_cache.py`、`tests/test_translation_timing.py`
- `2bbe3c9` `CHANGELOG.md`、`docs/development.md`、`docs/local-service.md`、`extension/asr-engine.js`、`extension/background.js`、`extension/offscreen.js`、`extension/pcm-worklet.js`、`extension/popup.js`、`server/app.py`、`server/asr.py`、`server/streaming.py`、`server/text.py`、`server/ws_events.py`、`tests/extension.test.mjs`、`tests/test_asr.py`、`tests/test_security.py`、`tests/test_translation_timing.py`、`tests/test_ws_events.py`、`web/static/app.js`、`web/static/pcm-worklet.js`
- `592c373` `CHANGELOG.md`、`docs/local-service.md`、`docs/model-comparison.md`、`requirements/parakeet.txt`、`requirements/qwen3-asr.txt`、`requirements/whisper-turbo.txt`、`server/app.py`、`server/asr.py`、`server/asr_backends.py`、`server/asr_router.py`、`server/streaming.py`、`tests/test_asr_backends.py`、`tests/test_ws_events.py`、`tools/test_asr.py`
- `44d9e25` `CHANGELOG.md`、`docs/asr-domain.md`、`extension/asr-domain.js`、`extension/asr-engine.js`、`extension/asr-terms/episodes.json`、`extension/background.js`、`extension/offscreen.js`、`server/app.py`、`server/asr.py`、`server/asr_domain.py`、`server/episodes.py`、`server/streaming.py`、`tests/asr-domain.test.mjs`、`tests/extension.test.mjs`、`tests/test_episodes.py`
- `b775424` `CHANGELOG.md`、`docs/agentic-asr.md`、`server/app.py`、`server/asr_agent.py`、`server/asr_review.py`、`server/streaming.py`、`server/text.py`、`tests/test_asr_agent.py`、`tools/review_asr.py`
- `20d1626` `CHANGELOG.md`、`docs/translation.md`、`extension/asr-engine.js`、`extension/asr-terms/translation.json`、`extension/background.js`、`extension/offscreen.js`、`server/app.py`、`server/conversation.py`、`server/streaming.py`、`server/translate.py`、`tests/extension.test.mjs`、`tests/test_translation_cache.py`
- `1578a6a` `CHANGELOG.md`、`docs/local-service.md`、`requirements/diarization.txt`、`server/diarization.py`、`tests/test_diarization.py`
- `c8e66df` `CHANGELOG.md`、`docs/benchmark.md`、`requirements/benchmark.txt`、`server/benchmark.py`、`server/streaming.py`、`testdata/benchmark/README.md`、`tests/test_benchmark.py`、`tools/benchmark.py`、`tools/benchmark_stream.py`、`tools/benchmark_vad.py`、`tools/import_benchmark.py`
- `309b1ac` `CHANGELOG.md`、`docs/local-service.md`、`extension/background.js`、`extension/offscreen.js`、`extension/popup.css`、`extension/popup.html`、`extension/popup.js`、`server/app.py`、`server/asr.py`、`server/asr_backends.py`、`server/streaming.py`、`tests/extension.test.mjs`、`tests/test_security.py`
- `0ea8079` `README.md`、`THIRD_PARTY_NOTICES.md`、`docs/architecture.md`、`docs/benchmark.md`、`docs/development.md`
- `245688e` `CHANGELOG.md`、`README.md`、`docs/local-service.md`、`docs/translation.md`、`extension/asr-engine.js`、`extension/background.js`、`extension/offscreen.html`、`extension/offscreen.js`、`extension/popup.css`、`extension/popup.html`、`extension/popup.js`、`extension/service-url.js`、`server/app.py`、`server/security.py`、`server/streaming.py`、`server/translate.py`、`tests/extension.test.mjs`、`tests/test_security.py`、`tests/test_translation_cache.py`、`tools/content_check.mjs`、`tools/simulate.py`、`web/index.html`、`web/static/app.js`
- `da8891e` `docs/model-comparison.md`、`requirements/parakeet.txt`、`server/asr_backends.py`
- `7efbe0c` `CHANGELOG.md`、`docs/development.md`、`server/app.py`、`tests/test_security.py`、`web/static/app.js`
- `ded107c` `docs/benchmark.md`、`docs/translation.md`、`tools/benchmark.py`、`tools/benchmark_stream.py`、`tools/test_translate.py`
- `b18a9d0` `docs/development.md`、`tools/browser_check.mjs`、`tools/content_check.mjs`

</details>

## C 测试与实测

| 检查 | 结果 |
| --- | --- |
| Python 3.12.14 | 项目虚拟环境通过 86 项测试。 |
| Node.js v24.22.1 | 通过 68 项测试。 |
| Chromium | 21 项通过。包含 10,000 次字幕更新、100 次重建、2 轮真实 WASM 启停和 595.5 秒连续识别。连续阶段产出 128 条 final 和 128 条测试译文，WASM 内存保持 512 MiB。 |
| Chromium 模型缓存 | 使用真实 Cache API、完整摘要和两个进程。首次 3 个模型文件下载，重启下载 0 次。此检查的 WASM 识别接口使用桩。 |
| Chromium 演示页 | 真实 AudioWorklet、认证 WebSocket、SenseVoice 和 mock 译文。观察到 15 次字幕更新，从中文切换到英文后有译文，停止状态正常。缺失 Parakeet 权重时启动回退到 SenseVoice，令牌写入临时文件。 |
| 标签页扩展实装 | 管理员策略返回 `Loading of unpacked extensions is disabled by the administrator.`。工作台演示与 WASM 检查已完成，Chrome/Edge 工具栏 `tabCapture` 实装仍受阻。 |
| CPU ASR | 12 条 JSUT 真人朗读、2 线程、同一参考和预热条件。四模型 CER、WER、RSS、RTF 与耗时见 Benchmark。Qwen3-ASR CPU BF16 在独立 7.70 秒演示音频上完成转写，解码 18.39 秒。 |
| VAD | 9 组参数全部运行。0.4、0.6、0.8 秒设置的检测 P50 为 460、660、840 ms。8 秒上限在样本中触发一次切分，默认仍为 0.4 秒和 12 秒。 |
| 真 WebSocket 与 mock 翻译 | 修正回放节奏后，12 次认证、12 条 final 和 12 条译文全部完成。观察到的 final 丢失和译文缺失均为 0。finalization P50/P95 为 1,010/1,683 ms，mock 回填为 0.3/3.7 ms。 |
| 真 WebSocket 与 DeepSeek | 仓库合成演示音频经本地 SenseVoice 输出 2 条 final，两条均收到真实译文。finalization P50/P95 为 785/1,826 ms，DeepSeek 回填为 688/1,149 ms。 |
| DeepSeek 提示对照 | 中文和英文字稿各 4 次请求均完成。两组样本各对照单轮与多轮，使用合成台词和 HTTPS 环境代理。 |
| 译文和说话人评分 | 合成参考验证了 chrF 100，以及匿名标签交换且包含重叠时 DER 0。真实直播的这两个结果需要已核验参考。 |
| CUDA / VRAM | 当前环境无 CUDA GPU，显存测量和 RTX 5070 Laptop 验收待运行。 |

首轮实时回放有一条以 1013 关闭，下一会话成功。回放器调整为按实际发送时间继续定速，复测完成所有会话。拥塞强制关闭和恢复另有真实协议回归。 [指标和 CPU 对照](benchmark.md) · [翻译对照](translation.md) · [浏览器检查](development.md)

## D 架构变化

连续语音的 final 先固定独立上下文，再提交有界翻译。PCM 经有界工作线程和 VAD 序列后送入浏览器 SenseVoice 或本地后端。节目范围限定纠错，Agent 只对少量可疑片段启动第二次本机识别。关键事件按发送顺序投递，网页按 ID 处理译文。后端加载按部署配置选择并报告回退。 [修改前后架构](architecture.md)

## E 后续验收边界

- 授权的目标直播、演员多人交谈、背景音乐、重叠音频和独立参考仍需采集。当前 JSUT 结果只支持这批朗读音频上的观察。直播 CER、实体 F1、Agent 准确率增益与翻译质量均待评估。
- Chromium 管理员策略限制未打包扩展。工具栏和 Edge 仍需在可加载扩展的测试环境验收。GPU、真实 Community-1 与实际 DER 同样需要相应环境或模型访问。
- 当前复查信号包括重复、强制切分、音量或削波和节目术语。Slow Loop 训练、模型发布和回滚自动化已延后。审核记录默认关闭，监督数据需独立核验与授权。 [审核与限制](agentic-asr.md)
- 远程音频出口改为显式授权和 WSS。本地缺少 DeepSeek Key 时只显示日语，也可主动选择 Google 公共翻译。 [服务配置](local-service.md)

## F 最终 Git 核验

开发分支的代码和文档均按阶段提交。使用以下命令获取包含验收报告提交的完整范围与工作区状态。

```sh
git status
git branch --show-current
git log --oneline -15
git log --oneline 7112fe9..HEAD
```

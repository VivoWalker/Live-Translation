# 本地 ASR 复查与审核

服务通过 `--agent` 启用复查。可用 `--agent-secondary` 和 `--agent-model-dir` 指定第二模型，识别与复查均在本机执行。第二模型加载失败时，主模型和翻译继续运行。使用 `--no-agent` 停用复查。

```sh
python -m server.app --agent --agent-secondary whisper --agent-model-dir /path/to/whisper --agent-audit out/asr-review.sqlite
```

Agent 观察强制切分、异常重复、低音量或削波，以及节目术语的可疑读音。实时模式优先复查已核验名称的读音、明显重复或同时触发切分与音质异常的片段。片段上限为 8 秒，服务全局每 5 秒最多启动一次。复查使用一个独立推理槽，主模型忙碌、音频积压或槽位尚未释放时直接跳过。

默认实时预算按模型选取，SenseVoice 450 ms、Whisper Base 550 ms、Parakeet 650 ms、Turbo 750 ms、Qwen3 900 ms。CPU Turbo 和 Qwen3 默认走离线复查，可用 `--agent-budget-ms` 显式开启限时试跑。调度参考近 16 次完成的推理，在相近片段上预测明显超预算时降频，每 60 秒可试探一次。连续超时触发 15–120 秒冷却。直播等待预算为 100–1500 ms。超时、停止或配置变化只结束等待，原生推理槽随线程实际结束释放。

有预算时先发出原假设预览，再以同一分段 ID 确认 final。第二模型从原音频得到独立假设。只有单一替换与已核验的节目术语、读音及第二假设一致时，才采用新写法。冲突、超时、模型故障或缺少证据时保留主模型结果。每段 final 只提交一次翻译。

### 离线修订

```sh
python tools/refine_asr.py out/manifest.json --model sensevoice=/models/sensevoice \
  --secondary whisper=/models/whisper --output out/refined.json
```

按清单顺序处理已分段音频。相邻且同来源、同节目的片段共享主识别上下文。第二模型的独立假设使用相同证据规则；可重复指定 `--secondary` 让两个独立模型一致时才采用修订。默认预算为 30 秒，Qwen3 为 60 秒，可用 `--budget-ms` 调整。复查片段最多 60 秒。结果写入本地文件，可选 `--review` 加入审核。该命令对直播事件和翻译无副作用。

### 指标口径

- `segments_total` 统计进入 Agent 的非空主模型片段，`segments_flagged` 统计触发风险的片段。`secondary_attempts / segments_total` 是触发率。`secondary_skipped` 含按原因统计的未启动复查。
- 超时率和二次纠错采纳率均以已启动的复查数为分母。推理失败和等待超时可以发生在同一次复查。采纳率衡量决策行为，准确率变化需独立参考转录。
- `secondary_inference_ms` 是完成原生推理的总毫秒数，含超时后完成、执行失败和会话停止后完成的调用。平均值以完成数为分母。等待时间以完成决策的片段为分母，未复查片段计 0，P95 使用最近 256 次观察。每条 final 的 `verification_wait_ms` 记录从启动 Agent 到决定 final 的实际额外等待。
- `corrections_accepted` 含安全词库与复查采纳的片段，`uncertain_decisions` 和 `fallback_count` 分别统计不确定决策与回到主结果的次数。没有分母的比率返回 `null`。

## 人工审核

配置 `--agent-audit` 后，SQLite 保存最多 512 条最近决策，包含原始转录、主模型结果、提议、来源和理由。审阅人员听取有授权的原始材料并核验完整转录。数据库位于本地文件系统，服务默认关闭审核持久化。

```sh
python tools/review_asr.py out/asr-review.sqlite list --status pending
python tools/review_asr.py out/asr-review.sqlite accept 12 --reference '已人工核验的日语转录'
python tools/review_asr.py out/asr-review.sqlite reject 13
python tools/review_asr.py out/asr-review.sqlite candidates
python tools/review_asr.py out/asr-review.sqlite validate /path/to/independent-holdout.jsonl
python tools/review_asr.py out/asr-review.sqlite export > out/reviewed-transcripts.jsonl
```

验证文件每行提供独立的 `id`、`episode`、主模型 `baseline`、人工 `reference`、`source` 与 `verified: true`。工具比较关闭、手动和自动词包，并为至少两次人工确认、无拒绝记录的节目规则检查留出集。规则有改进且未引起回归时会标为可采用。审核人员可将合格规则写入节目目录，经测试后重新部署。模型冲突产生的未经核验候选保留待调查状态。

导出仅包含经过人工确认的文字，保存音频和构建训练集需要独立授权与来源记录。可选微调、模型发布与自动回滚未接入实时服务。

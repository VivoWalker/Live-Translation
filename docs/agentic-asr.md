# 本地 ASR 复查与审核

服务通过 `--agent` 启用复查。可用 `--agent-secondary` 和 `--agent-model-dir` 指定第二模型，识别与复查均在本机执行。第二模型加载失败时，主模型和翻译继续运行。使用 `--no-agent` 停用复查。

```sh
python -m server.app --agent --agent-secondary whisper --agent-model-dir /path/to/whisper +  --agent-audit out/asr-review.sqlite
```

Agent 观察强制切分、异常重复、低音量或削波，以及节目术语的可疑读音。这些信号用来决定是否复查。背景音乐、重叠语音和置信度校准需要另外验证。复查适用于至多 8 秒的片段，服务全局每 5 秒最多启动一次。复查任务独占一个额外推理槽，主模型可继续处理其他会话。默认最多等待 450 ms，超时后的原生模型可在后台完成，槽位随实际推理结束释放。

有预算时先发出原假设预览，再以同一分段 ID 确认 final。第二模型从原音频得到独立假设。只有单一替换与已核验的节目术语、读音及第二假设一致时，才采用新写法。冲突、超时、模型故障或缺少证据时保留主模型结果。最终确认的文本进入翻译。

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

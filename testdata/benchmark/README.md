# 评估数据目录

评估清单和媒体由操作方在本地准备。仓库中的旧演示音频可用于链路冒烟，目标声优直播、词汇、说话人及翻译参考转录需按来源授权另行建立。

清单示例中的台词是格式示意。运行前请使用实际核验的参考数据替换。

```json
{
  "version": 2,
  "dataset_version": "research-01",
  "name": "本地评估",
  "entity_catalog": ["藤田ことね"],
  "clips": [
    {
      "id": "clip-01",
      "audio": "clips/clip-01.wav",
      "source": "原始资料出处",
      "license": "适用许可与授权记录",
      "usage_scope": "本地研究与质量评估",
      "data_kind": "authorized_recording",
      "recording": "original-broadcast-01",
      "language": "ja",
      "audio_sha256": "<本地音频的 SHA-256>",
      "conditions": {"overlapping_speech": false, "background_music": null, "domain_terms": true},
      "tags": ["multi-speaker", "bgm", "domain-specific"],
      "title": "初星学園HR",
      "verified": true,
      "annotation_source": "标注人员或经过核验的发布转录",
      "reference": "藤田ことねの話です。",
      "entities": ["藤田ことね"],
      "translations": {"zh": "在聊藤田琴音。", "en": "We're talking about Kotone Fujita."},
      "speakers": [{"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"}]
    }
  ]
}
```

音频路径限于清单目录内。每条最多 180 秒。v2 验证音频摘要并拒绝重复音频。无标注片段保留来源和使用权限，省略参考字段。条件未知时用 `null`，`data_kind` 可选 `synthetic`、`mock`、`public_recording` 或 `authorized_recording`。v1 清单可继续读取，报告将其来源标记为旧版。开发、审核和最终测试片段按原录音组分开，保留独立测试集。

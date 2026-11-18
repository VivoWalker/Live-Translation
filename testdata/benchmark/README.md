# 评估数据目录

评估清单和媒体由操作方在本地准备。仓库中的旧演示音频可用于链路冒烟，目标声优直播、词汇、说话人及翻译参考转录需按来源授权另行建立。

清单示例中的台词是格式示意。运行前请使用实际核验的参考数据替换。

```json
{
  "version": 1,
  "name": "本地评估",
  "entity_catalog": ["藤田ことね"],
  "clips": [
    {
      "id": "clip-01",
      "audio": "clips/clip-01.wav",
      "source": "原始资料出处",
      "license": "适用许可与授权记录",
      "tags": ["multi-speaker", "bgm", "domain-specific"],
      "title": "初星学園HR",
      "verified": true,
      "reference": "藤田ことねの話です。",
      "entities": ["藤田ことね"],
      "translations": {"zh": "在聊藤田琴音。", "en": "We're talking about Kotone Fujita."},
      "speakers": [{"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"}]
    }
  ]
}
```

本地 PCM 输入限于清单目录内。每条最多 180 秒。无标注片段保留 `source` 与 `license`，省略对应参考字段。标签建议包括单人、多轮、语速快、背景音乐、重叠及长句。开发、审核和最终测试片段应分开，使用独立的录音来源或节目划分。

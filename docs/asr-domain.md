# 日语领域识别与词表

浏览器默认使用日语 `language=ja` 的 SenseVoice；Python 的 SenseVoice / Whisper 保持 `language=ja`、Whisper `task=transcribe`。三种路径在规范化日语后，使用同一份 [asr-terms.json](../extension/asr-terms.json) 做本地专名纠错，再发送日语字幕和最终分段翻译。partial 不调用翻译服务。

当前 sherpa-onnx 的这两种离线模型接入使用 `greedy_search`。已检查安装版本的 `from_sense_voice` / `from_whisper` 及 WASM 绑定；这里没有为它们配置 transducer 的 hotwords 参数，也没有伪造 Whisper initial prompt 支持。本次实现是可关闭的文本领域适配，没有重新训练模型权重，不能修复没听到的音节、重叠语音或被背景音乐盖住的内容。

## 使用

扩展弹窗的「专名纠错」提供三个选项，开始下一次字幕时生效：

| 选项 | 行为 |
| --- | --- |
| 学マス / 陽高真白 + 动漫声优（默认） | 全部词条，包括学マス角色、歌曲及通用动漫声优 |
| 动漫声优 / BanG Dream! / Love Live! | `common` 词条；不应用学マス角色及歌曲规则 |
| 关闭 | 不替换识别结果；仍进行日语空格规范化 |

本地服务的配置由服务进程设置，扩展的选项不会覆盖共享服务：

```sh
python -m server.app --asr-domain gakumas
python -m server.app --asr whisper --asr-domain anime
python -m server.app --asr-domain off
```

也可在 `config.local.json` 中设置 `"asr_domain": "gakumas"`。Python 指定非日语或 `auto` 语言时不应用日语词表。没有新增模型下载、在线纠错或额外翻译请求。

## 范围与误改控制

首批人工整理了 169 个词条、448 个别名，重点为陽高真白、学マス角色/出演者，以及 BanG Dream!（含 MyGO!!!!!、Ave Mujica）、Love Live! 的部分团体、出演者和歌曲。包括完整姓名读音的平假名/片假名写法与部分常见同音异字。它不是完整节目/歌曲目录，也没有自动更新；词条和推测别名不等于从真实直播测得的错误频率。

例如 `日高真白さん` → `陽高真白さん`，`秦谷みすず` → `秦谷美鈴`，`高松灯` → `高松燈`。不从单独的 `ましろ`、`ひろ`、`ことね` 等短名推断完整姓名，也不做全句模糊匹配。

`白線`、`光景`、`Campus mode!!` 以及 `Aqours` 等容易与普通词混淆的条目需要邻近语境：只查看原始假设中别名前后各 24 个 Unicode 字符，且不把别名自身算作证据。因此 `次の曲ははくせん` 会规范为 `次の曲は白線`，`はくせんの外側で待つ` 不变；`ラブライブのアクア` 可变为 `ラブライブのAqours`，`アクアを買った` 不变。规则不会从前一句积累证据来强行改写下一句。

匹配只扫描原始文本，先匹配最长别名，保护已有的完整标准名和英文词边界，不循环替换。即使有语境保护，同音的真实人名/歌曲仍可能误判；遇到不适用的节目可以关闭，或删除/收紧对应别名。

## 添加实测词条

直接编辑扩展中的 `extension/asr-terms.json`，然后重新加载扩展。Python 同样读取该文件；也可把文件复制成自定义版本，使用 `--asr-terms /path/to/terms.json` 或配置 `"asr_terms": "/path/to/terms.json"`。自定义文件替换整个内置词表，结构如下：

```json
{
  "version": 1,
  "cues": {"song": ["曲", "歌", "ライブ"]},
  "entries": [
    {"term": "陽高真白", "scope": "common", "aliases": ["日高真白", "ひだかましろ"]},
    {"term": "白線", "scope": "gakumas", "aliases": ["はくせん"], "requires": ["song"]}
  ]
}
```

`scope` 只能为 `common` / `gakumas`。`requires` 的任意一个语境组匹配即可，省略表示无语境限制；它们都是字面字符串，不会当作正则表达式执行。以实际识别结果添加最窄的别名，不把某个短姓、普通词或整个读音相近的句子批量映射成专名。先确认标准写法，再添加正例与「不应修改」的反例。

词表最多 500 条，每条最多 12 个别名，每个名称/别名 2–80 个 Unicode 字符；上下文组最多 16 组，每组最多 40 个提示词。文件最多 256 KiB，超过 8192 个字符的识别结果跳过纠错。重复别名、缺失上下文组和格式错误会拒绝加载；没有逐句缓存、会话历史或台词日志增长。

## 验证与限制

```sh
python -m unittest tests.test_asr_domain tests.test_asr
node --test tests/asr-domain.test.mjs tests/extension.test.mjs
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain off --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain gakumas --threads 2
```

共享正反例验证两端规则一致，完整别名检查覆盖词条，集成测试确认纠错结果进入日语字幕与翻译，并覆盖关闭、切换配置及启动取消。真实模型的普通日语音频只能用于观察回归；文本测试不能证明对直播音频的字错率或专名召回率改善。目前没有用户这些节目的标注音频，不报告未经测量的准确率提升。后续声学模型微调需要合法可用的录音、逐句日语参考文本以及独立测试集。

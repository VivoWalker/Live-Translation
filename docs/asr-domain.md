# 日语领域识别与词表

浏览器的 SenseVoice 与 Python 的 SenseVoice、Whisper 共用[日语专名词库](../extension/asr-terms)。识别文本规范化后先在本地校正专名，再显示日语字幕或翻译最终分段。

当前 sherpa-onnx 的这两种离线模型接入使用 `greedy_search`。已检查安装版本的 `from_sense_voice` / `from_whisper` 及 WASM 绑定；这里没有为它们配置 transducer 的 hotwords 参数，也没有伪造 Whisper initial prompt 支持。本次实现是可关闭的文本领域适配，没有重新训练模型权重，不能修复没听到的音节、重叠语音或被背景音乐盖住的内容。

## 使用

在扩展弹窗的「专名词库」中勾选需要的词库，下次开始字幕时生效。默认全部勾选，全部取消可关闭纠错。

| 词库 | 本地服务 ID |
| --- | --- |
| 陽高真白 | `mashiro` |
| 学マス | `gakumas` |
| BanG Dream! | `bandori` |
| Love Live! | `lovelive` |
| 通用声优与动画 | `general` |

本地服务的配置由服务进程设置，扩展的选项不会覆盖共享服务：

```sh
python -m server.app --asr-packs mashiro gakumas
python -m server.app --asr whisper --asr-packs bandori lovelive
python -m server.app --asr-packs
```

也可在 `config.local.json` 中设置 `"asr_packs": ["mashiro", "gakumas"]`，用 `[]` 关闭。旧版弹窗选项与 `asr_domain` 仍可读取。旧 `gakumas` 对应全部词库，`anime` 对应陽高真白、BanG Dream!、Love Live! 和通用声优与动画，`off` 对应全部关闭。学マス的其他出演者现归入学マス词库。

词条随应用打包，运行时在本地匹配。Python 的日语词库在 `language=ja` 时生效。

## 范围与误改控制

首批人工整理了 169 个词条、448 个别名，重点为陽高真白、学マス角色/出演者，以及 BanG Dream!（含 MyGO!!!!!、Ave Mujica）、Love Live! 的部分团体、出演者和歌曲。包括完整姓名读音的平假名/片假名写法与部分常见同音异字。它不是完整节目/歌曲目录，也没有自动更新；词条和推测别名不等于从真实直播测得的错误频率。

例如 `日高真白さん` → `陽高真白さん`，`秦谷みすず` → `秦谷美鈴`，`高松灯` → `高松燈`。不从单独的 `ましろ`、`ひろ`、`ことね` 等短名推断完整姓名，也不做全句模糊匹配。

`白線`、`光景`、`Campus mode!!` 以及 `Aqours` 等容易与普通词混淆的条目需要邻近语境：只查看原始假设中别名前后各 24 个 Unicode 字符，且不把别名自身算作证据。因此 `次の曲ははくせん` 会规范为 `次の曲は白線`，`はくせんの外側で待つ` 不变；`ラブライブのアクア` 可变为 `ラブライブのAqours`，`アクアを買った` 不变。规则不会从前一句积累证据来强行改写下一句。

匹配只扫描原始文本，先匹配最长别名，保护已有的完整标准名和英文词边界，不循环替换。即使有语境保护，同音的真实人名/歌曲仍可能误判；遇到不适用的节目可以关闭，或删除/收紧对应别名。

## 添加实测词条

编辑 `extension/asr-terms/` 中对应的 JSON 文件，再重新加载扩展或重启 Python 服务。Python 也可使用 `--asr-terms /path/to/terms.json` 或 `"asr_terms": "/path/to/terms.json"` 替换整套内置词库。使用自定义文件时请省略 `--asr-packs`。

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

`scope` 是旧版自定义词库的选填字段，取值为 `common` 或 `gakumas`。`requires` 中的语境组满足任意一个即可，省略表示无语境限制。所有别名和提示词按字面匹配。以实际识别结果添加明确的别名，核对标准写法并补上正例和反例。

词表最多 500 条，每条最多 12 个别名，每个名称/别名 2–80 个 Unicode 字符；上下文组最多 16 组，每组最多 40 个提示词。文件最多 256 KiB，超过 8192 个字符的识别结果跳过纠错。重复别名、缺失上下文组和格式错误会拒绝加载；没有逐句缓存、会话历史或台词日志增长。

## 验证与限制

```sh
python -m unittest tests.test_asr_domain tests.test_asr
node --test tests/asr-domain.test.mjs tests/extension.test.mjs
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain off --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain gakumas --threads 2
```

共享正反例验证两端规则一致，完整别名检查覆盖词条，集成测试确认纠错结果进入日语字幕与翻译，并覆盖关闭、切换配置及启动取消。真实模型的普通日语音频只能用于观察回归；文本测试不能证明对直播音频的字错率或专名召回率改善。目前没有用户这些节目的标注音频，不报告未经测量的准确率提升。后续声学模型微调需要合法可用的录音、逐句日语参考文本以及独立测试集。

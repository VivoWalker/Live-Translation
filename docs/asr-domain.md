# 日语领域识别与词表

## 节目上下文

手动模式继续使用原有词包选择。自动模式规范化标题后，依次选择唯一已核验节目、唯一企划、自选回退词包、保守直播词表。标题同时指向多个企划时视为匹配不确定。浏览器默认保留原文。保守词表上线前设置了精简允许名单，每处纠错仍需同句直播线索。`general` 完整词包需手动启用或由已知企划选择。

弹窗的「标题未匹配时」可切换这些回退路径。默认服务模式由服务的 `--auto-domain-packs` 和 `--auto-domain-general` 决定。自定义目录通过 `--episode-catalog` 加载。服务手动模式继续使用部署时的词库配置。

目录记录包含 `franchise`、可选 `episode`、词包、`scope`、`verified`、`title_contains` 或 `title_exact`，以及 HTTPS `source` 或 `official_source`。旧节目记录的核验状态默认为真，历史配置仍可读取。术语可按 `actor`、`character`、`song` 和 `nickname` 等类别登记读音、优先级、核验状态和独立来源。仅命中核验节目时使用其已核验词条和提示，企划匹配使用该企划词包。页面标题只在包内目录上按字面匹配。 [节目目录](../extension/asr-terms/episodes.json)

Python recognizer 返回原始识别、显示文本和每处证据。浏览器词表的 `explain(text)` 返回同类的替换与建议。偏移量以规范化输入中的 Unicode 码点为单位。记录包括别名、规范词、来源、核验状态、触发规则、决策级别和独立 ASR 标记。字幕的日语规范名与后续翻译词表独立。

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

## 覆盖范围

五套词库共 453 个不同词条、1,367 种不同识别写法。部分相关词条共用，例如十王星南同时出现在陽高真白与学マス词库中。

| 词库 | 示例 |
| --- | --- |
| 陽高真白 | `ひたかましろ` → `陽高真白`。包含十王星南、桃尻芹香和「陽高真白はぽじてぃぶ☆ぷりんせす」「おうちとれーにんぐっ！」 |
| 学マス | `学馬` → `学マス`，`がくま水曜日` → `学マ水曜日`，有系列线索时 `エヌアイエー` → `N.I.A`。覆盖初星学園HR、角色与出演者、育成用语及歌曲 |
| BanG Dream! | `ぽぴぱ` → `ポピパ`、`ぱすぱれ` → `パスパレ`、`がるぱ` → `ガルパ`。包含 MyGO!!!!!、Ave Mujica 等乐队、出演者和歌名 |
| Love Live! | `にじがく` → `ニジガク`、`りんくら` → `リンクラ`、`セイハス` → `せーはす`。覆盖虹ヶ咲、蓮ノ空等团体、角色和歌名 |
| 通用声优与动画 | `めんげん` → `メン限`、`りあたい` → `リアタイ`。包含声优姓名、动画曲名及直播和活动用语 |

## 误改控制

| 级别 | 生效条件 |
| --- | --- |
| 1 确定性 | 随版本审阅的低歧义别名或已部署词库的明确标注 |
| 2 上下文 | 同句中存在具体线索，或命中核验节目中的明确别名 |
| 3 建议 | 标记为 `candidate: true`、未经核验或不同词条有冲突的写法保持原样。已核验节目的读音需另一个独立声学假设支持同一处修改 |
| 4 原样保留 | 缺少所需线索或别名，保留主识别文本 |

词条或别名的 `verified: false` 始终限制为候选。版本 1 词库中旧格式的条目继续按已审阅词库使用。已核验的规范名和读音本身也不能替代独立声学证据。当已核验节目读音同时出现在底层词包时，以较严格的候选规则处理。

纠错按原始识别文本从左到右匹配，优先处理完整的长别名，并保护已有的标准写法。易混别名查看同一句中前后各 24 个 Unicode 字符，遇到 `。` 或换行截断。两侧分别匹配，别名本身和之前的分段均不提供线索。

`バンドリのラス` 可以校正为 `バンドリのRAS`。`クラス` 和 `ラスト` 通过片假名边界检查保留原样。`学マスのテマリちゃん` 可以校正为 `学マスの手毬ちゃん`。单独出现的 `ましろ`、`ひろ`、`ことね` 会保留原样。在不熟悉的节目中可以只勾选相关词库，减小同音名字的误改范围。

## 资料来源

通过 GitHub 公开检索核对标准写法、简称和姓名读音，识别异体仍由本项目人工整理。

- 陽高真白的读音、十王星南的出演关系、节目日历和桃尻芹香的角色曲。 [Gakumas_dic](https://github.com/reindex-ot/Gakumas_dic/blob/15e9438f2505abb246be7cba954f5eba2a344c59/Gakumas_dic_Gboard.txt) · [imasparql](https://github.com/imas/imasparql/blob/master/RDFs/Gakuen.rdf) · [出演日历](https://github.com/IvanChan1129/gakumas-calendar-ics/blob/b49d4fab613e6c49f1bea2cc525610ac35390916/casts/cast-1acc688e5b3a308f.ics) · [曲目资料](https://github.com/onihusube/ensonglog/tree/a0b3cba42e6f432304110cf7bdcf0bf9882be073/docs/2025)
- 学マス的角色、育成和生放送用语，以及氷渡香名江与 H.I.F 的写法。 [gakumas-data](https://github.com/surisuririsu/gakumas-tools/tree/master/packages/gakumas-data) · [角色资料](https://github.com/fuga-if/idol-live-db/blob/bf800a0daf4f7d182806cdf072c41bc608c14264/data/_applied/idols/20261108_gakuen_hiwatari_kanae.json) · [初星学園HR](https://github.com/Velgail/imas_llm_news/blob/97be57d96136c4847500b8fa72da97c56b4a27dc/docs/_posts/2026/08/2026-08-13-gaku-hr11-broadcast-today.md) · [H.I.F](https://github.com/Velgail/imas_llm_news/blob/97be57d96136c4847500b8fa72da97c56b4a27dc/docs/_posts/2026/06/2026-06-06-gakumas-garakuta-single-release.md)
- BanG Dream! 乐队、演员、角色、通称及 MyGO!!!!! 歌名读音。 [Open Bandori Database](https://github.com/BANKA2017/open-bandori-database) · [乐队简称](https://github.com/haneoka-gakuen/haneoka/blob/b5e39264ca144811d9fd619715106688495245b6/src/lib/catalog-query-aliases.json) · [MyGO!!!!! 曲目读音](https://github.com/takaki719/mygo-quiz/blob/b74a308f664a286dcbf2a51945ea4776d0f26e2b/data/songs.ts)
- Love Live! 的团体、曲目、角色读音与蓮ノ空简称。 [TakasakiInfo](https://github.com/AuroraCaelum/TakasakiInfo) · [蓮ノ空词条](https://github.com/moganbo/IME/blob/d3a8cfb634cbb1155ef2a3f68d7e8857a741421f/live_live_hasunosora/lovelive_hasunosora.txt) · [せーはす](https://github.com/AuroraCaelum/sehasu-counter)
- 通用词库中的部分声优和动画歌曲，包括《ぼっち・ざ・ろっく！》的出演者和「青春コンプレックス」。 [动画资料](https://github.com/open-ani/animeko/blob/42ef5d4616bb64f4530ebb56247f7847c3329da8/app/shared/ui-subject/src/commonMain/kotlin/ui/subject/details/SubjectDetailsTestData.kt) · [歌曲资料](https://github.com/czy0729/Bangumi-Subject/blob/b27311eb0f7d54b329e134c095879a273b3189c4/data/4009/400957.json)

## 添加实测词条

编辑 `extension/asr-terms/` 中对应的 JSON 文件，再重新加载扩展或重启 Python 服务。Python 也可使用 `--asr-terms /path/to/terms.json` 或 `"asr_terms": "/path/to/terms.json"` 替换整套内置词库。使用自定义文件时请省略 `--asr-packs`。

```json
{
  "version": 1,
  "cues": {"song": ["曲", "歌", "ライブ"], "bandori": ["バンドリ", "ガルパ"]},
  "entries": [
    {"term": "陽高真白", "scope": "common", "aliases": ["日高真白", "ひだかましろ"]},
    {"term": "白線", "scope": "gakumas", "aliases": ["はくせん"], "requires": ["song"]},
    {"term": "RAS", "aliases": [{"text": "ラス", "requires": ["bandori"], "katakanaBoundary": true}]}
  ]
}
```

`scope` 是旧版自定义词库的选填字段，取值为 `common` 或 `gakumas`。`requires` 中任一组的任一线索匹配即可。别名可以用字符串继承词条条件，也可以用对象为某个写法指定自己的 `requires`。全片假名别名可设置 `katakanaBoundary: true`，避免匹配在更长的片假名词中。所有别名和提示词均按字面匹配。以实际识别结果添加明确的别名，核对标准写法并补上正例和反例。

词表最多 500 条，每条最多 12 个别名，每个名称/别名 2–80 个 Unicode 字符；上下文组最多 16 组，每组最多 40 个提示词。文件最多 256 KiB，超过 8192 个字符的识别结果跳过纠错。重复别名、缺失上下文组和格式错误会拒绝加载；没有逐句缓存、会话历史或台词日志增长。

## 验证与限制

```sh
python -m unittest tests.test_asr_domain tests.test_asr
node --test tests/asr-domain.test.mjs tests/extension.test.mjs
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain off --threads 2
python tools/test_asr.py testdata/ja_nanami.mp3 --asr-domain gakumas --threads 2
```

共享正反例验证两端规则一致，完整别名检查覆盖词条，集成测试确认纠错结果进入日语字幕与翻译，并覆盖关闭、切换配置及启动取消。真实模型的普通日语音频只能用于观察回归；文本测试不能证明对直播音频的字错率或专名召回率改善。目前没有用户这些节目的标注音频，不报告未经测量的准确率提升。后续声学模型微调需要合法可用的录音、逐句日语参考文本以及独立测试集。

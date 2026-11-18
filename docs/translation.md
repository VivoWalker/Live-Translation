# 翻译、缓存与用量

[返回项目首页](../README.md)

## 请求约定

浏览器与 Python 服务默认使用同一份固定翻译指令，版本为 `subtitle-v3`。用户消息包含当前句与上一句，节目、词表及 ASR 内容都作为 JSON 数据传入。请求保留在配置的翻译端点，服务与扩展拒绝重定向。

```json
{"previous": "上一句日语", "current": "当前最终分段的日语"}
```

上一句仅辅助理解指代与语气，只翻译当前句。首次请求的 `previous` 为空。日语 partial 只更新预览，最终分段才请求翻译；连续长语音保留 12 秒分段上限。固定前缀不填充无用文字，也不为缓存命中累计整段历史。

默认 `deepseek-chat`、`temperature=0.2`、`max_tokens=512`、非流式。Python 支持 `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`。默认接口为 `https://api.deepseek.com/chat/completions`。

本地服务只在配置有效翻译器时联网。需要使用系统 HTTPS 代理时可显式设置 `DEEPSEEK_TRUST_ENV=1`。服务与浏览器限制响应体为 64 KiB，译文最多 8192 字符。

可选多轮上下文保留最近 3、4 或 5 条日语 final，每条最多 512 个字符。本地服务使用 `--context-turns 3`，浏览器可在高级设置中启用。请求可附带已匹配的节目、企划及最多 8 个相关译名。翻译指令要求保留口头修正、吐槽和自然的省略，只输出当前句的译文。

日语转写保留例如「藤田ことね」的日语规范形。简体中文和英语可分别选用「藤田琴音」与「Kotone Fujita」。本地服务可用 `--translation-glossary` 指定有版本号的译名文件。 [默认译名词表](../extension/asr-terms/translation.json)

## 会话内复用

| 项目 | 限制 / 行为 |
| --- | --- |
| LRU | 最多 500 条；缓存键和译文的 UTF-8 数据合计最多 1 MiB |
| 单项 | 最多 32 KiB，超大项不缓存 |
| 请求键 | API 地址、模型、提示词版本、语言、完整上下文快照、译名版本与生成参数 |
| 可缓存结果 | 非空且 `finish_reason=stop` 的完整成功响应 |
| 不缓存 | 失败、取消、超时、截断及无法确认完成的响应 |
| 进行中请求 | 相同键共用一次 API 调用；每会话最多 32 个不同请求 |

上下文在日语 final 产生时固定，构建请求与生成键使用同一快照。上一句随日语 final 立即推进，后一句可先完成翻译。字幕按分段 ID 回填。不同上下文的相同台词使用独立缓存键。

每个会话最多容纳 32 个翻译分段，其中 3 个同时等待译文。浏览器在一次 12 秒传输限时内可重试一次瞬时网络、429 或 5xx 错误，超过 16 秒排队期限的分段在取出时结束等待。本地会话的排队与翻译合计上限为 28 秒，DeepSeek 传输最多尝试两次。队列满或请求失败时发送带 ID 的错误并保留日语，语言切换取消未完成任务。

浏览器缓存仅保留在内存，不写 Cache Storage / localStorage；持久化识别模型缓存独立管理。Python 每个 WebSocket 拥有独立的 pipeline、LRU、任务与统计，只共享底层 HTTP 连接。停止、重启和相关配置切换会清理会话状态，旧会话结果不能进入新会话。

## 调试统计

浏览器在 offscreen 页查看 `JLSEngine.stats().translation`；本地服务在认证后的 WebSocket 发送 `{"type":"stats"}`，响应的 `translation` 字段包含同类指标。

| 指标 | 含义 |
| --- | --- |
| `api_requests` | 实际调用次数，包括重试 |
| `local_cache_hits` | 本地译文缓存命中次数 |
| `merged_requests` | 复用进行中请求的次数 |
| `request_ms` / `avg_request_ms` | 每次实际请求的累计 / 平均耗时 |
| `prompt_cache_hit_tokens` | API 报告的服务端输入缓存命中 token |
| `prompt_cache_miss_tokens` | API 报告的输入缓存未命中 token |
| `completion_tokens` | API 报告的输出 token |

API 未返回某字段时不会把它当成零。若任何已完成请求缺少某 usage 字段，该字段的完整累计值为 `null`；`usage_reported_tokens` 保留已知部分，`usage_unavailable_requests` 统计缺失次数，`usage_pending_requests` 标明仍在等待的请求。显式返回的零仍为零。

本地命中与合并不会重复计入 API usage，也不算 DeepSeek 服务端缓存命中。计数器数量固定并有饱和上限，不保存逐句统计日志；诊断不输出 Key、完整台词、上下文或缓存键。

## 少量真实 API 对照

已有凭据时可运行下面的命令。它直接调用传输层，绕过本地译文缓存和请求合并；会产生少量真实 API 费用。

```sh
python tools/test_translate.py --engine deepseek --probe-cache --report /tmp/deepseek-usage.json
```

报告只包含模型、提示词版本、场景编号、usage、请求次数和耗时，不包含台词或凭据。需要代理时，使用可访问的服务地址配置 `DEEPSEEK_BASE_URL`。

2026-11-17 经环境代理进行的 3 次对照，使用相同固定 system 提示词。第二次只更换当前台词；第三次完全重复第一次，且绕过本地复用：

| 场景 | API 次数 | 命中 token | 未命中 token | 输出 token | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 固定前缀，台词 A | 1 | 0 | 129 | 6 | 1205 ms |
| 固定前缀，台词 B | 1 | 0 | 127 | 5 | 850 ms |
| 完全重复 A | 1 | 0 | 129 | 6 | 1072 ms |

本次未观察到 DeepSeek 服务端缓存收益。原实现已有固定前缀，移动上下文本身不保证命中；这组小样本也不能代表长期命中率或大样本翻译质量。

本地 LRU 与并发合并减少的是实际 API 调用，收益取决于同一上下文中的重复请求频率。服务端缓存收益需以真实 API 返回的 usage 为依据，不承诺未经验证的节省比例。

## 多轮提示对照

下面的命令使用两组合成日语对话，对同一句分别提交单轮和多轮提示。每个目标语言调用四次 DeepSeek，请求结果按稳定的场景编号记录。提供代理的环境可设置 `DEEPSEEK_TRUST_ENV=1`。

```sh
python tools/test_translate.py --probe-context --target zh --report /tmp/jls-context-zh.json
python tools/test_translate.py --probe-context --target en --report /tmp/jls-context-en.json
```

通过环境 HTTPS 代理实测，中英文各四次请求均完成。中文单轮与多轮 P50 分别为 766 和 764 ms，英文分别为 965 和 854 ms，每个分组有两条样本。质量评估需使用额外的参考译文。

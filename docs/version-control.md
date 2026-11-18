# 开发基线与版本控制

本次开发分支为 `feature/agentic-asr-improvements`，起点为 `7112fe9d199a97a1ccfd39b003ae5f57837dc6d7`（`feat/domain-lexicon-packs`）。起始工作区干净，原分支保留。`origin` 指向 `VivoWalker/Live-Translation`，阶段提交均在本地开发分支。

## 修改前验证

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| Python 3.12.14，项目虚拟环境 | `.venv/bin/python -m unittest discover -s tests` | 60 项通过 |
| Node.js v24.22.1 | `node --test tests/*.test.mjs` | 58 项通过 |
| Python 3.12.14，系统环境 | `python -m unittest discover -s tests` | 5 个测试模块因缺少 `sherpa_onnx` 无法导入 |

## 修改前代码审查

| 路径 | 已有实现 | 优先处理的问题 |
| --- | --- | --- |
| Offscreen、浏览器识别引擎 | 标签页采集、单独回放、16 kHz PCM、SenseVoice WASM、校验并复用模型缓存、启停资源所有权 | 请求在翻译完成后推进上一句上下文；交付上限满时静默返回；VAD 在整个输入块处理完后才检查状态 |
| Python ASR、流式会话 | SenseVoice 与 Whisper int8、Silero、滚动预览、自适应间隔和强制切分 | 新 final 取消旧翻译；按最大已完成 ID 过滤会丢掉乱序结果；VAD 只消费最近一个待处理分段 |
| 服务入口 | 连接令牌、Host/Origin 校验、限流与音频字节预算 | 输出队列满时无条件跳过事件；客户端未检查发送缓冲量 |
| 词库、翻译与字幕 | Python/JavaScript 共用五套词库；已有规范词保护、上下文规则、会话 LRU、请求合并和按 ID 回填 | 缺少节目级选择和纠错审计；翻译历史依赖异步完成；字幕层已有乱序支持，可直接复用 |
| 测试与工具 | 单元测试、HTTP/WS 桩、Chromium 页面检查和无标注日语样本 | 缺少同条件 A/B 指标、可授权的节目级参考转录及完整标签页采集验收记录 |

阶段通过相关测试后，以 Conventional Commits 格式提交。单项回滚使用 `git revert <SHA>`。回到基线进行验证时，可用 `git switch --detach 7112fe9` 或创建独立工作树。最终核验使用 `git status` 和 `git log --oneline 7112fe9..HEAD`。

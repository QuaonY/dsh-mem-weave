# Changelog

本文件只记录当前发布的版本。MemWeave 以 **v1.0.0** 为第一个正式版本，此前所有开发中间版本不再保留记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-11-17

优化记忆的整体流程与向量检索：

- 记忆从写入、整理到召回的链路更连贯，跨会话的延续更自然。
- 向量检索的命中与稳定性有所提升，语义路的结果更贴近当前话题。

## [1.0.0] - 2026-11-17

首个正式版本：把长期记忆、人格、写入治理、隐私保护与检索工程合成一个开箱即用的 DSH 插件。

### 记忆与人格

- 七层记忆：`soul`、`user`、`rules`、`project`、`fact`、`lesson`、`topic`，每层独立的半衰期与注入优先级。
- 三段注入：S1 人格（九块固定顺序拼接）、S2 会话首轮快照、S3 之后的增量与召回，各自限额、互不挤压。
- 人格可编辑、可预览、可回滚版本；内置两套原创人格（小满、林禾·夜班修理铺），支持应用预设。
- 用户画像：从 `user` / `soul` / `fact` / `project` 聚合出偏好、目标、沟通风格与边界，可逐项修正或删除。
- 约定与日期：到期约定、生日、纪念日、农历节日提前提醒；未到期的约定不会被整理掉。
- 提示词语言可切换（`promptLang`: `zh` / `en`），界面语言与注入语言同源。

### 检索与向量

- 召回流水线：FTS5 前置候选 → BM25 关键词 + 语义路 + 链接扩展 → RRF 融合（k=60）→ 时间衰减（带下限）→ 去同质 → 反刍抑制 → top-k，返回可解释 `trace`。
- 向量后端四档：`sqlite-vec`（五平台预编译扩展随包分发）、`vectra`（本体随包）、`builtin`（SQLite BLOB + JS 余弦兜底）、`disabled`（仅显式关闭）。任一环失败自动退回关键词。
- Embedding 来源：语义路需开启向量检索（`recall.vector.enabled`）；支持 OpenAI 兼容的 HTTP 服务；未配置 provider 时自动探测本机 Ollama / LM Studio（只连 `127.0.0.1`，可用 `MEMWEAVE_EMBEDDING_DISCOVERY=0` 关闭），也可用 `OPENAI_API_KEY` 云兜底；全部未命中则只走关键词。
- 本地模型：设置页一键下载 ONNX 模型（bge-small-zh、all-MiniLM-L6、e5-small、bge-m3 等），下完离线推理；下载走官方源，不通时自动回退镜像，HTML 错误页不会被当成模型保存。
- 时间衰减下限（`lifecycle.decayFloor`，默认 0.1）与参数单一来源，避免「太久没提就彻底归零」。

### 治理与撤销

- 写入四级把关：来源检测（明说 / 观察 / 推断）、去重与合并、冲突冻结、审计留痕。
- 人工保留项：改人格、改 `rules` / `soul`、裁决冲突、永久删除只能由人执行；AI 调用返回 `E_PERM`。
- 24 小时撤销窗口：写入、修改、合并、整理都可撤回，审计记录完整。
- 冲突先在候选池冻结，不覆盖旧结论；确认后才合并或替换。
- 空闲整理（dream）：过期转 `stale`、冷记忆合并摘要、完工半年的项目整体归档，归档与合并的原文都可恢复。
- 多进程安全：`process_lease` 保证同一库只有一个进程执行整理与向量索引，TTL 180 秒。

### 隐私与安全

- 写入侧拦截密钥、令牌、密码；其余八类敏感信息（手机号、邮箱、身份证、信用卡、IP、地址等）按类型标记。
- 读出侧默认字段级脱敏（`recallPolicy: "redact"`），可切到整条过滤（`"filter"`）；敏感条目不进向量索引。
- 注入前清理特殊括号与换行，防止伪造段落；日志不记记忆正文。
- 备份加密：AES-256-GCM + scrypt + 旁文件校验，篡改或口令错误直接失败；旧 CBC 备份仍可解密。

### 界面

- 九个页面：总览、人格、记忆、用户画像、候选与冲突、注入与预算、治理与审计、备份、高级。
- 每轮对话后显示「这轮记了什么」卡片；检索结果可看命中原因与衰减系数；注入可逐字预览并与实际注入比对。
- 危险操作需手输确认词；长列表虚拟滚动；审计记录展示时默认脱敏。

### 工具与命令

- 22 个 `weave_*` 工具，覆盖写入、检索、整理、治理、人格与画像，权限外的操作直接拒绝。
- 对话内命令：`/weave status | reload | preset <id> | strict on|off | dream`。
- 命令行运维：`node scripts/weave.mjs status | render | persona | reset`。

### 工程

- **零运行时依赖**：`package.json` 无 `dependencies`，install 阶段不执行任何脚本。
- **随包依赖**：本地模型推理（`@huggingface/transformers` 4.3.2 + `onnxruntime-node` 1.30.0）与 `vectra` 0.15.0 放在 `lib/vendor/`，装完即可离线使用；五个平台的 sqlite-vec 扩展在 `lib/native/`。版本固定在 `scripts/vendor-pins.mjs`，许可证汇总在 `lib/vendor/THIRD_PARTY_LICENSES.txt` 与 `THIRD_PARTY_NOTICES.md`。
- 不随包 GPU 加速文件（DirectML / dxcompiler / dxil），只做 CPU 推理；`onnxruntime` 1.30 本身不提供 Intel Mac 的推理库。
- 安装包约 70 MB（2868 个文件，解包约 203 MB）；模型权重在首次使用时下载。
- 测试 112 个文件 / 1038 个用例（1 个默认跳过）；覆盖率门禁 70 / 70 / 75 / 75（语句 / 行 / 分支 / 函数），当前实测约 78 / 78 / 80 / 83（计时类用例会让数字小幅浮动）。
- 一致性自检 `pnpm conformance`（出厂状态零注入、九块保序）与基线接口的检索护栏 `pnpm bench:guard` 进 CI。
- 需要 Node ≥ 22.13（内置扩展加载依赖宿主 SQLite 的 `allowExtension`）。

### 已知边界

- 检索在 LongMemEval-S 与 LoCoMo 上与同数据 BM25 持平，尚未超过；多跳、时间、偏好题是短板。
- 10 万条规模未实测；10k 条召回 p95 在 30.6–56.2 ms 区间。
- 敏感检测是规则 + 置信度，不是万无一失；改写或编码后的敏感信息可能漏检。
- 权限边界依赖宿主不把本插件的 RPC 暴露给 AI 或其他插件。

# Changelog / 更新日志

All notable changes to MemWeave are recorded here, newest first. Each release appends one section; the release pipeline extracts the matching section as the Release body. Published release pages do not auto-update when this file is edited later. Records start at **v1.0.0**, the first stable release; earlier development versions are not retained.

每个版本的变更都记录在此，最新在前。每次发版追加一节；发布流水线自动抽取对应版本章节作为 Release 说明。已发布的页面不会随本文件后续编辑自动更新。自第一个正式版本 **v1.0.0** 起记录，此前开发中间版本不再保留。

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). Each section lists English first, then Chinese under a "中文" line.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。每节英文在前，「中文」行之后为中文。

## [1.0.4] - 2026-11-20

Fixes known issues and improves the user experience.

中文

修复已知问题，优化用户体验。

## [1.0.3] - 2026-11-20

A focused round of fixes for 13 high-severity issues found in a full audit, covering privacy, write governance, recall, extraction, vectors and the UI:

- Privacy: settings queries no longer return apiKey in plaintext; turn notices carry only redacted summaries and are scoped to the current session.
- Write governance: conflict merges go through the governance pipeline (risk tiers + human confirmation); archive rewrites no longer hit unique constraints; cold merges are grouped per project instead of leaking across projects.
- Recall & injection: the user profile is wired into first-turn injection; Chinese numerals are parsed as whole spans ("十三楼" → 13) so words like "十分" / "万一" are no longer mangled.
- Extraction: candidates are persisted by risk tier — low risk auto-accepted, high risk left for confirmation — instead of creating candidates without writing memories.
- Profile: confidence uses the 1–5 importance scale, so high-importance memories become "observed" preferences sooner.
- Vectors: the backend is re-probed after a backup restore so recall keeps working; partial vector-config updates no longer clear existing values or trigger needless reindexing.
- UI & persona: textarea/checkbox DOM properties fixed; session-level persona overrides no longer pollute the global persona.
- Turn notices: duplicate turn-stopping events within the same millisecond no longer send duplicate cards.

中文

集中修复一轮全量审查发现的 13 项高危问题，覆盖隐私、写入治理、召回、抽取、向量与界面：

- 隐私：设置查询不再返回 apiKey 明文；轮后通知只带脱敏摘要，且限定本会话。
- 写入治理：冲突合并纳入治理管线（风险分级与人工确认）；归档内容重写不再撞唯一约束；冷合并按项目分组，不再跨项目污染。
- 召回与注入：用户画像接入首轮注入；中文数字整段解析（「十三楼」→13），「十分」「万一」等词不再被误转换。
- 抽取：候选按风险分级真正落库——低风险自动接受、高风险留待确认，不再只建候选不写记忆。
- 画像：置信度改用 1–5 重要度量纲，高重要度记忆更快成为「观察到的」偏好。
- 向量：恢复备份后重新探测后端，检索不再失效；部分更新向量配置不再清空现值或误触发重索引。
- 界面与人格：textarea/checkbox 的 DOM 属性修正；会话级人格覆盖不再污染全局人格。
- 轮后通知：同一毫秒内重复的 turn-stopping 不再重复发卡片。

## [1.0.2] - 2026-11-17

Fixes the memory badge next to the input box crashing on mount under DSH 0.2.x (`Cannot set property "container" without provide`):

- The badge no longer writes `container` onto the protected plugin-context copy; the slot container is passed directly.
- Fallbacks added: fall back to `document.body` when no container is readable; skip silently when RPC is not ready or the current turn is unavailable, leaving no unhandled exceptions.

中文

修复输入框旁的记忆徽章在 DSH 0.2.x 上挂载即报错的问题（`Cannot set property "container" without provide`）：

- 不再往受保护的插件上下文副本上写 `container`，插槽容器直接传给徽章。
- 补齐兜底：读不到容器时退回 `document.body`；RPC 未就绪或上下文里读不到本轮信息时静默跳过，不再留下未处理的异常。

## [1.0.1] - 2026-11-17

Improves the overall memory flow and vector recall:

- The write → consolidate → recall chain is more coherent, making cross-session continuity feel natural.
- Vector recall hits and stability improve; semantic results stay closer to the current topic.

中文

优化记忆的整体流程与向量检索：

- 记忆从写入、整理到召回的链路更连贯，跨会话的延续更自然。
- 向量检索的命中与稳定性有所提升，语义路的结果更贴近当前话题。

## [1.0.0] - 2026-11-17

First stable release: long-term memory, persona, write governance, privacy protection and recall engineering in one out-of-the-box DSH plugin.

- Memory layers: seven layers (`soul` / `user` / `rules` / `project` / `fact` / `lesson` / `topic`), each with its own half-life and injection priority; three injection sections (persona nine-block, first-turn snapshot, later deltas + recall) with separate budgets that never squeeze each other.
- Persona: editable, previewable, version-rollbackable; two original built-in personas (Xiaoman, Lin He · Night-Shift Repair Shop) with preset support; prompt language switchable (`zh` / `en`), UI and injection share the same source.
- User profile: preferences, goals, communication style and boundaries aggregated from `user` / `soul` / `fact` / `project`, correctable or deletable item by item.
- Promises & dates: due promises, birthdays, anniversaries and lunar festivals surface ahead of time; pending promises are never consolidated away.
- Recall: FTS5 prefilter → BM25 keyword + semantic + link expansion → RRF fusion → time decay (with floor) → diversity → rumination damping → top-k, every hit carrying an explainable trace.
- Vectors: four backend tiers (`sqlite-vec` / `vectra` / `builtin` / `disabled`), any failure falls back to keyword; the semantic route needs the vector switch (UI Advanced) plus an embedding provider, supports OpenAI-compatible HTTP services, probes local Ollama / LM Studio when unconfigured (`127.0.0.1` only, disable with `MEMWEAVE_EMBEDDING_DISCOVERY=0`); ONNX local models download once and run offline, with mirror fallback when the official source is unreachable.
- Write governance: four gates (source detection, dedup & merge, conflict freeze, audit trail); conflicts freeze in the candidate pool and only merge or replace after confirmation, never overwriting old conclusions.
- Human-only operations: editing persona, changing `rules` / `soul`, adjudicating conflicts and permanent deletion are human-only; overreaching AI calls get `E_PERM`.
- Undo: a 24-hour window covers writes, edits, merges and consolidation, with a complete audit trail.
- Idle consolidation (dream): expired entries turn `stale`, cold memories merge into summaries, projects finished six months ago archive whole, originals recoverable; `process_lease` keeps consolidation and vector indexing single-process per database.
- Privacy: keys, tokens and passwords are blocked on write; eight other sensitive kinds (phone, email, ID card, credit card, IP, address, …) are field-redacted by default before injection, switchable to whole-entry filtering, and never enter the vector index.
- Injection & logs: special brackets and newlines are stripped before injection to prevent forged sections; logs never contain memory bodies.
- Backup: AES-256-GCM + scrypt with sidecar verification; tampering or a wrong passphrase fails immediately; legacy CBC backups still decrypt.
- UI: nine pages (Overview, Persona, Memory, User Profile, Candidates & conflicts, Injection & budget, Governance & audit, Backup, Advanced); a post-turn "what was remembered" card; recall shows hit reasons and decay factors; injection previewable verbatim and comparable with what was actually injected; dangerous actions need a typed confirmation word; long lists virtual-scroll; audit displays redacted by default.
- Tools & commands: 22 `weave_*` tools covering write, recall, consolidation, governance, persona and profile, rejecting out-of-permission operations; in-conversation `/weave status | reload | preset <id> | strict on|off | dream`; CLI ops via `node scripts/weave.mjs status | render | persona | reset`.
- Engineering: zero runtime dependencies, no install-time scripts; local inference (transformers + onnxruntime) and vectra bundled in `lib/vendor`, five-platform sqlite-vec extensions in `lib/native`, versions pinned in `scripts/vendor-pins.mjs`, licenses summarized in `THIRD_PARTY_NOTICES.md`; CPU-only inference (onnxruntime ships no Intel Mac inference library), no GPU acceleration files bundled; ~70 MB install package, model weights download on first use; Node ≥ 22.13 required; `pnpm conformance` and `pnpm bench:guard` run in CI.

中文

首个正式版本：把长期记忆、人格、写入治理、隐私保护与检索工程合成一个开箱即用的 DSH 插件。

- 记忆分层：七层记忆 `soul` / `user` / `rules` / `project` / `fact` / `lesson` / `topic`，每层独立半衰期与注入优先级；三段注入（人格九块、会话首轮快照、之后的增量与召回）各自限额、互不挤压。
- 人格：可编辑、可预览、可回滚版本；内置两套原创人格（小满、林禾·夜班修理铺），支持应用预设；提示词语言可切 `zh` / `en`，界面与注入语言同源。
- 用户画像：从 `user` / `soul` / `fact` / `project` 聚合偏好、目标、沟通风格与边界，可逐项修正或删除。
- 约定与日期：到期约定、生日、纪念日、农历节日提前提醒；未到期的约定不会被整理掉。
- 检索：FTS5 前置候选 → BM25 关键词 + 语义路 + 链接扩展 → RRF 融合 → 时间衰减（带下限）→ 去同质 → 反刍抑制 → top-k，每条命中带可解释 trace。
- 向量：后端四档 `sqlite-vec` / `vectra` / `builtin` / `disabled`，任一环失败自动退回关键词；语义路需在界面「高级」开启向量开关并配置 embedding 服务，支持 OpenAI 兼容 HTTP 服务，未配置时探测本机 Ollama / LM Studio（只连 `127.0.0.1`，可用 `MEMWEAVE_EMBEDDING_DISCOVERY=0` 关闭）；ONNX 本地模型一键下载后离线推理，官方源不通自动回退镜像。
- 写入治理：四级把关（来源检测、去重合并、冲突冻结、审计留痕）；冲突先在候选池冻结，确认后才合并或替换，不覆盖旧结论。
- 人工保留项：改人格、改 `rules` / `soul`、裁决冲突、永久删除只能由人执行；AI 越权调用返回 `E_PERM`。
- 撤销：24 小时窗口覆盖写入、修改、合并、整理，审计记录完整。
- 空闲整理（dream）：过期转 `stale`、冷记忆合并摘要、完工半年的项目整体归档，原文都可恢复；`process_lease` 保证同一库单进程执行整理与向量索引。
- 隐私：写入侧拦截密钥、令牌、密码；其余八类敏感信息（手机号、邮箱、身份证、信用卡、IP、地址等）注入前默认字段级脱敏，可切整条过滤，敏感条目不进向量索引。
- 注入与日志：注入前清理特殊括号与换行，防止伪造段落；日志不记记忆正文。
- 备份：AES-256-GCM + scrypt + 旁文件校验，篡改或口令错误直接失败；旧 CBC 备份仍可解密。
- 界面：九个页面（总览、人格、记忆、用户画像、候选与冲突、注入与预算、治理与审计、备份、高级）；轮后「这轮记了什么」卡片；检索可看命中原因与衰减系数；注入可逐字预览并与实际注入比对；危险操作需手输确认词；长列表虚拟滚动；审计展示默认脱敏。
- 工具与命令：22 个 `weave_*` 工具覆盖写入、检索、整理、治理、人格与画像，权限外操作直接拒绝；对话内 `/weave status | reload | preset <id> | strict on|off | dream`；命令行运维 `node scripts/weave.mjs status | render | persona | reset`。
- 工程：零运行时依赖，install 阶段不执行任何脚本；本地推理（transformers + onnxruntime）与 vectra 随包于 `lib/vendor`，五平台 sqlite-vec 扩展在 `lib/native`，版本固定于 `scripts/vendor-pins.mjs`，许可证汇总见 `THIRD_PARTY_NOTICES.md`；只做 CPU 推理（onnxruntime 不提供 Intel Mac 推理库），不随包 GPU 加速文件；安装包约 70 MB，模型权重首次使用时下载；需 Node ≥ 22.13；一致性自检 `pnpm conformance` 与检索护栏 `pnpm bench:guard` 进 CI。
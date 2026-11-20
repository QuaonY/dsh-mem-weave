# 使用与配置

安装、配置键、界面、AI 工具与命令行。工作原理见 [ARCHITECTURE.md](./ARCHITECTURE.md)，隐私边界见 [PRIVACY.md](./PRIVACY.md)。安装步骤与安装包内容以仓库根目录的 [README.zh-CN.md](../README.zh-CN.md) 为准。

## 1. 数据与配置

- 记忆库默认在 `$DSH_HOME/memweave/memweave.db`，可在界面「备份 → 存储位置」迁移。
- 配置写在 DSH 配置文件（`$DSH_HOME/config.json`），所有键都可缺省，缺省即最保守行为。

```json
{
  "plugins": {
    "dsh-mem-weave": {
      "dataDir": "",
      "promptLang": "zh",
      "strict": false,
      "memory": { "snapshotMaxChars": 4000, "deltaMaxChars": 1200, "recallMaxChars": 900, "recallMaxItems": 5 }
    }
  }
}
```

这些键的默认值同样写在随包的 `cordis.patch.yml` 里。表内为常用键；全量键与默认值见 `src/host/service.ts` 的 `defaultConfig()`。

### 1.1 通用

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | 空 | 空 = `$DSH_HOME/memweave`；只能在这里或 `weave_home`（需人工确认）改 |
| `promptLang` | `zh` | 注入给 AI 的提示词语言，同时决定界面语言：`zh` / `en` |
| `strict` | `false` | `true` = 所有记忆写入都需人工确认 |

### 1.2 人格与记忆

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `persona.enabled` | `true` | 是否注入人格 |
| `persona.applyNextSession` | `true` | 人格修改在下个会话生效 |
| `persona.order` | `auto` | 九块人格的顺序策略 |
| `memory.snapshotMaxChars` | `4000` | S2 快照上限（字） |
| `memory.deltaMaxChars` | `1200` | S3 增量上限（字） |
| `memory.recallMaxChars` | `900` | S3 召回上限（字） |
| `memory.recallMaxItems` | `5` | S3 最多召回条数 |
| `memory.hitTopK` | `5` | 检索返回条数 |

### 1.3 召回与向量

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `recall.routes` | `[keyword, link]` | 参与融合的检索路；配置 embedding 后可加 `semantic` |
| `recall.rrfK` | `60` | RRF 常数 |
| `recall.weights.keyword` | `1.0` | 关键词路权重 |
| `recall.weights.semantic` | `0.8` | 语义路权重 |
| `recall.weights.link` | `0.5` | 链接扩展权重 |
| `recall.synonymsFile` | 空 | 同义词表（JSON）路径 |
| `recall.semanticMinScore` | `0.42` | 语义路最小余弦；本地小模型相关度普遍偏低，设太高会整段丢命中 |
| `embedding.baseUrl` / `model` / `dimensions` | 无 | embedding 服务三件套，齐全即建立 provider；也可用环境变量指定（见 1.6） |
| `embedding.apiKey` | 无 | 服务密钥，建议放环境变量；设置查询接口不回显明文 |
| `embedding.enabled` | 缺省视为开 | `false` = 显式关闭语义路 |
| `lifecycle.halfLifeDays` | 见下 | 各层半衰期 |
| `lifecycle.decayFloor` | `0.1` | 时间衰减下限；设 0 即纯指数衰减 |
| `lifecycle.coldMemoryMonths` | `6` | 多久没用视为冷记忆（可归档） |

`lifecycle.halfLifeDays` 默认：`topic` 30、`fact` 90、`project` 180、`user` / `soul` / `lesson` 365、`rules` 0（不衰减）。

向量总开关不在配置文件里：在界面「高级 → 向量检索」开启（存记忆库）。后端按 `sqlite-vec → vectra → builtin` 自动探测，唯一关闭开关是 `MEMWEAVE_VECTOR_BACKEND=off`。语义路需「开关开 + provider 已配 + 后端可用」三者齐备才参与融合，任一环缺失只走关键词。

### 1.4 整理、治理、镜像

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dream.enabled` | `true` | 空闲时自动整理 |
| `dream.idleMinutes` | `180` | 空闲多久触发 |
| `dream.timezone` | `Asia/Shanghai` | 时区 |
| `dream.peakHours` | `[[9,12],[14,18]]` | 活跃时段（不在此时段整理） |
| `governance.autoAcceptLowRisk` | `true` | 低风险写入自动通过 |
| `governance.undoWindowHours` | `24` | 可撤销窗口（小时） |
| `governance.requireConfirmFor` | `[rules, soul, persona, delete]` | 必须人工确认的操作 |
| `governance.sensitivePatterns` | `default` | 敏感词规则集 |
| `governance.turnNotice.enabled` | `true` | 轮后「这轮记了什么」卡片（只带脱敏摘要、限定本会话） |
| `mirror.enabled` | `true` | 生成人类可读镜像 |
| `mirror.rebuildDebounceMs` | `60000` | 镜像重建防抖 |
| `mirror.maxFileKb` | `25` | 单个镜像文件上限 |
| `quote.enabled` | `false` | 是否索引会话原文（供 `weave_quote`） |
| `quote.indexDays` | `90` | 原文索引保留天数 |
| `budget.totalWarnChars` | `6000` | 三段合计超此值时提示 |
| `budget.personaWarnOnly` | `true` | 人格超预算只警告不裁剪 |

### 1.5 隐私与画像

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `privacy.recallPolicy` | `redact` | 读出侧脱敏：字段级脱敏；`filter` = 整条不参与召回与注入 |
| `profile.enabled` | `true` | 用户画像功能 |
| `profile.injectToS2` | `true` | 画像摘要注入 S2 首轮快照 |

### 1.6 环境变量

| 变量 | 作用 |
| --- | --- |
| `MEMWEAVE_VECTOR_BACKEND=off` | 关闭向量检索（唯一会落到 `disabled` 的开关） |
| `MEMWEAVE_SQLITE_VEC_PATH` | 指定 sqlite-vec 扩展文件（只指向可信路径） |
| `MEMWEAVE_EMBEDDING_BASE_URL` / `MEMWEAVE_EMBEDDING_MODEL` / `MEMWEAVE_EMBEDDING_DIMENSIONS` | 显式指定 embedding 服务（地址 / 模型 / 维度） |
| `MEMWEAVE_EMBEDDING_API_KEY` / `OPENAI_API_KEY` | embedding 服务的密钥 |
| `MEMWEAVE_EMBEDDING_DISCOVERY` | 本机自动探测：默认开启（只连 `127.0.0.1` 的 Ollama / LM Studio），设 `0` 关闭 |
| `MEMWEAVE_EMBEDDING_LOCAL_URLS` | 自定义本机探测地址 |
| `MEMWEAVE_OLLAMA_URL` / `MEMWEAVE_LMSTUDIO_URL` | 覆盖本机 Ollama / LM Studio 地址 |
| `MEMWEAVE_MODEL_ENDPOINT` | 本地模型下载源（默认 `huggingface.co`，不通时回退镜像） |
| `MEMWEAVE_DATA` | `weave.mjs` 使用的数据目录 |

## 2. 界面

| 页面 | 用途 |
| --- | --- |
| 总览 | 状态、待办、最近动作、健康检查 |
| 人格 | 编辑人格、应用预设、回滚版本、实时预览 |
| 记忆 | 浏览、搜索、编辑记忆，设置约定和纪念日 |
| 用户画像 | 查看、修正或删除「我对你的理解」 |
| 候选与冲突 | 确认 AI 想写的内容，处理相互矛盾的条目 |
| 注入与预算 | 调整上限，查看每轮实际注入了什么 |
| 治理与审计 | 撤销操作、查看审计记录 |
| 备份 | 备份、恢复、导入导出、存储位置 |
| 高级 | 遗忘、召回、向量来源、敏感词等细项 |

每轮对话结束后，对话里会出现一张小卡片，说明这轮记了什么。

## 3. 给 AI 的工具

插件向 AI 提供 22 个 `weave_*` 工具。AI 只能调用权限内的读操作与写入提案；人格、规则、裁决、永久删除会被拒绝（`E_PERM`）。

| 分组 | 工具 |
| --- | --- |
| 写入 | `weave_remember`、`weave_extract`、`weave_promise`、`weave_annotate` |
| 检索 | `weave_recall`、`weave_read`、`weave_similar`、`weave_quote` |
| 整理 | `weave_backlog`、`weave_distill`、`weave_consolidate` |
| 治理 | `weave_pending`、`weave_resolve`、`weave_restore`、`weave_forget`、`weave_revise`、`weave_audit` |
| 人格与画像 | `weave_persona`、`weave_preset`、`weave_profile`、`weave_user_profile` |
| 系统 | `weave_home` |

对话里也可以直接输入命令，不消耗 token：

```
/weave status | reload | preset <id> | strict on|off | dream
```

## 4. 命令行运维

```bash
node scripts/weave.mjs status      # 状态、条数、注入体积与 hash
node scripts/weave.mjs render      # 逐字打印三段注入
node scripts/weave.mjs persona show | diff | restore <version>
node scripts/weave.mjs reset       # 需手输 RESET，且先强制备份
```

`--data <dir>` 可指定数据目录；`lib/` 不存在时会先自动构建。

## 5. 常见问题

**AI 没记住某件事？** 先看「候选与冲突」：低置信度内容会停在候选池等确认；`strict: true` 时所有写入都要确认。

**某条记忆排到后面了？** 衰减只影响排名，条目仍在，可在「记忆」页搜到。

**能彻底删除吗？** 永久删除只能由人操作并需手输确认；AI 调用 `weave_forget` 只做归档，原文可恢复。

**换电脑怎么迁移？** 在「备份」页导出（可加密）后在新机器恢复；或直接迁移整个 `dataDir`（先退出 DSH）。

**语义路没生效？** 查三件事：界面「高级」的向量开关、embedding provider（配置 `embedding` 或环境变量）、后端是否可用（「总览」健康检查看向量后端）。恢复备份后后端会自动重新探测。任一环缺失只走关键词，召回不会不可用。

首个正式版本：给 DeepSeek Harness 的记忆与人格插件。

- **七层记忆 + 三段注入**：S1 人格、S2 会话首轮快照、S3 增量与召回，三段各自限额、互不挤压。
- **像人一样遗忘**：按层设半衰期（话题 30 天、事实 90 天、项目 180 天、个人信息 365 天、规则不衰减），只影响排名，不删数据。
- **检索**：FTS5 前置候选 + BM25 / 语义 / 链接扩展，RRF 融合后做时间衰减、去同质与反刍抑制，结果带可解释 `trace`。
- **写入治理**：来源检测、去重合并、冲突冻结、审计留痕，写入与整理都能在 24 小时内撤销。
- **权限边界**：改人格、改规则、裁决冲突、永久删除只能由人执行，AI 越权返回 `E_PERM`。
- **隐私**：密钥、令牌、密码写入即拦；八类敏感信息读出脱敏，且不进向量索引。
- **开箱即用**：零运行时依赖，随包自带五平台 sqlite-vec 扩展、本地推理组件与 vectra；九个设置页面、22 个 `weave_*` 工具。
- **数据在本机**：单个 SQLite 文件，可加密备份，无遥测、无账号。

安装：

```bash
dsh plugin --profile desktop add https://github.com/QuaonY/dsh-mem-weave/releases/download/v1.0.0/dsh-mem-weave-1.0.0.tgz
```

完整变更记录：[CHANGELOG.md](https://github.com/QuaonY/dsh-mem-weave/blob/main/CHANGELOG.md) · 使用与配置：[docs/USAGE.md](https://github.com/QuaonY/dsh-mem-weave/blob/main/docs/USAGE.md)

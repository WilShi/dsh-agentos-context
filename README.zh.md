---

> **Fork 说明**：本包是内部 `@deepseek-ai/dsh-agentos-context` 0.2.1-rc.5 源码的社区分叉，以 `@wilshi/dsh-agentos-context` 发布（MIT）。它内联了 DSH 0.2.1 的客户端 UI 基础组件，使 Web 端能在公开版加载；同时移除了部署专用的网关默认值与措辞，并重做了记忆图谱。数据格式、工具与 RPC 命名空间保持不变。
description: "为 DSH Web 与 Desktop 配置提供自动记忆、分域召回、本体图谱和本地文档知识库。"
kind: "package-bundle"
---

# @wilshi/dsh-agentos-context

[English](README.md) | 中文

## 概述

agentOS Context 为 DSH 配置增加自动长期记忆、分域召回、基于来源的本体图谱和本地文档知识库。Web 应用和 DSH Desktop 默认包含该能力。现有 OpenContext 数据无需破坏性迁移即可继续读取，新记录写入增量 sidecar。配置维护者可以通过 `dsh plugin` 添加或移除该 bundle；它有意采用有限本体，而不是通用 OWL 推理器。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步了解](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

DSH Web 和 Desktop 已通过 `dsh-web-app` 挂载此包。打开**设置 → 记忆**可以配置捕获、召回、嵌入、提炼和保留策略，也可以在记忆工作台中使用列表、图谱、审核和知识库视图。设置入口和对话页标签会跟随 DSH 当前语言。不包含 `dsh-web-app` 的配置可以显式启用或移除已安装的 bundle：

```text
dsh plugin --profile <name> add @wilshi/dsh-agentos-context
dsh plugin --profile <name> remove @wilshi/dsh-agentos-context
```

添加 bundle 会把当前实现挂到兼容的 `dsh-opencontext` Loader 行上。因此，官方设置服务会把旧设置区直接导入同一命名空间并保留原值；标记为 volatile 的字段可以即时生效，无需重启插件，但部分 volatile 开关（例如自动记忆）只作用于当前进程，重启后恢复默认值，界面和配置说明应以持久化语义为准。设置中的显式值优先于环境变量，环境变量只提供未显式配置时的默认值。如果已安装包没有公开 `dsh.bundle.patch` 声明，命令会失败。

### 自动记忆与召回

自动捕获人工提示默认开启，也可以关闭。配置模型可用时会提炼已接受的提示；提炼暂时失败时会保留一条低重要度工作记忆 24 小时，而不是丢弃提示。召回按 `run → agent → workspace → user → app → global` 顺序搜索已授权范围，将 run 记忆限制在一个会话内，并且只为已接受的用户查询注入有界证据。

3+1 分层将工作、情景、语义和程序记忆与记忆类型分别存储。重复证据可以强化并晋升记录；近似冲突会成为审核候选，不会覆盖已确立事实。凭据形状的内容受到显式保护：自动捕获会整条跳过疑似密钥、令牌或私钥的提示，显式 save/revise/reinforce 会返回 `SECRET_REJECTED`，不会把这类内容送往提炼网关或写入 sidecar。日志脱敏覆盖常见 GitHub、AWS、GitLab、npm、PEM 和 Bearer/Basic 形式。普通本地内容仍无损保留。

RPC 的 `local:`、`run:`、`session:` 等工作区范围保持可用；`user:`、`agent:`、`app:` 身份分区只允许当前可信会话身份或显式配置身份访问，`scopes` 和 `bootstrap` 也只返回可见分区。确有旧集成需要放宽时，可显式设置 `allowForeignScopeIds=true`（或 `AGENTOS_CONTEXT_ALLOW_FOREIGN_SCOPE_IDS`）恢复旧行为，但不建议用于多用户或远程环境。

### 知识库与文档解析

知识库上传需要显式操作。选择“全部范围”时，知识库视图会聚合当前文档与旧版文档，新上传的文档仍写入共享全局范围。知识库视图可以上传、列出、搜索、检查、重新索引和删除不超过 4 MiB 的文本文件，以及不超过 25 MiB 的 DOCX、XLSX、PPTX、PDF、ODT、ODS、ODP、ODG、RTF 或 EPUB 文件。二进制提取在本地运行，关闭 OCR、附件提取和外部解析服务；索引只接收有界的提取文本与来源信息。索引和搜索分别使用默认 10 分钟和 30 秒的独立时限。

没有嵌入凭据时仍可使用词法检索。配置嵌入后，此包加载本地 SQLite 向量扩展并组合词法与语义结果。基于模型的提炼和嵌入只会把选定文本与配置凭据发送到启动时精确白名单中的端点；远程端点必须使用 HTTPS，明文 HTTP 仅允许回环地址或显式写入 OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES 的端点。

### 图谱、本体与兼容性

工作台提供 2D 关系视图，以及可记住选择的 WebGL 3D 点云视图，支持轨道控制、缩放、点选、社区折叠、跟随应用当前明暗主题和基于来源的详情抽屉；不支持 WebGL 时回退到 2D。模型提取可以建议带类型的对象和关系，但每条关系必须精确引用来源，并在人工确认前保持待审核状态。汇总视图会先按记忆范围把大图谱折叠成社区，用户进入某个范围后再查看细节；单一范围继续使用确定性关系社区并保留跨社区边。

Desktop 中退出原生全屏会同步退出图谱全屏，即使没有 DOM 全屏事件。快速重新进入时，DOM 全屏事件会恢复图谱状态，上一轮延迟到达的原生退出不会关闭当前 DOM 全屏图谱。通过按钮或 Escape 主动退出后，上一轮延迟到达的 DOM 全屏进入会被退出，不会重新激活图谱全屏。仅 CSS 的全屏回退仍支持 Escape 退出。

旧 OpenContext 记忆和文档引用保持只读输入，启动时不会重写。此包保留 `dsh-opencontext` 设置命名空间，读取兼容标识，并在展示 `memory_*`、`knowledge_*` 和 `context_*` 名称的同时保留可调用的 `oc_*` 别名。新修订、退役、使用轨迹和本体状态写入 agentOS Context sidecar；schema v1 sidecar 会增量迁移到 schema v2。

sidecar 或原生 SQLite 依赖初始化失败时，插件会保持加载并明确报告 `STORE_UNAVAILABLE`，而不是让整个记忆插件消失；知识库的原生解析依赖按需加载。图谱统计区分 `truncated`（实际裁剪）与 `depthLimited`（用户限制的深度），默认按记录时间选择节点；孤立节点会合并到未聚类社区，避免一节点一社区。关系审核只允许 pending → confirmed/rejected；confirmed → rejected 记为撤回，rejected 不能再次直接确认。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部信息——点击展开</summary>

bundle patch 插入一个双端 Cordis 包。Host 端打开兼容后端和 sidecar，注册通过认证的 `agentos-context/v1/*` RPC 路由、模型工具、运行时 skill 和 Agent 生命周期监听器。Client 端安装一级记忆设置入口和工作台视图。浏览器操作使用通过认证的 Connection RPC，不再使用旧的原始浏览器路由。弹窗视图使用包内 UI 组件处理焦点约束、仅关闭栈顶弹窗的 Esc 行为和关闭后的焦点恢复，此包负责内容和布局。

旧 OpenContext 存储在首次执行相关操作时才加载，不会因为 CLI 帮助或配置结构检查而提前加载。销毁未使用的兼容后端会关闭其自有文档存储，但不会初始化旧存储。

sidecar 在 SQLite 中保存不可变的来源和记忆修订、带类型实体、已审核关系、时间有效性、幂等性和使用策略。向量索引使用相同的范围与修订检查，因此过期或未授权的嵌入不会成为召回结果。现有 OpenContext 记录以保守方式投影，并保留在原数据库中。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 激活与旧行抑制 |
| [`src/index.ts`](src/index.ts) | Host 入口、配置与插件组装 |
| [`src/context/store.js`](src/context/store.js) | sidecar 持久化、本体与修订规则 |
| [`src/recall.js`](src/recall.js) | 已接受查询的分域召回与提示注入 |
| [`src/document-parser.js`](src/document-parser.js) | 有界的本地文本与二进制文档提取 |
| [`src-client/index.tsx`](src-client/index.tsx) | 设置与记忆工作台注册 |

</details>

-----

<a id="further-exploration"></a>
## 进一步了解

- [兼容性与操作约定](docs/CONTRACT.md)
- [交互原型](prototype/PROTOTYPE.md)
- [DSH profile 与组合包](../../../docs/architecture.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 自动召回

#### 模型看到的内容

对于已接受的人工查询，此包会追加一条来源为 `agentos-context` 的用户消息，其中包含有界的 `<opencontext_evidence>` 块；该生产者自有来源兼容当前会话格式。该块将召回记录标记为不可信证据，对记录内容和 id 转义，并且只包含当前会话已授权范围内的记录。

#### Token 影响

召回最多增加配置的 `maxBytes` 证据预算及其固定包装。没有匹配记录时不增加消息。使用跟踪器会记录进入已提交请求的精确修订。

#### KV Cache 影响

证据消息位于当前人工消息之后，因此不同查询或记忆结果会改变请求后缀，但不会重写更早的持久会话历史。

### 记忆与知识库工具

#### 模型看到的内容

此包注册描述性工具，包括 `memory_search`、`memory_save`、`knowledge_search` 和 `knowledge_document_upload`；旧的 `oc_*` 名称保留为可调用别名。工具结果返回有界结构化记录或文档分块，并且不会把召回文本提升为指令。

#### Token 影响

工具 schema 会为挂载此包的预设增加固定定义。工具调用只增加模型选中的有界结果和各操作配置限制内的内容。

#### KV Cache 影响

稳定的工具定义可以保留请求前缀缓存。工具结果按普通工具调用位置追加新历史，不会修改以前的消息。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- 本体只使用已批准的有限实体与关系类型；它不实现任意 OWL 推理、组织级授权、自动冲突裁决、审核撤销、不可逆清除或跨项目共享。
- 不解析旧版 `.doc`、`.xls`、`.ppt` 和专有 `.wps`、`.et`、`.dps` 文件。请先另存为 OOXML 或 ODF。纯图片 PDF 需要 OCR，没有可提取文本时会被拒绝。
- 自动捕获默认写入当前工作区。用户、Agent 和应用范围需要可信运行时身份或显式本地配置；不可信消息无法伪造这些身份。
- 回滚到旧插件不会破坏原始记录，但会隐藏仅存在于 sidecar 的写入。因此只在 sidecar 中退役的旧记录可能在回滚后重新出现；评估期间应保留两个数据库。
- 知识库上传是本地显式操作。此包不会抓取目录、同步外部仓库或执行 OCR。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
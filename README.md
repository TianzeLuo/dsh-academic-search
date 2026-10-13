# dsh-academic-search

DSH 插件：**CS/AI 学术检索**。多来源论文发现、论文身份归并、有界引用链、arXiv 原文
下载与 reader 交接。六个工具只访问公开学术 API（arXiv / OpenAlex / Semantic Scholar /
Crossref），**不调用模型 API**。

从 `codex-readers` 的 `academic-search` 0.2.0（Codex MCP 插件）移植而来。检索引擎
（`lib/engine/`）逐字复制自该仓库，行为与边界检查保持一致；新增的是 DSH 原生的工具
封装与**项目级开关**。原仓库未做任何修改。

## 项目级开关：默认关闭

插件装进 profile 一次，但**模型可见面是按会话注册的**：没有在项目里开启时，任何会话
都看不到这六个工具和 `academic-research` 技能，工具 schema 与技能目录行都不进入上下文。

判定在每次 `agent/created`（包括恢复已有会话）时做一次：

1. 取会话头里的工作目录 `session.header.cwd`；
2. 向上找到最近的含 `.git` 的祖先目录作为**项目根**（与 DSH 自带的
   `dsh-skill-filesystem` 同一条规则）；
3. 读 `<项目根>/.dsh/research.json`；
4. 只有 `plugins["academic-search"]` 为 `true`（或对象形式 `{ "enabled": true }`）时，
   才把六个工具与一个 skill provider 注册到 `agent.ctx` 上。

注册落在 agent 自己的 scope 链上，别的会话不在那条链上——隔离是 DSH 原生的，不需要
运行期过滤。开关在**新建或恢复会话时**生效；已经跑着的会话不会中途改工具表。

### 配置文件

`<项目根>/.dsh/research.json`：

```json
{
  "version": 1,
  "plugins": {
    "academic-search": true,
    "autoresearch": { "enabled": true },
    "another-plugin": { "enabled": true, "dataRoot": "/abs/path" }
  }
}
```

- 每个插件一个键，取值 `true` / `false`，或对象（`enabled` 必填，`dataRoot` 可选）。
- `dataRoot` 让这一个项目把检索缓存放到别处；默认是 `<本包>/data/academic`。
- 键缺失、文件不存在、JSON 读不动，一律当作**关闭**——配置坏了不会让会话创建失败。
- 为省事也接受把插件 id 直接写在顶层，但 `plugins` 里的同名键优先。

### 用脚本开关

```sh
node bin/research-project.mjs status         # 看当前状态
node bin/research-project.mjs enable         # 在当前项目开启
node bin/research-project.mjs disable        # 关闭（写 false，不删键、不删文件）
node bin/research-project.mjs enable --project /path/to/project --data-root /abs/cache
```

脚本按与宿主相同的规则解析项目根，只改本插件一个键，不动配置里其他插件的条目。
`dsh-autoresearch` 有一份同样的脚本，管它自己的键。

## 六个工具

| 工具 | 做什么 | 关键参数 |
|---|---|---|
| `academic_search` | 有界多源检索：1–6 条英文查询 → 归并后的候选表 + 每来源状态 | `queries` `sources` `per_source` `limit` `mode` `detail` `ranking` `query_plan` |
| `academic_resolve` | arXiv ID/URL、DOI、OpenAlex W ID、S2 ID → 权威元数据 | `identifier` |
| `academic_expand` | 引用链一跳有界扩展（参考文献 / 被引），最多 30 条 | `identifier` `direction` `limit` |
| `academic_fetch` | 只下载 arXiv 原文：固定版本、验 PDF 文件头、存 SHA-256，返回 `reader_next.arguments` | `identifier` `expected_title` |
| `academic_read` | 按 `run_id` 本地分页读完整候选，不发网络请求 | `run_id` `offset` `limit` `detail` |
| `academic_export` | 一次检索导出完整 JSON、Markdown 候选表与 BibTeX | `run_id` |

预算上限：最多 6 查询、4 来源、每来源每查询 30 条、展示最多 100 条。`semantic` 模式
只支持 `sources: ["openalex"]`。`rate_limited` / `access_denied` / `timeout` /
`invalid_response` 都不是零命中；部分来源成功时整体为 `partial`，返回里保留每个来源
的失败状态。全部来源失败时工具抛错，不伪装成功。

`academic_fetch` 返回的 `reader_next.arguments` 要原样交给 paper-reader 的
`paper_import`；当前会话没有该工具时，把 PDF 绝对路径、`manifest_path` 与 SHA-256
交给用户，不要自己抽文本。

## 数据放在哪

默认 `<本包>/data/academic`（被 Git 忽略），目录布局与引擎一致：

```
data/academic/
├── http-cache/     成功文本响应的 24 小时缓存（键含认证 header 的哈希，不存原文）
├── source-state/   HTTP 429 的持久冷却期限
├── runs/           每次检索的完整记录（展示上限不裁剪磁盘候选）
├── exports/        导出的 JSON / Markdown / BibTeX
└── papers/         固定版本的 arXiv PDF 与来源清单
```

可选环境变量 `OPENALEX_API_KEY`、`SEMANTIC_SCHOLAR_API_KEY` 只从进程环境读取，作为
请求 header 发送；不写进 URL、配置或日志。

**不要把数据根指到 `~/.dsh` 下面**：引擎的写入边界会拒绝 `.dsh` 账户数据，宿主侧
也会在注册前就判定为不可用并保持关闭（只会记一条警告）。

## 命令行（调试用）

DSH 会话里的正常用法是直接调用工具。脱离宿主调试或批量调用时：

```sh
node bin/academic.mjs list
node bin/academic.mjs call --tool academic_search --json-file /abs/args.json --format data
```

走的是同一个引擎与同一个数据根。

## 安装

```sh
dsh plugin --profile web add /mnt/f/project/tools/plugin/dsh-academic-search
```

装完重启 `dsh web`（bundle 属启动期组装）。`cordis.patch.yml` 里的 `insert:` 行会随包
追加进 profile 的 `dsh.profile.bundles`，不需要手写。要改全局数据根就在 profile 的
`cordis.patch.yml` 里按 id 覆盖。

## 验证

```sh
node --test
```

34 个用例覆盖：项目开关判定（缺配置/关闭/开启/坏配置/子目录命中/数据根非法）、
SKILL.md 解析与 provider 契约、六个工具的 schema 子集与参数错误路径、以及随包复制的
`fast-xml-parser` 真的能解析 arXiv Atom。全部离线。

真实检索已实测（arXiv 单来源、`rectified flow generative model` → 正常返回候选与
`source_results`）。未测：人工相关性标注、开放世界召回、S2 认证来源。

## 来源与许可

- 检索引擎（`lib/engine/academic/*`、`lib/engine/lib/guarded-fs.mjs`）复制自
  `codex-readers` 的 `academic-search` 0.2.0，未做改动；上游同为 MIT。
- `lib/engine/vendor/node_modules/` 下是随包复制的 `fast-xml-parser` 及其传递依赖
  （`@nodable/entities`、`fast-xml-builder`、`is-unsafe`、`path-expression-matcher`、
  `strnum`、`xml-naming`、`anynum`），各自的 LICENSE 保留在各自目录内。
- 本包自身：MIT，见 `LICENSE`。

## 已知限制

- 检索相关性只依据标题与摘要，没有全文相关性判定；`ranking: relevance` 的概念覆盖
  重排在离线种子覆盖上没有证明优于原排序，因此不是普通查询的默认。
- `academic_fetch` 只支持 arXiv；其他来源的开放全文链接只作为候选元数据返回。
- 单进程内按来源排队（arXiv 请求间隔 ≥3.1s，其他来源 ≥1.1s）；多个独立进程的最小
  间隔不共享，429 冷却通过数据根共享。
- 网络目的地限定在实现中的学术服务 HTTPS host，不接受任意下载 URL。

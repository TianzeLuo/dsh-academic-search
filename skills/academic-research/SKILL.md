---
name: academic-research
description: 搜索 CS/AI 学术文献、从种子论文扩展引用链、形成候选阅读表并将选中原文交给 reader。用于研究问题、相关工作、论文发现和学术更新检索；单篇已导入论文内部问答继续使用 paper-reader。
---

把用户的研究问题转成有出处的论文候选和阅读顺序。当前工具不调用模型 API；远程请求使用 arXiv、OpenAlex、Semantic Scholar 或显式选择的 Crossref。检索质量依据来自标题/摘要，正文核对交给 reader。

这些工具只在**本项目开启了 academic-search** 时存在（判定见项目根 `.dsh/research.json`）。当前会话没有 `academic_search` 时不要假装调用，也不要改走 curl/python 直连学术 API：先说明本项目的开关状态，让用户在项目里开启后重开会话或恢复会话。

- 先提取核心概念、术语变体、时间范围与已有种子。优先生成 2–4 个英文查询，分开查方法、机制和评测；也查反例/限制，避免把用户假设写成检索前提。arXiv 查询支持 `ti:`、`abs:`、`cat:` 等字段；普通查询按词 AND 组合并保留引号短语；长问题可用单查询的 `query_plan.required` 指定必需概念、`optional` 指定仅用于重排的可选词，实际执行查询保留在来源状态中。零命中只建议缩短，不自动增加请求。需要更宽召回时拆短查询，保留一个不限制类别的分支。
- 调用 `academic_search`，默认三来源、每来源每查询 10 条。初轮最多 6 查询、每来源每查询 30 条、输出最多 100 条；根据任务给更小的预算。OpenAlex 语义模式需显式指定 `sources: [openalex]`，不要把其他来源的关键词搜索称为语义搜索。
- 检查 `status` 和 `source_results`。`rate_limited`、`access_denied`、`timeout`、`invalid_response` 不是零命中；仅部分来源成功时写清覆盖限制。HTTP 429 会触发短冷却，不重复轰炸；认证拒绝不更换身份或工具绕过。
- `source_records` 保存身份、出处与各来源排名；默认精简返回省略摘要、作者和原始记录；全部候选及完整记录保留在 `run_path`，展示上限不裁剪磁盘候选。用 `academic_read` 按 `run_id`、`offset`、`limit` 分页，需要摘要时用 `detail: full`；核对 `returned`、`unique_candidates`、`next_offset`。词面排序附带匹配/缺失词理由，不能冒充语义相关性；普通查询保留原排序；显式 `ranking: relevance` 或 `query_plan` 才启用概念覆盖重排，`ranking: legacy` 可恢复原排序。离线种子覆盖未证明新重排普遍更好。结果的 `work_id` 仅用于该次候选表，跨次关联用 DOI/arXiv/S2/OpenAlex ID。元数据冲突需回到来源记录核对。引用数不作为论文正确性或新颖性的证明。
- 选 3–5 篇确认相关的种子，必要时用 `academic_expand` 扩展一次参考文献或被引论文；工具不会递归遍历。arXiv/S2 种子走 Semantic Scholar，DOI/OpenAlex 种子走 OpenAlex。S2 不可用时可以用已知的 DOI/OpenAlex 身份做另一来源的公开检索，仍保留原失败记录。
- 候选表给相关理由、发表日期/状态、元数据缺项和优先阅读位置；未知保持未知。`academic_export` 可生成 Markdown、JSON、BibTeX；不能把自动导出等同于人工筛选或完整文献覆盖。
- 对选中 arXiv 论文调用 `academic_fetch`，可传 `expected_title` 在下载前检查元数据标题；返回的 `reader_next.arguments` 是要原样交给 `paper_import` 的（source 绝对路径 + provenance manifest + expected_title），贯通 PDF SHA、版本和来源清单。导入的 `identity.title_check` 只检查首页提取文本，不能替代原页人工确认；`mismatch` 或 `unavailable` 要明确说明。选定页用 `paper_evidence` 导出文本、原页 PNG、PDF 和哈希清单；导出不代表已阅读或数学已核。下载固定 arXiv 版本、保存哈希并校验 PDF 文件头；导入后核对标题和主要内容。其他来源全文地址可供用户打开，当前下载工具仅支持 arXiv。
- 当前会话没有 `paper_import` / `paper_evidence`（论文解读模式未启用）时，不要伪造交接：把 `academic_fetch` 返回的 PDF 绝对路径、`manifest_path` 和 SHA-256 如实交给用户，并说明还需要在论文解读模式下导入。

回答区分：候选元数据、摘要中的作者主张、原文证据、自己的综合判断。预算耗尽或关键来源不可用时报告停止原因；“未找到”不足以证明没有相关工作。

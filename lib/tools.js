/**
 * tools.js — 六个宿主工具：academic_search / academic_resolve / academic_expand /
 * academic_fetch / academic_read / academic_export。
 *
 * ## 为什么要自己写 defineTool 的等价物
 *
 * 官方写法是 `import { defineTool } from '@deepseek-ai/dsh-tools'`。但本包以 `link:`
 * 方式装进 profile，Node 按符号链接的 **realpath** 解析裸导入，`@deepseek-ai/*` 只
 * 存在于 profile 的 `node_modules`，不在本包的祖先目录链上，直接 ERR_MODULE_NOT_FOUND。
 * 所以本包自包含，不引入任何 DSH 包依赖（与 `dsh-paper-reader` 同样的取舍）。
 *
 * 注册表侧的实际契约（dsh-paper-reader 已实测过）：
 *
 *     { name, description, parameters(JSON Schema), output: { schema, render },
 *       async execute(args, exec) { ... } }
 *
 * **入参校验由工具自己负责**——注册表不校验 `parameters`，只有输出侧会拿
 * `output.schema` 校验返回值，不合规就抛 ToolOutputError。这里两层都做：
 * 暴露给模型的 `parameters` 用受支持的 JSON Schema 子集（`type` / `enum` /
 * `items` / `properties` / `required` / `additionalProperties` / `description`），
 * 真正的强约束（长度、上下界、日期格式、UUID）交给引擎自己的 `validate()`——
 * 它在任何网络请求和写盘之前执行，所以非法参数不会产生副作用。
 *
 * ## 为什么输出 schema 是宽松对象
 *
 * 引擎的返回值形状随状态分支变化（`ok` / `partial` / `failed` / 各种 source 错误），
 * 而且本来就是给模型读的 JSON。所以 `output.schema` 声明成
 * `{ type: 'object', additionalProperties: true }`，模型看到的是缩进过的 JSON。
 * 过大的返回按明确上限截断并说明原因，不静默丢内容。
 */

import { AcademicService, InputError } from './engine/academic/service.mjs'
import { SourceError } from './engine/academic/http.mjs'

/** 一次工具结果渲染给模型的字符上限。 */
const RENDER_LIMIT = 200_000

/** 输出 schema：任意 JSON 对象。 */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

/**
 * 构造一个对象根参数 schema。
 *
 * @param {Record<string, object>} properties 属性 schema。
 * @param {string[]} required 必填键。
 * @returns {object} 对象根、禁止未知键的 JSON Schema。
 */
function parameters(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * 文本内容块。
 *
 * @param {string} value 文本。
 * @returns {object[]} 内容块数组。
 */
function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * 按 dataRoot 复用服务实例。
 *
 * 同一个 dataRoot 只建一个 `AcademicService`，这样 HTTP 队列与限流冷却在同一进程
 * 内是共享的；跨进程的冷却靠引擎写在 `source-state/` 下的文件。不同项目可以配置
 * 不同的 dataRoot，各拿各的实例。
 */
const services = new Map()

/**
 * 取（或建）一个 dataRoot 对应的服务。
 *
 * @param {string} dataRoot 数据根绝对路径。
 * @returns {AcademicService} 服务实例。
 */
function serviceFor(dataRoot) {
  let service = services.get(dataRoot)
  if (service === undefined) {
    service = new AcademicService({ dataRoot })
    services.set(dataRoot, service)
  }
  return service
}

/**
 * 把引擎结果渲染成模型可见的文本。
 *
 * @param {unknown} value 引擎返回的结构化结果。
 * @returns {object[]} 内容块。
 */
function renderJson(value) {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  if (json.length <= RENDER_LIMIT) return text(json)
  return text(`${json.slice(0, RENDER_LIMIT)}\n…（结果超过 ${RENDER_LIMIT} 字符上限被截断；请用更小的 limit / detail / abstract_chars 重试）`)
}

/**
 * 组装一个注册表可用的工具定义。
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: object,
 *   execute: (args: object, exec: object) => Promise<unknown>,
 * }} options 工具声明。
 * @returns {object} 工具定义。
 */
function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      return options.execute(args ?? {}, exec)
    },
  }
}

/** 单条查询最多 800 字符，与引擎一致。 */
const querySchema = { type: 'string', description: '一条英文检索式，最长 800 字符' }

/**
 * 六个工具的定义。
 *
 * @param {{ dataRoot: string }} options 数据根。
 * @returns {object[]} 工具定义数组。
 */
export function createTools(options) {
  const { dataRoot } = options

  /**
   * 调用引擎并归一化错误。
   *
   * 参数错误（InputError）直接抛给模型；来源错误（SourceError）连状态一起抛；
   * 全部来源失败（`status === 'failed'`）也抛错——与原始 MCP 桥的 `isError` 语义
   * 一致：失败不会伪装成成功。`partial` 正常返回，模型必须自己看 `source_results`。
   *
   * @param {string} name 引擎工具名。
   * @param {object} args 实参。
   * @returns {Promise<unknown>} 结构化结果。
   */
  const callEngine = async (name, args) => {
    const service = serviceFor(dataRoot)
    let result
    try {
      result = await service.call(name, args)
    } catch (error) {
      if (error instanceof InputError) throw new Error(`${name} 参数不合法：${error.message}`)
      if (error instanceof SourceError) throw new Error(`${name} 来源错误（${error.status}）：${error.message}`)
      throw error
    }
    if (result.isError === true) {
      const data = result.structuredContent ?? {}
      const status = typeof data.status === 'string' ? data.status : 'error'
      const message = typeof data.error === 'string' ? data.error : '学术来源请求失败'
      throw new Error(`${name} 失败（${status}）：${message}\n${JSON.stringify(data, null, 2)}`)
    }
    return result.structuredContent
  }

  const search = tool({
    name: 'academic_search',
    description:
      '有界的学术检索：把 1–6 条英文查询发给 arXiv / OpenAlex / Semantic Scholar / Crossref，' +
      '按共享身份归并候选，返回候选表与每个来源的状态。不调用模型 API。' +
      '默认精简返回省略作者、摘要与原始来源记录，全部候选和完整记录留在 run_path；' +
      '要看细节用 academic_read 按 run_id 本地分页，或 detail: "full"。' +
      '默认每来源每查询 10 条、最多展示 20 条；上限为 6 查询、4 来源、每来源每查询 30 条、展示 100 条。' +
      'semantic 模式只支持 sources: ["openalex"]。' +
      'source_results 里的 rate_limited / access_denied / timeout / invalid_response 都不是零命中；' +
      '只有部分来源成功时整体为 partial，必须把覆盖限制写清楚。',
    parameters: parameters(
      {
        queries: {
          type: 'array',
          items: querySchema,
          description: '1–6 条英文检索式；分开查方法、机制与评测',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['arxiv', 'openalex', 'semanticscholar', 'crossref'] },
          description: '默认 arxiv、openalex、semanticscholar；跨来源会消耗更多请求预算',
        },
        per_source: { type: 'integer', description: '每来源每查询取多少条，1–30，默认 10' },
        limit: { type: 'integer', description: '展示多少条候选，1–100，默认 20；不裁剪磁盘上的候选' },
        mode: { type: 'string', enum: ['keyword', 'semantic'], description: '默认 keyword；semantic 仅支持 OpenAlex 单来源' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        date_to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        abstract_chars: { type: 'integer', description: '摘要字符上限 0–5000；显式给出时返回摘要' },
        detail: { type: 'string', enum: ['summary', 'full'], description: '默认 summary' },
        ranking: {
          type: 'string',
          enum: ['legacy', 'relevance', 'rrf'],
          description: 'legacy 为原 RRF 排序；relevance 启用概念覆盖重排；rrf 为纯融合对照',
        },
        query_plan: {
          type: 'object',
          properties: {
            required: { type: 'array', items: { type: 'string' }, description: '必需概念，1–8 个' },
            optional: { type: 'array', items: { type: 'string' }, description: '只用于重排的可选词，0–8 个' },
          },
          required: ['required'],
          additionalProperties: false,
          description: '只允许配一条 query：把必需概念与可选词分开，实际执行的查询会保留',
        },
      },
      ['queries'],
    ),
    execute: (args) => callEngine('academic_search', args),
  })

  const resolve = tool({
    name: 'academic_resolve',
    description:
      '把一个学术标识解析成权威元数据。接受 arXiv ID/URL、DOI、OpenAlex W ID 或 Semantic Scholar paper ID；' +
      '不接受任意 URL。DOI/OpenAlex 走 OpenAlex，arXiv/S2 ID 走 Semantic Scholar，没有秘密切换身份。',
    parameters: parameters(
      { identifier: { type: 'string', description: 'arXiv ID/URL、DOI、OpenAlex W ID 或 S2 paper ID' } },
      ['identifier'],
    ),
    execute: (args) => callEngine('academic_resolve', args),
  })

  const expand = tool({
    name: 'academic_expand',
    description:
      '沿引用链做一跳有界扩展：取某篇论文的参考文献或被引论文，最多 30 条。' +
      '只做一跳，不递归遍历。OpenAlex ID/DOI 走 OpenAlex，arXiv/S2 ID 走 Semantic Scholar。' +
      '返回里会如实报告截断与来源错误；OpenAlex 的参考文献 hydration 可能报告缺失 ID。',
    parameters: parameters(
      {
        identifier: { type: 'string', description: 'arXiv ID/URL、DOI、OpenAlex W ID 或 S2 paper ID' },
        direction: { type: 'string', enum: ['references', 'citations'], description: '默认 references' },
        limit: { type: 'integer', description: '最多取多少条，1–30' },
        abstract_chars: { type: 'integer', description: '摘要字符上限 0–5000，默认 1000' },
      },
      ['identifier'],
    ),
    execute: (args) => callEngine('academic_expand', args),
  })

  const fetchTool = tool({
    name: 'academic_fetch',
    description:
      '只下载 arXiv 原文 PDF：先按元数据固定到确切版本，再校验 PDF 文件头并保存 SHA-256，' +
      '返回 provenance manifest 与 reader_next.arguments。把 reader_next.arguments 原样交给' +
      ' paper_import，PDF 哈希与来源清单不符时停止导入。' +
      'expected_title 会在下载前比对解析到的元数据标题，不一致就拒绝下载。其他来源的开放全文只作为候选链接返回。',
    parameters: parameters(
      {
        identifier: { type: 'string', description: 'arXiv ID/URL' },
        expected_title: { type: 'string', description: '预期标题；与元数据不一致时拒绝下载' },
      },
      ['identifier'],
    ),
    execute: (args) => callEngine('academic_fetch', args),
  })

  const read = tool({
    name: 'academic_read',
    description:
      '按 run_id 在本地分页读取一次检索的完整候选：没有网络请求，磁盘上的全部候选都能翻到，' +
      '包括超出原展示上限的那些。detail: "full" 返回摘要与来源记录，abstract_chars 显式给出摘要上限。' +
      '返回里的 returned、unique_candidates、next_offset 区分召回与展示。',
    parameters: parameters(
      {
        run_id: { type: 'string', description: 'academic_search 返回的 run_id（UUID）' },
        offset: { type: 'integer', description: '起始偏移，默认 0' },
        limit: { type: 'integer', description: '本页条数，1–100，默认 20' },
        detail: { type: 'string', enum: ['summary', 'full'], description: '默认 summary' },
        abstract_chars: { type: 'integer', description: '摘要字符上限 0–5000' },
      },
      ['run_id'],
    ),
    execute: (args) => callEngine('academic_read', args),
  })

  const exportTool = tool({
    name: 'academic_export',
    description:
      '把一次检索的 run_id 导出成完整 JSON、Markdown 候选表和 BibTeX，输出写在配置的数据根内。' +
      '自动导出不等于人工筛选，也不能当作完整文献覆盖。',
    parameters: parameters(
      { run_id: { type: 'string', description: 'academic_search 返回的 run_id（UUID）' } },
      ['run_id'],
    ),
    execute: (args) => callEngine('academic_export', args),
  })

  return [search, resolve, expand, fetchTool, read, exportTool]
}

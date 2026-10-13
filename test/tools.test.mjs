/**
 * tools.test.mjs — 六个工具定义的契约与参数错误路径。
 *
 * 这里**不打网络**：只验证暴露给模型的 schema 在注册表支持的子集内、形状正确，
 * 以及非法参数会在请求发生之前变成工具错误。
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTools } from '../lib/tools.js'

/** 注册表支持的 schema 关键字（见 dsh-tools 的 assertSupportedJsonSchema）。 */
const SUPPORTED_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

const WITHIN_LIMIT = 200_000

/**
 * 校验一个 schema 子树只用了受支持的关键字。
 *
 * @param {unknown} node 待检查的 schema。
 * @param {string} path 诊断路径。
 */
function assertSupportedSchema(node, path = 'schema') {
  assert.equal(typeof node, 'object', `${path} 必须是对象`)
  assert.notEqual(node, null, `${path} 不能是 null`)
  for (const key of Object.keys(node)) {
    assert.ok(SUPPORTED_KEYS.has(key), `${path}.${key} 不在注册表支持的子集里`)
  }
  if (node.properties !== undefined) {
    for (const [key, value] of Object.entries(node.properties)) assertSupportedSchema(value, `${path}.properties.${key}`)
  }
  if (node.items !== undefined) assertSupportedSchema(node.items, `${path}.items`)
  if (node.oneOf !== undefined) node.oneOf.forEach((branch, index) => assertSupportedSchema(branch, `${path}.oneOf[${index}]`))
}

/**
 * 建一个 scratch 数据根。
 *
 * @returns {string} 目录路径。
 */
function scratchDataRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-academic-search-tools-'))
}

const TOOLS = createTools({ dataRoot: scratchDataRoot() })

test('导出六个工具，名字与顺序稳定', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ['academic_search', 'academic_resolve', 'academic_expand', 'academic_fetch', 'academic_read', 'academic_export'],
  )
})

test('每个工具的参数 schema 在受支持子集内且是对象根', () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0, `${tool.name} 缺少 description`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 应禁止未知参数`)
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 的 required 应是数组`)
    assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
  }
})

test('每个工具的输出 schema 是宽松对象，render 产出文本块', () => {
  for (const tool of TOOLS) {
    assert.deepEqual(tool.output.schema, { type: 'object', additionalProperties: true })
    const blocks = tool.output.render({}, { ok: true })
    assert.deepEqual(blocks, [{ type: 'text', text: '{\n  "ok": true\n}' }])
  }
})

test('必填参数与枚举与引擎的能力对齐', () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.academic_search.parameters.required, ['queries'])
  assert.deepEqual(byName.academic_resolve.parameters.required, ['identifier'])
  assert.deepEqual(byName.academic_expand.parameters.required, ['identifier'])
  assert.deepEqual(byName.academic_fetch.parameters.required, ['identifier'])
  assert.deepEqual(byName.academic_read.parameters.required, ['run_id'])
  assert.deepEqual(byName.academic_export.parameters.required, ['run_id'])
  assert.deepEqual(byName.academic_search.parameters.properties.sources.items.enum, [
    'arxiv',
    'openalex',
    'semanticscholar',
    'crossref',
  ])
  assert.deepEqual(byName.academic_search.parameters.properties.mode.enum, ['keyword', 'semantic'])
  assert.deepEqual(byName.academic_expand.parameters.properties.direction.enum, ['references', 'citations'])
})

test('非法参数在发请求之前变成工具错误', async () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]))
  await assert.rejects(
    () => byName.academic_search.execute({ queries: 'not-an-array' }, {}),
    /academic_search 参数不合法/,
  )
  await assert.rejects(() => byName.academic_search.execute({}, {}), /参数不合法/)
  await assert.rejects(
    () => byName.academic_search.execute({ queries: ['x'], unknown_key: 1 }, {}),
    /参数不合法/,
  )
  await assert.rejects(
    () => byName.academic_read.execute({ run_id: 'not-a-uuid' }, {}),
    /参数不合法/,
  )
  await assert.rejects(
    () => byName.academic_search.execute({ queries: ['x'], sources: ['arxiv'], mode: 'semantic' }, {}),
    /参数不合法/,
  )
})

test('输出超过上限时截断并说明原因', () => {
  const byName = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool]))
  const huge = { blob: 'x'.repeat(WITHIN_LIMIT + 10) }
  const [block] = byName.academic_search.output.render({}, huge)
  assert.ok(block.text.length < WITHIN_LIMIT + 400)
  assert.match(block.text, /字符上限被截断/)
})

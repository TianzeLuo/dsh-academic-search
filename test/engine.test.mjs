/**
 * engine.test.mjs — 被复制进来的引擎仍然可用。
 *
 * 这几个用例证明两件事：随包复制的 `fast-xml-parser`（连同它的传递依赖）真的能解析
 * arXiv 的 Atom；以及引擎自己的路径边界行为与本插件宿主侧的预检查一致（`.dsh`
 * 下的数据根会被拒绝）。全部离线，不打网络。
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { identifier, titleKey, parseArxiv } from '../lib/engine/academic/model.mjs'
import { AcademicService } from '../lib/engine/academic/service.mjs'

/** 一份最小的合法 arXiv Atom 响应。 */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2608.23864v1</id>
    <title>AffineTok: An Example</title>
    <summary>  We study an example.  </summary>
    <published>2026-08-01T00:00:00Z</published>
    <updated>2026-08-02T00:00:00Z</updated>
    <author><name>Ada Lovelace</name></author>
    <category term="cs.LG"/>
  </entry>
</feed>`

test('vendored fast-xml-parser 能解析 arXiv Atom', () => {
  const parsed = parseArxiv(ATOM)
  assert.equal(parsed.papers.length, 1)
  const [paper] = parsed.papers
  assert.equal(paper.title, 'AffineTok: An Example')
  assert.equal(paper.abstract, 'We study an example.')
  assert.equal(paper.ids.arxiv, '2608.23864')
  assert.equal(paper.ids.arxiv_version, '2608.23864v1')
  assert.deepEqual(paper.authors, ['Ada Lovelace'])
  assert.deepEqual(paper.categories, ['cs.LG'])
})

test('parseArxiv 拒绝非法响应', () => {
  assert.throws(() => parseArxiv('not xml'), /not a valid Atom feed/)
})

test('identifier 与 titleKey 的归一化', () => {
  assert.deepEqual(identifier('arXiv:2401.12345v2'), { type: 'arxiv', value: '2401.12345v2' })
  assert.deepEqual(identifier('https://arxiv.org/abs/2401.12345'), { type: 'arxiv', value: '2401.12345' })
  assert.equal(identifier('10.1234/abc').type, 'doi')
  assert.equal(identifier('W4391468387').type, 'openalex')
  assert.equal(titleKey('  Affine Tok: An Example '), titleKey('affine tok: an example'))
})

test('学术服务列出六个工具', () => {
  const service = new AcademicService({ dataRoot: mkdtempSync(join(tmpdir(), 'dsh-academic-search-engine-')) })
  assert.deepEqual(
    service.list().map((tool) => tool.name),
    ['academic_search', 'academic_resolve', 'academic_expand', 'academic_fetch', 'academic_read', 'academic_export'],
  )
})

test('引擎拒绝把 .dsh 账户目录当数据根（与宿主预检查一致）', () => {
  assert.throws(() => new AcademicService({ dataRoot: '/home/someone/.dsh/academic' }), /Protected account data/)
})

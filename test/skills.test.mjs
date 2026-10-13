/**
 * skills.test.mjs — SKILL.md 解析与 provider 契约。
 *
 * 覆盖：合法技能包、frontmatter 缺失/缺 description/name 与目录名不一致/多行标量，
 * 以及 provider 的 list/get 形状（`rank` 与 `locator` 不得泄漏给消费者）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildCandidates, createProvider, readSkill } from '../lib/skills.js'

/**
 * 建一个 scratch 技能根。
 *
 * @param {string} label 名字前缀。
 * @returns {string} 目录绝对路径。
 */
function scratch(label) {
  return mkdtempSync(join(tmpdir(), `dsh-academic-search-skills-${label}-`))
}

/**
 * 写一个技能包。
 *
 * @param {string} root 技能根。
 * @param {string} name 技能包目录名。
 * @param {string} body SKILL.md 全文。
 * @returns {string} 技能包目录。
 */
function writeBundle(root, name, body) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), body, 'utf8')
  return directory
}

const VALID = ['---', 'name: demo-skill', 'description: 一句话说明。', 'whenToUse: 什么时候用。', '---', '', '正文。'].join('\n')

test('readSkill 解析单行 frontmatter 并剥掉区块', () => {
  const root = scratch('valid')
  const directory = writeBundle(root, 'demo-skill', VALID)
  const skill = readSkill(directory, 'demo-skill')
  assert.equal(skill.description, '一句话说明。')
  assert.equal(skill.whenToUse, '什么时候用。')
  assert.equal(skill.body, '正文。')
  assert.equal(skill.path, join(directory, 'SKILL.md'))
})

test('readSkill 接受带引号的值与缺省 name', () => {
  const root = scratch('quoted')
  const directory = writeBundle(root, 'demo', ['---', 'description: "带: 冒号的值"', '---', 'x'].join('\n'))
  assert.equal(readSkill(directory, 'demo').description, '带: 冒号的值')
})

test('readSkill 拒绝缺 frontmatter、缺 description、name 不一致与多行标量', () => {
  const root = scratch('bad')
  assert.throws(() => readSkill(writeBundle(root, 'a', '没有 frontmatter'), 'a'), /缺少 YAML frontmatter/)
  assert.throws(() => readSkill(writeBundle(root, 'b', ['---', 'whenToUse: x', '---', 'x'].join('\n')), 'b'), /缺少 description/)
  assert.throws(
    () => readSkill(writeBundle(root, 'c', ['---', 'name: other', 'description: d', '---', 'x'].join('\n')), 'c'),
    /与目录名 "c" 不一致/,
  )
  assert.throws(
    () => readSkill(writeBundle(root, 'd', ['---', 'description: >', '  多行', '---', 'x'].join('\n')), 'd'),
    /多行标量/,
  )
})

test('buildCandidates 只认顶层技能包，按名字排序', () => {
  const root = scratch('candidates')
  writeBundle(root, 'zeta', VALID.replace('demo-skill', 'zeta'))
  writeBundle(root, 'alpha', VALID.replace('demo-skill', 'alpha'))
  // 嵌套目录里的 SKILL.md 刻意不被发现。
  writeBundle(join(root, 'alpha', 'references'), 'nested', VALID.replace('demo-skill', 'nested'))
  const names = buildCandidates(root, 'p', 600).map((candidate) => candidate.name)
  assert.deepEqual(names, ['alpha', 'zeta'])
})

test('buildCandidates 在空根上直接报错', () => {
  assert.throws(() => buildCandidates(scratch('empty'), 'p', 600), /没有任何技能包/)
})

test('provider 的 list/get 不泄漏 rank 与 locator，并带回正文', async () => {
  const root = scratch('provider')
  writeBundle(root, 'demo-skill', VALID)
  const provider = createProvider(root, 'dsh-academic-search', 600)
  assert.equal(provider.name, 'dsh-academic-search')

  const listed = await provider.list()
  assert.equal(listed.length, 1)
  const candidate = listed[0]
  assert.equal(candidate.rank, 600)
  assert.equal(candidate.locator.directory, join(root, 'demo-skill'))
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.invocation.modelInvocable, true)
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: join(root, 'demo-skill') })

  const loaded = await provider.get(candidate)
  assert.equal(loaded.content, '正文。')
  assert.equal(loaded.rank, undefined)
  assert.equal(loaded.locator, undefined)
  assert.equal(loaded.provider, 'dsh-academic-search')
  assert.equal(loaded.source, 'bundled')
})

test('createProvider 在装配期就暴露坏技能包', () => {
  const root = scratch('early')
  writeBundle(root, 'broken', '没有 frontmatter')
  assert.throws(() => createProvider(root, 'p', 600), /缺少 YAML frontmatter/)
})

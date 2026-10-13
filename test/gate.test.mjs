/**
 * gate.test.mjs — 项目级开关的判定逻辑。
 *
 * 这些用例不碰网络、不碰 profile：只验证「哪个目录算项目根」「配置怎么读」
 * 「哪些写法算开启」。宿主侧对这些函数的调用见 plugin.test.mjs。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CONFIG_RELATIVE,
  configPathFor,
  findProjectRoot,
  pluginSetting,
  readProjectConfig,
  resolveGate,
  writeProjectConfig,
} from '../lib/gate.js'

/**
 * 建一个 scratch 目录。用唯一名字，创建后不再清理。
 *
 * @param {string} label 名字前缀。
 * @returns {string} 目录绝对路径。
 */
function scratch(label) {
  return mkdtempSync(join(tmpdir(), `dsh-academic-search-${label}-`))
}

test('findProjectRoot 找到最近的含 .git 的祖先', () => {
  const root = scratch('root')
  mkdirSync(join(root, '.git'))
  const nested = join(root, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), root)
  assert.equal(findProjectRoot(root), root)
})

test('findProjectRoot 没有 .git 时退回给定目录本身', () => {
  const dir = scratch('nogit')
  const nested = join(dir, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRoot(nested), nested)
})

test('configPathFor 指向 .dsh/research.json', () => {
  assert.equal(configPathFor('/tmp/x'), join('/tmp/x', CONFIG_RELATIVE))
})

test('readProjectConfig 区分缺失、坏 JSON 与合法对象', () => {
  const root = scratch('config')
  assert.deepEqual(readProjectConfig(root), { path: join(root, CONFIG_RELATIVE), present: false })

  const path = configPathFor(root)
  mkdirSync(join(root, '.dsh'), { recursive: true })

  writeFileSync(path, '{ not json', 'utf8')
  const broken = readProjectConfig(root)
  assert.equal(broken.present, true)
  assert.match(broken.error, /合法的 JSON 对象/)

  writeFileSync(path, '[1,2,3]', 'utf8')
  assert.match(readProjectConfig(root).error, /顶层必须是一个 JSON 对象/)

  writeFileSync(path, '{"plugins":{"academic-search":true}}', 'utf8')
  assert.deepEqual(readProjectConfig(root).config, { plugins: { 'academic-search': true } })
})

test('pluginSetting 接受 true / 对象 / 顶层写法，其余一律算关闭', () => {
  assert.deepEqual(pluginSetting({ plugins: { p: true } }, 'p'), { enabled: true })
  assert.deepEqual(pluginSetting({ plugins: { p: { enabled: true, dataRoot: '/x' } } }, 'p'), {
    enabled: true,
    dataRoot: '/x',
  })
  assert.deepEqual(pluginSetting({ p: true }, 'p'), { enabled: true })
  assert.deepEqual(pluginSetting({ plugins: { p: false } }, 'p'), { enabled: false })
  assert.deepEqual(pluginSetting({ plugins: { p: { enabled: false } } }, 'p'), { enabled: false })
  assert.deepEqual(pluginSetting({ plugins: {} }, 'p'), { enabled: false })
  assert.deepEqual(pluginSetting({ plugins: { p: 'yes' } }, 'p'), { enabled: false })
  assert.deepEqual(pluginSetting(undefined, 'p'), { enabled: false })
  // 顶层写法在 plugins 里存在同名键时让位给 plugins。
  assert.deepEqual(pluginSetting({ p: true, plugins: { p: false } }, 'p'), { enabled: false })
})

test('resolveGate：没配置 / 没开启 / 开启 / 坏配置', () => {
  const root = scratch('gate')
  mkdirSync(join(root, '.git'))
  const sub = join(root, 'deep', 'dir')
  mkdirSync(sub, { recursive: true })

  // 没有配置文件：关闭。
  assert.equal(resolveGate({ cwd: sub, pluginId: 'academic-search', defaultDataRoot: '/d' }).enabled, false)

  // 开启：数据根取项目覆盖，否则取默认。
  writeProjectConfig(root, { version: 1, plugins: { 'academic-search': true } })
  const on = resolveGate({ cwd: sub, pluginId: 'academic-search', defaultDataRoot: '/d' })
  assert.equal(on.enabled, true)
  assert.equal(on.projectRoot, root)
  assert.equal(on.dataRoot, '/d')

  writeProjectConfig(root, { version: 1, plugins: { 'academic-search': { enabled: true, dataRoot: '/custom' } } })
  assert.equal(resolveGate({ cwd: sub, pluginId: 'academic-search', defaultDataRoot: '/d' }).dataRoot, '/custom')

  // 关掉：即使文件在也关闭。
  writeProjectConfig(root, { version: 1, plugins: { 'academic-search': false } })
  assert.equal(resolveGate({ cwd: sub, pluginId: 'academic-search', defaultDataRoot: '/d' }).enabled, false)

  // 坏配置：关闭，且给出原因。
  writeFileSync(configPathFor(root), 'oops', 'utf8')
  const broken = resolveGate({ cwd: sub, pluginId: 'academic-search', defaultDataRoot: '/d' })
  assert.equal(broken.enabled, false)
  assert.match(broken.reason, /合法的 JSON 对象/)

  // 会话没有工作目录：关闭。
  const noCwd = resolveGate({ cwd: undefined, pluginId: 'academic-search', defaultDataRoot: '/d' })
  assert.equal(noCwd.enabled, false)
  assert.match(noCwd.reason, /没有工作目录/)
})

test('writeProjectConfig 覆盖写且保持其他键', () => {
  const root = scratch('write')
  writeProjectConfig(root, { version: 1, plugins: { a: true } })
  const parsed = JSON.parse(readProjectConfig(root).config === undefined ? '{}' : JSON.stringify(readProjectConfig(root).config))
  assert.deepEqual(parsed, { version: 1, plugins: { a: true } })
})

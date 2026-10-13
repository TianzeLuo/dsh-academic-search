/**
 * plugin.test.mjs — 宿主侧的「默认关闭、按项目开启」。
 *
 * 用一个最小的假 Cordis 上下文跑真实的 `apply`，覆盖：
 *
 *   - 没配置 / 关了 / 配置坏了 → 一个工具、一个技能都不注册；
 *   - 项目开了 → 六个工具 + 一个 provider，且注册落在**这条 agent 的 ctx** 上；
 *   - 数据根非法（例如指到 .dsh 下）→ 保持关闭并给警告，而不是等到调用时才炸；
 *   - agent 释放与插件卸载都会撤销注册。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { configPathFor, writeProjectConfig } from '../lib/gate.js'

/**
 * 建一个 scratch 目录。
 *
 * @param {string} label 前缀。
 * @returns {string} 绝对路径。
 */
function scratch(label) {
  return mkdtempSync(join(tmpdir(), `dsh-academic-search-host-${label}-`))
}

/**
 * 造一个最小的假上下文。
 *
 * @param {Record<string, unknown>} services 该层能看到的服务。
 * @param {object} state 共享状态。
 * @returns {object} 假 Context。
 */
function makeContext(services, state) {
  return {
    logger: { warn: (message) => state.warnings.push(message) },
    inject(deps, callback) {
      if (deps.every((dep) => services[dep] !== undefined)) callback(makeContext(services, state))
    },
    on(event, handler) {
      state.listeners[event] = [...(state.listeners[event] ?? []), handler]
    },
    effect(factory) {
      state.effects.push(factory)
    },
    ...services,
  }
}

/**
 * 造宿主测试环境。
 *
 * @returns {object} 环境对象。
 */
function harness() {
  const state = { warnings: [], listeners: {}, effects: [], tools: [], providers: [], liveAgents: [] }
  const tools = {
    register(definition) {
      state.tools.push(definition.name)
      return () => {
        state.tools = state.tools.filter((name) => name !== definition.name)
      }
    },
  }
  const skills = {
    registerProvider(factory) {
      const provider = factory({ invalidate() {} })
      state.providers.push(provider.name)
      return () => {
        state.providers = state.providers.filter((name) => name !== provider.name)
      }
    },
  }
  const agents = { list: () => state.liveAgents }
  return { state, root: makeContext({ agents }, state), agentServices: { tools, skills } }
}

/**
 * 建一个项目目录并可选地写配置。
 *
 * @param {string | object} config 配置对象；省略则不写文件。
 * @returns {string} 项目根。
 */
function project(config) {
  const root = scratch('project')
  mkdirSync(join(root, '.git'))
  if (config !== undefined) writeProjectConfig(root, config)
  return root
}

/**
 * 造一个假 agent。
 *
 * @param {object} harness 环境。
 * @param {string} cwd 会话工作目录。
 * @returns {object} 假 agent。
 */
function agentContext(harness, cwd) {
  const agent = {
    id: 'session-1',
    session: { header: { cwd } },
  }
  agent.ctx = makeContext(harness.agentServices, harness.state)
  return agent
}

test('没有配置文件时不注册任何工具与技能', () => {
  const h = harness()
  apply(h.root, {})
  const agent = agentContext(h, project())
  h.state.listeners['agent/created'][0]({ agent })
  assert.deepEqual(h.state.tools, [])
  assert.deepEqual(h.state.providers, [])
})

test('项目显式开启时注册六个工具与一个 skill provider', () => {
  const root = project({ version: 1, plugins: { 'academic-search': true } })
  const h = harness()
  apply(h.root, {})
  const agent = agentContext(h, root)
  h.state.listeners['agent/created'][0]({ agent })
  assert.deepEqual(h.state.tools, [
    'academic_search',
    'academic_resolve',
    'academic_expand',
    'academic_fetch',
    'academic_read',
    'academic_export',
  ])
  assert.deepEqual(h.state.providers, ['dsh-academic-search'])
  assert.ok(h.state.warnings.some((message) => message.includes('已为会话')))
})

test('子目录里开会话也能命中项目根的配置', () => {
  const root = project({ version: 1, plugins: { 'academic-search': true } })
  const nested = join(root, 'packages', 'a')
  mkdirSync(nested, { recursive: true })
  const h = harness()
  apply(h.root, {})
  h.state.listeners['agent/created'][0]({ agent: agentContext(h, nested) })
  assert.equal(h.state.tools.length, 6)
})

test('显式关闭与坏配置都保持关闭', () => {
  const off = project({ version: 1, plugins: { 'academic-search': false } })
  const h1 = harness()
  apply(h1.root, {})
  h1.state.listeners['agent/created'][0]({ agent: agentContext(h1, off) })
  assert.deepEqual(h1.state.tools, [])

  const broken = project()
  mkdirSync(join(broken, '.dsh'), { recursive: true })
  writeFileSync(configPathFor(broken), '{ oops', 'utf8')
  const h2 = harness()
  apply(h2.root, {})
  h2.state.listeners['agent/created'][0]({ agent: agentContext(h2, broken) })
  assert.deepEqual(h2.state.tools, [])
  assert.deepEqual(h2.state.providers, [])
})

test('只开启另一个插件时本插件不注册', () => {
  const root = project({ version: 1, plugins: { autoresearch: true } })
  const h = harness()
  apply(h.root, {})
  h.state.listeners['agent/created'][0]({ agent: agentContext(h, root) })
  assert.deepEqual(h.state.tools, [])
})

test('数据根指到 .dsh 下时保持关闭并给出警告', () => {
  const root = project({ version: 1, plugins: { 'academic-search': { enabled: true, dataRoot: '/home/u/.dsh/cache' } } })
  const h = harness()
  apply(h.root, {})
  h.state.listeners['agent/created'][0]({ agent: agentContext(h, root) })
  assert.deepEqual(h.state.tools, [])
  assert.deepEqual(h.state.providers, [])
  assert.ok(h.state.warnings.some((message) => message.includes('.dsh')))
})

test('同一个 agent 重复宣告只安装一次；释放后撤销注册', () => {
  const root = project({ version: 1, plugins: { 'academic-search': true } })
  const h = harness()
  apply(h.root, {})
  const agent = agentContext(h, root)
  h.state.listeners['agent/created'][0]({ agent })
  h.state.listeners['agent/created'][0]({ agent })
  assert.equal(h.state.tools.length, 6)

  h.state.listeners['agent/disposed'][0]({ agent })
  assert.deepEqual(h.state.tools, [])
  assert.deepEqual(h.state.providers, [])
})

test('插件卸载会撤销全部注册', () => {
  const root = project({ version: 1, plugins: { 'academic-search': true } })
  const h = harness()
  apply(h.root, {})
  h.state.listeners['agent/created'][0]({ agent: agentContext(h, root) })
  assert.equal(h.state.tools.length, 6)
  // effect 工厂返回 dispose。
  for (const factory of h.state.effects) factory()()
  assert.deepEqual(h.state.tools, [])
  assert.deepEqual(h.state.providers, [])
})

test('apply 时已经存在的 agent 也会被安装', () => {
  const root = project({ version: 1, plugins: { 'academic-search': true } })
  const h = harness()
  const existing = agentContext(h, root)
  h.state.liveAgents.push(existing)
  apply(h.root, {})
  assert.equal(h.state.tools.length, 6)
})

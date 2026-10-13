/**
 * index.js — dsh-academic-search 的宿主插件。
 *
 * ## 这个插件做什么
 *
 * 六个学术检索工具（`academic_search` / `academic_resolve` / `academic_expand` /
 * `academic_fetch` / `academic_read` / `academic_export`）加一个 `academic-research`
 * 技能。工具只访问公开学术 API（arXiv / OpenAlex / Semantic Scholar / Crossref），
 * 不调用模型 API；原文解读与图表核对交给 reader。
 *
 * ## 项目级开关：默认关闭
 *
 * 插件本身装进 profile 一次，但**模型可见面是按会话注册的**：
 *
 *   1. 每次 `agent/created`（含 resume）读会话头里的工作目录 `session.header.cwd`；
 *   2. 向上找到项目根（最近的含 `.git` 的祖先，与 `dsh-skill-filesystem` 同规则）；
 *   3. 读 `<项目根>/.dsh/research.json`，只有 `plugins["academic-search"] === true`
 *      （或对象形式 `{ "enabled": true }`）才注册；
 *   4. 注册只落在 `agent.ctx` 上——工具与 skill provider 都只对这一条 agent 的
 *      scope 链可见，别的会话根本不在那条链上。
 *
 * 没开、没配置文件、配置坏了，一律不注册任何东西：其他任务看不到工具、看不到技能，
 * 也不背任何 schema 或目录行的 token。这就是「默认关闭、按项目开启」。
 *
 * ## 为什么不做成 preset / 模式
 *
 * preset 的粒度是「每个会话选模式」，装不装东西由用户当场选。这里要的是**项目**
 * 决定：同一个账号下的不同项目，各自的目录里说了算。用 `agent.ctx` 做作用域注册
 * 同样是 DSH 原生的隔离机制（preset 内部用的就是它），只是触发器换成了项目配置。
 *
 * ## 失败不连坐
 *
 * `agent/created` 的监听器抛错会让整次会话创建失败，所以判定与注册全程包在
 * try/catch 里：配置读不动、数据根非法，都只记一条 warn，插件对这次会话保持关闭，
 * 会话照常创建。同理，不声明静态 `inject`——缺 `agents` 服务的部署里这一行只是
 * 不生效，而不会让 profile 起不来。
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { CONFIG_RELATIVE, resolveGate } from './gate.js'
import { createProvider } from './skills.js'
import { createTools } from './tools.js'

/** 插件 id：只用于日志与 provider 名，与 loader 行 id 无关。 */
export const name = 'academic-search'

/** 本包根目录（`package.json` 所在目录）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 技能包根目录。 */
const SKILLS_ROOT = join(PACKAGE_ROOT, 'skills')

/** 注册到 skill 注册表的 provider 名。 */
const PROVIDER = 'dsh-academic-search'

/**
 * 同名技能的去重等级，与官方 `bundled` 根（600）一致。
 *
 * 取 600 而不是更小：项目自己的 `.dsh/skills`（100）或 `.agents/skills`（200）
 * 里同名技能应当能盖过本插件的默认版本。
 */
const SKILL_RANK = 600

/** 默认数据根：本包内的 `data/academic`。 */
const DEFAULT_DATA_ROOT = join(PACKAGE_ROOT, 'data', 'academic')

/**
 * 判断数据根能不能用。
 *
 * 引擎自带边界检查：写入根不得落在 `.dsh`（账户数据）之下、不得是盘符根或系统
 * 目录、不得经过 symlink/junction。默认数据根在包内，所以正常配置不会撞上；
 * 但用户完全可能把 `dataRoot` 指到 `~/.dsh/...`——那种情况引擎会在每次写盘时
 * 才报错，不如在注册前就说清楚并保持关闭。
 *
 * @param {string} dataRoot 候选数据根。
 * @returns {string | undefined} 不可用时的原因。
 */
function dataRootProblem(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) return '数据根为空'
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(dataRoot)) return `数据根不是绝对路径：${dataRoot}`
  if (/(?:^|[\\/])\.dsh(?:[\\/]|$)/i.test(dataRoot)) {
    return `数据根不能落在 .dsh 账户目录下（引擎的写入边界会拒绝）：${dataRoot}`
  }
  return undefined
}

/**
 * 把工具与 skill provider 注册到一条 agent 的 scope 上。
 *
 * 返回一个幂等的 dispose。里面的 `inject` 回调在服务已就绪时是同步执行的；万一
 * 之后才激活，`closed` 标记保证已经关闭的注册会被立刻撤销，不会漏。
 *
 * @param {object} agent 目标 agent。
 * @param {string} dataRoot 本会话使用的数据根。
 * @param {(message: string) => void} warn 警告回调。
 * @returns {() => void} dispose。
 */
function installForAgent(agent, dataRoot, warn) {
  /** @type {Array<() => void>} */
  const disposers = []
  let closed = false
  const register = (dispose) => {
    if (typeof dispose !== 'function') return
    if (closed) dispose()
    else disposers.push(dispose)
  }

  const scoped = agent.ctx

  scoped.inject(['tools'], (scope) => {
    // 注意：inject 回调在微任务里激活，已经不是 `agent/created` 监听的同步栈，
    // 抛错不会被那边的 try/catch 接住，只会变成一条无人处理的 fiber 错误。所以
    // 这里吞掉并报告：注册失败最坏是这次会话没有工具，不该影响会话本身。
    try {
      for (const definition of createTools({ dataRoot })) register(scope.tools.register(definition))
    } catch (error) {
      warn(`注册工具失败，本次会话的工具不完整：${error.message}`)
    }
  })

  scoped.inject(['skills'], (scope) => {
    register(
      scope.skills.registerProvider(() => {
        // 技能包读盘失败（例如被删）不应该让 skill 目录整体不可用，但也不该静默：
        // 报给它自己的目录调用，拿到的就是空列表 + 一条警告。
        try {
          return createProvider(SKILLS_ROOT, PROVIDER, SKILL_RANK)
        } catch (error) {
          warn(`技能包不可用：${error.message}`)
          return { name: PROVIDER, list: () => Promise.resolve([]), get: () => Promise.resolve(undefined) }
        }
      }),
    )
  })

  return () => {
    closed = true
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx profile 根层的插件上下文。
 * @param {{ dataRoot?: string }} [config] loader 行里的配置。
 */
export function apply(ctx, config = {}) {
  const pluginDataRoot = config.dataRoot ?? DEFAULT_DATA_ROOT

  ctx.inject(['agents'], (scoped) => {
    /** @type {Map<object, () => void>} */
    const installed = new Map()

    const warn = (message) => {
      try {
        scoped.logger?.warn?.(`[${name}] ${message}`)
      } catch {
        // 日志失败不能影响会话创建。
      }
    }

    /**
     * 判定并（必要时）安装。
     *
     * @param {object} agent 新建或恢复的 agent。
     */
    const maybeInstall = (agent) => {
      if (installed.has(agent)) return
      const cwd = agent?.session?.header?.cwd
      const gate = resolveGate({ cwd, pluginId: name, defaultDataRoot: pluginDataRoot })
      if (!gate.enabled) return
      const problem = dataRootProblem(gate.dataRoot)
      if (problem !== undefined) {
        warn(`项目已开启 ${name}，但数据根不可用，本次会话保持关闭：${problem}`)
        return
      }
      installed.set(agent, installForAgent(agent, gate.dataRoot, warn))
      warn(`已为会话 ${agent.id} 开启（${gate.configPath}）`)
    }

    for (const agent of scoped.agents.list()) {
      try {
        maybeInstall(agent)
      } catch (error) {
        warn(`恢复已存在会话时安装失败：${error.message}`)
      }
    }

    scoped.on('agent/created', ({ agent }) => {
      try {
        maybeInstall(agent)
      } catch (error) {
        // 判定或注册失败只影响本插件的可见性，绝不能让会话创建失败。
        warn(`安装失败，本次会话保持关闭：${error.message}`)
      }
    })

    scoped.on('agent/disposed', ({ agent }) => {
      const dispose = installed.get(agent)
      if (dispose === undefined) return
      installed.delete(agent)
      try {
        dispose()
      } catch (error) {
        warn(`卸载失败：${error.message}`)
      }
    })

    scoped.effect(
      () => () => {
        for (const dispose of installed.values()) {
          try {
            dispose()
          } catch {
            // 关停阶段不再放大错误。
          }
        }
        installed.clear()
      },
      `${name}:scoped-registrations()`,
    )
  })
}

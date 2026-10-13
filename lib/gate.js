/**
 * gate.js — 项目级开关：默认关闭，只在显式开启的项目里生效。
 *
 * ## 为什么要有这一层
 *
 * 本插件装进 profile 后对**所有**会话可见，但它的工具与技能只应该在需要它的
 * 项目里进入模型上下文。所以每次创建/恢复 agent 时先看这个会话的工作目录：
 * 找到项目根，读 `<项目根>/.dsh/research.json`，只有这个插件被显式打开才注册。
 * 没开、没文件、文件坏了，一律不注册——默认关闭，其他任务零上下文开销。
 *
 * ## 项目根怎么定
 *
 * 与 DSH 自己的 `dsh-skill-filesystem` 一致：从会话工作目录向上找最近的、含有
 * `.git` 的祖先目录；一路上都没有就退回工作目录本身。这样在一个仓库的子目录里
 * 开会话，也能命中仓库根的配置。
 *
 * ## 配置文件格式
 *
 * `<项目根>/.dsh/research.json`，UTF-8 JSON：
 *
 *     {
 *       "version": 1,
 *       "plugins": {
 *         "academic-search": true,
 *         "autoresearch": { "enabled": true, "dataRoot": "/abs/path" }
 *       }
 *     }
 *
 * 每个插件条目的取值可以是 `true`、`false`，或一个对象（`enabled` 必填，
 * `dataRoot` 可选，用来把这一个项目的检索缓存放到别处）。缺失等于 `false`。
 * 为省事也接受把插件 id 直接写在顶层，但 `plugins` 优先。
 *
 * 本模块只读文件从不写文件；写配置由 `bin/research-project.mjs` 负责，关掉一个
 * 插件是把 `enabled` 改成 `false`，从不删除键或文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 相对项目根的配置路径。 */
export const CONFIG_RELATIVE = join('.dsh', 'research.json')
/** 当前配置文件版本，仅作记录，不影响判定。 */
export const CONFIG_VERSION = 1

/**
 * 找项目根：最近的含 `.git` 的祖先目录，找不到就退回 `cwd`。
 *
 * @param {string} cwd 会话工作目录（绝对路径）。
 * @returns {string} 项目根绝对路径。
 */
export function findProjectRoot(cwd) {
  let current = resolve(cwd)
  for (;;) {
    // `.git` 可能是目录（普通 clone），也可能是文件（worktree）。存在即可。
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 配置文件的绝对路径。
 *
 * @param {string} projectRoot 项目根。
 * @returns {string} `<项目根>/.dsh/research.json`。
 */
export function configPathFor(projectRoot) {
  return join(resolve(projectRoot), CONFIG_RELATIVE)
}

/**
 * 读项目配置。
 *
 * 从不抛错：文件缺失、读不动、不是合法 JSON 对象，都返回带 `error`/`present`
 * 的结果，由调用方决定怎么处理。宿主侧一律当作「没开启」——配置坏了不应该让
 * 会话创建失败。
 *
 * @param {string} projectRoot 项目根。
 * @returns {{ path: string, present: boolean, config?: object, error?: string }}
 *   解析结果；`present` 表示文件是否存在。
 */
export function readProjectConfig(projectRoot) {
  const path = configPathFor(projectRoot)
  if (!existsSync(path)) return { path, present: false }
  let raw
  try {
    raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return { path, present: true, error: `无法读取配置文件：${error.message}` }
  }
  if (raw.trim().length === 0) return { path, present: true, config: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是一个 JSON 对象')
    }
    return { path, present: true, config: parsed }
  } catch (error) {
    return { path, present: true, error: `配置文件不是合法的 JSON 对象：${error.message}` }
  }
}

/**
 * 取出一个插件在配置里的条目。
 *
 * @param {object | undefined} config 解析后的配置对象。
 * @param {string} pluginId 插件 id，例如 `academic-search`。
 * @returns {{ enabled: boolean, dataRoot?: string }} 归一化后的开关。
 */
export function pluginSetting(config, pluginId) {
  const fromMap = config?.plugins?.[pluginId]
  const entry = fromMap === undefined ? config?.[pluginId] : fromMap
  if (entry === true) return { enabled: true }
  if (entry === undefined || entry === null || entry === false) return { enabled: false }
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const dataRoot = typeof entry.dataRoot === 'string' && entry.dataRoot.length > 0 ? entry.dataRoot : undefined
    return { enabled: entry.enabled === true, ...(dataRoot === undefined ? {} : { dataRoot }) }
  }
  return { enabled: false }
}

/**
 * 判定一次会话是否应该装上本插件。
 *
 * @param {{
 *   cwd: string | undefined,
 *   pluginId: string,
 *   defaultDataRoot?: string,
 * }} options 判定输入。`cwd` 来自会话头，可能缺失；`defaultDataRoot` 给不带
 *   数据根的插件（例如纯 skill 插件）省略。
 * @returns {{
 *   enabled: boolean, projectRoot?: string, configPath?: string,
 *   dataRoot?: string, reason: string,
 * }} 判定结果；`reason` 一律给出人类可读的原因，便于日志排查。
 */
export function resolveGate(options) {
  const { cwd, pluginId, defaultDataRoot } = options
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { enabled: false, reason: '会话没有工作目录，无法判定项目开关' }
  }
  const projectRoot = findProjectRoot(cwd)
  const read = readProjectConfig(projectRoot)
  if (!read.present) {
    return { enabled: false, projectRoot, configPath: read.path, reason: `未创建 ${CONFIG_RELATIVE}` }
  }
  if (read.error !== undefined) {
    return { enabled: false, projectRoot, configPath: read.path, reason: read.error }
  }
  const setting = pluginSetting(read.config, pluginId)
  if (!setting.enabled) {
    return { enabled: false, projectRoot, configPath: read.path, reason: `${pluginId} 未在该项目中开启` }
  }
  const dataRoot = setting.dataRoot ?? defaultDataRoot
  return {
    enabled: true,
    projectRoot,
    configPath: read.path,
    ...(dataRoot === undefined ? {} : { dataRoot }),
    reason: `已由 ${read.path} 开启`,
  }
}

/**
 * 写入项目配置（只由 CLI 使用，宿主侧不写）。
 *
 * 采用直接覆盖写：文件很小，且半截 JSON 只会让 `readProjectConfig` 报错并把插件
 * 当作关闭，不会静默用错值。关插件写 `false`，不删键、不删文件。
 *
 * @param {string} projectRoot 项目根。
 * @param {object} config 完整配置对象。
 * @returns {string} 写入的绝对路径。
 */
export function writeProjectConfig(projectRoot, config) {
  const path = configPathFor(projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return path
}

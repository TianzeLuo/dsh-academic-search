/**
 * skills.js — 把本包 `skills/` 下的技能包注册成 agent 作用域的 skill provider。
 *
 * ## 为什么是 provider，而不是 `ctx.skills.register()`
 *
 * 两者都能注册运行时技能，但 provider 能给出 `path` 与 `resourceBase`：模型加载
 * 技能正文后，`skill` 工具会告诉它技能包目录在哪，正文里写的
 * `references/*.md`、`scripts/*.mjs` 才有可读的落点。纯 `register()` 做不到这一点
 * （正文里的相对路径没有基准）。
 *
 * ## 隔离从哪里来
 *
 * provider 是注册在 **agent 自己的 scope** 上的（见 `lib/index.js` 的
 * `agent.ctx.skills.registerProvider`）。DSH 的 skill 注册表按作用域链解析，别的
 * 会话不在那条链上，根本不会被问到——隔离是结构性的，这里不需要任何运行期判断。
 *
 * ## 扫描规则
 *
 * 只认顶层目录里的 `SKILL.md`，与官方 `dsh-skill-filesystem` 一致：更深一层目录
 * （`references/`、`scripts/`）里的同名文件刻意不发现，免得把参考资料当成技能。
 *
 * frontmatter 只解析单行标量。本包的 SKILL.md 由我们自己维护，格式固定；遇到
 * 多行标量（`>` / `|`）直接报错要求写单行，而不是猜。这样不需要为一个 frontmatter
 * 再拖一个 YAML 依赖进来。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** SKILL.md 的 YAML frontmatter 区块。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * 解析 frontmatter 的单行 `key: value` 字段。
 *
 * @param {string} block frontmatter 区块内容（不含分隔线）。
 * @param {string} file 出错时报告用的文件路径。
 * @returns {Record<string, string>} 字段表。
 * @throws {Error} 行里没有冒号，或用了多行标量时。
 */
function parseFrontmatterFields(block, file) {
  const fields = {}
  for (const line of block.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) throw new Error(`${file} 的 frontmatter 行无法解析：${line}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.startsWith('>') || value.startsWith('|')) {
      throw new Error(`${file} 的 ${key} 用了多行标量，请写成单行`)
    }
    const quoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    fields[key] = value
  }
  return fields
}

/**
 * 读取并校验一个技能包。
 *
 * @param {string} directory 技能包目录。
 * @param {string} expectedName 目录名，同时也是技能的对外名字。
 * @returns {{ path: string, description: string, whenToUse?: string, body: string }}
 *   解析后的字段与去掉 frontmatter 的正文。
 * @throws {Error} 缺 SKILL.md、缺 frontmatter、缺 description，或 frontmatter 的
 *   name 与目录名不一致时。
 */
export function readSkill(directory, expectedName) {
  const path = join(directory, 'SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const match = FRONTMATTER.exec(raw)
  if (match?.[1] === undefined) throw new Error(`${path} 缺少 YAML frontmatter`)
  const fields = parseFrontmatterFields(match[1], path)
  const description = fields.description
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`${path} 的 frontmatter 缺少 description`)
  }
  const whenToUse = fields.whenToUse
  // 技能名取自目录名。声明了 name 却不一致就直接报错：否则模型拿目录名去加载、
  // 人对着文件里的名字排查，这种不一致很难发现。
  if (fields.name !== undefined && fields.name !== expectedName) {
    throw new Error(`${path} 的 frontmatter name "${fields.name}" 与目录名 "${expectedName}" 不一致`)
  }
  return {
    path,
    description,
    ...(whenToUse === undefined || whenToUse.length === 0 ? {} : { whenToUse }),
    body: raw.slice(match[0].length).trim(),
  }
}

/**
 * 列出技能包目录名，按字典序。
 *
 * @param {string} root 技能根目录。
 * @returns {string[]} 技能名数组。
 */
export function listSkillNames(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * 每次调用都重新读盘，构建当前候选。改正文、增删技能包都即时生效，不需要重载
 * 插件。
 *
 * @param {string} root 技能根目录。
 * @param {string} providerName 注册到注册表的 provider 名。
 * @param {number} rank 同名技能的去重等级，越小越优先。
 * @returns {object[]} 候选数组。
 * @throws {Error} 根目录下没有任何技能包，或某个技能包校验不通过时。
 */
export function buildCandidates(root, providerName, rank) {
  const names = listSkillNames(root)
  if (names.length === 0) throw new Error(`${root} 下没有任何技能包`)
  return names.map((skillName) => {
    const directory = join(root, skillName)
    const skill = readSkill(directory, skillName)
    return {
      name: skillName,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      path: skill.path,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: providerName,
      source: 'bundled',
      rank,
      resourceBase: { kind: 'directory', path: directory },
      locator: { directory },
    }
  })
}

/**
 * 构造注册表可用的 skill provider。
 *
 * 激活时先校验一次技能包，装配错误早暴露，而不是等到第一次列目录。
 * `list()` 每次重新扫描、`get()` 每次重新读盘。
 *
 * @param {string} root 技能根目录。
 * @param {string} providerName 注册到注册表的 provider 名。
 * @param {number} rank 同名技能的去重等级。
 * @returns {{ name: string, list: () => Promise<object[]>, get: (candidate: object) => Promise<object> }}
 *   provider。
 */
export function createProvider(root, providerName, rank) {
  buildCandidates(root, providerName, rank)
  return {
    name: providerName,
    list() {
      return Promise.resolve(buildCandidates(root, providerName, rank))
    },
    get(candidate) {
      // `rank` / `locator` 是 provider 与注册表之间的私有字段，返回前剥掉。
      const { rank: _rank, locator, ...summary } = candidate
      const skill = readSkill(locator.directory, candidate.name)
      return Promise.resolve({ ...summary, content: skill.body })
    },
  }
}

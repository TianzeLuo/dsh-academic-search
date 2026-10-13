#!/usr/bin/env node
/**
 * research-project.mjs — 项目级开关的读写入口（本包只碰自己的键）。
 *
 * 用法：
 *
 *     node bin/research-project.mjs status  [--project <目录>]
 *     node bin/research-project.mjs enable  [--project <目录>] [--data-root <绝对目录>]
 *     node bin/research-project.mjs disable [--project <目录>]
 *
 * `--project` 默认当前目录。脚本会按与宿主相同的规则（最近的含 `.git` 的祖先）
 * 解析项目根，写 `<项目根>/.dsh/research.json`。
 *
 * 只改本插件一个键：`disable` 把 `enabled` 写成 `false`，**不删键、不删文件**，
 * 也不动配置里其他插件的条目。这样两个插件可以各自独立启停，共用一份配置。
 *
 * 开关在**新建或恢复会话时**生效：改完开一个新任务，或在已有会话里让它恢复一次。
 */

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { CONFIG_VERSION, findProjectRoot, pluginSetting, readProjectConfig, writeProjectConfig } from '../lib/gate.js'

/** 本包负责的插件 id。 */
const PLUGIN_ID = 'academic-search'

/**
 * 解析 `--flag value` 形式的命令行。
 *
 * @param {string[]} argv 参数（不含 node 与脚本名）。
 * @returns {{ command: string, values: Record<string, string> }} 解析结果。
 * @throws {Error} 未知选项、缺值或命令不认识时。
 */
function parseArgv(argv) {
  const values = {}
  let command
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      if (command !== undefined) throw new Error(`多余的参数：${token}`)
      command = token
      continue
    }
    const key = token.slice(2)
    if (!['project', 'data-root'].includes(key)) throw new Error(`未知选项：--${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 缺值`)
    values[key] = value
    index += 1
  }
  return { command: command ?? 'status', values }
}

/**
 * 入口。
 *
 * @returns {number} 进程退出码。
 */
function main() {
  let parsed
  try {
    parsed = parseArgv(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
  const { command, values } = parsed
  if (!['status', 'enable', 'disable'].includes(command)) {
    process.stderr.write(`命令必须是 status / enable / disable，收到：${command}\n`)
    return 2
  }

  const projectDir = resolve(values.project ?? process.cwd())
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    process.stderr.write(`--project 不是一个已存在的目录：${projectDir}\n`)
    return 2
  }
  const projectRoot = findProjectRoot(projectDir)
  const read = readProjectConfig(projectRoot)
  if (read.present && read.error !== undefined) {
    process.stderr.write(`${read.error}\n`)
    process.stderr.write(`请先修好或移开这个文件，脚本不会覆盖读不懂的配置：${read.path}\n`)
    return 1
  }

  if (command === 'status') {
    const status = pluginSetting(read.config, PLUGIN_ID)
    process.stdout.write(
      `${JSON.stringify(
        {
          plugin: PLUGIN_ID,
          projectRoot,
          configPath: read.path,
          configPresent: read.present,
          enabled: status.enabled,
          dataRoot: status.dataRoot ?? null,
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  const config = {
    version: typeof read.config?.version === 'number' ? read.config.version : CONFIG_VERSION,
    ...(read.config ?? {}),
    plugins: { ...(read.config?.plugins ?? {}) },
  }
  const previous = pluginSetting(read.config, PLUGIN_ID)
  if (command === 'enable') {
    const entry = { enabled: true }
    if (values['data-root'] !== undefined) {
      if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(values['data-root'])) {
        process.stderr.write(`--data-root 必须是绝对路径：${values['data-root']}\n`)
        return 2
      }
      entry.dataRoot = values['data-root']
    } else if (previous.dataRoot !== undefined) {
      // 只是重新开启时保留原数据根，别把用户配的路径抹掉。
      entry.dataRoot = previous.dataRoot
    }
    config.plugins[PLUGIN_ID] = entry
  } else {
    config.plugins[PLUGIN_ID] = { enabled: false, ...(previous.dataRoot === undefined ? {} : { dataRoot: previous.dataRoot }) }
  }

  const path = writeProjectConfig(projectRoot, config)
  process.stdout.write(
    `${JSON.stringify({ plugin: PLUGIN_ID, projectRoot, configPath: path, enabled: command === 'enable' }, null, 2)}\n`,
  )
  process.stdout.write('开关在新建或恢复会话时生效；已经跑着的会话不会中途改变工具表。\n')
  return 0
}

process.exitCode = main()

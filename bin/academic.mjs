#!/usr/bin/env node
/**
 * academic.mjs — 脱离 DSH 的本地 CLI（调试与不依赖 GUI 的批量调用）。
 *
 *     node bin/academic.mjs list
 *     node bin/academic.mjs call --tool academic_search --json-file <绝对JSON参数文件>
 *                                  [--format full|data|text] [--data-root <绝对目录>]
 *
 * 走的是与宿主工具完全相同的引擎与服务（`lib/engine/academic/service.mjs`），所以
 * 结果形状、数据根布局、边界检查都一致。DSH 会话里的正常用法是直接调用
 * `academic_search` 等工具；这个 CLI 只是给测试和命令行场景用的后门，不扩大能力。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { AcademicService, InputError } from '../lib/engine/academic/service.mjs'

/** 默认数据根：与本包宿主侧一致。 */
const DEFAULT_DATA_ROOT = join(fileURLToPath(new URL('../', import.meta.url)), 'data', 'academic')

/**
 * 解析命令行。
 *
 * @param {string[]} argv 参数。
 * @returns {{ command: string, values: Record<string, string> }} 解析结果。
 * @throws {Error} 选项未知、缺值或命令有多余参数时。
 */
function parseArgv(argv) {
  const values = {}
  let command
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      if (command !== undefined) throw new Error('多余的参数')
      command = token
      continue
    }
    const key = token.slice(2)
    if (!['tool', 'json-file', 'format', 'data-root'].includes(key)) throw new Error(`未知选项或缺少值：--${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`未知选项或缺少值：--${key}`)
    values[key] = value
    index += 1
  }
  return { command: command ?? 'list', values }
}

try {
  const { command, values } = parseArgv(process.argv.slice(2))
  const service = new AcademicService({ dataRoot: values['data-root'] ?? DEFAULT_DATA_ROOT })
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(service.list(), null, 2)}\n`)
  } else if (command === 'call') {
    if (values.tool === undefined || values['json-file'] === undefined) {
      throw new InputError('call 需要 --tool 与 --json-file')
    }
    const format = values.format ?? 'full'
    if (!['full', 'data', 'text'].includes(format)) throw new InputError('format 必须是 full / data / text')
    const args = JSON.parse(readFileSync(values['json-file'], 'utf8').replace(/^\uFEFF/, ''))
    const result = await service.call(values.tool, args)
    const output =
      format === 'data' ? result.structuredContent : format === 'text' ? result.content : result
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    if (result.isError === true) process.exitCode = 1
  } else {
    throw new InputError('命令必须是 list 或 call')
  }
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`)
  process.exitCode = 1
}

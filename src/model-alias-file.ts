/**
 * **用户层模型别名**（2026-11-17 用户诉求「做一个额外的口子」）。
 *
 * ## 是什么
 *
 * 一个可选的 JSON 文件，让用户**不用改代码、不用升级插件**就能调整模型归并：
 *
 * ```
 * ~/.dsh/jet-hub/model-aliases.json
 * ```
 *
 * ```jsonc
 * {
 *   "models": [
 *     { "key": "glm-5-4", "name": "GLM-5.4", "pattern": "^glm-5-4(-free)?$" },
 *     { "key": "glm-5-3-flash", "name": "GLM-5.3-Flash", "pattern": "^glm-5-[34]-flash(-free)?$" },
 *     { "key": "mimo-v3", "name": "MiMo V3", "ids": ["mimo-mx7k"] }
 *   ]
 * }
 * ```
 *
 * - `pattern`：作用在**归一化键**上的正则（写法变体 / 跨版本合并）；
 * - `ids`：字面 id（机器代号、渠道前缀写法）—— 与型号名无字面关系时用它；
 * - 两者都可省略 ⇒ 该行**只登记展示名**，不参与合并。
 *
 * ## 语义（三条，缺一都会让用户困惑）
 *
 * 1. **用户层优先**：同一键用户也写了规则时，用户规则先命中（可覆盖内置匹配范围）；
 * 2. **坏行跳过、不崩**：JSON 语法错 / 正则非法 / 缺 `key` ⇒ 跳过该行并 warn，
 *    **绝不让整个插件起不来**（这个文件是用户手写的，必须能容错）；
 * 3. **文件不存在 = 没有用户层**（与升级前行为一致，零副作用）。
 *
 * ## ⚠️ 为什么不做热加载
 *
 * 读一次、缓存在内存里：模型归并在**目录推导**时发生（60 秒 TTL），
 * 每次 `listModels` 都读盘会让选择器变慢。用户改完文件**重启 DSH** 即可生效
 * （README 已写明这条）。
 *
 * @module src/model-alias-file.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelIdentityRule } from './canonical-models.js'

/** 文件名（与 `state.json` 同目录）。 */
export const MODEL_ALIASES_FILE = 'model-aliases.json'

/** 解析结果：规则 + 合并过程中发现的问题（供日志如实报告）。 */
export interface ParsedModelAliases {
  rules: ModelIdentityRule[]
  /** 被跳过的行/字段（人类可读），挂在 warn 上。 */
  problems: string[]
}

/**
 * 把一个 JSON 值解析成模型身份规则。
 *
 * ⚠️ **全部字段都要判类型**：这个文件是用户手写的，任何形状都可能出现。
 * ⚠️ 正则非法（`new RegExp` 抛错）只跳过**那一行**，不牵连其它行。
 */
export function parseModelAliases(raw: unknown): ParsedModelAliases {
  const problems: string[] = []
  const rules: ModelIdentityRule[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { rules, problems: ['根节点不是对象'] }
  }
  const models = (raw as { models?: unknown }).models
  if (!Array.isArray(models)) {
    return { rules, problems: ['缺少 models 数组'] }
  }

  for (const [index, item] of models.entries()) {
    const where = `models[${index}]`
    if (typeof item !== 'object' || item === null) {
      problems.push(`${where} 不是对象`)
      continue
    }
    const key = (item as { key?: unknown }).key
    const name = (item as { name?: unknown }).name
    if (typeof key !== 'string' || key.trim().length === 0) {
      problems.push(`${where} 缺少非空 key`)
      continue
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      problems.push(`${where} 缺少非空 name`)
      continue
    }

    let pattern: RegExp | undefined
    const rawPattern = (item as { pattern?: unknown }).pattern
    if (rawPattern !== undefined && rawPattern !== null) {
      if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
        problems.push(`${where}.pattern 不是非空字符串`)
        continue
      }
      try {
        pattern = new RegExp(rawPattern)
      } catch (error) {
        problems.push(`${where}.pattern 不是合法正则：${String(error)}`)
        continue
      }
    }

    let ids: string[] | undefined
    const rawIds = (item as { ids?: unknown }).ids
    if (rawIds !== undefined && rawIds !== null) {
      if (!Array.isArray(rawIds)) {
        problems.push(`${where}.ids 不是数组`)
        continue
      }
      const cleaned = rawIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      )
      if (cleaned.length === 0) {
        problems.push(`${where}.ids 没有非空字符串`)
        continue
      }
      ids = cleaned
    }

    // match 里两个字段都没有 ⇒ 只登记展示名（合法用法，不是错误）。
    if (pattern === undefined && ids === undefined) {
      rules.push({ key, name })
      continue
    }
    rules.push({ key, name, match: { ...(pattern === undefined ? {} : { pattern }), ...(ids === undefined ? {} : { ids }) } })
  }

  return { rules, problems }
}

/**
 * 读用户层文件并解析。文件不存在 ⇒ 空规则（与升级前一致）。
 *
 * ⚠️ **读失败也返回空规则**（附 problem）：一个可选文件不该阻断插件启动。
 */
export function loadModelAliases(home: string): ParsedModelAliases {
  const path = join(home, 'jet-hub', MODEL_ALIASES_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 不存在 / 不可读 ⇒ 没有用户层（正常路径）。
    return { rules: [], problems: [] }
  }
  try {
    return parseModelAliases(JSON.parse(text))
  } catch (error) {
    return { rules: [], problems: [`JSON 解析失败：${String(error)}`] }
  }
}
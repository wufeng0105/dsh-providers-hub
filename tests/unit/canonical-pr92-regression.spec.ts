import { describe, expect, it } from 'vitest'
import { canonicalKeyFor } from '../../src/canonical-models.js'

/**
 * 回归核实：上游 PR #92（2026-11-15 已合并）加的三条 DeepSeek 日期快照归并：
 *
 *   codearts:  { 'deepseek-v4.1-flash-1017': 'deepseek-v4-1-flash' }
 *   modelscope:{ 'deepseek-ai/DeepSeek-V4.1-Flash-1017': 'deepseek-v4-1-flash',
 *                'deepseek-ai/DeepSeek-V4-Pro-0813': 'deepseek-v4-pro' }
 *
 * 单表重构后必须仍然归到「同一虚拟模型」，否则就是回归：
 * 主行挂着必然 400 的死链、而真正能用的后缀那条单独成列。
 *
 * ⚠️⚠️ **与上游 PR #92 的唯一差异（有意，不是回归）**：上游把 `-1017` 归到
 * `deepseek-v4-1-flash`（V4.1 独立键）；本仓按用户 2026-11-16 的明确要求
 * **跨代际合并**成一个 `deepseek-flash`。归并**目标键**不同，但「后缀那条必须与
 * 无后缀那条落在同一键」这件事**相同** —— 本文件守的是后者。
 */
describe('★ 上游 PR #92 的三条 DeepSeek 快照归并没有被单表重构吃掉', () => {
  const cases = [
    // [provider, realId, displayName, 期望归到的 key]
    ['codearts', 'deepseek-v4.1-flash-1017', 'DeepSeek-V4.1-Flash-1017', 'deepseek-flash'],
    ['modelscope', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'DeepSeek-V4.1-Flash-1017', 'deepseek-flash'],
    ['modelscope', 'deepseek-ai/DeepSeek-V4-Pro-0813', 'DeepSeek-V4-Pro-0813', 'deepseek-v4-pro'],
  ]

  it.each(cases)('%s 的 %s 归到 %s', (provider, realId, displayName, expected) => {
    const result = canonicalKeyFor(provider, realId, displayName)
    expect(result, `${provider}/${realId} 必须能归一，否则它在聚合里单独成列`).toBeDefined()
    expect(result.key).toBe(expected)
  })

  it('★ 无后缀的那条归到**同一个**键（不是拆成两条）', () => {
    const withSuffix = canonicalKeyFor('modelscope', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'DeepSeek-V4.1-Flash-1017')
    const plain = canonicalKeyFor('modelscope', 'deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash')
    expect(plain?.key).toBe('deepseek-flash')
    expect(withSuffix?.key).toBe(plain?.key)
  })
})

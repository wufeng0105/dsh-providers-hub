import { describe, expect, it } from 'vitest'
import { parseModelAliases } from '../../src/model-alias-file.js'

/**
 * 用户层别名文件的解析与**容错**（2026-11-17「口子」）。
 *
 * 这是用户手写的文件 ⇒ 容错是硬要求：任何坏行都只跳过**那一行**，
 * 绝不抛错、绝不牵连其它行（否则一个手滑会让整个聚合起不来）。
 */
describe('parseModelAliases：合法形状', () => {
  it('pattern / ids / 仅展示名 三种行都能解析', () => {
    const { rules, problems } = parseModelAliases({
      models: [
        { key: 'glm-5-4', name: 'GLM-5.4', pattern: '^glm-5-4(-free)?$' },
        { key: 'mimo-v3', name: 'MiMo V3', ids: ['mimo-mx7k'] },
        { key: 'only-name', name: 'Only Name' },
      ],
    })
    expect(problems).toEqual([])
    expect(rules).toHaveLength(3)
    expect(rules[0]!.match?.pattern?.test('glm-5-4')).toBe(true)
    expect(rules[1]!.match?.ids).toEqual(['mimo-mx7k'])
    expect(rules[2]!.match).toBeUndefined()
  })

  it('ids 里的空串与非字符串被剔除，全空则该行跳过', () => {
    const { rules, problems } = parseModelAliases({
      models: [
        { key: 'a', name: 'A', ids: ['x', '', '  ', 42] },
        { key: 'b', name: 'B', ids: ['', '  '] },
      ],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0]!.match?.ids).toEqual(['x'])
    expect(problems.some((p) => p.includes('models[1]'))).toBe(true)
  })
})

describe('parseModelAliases：容错（坏行只跳过自己）', () => {
  it('非法正则 ⇒ 跳过该行，其余照常', () => {
    const { rules, problems } = parseModelAliases({
      models: [
        { key: 'good', name: 'Good', pattern: '^good$' },
        { key: 'bad', name: 'Bad', pattern: '(' },   // 非法正则
      ],
    })
    expect(rules.map((r) => r.key)).toEqual(['good'])
    expect(problems.some((p) => p.includes('models[1].pattern'))).toBe(true)
  })

  it('缺 key / 缺 name / 非对象 ⇒ 各自跳过', () => {
    const { rules, problems } = parseModelAliases({
      models: [
        { name: 'No Key' },
        { key: 'no-name' },
        'string-item',
        null,
        { key: '  ', name: 'Blank Key' },
        { key: 'ok', name: 'OK' },
      ],
    })
    expect(rules.map((r) => r.key)).toEqual(['ok'])
    expect(problems.length).toBeGreaterThanOrEqual(5)
  })

  it('根节点畸形 ⇒ 空规则 + 问题描述（不抛错）', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}]) {
      const { rules, problems } = parseModelAliases(bad)
      expect(rules).toEqual([])
      expect(problems.length).toBeGreaterThan(0)
    }
  })

  it('pattern 非字符串 ⇒ 跳过该行', () => {
    const { rules, problems } = parseModelAliases({
      models: [{ key: 'x', name: 'X', pattern: 42 }],
    })
    expect(rules).toEqual([])
    expect(problems.some((p) => p.includes('pattern'))).toBe(true)
  })

  it('ids 不是数组 ⇒ 跳过该行', () => {
    const { rules, problems } = parseModelAliases({
      models: [{ key: 'x', name: 'X', ids: 'not-array' }],
    })
    expect(rules).toEqual([])
    expect(problems.some((p) => p.includes('ids'))).toBe(true)
  })
})
import { describe, expect, it } from 'vitest'
import {
  canonicalDisplayName,
  canonicalKeyFor,
  isUnifiedKey,
  setUserModelIdentities,
} from '../../src/canonical-models.js'

/**
 * 单表重构（2026-11-17）：**模型身份知识只有一张表**。
 *
 * 结构不变式：新增一个模型 = 加一行；用户层可覆盖内置层。
 * 这里钉住的是「机制」，不是具体条目（具体条目在 `canonical-models.spec.ts` 的
 * 既有用例里逐条锁着）。
 */

describe('用户层（口子）：可追加、可覆盖、可清空', () => {
  it('★ 用户层能**追加**一个全新模型（内置表里没有的）', () => {
    // 模拟用户把 `mimo-v3` 登记进 model-aliases.json
    setUserModelIdentities([
      { key: 'mimo-v3', name: 'MiMo V3', match: { pattern: /^mimo-?v3(-free)?$/ } },
    ])
    try {
      expect(canonicalKeyFor('buddy', 'mimo-v3', 'MiMo V3')?.key).toBe('mimo-v3')
      expect(canonicalKeyFor('buddy', 'MiMo-V3 ', 'MiMo V3')?.key).toBe('mimo-v3')
      expect(canonicalDisplayName('mimo-v3')).toBe('MiMo V3')
      expect(isUnifiedKey('mimo-v3')).toBe(true)
    } finally {
      setUserModelIdentities([])
    }
  })

  it('★ 用户层能**覆盖**内置条的匹配范围（放宽 pattern）', () => {
    // 内置：glm-5-3-flash 只收 `^glm-5-3-flash(-free)?$`
    expect(canonicalKeyFor('buddy', 'glm-5-4-flash', 'GLM-5.4-Flash')?.key)
      .toBe('glm-5-4-flash')
    // 用户层放宽成跨版本合并 ⇒ 5.4 也并进 5.3-Flash
    setUserModelIdentities([
      { key: 'glm-5-3-flash', name: 'GLM-5.3-Flash', match: { pattern: /^glm-5-[34]-flash(-free)?$/ } },
    ])
    try {
      expect(canonicalKeyFor('buddy', 'glm-5-4-flash', 'GLM-5.4-Flash')?.key)
        .toBe('glm-5-3-flash')
    } finally {
      setUserModelIdentities([])
    }
    // 清空后回到内置行为
    expect(canonicalKeyFor('buddy', 'glm-5-4-flash', 'GLM-5.4-Flash')?.key)
      .toBe('glm-5-4-flash')
  })

  it('★ 用户层能只登记**展示名**（不合并任何东西）', () => {
    setUserModelIdentities([{ key: 'brand-new-model', name: 'Brand New Model' }])
    try {
      expect(canonicalDisplayName('brand-new-model')).toBe('Brand New Model')
      // 没有 match ⇒ 不算合并型条目（不该享受「统一条目」的档位/门控行为）
      expect(isUnifiedKey('brand-new-model')).toBe(false)
    } finally {
      setUserModelIdentities([])
    }
  })
})

describe('单表机制：新增一行即可聚合', () => {
  it('★ 一行规则即可把多条写法并成一个键（含字面 id）', () => {
    setUserModelIdentities([
      {
        key: 'acme-flash',
        name: 'ACME Flash',
        match: { pattern: /^acme-(pro-)?flash(-free)?$/, ids: ['acme-mx7k'] },
      },
    ])
    try {
      // pattern 命中
      expect(canonicalKeyFor('buddy', 'acme-flash', 'ACME Flash')?.key).toBe('acme-flash')
      expect(canonicalKeyFor('buddy', 'acme-pro-flash', 'ACME Flash')?.key).toBe('acme-flash')
      // 字面 id 命中（机器代号，正则匹配不到）⇒ via=patch
      const byId = canonicalKeyFor('buddy', 'acme-mx7k', 'whatever')
      expect(byId?.key).toBe('acme-flash')
      expect(byId?.via).toBe('patch')
    } finally {
      setUserModelIdentities([])
    }
  })

  it('★ 未命中任何规则 ⇒ 原样返回（宁可漏合并，不可错合并）', () => {
    expect(canonicalKeyFor('buddy', 'totally-unknown-xyz', 'Totally Unknown')?.key)
      .toBe('totally-unknown-xyz')
    expect(canonicalDisplayName('totally-unknown-xyz')).toBe('totally-unknown-xyz')
  })

  it('★ 用户层不破坏排除集（auto 仍被拒绝）', () => {
    setUserModelIdentities([{ key: 'auto', name: 'X', match: { pattern: /^auto$/ } }])
    try {
      expect(canonicalKeyFor('buddy', 'auto', 'Auto')).toBeUndefined()
    } finally {
      setUserModelIdentities([])
    }
  })
})
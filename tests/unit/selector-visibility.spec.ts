import { describe, expect, it } from 'vitest'
import {
  hiddenProvidersSnapshot,
  isProviderHidden,
  rawListModelsFor,
  rememberRawListModels,
  setHiddenProviders,
  syncHiddenProviders,
  withSelectorVisibility,
} from '../../src/selector-visibility.js'
import { sanitizeHiddenProviders } from '../../src/jet-hub-store.js'

/**
 * 「从选择器隐藏已聚合的分组」（2026-11-16 用户诉求）。
 *
 * ## 核心不变式
 * 隐藏一个渠道 ⇒ 它对**宿主**的 `listModels` 返回 `[]`（分组消失），
 * 但聚合通过 `rawListModelsFor` 仍能读到它的目录（候选不丢）。
 * 若哪天有人把「隐藏」实现成「关闭」（灌黑名单），这条会红。
 */

function makeAdapter(models: Record<string, Array<{ id: string; name?: string }>>) {
  return {
    listModels: async (provider: string) => models[provider] ?? [],
    resolveModel: async (provider: string, id: string) => ({ provider, id }),
  }
}

describe('sanitizeHiddenProviders：只认非空字符串', () => {
  it('去空、去重、保序', () => {
    expect(sanitizeHiddenProviders([' a ', 'b', 'a', '', '   ', 42, null]))
      .toEqual(['a', 'b'])
  })

  it('畸形输入退化为空数组（= 全部显示）', () => {
    for (const bad of [null, undefined, 'x', {}, 42, true]) {
      expect(sanitizeHiddenProviders(bad)).toEqual([])
    }
  })
})

describe('选择器可见性：隐藏 = 分组消失，但聚合仍读得到', () => {
  it('★ 隐藏后宿主侧 listModels 返回空；聚合侧原方法仍返回目录', async () => {
    setHiddenProviders([])
    const adapter = makeAdapter({ buddy: [{ id: 'deepseek-v4.1-flash' }] })
    rememberRawListModels(['buddy'], adapter)
    const wrapped = withSelectorVisibility(['buddy'], adapter) as {
      listModels: (p: string) => Promise<readonly { id: string }[]>
    }
    // 未隐藏：照常返回
    expect((await wrapped.listModels('buddy')).length).toBe(1)
    // 隐藏后：宿主侧空
    setHiddenProviders(['buddy'])
    const wrappedHidden = withSelectorVisibility(['buddy'], adapter) as typeof wrapped
    expect(await wrappedHidden.listModels('buddy')).toEqual([])
    // ★ 关键：聚合读原始方法，仍拿得到（「隐藏」不是「关闭」）
    expect((await rawListModelsFor('buddy')!('buddy')).length).toBe(1)
    setHiddenProviders([])
  })

  it('★ 聚合自身永不被隐藏（即便被写进隐藏集合）', async () => {
    setHiddenProviders(['aggregate'])
    expect(isProviderHidden('aggregate')).toBe(true)
    const adapter = makeAdapter({ aggregate: [{ id: 'auto' }] })
    const wrapped = withSelectorVisibility(['aggregate'], adapter) as {
      listModels: (p: string) => Promise<readonly { id: string }[]>
    }
    // 聚合分组必须仍可见（否则用户连聚合都选不到）
    expect((await wrapped.listModels('aggregate')).length).toBe(1)
    setHiddenProviders([])
  })

  it('隐藏只拦 listModels：resolveModel 等成员原样透传', async () => {
    setHiddenProviders(['buddy'])
    const adapter = makeAdapter({ buddy: [{ id: 'm' }] })
    const wrapped = withSelectorVisibility(['buddy'], adapter) as {
      resolveModel: (p: string, id: string) => Promise<{ provider: string; id: string }>
    }
    expect(await wrapped.resolveModel('buddy', 'm')).toEqual({ provider: 'buddy', id: 'm' })
    setHiddenProviders([])
  })

  it('快照可下发（供面板渲染），且是副本（外部改不动内部）', () => {
    setHiddenProviders(['a', 'b'])
    const snapshot = hiddenProvidersSnapshot()
    snapshot.push('c')
    expect(hiddenProvidersSnapshot()).toEqual(['a', 'b'])
    setHiddenProviders([])
  })
})

describe('★ 真实缺陷守卫（2026-11-16 用户报障「都勾上了但没成功」）', () => {
  /**
   * 两个独立的失效点，各自都能让「勾了没用」且零报错：
   * ① 包装时按「当前隐藏集」做静态短路 ⇒ 注册后又勾选永远不生效；
   * ② 装配期没把已落盘的集合灌进单例 ⇒ 重启后已勾选的也不生效。
   * 下面的用例分别钉住它们。
   */
  it('★① 包好之后再勾选，必须**立刻**生效（不得有注册期短路）', async () => {
    setHiddenProviders([])
    const adapter = makeAdapter({ buddy: [{ id: 'm' }] })
    // 关键：**先包装**（此刻没有任何渠道被隐藏）…
    const wrapped = withSelectorVisibility(['buddy'], adapter) as {
      listModels: (p: string) => Promise<readonly { id: string }[]>
    }
    expect((await wrapped.listModels('buddy')).length).toBe(1)
    // …**再**勾选（模拟用户在面板里操作）
    setHiddenProviders(['buddy'])
    expect(await wrapped.listModels('buddy'), '包装必须每次现查隐藏集').toEqual([])
    setHiddenProviders([])
  })

  it('★② 已落盘的集合必须能灌进单例（装配期同步），且灌完立即生效', async () => {
    setHiddenProviders([])
    const adapter = makeAdapter({ qoder: [{ id: 'dfmodel' }] })
    const wrapped = withSelectorVisibility(['qoder'], adapter) as {
      listModels: (p: string) => Promise<readonly { id: string }[]>
    }
    expect((await wrapped.listModels('qoder')).length).toBe(1)
    // 模拟 `index.ts` 装配期那一次同步（读盘得到的集合）
    syncHiddenProviders(['qoder', 'buddy'])
    expect(isProviderHidden('qoder')).toBe(true)
    expect(await wrapped.listModels('qoder')).toEqual([])
    setHiddenProviders([])
  })

  it('★ 聚合读目录不受隐藏影响（装配期同步后仍能拿到候选）', async () => {
    setHiddenProviders(['buddy'])
    const adapter = makeAdapter({ buddy: [{ id: 'm' }] })
    rememberRawListModels(['buddy'], adapter)
    const wrapped = withSelectorVisibility(['buddy'], adapter) as {
      listModels: (p: string) => Promise<readonly { id: string }[]>
    }
    expect(await wrapped.listModels('buddy'), '宿主侧隐藏').toEqual([])
    expect((await rawListModelsFor('buddy')!('buddy')), '聚合侧仍可见').toHaveLength(1)
    setHiddenProviders([])
  })
})
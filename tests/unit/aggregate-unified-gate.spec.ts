import { describe, expect, it } from 'vitest'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'
import { WIRED_EXPIRY_PROVIDERS } from '../../src/aggregate-expiry.js'

/**
 * 型号统一条目的门控/选序/播报行为（2026-11-16，规格 §4）。
 *
 * 统一键（isUnifiedKey 为真）：
 * - 建池：default-rejected（未接入折算且未手工打开）的候选**放宽进池**，排最后（NEVER）；
 *   显式拒绝（rejected）仍剔除（开关必须有用）。
 * - 选序：候选数超过 maxAttemptsFor 时**不截断尾部**，且同渠道分散（pickDiversified）。
 * - 播报：isAllDefaultsUnopened 对统一键恒 false（全 default-rejected 也播报）。
 *
 * 非统一键与 auto：既有口径不变（另有守卫）。
 */

const USER_MSG = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never

function makePool() {
  return {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never
}

/** 前置事实：raccoon 未接入临期折算（default-rejected 的来源）。 */
describe('前置事实', () => {
  it('raccoon 未接入折算、buddy 已接入', () => {
    expect(WIRED_EXPIRY_PROVIDERS).not.toContain('raccoon')
    expect(WIRED_EXPIRY_PROVIDERS).toContain('buddy')
  })
})

/** 造 ctx：buddy（已接入）+ raccoon（未接入）同供一个模型；stream 记录发往渠道。 */
function makeCtx(modelId: string, sent: string[], opts?: { failAll?: boolean }) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
      listModels: async () => [{ id: modelId, name: modelId }],
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      stream: (o: { provider: string }) => {
        sent.push(o.provider)
        return (async function* () {
          if (opts?.failAll) throw new Error(`${o.provider} 挂了`)
          yield { type: 'text', text: 'ok' }
        })()
      },
    },
  } as never
}

describe('统一键建池：default-rejected 放宽、显式拒绝仍生效', () => {
  it('未接入且未打开的 raccoon 进统一键池（buddy 失败后换到它）', async () => {
    const sent: string[] = []
    // buddy 临期最早排第一但失败 ⇒ 若 raccoon 进池则换到它
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () {
            if (o.provider === 'buddy') throw new Error('buddy 挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (p: string) => (p === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    expect(sent).toEqual(['buddy', 'raccoon'])
  })

  it('显式拒绝的 raccoon 不进统一键池（开关必须有用）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () {
            if (o.provider === 'buddy') throw new Error('buddy 挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (p: string) => (p === 'buddy' ? 100 : 900),
      rejections: () => ({ 'glm-5-3': { raccoon: { 'glm-5.3': true } } }),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    // buddy 失败、raccoon 被显式拒绝 ⇒ 无候选可换 ⇒ 抛错
    await expect((async () => {
      for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent).toEqual(['buddy']) // raccoon 从未被尝试
  })

  it('非统一键口径不变：default-rejected 的 raccoon 仍被剔（kimi-k3）', async () => {
    const sent: string[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'raccoon' }],
        listModels: async () => [{ id: 'kimi-k3', name: 'Kimi-K3' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string }) => {
          sent.push(o.provider)
          return (async function* () {
            if (o.provider === 'buddy') throw new Error('buddy 挂了')
            yield { type: 'text', text: 'ok' }
          })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async (p: string) => (p === 'buddy' ? 100 : 900),
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'kimi-k3')
    await expect((async () => {
      for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    })()).rejects.toThrow()
    expect(sent).toEqual(['buddy']) // 非统一键：raccoon 默认不参与，不被尝试
  })
})

describe('统一键选序：同渠道分散（不一家吃满）+ 不截断', () => {
  it('统一键用 pickDiversified：同渠道多候选时别家挤进前三，且全部候选轮得到', async () => {
    // 靶点说明：maxAttemptsFor 取**所有**虚拟模型最长候选表，统一键自己就是最长 ⇒
    //   limit ≥ 统一键候选数 ⇒ slice 本就不截断它。故统一键选序的真正行为差异是
    //   **分散**（pickDiversified，与 auto 同款，防 qoder 排队故障那种「一家吃满」）：
    //   第一轮每家最多 2 个 ⇒ 同渠道 5 候选时，别家（codearts）必须挤进第 3 位。
    //   断言①分散（前三个含 codearts）②不截断（6 个候选全尝试）。
    //   把 pickDiversified 改回 slice ⇒ 前三个全是 buddy ⇒ ①红。
    const sent: string[] = []
    // buddy 供 5 个写法变体（都归一到 glm-5-3）+ codearts 1 个 ⇒ 6 候选，buddy 占 5。
    const ids = ['glm-5.3', 'glm-5.3-free', 'GLM-5.3', 'glm-5.3 ', 'Glm-5.3']
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'buddy' }, { id: 'codearts' }],
        listModels: async (p: string) => (p === 'buddy'
          ? ids.map((id) => ({ id, name: id }))
          : [{ id: 'glm-5.3', name: 'glm-5.3' }]),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: (o: { provider: string; model: string }) => {
          sent.push(`${o.provider}/${o.model}`)
          return (async function* () { throw new Error('挂了') })()
        },
      },
    } as never
    const adapter = new AggregateAdapter(ctx, {
      accountPool: makePool(),
      expiryProbe: async () => 100,
    })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    await expect((async () => {
      for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    })()).rejects.toThrow()
    // ② 不截断：6 个候选（buddy 5 + codearts 1）全部被尝试
    expect(sent.length).toBe(6)
    // ① 分散：配额=2（第一轮每家最多 2 个）⇒ buddy 占前两个后，codearts 必须挤进第 3 位
    //    （而非 slice 那样前 5 个全是 buddy）。把 pickDiversified 改回 slice ⇒ 前三个全 buddy ⇒ 红。
    expect(sent.slice(0, 3)).toContain('codearts/glm-5.3')
  })
})

describe('统一键播报：全 default-rejected 也播报', () => {
  it('只有未接入候选的统一键仍出现在 listModels（isAllDefaultsUnopened 恒 false）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'raccoon' }],
        listModels: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    await adapter.refreshCatalog()
    const listed = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(listed.map((m) => m.id)).toContain('glm-5-3')
  })

  it('非统一键只有未接入候选 ⇒ 不播报（既有口径回归）', async () => {
    const ctx = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      llm: {
        listProviders: () => [{ id: 'raccoon' }],
        listModels: async () => [{ id: 'kimi-k3', name: 'Kimi-K3' }],
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        stream: () => (async function* () { /* noop */ })(),
      },
    } as never
    const adapter = new AggregateAdapter(ctx, { accountPool: makePool(), expiryProbe: async () => 100 })
    await adapter.refreshCatalog()
    const listed = await adapter.listModels(AGGREGATE_PROVIDER)
    expect(listed.map((m) => m.id)).not.toContain('kimi-k3')
  })
})
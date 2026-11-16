import { describe, expect, it } from 'vitest'
import { AggregateAdapter, AGGREGATE_PROVIDER } from '../../src/aggregate-adapter.js'

/**
 * 型号统一条目的请求路径行为（2026-11-16，规格 §4）。
 *
 * 统一键（isUnifiedKey 为真，如 glm-5-3 / deepseek-v4-flash）：
 * - resolveModel **不声明 reasoning**（隐藏档位选择器）；
 * - streamThrough **恒顶格**：忽略请求携带的旧档位，注入候选已声明的最强非 off 档；
 *   候选无声明 ⇒ 不下发（走上游默认，不编造）。
 *
 * 非统一键（如 kimi-k3）与 auto：既有行为逐字节不变（另有守卫）。
 */

function makePool() {
  return {
    disabledModelsFor: () => new Set<string>(),
    getAvailableAccount: async () => ({ entry: { id: 'a1' }, credential: {} }),
  } as never
}

/** 造 ctx：单渠道单模型，档位由 efforts 给定，stream 记录收到的 reasoningEffort。 */
function makeCtx(opts: {
  modelId: string
  modelName: string
  efforts: Array<{ id: string }>
  seen: Array<{ provider: string; effort: string | undefined }>
}) {
  return {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    llm: {
      listProviders: () => [{ id: 'buddy', name: 'buddy' }],
      listModels: async () => [{ id: opts.modelId, name: opts.modelName }],
      resolveModelInfo: async () => ({ reasoning: { efforts: opts.efforts } }),
      stream: (options: { provider: string; reasoningEffort?: string }) => {
        opts.seen.push({ provider: options.provider, effort: options.reasoningEffort })
        return (async function* () { yield { type: 'text', text: 'ok' } })()
      },
    },
  } as never
}

const USER_MSG = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never

describe('统一键：resolveModel 不声明 reasoning（隐藏选择器）', () => {
  it('统一键 glm-5-3 ⇒ reasoning 缺席', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'glm-5.3', modelName: 'GLM-5.3', efforts: [{ id: 'low' }, { id: 'high' }], seen: [],
    }), { accountPool: makePool() })
    await adapter.refreshCatalog()
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'glm-5-3')
    expect(info.reasoning).toBeUndefined()
  })

  it('非统一键 kimi-k3 ⇒ reasoning 照旧声明（回归）', async () => {
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'kimi-k3', modelName: 'Kimi-K3', efforts: [{ id: 'low' }, { id: 'high' }], seen: [],
    }), { accountPool: makePool() })
    await adapter.refreshCatalog()
    const info = await adapter.resolveModel(AGGREGATE_PROVIDER, 'kimi-k3')
    expect(info.reasoning).toBeDefined()
    expect(info.reasoning!.efforts.length).toBeGreaterThan(0)
  })
})

describe('统一键：streamThrough 恒顶格', () => {
  it('忽略请求携带的旧档位 low，注入候选最强档 max', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'glm-5.3', modelName: 'GLM-5.3',
      efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of call.stream({ ...USER_MSG, reasoningEffort: 'low' } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'max' }])
  })

  it('两档 off/on ⇒ 注入 on', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'deepseek-v4-flash', modelName: 'DeepSeek Flash',
      efforts: [{ id: 'off' }, { id: 'on' }], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'deepseek-flash')
    for await (const _ of call.stream({ ...USER_MSG, reasoningEffort: 'off' } as never)) { /* drain */ }    expect(seen).toEqual([{ provider: 'buddy', effort: 'on' }])
  })

  it('候选无档位声明 ⇒ 不下发 reasoningEffort（不编造）', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'glm-5-3', modelName: 'GLM-5.3', efforts: [], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of call.stream({ ...USER_MSG, reasoningEffort: 'high' } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: undefined }])
  })

  it('请求未带档位（undefined）也注入最强档', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'glm-5-3', modelName: 'GLM-5.3',
      efforts: [{ id: 'low' }, { id: 'high' }], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'glm-5-3')
    for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'high' }])
  })
})

describe('非统一键：streamThrough 既有翻译行为不变（回归）', () => {
  it('kimi-k3 + 请求 minimal ⇒ 就近落到候选声明的 low（不是顶格）', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'kimi-k3', modelName: 'Kimi-K3',
      efforts: [{ id: 'low' }, { id: 'high' }], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'kimi-k3')
    for await (const _ of call.stream({ ...USER_MSG, reasoningEffort: 'minimal' } as never)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: 'low' }])
  })

  it('kimi-k3 + 请求 undefined ⇒ 原样透传（不注入）', async () => {
    const seen: Array<{ provider: string; effort: string | undefined }> = []
    const adapter = new AggregateAdapter(makeCtx({
      modelId: 'kimi-k3', modelName: 'Kimi-K3',
      efforts: [{ id: 'low' }, { id: 'high' }], seen,
    }), { accountPool: makePool(), expiryProbe: async () => 100 })
    const call = await adapter.prepareCall(AGGREGATE_PROVIDER, 'kimi-k3')
    for await (const _ of call.stream(USER_MSG)) { /* drain */ }
    expect(seen).toEqual([{ provider: 'buddy', effort: undefined }])
  })
})
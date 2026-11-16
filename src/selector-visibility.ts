/**
 * 选择器可见性（2026-11-16 用户诉求）：
 * 把**已经聚合过**的渠道分组从模型选择器里隐藏，但**不关闭** ——
 * 它们仍参与聚合轮换、账号与积分照常。
 *
 * ## 为什么必须单独一张表（别拿「关闭供应商」凑合）
 *
 * DSH 选择器里每个 provider 分组的可见性 = 该 provider 的 `listModels()` 是否返回空。
 * 而聚合恰恰**也读同一个方法**（拿候选目录）⇒ 若用「关闭供应商」（把目录灌进黑名单）
 * 来隐藏，聚合会一并失去这些候选 —— 那就成了「关闭」而不是「隐藏」。
 *
 * ⇒ 本模块在**注册边界**套一层 `listModels`：隐藏的 provider 对宿主返回 `[]`；
 *   聚合通过 {@link rawListModelsFor} 读**未套这层**的原适配器
 *   （黑名单仍由原适配器内部过滤，成员口径不变）。
 *
 * ## 边界
 * - `aggregate` 自身**永不隐藏**（它是唯一要保留的分组）。
 * - 隐藏只影响 `listModels`；`resolveModel` / `prepareCall` / `stream` 全部照旧
 *   ⇒ 已在跑的老会话、以及聚合的转发都不受影响。
 * - 本模块是进程级单例（与 `account-pool` 的落盘状态同步，由接线层 set）。
 */

/** 目录条目的最小形状（与 `aggregate-catalog.ts` 的 `CatalogModel` 兼容）。 */
export interface VisibilityCatalogModel {
  id: string
  name?: string
}

type ListModelsFn = (provider: string) => Promise<readonly VisibilityCatalogModel[]>

/** 聚合自身的 provider id（永不隐藏；与 `aggregate-adapter.ts` 的常量逐字相同）。 */
const AGGREGATE_PROVIDER_ID = 'aggregate'

const hiddenProviders = new Set<string>()
const rawListModels = new Map<string, ListModelsFn>()

/** 整体替换隐藏集合（接线层在载入状态、以及每次写操作后调用）。 */
export function setHiddenProviders(providers: Iterable<string>): void {
  hiddenProviders.clear()
  for (const provider of providers) hiddenProviders.add(provider)
}

/** 当前隐藏集合的快照（供 RPC 下发）。 */
export function hiddenProvidersSnapshot(): string[] {
  return [...hiddenProviders]
}

/** 该 provider 是否被用户要求「在选择器里隐藏」。 */
export function isProviderHidden(provider: string): boolean {
  return hiddenProviders.has(provider)
}

/**
 * 记住某个 provider 的**原始** `listModels`（未套隐藏层），供聚合读取。
 * 由 `llm-register-compat.ts` 在注册时调用，每个 provider 记一次。
 */
export function rememberRawListModels(providers: readonly string[], adapter: object): void {
  const fn = (adapter as { listModels?: unknown }).listModels
  if (typeof fn !== 'function') return
  for (const provider of providers) {
    rawListModels.set(provider, (p: string) => (fn as ListModelsFn).call(adapter, p))
  }
}

/** 聚合读目录用的原始 `listModels`（未套隐藏层）；未登记返回 undefined。 */
export function rawListModelsFor(provider: string): ListModelsFn | undefined {
  return rawListModels.get(provider)
}

/**
 * 给已注册的适配器套一层「隐藏即空目录」。
 *
 * ⚠️ 只拦 `listModels` 一个成员：其余成员原样透传（`Reflect.get` 保留原型链上的方法）。
 * ⚠️ Proxy 失败不得阻断注册 —— 由调用方 try/catch 兜底（与既有几层包装同口径）。
 */
export function withSelectorVisibility(providers: readonly string[], adapter: object): object {
  // 该适配器服务的 provider 全在隐藏集里才需要真拦；否则原样返回，零开销。
  const anyVisible = providers.some(
    (provider) => provider === AGGREGATE_PROVIDER_ID || !hiddenProviders.has(provider),
  )
  if (anyVisible && providers.every((p) => !hiddenProviders.has(p))) return adapter
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop !== 'listModels') return Reflect.get(target, prop, receiver)
      return async (provider: string): Promise<readonly VisibilityCatalogModel[]> => {
        if (provider !== AGGREGATE_PROVIDER_ID && hiddenProviders.has(provider)) return []
        const fn = (target as { listModels?: unknown }).listModels
        return typeof fn === 'function' ? (fn as ListModelsFn).call(target, provider) : []
      }
    },
  })
}
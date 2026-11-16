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

/**
 * 该 provider 是否被用户要求「在选择器里隐藏」。
 *
 * ⚠️ 判据是**运行时集合**（面板随时可改），不是注册期快照 —— 理由见
 * {@link withSelectorVisibility} 的注释。
 */
export function isProviderHidden(provider: string): boolean {
  return hiddenProviders.has(provider)
}

/**
 * 主动把「已落盘的隐藏集合」灌进本模块（**注册路径必须在包装前调用一次**）。
 *
 * ## ⚠️ 为什么必须有它（真实缺陷，2026-11-16 用户报障「勾了没成功」）
 *
 * 隐藏集合住在 `AccountPool`，而它是**惰性载入**的（`ensureLoaded()` 在首次访问
 * 某个 getter 时才读盘）。插件的注册流程发生在装配阶段，那时通常**没有任何代码
 * 碰过池** ⇒ 本模块的集合还是空的 ⇒ 重启后第一次打开选择器时，
 * 「隐藏」对已落盘的勾选**完全不生效**（用户必须先点一次面板让池载入才好）。
 * ⇒ 让调用方在注册前显式 `syncHiddenProvidersFrom(pool.listHiddenProviders())`。
 *
 * ⚠️ 本函数本身不读盘（保持本模块零 IO）：取集合是调用方的责任。
 */
export function syncHiddenProviders(providers: Iterable<string>): void {
  setHiddenProviders(providers)
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
  // ⚠️⚠️ **不得在这里按「当前隐藏集」做静态短路**（真实缺陷，2026-11-16 用户报障
  //    「我所有的都已经勾选上了，但是没成功」）：
  //    初版写的是 `if (全部可见) return adapter` —— 而注册发生在**插件加载时**，
  //    那时用户在面板里的勾选要么还没发生、要么刚被 restart 读回得比注册晚
  //    ⇒ 一旦注册那一刻「没有全员隐藏」，包装就被永久跳过，
  //    之后无论用户怎么勾都**再也不会生效**（且零报错）。
  //    ⇒ 隐藏集是**运行时可变的**，判据必须每次 `listModels` 现查（下面的 Proxy）。
  //    代价是每层多一次 Proxy 转发（纳秒级、只影响一次目录读取），可忽略。
  void providers
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop !== 'listModels') return Reflect.get(target, prop, receiver)
      return async (provider: string): Promise<readonly VisibilityCatalogModel[]> => {
        // ⚠️ 聚合自身永不隐藏（它是用户唯一要保留的分组）。
        if (provider !== AGGREGATE_PROVIDER_ID && isProviderHidden(provider)) return []
        const fn = (target as { listModels?: unknown }).listModels
        return typeof fn === 'function' ? (fn as ListModelsFn).call(target, provider) : []
      }
    },
  })
}
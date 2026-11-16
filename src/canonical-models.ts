/**
 * 跨渠道模型**身份归一**：把同一个真实模型在各 provider 下的不同 modelId / 不同
 * 展示名，收敛成一个「规范键」，供聚合 provider 归组。
 *
 * ## 本模块只有**一张表**
 *
 * 2026-11-17 重构：原先这里并列着四张表（`CANONICAL_OVERRIDES` /
 * `CANONICAL_UNIFY_RULES` / `CANONICAL_UNIFY_EXACT` / `CANONICAL_NAMES`），
 * 它们其实回答的是**同一个问题**——「（渠道、id、名字）属于哪个模型、叫什么」。
 * 四张表带来的是**四处要同步维护**，且其中 7 条补丁在统一表出现后已完全冗余
 *（实测：删掉它们行为逐字节不变）。
 *
 * ⇒ 现在只有 {@link MODEL_IDENTITIES}：**每行 = 一个模型**，行内自带它的全部别名
 *（正则 + 字面 id）与展示名。**新增模型 = 加一行**，不改任何代码。
 *
 * ## 两层：内置表 + 用户层
 *
 * - {@link BUILTIN_MODEL_IDENTITIES}：随插件发布，**只读**；
 * - {@link setUserModelIdentities}：用户在 `~/.dsh/jet-hub/model-aliases.json` 里
 *   追加/覆盖的规则（由接线层读文件后注入）。**用户层优先**命中。
 *
 * ## 两条通道（id / name）仍然保留
 *
 * 各 provider 的 modelId **不都是自描述的**：qoder 的 `gfmodel`、accio 的
 * `1Drift-…`、marvis 的槽位名 `deepseek-v4-pro-external` 都是内部代号，
 * 真名只在展示名里 ⇒ 这些 provider 必须走 `name` 通道（见 {@link PRIMARY_CHANNEL}）。
 *
 * ⚠️ **展示名通道会错误合并 workbuddy 的 `-sg`**（两者展示名逐字相同、却是两条
 * 区域链路）⇒ 绝不做「两通道投票」，只按 provider 声明的主通道。
 *
 * ## 铁律：宁可漏合并，不可错合并
 *
 * 漏合并的代价是「同一模型出现两条」，用户一眼看得出、能手工关掉；
 * 错合并的代价是「请求打到了不是用户想要的那个模型」，且**没有任何提示**。
 * ⇒ 表内所有 pattern 一律**锚定**（`^…$`），不同档位绝不互并。
 *
 * @module src/canonical-models.ts
 */

/**
 * 抽象路由别名 —— **不是真实模型**，不参与归一化。
 *
 * 两个来源：
 * - workbuddy 的 `default-model` / `fast-model` / `balanced-model` /
 *   `primary-model` / `deep-model` 是**服务端抽象路由**；
 * - qoder 系的 `auto` 是**客户端选模模式**。
 *
 * ⚠️ 它们若参与归一化会变成若干「只有一个渠道」的虚拟模型，且语义上是空的。
 *
 * ⚠️⚠️ **不要**把 AutoClaw 的 `zai_auto` / `zai_auto-fast` 加进本集合：
 * 它们是上游**真实存在、可直接调用**的模型（有独立能力声明与实测依据）。
 * 加进来的后果**不是合并、而是消失**（`canonicalKeyFor` 返回 undefined ⇒
 * `buildVirtualModels` 直接 continue ⇒ 聚合里再也选不到）。
 * 那是**显示名**问题，正解是给它们登记人类可读名，不是删模型。
 */
export const EXCLUDED_ALIASES: ReadonlySet<string> = new Set([
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
  'auto',
])

/**
 * provider → 归一化**主通道**。
 *
 * 未列出的 provider 一律 `id`。⚠️ 不要「为了省事」把 qoder 也改成 `id`：
 * 它的 modelId 是 `gfmodel` 这类内部代号，走 id 通道会让每个模型各自成一个
 * 虚拟模型，跨渠道聚合**完全不发生**。
 */
const PRIMARY_CHANNEL: Readonly<Record<string, 'id' | 'name'>> = Object.freeze({
  qoder: 'name',
  qodercn: 'name',
  // accio（阿里 Accio Work）：`modelCode` 是 `1Drift-…` 内部代号，真名只在
  // `modelDisplayName` 里。走 id 通道 ⇒ 每个模型各自孤立、聚合里永远看不到它。
  accio: 'name',
  // 腾讯 Marvis：id 是**槽位名**（`deepseek-v4-pro-external`，此前是 `main-auto`），
  // 一个服务端路由保证，会随上游路由策略变化 ⇒ id 不携带模型身份，必须走 name。
  marvis: 'name',
})

/** 该 provider 的归一化主通道；未声明者默认 `id`。 */
export function channelOf(provider: string): 'id' | 'name' {
  return PRIMARY_CHANNEL[provider] ?? 'id'
}

/**
 * 把一个模型 id 归一成候选键。
 *
 * 步骤（顺序有意为之）：
 * 1. **剥命名空间前缀**（取最后一个 `/` 之后）：`cline-free/x` → `x`；
 * 2. 去 `:free` 后缀；
 * 3. 剥 `sn-` 前缀（raccoon）；
 * 4. **所有点号转连字符**（`v4.1` → `v4-1`，但**不删点** ⇒ `v4.1` ≠ `v4`）；
 * 5. 空格转连字符（展示名通道会用到）；
 * 6. 全小写。
 *
 * ⚠️ 第 4 步是「**所有**点号」而不是只处理版本号（初版只匹配 `v4.1` 形态，
 * 漏掉了 `6.8` / `k2.8` / `m2.7` 这些不带 `v` 的写法）。
 * ⚠️ **不剥** 4 位日期后缀（`-0731`）与 `-official`：它们是**独立信息**
 *（不同 build / 不同计费桶），归并与否由**表里的 pattern 逐族决定**。
 */
export function normalizeModelKey(raw: string): string {
  let s = raw.trim().toLowerCase()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:free$/, '')
  s = s.replace(/^sn-/, '')
  s = s.replace(/\./g, '-')
  s = s.replace(/\s+/g, '-')
  return s
}

/**
 * 把一条**展示名**归一成候选键：先剥掉非模型信息，再走 {@link normalizeModelKey}。
 *
 * 要剥掉的东西（各家的展示名里都混着它们）：
 * - 倍率后缀 ` · x0.75` / ` · x0.2→x0.1`（raccoon / loomy 直接写在表里）；
 * - 「免费」标注（raccoon 的 `· 免费`、cline 的 ` · 免费`）。
 *
 * ⚠️ 只剥**第一个 `·` 之后**的全部内容：`·` 是倍率分隔符，在本仓库所有 provider
 * 的展示名里都不作为模型名的一部分出现。
 */
export function normalizeNameKey(name: string): string {
  const stripped = name
    .replace(/\s*·.*$/, '')
    .replace(/免费/g, '')
    .trim()
  return normalizeModelKey(stripped)
}

/**
 * 一条模型身份规则。**这就是全部「模型知识」的形状**。
 */
export interface ModelIdentityRule {
  /** 规范键（= 对外 modelId）。 */
  key: string
  /** 官方展示名。 */
  name: string
  /**
   * 匹配规则（**任一**命中即归入本键）。省略 ⇒ 本行**只登记展示名**、
   * 不参与合并（例如 `kimi-k3` 这类键本来就唯一的模型）。
   */
  match?: {
    /**
     * 作用在**归一化后**的键上的正则（`normalizeModelKey` 的产物）。
     * 用于写法变体与「同档跨代际合并」。
     * ⚠️ 必须锚定（`^…$`），否则 `glm-5-3` 会吸走 `glm-5-3-flash`。
     */
    pattern?: RegExp
    /**
     * 字面 id（比较时两边都过 `normalizeModelKey`）。
     * 用于**机器代号**（`xopglm52`）与**渠道前缀写法**（`zai_glm-5.3-flash`）：
     * 它们与型号名没有字面关系，正则匹配不到。
     */
    ids?: readonly string[]
  }
}

/**
 * **内置模型身份表**（随插件发布，只读）。
 *
 * ## 怎么加一行
 *
 * ```ts
 * { key: 'glm-5-4', name: 'GLM-5.4', match: { pattern: /^glm-5-4(-free)?$/ } }
 * ```
 *
 * - 想让它**跨代际合并**进已有条目 ⇒ 把已有条目的 pattern 放宽
 *   （例如 `^glm-5-[34]-flash(-free)?$`）；
 * - 字面认不出的机器代号 ⇒ 写进 `ids`；
 * - 只想要好看的展示名、不合并 ⇒ 只写 `key` + `name`（不写 `match`）。
 *
 * ## 现有条目的两类性质（务必区分，别把「策略」当 bug 修）
 *
 * | 性质 | 依据 | 例子 |
 * |---|---|---|
 * | **同一身份** | 上游事实：同一模型的两种写法 | `glm-5.3-flash` ↔ `GLM-5.3-Flash` |
 * | **用户策略** | 用户偏好：认为可互换、不想挑 | **`deepseek-flash`（V4 与 V4.1 合并）** |
 *
 * ⚠️⚠️ **`deepseek-flash` 的跨代际合并是用户 2026-11-16 的明确要求**，不是缺陷：
 * 原话「我放出来的 DeepSeek 都是我精选过的，都可以统一成一个，不管它之前叫啥」。
 * 代价（已接受）：轮换按「积分最快作废」挑候选、不按代际，可能落到旧一代。
 * **不要**把它拆回 `deepseek-v4-flash` / `deepseek-v4-1-flash` 两条 ——
 * 那会让用户的选择器从 1 条变回 7 条，且没有任何报错。
 */
const BUILTIN_MODEL_IDENTITIES: readonly ModelIdentityRule[] = Object.freeze([
  // ── DeepSeek ──
  // Flash 一族：跨代际合并（用户策略，见上方长注释）。含日期快照 / -official / -free。
  {
    key: 'deepseek-flash',
    name: 'DeepSeek Flash',
    match: {
      pattern: /^deepseek-(v4-1-|v4-)?flash(-[0-9]{4}|-official)?(-free)?$/,
      // 讯飞 AStudio 的机器代号（真网实测 display_name = DeepSeek-V4.1-Flash）。
      ids: ['xopdsv4flash0731in', 'xdeepseek-flash-in'],
    },
  },
  // Pro 自成一条（与 Flash 绝不互并）。
  {
    key: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    match: {
      pattern: /^deepseek-(v4-1-|v4-)?pro(-[0-9]{4}|-official)?(-free)?$/,
      ids: ['xopdeepseekv4pro0813'],
    },
  },

  // ── GLM ──
  // 每个版本各一条（用户明确要 5.3 与 5.3-Flash **都显示**，不合并）。
  {
    key: 'glm-5-3-flash',
    name: 'GLM-5.3-Flash',
    match: {
      pattern: /^glm-5-3-flash(-free)?$/,
      // AutoClaw 的 id 带渠道前缀（`zai_` / `zaicoding_`），正则匹配不到。
      ids: ['zai_glm-5.3-flash'],
    },
  },
  {
    key: 'glm-5-3',
    name: 'GLM-5.3',
    match: { pattern: /^glm-5-3(-free)?$/, ids: ['zaicoding_glm-5.3'] },
  },
  { key: 'glm-5-2', name: 'GLM-5.2', match: { pattern: /^glm-5-2(-free)?$/, ids: ['xopglm52'] } },
  { key: 'glm-5-1', name: 'GLM-5.1', match: { pattern: /^glm-5-1(-free)?$/ } },
  { key: 'glm-5', name: 'GLM-5', match: { pattern: /^glm-5(-free)?$/ } },
  { key: 'glm-5v-turbo', name: 'GLM-5V-Turbo' },

  // ── MiniMax ──
  { key: 'minimax-m3-1-flash', name: 'MiniMax-M3.1-Flash', match: { pattern: /^minimax-m3-1-flash(-free)?$/ } },
  { key: 'minimax-m3', name: 'MiniMax-M3', match: { pattern: /^minimax-m3(-free)?$/ } },
  { key: 'minimax-m2-7', name: 'MiniMax-M2.7', match: { pattern: /^minimax-m2-7(-free)?$/ } },
  { key: 'minimax-m2-7-highspeed', name: 'MiniMax-M2.7-highspeed' },

  // ── Qwen ──
  // ⚠️ `qwen-?` 两种连接写法都收：不同渠道一个写 `qwen3.8-flash`、另一个写
  //    `qwen-3.8-flash`，归一后只差一个连字符（同一模型的两种写法）。
  // ⚠️ `qwen-?4-max` 后面要收 `-preview`：2026-11-17 用户报障选择器里
  //    `Qwen4-Max` 与 `qwen4-max-preview` **并列两条**（同一个模型的预览版被拆出去）。
  //    预览版是同一模型的不同阶段，归到同一键；显示名按用户要求取 `Qwen4`。
  { key: 'qwen4-max', name: 'Qwen4', match: { pattern: /^qwen-?4-max(-preview)?(-free)?$/ } },
  { key: 'qwen3-8-flash', name: 'Qwen3.8-Flash', match: { pattern: /^qwen-?3-8-flash(-free)?$/ } },
  { key: 'qwen3-8-max', name: 'Qwen3.8-Max', match: { pattern: /^qwen-?3-8-max(-free)?$/ } },
  { key: 'qwen3-7-max', name: 'Qwen3.7-Max', match: { pattern: /^qwen-?3-7-max(-free)?$/ } },
  { key: 'qwen3-7-plus', name: 'Qwen3.7-Plus', match: { pattern: /^qwen-?3-7-plus(-free)?$/ } },
  { key: 'qwen3-7-flash', name: 'Qwen3.7-Flash', match: { pattern: /^qwen-?3-7-flash(-free)?$/ } },
  { key: 'qwen3-6-plus', name: 'Qwen3.6-Plus', match: { pattern: /^qwen-?3-6-plus(-free)?$/ } },
  { key: 'qwen3-5-plus-2026-04-20', name: 'Qwen3.5-Plus-2026-04-20' },

  // ── Kimi ──
  { key: 'kimi-k3', name: 'Kimi-K3' },
  { key: 'kimi-k3-1', name: 'Kimi-K3-1' },
  { key: 'kimi-k2-8-preview', name: 'Kimi-K2.8-Preview' },
  { key: 'kimi-k2-7', name: 'Kimi-K2.7' },
  { key: 'kimi-k2-7-code', name: 'Kimi-K2.7-Code' },
  { key: 'kimi-k2-7-code-highspeed', name: 'Kimi-K2.7-Code-Highspeed' },
  { key: 'kimi-k2-6', name: 'Kimi-K2.6' },
  { key: 'kimi-k2-5', name: 'Kimi-K2.5' },

  // ── Gemini ──
  { key: 'gemini-3-8-flash', name: 'Gemini 3.8 Flash' },
  { key: 'gemini-3-5-flash', name: 'Gemini 3.5 Flash' },

  // ── 其它 ──
  { key: 'hy4-preview', name: 'Hy4 Preview' },
  { key: 'hy3', name: 'Hy3' },
  { key: 'hy3-x', name: 'Hy3 X' },
  { key: 'sensenova-6-8-flash', name: 'SenseNova-6.8-Flash' },
  { key: 'sensenova-6-8-flash-lite', name: 'SenseNova-6.8-Flash-Lite' },
  { key: 'doubao-seed-2-1-pro-260628', name: 'Doubao Seed 2.1 Pro' },
  { key: 'doubao-seed-2-1-turbo-260628', name: 'Doubao Seed 2.1 Turbo' },
  { key: 'doubao-seed-2-0-code-preview-260215', name: 'Doubao Seed 2.0 Code Preview' },
  // AutoClaw 自带的两条 Auto（上游真实模型，不是我们的抽象入口）。
  { key: 'zai_auto', name: 'Auto (AutoClaw)' },
  { key: 'zai_auto-fast', name: 'Auto-Fast (AutoClaw)' },
])

/**
 * 用户层规则（来自 `~/.dsh/jet-hub/model-aliases.json`，由接线层注入）。
 *
 * ⚠️ **用户层优先命中**：它排在 {@link BUILTIN_MODEL_IDENTITIES} 之前参与匹配，
 * 因此既能**追加**新模型，也能**覆盖**内置条目的匹配范围（例如把 GLM 的 pattern
 * 放宽成跨版本合并）。
 * ⚠️ 本模块**不做 IO**（保持纯函数、可单测）；读文件与校验是调用方的事。
 */
let userIdentities: readonly ModelIdentityRule[] = Object.freeze([])

/** 注入用户层规则（覆盖式：传空数组即清除）。 */
export function setUserModelIdentities(rules: readonly ModelIdentityRule[]): void {
  userIdentities = Object.freeze([...rules])
}

/** 当前生效的全部规则（用户层在前）。 */
function allIdentities(): readonly ModelIdentityRule[] {
  return userIdentities.length === 0
    ? BUILTIN_MODEL_IDENTITIES
    : [...userIdentities, ...BUILTIN_MODEL_IDENTITIES]
}

/** 该键是否是「合并型」条目（有 match ⇒ 会把多条候选并进来）。 */
export function isUnifiedKey(key: string): boolean {
  return allIdentities().some((rule) => rule.key === key && rule.match !== undefined)
}

/** 按字面 id 匹配（两边都归一化）。 */
function ruleMatchesId(rule: ModelIdentityRule, idKey: string): boolean {
  const ids = rule.match?.ids
  if (ids === undefined || ids.length === 0) return false
  for (const id of ids) {
    if (normalizeModelKey(id) === idKey) return true
  }
  return false
}

/**
 * 一个候选条目归入哪个规范键。
 *
 * 顺序（**不可调换**）：
 * 1. **排除集**（查 `realId` / `idKey` / `nameKey`，见下）→ `undefined`；
 * 2. **字面 id 命中**（表里的 `ids`）→ `via: 'patch'`（人工逐条登记，面板标 ⚠️补丁）；
 * 3. **主通道**（`channelOf`）算出候选键，再查表里的 `pattern` → 保持原通道；
 * 4. 都没命中 ⇒ 原样返回主通道键（**不猜、不合并**）。
 *
 * ## ⚠️ 排除集必须查三条候选键，不能只查 id
 *
 * 初版只查 `realId` / `idKey`。但 `name` 通道的 provider 可以用**展示名**算出键
 * —— 若某条目的展示名归一后落在排除集里（如展示名就叫 `Auto`）而它的 id 不是
 * `auto`，初版会**放行**它 ⇒ 产出一个 `key === 'auto'` 的虚拟模型，与
 * `AGGREGATE_AUTO_MODEL` 撞名 ⇒ DSH 的 `listModels` 因 **id 重复**抛
 * `INVALID_CATALOG`（整个聚合目录直接不可用）。
 * ⇒ 排除判定必须在**算出键之后**再做一次。
 *
 * @returns `via` 标明归属来源，供面板标注 `⚠️补丁`（人工核查用）。
 */
export function canonicalKeyFor(
  provider: string,
  realId: string,
  realName: string,
): { key: string; via: 'id' | 'name' | 'patch' } | undefined {
  const idKey = normalizeModelKey(realId)
  if (EXCLUDED_ALIASES.has(realId) || EXCLUDED_ALIASES.has(idKey)) return undefined

  const rules = allIdentities()

  // ② 字面 id（机器代号 / 渠道前缀写法）：与型号名无字面关系，只能逐条登记。
  for (const rule of rules) {
    if (!ruleMatchesId(rule, idKey)) continue
    return EXCLUDED_ALIASES.has(rule.key) ? undefined : { key: rule.key, via: 'patch' }
  }

  // ③ 主通道算键 → 查 pattern。
  const nameKey = normalizeNameKey(realName)
  const chosen = channelOf(provider) === 'name' && nameKey.length > 0 && nameKey !== idKey
    ? { key: nameKey, via: 'name' as const }
    : { key: idKey, via: 'id' as const }
  if (EXCLUDED_ALIASES.has(chosen.key)) return undefined

  for (const rule of rules) {
    const pattern = rule.match?.pattern
    if (pattern === undefined) continue
    if (!pattern.test(chosen.key)) continue
    // pattern 命中保持原通道（确定性归一，不新增 `⚠️补丁` 标记）。
    return EXCLUDED_ALIASES.has(rule.key) ? undefined : { key: rule.key, via: chosen.via }
  }

  // ④ 没命中 ⇒ 原样（宁可漏合并，不可错合并）。
  return chosen
}

/**
 * 规范键 → **官方展示名**（用户在模型选择器里看到的名字）。
 *
 * ⚠️ 只登记我们**确定**的模型。未登记的回退为键本身（**不编造**）——
 * 编造一个「看起来像官方」的名字比显示裸键更糟：用户无从判断它是不是自己
 * 想的那个模型。
 * ⚠️ 展示名**不含倍率**：倍率是按渠道不同的运行时信息，写进规范名会让同一虚拟
 * 模型在不同渠道下显示不同名字（与「归一」的目的相反）。
 *
 * ⚠️ **必须用 `Object` 安全的查找**：`BUILTIN_MODEL_IDENTITIES` 是数组，
 * 用 `.find` 天然没有原型链问题；但**不得**改回对象字面量查表 ——
 * 那会让 `constructor` 这类键返回 `Object` 构造函数，DSH 校验 name 为字符串时
 * 抛 `INVALID_CATALOG`（整个聚合目录不可用，本仓库有实测记录）。
 */
export function canonicalDisplayName(key: string): string {
  for (const rule of allIdentities()) {
    if (rule.key === key) return rule.name
  }
  return key
}
// 选路决策：纯函数，不碰网络、不碰文件。
//
// 决策的最小单位从「四类通道」细化成「具体链路」：
//   lan:192.168.1.2 / lants:100.64.x.x / manual:lanUrl / tailcat / relay
// 手动模式按用户给的链路顺序（单选/多选/拖拽）走；自动模式按质量 + 稳定性综合评分挑；
// lan-first 按组优先级走、组内按 RTT 挑。三套模式共用一套健康判据与降级迟滞。
//
// 一条链路「不健康」= 探测失败，或 RTT 超过该类阈值。不健康不会立刻降级：要连续 N 次
// （thresholds[group].fails）才算数，否则一次抖动就会把手机推到更慢的线路上。
'use strict'

const groupOf = id => {
  if (typeof id !== 'string') return ''
  if (id.startsWith('lan:')) return 'lan'
  if (id.startsWith('lants:')) return 'lan-ts'  // 100.64 网卡：局域网内线路，与 DSH tailcat 隧道分开
  if (id.startsWith('ts:')) return 'tailscale' // 旧 id 兼容
  if (id.startsWith('manual:')) return 'manual'
  return id // tailcat / relay / 旧式的 channel key
}

/**
 * 一条链路此刻是否可用且够快。
 *
 * RTT 未知但连得上（直连隧道、手填链路这种电脑侧量不到时延的）算健康：不参与速度比较，
 * 但仍然可以当兜底。真正不可达时 `ok` 是 false，不会漏到这来。
 */
export function isHealthy(channel, state, thresholds) {
  if (!state || state.ok !== true) return false
  if (typeof state.rttMs !== 'number' || !Number.isFinite(state.rttMs)) return true
  const limit = thresholds?.[groupOf(channel)]?.degradeMs ?? Infinity
  return state.rttMs <= limit
}

/** 是否至少连得上（不看快慢）。 */
export function isAlive(state) {
  return Boolean(state && state.ok === true)
}

/** 综合分越高越好。质量看 EMA RTT，稳定性看可用率 + 抖动。 */
export function scoreLink(id, state, thresholds, policy) {
  if (!isHealthy(id, state, thresholds)) return -Infinity
  const qualityWeight = policy?.qualityWeight ?? 0.7
  const stabilityWeight = policy?.stabilityWeight ?? 0.3
  const totalWeight = Math.max(qualityWeight + stabilityWeight, 0.0001)

  // 质量分：RTT 越小分越高。用 1/(1+rtt/100) 归一化到 (0,1]。
  const rtt = typeof state.avgMs === 'number' ? state.avgMs
    : (typeof state.rttMs === 'number' ? state.rttMs : null)
  const quality = rtt === null ? 0.5 : 1 / (1 + rtt / 100)

  // 稳定性分：可用率越高、抖动越小分越高。没探测过时给中性分。
  const availability = state.probes > 0 ? (state.okCount || 0) / state.probes : 0.5
  const jitter = typeof state.jitterMs === 'number' ? state.jitterMs : 0
  const jitterPenalty = 1 / (1 + jitter / 50)
  const stability = 0.6 * availability + 0.4 * jitterPenalty

  return (qualityWeight * quality + stabilityWeight * stability) / totalWeight
}

/** 从 measurements 里挑综合分最高的一条；可选 exclude 一组 id。 */
function pickBest(measurements, thresholds, policy, exclude = new Set()) {
  let best = null
  let bestScore = -Infinity
  for (const [id, state] of Object.entries(measurements)) {
    if (exclude.has(id)) continue
    const score = scoreLink(id, state, thresholds, policy)
    if (score > bestScore) { best = id; bestScore = score }
  }
  if (best) return best
  // 一个健康分都没有时退回「连得上但慢」的那条，仍排除 flap 过的。
  for (const [id, state] of Object.entries(measurements)) {
    if (!exclude.has(id) && isAlive(state)) return id
  }
  return null
}

/** 手动顺序（或 lan-first 的组顺序）里挑第一条可用的。 */
function pickByOrder(order, measurements, thresholds) {
  for (const id of order) if (isHealthy(id, measurements[id], thresholds)) return id
  for (const id of order) if (isAlive(measurements[id])) return id
  return null
}

/**
 * 顺序里排在 current 前面、且此刻健康的链路。
 * 「局域网优先」不能只在降级时生效——局域网恢复后必须能抢回来。
 */
function preferredAbove(order, current, measurements, thresholds) {
  for (const id of order) {
    if (id === current) return null
    if (isHealthy(id, measurements[id], thresholds)) return id
  }
  return null
}

/** 把 selection（可能是链路 id）与 channel 级 order 合并成一条完整的优先序列。 */
function buildOrder(config, measurements) {
  if (config.mode === 'manual' && Array.isArray(config.selection) && config.selection.length) {
    // 用户显式选的链路排前面；selection 里没有但 measurements 里有的，按 group order 补在后面。
    const rest = Object.keys(measurements)
      .filter(id => !config.selection.includes(id))
      .sort((a, b) => groupRank(groupOf(a)) - groupRank(groupOf(b)))
    return [...config.selection, ...rest]
  }
  if (config.mode === 'manual') return config.order
  // lan-first / auto：按组顺序展开 measurements；同一组内按 RTT 从低到高排，
  // 这样多条局域网链路里 lan-first 也会挑当下最快的那条（质量优先，仍守组优先级）。
  return Object.keys(measurements).sort((a, b) => {
    const g = groupRank(groupOf(a)) - groupRank(groupOf(b))
    if (g !== 0) return g
    const ra = measurements[a]?.rttMs
    const rb = measurements[b]?.rttMs
    if (typeof ra !== 'number') return typeof rb !== 'number' ? 0 : 1
    if (typeof rb !== 'number') return -1
    return ra - rb
  })
}

function groupRank(group) {
  const order = ['lan', 'lan-ts', 'tailscale', 'manual', 'tailcat', 'relay']
  const i = order.indexOf(group)
  return i === -1 ? 99 : i
}

/**
 * 算出这一轮应该用哪条链路，以及要把 dsh-mobile-plugin 改成什么样。
 *
 * @param {object} args.config 归一后的配置
 * @param {Record<string, object>} args.measurements 各链路最新状态（key 为链路 id 或旧式 channel key）
 * @param {object} args.prev 上一轮决策（`{ current, softFails, switchedAt, switches }`）
 * @param {object} args.context 环境事实
 * @param {number} args.now 时间戳（测试注入）
 */
export function decide({ config, measurements, prev = {}, context = {}, now = Date.now() }) {
  const thresholds = config.thresholds
  const policy = config.autoPolicy || {}
  const current = prev.current || null
  const currentState = current ? measurements[current] : null
  const currentHealthy = current ? isHealthy(current, currentState, thresholds) : false
  const activeOrder = buildOrder(config, measurements)

  // 当前这条不健康的「连击」：没到阈值就继续守着它。
  const currentGroup = groupOf(current)
  const failsNeeded = current ? (thresholds[currentGroup]?.fails ?? 3) : 1
  const softFails = currentHealthy ? 0 : (prev.softFails || 0) + 1
  const dwellMs = now - (prev.switchedAt || 0)
  const minDwell = policy.minDwellMs > 0 ? policy.minDwellMs : config.intervalMs * 2
  const flapLimit = policy.maxFlapPer10m ?? 3

  let target = null
  let reason = ''

  if (!current) {
    reason = 'initial'
  } else if (currentHealthy && softFails === 0) {
    if (config.mode === 'auto') {
      // 10 分钟内被切进来太多次的链路暂时拉黑，抑制 auto 模式来回横跳。
      const flapExclude = new Set()
      for (const [id, times] of Object.entries(prev.switches || {})) {
        const recent = (times || []).filter(t => now - t < 10 * 60 * 1000)
        if (recent.length >= flapLimit) flapExclude.add(id)
      }
      const best = pickBest(measurements, thresholds, policy, flapExclude)
      const currentScore = scoreLink(current, currentState, thresholds, policy)
      const bestScore = best ? scoreLink(best, measurements[best], thresholds, policy) : -Infinity
      const clearlyBetter = best && best !== current && bestScore > currentScore * (1 + (policy.switchRatio ?? 0.15))
      if (clearlyBetter && dwellMs >= minDwell) {
        target = best
        reason = `auto: ${best} 综合分明显更高（${bestScore.toFixed(3)} > ${currentScore.toFixed(3)}）`
      }
    } else {
      // 顺序型模式：排在前面那条一旦恢复健康，就抢回来。
      const better = preferredAbove(activeOrder, current, measurements, thresholds)
      if (better && dwellMs >= minDwell) {
        target = better
        reason = `抢回更高优先级：${better} 已恢复`
      }
    }
    target = target || current
    reason = reason || `keep: ${current} 健康`
  } else if (softFails < failsNeeded) {
    target = current
    reason = `hold: ${current} 暂不健康（${softFails}/${failsNeeded}）`
  } else {
    reason = `${current} 连续 ${softFails} 次不健康，降级`
  }

  if (!target) {
    if (config.mode === 'manual') target = pickByOrder(activeOrder, measurements, thresholds)
    else if (config.mode === 'auto') target = pickBest(measurements, thresholds, policy)
    else target = pickByOrder(activeOrder, measurements, thresholds)
    if (!target) {
      // 一条都不通：保持现状，别把手机踢到一个更差的配置上。
      target = current
      reason = 'none: 没有任何链路可用，保持现状'
    } else if (target !== current) {
      reason = `${reason}，切到 ${target}`
    }
  }

  const switched = target !== current
  const switches = { ...(prev.switches || {}) }
  if (switched && target) switches[target] = [...(switches[target] || []), now]
  const nextPrev = {
    current: target,
    softFails: switched ? 0 : softFails,
    switchedAt: switched ? now : (prev.switchedAt || 0),
    switches,
  }

  const actions = buildActions({ config, target, measurements, context })
  const warnings = buildWarnings({ config, target, measurements, context })

  return { target, reason, actions, warnings, prev: nextPrev }
}

export const TS_V4_PATTERN = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/**
 * 把「用哪条链路」翻译成 dsh-mobile-plugin 的配置动作。
 *
 * 电脑侧能表达的三样：局域网候选的优先地址（preferredLanAddress）、手填直连地址
 * （manualLanUrl）、直连隧道开关。
 *   - lan:<addr>    → preferredLanAddress = addr（只能调网卡候选顺序，见 dsh-mobile-plugin）
 *   - ts:<addr>     → manualLanUrl = http://addr:port
 *   - manual:<field>→ 该字段原样写回（manualLanUrl / manualIpv4Url / ...），不碰其它手填字段
 *   - tailcat       → 隧道开、清空 LAN 优先地址
 *   - relay         → 不需要动作
 */
export function buildActions({ config, target, measurements, context }) {
  const actions = []
  const contextAny = context || {}
  const port = Number.isInteger(contextAny.lanPort) && contextAny.lanPort > 0 ? contextAny.lanPort : 18787
  const links = Array.isArray(contextAny.links) ? contextAny.links : []
  const findLink = id => links.find(link => link.id === id)

  // 兼容旧式的 channel key：策略层现在返回链路 id，但外部/测试可能仍传 'lan' / 'tailscale'。
  if (target === 'lan' && contextAny.lanAddress) target = `lan:${contextAny.lanAddress}`
  else if (target === 'tailscale' && contextAny.tailscaleAddress) target = `ts:${contextAny.tailscaleAddress}`
  // 测量值也兼容旧式：链路 id 找不到时回退到 group key。
  const measureOf = id => measurements[id] || measurements[groupOf(id)]

  if (typeof target === 'string' && target.startsWith('lan:')) {
    const addr = target.slice(4)
    actions.push({ kind: 'preferredLanAddress', value: addr })
    actions.push({ kind: 'manualLanUrl', value: '' })
    if (contextAny.manualTcpUrl && TS_V4_PATTERN.test(contextAny.manualTcpUrl)) {
      actions.push({ kind: 'manualTcpUrl', value: '' })
    }
    const lanHealthy = isHealthy(target, measureOf(target), config.thresholds)
    const phoneOnLan = contextAny.deviceLastChannel === 'lan' || contextAny.lanSeenByPhone === true
    const entryStable = contextAny.entryUnstable !== true
    const safeToClose = config.allowDisableTailcat && lanHealthy && phoneOnLan && entryStable
    actions.push({ kind: 'tailcat', enabled: !safeToClose })
    if (!safeToClose) {
      if (!config.allowDisableTailcat) actions.push({ kind: 'note', value: '未允许关闭直连隧道，保持兜底' })
      else if (!lanHealthy) actions.push({ kind: 'note', value: '局域网未通过探测，保持直连隧道' })
      else if (!phoneOnLan) actions.push({ kind: 'note', value: '局域网尚未被手机实际使用过，暂不关闭直连隧道' })
      else if (!entryStable) actions.push({ kind: 'note', value: '局域网入口近期崩过，先保住直连隧道兜底' })
    }
  } else if (typeof target === 'string' && target.startsWith('lants:')) {
    // 100.64 网卡地址：局域网内的一条线路，通过 manualLanUrl 上报给手机。
    // 它与 DSH 内置 tailcat 隧道是两条独立线路——这里必须保持隧道开启，不能像选普通
    // RFC1918 局域网那样去关它；也清掉其它手填字段，避免占用同一字段打架。
    const addr = target.slice(6)
    const link = findLink(target)
    const url = link?.url || `http://${addr}:${port}`
    actions.push({ kind: 'preferredLanAddress', value: '' })
    for (const key of ['manualLanUrl', 'manualIpv4Url', 'manualIpv6Url', 'manualTcpUrl']) {
      actions.push({ kind: key, value: key === 'manualLanUrl' ? url : '' })
    }
    actions.push({ kind: 'tailcat', enabled: true })
  } else if (typeof target === 'string' && target.startsWith('ts:')) {
    // 旧 id 兼容：曾经的 ts: 现在等同 lants:，同样写 manualLanUrl、保留隧道。
    const addr = target.slice(3)
    actions.push({ kind: 'preferredLanAddress', value: '' })
    for (const key of ['manualLanUrl', 'manualIpv4Url', 'manualIpv6Url', 'manualTcpUrl']) {
      actions.push({ kind: key, value: key === 'manualLanUrl' ? `http://${addr}:${port}` : '' })
    }
    actions.push({ kind: 'tailcat', enabled: true })
  } else if (typeof target === 'string' && target.startsWith('manual:')) {
    const link = findLink(target)
    const field = link?.field || target.slice(7)
    const value = link?.url || contextAny[field] || ''
    actions.push({ kind: 'preferredLanAddress', value: '' })
    // 手填链路各自回写自己的字段；清掉其它手填字段以免多条同时生效互相打架。
    for (const key of ['manualLanUrl', 'manualIpv4Url', 'manualIpv6Url', 'manualTcpUrl']) {
      actions.push({ kind: key, value: key === field ? value : '' })
    }
    actions.push({ kind: 'tailcat', enabled: true })
  } else if (target === 'tailcat') {
    actions.push({ kind: 'preferredLanAddress', value: '' })
    actions.push({ kind: 'manualLanUrl', value: '' })
    actions.push({ kind: 'tailcat', enabled: true })
  }
  // relay 不需要动作：由 dsh-mobile-plugin 自己维护。
  return actions
}

function buildWarnings({ config, target, measurements, context }) {
  const warnings = []
  const contextAny = context || {}
  const links = Array.isArray(contextAny.links) ? contextAny.links : []
  if (typeof target === 'string' && target.startsWith('lan:') && !links.some(l => l.id === target)) {
    warnings.push('目标局域网链路已不在网卡清单里，可能刚被拔掉')
  }
  if (typeof target === 'string' && target.startsWith('lants:') && !links.some(l => l.id === target)) {
    warnings.push('目标 Tailscale 网卡（局域网线路）已消失')
  }
  if (typeof target === 'string' && target.startsWith('ts:') && !links.some(l => l.id === target)) {
    warnings.push('目标 Tailscale 链路已消失')
  }
  if (target === 'lan' && !contextAny.lanAddress) {
    warnings.push('找不到局域网地址，无法把流量固定到局域网')
  }
  if (target === 'tailscale' && !contextAny.tailscaleAddress) {
    warnings.push('这台电脑没有 Tailscale 地址（100.64.0.0/10），选它没有意义')
  }
  if (groupOf(target) === 'lan' && config.autoHealSidecar === false && measurements[target]?.ok === false) {
    warnings.push('局域网入口连不上，且自动修复已关闭，需要手动在插件面板重启 sidecar')
  }
  return warnings
}

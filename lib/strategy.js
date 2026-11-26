// 选路决策：纯函数，不碰网络、不碰文件。
//
// 三种模式共用一套「健康」判据，差别只在怎么挑：
//   lan-first  按固定偏好 lan → tailscale → tailcat → relay
//   auto       在健康通道里挑 RTT 最小的（有滞后，避免来回跳）
//   manual     严格按用户给的顺序，前一条不健康才让位
//
// 一条通道「不健康」= 探测失败，或 RTT 超过该类阈值。不健康不会立刻降级：要连续 N 次
// （thresholds[key].fails）才算数，否则一次抖动就会把手机推到更慢的线路上。
'use strict'

/**
 * 一条通道此刻是否可用且够快。
 *
 * RTT 未知但连得上（直连隧道这种电脑侧量不到时延的通道）算健康：不参与速度比较，
 * 但仍然可以当兜底。真正不可达时 `ok` 是 false，不会漏到这来。
 */
export function isHealthy(channel, state, thresholds) {
  if (!state || state.ok !== true) return false
  if (typeof state.rttMs !== 'number' || !Number.isFinite(state.rttMs)) return true
  const limit = thresholds?.[channel]?.degradeMs ?? Infinity
  return state.rttMs <= limit
}

/** 是否至少连得上（不看快慢）。 */
export function isAlive(state) {
  return Boolean(state && state.ok === true)
}

function healthRank(channel, state, thresholds) {
  if (!isHealthy(channel, state, thresholds)) return 0
  if (typeof state?.rttMs !== 'number') return 0
  return 1_000_000 - Math.round(state.rttMs)
}

/**
 * 手动顺序里挑第一条可用的；全都不健康时退回「连得上但慢」的那条，一个都连不上就 null。
 */
function pickByOrder(order, measurements, thresholds) {
  for (const channel of order) if (isHealthy(channel, measurements[channel], thresholds)) return channel
  for (const channel of order) if (isAlive(measurements[channel])) return channel
  return null
}

function pickFastest(measurements, thresholds) {
  let best = null
  let bestRtt = Infinity
  for (const [channel, state] of Object.entries(measurements)) {
    // 时延未知的通道（直连隧道）不参与速度比较：拿它跟 12ms 的局域网比是在编数字。
    if (typeof state?.rttMs !== 'number' || !Number.isFinite(state.rttMs)) continue
    if (!isHealthy(channel, state, thresholds)) continue
    if (state.rttMs < bestRtt) { best = channel; bestRtt = state.rttMs }
  }
  if (best) return best
  for (const [channel, state] of Object.entries(measurements)) if (isAlive(state)) return channel
  return null
}

/**
 * 顺序里排在 current 前面、且此刻健康的通道。
 * 「局域网优先」不能只在降级时生效——局域网恢复后必须能抢回来，否则一旦抖到隧道就再也回不去了。
 */
function preferredAbove(order, current, measurements, thresholds) {
  for (const channel of order) {
    if (channel === current) return null
    if (isHealthy(channel, measurements[channel], thresholds)) return channel
  }
  return null
}

/**
 * 算出这一轮应该用哪条通道，以及要把 dsh-mobile-plugin 改成什么样。
 *
 * @param {object} args
 * @param {object} args.config 归一后的配置
 * @param {Record<string, object>} args.measurements 各通道最新状态
 * @param {object} args.prev 上一轮决策（`{ current, softFails, switchedAt }`）
 * @param {object} args.context 环境事实：手机最后用过的通道、局域网地址、是否已知手机走过局域网
 * @param {number} args.now 时间戳（测试注入）
 */
export function decide({ config, measurements, prev = {}, context = {}, now = Date.now() }) {
  const thresholds = config.thresholds
  const order = config.order
  const lanFirstOrder = ['lan', 'tailscale', 'tailcat', 'relay']
  const current = prev.current || null
  const currentState = current ? measurements[current] : null
  const currentHealthy = current ? isHealthy(current, currentState, thresholds) : false
  const activeOrder = config.mode === 'manual' ? order : lanFirstOrder

  // 当前这条不健康的「连击」：没到阈值就继续守着它。
  const failsNeeded = current ? (thresholds[current]?.fails ?? 3) : 1
  const softFails = currentHealthy ? 0 : (prev.softFails || 0) + 1
  const dwellMs = now - (prev.switchedAt || 0)
  const minDwell = config.intervalMs * 2

  let target = null
  let reason = ''

  if (!current) {
    reason = 'initial'
  } else if (currentHealthy && softFails === 0) {
    if (config.mode === 'auto') {
      // auto 只看快慢：比当前快 25% 以上才换，避免来回跳。
      const fastest = pickFastest(measurements, thresholds)
      const currentRtt = typeof currentState?.rttMs === 'number' ? currentState.rttMs : null
      const fastestRtt = fastest ? measurements[fastest]?.rttMs : null
      const comparable = currentRtt !== null && typeof fastestRtt === 'number'
      const clearlyBetter = fastest && fastest !== current && comparable
        && fastestRtt * 1.25 < currentRtt
      if (clearlyBetter && dwellMs >= minDwell) {
        target = fastest
        reason = `auto: ${fastest} 比 ${current} 快 25% 以上`
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
    if (config.mode === 'manual') target = pickByOrder(order, measurements, thresholds)
    else if (config.mode === 'auto') target = pickFastest(measurements, thresholds)
    else target = pickByOrder(lanFirstOrder, measurements, thresholds)
    if (!target) {
      // 一条都不通：保持现状，别把手机踢到一个更差的配置上。
      target = current
      reason = 'none: 没有任何通道可用，保持现状'
    } else if (target !== current) {
      reason = `${reason}，切到 ${target}`
    }
  }

  const switched = target !== current
  const nextPrev = {
    current: target,
    softFails: switched ? 0 : softFails,
    switchedAt: switched ? now : (prev.switchedAt || 0),
  }

  const actions = buildActions({ config, target, measurements, context })
  const warnings = buildWarnings({ config, target, measurements, context })

  return { target, reason, actions, warnings, prev: nextPrev }
}

/**
 * 把「用哪条通道」翻译成 dsh-mobile-plugin 的配置动作。
 *
 * 电脑侧能表达的只有三样：局域网候选的优先地址、手填直连地址、直连隧道开关。
 * 所以「选 tailscale」= 把它写成手填直连；「选局域网」= 把网卡地址设为优先，
 * 并且在安全时关掉直连隧道；「选隧道」= 保持隧道开、不指定优先地址。
 */
export function buildActions({ config, target, measurements, context }) {
  const actions = []
  const lanAddress = context.lanAddress || ''
  const tsAddress = context.tailscaleAddress || ''
  const port = Number.isInteger(context.lanPort) && context.lanPort > 0 ? context.lanPort : 18787

  if (target === 'lan') {
    if (lanAddress) actions.push({ kind: 'preferredLanAddress', value: lanAddress })
    actions.push({ kind: 'manualLanUrl', value: '' })
    // 手填的 TCP 直连如果指向 Tailscale 网段，在「局域网优先」下它就是一条绕路候选，一并收掉。
    // 其它地址（内网穿透域名等）不动：那是用户自己的线路，不属于这一轮的编排范围。
    if (context.manualTcpUrl && TS_V4_PATTERN.test(context.manualTcpUrl)) {
      actions.push({ kind: 'manualTcpUrl', value: '' })
    }
    // 只有在局域网确实健康、手机最近真的走过局域网、且入口本身稳定时，才敢关隧道。
    const lanHealthy = isHealthy('lan', measurements.lan, config.thresholds)
    const phoneOnLan = context.deviceLastChannel === 'lan' || context.lanSeenByPhone === true
    const entryStable = context.entryUnstable !== true
    const safeToClose = config.allowDisableTailcat && lanHealthy && phoneOnLan && entryStable
    actions.push({ kind: 'tailcat', enabled: !safeToClose })
    if (!safeToClose) {
      if (!config.allowDisableTailcat) actions.push({ kind: 'note', value: '未允许关闭直连隧道，保持兜底' })
      else if (!lanHealthy) actions.push({ kind: 'note', value: '局域网未通过探测，保持直连隧道' })
      else if (!phoneOnLan) actions.push({ kind: 'note', value: '局域网尚未被手机实际使用过，暂不关闭直连隧道' })
      else if (!entryStable) actions.push({ kind: 'note', value: '局域网入口近期崩过，先保住直连隧道兜底' })
    }
  } else if (target === 'tailscale') {
    actions.push({ kind: 'preferredLanAddress', value: '' })
    if (tsAddress) actions.push({ kind: 'manualLanUrl', value: `http://${tsAddress}:${port}` })
    actions.push({ kind: 'tailcat', enabled: true })
  } else if (target === 'tailcat') {
    actions.push({ kind: 'preferredLanAddress', value: '' })
    actions.push({ kind: 'manualLanUrl', value: '' })
    actions.push({ kind: 'tailcat', enabled: true })
  }
  // relay 不需要动作：它由 dsh-mobile-plugin 自己维护，关掉局域网也影响不到它。
  return actions
}

export const TS_V4_PATTERN = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

function buildWarnings({ config, target, measurements, context }) {
  const warnings = []
  if (target === 'lan' && !context.lanAddress) {
    warnings.push('找不到局域网地址，无法把流量固定到局域网')
  }
  if (target === 'tailscale' && !context.tailscaleAddress) {
    warnings.push('这台电脑没有 Tailscale 地址（100.64.0.0/10），选它没有意义')
  }
  if (target === 'lan' && config.autoHealSidecar === false && measurements.lan?.ok === false) {
    warnings.push('局域网入口连不上，且自动修复已关闭，需要手动在插件面板重启 sidecar')
  }
  return warnings
}

// 配置形状与归一。
//
// 宁可在这里把坏值挡成默认值，也不要在策略层到处判类型：策略层只该看「一条通道现在怎么样」，
// 不该关心用户传进来的是 "80" 还是 80。
'use strict'

export const MODES = ['lan-first', 'auto', 'manual']
export const CHANNELS = ['lan', 'tailscale', 'tailcat', 'relay']

const DEFAULT_THRESHOLDS = {
  lan: { degradeMs: 80, restoreMs: 50, fails: 3 },
  tailscale: { degradeMs: 120, restoreMs: 70, fails: 3 },
  tailcat: { degradeMs: 180, restoreMs: 100, fails: 3 },
  relay: { degradeMs: 220, restoreMs: 140, fails: 3 },
}

const int = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

function oneThreshold(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    degradeMs: int(src.degradeMs, fallback.degradeMs, 1, 60000),
    restoreMs: int(src.restoreMs, fallback.restoreMs, 1, 60000),
    fails: int(src.fails, fallback.fails, 1, 100),
  }
}

/**
 * 把手写的 config（bundle 行里的、面板提交的）收敛成一份完整配置。
 * 未知键直接丢掉：面板与 bundle 行共用这一个入口，多出来的字段不该渗进落盘状态。
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const mode = MODES.includes(src.mode) ? src.mode : 'lan-first'
  const order = Array.isArray(src.order)
    ? src.order.filter((key, index, list) => CHANNELS.includes(key) && list.indexOf(key) === index)
    : []
  const thresholdsRaw = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {}
  const thresholds = {}
  for (const key of CHANNELS) thresholds[key] = oneThreshold(thresholdsRaw[key], DEFAULT_THRESHOLDS[key])
  return {
    mode,
    // 手动顺序缺项时补全，保证每一类都出现在序列里：少一条就等于那条永远不被选中，
    // 面板上也点不回来。
    order: order.length ? [...order, ...CHANNELS.filter(key => !order.includes(key))] : [...CHANNELS],    intervalMs: int(src.intervalMs, 4000, 1000, 60000),
    probeTimeoutMs: int(src.probeTimeoutMs, 1200, 200, 10000),
    thresholds,
    // 关掉 tailcat 是「逼手机走局域网」的唯一手段，也是唯一能让手机彻底连不上的动作。
    // 默认允许，但策略层还要求局域网实测健康 + 手机最近确实走过局域网，两道闸缺一不可。
    allowDisableTailcat: bool(src.allowDisableTailcat, true),
    autoHealSidecar: bool(src.autoHealSidecar, true),
    // 局域网入口的崩溃在现场是「几十秒到几分钟一次」的量级，5 分钟的冷却等于放它死着不管。
    // 30 秒是「够快恢复」与「别在真故障里疯狂重启」之间折中的那一档。
    healCooldownMs: int(src.healCooldownMs, 30000, 10000, 3600000),
    // 观察模式：只算不动手，用户可以先看几天它想切到哪。
    dryRun: bool(src.dryRun, false),
  }
}

export { DEFAULT_THRESHOLDS }

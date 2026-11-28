// 配置形状与归一。
//
// 宁可在这里把坏值挡成默认值，也不要在策略层到处判类型：策略层只该看「一条链路现在怎么样」，
// 不该关心用户传进来的是 "80" 还是 80。
//
// 配置分两层：
//   - channel 层（order / thresholds / GROUPS）：四类通道的粗粒度顺序与健康阈值；
//   - link 层（selection）：手动模式下具体每条链路的优先级，支持单选、多选、拖拽排序。
//     链路 id 形如 lan:192.168.1.2 / lants:100.64.x.x / manual:lanUrl / tailcat / relay。
'use strict'

export const MODES = ['lan-first', 'auto', 'manual']
// lan-ts = 100.64 网卡的局域网线路（与 DSH 内置 tailcat 隧道分开）。
// tailscale 作为旧 id 的兼容组保留，避免旧配置里这一组阈值丢失。
export const CHANNELS = ['lan', 'lan-ts', 'tailscale', 'tailcat', 'relay']
export const GROUPS = CHANNELS

const DEFAULT_THRESHOLDS = {
  lan: { degradeMs: 80, restoreMs: 50, fails: 3 },
  'lan-ts': { degradeMs: 120, restoreMs: 70, fails: 3 },
  tailscale: { degradeMs: 120, restoreMs: 70, fails: 3 }, // 兼容旧配置
  tailcat: { degradeMs: 180, restoreMs: 100, fails: 3 },
  relay: { degradeMs: 220, restoreMs: 140, fails: 3 },
}

// 自动模式的默认评分策略：质量（RTT）为主，稳定性（失败/抖动）为辅。
const DEFAULT_AUTO_POLICY = {
  qualityWeight: 0.7,      // 时延在综合分里的权重
  stabilityWeight: 0.3,    // 稳定性在综合分里的权重
  switchRatio: 0.15,       // 新链路要比当前综合分好 15% 才切换（滞后，避免来回跳）
  maxFlapPer10m: 3,        // 10 分钟内切换到这条链路超过这个次数就暂时不再选它
  minDwellMs: 0,           // 0 = 用 intervalMs * 2 作为默认驻留时间
}

const int = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

const num = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
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

function oneAutoPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const qualityWeight = num(src.qualityWeight, DEFAULT_AUTO_POLICY.qualityWeight, 0, 1)
  return {
    qualityWeight,
    stabilityWeight: num(src.stabilityWeight, DEFAULT_AUTO_POLICY.stabilityWeight, 0, 1),
    switchRatio: num(src.switchRatio, DEFAULT_AUTO_POLICY.switchRatio, 0, 0.9),
    maxFlapPer10m: int(src.maxFlapPer10m, DEFAULT_AUTO_POLICY.maxFlapPer10m, 0, 100),
    minDwellMs: int(src.minDwellMs, DEFAULT_AUTO_POLICY.minDwellMs, 0, 3600000),
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
  // link 级选择：去重、只收字符串，允许为空（= 跟随 channel 层 / 默认优先级）。
  const selection = Array.isArray(src.selection)
    ? src.selection.filter((id, index, list) => typeof id === 'string' && id.length > 0 && id.length <= 128 && list.indexOf(id) === index)
    : []
  const thresholdsRaw = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {}
  const thresholds = {}
  for (const key of CHANNELS) thresholds[key] = oneThreshold(thresholdsRaw[key], DEFAULT_THRESHOLDS[key])
  return {
    mode,
    // 手动顺序缺项时补全，保证每一类都出现在序列里：少一条就等于那条永远不被选中，
    // 面板上也点不回来。
    order: order.length ? [...order, ...CHANNELS.filter(key => !order.includes(key))] : [...CHANNELS],
    selection,
    intervalMs: int(src.intervalMs, 4000, 1000, 60000),
    probeTimeoutMs: int(src.probeTimeoutMs, 1200, 200, 10000),
    thresholds,
    autoPolicy: oneAutoPolicy(src.autoPolicy),
    // 关掉 tailcat 是「逼手机走局域网」的唯一手段，也是唯一能让手机彻底连不上的动作。
    // 默认允许，但策略层还要求局域网实测健康 + 手机最近确实走过局域网，两道闸缺一不可。
    allowDisableTailcat: bool(src.allowDisableTailcat, true),
    autoHealSidecar: bool(src.autoHealSidecar, true),
    // 局域网入口的崩溃在现场是「几十秒到几分钟一次」的量级，5 分钟的冷却等于放它死着不管。
    // 30 秒是「够快恢复」与「别在真故障里疯狂重启」之间折中的那一档。
    healCooldownMs: int(src.healCooldownMs, 30000, 10000, 3600000),
    // 看门狗：单位窗口内重启次数超上限就暂停自动重启，避免自愈本身反复拖断移动连接。
    healWatchdog: {
      windowMs: int(src.healWatchdog?.windowMs, 10 * 60 * 1000, 60000, 24 * 3600 * 1000),
      maxRestarts: int(src.healWatchdog?.maxRestarts, 3, 1, 100),
      cooldownMs: int(src.healWatchdog?.cooldownMs, 15 * 60 * 1000, 60000, 24 * 3600 * 1000),
    },
    // 自动重启守护：检测到 dsh-mobile-plugin 版本不一致/外壳换代时自动重启 DSH 宿主，
    // 彻底消除"每次自动更新后都要手动重启"。默认开启，带 24h 熔断防循环。
    restartGuard: {
      enabled: bool(src.restartGuard?.enabled, true),
      checkIntervalMs: int(src.restartGuard?.checkIntervalMs, 60000, 10000, 3600000),
      startupGraceMs: int(src.restartGuard?.startupGraceMs, 90000, 0, 30 * 60 * 1000),
      windowMs: int(src.restartGuard?.windowMs, 24 * 3600 * 1000, 60000, 7 * 24 * 3600 * 1000),
      maxRestarts: int(src.restartGuard?.maxRestarts, 2, 1, 20),
    },
    // 观察模式：只算不动手，用户可以先看几天它想切到哪。
    dryRun: bool(src.dryRun, false),
  }
}

export { DEFAULT_THRESHOLDS, DEFAULT_AUTO_POLICY }

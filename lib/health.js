// 局域网入口健康判据（纯函数）。
//
// 背景：dsh-mobile-plugin 0.5.12x 之后 /api/relay/status 不再提供 `lan.state` /
// `sidecar.state`。旧代码把 `undefined !== 'listening'` 当作故障，导致每轮探测
// 都误判入口挂掉、反复重启 sidecar，把移动连接一次次拖断。
//
// 新判据保守得多：只有**明确**看到故障态，且没有任何 LAN 链路实测可达时，才算
// 入口不健康。字段缺失 / 未知值一律视为健康——宁可少自愈一次，也不能因为误判
// 把正在用的连接断掉。
'use strict'

const UNHEALTHY = new Set(['error', 'stopped', 'failed', 'down', 'crashed', 'offline'])

/**
 * @param {object} relay /api/relay/status 的响应
 * @param {Record<string, object>} channels 各链路实测状态（key 为链路 id）
 * @returns {boolean} 是否明确处于故障态
 */
export function lanEntryUnhealthy(relay, channels) {
  const r = relay || {}
  const signals = [
    r.sidecar?.state,
    r.lan?.state,
    r.lan?.recovery?.state,
  ]
  const explicitlyBad = signals.some(value =>
    typeof value === 'string' && UNHEALTHY.has(value.toLowerCase()))
  if (!explicitlyBad) return false

  // 交叉验证：只要还有一条局域网链路实测可达，入口就是好的，不重启。
  const lanHealthy = Object.entries(channels || {})
    .some(([id, ch]) => id.startsWith('lan:') && ch && ch.ok === true)
  if (lanHealthy) return false
  return true
}

/**
 * 看门狗：判断本轮是否应该因重启过于频繁而熔断。
 * @param {number[]} restarts 滑动窗口内的重启时间戳
 * @param {number} now 当前时间
 * @param {{windowMs:number, maxRestarts:number}} cfg 看门狗配置
 * @returns {{shouldTrip:boolean, recent:number[]}}
 */
export function watchdogCheck(restarts, now, cfg) {
  const windowMs = cfg?.windowMs ?? 10 * 60 * 1000
  const maxRestarts = cfg?.maxRestarts ?? 3
  const recent = (restarts || []).filter(t => now - t < windowMs)
  return { shouldTrip: recent.length >= maxRestarts, recent }
}

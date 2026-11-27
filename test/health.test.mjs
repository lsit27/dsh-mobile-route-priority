import test from 'node:test'
import assert from 'node:assert/strict'

import { lanEntryUnhealthy, watchdogCheck } from '../lib/health.js'

test('新版本 status 没有 lan.state / sidecar.state 时不误判故障（关键回归）', () => {
  // 这是现场实际抓到的 0.5.127 结构：lan 没有 state，sidecar 没有 state
  const relay = {
    lan: { adjusted: false, recovery: { state: 'unchanged' }, requestedPort: 18787, ingressPort: 38471 },
    sidecar: { scope: { worker: 'restartable' } },
  }
  const channels = { 'lan:10.19.9.3': { ok: true, rttMs: 2 } }
  assert.equal(lanEntryUnhealthy(relay, channels), false)
})

test('明确故障态且无 LAN 链路可达时才判定不健康', () => {
  const relay = { sidecar: { state: 'error' }, lan: { recovery: { state: 'unchanged' } } }
  assert.equal(lanEntryUnhealthy(relay, {}), true)
})

test('明确故障态但 LAN 实测健康时不重启（交叉验证）', () => {
  const relay = { sidecar: { state: 'error' } }
  const channels = { 'lan:10.19.9.3': { ok: true, rttMs: 5 } }
  assert.equal(lanEntryUnhealthy(relay, channels), false)
})

test('未知状态值不当成故障', () => {
  const relay = { sidecar: { state: 'starting' }, lan: { recovery: { state: 'recovering' } } }
  assert.equal(lanEntryUnhealthy(relay, {}), false)
})

test('多种故障态都识别', () => {
  for (const state of ['error', 'stopped', 'failed', 'down', 'crashed', 'offline']) {
    assert.equal(lanEntryUnhealthy({ sidecar: { state } }, {}), true, `${state} 应判故障`)
  }
})

test('看门狗：窗口内重启次数达上限则熔断', () => {
  const now = 1_000_000
  const cfg = { windowMs: 600_000, maxRestarts: 3 }
  assert.equal(watchdogCheck([now - 1000, now - 2000], now, cfg).shouldTrip, false)
  assert.equal(watchdogCheck([now - 1000, now - 2000, now - 3000], now, cfg).shouldTrip, true)
})

test('看门狗：窗口外的旧重启不计入', () => {
  const now = 1_000_000
  const cfg = { windowMs: 600_000, maxRestarts: 3 }
  const result = watchdogCheck([now - 700_000, now - 800_000, now - 900_000, now - 1000], now, cfg)
  assert.equal(result.shouldTrip, false)
  assert.equal(result.recent.length, 1)
})

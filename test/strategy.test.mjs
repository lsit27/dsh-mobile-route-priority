import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { decide, isHealthy, buildActions } from '../lib/strategy.js'

const baseConfig = (patch = {}) => normalizeConfig({ intervalMs: 1000, ...patch })

const ch = (rttMs, fails = 0) => ({ ok: rttMs !== null, rttMs, fails, lastOkAt: 0, lastError: rttMs === null ? 'timeout' : '' })

const ctxBase = { lanAddress: '192.168.70.27', tailscaleAddress: '100.64.26.27', lanPort: 18787, deviceLastChannel: 'lan', lanSeenByPhone: true }

test('局域网健康时 lan-first 选局域网', () => {
  const result = decide({
    config: baseConfig({ mode: 'lan-first' }),
    measurements: { lan: ch(20), tailscale: ch(30), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: {},
    context: ctxBase,
    now: 1000,
  })
  assert.equal(result.target, 'lan')
})

test('局域网连续不健康达到阈值后降级到 Tailscale', () => {
  const config = baseConfig({ mode: 'lan-first' })
  const prev = { current: 'lan', softFails: 2, switchedAt: 0 }
  const result = decide({
    config,
    measurements: { lan: ch(400, 4), tailscale: ch(40), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev,
    context: ctxBase,
    now: 5000,
  })
  assert.equal(result.target, 'tailscale')
  assert.match(result.reason, /降级/)
})

test('未到阈值时保持当前通道，避免一次抖动就切换', () => {
  const result = decide({
    config: baseConfig({ mode: 'lan-first' }),
    measurements: { lan: ch(300, 1), tailscale: ch(40), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: { current: 'lan', softFails: 0, switchedAt: 0 },
    context: ctxBase,
    now: 3000,
  })
  assert.equal(result.target, 'lan')
  assert.match(result.reason, /hold|暂不健康/)
})

test('auto 模式挑延迟最低的那条', () => {
  const result = decide({
    config: baseConfig({ mode: 'auto' }),
    measurements: { lan: ch(60), tailscale: ch(12), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: {},
    context: ctxBase,
    now: 1000,
  })
  assert.equal(result.target, 'tailscale')
})

test('manual 模式严格按用户顺序', () => {
  const result = decide({
    config: baseConfig({ mode: 'manual', order: ['tailcat', 'lan', 'tailscale', 'relay'] }),
    measurements: { lan: ch(10), tailscale: ch(15), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: {},
    context: ctxBase,
    now: 1000,
  })
  assert.equal(result.target, 'tailcat')
})

test('手动顺序第一条不可用时让位给第二条', () => {
  const result = decide({
    config: baseConfig({ mode: 'manual', order: ['tailcat', 'lan', 'tailscale', 'relay'] }),
    measurements: { lan: ch(10), tailscale: ch(15), tailcat: { ok: false, rttMs: null, fails: 5 }, relay: ch(null) },
    prev: {},
    context: ctxBase,
    now: 1000,
  })
  assert.equal(result.target, 'lan')
})

test('局域网还没被手机用过时不敢关直连隧道', () => {
  const actions = buildActions({
    config: baseConfig({ allowDisableTailcat: true }),
    target: 'lan',
    measurements: { lan: ch(10) },
    context: { ...ctxBase, deviceLastChannel: 'tailcat', lanSeenByPhone: false },
  })
  const tailcat = actions.find(action => action.kind === 'tailcat')
  assert.equal(tailcat.enabled, true)
  assert.ok(actions.some(action => action.kind === 'note'))
})

test('局域网被手机用过且健康时关闭直连隧道', () => {
  const actions = buildActions({
    config: baseConfig({ allowDisableTailcat: true }),
    target: 'lan',
    measurements: { lan: ch(10) },
    context: ctxBase,
  })
  const tailcat = actions.find(action => action.kind === 'tailcat')
  assert.equal(tailcat.enabled, false)
})

test('选 Tailscale 时把它写成手填直连地址', () => {
  const actions = buildActions({
    config: baseConfig(),
    target: 'tailscale',
    measurements: { tailscale: ch(12) },
    context: ctxBase,
  })
  const direct = actions.find(action => action.kind === 'manualLanUrl')
  assert.equal(direct.value, 'http://100.64.26.27:18787')
})

test('配置归一：坏值被挡成默认值，顺序缺项补全', () => {
  const config = normalizeConfig({ mode: 'nope', order: ['lan', 'lan', 'bogus'], thresholds: { lan: { degradeMs: -5 } }, intervalMs: 'abc' })
  assert.equal(config.mode, 'lan-first')
  assert.deepEqual(config.order, ['lan', 'lan-ts', 'tailscale', 'tailcat', 'relay'])
  assert.equal(config.thresholds.lan.degradeMs, 1)
  assert.equal(config.intervalMs, 4000)
})

test('局域网恢复后从隧道抢回来（局域网优先不能只在降级时生效）', () => {
  const result = decide({
    config: baseConfig({ mode: 'lan-first' }),
    measurements: { lan: ch(8), tailscale: ch(30), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: { current: 'tailcat', softFails: 0, switchedAt: 0 },
    context: ctxBase,
    now: 10_000,
  })
  assert.equal(result.target, 'lan')
  assert.match(result.reason, /抢回/)
})

test('刚到新通道的驻留时间内不来回跳', () => {
  const result = decide({
    config: baseConfig({ mode: 'lan-first', intervalMs: 4000 }),
    measurements: { lan: ch(8), tailscale: ch(30), tailcat: { ok: true, rttMs: null, fails: 0 }, relay: ch(null) },
    prev: { current: 'tailcat', softFails: 0, switchedAt: 9900 },
    context: ctxBase,
    now: 10_000,
  })
  assert.equal(result.target, 'tailcat')
})

test('入口近期崩过时不关隧道（先保住兜底）', () => {
  const actions = buildActions({
    config: baseConfig({ allowDisableTailcat: true }),
    target: 'lan',
    measurements: { lan: ch(10) },
    context: { ...ctxBase, entryUnstable: true },
  })
  assert.equal(actions.find(a => a.kind === 'tailcat').enabled, true)
  assert.ok(actions.some(a => a.kind === 'note' && /入口近期崩过/.test(a.value)))
})

test('局域网优先时收掉指向 Tailscale 的手填 TCP 直连', () => {
  const actions = buildActions({
    config: baseConfig(),
    target: 'lan',
    measurements: { lan: ch(10) },
    context: { ...ctxBase, manualTcpUrl: '100.64.26.27:18787' },
  })
  assert.ok(actions.some(a => a.kind === 'manualTcpUrl' && a.value === ''))
})

test('非 Tailscale 的手填 TCP 直连不动', () => {
  const actions = buildActions({
    config: baseConfig(),
    target: 'lan',
    measurements: { lan: ch(10) },
    context: { ...ctxBase, manualTcpUrl: 'relay.example.com:7000' },
  })
  assert.equal(actions.some(a => a.kind === 'manualTcpUrl'), false)
})

test('RTT 未知但连得上的隧道算健康', () => {
  assert.equal(isHealthy('tailcat', { ok: true, rttMs: null }, baseConfig().thresholds), true)
})

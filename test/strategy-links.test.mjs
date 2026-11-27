import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../lib/config.js'
import { decide, scoreLink, buildActions } from '../lib/strategy.js'
import { createChannelState, foldProbe } from '../lib/probe.js'

const cfg = (patch = {}) => normalizeConfig({ intervalMs: 1000, ...patch })
const ch = (rttMs, extra = {}) => ({ ...createChannelState(), ok: rttMs !== null, rttMs, avgMs: rttMs, probes: 10, okCount: 10, ...extra })

const links = [
  { id: 'lan:192.168.1.2', group: 'lan', field: '', url: 'http://192.168.1.2:18787', address: '192.168.1.2' },
  { id: 'lan:10.0.0.8', group: 'lan', field: '', url: 'http://10.0.0.8:18787', address: '10.0.0.8' },
  { id: 'lants:100.64.1.2', group: 'lan-ts', field: '', url: 'http://100.64.1.2:18787', address: '100.64.1.2', viaField: 'manualLanUrl' },
  { id: 'ts:100.64.1.2', group: 'tailscale', field: '', url: 'http://100.64.1.2:18787', address: '100.64.1.2' },
  { id: 'manual:lanUrl', group: 'manual', field: 'manualLanUrl', url: 'http://tunnel.example.com:8443', address: 'tunnel.example.com' },
  { id: 'tailcat', group: 'tailcat', field: '', url: '' },
  { id: 'relay', group: 'relay', field: '', url: '' },
]
const ctx = { links, lanAddress: '192.168.1.2', tailscaleAddress: '100.64.1.2', lanPort: 18787, deviceLastChannel: 'lan', lanSeenByPhone: true }

test('手动：单选只认选中的那条链路', () => {
  const m = {
    'lan:192.168.1.2': ch(50), 'lan:10.0.0.8': ch(12),
    'lants:100.64.1.2': ch(9), 'manual:lanUrl': ch(30), tailcat: ch(null), relay: ch(null),
  }
  const result = decide({
    config: cfg({ mode: 'manual', selection: ['lants:100.64.1.2'] }),
    measurements: m, prev: {}, context: ctx, now: 1000,
  })
  assert.equal(result.target, 'lants:100.64.1.2')
})

test('手动：多选按排序挑第一条可用的', () => {
  const m = {
    'lan:192.168.1.2': ch(50), 'lan:10.0.0.8': ch(12),
    'lants:100.64.1.2': ch(null), 'manual:lanUrl': ch(30), tailcat: ch(null), relay: ch(null),
  }
  const result = decide({
    config: cfg({ mode: 'manual', selection: ['lants:100.64.1.2', 'manual:lanUrl', 'lan:10.0.0.8'] }),
    measurements: m, prev: {}, context: ctx, now: 1000,
  })
  assert.equal(result.target, 'manual:lanUrl')
})

test('lan-first：多条局域网链路里挑 RTT 最低的那条', () => {
  const m = {
    'lan:192.168.1.2': ch(50), 'lan:10.0.0.8': ch(12),
    'lants:100.64.1.2': ch(9), 'manual:lanUrl': ch(30), tailcat: ch(null), relay: ch(null),
  }
  const result = decide({ config: cfg({ mode: 'lan-first' }), measurements: m, prev: {}, context: ctx, now: 1000 })
  assert.equal(result.target, 'lan:10.0.0.8')
})

test('lants: 走 manualLanUrl，且保持 DSH 隧道开启（两条线路分开）', () => {
  const actions = buildActions({ config: cfg(), target: 'lants:100.64.1.2', measurements: {}, context: ctx })
  assert.ok(actions.some(a => a.kind === 'manualLanUrl' && a.value === 'http://100.64.1.2:18787'))
  assert.ok(actions.some(a => a.kind === 'preferredLanAddress' && a.value === ''))
  // 关键：选 Tailscale 网卡线路时不能像选 RFC1918 局域网那样关掉 DSH 隧道
  const tailcat = actions.find(a => a.kind === 'tailcat')
  assert.ok(tailcat && tailcat.enabled === true)
  assert.ok(actions.some(a => a.kind === 'manualIpv4Url' && a.value === ''))
})

test('auto：稳定性差的快链路输给稳定的稍慢链路', () => {
  const fastUnstable = ch(8, { avgMs: 8, jitterMs: 60, probes: 20, okCount: 10 }) // 50% 可用、大抖动
  const slowStable = ch(25, { avgMs: 25, jitterMs: 1, probes: 20, okCount: 20 })
  const policy = cfg({ mode: 'auto' }).autoPolicy
  assert.ok(scoreLink('lan:slow', slowStable, cfg().thresholds, policy) > scoreLink('lan:fast', fastUnstable, cfg().thresholds, policy))
})

test('auto：切换优势阈值拦住微小提升', () => {
  const m = {
    'lan:192.168.1.2': ch(20, { avgMs: 20, probes: 10, okCount: 10 }),
    'lan:10.0.0.8': ch(19, { avgMs: 19, probes: 10, okCount: 10 }),
  }
  const result = decide({
    config: cfg({ mode: 'auto', autoPolicy: { switchRatio: 0.5 } }),
    measurements: m, prev: { current: 'lan:192.168.1.2', switchedAt: 0, softFails: 0 }, context: ctx, now: 10000,
  })
  assert.equal(result.target, 'lan:192.168.1.2')
})

test('auto：10 分钟内被切太多次的链路被限抖拉黑', () => {
  const m = {
    'lan:192.168.1.2': ch(20, { avgMs: 20 }),
    'lan:10.0.0.8': ch(5, { avgMs: 5 }),
  }
  const result = decide({
    config: cfg({ mode: 'auto', autoPolicy: { maxFlapPer10m: 2 } }),
    measurements: m,
    prev: { current: 'lan:192.168.1.2', softFails: 0, switchedAt: 0, switches: { 'lan:10.0.0.8': [1000, 2000, 3000] } },
    context: ctx, now: 10000,
  })
  assert.equal(result.target, 'lan:192.168.1.2')
})

test('动作翻译：lan:<addr> 写 preferredLanAddress', () => {
  const actions = buildActions({ config: cfg(), target: 'lan:192.168.1.2', measurements: {}, context: ctx })
  assert.ok(actions.some(a => a.kind === 'preferredLanAddress' && a.value === '192.168.1.2'))
})

test('动作翻译：manual:<field> 只回写自己的字段', () => {
  const actions = buildActions({ config: cfg(), target: 'manual:lanUrl', measurements: {}, context: ctx })
  assert.ok(actions.some(a => a.kind === 'manualLanUrl' && a.value === 'http://tunnel.example.com:8443'))
  assert.ok(actions.some(a => a.kind === 'manualIpv4Url' && a.value === ''))
})

test('探测折叠维护稳定性指标', () => {
  let s = createChannelState()
  s = foldProbe(s, { ok: true, rttMs: 20 }, 1000)
  s = foldProbe(s, { ok: true, rttMs: 30 }, 2000)
  s = foldProbe(s, { ok: false, error: 'timeout' }, 3000)
  assert.equal(s.probes, 3)
  assert.equal(s.okCount, 2)
  assert.equal(s.fails, 1)
  assert.ok(s.avgMs > 0 && s.jitterMs >= 0)
})

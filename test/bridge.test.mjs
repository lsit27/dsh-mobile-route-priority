import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readRelayConfig, dshHome, summarizeDevices, phoneRecentlyOnLan } from '../lib/bridge.js'

test('readRelayConfig 读取全部五个手填/优先字段（回归：此前漏读 ipv4/ipv6）', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(dshHome(), home)
    writeFileSync(join(home, 'relay.json'), JSON.stringify({
      manualTcpUrl: '  tcp.example:7000  ',
      manualLanUrl: 'http://lan.example:18787',
      manualIpv4Url: 'http://1.2.3.4:18787',
      manualIpv6Url: 'http://[240e::1]:18787',
      preferredLanAddress: '10.0.0.5',
    }))
    const cfg = readRelayConfig()
    assert.equal(cfg.manualTcpUrl, 'tcp.example:7000')
    assert.equal(cfg.manualLanUrl, 'http://lan.example:18787')
    assert.equal(cfg.manualIpv4Url, 'http://1.2.3.4:18787')
    assert.equal(cfg.manualIpv6Url, 'http://[240e::1]:18787')
    assert.equal(cfg.preferredLanAddress, '10.0.0.5')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('readRelayConfig 文件缺失时返回全字段空串', () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const cfg = readRelayConfig()
    assert.deepEqual(Object.keys(cfg).sort(), ['manualIpv4Url', 'manualIpv6Url', 'manualLanUrl', 'manualTcpUrl', 'preferredLanAddress'])
    assert.ok(Object.values(cfg).every(v => v === ''))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('summarizeDevices 过滤吊销设备，phoneRecentlyOnLan 判近 10 分钟 LAN', () => {
  const now = Date.now()
  const rows = summarizeDevices([
    { deviceId: 'a', lastChannel: 'lan', lastSeenAt: now - 1000 },
    { deviceId: 'b', lastChannel: 'lan', lastSeenAt: now - 11 * 60 * 1000, revokedAt: 1 },
  ])
  assert.equal(rows.length, 1)
  assert.equal(phoneRecentlyOnLan(rows), true)
  assert.equal(phoneRecentlyOnLan([{ lastChannel: 'ipv6', lastSeenAt: now }]), false)
})

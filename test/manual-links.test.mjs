// 手填链路端到端回归（用现场采集的真实历史值固化）。
//
// 覆盖"遗留问题3"要求的四件事里的三项纯逻辑部分：
//   - readRelayConfig 五字段读取（bridge.test.mjs 亦有覆盖）
//   - discoverLinks 生成 4 条 manual:* 链路
//   - 策略层选中 manual:* 时只回写对应字段
// 第四项"面板显示这些链路卡片"由 DOM 桩在验证阶段执行，见验证报告。
import test from 'node:test'
import assert from 'node:assert/strict'

import { discoverLinks } from '../lib/links.js'
import { normalizeConfig } from '../lib/config.js'
import { buildActions } from '../lib/strategy.js'

// 现场历史值（来自 relay.json 采集与网卡探测记录），只用于构造测试对象，不写生产配置。
const HISTORICAL = {
  preferredLanAddress: '10.19.9.3',
  manualLanUrl: 'http://10.19.9.154:18787',       // 手填局域网对手地址
  manualIpv4Url: 'http://10.19.9.3:18787',
  manualIpv6Url: 'http://[240e:3bb:2cc0:bae0:f290:24fc:50cc:a56]:18787',
  manualTcpUrl: '10.19.9.3:18787',
}

test('历史值：discoverLinks 生成 4 条 manual:* 链路，字段与 URL 正确', () => {
  const links = discoverLinks(undefined, { relayConfig: HISTORICAL, port: 18787 }).manual
  assert.equal(links.length, 4)
  const byId = Object.fromEntries(links.map(l => [l.id, l]))
  assert.equal(byId['manual:lanUrl'].url, 'http://10.19.9.154:18787')
  assert.equal(byId['manual:lanUrl'].address, '10.19.9.154')
  assert.equal(byId['manual:ipv4'].address, '10.19.9.3')
  assert.equal(byId['manual:ipv6'].address, '240e:3bb:2cc0:bae0:f290:24fc:50cc:a56')
  assert.equal(byId['manual:tcp'].url, 'http://10.19.9.3:18787') // 裸 host:port 补 http://
  for (const l of links) assert.equal(l.source, 'plugin-config')
})

test('历史值：选中每条 manual:* 只回写自己占用的字段', () => {
  const links = discoverLinks(undefined, { relayConfig: HISTORICAL, port: 18787 }).manual
  const writeFields = ['manualLanUrl', 'manualIpv4Url', 'manualIpv6Url', 'manualTcpUrl']
  for (const target of ['manual:lanUrl', 'manual:ipv4', 'manual:ipv6', 'manual:tcp']) {
    const link = links.find(l => l.id === target)
    const actions = buildActions({
      config: normalizeConfig({ mode: 'manual', selection: [target] }),
      target,
      measurements: {},
      context: { links, lanPort: 18787 },
    })
    const written = actions.filter(a => writeFields.includes(a.kind) && a.value !== '')
    assert.equal(written.length, 1, `${target} 应只写一个字段`)
    assert.equal(written[0].kind, link.viaField, `${target} 应写 ${link.viaField}`)
    assert.equal(written[0].value, link.url, `${target} 应回写自己的 URL`)
  }
})

test('历史值：lan-ts 与 manual:lanUrl 共用 manualLanUrl 的冲突提示不丢失', () => {
  // 两条链路 viaField 都是 manualLanUrl —— 这是已知冲突，UI 已显著提示。
  const links = discoverLinks(undefined, { relayConfig: HISTORICAL, port: 18787 })
  const lants = links.lants.find(l => l.group === 'lan-ts')
  const manualLan = links.manual.find(l => l.id === 'manual:lanUrl')
  assert.equal(lants.viaField, 'manualLanUrl')
  assert.equal(manualLan.viaField, 'manualLanUrl')
})

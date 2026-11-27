import test from 'node:test'
import assert from 'node:assert/strict'

import { discoverLinks, isLanAddress, isTailscaleAddress, isVirtualInterface, manualLinks } from '../lib/links.js'

const ifaces = (spec) => Object.fromEntries(spec.map(([name, addresses]) => [name, addresses.map(address => ({ address, family: 'IPv4', internal: false }))]))

test('局域网地址判定只认 RFC1918 三段', () => {
  assert.equal(isLanAddress('10.19.9.3'), true)
  assert.equal(isLanAddress('192.168.1.5'), true)
  assert.equal(isLanAddress('172.20.0.1'), true)
  assert.equal(isLanAddress('100.64.19.3'), false)
  assert.equal(isLanAddress('8.8.8.8'), false)
  assert.equal(isLanAddress('169.254.1.1'), false)
})

test('Tailscale 只认 100.64/10', () => {
  assert.equal(isTailscaleAddress('100.64.19.3'), true)
  assert.equal(isTailscaleAddress('100.127.255.255'), true)
  assert.equal(isTailscaleAddress('100.128.0.1'), false)
})

test('虚拟网卡按名字挡，不按地址段挡', () => {
  assert.equal(isVirtualInterface('br-c77c19da8cae'), true)
  assert.equal(isVirtualInterface('docker0'), true)
  assert.equal(isVirtualInterface('bond1-ovs'), false)
  assert.equal(isVirtualInterface('en0'), false)
})

test('多网卡多 IP：全部枚举为局域网链路，物理网卡按接口优先级排序', () => {
  const links = discoverLinks(ifaces([
    ['br-c77c19da8cae', ['172.20.0.1']],       // Docker 网桥，应被挡
    ['bond1-ovs', ['10.19.9.3']],              // 真局域网（bond 类接口 rank 3）
    ['wlan0', ['192.168.1.20', '192.168.1.21']], // Wi-Fi rank 2，排在 bond 前
    ['tailscale0', ['100.64.19.3']],
    ['lo', ['127.0.0.1']],
  ]), { port: 18787 })
  // Wi-Fi 排在 bond 之前，与 dsh-mobile-plugin 的 interfaceRank 口径一致
  assert.deepEqual(links.lan.map(l => l.address), ['192.168.1.20', '192.168.1.21', '10.19.9.3'])
  assert.deepEqual(links.lan.map(l => l.id), ['lan:192.168.1.20', 'lan:192.168.1.21', 'lan:10.19.9.3'])
  assert.equal(links.lan.find(l => l.address === '10.19.9.3').url, 'http://10.19.9.3:18787')
  // 172.20.0.1 属于 Docker 网桥，不能当局域网链路
  assert.equal(links.lan.some(l => l.address === '172.20.0.1'), false)
})

test('Tailscale 网卡地址归为局域网内线路（lan-ts），与 DSH 隧道分开', () => {
  const links = discoverLinks(ifaces([
    ['bond1-ovs', ['10.19.9.3']],
    ['tailscale0', ['100.64.19.3']],
  ]))
  assert.deepEqual(links.lants.map(l => l.address), ['100.64.19.3'])
  assert.equal(links.lants[0].id, 'lants:100.64.19.3')
  assert.equal(links.lants[0].group, 'lan-ts')
  assert.equal(links.lants[0].viaField, 'manualLanUrl')
  assert.equal(links.flat.filter(l => l.group === 'lan-ts').length, 1)
  // DSH 隧道是固定链路，是另一条线路，不与 lants 合并
  assert.equal(links.flat.some(l => l.id === 'tailcat'), false) // 隧道由 FIXED_LINKS 提供
  assert.equal(links.lan.some(l => l.address === '100.64.19.3'), false) // 不混进 RFC1918 局域网组
})

test('插件手填链路与局域网重名也单独一条、来源隔离', () => {
  const relay = { manualLanUrl: 'http://10.19.9.3:18787', manualTcpUrl: 'relay.example.com:7000', manualIpv4Url: '', manualIpv6Url: '' }
  const links = discoverLinks(ifaces([['bond1-ovs', ['10.19.9.3']]]), { relayConfig: relay })
  const lan = links.flat.find(l => l.group === 'lan' && l.address === '10.19.9.3')
  const manual = links.flat.find(l => l.id === 'manual:lanUrl')
  assert.ok(lan && manual)
  assert.equal(lan.source, 'nic')
  assert.equal(manual.source, 'plugin-config')
  assert.equal(manual.address, '10.19.9.3') // 同地址，但来源与 id 不同
  assert.notEqual(lan.id, manual.id)
})

test('手填链路支持四类字段', () => {
  const relay = {
    manualLanUrl: 'http://tunnel.example.com:8443',
    manualIpv4Url: 'http://1.2.3.4:18787',
    manualIpv6Url: 'http://[240e::1]:18787',
    manualTcpUrl: 'tcp.example.com:7000',
  }
  const links = manualLinks(relay)
  assert.deepEqual(links.map(l => l.id), ['manual:lanUrl', 'manual:ipv4', 'manual:ipv6', 'manual:tcp'])
  assert.equal(links.find(l => l.id === 'manual:tcp').url, 'http://tcp.example.com:7000')
})

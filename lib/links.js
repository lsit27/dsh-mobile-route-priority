// 链路发现：把「这台电脑上手机能走的每一条路」枚举成带稳定 id 的清单。
//
// 判据刻意与 dsh-mobile-plugin 的 lib/relay/lan-network.cjs 对齐（那是它真正上报给手机的口径）：
//   - 局域网 = RFC1918 三段，且按「网卡名黑名单」挡掉容器/虚拟网卡，不按地址段挡
//     （172.17~31 可能是真实 Wi-Fi，反馈 1012 已经踩过一次坑）；
//   - Tailscale 网卡 = 100.64/10（如 tailscale0 的 100.64.19.3）属于**局域网内的一条线路**，
//     但它不是 RFC1918、dsh-mobile-plugin 不会自动上报，所以单独归到 lan-ts 组，通过
//     manualLanUrl 表达。它与 DSH 内置的 tailcat 隧道（走公网节点中转）是两条完全不同的线路，
//     不能合并——用户明确要求分开；
//   - 手填链路（manualLanUrl/manualIpv4Url/manualTcpUrl/manualIpv6Url）是用户在 dsh-mobile-plugin
//     里单独配置的，即使地址和某条局域网链路长得一样，也必须单独占一条 —— 两类来源不同，
//     手机端走的通道也不同，不能合并。
//
// 字段冲突：lan-ts 与手填链路里的 manual:lanUrl 都占用 manualLanUrl，两者不能同时生效；
// 面板上会明确提示。
//
// 这个模块不探测、不决策，只回答「有哪些链路、分别叫什么」。
'use strict'

import os from 'node:os'

/** IPv4 文本 → 32 位无符号整数；非法回 null。 */
export function ipv4Number(address) {
  const text = String(address == null ? '' : address)
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return (((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3]) >>> 0
}

const inRange = (value, start, end) => value >= start && value <= end

/** RFC1918 三段：10/8、172.16/12、192.168/16。与 dsh-mobile-plugin 的 isLanCandidateAddress 一致。 */
export function isLanAddress(address) {
  const value = ipv4Number(address)
  if (value === null) return false
  return inRange(value, 0x0a000000, 0x0affffff)
    || inRange(value, 0xac100000, 0xac1fffff)
    || inRange(value, 0xc0a80000, 0xc0a8ffff)
}

/** Tailscale / CGNAT：100.64/10。 */
export function isTailscaleAddress(address) {
  const value = ipv4Number(address)
  return value !== null && inRange(value, 0x64400000, 0x647fffff)
}

// 容器桥、虚拟机、overlay：这些网卡上的 RFC1918 地址手机在局域网里拨不通。
const VIRTUAL_INTERFACE = /^(?:docker|br-|veth|virbr|vmnet|vboxnet|vbox|vnic|vEthernet|Hyper-V|Default Switch|zt|nebula|ham\d|llw\d|awdl\d|safeline|cni|lxcbr|podman|flannel|cali|kube)/i
const VPN_INTERFACE = /^(?:utun|tun|tap|ppp|ipsec|wg|tailscale|vpn|zt|nebula)/i

export function isVirtualInterface(name) {
  return VIRTUAL_INTERFACE.test(String(name || ''))
}
export function isVpnInterface(name) {
  return VPN_INTERFACE.test(String(name || ''))
}

/** 物理网卡优先排序：以太网 > macOS en > Wi-Fi > 其它。 */
export function interfaceRank(name) {
  const n = String(name || '')
  if (/^(?:eth\d+$|enp\ds?\d*$|ens\d|eno\d|enx)/i.test(n)) return 0
  if (/^en\d+$/i.test(n)) return 1
  if (/^(?:wl|wlan)/i.test(n)) return 2
  return 3
}

const MAX_PER_GROUP = 16

/**
 * 扫网卡，按 accept 过滤 IPv4 端点。与 dsh-mobile-plugin 的 collectEndpoints 同口径：
 * 跳过 virtual/vpn 网卡、跳过 internal、按网卡名排序、按地址去重、最多 16 条。
 */
function collect(interfaces, accept) {
  const found = []
  let order = 0
  for (const [name, entries] of Object.entries(interfaces || {})) {
    const current = order++
    if (isVpnInterface(name) || isVirtualInterface(name)) continue
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue
      const family = entry.family
      if (family !== 'IPv4' && family !== 4) continue
      if (!accept(entry.address)) continue
      found.push({ name, address: entry.address, order: current })
    }
  }
  const seen = new Set()
  return found
    .sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name) || a.order - b.order)
    .filter(item => {
      if (seen.has(item.address)) return false
      seen.add(item.address)
      return true
    })
    .slice(0, MAX_PER_GROUP)
}

/**
 * Tailscale 单独扫：它挂在 VPN 虚拟网卡上，会被上面的黑名单挡掉，所以这里不套黑名单，
 * 只按 100.64/10 找地址（与本机是否有 Tailscale 网卡无关）。
 */
function collectTailscale(interfaces) {
  const found = []
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue
      const family = entry.family
      if (family !== 'IPv4' && family !== 4) continue
      if (!isTailscaleAddress(entry.address)) continue
      if (!found.some(item => item.address === entry.address)) {
        found.push({ name, address: entry.address })
      }
    }
  }
  return found.slice(0, MAX_PER_GROUP)
}

/**
 * 从 dsh-mobile-plugin 的落盘配置里读「用户单独配置的链路」。
 * 这四类字段在 dsh-mobile-plugin 里是独立于网卡枚举的直连通道，地址即使和局域网重名也不是一回事。
 * @param {object} relayConfig readRelayConfig() 的结果（或其扩展）
 * @param {number} port 局域网端口，用来给裸 host 补 URL
 */
export function manualLinks(relayConfig = {}, port = 18787) {
  const src = relayConfig && typeof relayConfig === 'object' ? relayConfig : {}
  const links = []
  const add = (key, field, value, kind) => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return
    // 已经有 scheme 的原样用；裸 host:port 补 http://。
    const url = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw}`
    links.push({
      id: `manual:${key}`,
      field,
      kind,                 // lan-url | ipv4 | tcp | ipv6 —— UI 展示用
      address: hostOf(url),
      url,
      interface: `plugin-config:${field}`,
      source: 'plugin-config',
      viaField: field,      // 这条手填链路占用的 dsh-mobile-plugin 字段
    })
  }
  add('lanUrl', 'manualLanUrl', src.manualLanUrl, 'lan-url')
  add('ipv4', 'manualIpv4Url', src.manualIpv4Url, 'ipv4')
  add('ipv6', 'manualIpv6Url', src.manualIpv6Url, 'ipv6')
  add('tcp', 'manualTcpUrl', src.manualTcpUrl, 'tcp')
  return links
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return ''
  }
}

/**
 * 枚举所有链路。返回：
 *   lan        - 网卡枚举的局域网链路（多条，物理网卡优先，RFC1918）
 *   lants      - Tailscale 网卡的局域网链路（100.64/10，单独一组，通过 manualLanUrl 表达）
 *   manual     - 插件里单独配置的链路（与上面两类分开）
 *   flat       - 扁平清单，每项带 group 字段，UI 与策略层共用
 *
 * @param {object} interfaces os.networkInterfaces() 的形状，可注入测试
 * @param {object} opts { relayConfig, port }
 */
export function discoverLinks(interfaces = os.networkInterfaces(), opts = {}) {
  const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : 18787
  const lan = collect(interfaces, isLanAddress).map(item => ({
    id: `lan:${item.address}`,
    group: 'lan',
    source: 'nic',
    address: item.address,
    interface: item.name,
    url: `http://${item.address}:${port}`,
  }))
  // 100.64/10 网卡地址：局域网内的一条线路，但 dsh-mobile-plugin 不自动上报（它只认 RFC1918），
  // 所以单独成组、通过 manualLanUrl 表达。与 DSH 内置 tailcat 隧道是两条独立线路。
  const lants = collectTailscale(interfaces).map(item => ({
    id: `lants:${item.address}`,
    group: 'lan-ts',
    source: 'nic',
    address: item.address,
    interface: item.name,
    url: `http://${item.address}:${port}`,
    viaField: 'manualLanUrl', // 这条线路写进 dsh-mobile-plugin 的字段
  }))
  const manual = manualLinks(opts.relayConfig, port).map(item => ({ ...item, group: 'manual' }))
  return { lan, lants, manual, flat: [...lan, ...lants, ...manual] }
}

/** 固定链路（隧道、中转）的 id —— 与动态链路共用一套优先级表达。 */
export const FIXED_LINKS = [
  { id: 'tailcat', group: 'tailcat', source: 'builtin', name: '直连隧道' },
  { id: 'relay', group: 'relay', source: 'builtin', name: '中转' },
]

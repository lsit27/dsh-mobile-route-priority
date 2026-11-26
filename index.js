// dsh-mobile-route-priority —— 给 dsh-mobile-plugin 加一层「选路控制器」。
//
// 为什么要单独一个插件：手机端 App 的通道顺序是它自己决定的，电脑侧唯一能施加影响的三处是
// 「局域网优先地址」「手填直连地址」「直连隧道开关」。把这三处按时延实测结果编排起来，
// 就能把「明明在局域网却绕到隧道」这件事按住不放。
//
// 这个文件只做装配：状态、定时器、路由。决策在 lib/strategy.js（纯函数），
// 探测在 lib/probe.js，与 dsh-mobile-plugin 的交互在 lib/bridge.js。
'use strict'

import os from 'node:os'
import { normalizeConfig, CHANNELS, MODES } from './lib/config.js'
import { probeHttp, createChannelState, foldProbe } from './lib/probe.js'
import { decide, isHealthy } from './lib/strategy.js'
import { fetchRelayStatus, patchRelayConfig, setTailcatEnabled, restartSidecar, readDevices, phoneRecentlyOnLan, readRelayConfig } from './lib/bridge.js'
import { PANEL_HTML } from './lib/panel.js'

export const name = 'dsh-mobile-route-priority'
export const inject = ['webServer']

const PANEL_PATH = '/api/mobile-route/panel'
const STATE_PATH = '/api/mobile-route/state'
const CONFIG_PATH = '/api/mobile-route/config'
const ACTION_PATH = '/api/mobile-route/action'

const LAN_PREFIXES = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]
const isPrivateV4 = ip => LAN_PREFIXES.some(re => re.test(ip))
const isTailscaleV4 = ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
const isUsableV4 = ip => typeof ip === 'string' && !ip.startsWith('127.') && !ip.startsWith('169.254.')

/** 从本机网卡里挑出两类地址：局域网一个、Tailscale 一个。 */
export function discoverAddresses(interfaces = os.networkInterfaces()) {
  let lan = ''
  let tailscale = ''
  for (const [adapter, rows] of Object.entries(interfaces)) {
    for (const row of rows || []) {
      if (row.family !== 'IPv4' || row.internal) continue
      if (!isUsableV4(row.address)) continue
      if (isTailscaleV4(row.address)) { tailscale = tailscale || row.address; continue }
      // 以太网优先于虚拟网卡：走真线的那块更可能和手机同网段。
      if (isPrivateV4(row.address)) {
        const virtual = /vethernet|vmware|virtualbox|hyper-v|docker|wsl|loopback/i.test(adapter)
        if (!lan || (!virtual && /ethernet|以太网|wlan|wi-fi|wireless/i.test(adapter))) lan = row.address
      }
    }
  }
  return { lan, tailscale }
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store' })
  res.end(payload)
}

function html(res, status, body) {
  const payload = Buffer.from(body)
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store' })
  res.end(payload)
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      raw += chunk
      if (raw.length > limit) { reject(new Error('请求体过大')); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, rawConfig = {}) {
  const log = (level, message, ...rest) => {
    try { ctx.logger?.[level]?.(`[route-priority] ${message}`, ...rest) } catch { /* 日志不能反过来弄挂插件 */ }
  }

  const state = {
    config: normalizeConfig(rawConfig),
    channels: { lan: createChannelState(), tailscale: createChannelState(), tailcat: createChannelState(), relay: createChannelState() },
    decision: { target: null, reason: '尚未开始探测', actions: [], warnings: [] },
    prev: {},
    history: [],
    devices: [],
    relay: null,
    addresses: { lan: '', tailscale: '' },
    lastProbeAt: 0,
    lastError: '',
    lastHealAt: 0,
    // 入口稳定性：一次自愈之后的一段时间内都算「不稳」，此时不关隧道。
    // 局域网刚崩过就断掉唯一的兜底，等于把手机扔进黑洞。
    entry: { healCount: 0, lastHealAt: 0, unstableUntil: 0 },
    applied: {},
    startedAt: Date.now(),
  }

  const port = () => {
    try { return ctx.webServer?.port || 3080 } catch { return 3080 }
  }

  /** 一轮探测。tailcat 拨不了（需要隧道密钥），只能用插件报的 ready 当作可用。 */
  async function probeAll() {
    const relay = await fetchRelayStatus(port())
    state.relay = relay
    state.devices = readDevices()
    const addresses = discoverAddresses()
    state.addresses = addresses
    const lanPort = Number.isInteger(relay?.lan?.port) && relay.lan.port > 0 ? relay.lan.port : 18787
    const now = Date.now()

    const lanProbe = addresses.lan
      ? await probeHttp({ host: addresses.lan, port: lanPort, timeoutMs: state.config.probeTimeoutMs })
      : { ok: false, rttMs: null, status: null, error: 'no-lan-address' }
    state.channels.lan = foldProbe(state.channels.lan, lanProbe, now)

    const tsProbe = addresses.tailscale
      ? await probeHttp({ host: addresses.tailscale, port: lanPort, timeoutMs: state.config.probeTimeoutMs })
      : { ok: false, rttMs: null, status: null, error: 'no-tailscale-address' }
    state.channels.tailscale = foldProbe(state.channels.tailscale, tsProbe, now)

    // 直连隧道：不自己拨，读插件状态。`ready && running` 才算这条通道可用。
    const tailcat = relay?.tailcat
    const tailcatOk = Boolean(tailcat && tailcat.enabled !== false && tailcat.running && tailcat.ready)
    state.channels.tailcat = foldProbe(state.channels.tailcat, {
      ok: tailcatOk,
      rttMs: null, // 隧道时延归手机端测，电脑侧没有可比数据
      status: null,
      error: tailcatOk ? '' : (tailcat?.error || 'tailcat-not-ready'),
    }, now)

    // 中转：只有在插件里真的注册了一条中转地址时才算一条可选通道。
    const relayOk = Boolean(relay?.tunnel && relay.tunnel.state === 'connected' && relay.relayUrl)
    state.channels.relay = foldProbe(state.channels.relay, {
      ok: relayOk,
      rttMs: null,
      status: null,
      error: relayOk ? '' : 'relay-not-registered',
    }, now)

    state.lastProbeAt = now

    const relayConfig = readRelayConfig()
    const lanSeenByPhone = phoneRecentlyOnLan(state.devices)
    state.decision = decide({
      config: state.config,
      measurements: state.channels,
      prev: state.prev,
      context: {
        lanAddress: addresses.lan,
        tailscaleAddress: addresses.tailscale,
        lanPort,
        deviceLastChannel: state.devices[0]?.lastChannel || '',
        lanSeenByPhone,
        manualTcpUrl: relayConfig.manualTcpUrl,
        entryUnstable: now < state.entry.unstableUntil,
      },
      now,
    })
    state.prev = state.decision.prev
    pushHistory({ kind: 'probe', target: state.decision.target, reason: state.decision.reason })
  }

  /** 关掉局域网入口的状态能让 sidecar 自愈，但限频：一场事故里每 4 秒重启一次只会更糟。 */
  async function healIfNeeded() {
    if (!state.config.autoHealSidecar) return
    const lanState = state.relay?.lan?.state
    if (lanState === 'listening') return
    if (Date.now() - state.lastHealAt < state.config.healCooldownMs) return
    state.lastHealAt = Date.now()
    try {
      const result = await restartSidecar(port())
      markEntryUnstable(`局域网入口重启：${result?.after?.lan?.state || 'unknown'}`)
      log('warn', 'sidecar 已尝试重启：%s', result?.after?.state || 'unknown')
    } catch (error) {
      markEntryUnstable(`局域网入口重启失败：${error?.message || error}`)
      state.lastError = String(error?.message || error)
      log('warn', 'sidecar 重启失败：%s', state.lastError)
    }
  }

  /** 一次自愈之后 10 分钟内都算「入口不稳」：这段时间不关隧道，先让它自己缓过来。 */
  function markEntryUnstable(reason) {
    const now = Date.now()
    state.entry.healCount += 1
    state.entry.lastHealAt = now
    state.entry.unstableUntil = now + 10 * 60 * 1000
    pushHistory({ kind: 'heal', reason })
  }

  /** 把决策翻译成实际动作。只下发与已应用值不同的项，减少对插件的无谓写入。 */
  async function applyDecision() {
    if (state.config.dryRun) return
    const actions = state.decision.actions || []
    const patch = {}
    for (const action of actions) {
      if (action.kind === 'preferredLanAddress' && state.applied.preferredLanAddress !== action.value) {
        patch.preferredLanAddress = action.value
        state.applied.preferredLanAddress = action.value
      }
      if (action.kind === 'manualLanUrl' && state.applied.manualLanUrl !== action.value) {
        patch.manualLanUrl = action.value
        state.applied.manualLanUrl = action.value
      }
      if (action.kind === 'manualTcpUrl' && state.applied.manualTcpUrl !== action.value) {
        patch.manualTcpUrl = action.value
        state.applied.manualTcpUrl = action.value
      }
      if (action.kind === 'tailcat' && state.applied.tailcat !== action.enabled) {
        try {
          await setTailcatEnabled(port(), action.enabled)
          state.applied.tailcat = action.enabled
          pushHistory({ kind: 'action', reason: `直连隧道 ${action.enabled ? '开启' : '关闭'}` })
        } catch (error) {
          log('warn', '切换直连隧道失败：%s', String(error?.message || error))
        }
      }
    }
    if (Object.keys(patch).length) {
      try {
        await patchRelayConfig(port(), patch)
        pushHistory({ kind: 'action', reason: `候选地址已更新：${JSON.stringify(patch)}` })
      } catch (error) {
        state.lastError = String(error?.message || error)
        log('warn', '写入候选地址失败：%s', state.lastError)
      }
    }
  }

  function pushHistory(entry) {
    state.history.unshift({ at: Date.now(), ...entry })
    if (state.history.length > 60) state.history.length = 60
  }

  async function tick() {
    try {
      await probeAll()
      await applyDecision()
      await healIfNeeded()
    } catch (error) {
      state.lastError = String(error?.message || error)
      log('warn', '一轮探测失败：%s', state.lastError)
    }
  }

  function snapshot() {
    return {
      ok: true,
      version: 1,
      config: state.config,
      addresses: state.addresses,
      channels: state.channels,
      decision: { target: state.decision.target, reason: state.decision.reason, warnings: state.decision.warnings || [] },
      applied: state.applied,
      devices: state.devices,
      history: state.history,
      entry: {
        healCount: state.entry.healCount,
        lastHealAt: state.entry.lastHealAt,
        unstable: Date.now() < state.entry.unstableUntil,
        unstableUntil: state.entry.unstableUntil,
      },
      relay: state.relay ? {
        lan: state.relay.lan,
        tunnel: state.relay.tunnel,
        tailcat: state.relay.tailcat,
        p2p: state.relay.p2p ? { path: state.relay.p2p.path, active: state.relay.p2p.active, error: state.relay.p2p.error } : null,
        relayUrl: state.relay.relayUrl || '',
        sidecar: state.relay.sidecar?.state || '',
      } : null,
      lastProbeAt: state.lastProbeAt,
      lastError: state.lastError,
      startedAt: state.startedAt,
      modes: MODES,
      channelsOrder: CHANNELS,
    }
  }

  async function saveConfig(patch) {
    const next = normalizeConfig({ ...state.config, ...patch })
    state.config = next
    // 持久化走 profile 的 configEditor：它会校验、串行写入，并且把「被上层覆盖」如实拒掉。
    // 编辑普通字段会让本插件重启一次，apply 会读到新配置——所以这里先把响应发出去。
    const entry = ctx.fiber?.entry
    const editor = (() => { try { return ctx.get('configEditor') } catch { return undefined } })()
    if (!entry || !editor) return { ok: true, persisted: false, config: next }
    try {
      await editor.edit(entry, current => ({ ...current, ...patch }))
      return { ok: true, persisted: true, config: next }
    } catch (error) {
      return { ok: false, persisted: false, config: next, message: String(error?.message || error) }
    }
  }

  ctx.effect(() => {
    let timer = null
    let disposed = false
    const run = async () => {
      if (disposed) return
      await tick()
      if (disposed) return
      timer = setTimeout(run, state.config.intervalMs)
    }
    void run()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, 'dsh-mobile-route-priority: probe loop')

  ctx.effect(() => {
    const routes = [
      { kind: 'exact', path: STATE_PATH, handler: (_req, res) => json(res, 200, snapshot()) },
      { kind: 'exact', path: PANEL_PATH, handler: (_req, res) => html(res, 200, PANEL_HTML) },
      { kind: 'exact', path: CONFIG_PATH, handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const result = await saveConfig(body)
          json(res, result.ok ? 200 : 400, { ...result, state: snapshot() })
        } catch (error) {
          json(res, 400, { ok: false, message: String(error?.message || error) })
        }
      } },
      { kind: 'exact', path: ACTION_PATH, handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const action = String(body?.action || '')
          if (action === 'probe') { await probeAll(); await applyDecision(); return json(res, 200, { ok: true, state: snapshot() }) }
          if (action === 'heal') { state.lastHealAt = 0; await healIfNeeded(); return json(res, 200, { ok: true, state: snapshot() }) }
          if (action === 'reset') {
            state.applied = {}
            state.prev = {}
            pushHistory({ kind: 'reset', reason: '手动重置应用状态' })
            return json(res, 200, { ok: true, state: snapshot() })
          }
          json(res, 400, { ok: false, message: `未知动作：${action || '(空)'}` })
        } catch (error) {
          json(res, 400, { ok: false, message: String(error?.message || error) })
        }
      } },
    ]
    const disposers = []
    for (const route of routes) {
      try { disposers.push(ctx.webServer.register(route)) } catch (error) {
        log('warn', '路由 %s 没挂上：%s', route.path, String(error?.message || error))
      }
    }
    return () => { for (const dispose of disposers) { try { dispose() } catch { /* 卸载失败不影响其它路由 */ } } }
  }, 'dsh-mobile-route-priority: routes')

  log('info', '已加载：模式 %s，面板 %s', state.config.mode, PANEL_PATH)
}

// 面板与 API 都挂在 webServer 上，路径与移动端插件的 `/api/relay/*` 刻意错开，
// 免得两个插件抢同一个前缀。
export const __internals = { discoverAddresses, isHealthy }

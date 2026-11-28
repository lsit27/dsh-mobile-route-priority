// dsh-mobile-route-priority —— 给 dsh-mobile-plugin 加一层「选路控制器」。
//
// 手机端 App 的通道顺序是它自己决定的，电脑侧唯一能施加影响的三处是
// 「局域网优先地址」「手填直连地址」「直连隧道开关」。把这三处按时延实测结果编排起来，
// 就能把「明明在局域网却绕到隧道」这件事按住不放。
//
// 这个文件只做装配：链路发现在 lib/links.js，状态/定时器/路由在下文，决策在 lib/strategy.js，
// 探测在 lib/probe.js，与 dsh-mobile-plugin 的交互在 lib/bridge.js。
'use strict'

import { normalizeConfig, CHANNELS, MODES } from './lib/config.js'
import { discoverLinks, FIXED_LINKS } from './lib/links.js'
import { probeHttp, createChannelState, foldProbe } from './lib/probe.js'
import { decide } from './lib/strategy.js'
import { lanEntryUnhealthy, watchdogCheck } from './lib/health.js'
import { ensureAutoUpdateDisabled, readAutoUpdate } from './lib/autoupdate.js'
import { restartNeeded, restartAllowed } from './lib/restart-guard.js'
import { fetchRelayStatus, patchRelayConfig, setTailcatEnabled, restartSidecar, readDevices, phoneRecentlyOnLan, readRelayConfig, dshHome } from './lib/bridge.js'
import { PANEL_HTML } from './lib/panel.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-mobile-route-priority'
export const inject = ['webServer']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESTART_HELPER = path.join(HERE, 'restart-helper.mjs')

// Two route families:
//   - `/dsh-mobile-route/*` is the PRIMARY one. The fnOS gateway only proxies
//     path prefixes it discovers from the webServer route table, and it
//     refuses `/api` outright (RESERVED_PREFIXES) — so a panel under `/api`
//     can never be reached through `http://<host>:5666/app/<name>/...`.
//     A dedicated top-level prefix is auto-discovered and proxied.
//   - `/api/mobile-route/*` stays for direct-port clients and old links.
// The panel resolves its own API base from `location.pathname`, so one page
// serves both families unchanged.
const ROUTE_FAMILIES = [
  { base: '/dsh-mobile-route', primary: true },
  { base: '/api/mobile-route', primary: false },
]
const PANEL_PATH = '/dsh-mobile-route/panel'
const STATE_PATH = '/dsh-mobile-route/state'
const CONFIG_PATH = '/dsh-mobile-route/config'
const ACTION_PATH = '/dsh-mobile-route/action'

/** 兼容旧调用方：返回单条 lan / Tailscale 网卡地址（现在每条链路都可能有多条）。 */
export function discoverAddresses(interfaces) {
  const links = discoverLinks(interfaces)
  return {
    lan: links.lan[0]?.address || '',
    tailscale: links.lants[0]?.address || '',
    lanList: links.lan,
    tailscaleList: links.lants,
  }
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
    channels: {},                 // key = 链路 id；值为 probe 状态 + 元信息
    decision: { target: null, reason: '尚未开始探测', actions: [], warnings: [] },
    prev: {},
    history: [],
    devices: [],
    relay: null,
    links: [],                    // 最新一次发现的链路清单（含 group / source）
    lastProbeAt: 0,
    lastError: '',
    lastHealAt: 0,
    // 入口稳定性：一次自愈之后的一段时间内都算「不稳」，此时不关隧道。
    entry: { healCount: 0, lastHealAt: 0, unstableUntil: 0 },
    // 看门狗：滑动窗口内的重启时间戳，超上限就暂停自动重启。
    watchdog: { restarts: [], trippedUntil: 0, trips: 0, lastReason: '' },
    // 自动重启守护：检测版本不一致/外壳换代，必要时自动重启 DSH 宿主。
    restartGuard: {
      restarts: [],           // 自动重启时间戳（24h 窗口）
      lastCheckAt: 0,
      lastResult: '未检查',
      pending: false,         // 已发起重启、等待进程被替换
      autoUpdateOff: false,   // 是否已关闭 dsh-mobile-plugin 自动更新
    },
    applied: {},
    startedAt: Date.now(),
  }

  const port = () => {
    try { return ctx.webServer?.port || 3080 } catch { return 3080 }
  }

  /** 一轮探测。tailcat/tailcat 类链路不自己拨，只能读插件报的 ready 当可用。 */
  async function probeAll() {
    const relay = await fetchRelayStatus(port())
    state.relay = relay
    state.devices = readDevices()
    const relayConfig = readRelayConfig()
    const lanPort = Number.isInteger(relay?.lan?.port) && relay.lan.port > 0 ? relay.lan.port : 18787
    const discovered = discoverLinks(undefined, { relayConfig, port: lanPort })
    const links = [...discovered.flat, ...FIXED_LINKS.map(f => ({ ...f, url: '' }))]
    state.links = links
    const now = Date.now()

    // 已发现链路里消失的清掉，避免面板上留僵尸行。
    const aliveIds = new Set(links.map(l => l.id))
    for (const key of Object.keys(state.channels)) {
      if (!aliveIds.has(key)) delete state.channels[key]
    }

    for (const link of links) {
      if (link.id === 'tailcat' || link.id === 'relay') continue
      let probe
      try {
        const target = new URL(link.url)
        probe = await probeHttp({ host: target.hostname, port: Number(target.port) || lanPort, timeoutMs: state.config.probeTimeoutMs })
      } catch {
        probe = { ok: false, rttMs: null, status: null, error: 'bad-link-url' }
      }
      const prev = state.channels[link.id] || createChannelState()
      state.channels[link.id] = { ...foldProbe(prev, probe, now), group: link.group, source: link.source, address: link.address || '', interface: link.interface || '' }
    }

    // 直连隧道：不自己拨，读插件状态。`ready && running` 才算这条通道可用。
    const tailcat = relay?.tailcat
    const tailcatOk = Boolean(tailcat && tailcat.enabled !== false && tailcat.running && tailcat.ready)
    state.channels.tailcat = { ...foldProbe(state.channels.tailcat || createChannelState(), {
      ok: tailcatOk,
      rttMs: null,
      status: null,
      error: tailcatOk ? '' : (tailcat?.error || 'tailcat-not-ready'),
    }, now), group: 'tailcat', source: 'builtin', address: '', interface: 'tailcat' }

    // 中转：只有插件里真的注册了中转地址时才算一条可选通道。
    const relayOk = Boolean(relay?.tunnel && relay.tunnel.state === 'connected' && relay.relayUrl)
    state.channels.relay = { ...foldProbe(state.channels.relay || createChannelState(), {
      ok: relayOk,
      rttMs: null,
      status: null,
      error: relayOk ? '' : 'relay-not-registered',
    }, now), group: 'relay', source: 'builtin', address: relay?.relayUrl || '', interface: 'relay' }

    state.lastProbeAt = now

    const lanSeenByPhone = phoneRecentlyOnLan(state.devices)
    const lanLink = links.find(l => l.group === 'lan')
    const tsLink = links.find(l => l.group === 'lan-ts') || links.find(l => l.group === 'tailscale')
    state.decision = decide({
      config: state.config,
      measurements: state.channels,
      prev: state.prev,
      context: {
        links,
        lanAddress: lanLink?.address || '',
        tailscaleAddress: tsLink?.address || '',
        lanPort,
        deviceLastChannel: state.devices[0]?.lastChannel || '',
        lanSeenByPhone,
        manualTcpUrl: relayConfig.manualTcpUrl,
        manualLanUrl: relayConfig.manualLanUrl,
        manualIpv4Url: relayConfig.manualIpv4Url,
        manualIpv6Url: relayConfig.manualIpv6Url,
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
    const now = Date.now()

    // 看门狗熔断：窗口内重启太频繁就暂停，避免自愈本身成为断连源头。
    const wd = state.watchdog
    const wdCfg = state.config.healWatchdog
    if (now < wd.trippedUntil) return
    const check = watchdogCheck(wd.restarts, now, wdCfg)
    wd.restarts = check.recent
    if (check.shouldTrip) {
      wd.trippedUntil = now + wdCfg.cooldownMs
      wd.trips += 1
      wd.lastReason = `窗口内已重启 ${wd.restarts.length} 次，超过上限 ${wdCfg.maxRestarts}，暂停自动重启 ${Math.round(wdCfg.cooldownMs / 1000)} 秒`
      pushHistory({ kind: 'watchdog', reason: wd.lastReason })
      log('warn', 'sidecar 自愈看门狗熔断：%s', wd.lastReason)
      return
    }

    if (!lanEntryUnhealthy(state.relay, state.channels)) return
    if (now - state.lastHealAt < state.config.healCooldownMs) return
    state.lastHealAt = now
    wd.restarts.push(now)
    try {
      const result = await restartSidecar(port())
      markEntryUnstable(`局域网入口重启：${result?.after?.lan?.state || result?.after?.state || 'unknown'}`)
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

  /** 磁盘上 dsh-mobile-plugin 的版本；读不到返回空串。 */
  function diskMobilePluginVersion() {
    try {
      const file = path.join(dshHome(), 'profiles', String(process.env.DSH_PROFILE || 'web'), 'node_modules', 'dsh-mobile-plugin', 'package.json')
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      return typeof raw.version === 'string' ? raw.version.trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * 启动时把 dsh-mobile-plugin 的自动更新关掉：它是"反复需要重启"的根源。
   * 幂等，每轮探测也顺手确保一次（防止外部把它改回 true）。
   */
  function ensureAutoUpdateOff() {
    if (state.restartGuard.autoUpdateOff && readAutoUpdate(dshHome()) === false) return
    const result = ensureAutoUpdateDisabled(dshHome())
    state.restartGuard.autoUpdateOff = result.enabled === false
    if (result.changed) {
      pushHistory({ kind: 'guard', reason: '已关闭 dsh-mobile-plugin 自动更新（避免热加载未重启）' })
      log('info', '已关闭 dsh-mobile-plugin 自动更新：%s', result.path)
    }
  }

  /** 发起一次 DSH 自动重启：写 plan + spawn 独立 helper，然后等进程被替换。 */
  function triggerRestart(reason) {
    if (state.restartGuard.pending) return false
    const cfg = state.config.restartGuard
    const now = Date.now()
    const allowed = restartAllowed(state.restartGuard.restarts, now, cfg)
    if (!allowed.allowed) {
      state.restartGuard.lastResult = `窗口内已重启 ${allowed.count} 次，达上限 ${cfg.maxRestarts}，停止自动重启`
      pushHistory({ kind: 'guard', reason: state.restartGuard.lastResult })
      log('warn', '自动重启守护熔断：%s', state.restartGuard.lastResult)
      return false
    }

    const portNum = (() => { try { return ctx.webServer?.port || 3080 } catch { return 3080 } })()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(dshHome(), 'dsh-mobile-route-priority')
    let planPath = ''
    try {
      fs.mkdirSync(dir, { recursive: true })
      planPath = path.join(dir, `restart-plan-${stamp}.json`)
      // 只继承重启必需的进程变量；完整 process.env 含 TRIM_API_TOKEN 等凭据，
      // 绝不能落盘到 666 的 JSON 里。helper 用 process.env 兜底即可拿到同样的环境。
      const plan = {
        pid: process.pid,
        execPath: process.execPath,
        argv: process.argv.slice(1),
        cwd: process.cwd(),
        port: portNum,
        reason,
        logPath: path.join(dir, 'restart.log'),
        requestedAt: new Date().toISOString(),
      }
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      state.restartGuard.lastResult = `写重启计划失败：${error?.message || error}`
      log('warn', '自动重启计划写入失败：%s', state.restartGuard.lastResult)
      return false
    }

    try {
      const helper = spawn(process.execPath, [RESTART_HELPER, planPath], {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      helper.unref()
    } catch (error) {
      state.restartGuard.lastResult = `启动重启助手失败：${error?.message || error}`
      log('warn', '自动重启助手启动失败：%s', state.restartGuard.lastResult)
      return false
    }

    state.restartGuard.restarts.push(now)
    state.restartGuard.pending = true
    state.restartGuard.lastResult = `已发起自动重启：${reason}`
    pushHistory({ kind: 'guard', reason: state.restartGuard.lastResult })
    log('warn', '自动重启 DSH：%s', reason)
    return true
  }

  /** 定时检查：版本不一致/外壳换代时自动重启（带启动宽限期与熔断）。 */
  function checkRestartGuard() {
    const cfg = state.config.restartGuard
    const now = Date.now()
    state.restartGuard.lastCheckAt = now
    if (!cfg.enabled) { state.restartGuard.lastResult = '自动重启守护已关闭'; return }
    // 启动宽限期：刚重启完先观察，别因为旧状态立刻再重启。
    if (now - state.startedAt < cfg.startupGraceMs) {
      state.restartGuard.lastResult = '启动宽限期内，暂不检查'
      return
    }
    // 丢弃窗口外记录
    state.restartGuard.restarts = state.restartGuard.restarts.filter(t => now - t < cfg.windowMs)
    const verdict = restartNeeded({
      diskVersion: diskMobilePluginVersion(),
      runningVersion: state.relay?.appVersion || '',
      status: state.relay,
      cfg,
    })
    state.restartGuard.lastResult = verdict.reason
    if (verdict.needed) triggerRestart(verdict.reason)
  }

  /** 把决策翻译成实际动作。只下发与已应用值不同的项，减少对插件的无谓写入。 */
  async function applyDecision() {
    if (state.config.dryRun) return
    const actions = state.decision.actions || []
    const patch = {}
    for (const action of actions) {
      if (['preferredLanAddress', 'manualLanUrl', 'manualIpv4Url', 'manualIpv6Url', 'manualTcpUrl'].includes(action.kind)) {
        if (state.applied[action.kind] !== action.value) {
          patch[action.kind] = action.value
          state.applied[action.kind] = action.value
        }
      } else if (action.kind === 'tailcat' && state.applied.tailcat !== action.enabled) {
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
      version: 2,
      config: state.config,
      links: state.links,
      channels: state.channels,
      decision: { target: state.decision.target, reason: state.decision.reason, warnings: state.decision.warnings || [], actions: state.decision.actions || [] },
      applied: state.applied,
      devices: state.devices,
      history: state.history,
      entry: {
        healCount: state.entry.healCount,
        lastHealAt: state.entry.lastHealAt,
        unstable: Date.now() < state.entry.unstableUntil,
        unstableUntil: state.entry.unstableUntil,
      },
      watchdog: {
        restartsInWindow: state.watchdog.restarts.filter(t => Date.now() - t < state.config.healWatchdog.windowMs).length,
        tripped: Date.now() < state.watchdog.trippedUntil,
        trippedUntil: state.watchdog.trippedUntil,
        trips: state.watchdog.trips,
        lastReason: state.watchdog.lastReason,
      },
      restartGuard: {
        enabled: state.config.restartGuard.enabled,
        diskVersion: diskMobilePluginVersion(),
        runningVersion: state.relay?.appVersion || '',
        autoUpdateOff: state.restartGuard.autoUpdateOff,
        pending: state.restartGuard.pending,
        lastCheckAt: state.restartGuard.lastCheckAt,
        lastResult: state.restartGuard.lastResult,
        restartsInWindow: state.restartGuard.restarts.filter(t => Date.now() - t < state.config.restartGuard.windowMs).length,
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

  // 启动时立刻关闭 dsh-mobile-plugin 自动更新（反复需重启的根源）。
  ensureAutoUpdateOff()

  ctx.effect(() => {
    let timer = null
    let disposed = false
    const run = async () => {
      if (disposed) return
      await tick()
      if (disposed) return
      ensureAutoUpdateOff() // 每轮顺手确保没被外部改回自动更新
      timer = setTimeout(run, state.config.intervalMs)
    }
    void run()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, 'dsh-mobile-route-priority: probe loop')

  // 独立的自动重启守护定时器：版本不一致/外壳换代时重启 DSH（带启动宽限期 + 熔断）。
  ctx.effect(() => {
    let timer = null
    let disposed = false
    const run = () => {
      if (disposed) return
      try { checkRestartGuard() } catch (error) {
        state.restartGuard.lastResult = `检查失败：${error?.message || error}`
        log('warn', '自动重启守护检查失败：%s', state.restartGuard.lastResult)
      }
      if (disposed) return
      timer = setTimeout(run, state.config.restartGuard.checkIntervalMs)
    }
    timer = setTimeout(run, Math.min(state.config.restartGuard.checkIntervalMs, 30000))
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, 'dsh-mobile-route-priority: restart guard')

  ctx.effect(() => {
    // One handler set, registered under every accepted route family so the
    // direct port and the fnOS gateway proxy expose identical behaviour.
    const buildRoutes = (base) => [
      { kind: 'exact', path: `${base}/state`, handler: (_req, res) => json(res, 200, snapshot()) },
      { kind: 'exact', path: `${base}/panel`, handler: (_req, res) => html(res, 200, PANEL_HTML) },
      { kind: 'exact', path: `${base}/config`, handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const result = await saveConfig(body)
          json(res, result.ok ? 200 : 400, { ...result, state: snapshot() })
        } catch (error) {
          json(res, 400, { ok: false, message: String(error?.message || error) })
        }
      } },
      { kind: 'exact', path: `${base}/action`, handler: async (req, res) => {
        try {
          const body = await readJson(req)
          const action = String(body?.action || '')
          if (action === 'probe') { await probeAll(); await applyDecision(); return json(res, 200, { ok: true, state: snapshot() }) }
          if (action === 'heal') { state.lastHealAt = 0; await healIfNeeded(); return json(res, 200, { ok: true, state: snapshot() }) }
          if (action === 'reset') {
            state.applied = {}
            state.prev = {}
            state.watchdog = { restarts: [], trippedUntil: 0, trips: 0, lastReason: '' }
            pushHistory({ kind: 'reset', reason: '手动重置应用状态' })
            return json(res, 200, { ok: true, state: snapshot() })
          }
          if (action === 'reset-watchdog') {
            state.watchdog = { restarts: [], trippedUntil: 0, trips: 0, lastReason: '' }
            pushHistory({ kind: 'watchdog', reason: '手动解除自愈看门狗熔断' })
            return json(res, 200, { ok: true, state: snapshot() })
          }
          if (action === 'restart-dsh') {
            const ok = triggerRestart('面板手动重启')
            return json(res, 200, { ok, state: snapshot() })
          }
          if (action === 'check-restart') {
            checkRestartGuard()
            return json(res, 200, { ok: true, state: snapshot() })
          }
          json(res, 400, { ok: false, message: `未知动作：${action || '(空)'}` })
        } catch (error) {
          json(res, 400, { ok: false, message: String(error?.message || error) })
        }
      } },
    ]
    const disposers = []
    for (const family of ROUTE_FAMILIES) {
      for (const route of buildRoutes(family.base)) {
        try { disposers.push(ctx.webServer.register(route)) } catch (error) {
          log('warn', '路由 %s 没挂上：%s', route.path, String(error?.message || error))
        }
      }
    }
    return () => { for (const dispose of disposers) { try { dispose() } catch { /* 卸载失败不影响其它路由 */ } } }
  }, 'dsh-mobile-route-priority: routes')

  log('info', '已加载：模式 %s，面板 %s', state.config.mode, PANEL_PATH)
}

// 面板与 API 都挂在 webServer 上，路径与移动端插件的 `/api/relay/*` 刻意错开。
export const __internals = { discoverAddresses, discoverLinks }

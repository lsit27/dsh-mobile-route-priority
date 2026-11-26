// 与 dsh-mobile-plugin 的本机控制面打交道。
//
// 落在 127.0.0.1 上的接口都是「本机专属」（localOnly），所以这里一律从 127.0.0.1 发请求。
// 这个模块不缓存状态：每次决策现读，免得面板显示的和插件里真在跑的是两回事。
'use strict'

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function devicesFile() {
  return path.join(dshHome(), 'relay-device-credentials.json')
}

/** 一台设备记录里我们关心的那几格。 */
export function summarizeDevices(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(row => row && typeof row === 'object' && !row.revokedAt)
    .map(row => ({
      deviceId: typeof row.deviceId === 'string' ? row.deviceId : '',
      name: typeof row.name === 'string' ? row.name : (typeof row.model === 'string' ? row.model : ''),
      platform: typeof row.platform === 'string' ? row.platform : '',
      lastChannel: typeof row.lastChannel === 'string' ? row.lastChannel : '',
      lastSeenAt: Number.isFinite(row.lastSeenAt) ? row.lastSeenAt : 0,
      lanDiscovery: row.lanDiscovery === 1,
    }))
}

/** 读设备凭据文件；读不到就是空表，不在面板上报错——文件不在只说明还没有手机配过对。 */
export function readDevices() {
  try {
    return summarizeDevices(JSON.parse(fs.readFileSync(devicesFile(), 'utf8')))
  } catch {
    return []
  }
}

/**
 * 手机最近一次明确走的是局域网吗。
 * `lastChannel: 'lan'` 是插件自己在连接建立时写的，比我们从外面猜可靠得多。
 */
export function phoneRecentlyOnLan(devices) {
  return devices.some(device => device.lastChannel === 'lan' && Date.now() - device.lastSeenAt < 10 * 60 * 1000)
}

function request(port, method, pathname, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(raw || '{}') } catch { parsed = null }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = parsed && typeof parsed.error === 'string' ? ` (${parsed.error})` : ''
          reject(new Error(`${pathname} -> ${res.statusCode}${detail}`))
          return
        }
        resolve(parsed ?? {})
      })
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`${pathname} -> timeout`))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 读插件状态。拿不到就返回 null，调用方按「插件不在」处理。 */
export async function fetchRelayStatus(port) {
  try {
    return await request(port, 'GET', '/api/relay/status')
  } catch {
    return null
  }
}

/** 改插件配置（候选地址、手填直连等）。只发变化的键。 */
export async function patchRelayConfig(port, patch) {
  const keys = Object.keys(patch || {})
  if (!keys.length) return { ok: true, skipped: true }
  return request(port, 'POST', '/api/relay/config', patch)
}

/** 开 / 关直连隧道通道。这是电脑侧唯一能让手机放弃隧道的手段。 */
export async function setTailcatEnabled(port, enabled) {
  return request(port, 'POST', '/api/relay/tailcat/enabled', { enabled: Boolean(enabled) })
}

/** 让插件自己把 sidecar 拉起来（局域网入口和隧道入口都在里面）。 */
export async function restartSidecar(port) {
  return request(port, 'POST', '/api/relay/restart-sidecar', {}, 60000)
}

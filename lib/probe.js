// 通道探测。
//
// 只做一件事：给一条「主机:端口」量一个可比较的耗时。用 http 而不是裸 TCP，因为局域网入口
// 是 HTTP 服务，能建立连接但迟迟不回包的那种半死状态，TCP 探测会误判成健康。
'use strict'

import http from 'node:http'

/**
 * 探测一个 HTTP 入口。
 * 任何 HTTP 状态码都算「通」—— 404 也证明服务在应答；只有连不上、超时、连接被重置才算失败。
 * @returns {Promise<{ok: boolean, rttMs: number|null, status: number|null, error: string}>}
 */
export function probeHttp({ host, port, path = '/', timeoutMs = 1200 }) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint()
    let settled = false
    const done = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6
    const req = http.request(
      { host, port, path, method: 'GET', timeout: timeoutMs, headers: { connection: 'close' } },
      res => {
        const rttMs = elapsed()
        res.resume()
        res.on('end', () => done({ ok: true, rttMs, status: res.statusCode ?? null, error: '' }))
        res.on('error', () => done({ ok: true, rttMs, status: res.statusCode ?? null, error: '' }))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      done({ ok: false, rttMs: null, status: null, error: 'timeout' })
    })
    req.on('error', error => done({ ok: false, rttMs: null, status: null, error: String(error?.code || error?.message || error) }))
    req.end()
  })
}

/** 一条通道的「质量」表现：连续失败次数与最近一次 RTT。 */
export function createChannelState() {
  return { rttMs: null, fails: 0, ok: false, lastOkAt: 0, lastError: '' }
}

/**
 * 把一次探测结果折进通道状态。
 * 成功清零失败计数；失败累加，并把 rtt 清空——留着上一次的 12ms 会让面板看起来「很健康但连不上」。
 */
export function foldProbe(state, probe, now = Date.now()) {
  const next = { ...state }
  if (probe.ok) {
    next.ok = true
    next.rttMs = probe.rttMs
    next.fails = 0
    next.lastOkAt = now
    next.lastError = ''
  } else {
    next.ok = false
    next.rttMs = null
    next.fails = (state.fails || 0) + 1
    next.lastError = probe.error || 'error'
  }
  return next
}

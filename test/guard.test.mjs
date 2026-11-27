import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureAutoUpdateDisabled, readAutoUpdate, autoUpdateFile } from '../lib/autoupdate.js'
import { versionMismatch, restartNeeded, restartAllowed } from '../lib/restart-guard.js'

test('自动更新：文件不存在时默认开启，ensure 后关闭', () => {
  const home = mkdtempSync(join(tmpdir(), 'au-'))
  assert.equal(readAutoUpdate(home), true) // ENOENT → 默认开启
  const r = ensureAutoUpdateDisabled(home)
  assert.equal(r.changed, true)
  assert.equal(readAutoUpdate(home), false)
  assert.equal(existsSync(autoUpdateFile(home)), true)
  // 幂等
  const r2 = ensureAutoUpdateDisabled(home)
  assert.equal(r2.changed, false)
})

test('自动更新：显式开启时被关闭', () => {
  const home = mkdtempSync(join(tmpdir(), 'au-'))
  mkdirSync(join(home, 'storages', 'mobile-plugin'), { recursive: true })
  writeFileSync(autoUpdateFile(home), JSON.stringify({ enabled: true }))
  assert.equal(readAutoUpdate(home), true)
  ensureAutoUpdateDisabled(home)
  assert.equal(readAutoUpdate(home), false)
})

test('版本不一致判定', () => {
  assert.equal(versionMismatch('0.5.130', '0.5.127'), true)
  assert.equal(versionMismatch('0.5.130', '0.5.130'), false)
  assert.equal(versionMismatch('', '0.5.127'), null)
})

test('restartNeeded：版本不一致触发', () => {
  const v = restartNeeded({ diskVersion: '0.5.130', runningVersion: '0.5.127', status: {}, cfg: { enabled: true } })
  assert.equal(v.needed, true)
  assert.match(v.reason, /版本/)
})

test('restartNeeded：shellChanged / 首次安装触发', () => {
  assert.equal(restartNeeded({ diskVersion: '0.5.130', runningVersion: '0.5.130', status: { shellChanged: true }, cfg: {} }).needed, true)
  assert.equal(restartNeeded({ diskVersion: '0.5.130', runningVersion: '0.5.130', status: { firstInstallPendingRestart: true }, cfg: {} }).needed, true)
})

test('restartNeeded：一致且已关闭时不触发', () => {
  assert.equal(restartNeeded({ diskVersion: '0.5.130', runningVersion: '0.5.130', status: {}, cfg: {} }).needed, false)
  assert.equal(restartNeeded({ diskVersion: '0.5.130', runningVersion: '0.5.127', status: {}, cfg: { enabled: false } }).needed, false)
})

test('熔断：24h 窗口内最多 2 次', () => {
  const now = 1_000_000
  const cfg = { windowMs: 24 * 3600 * 1000, maxRestarts: 2 }
  assert.equal(restartAllowed([], now, cfg).allowed, true)
  assert.equal(restartAllowed([now - 1000], now, cfg).allowed, true)
  assert.equal(restartAllowed([now - 1000, now - 2000], now, cfg).allowed, false)
})

test('熔断：窗口外的旧记录不计入', () => {
  const now = 1_000_000
  const cfg = { windowMs: 3600 * 1000, maxRestarts: 2 }
  assert.equal(restartAllowed([now - 7200 * 1000, now - 1000], now, cfg).allowed, true)
})

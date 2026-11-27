/**
 * route-priority 自动重启助手（独立进程，detached 启动）。
 *
 * 由 Host 插件在"检测到 dsh-mobile-plugin 版本不一致/外壳换代"时拉起。
 * 流程：等旧 dsh 退出 → 等端口释放 → 用完全相同的入口/参数/cwd 重新拉起 → 轮询端口直到恢复。
 *
 * 基于 dsh-restart 的 restart-helper.mjs（已在 fnOS 现场验证），只用 Node 内置模块。
 * 日志写到 plan.logPath，便于事后排查。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

const planPath = process.argv[2]
if (planPath === undefined) {
  console.error('usage: restart-helper.mjs <plan.json>')
  process.exit(2)
}

const rawPlan = readFileSync(planPath, 'utf8').replace(/^\uFEFF/, '')
const plan = JSON.parse(rawPlan)
const logPath = plan.logPath

function log(message) {
  try {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function listening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitUntil(predicate, timeoutMs, stepMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

async function main() {
  log(`helper start (reason=${plan.reason || 'auto'}, target pid=${plan.pid}, port=${plan.port})`)

  // 若当前进程还活着，先请求它自己优雅退出；用 SIGTERM 让 DSH 走正常关闭流程。
  if (alive(plan.pid)) {
    try {
      process.kill(plan.pid, 'SIGTERM')
      log('sent SIGTERM to old process')
    } catch (error) {
      log(`SIGTERM failed: ${error?.message ?? error}`)
    }
  }

  // 1) 等旧进程退出
  const t0 = Date.now()
  await waitUntil(() => Promise.resolve(!alive(plan.pid)), 20000, 150)
  if (alive(plan.pid)) {
    log(`pid ${plan.pid} still alive after 20s, forcing SIGKILL`)
    try { process.kill(plan.pid, 'SIGKILL') } catch (error) {
      log(`force kill failed: ${error?.message ?? error}`)
    }
    await sleep(1500)
  }
  log(`old process gone after ${Date.now() - t0}ms`)

  // 2) 等端口释放
  if (plan.port > 0) {
    const freed = await waitUntil(async () => !(await listening(plan.port)), 20000, 200)
    log(`port ${plan.port} release wait done (free=${freed})`)
  }

  // 3) 拉起新进程，失败重试
  const out = openSync(logPath, 'a')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (plan.port > 0 && (await listening(plan.port))) {
      log('port already serving; assume another dsh instance took over')
      return
    }
    log(`launch attempt ${attempt}: ${plan.execPath} ${plan.argv.join(' ')} (cwd=${plan.cwd})`)
    let child
    try {
      child = spawn(plan.execPath, plan.argv, {
        cwd: plan.cwd,
        env: plan.env || process.env,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      })
      child.unref()
      log(`spawned pid=${child.pid}`)
    } catch (error) {
      log(`spawn failed: ${error?.message ?? error}`)
      await sleep(1200)
      continue
    }
    const ok = plan.port > 0
      ? await waitUntil(() => listening(plan.port), 90000, 400)
      : await sleep(5000).then(() => true)
    if (ok) {
      log('dsh is listening again; restart complete')
      return
    }
    log(`attempt ${attempt} did not reach port ${plan.port}`)
    try { child.kill() } catch { /* ignore */ }
    await sleep(1500)
  }
  log('RESTART FAILED: give up after 3 attempts (手动重启可恢复)')
}

main().catch(error => {
  log(`helper crashed: ${error?.stack ?? error}`)
})

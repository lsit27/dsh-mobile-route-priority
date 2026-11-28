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
import { appendFileSync, readFileSync, openSync, closeSync } from 'node:fs'
import { connect } from 'node:net'

const planPath = process.argv[2]
if (planPath === undefined) {
  console.error('usage: restart-helper.mjs <plan.json>')
  process.exit(2)
}

const rawPlan = readFileSync(planPath, 'utf8').replace(/^\uFEFF/, '')
const plan = JSON.parse(rawPlan)

// 纵深防御：plan 文件由本插件写入，但仍校验字段类型，避免被篡改后 spawn 任意命令/杀错进程。
function validPlan(p) {
  if (!p || typeof p !== 'object') return false
  if (!Number.isInteger(p.pid) || p.pid <= 0) return false
  if (typeof p.execPath !== 'string' || !p.execPath) return false
  if (!Array.isArray(p.argv) || !p.argv.every(a => typeof a === 'string')) return false
  if (typeof p.cwd !== 'string' || !p.cwd) return false
  if (typeof p.logPath !== 'string' || !p.logPath) return false
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return false
  return true
}
if (!validPlan(plan)) {
  console.error('invalid restart plan')
  process.exit(2)
}
const logPath = plan.logPath

function log(message) {
  try {
    // 首次写入用 600 创建，避免日志被同机其它用户读取。
    try { const fd = openSync(logPath, 'a', 0o600); closeSync(fd) } catch { /* ignore */ }
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

  // 3) 拉起新进程，失败重试。
  // 不把子进程 stdout/stderr 重定向进 restart.log：DSH 启动 banner 会打印
  // `?token=...` 登录令牌，那会把凭据写进日志文件。DSH 自身日志由 DSH 管理。
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
        env: process.env,
        detached: true,
        stdio: 'ignore',
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

// 自动重启守护：判断"是否需要重启 DSH 宿主"。
//
// 触发条件（任一）：
//   1. 磁盘上的 dsh-mobile-plugin 版本 ≠ /api/relay/status 里的运行版本；
//   2. status.shellChanged === true（外壳换代，只有重启宿主才生效）；
//   3. status.firstInstallPendingRestart === true（首次热加载未重启）。
//
// 镜像不推送（mirror.ok=false）本身不作为触发条件：它只是版本不一致的后果，且可能
// 因隧道暂时不可用而波动；用版本/shellChanged 判定更精确、不会误重启。
//
// 熔断：滑动窗口（默认 24h）内自动重启超过上限（默认 2 次）就停止，避免循环。
'use strict'

/** 版本是否不一致。磁盘版本与运行版本都拿到才判定；缺一返回 null（未知）。 */
export function versionMismatch(diskVersion, runningVersion) {
  const a = typeof diskVersion === 'string' ? diskVersion.trim() : ''
  const b = typeof runningVersion === 'string' ? runningVersion.trim() : ''
  if (!a || !b) return null
  return a !== b
}

/**
 * 是否需要重启。
 * @returns {{needed:boolean, reason:string}}
 */
export function restartNeeded({ diskVersion, runningVersion, status, cfg }) {
  const conf = cfg || {}
  if (conf.enabled === false) return { needed: false, reason: '自动重启已关闭' }

  const mismatch = versionMismatch(diskVersion, runningVersion)
  if (mismatch === true) {
    return { needed: true, reason: `磁盘版本 ${diskVersion} ≠ 运行版本 ${runningVersion}` }
  }
  const s = status || {}
  if (s.shellChanged === true) {
    return { needed: true, reason: '插件外壳已换代，需重启宿主生效' }
  }
  if (s.firstInstallPendingRestart === true) {
    return { needed: true, reason: '插件首次热加载，需重启一次' }
  }
  return { needed: false, reason: '版本与外壳一致，无需重启' }
}

/**
 * 熔断检查：窗口内重启次数达上限则本轮不重启。
 * @returns {{allowed:boolean, count:number}}
 */
export function restartAllowed(restarts, now, cfg) {
  const windowMs = cfg?.windowMs ?? 24 * 3600 * 1000
  const maxRestarts = cfg?.maxRestarts ?? 2
  const recent = (restarts || []).filter(t => now - t < windowMs)
  return { allowed: recent.length < maxRestarts, count: recent.length }
}

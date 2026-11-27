// 管理 dsh-mobile-plugin 的自动更新开关。
//
// 反复断连的根因：dsh-mobile-plugin 默认自动更新，每次后台升级到新版后，新代码被热加载进
// 正在运行的 DSH，但外壳（host 侧）/隧道/镜像初始化只在进程启动时装载 —— 于是出现
// 「磁盘版本 > 运行版本」「shellChanged」「镜像不推送」，手机端反复报"解不开/请重启"。
//
// 治本：把自动更新关掉，别让运行中的进程被偷偷换代。以后要升级就手动更新 + 重启一次，
// 不会再来回折腾。
'use strict'

import fs from 'node:fs'
import path from 'node:path'

/** 自动更新开关文件，与 dsh-mobile-plugin 的 shell/updater.js 同口径。 */
export function autoUpdateFile(dshHome) {
  return path.join(dshHome, 'storages', 'mobile-plugin', 'auto-update.json')
}

/** 读取当前开关：文件不存在时 dsh-mobile-plugin 默认开启（true）。 */
export function readAutoUpdate(dshHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(autoUpdateFile(dshHome), 'utf8'))
    return raw?.enabled === true
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

/**
 * 确保自动更新关闭。幂等：已关闭时不写文件。
 * @returns {{changed:boolean, enabled:boolean, path:string}}
 */
export function ensureAutoUpdateDisabled(dshHome) {
  const file = autoUpdateFile(dshHome)
  const wasEnabled = readAutoUpdate(dshHome)
  if (!wasEnabled) return { changed: false, enabled: false, path: file }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ enabled: false }, null, 2)}\n`, 'utf8')
    return { changed: true, enabled: false, path: file }
  } catch {
    // 写不进去不阻断插件运行，只是这次没能关掉。
    return { changed: false, enabled: wasEnabled, path: file }
  }
}

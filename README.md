# dsh-mobile-route-priority

Route priority controller for [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin): it measures the links your phone can use and tells the plugin which one to advertise first, so the phone stops drifting onto the public tunnel while it sits on the same Wi-Fi. Supports LAN-first, automatic quality picking, and a manual order with latency-threshold failover.

[中文说明](#中文说明) · [English](#english)

---

## 中文说明

同一台电脑常常同时有局域网、Tailscale、直连隧道、中转好几条路。dsh-mobile-plugin 的候选顺序是
写死的，手机端「按顺序挨个试，第一个通就用」，于是局域网那条一旦不可用，手机就退到慢线路上，
而且不会自己抢回来——这就是「明明在同一个局域网，ms 却时好时坏」的来源。

这个插件按实测延迟决定该用哪条，并把它翻译成 dsh-mobile-plugin 能理解的三件事：

- 局域网候选的优先地址（`preferredLanAddress`）
- 手填直连地址（`manualLanUrl`，用来表达「走 Tailscale」）
- 直连隧道开关（`/api/relay/tailcat/enabled`，用来逼手机放弃隧道）

### 安装

```bash
dsh plugin add dsh-mobile-route-priority --profile web
```

或者在 DSH 的 **设置 → 插件** 里搜索 `dsh-mobile-route-priority` 安装。装完在插件列表里能看到
它，`/api/mobile-route/*` 路由随之生效。

面板：`http://127.0.0.1:3080/api/mobile-route/panel`（端口按你实际的 DSH Web 端口）。

### 三种模式

| 模式 | 行为 |
| --- | --- |
| 局域网优先 | 局域网健康就用它；不健康时依次退到 Tailscale、直连隧道、中转 |
| 自动择优 | 在健康通道里挑延迟最低的，只有明显更快（25% 以上）才切换 |
| 手动顺序 | 完全按面板顺序走，前一条连续不健康（次数可配）才让位 |

健康判据共用：探测失败或延迟超过「降级阈值」算不健康；要连续达到「连续失败次数」才降级，
恢复到「恢复阈值」以下才切回来。

### 安全护栏

关直连隧道是唯一能让手机彻底连不上的动作，所以四道闸必须同时满足：开关打开、局域网实测健康、
手机最近确实通过局域网连过（读 `relay-device-credentials.json` 的 `lastChannel`）、局域网入口近期
没崩过（每次自愈后 10 分钟内算不稳）。缺一条就保持隧道开着，并在面板上写明原因。局域网入口
（sidecar）挂掉时会限频（默认 30 秒）自愈。

手填的 TCP 直连若指向 Tailscale 网段（`100.64.0.0/10`），在局域网优先下会被收掉；其它地址不动。

### 配置

面板上能改的字段，也可以直接写进 `cordis.patch.yml` 的行配置：

```yaml
- insert:
    - id: dsh-mobile-route-priority
      name: 'dsh-mobile-route-priority'
      config:
        mode: lan-first          # lan-first | auto | manual
        order: [lan, tailscale, tailcat, relay]
        intervalMs: 4000
        probeTimeoutMs: 1200
        dryRun: false
        allowDisableTailcat: true
        autoHealSidecar: true
        thresholds:
          lan:      { degradeMs: 80,  restoreMs: 50,  fails: 3 }
          tailscale:{ degradeMs: 120, restoreMs: 70,  fails: 3 }
          tailcat:  { degradeMs: 180, restoreMs: 100, fails: 3 }
          relay:    { degradeMs: 220, restoreMs: 140, fails: 3 }
```

### 限制（请先读）

- **手机端仍有自己的判断。** 本插件编排电脑侧上报的候选与隧道开关，手机 App 怎么合并、何时重新
  探测不在控制范围内。它做的是持续把「正确的答案」摆在手机面前。
- **直连隧道的时延量不到**，只能读插件报的 ready 状态，所以它不参与速度比较，只作兜底。
- **Tailscale 地址只识别 `100.64.0.0/10`。**
- 真实效果以手机断 Wi-Fi 走流量、再回 Wi-Fi 的实测为准；面板上的数字只是电脑侧视角。

### 开发

```bash
node --test test/*.test.mjs
```

---

## English

`dsh-mobile-route-priority` is a DSH bundle that steers the mobile app's link choice. It probes the
LAN address, the Tailscale address, the built-in tunnel and the relay every few seconds, then rewrites
`preferredLanAddress`, `manualLanUrl` and the tailcat switch on `dsh-mobile-plugin` so the candidates
the phone receives are ordered by measured latency.

Three modes: `lan-first`, `auto` (fastest healthy link, 25% hysteresis), and `manual` (a user-ordered
list with per-channel degrade/restore thresholds). Switching a channel off requires three conditions:
the opt-in flag, a genuinely healthy LAN probe, and evidence the phone recently connected over the LAN.

### Install

```bash
dsh plugin add dsh-mobile-route-priority --profile web
```

Panel: `http://127.0.0.1:3080/api/mobile-route/panel`.

### Limitations

- The phone app keeps its own channel-merge and re-probe logic; this bundle only orchestrates what the
  computer advertises and whether the tunnel is available.
- The built-in tunnel's latency cannot be measured from the host, so it is a fallback rather than a
  speed candidate.
- Only `100.64.0.0/10` is recognised as a Tailscale address.

## License

MIT

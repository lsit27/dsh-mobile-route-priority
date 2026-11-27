# dsh-mobile-route-priority

Route priority controller for [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin): it measures the links your phone can use and tells the plugin which one to advertise first, so the phone stops drifting onto the public tunnel while it sits on the same Wi-Fi. Supports LAN-first, automatic quality picking, and a manual order with latency-threshold failover.

[中文说明](#中文说明) · [English](#english)

---

## 中文说明

同一台电脑常常同时有局域网、Tailscale、直连隧道、中转好几条路。dsh-mobile-plugin 的候选顺序是
写死的，手机端「按顺序挨个试，第一个通就用」，于是局域网那条一旦不可用，手机就退到慢线路上，
而且不会自己抢回来——这就是「明明在同一个局域网，ms 却时好时坏」的来源。

这个插件把每条手机可走的「链路」枚举出来——多块网卡的局域网 IP、Tailscale、插件里单独配置的
手填直连、直连隧道、中转——按实测延迟与稳定性挑一条，再翻译成 dsh-mobile-plugin 能理解的三件事：

- 局域网候选的优先地址（`preferredLanAddress`）
- 手填直连地址（`manualLanUrl` / `manualIpv4Url` / `manualIpv6Url` / `manualTcpUrl`）
- 直连隧道开关（`/api/relay/tailcat/enabled`）

局域网地址按 dsh-mobile-plugin 同款口径发现：支持多个 IP / 多块网卡，Docker / 虚拟网卡按名字
挡掉，不再误伤 172.x 的真实 Wi-Fi。**插件单独配置的手填链路与局域网链路严格分开**——即使地址
相同也各算一条（来源 `plugin-config` vs `nic`），面板上分组显示、分别控制。

**两条 Tailscale 线路是分开的**：`tailscale0` 的 `100.64.19.3` 属于**局域网内的一条线路**
（`lan-ts` 组，通过 `manualLanUrl` 上报），而 DSH 内置 `tailcat` 隧道走公网节点中转，是**另一条
独立线路**。两者独立排序、互不覆盖——选 Tailscale 网卡线路时不会关掉 DSH 隧道。注意 `lan-ts`
与手填链路的 `manual:lanUrl` 共用 `manualLanUrl` 字段，不能同时生效。

### 安装

```bash
dsh plugin add dsh-mobile-route-priority --profile web
```

或者在 DSH 的 **设置 → 插件** 里搜索 `dsh-mobile-route-priority` 安装。装完在插件列表里能看到
它，`/dsh-mobile-route/*` 路由随之生效（旧路径 `/api/mobile-route/*` 保留兼容）。

面板：`http://127.0.0.1:3080/dsh-mobile-route/panel`（端口按你实际的 DSH Web 端口）。

fnOS 上还可以从侧边栏左下角**「飞牛 OS」菜单**里选「手机连接选路」打开面板（新标签页），
插件同时在侧边栏插件行注册了同一入口。

### 三种模式

| 模式 | 行为 |
| --- | --- |
| 局域网优先 | 局域网链路健康就用它（多条网卡按 RTT 择优）；不健康时依次退到 Tailscale 网卡线路、插件手填链路、DSH 直连隧道、中转 |
| 自动择优 | 按质量（RTT）+ 稳定性（可用率、抖动）综合评分挑链路，明显更好才切换，带限抖保护 |
| 手动顺序 | 面板上单选或多选 + 拖拽排序；前一条连续不健康（次数可配）才让位 |

健康判据共用：探测失败或延迟超过「降级阈值」算不健康；要连续达到「连续失败次数」才降级，
恢复到「恢复阈值」以下才切回来。

### UI 设置界面

面板（`http://127.0.0.1:3080/dsh-mobile-route/panel`）按来源分组显示所有链路及实时质量指标。
手动模式支持**单选 / 多选排序**：拖拽条目（或 ↑↓ 按钮）调整优先级；自动模式可调质量权重、
稳定性权重、切换优势阈值、限抖次数与最短驻留时间。

### 安全护栏

关直连隧道是唯一能让手机彻底连不上的动作，所以四道闸必须同时满足：开关打开、局域网实测健康、
手机最近确实通过局域网连过（读 `relay-device-credentials.json` 的 `lastChannel`）、局域网入口近期
没崩过（每次自愈后 10 分钟内算不稳）。缺一条就保持隧道开着，并在面板上写明原因。局域网入口
（sidecar）挂掉时会限频（默认 30 秒）自愈，且有看门狗防误判：只有明确读到故障态且无任何
局域网链路实测可达才重启；10 分钟内重启超 3 次就熔断暂停，可用面板「解除自愈熔断」恢复。

手填的 TCP 直连若指向 Tailscale 网段（`100.64.0.0/10`），在局域网优先下会被收掉；其它地址不动。

### 配置

面板上能改的字段，也可以直接写进 `cordis.patch.yml` 的行配置：

```yaml
- insert:
    - id: dsh-mobile-route-priority
      name: 'dsh-mobile-route-priority'
      config:
        mode: lan-first          # lan-first | auto | manual
        order: [lan, lan-ts, tailscale, tailcat, relay]   # 组级顺序（含 lan-ts）
        selection: []            # 手动模式链路优先级，如 ['lan:192.168.1.2', 'lants:100.64.19.3']
        intervalMs: 4000
        probeTimeoutMs: 1200
        dryRun: false
        allowDisableTailcat: true
        autoHealSidecar: true
        autoPolicy:              # 自动择优策略
          qualityWeight: 0.7     # 质量（RTT）权重
          stabilityWeight: 0.3   # 稳定性（可用率/抖动）权重
          switchRatio: 0.15      # 综合分需高出当前这个比例才切换
          maxFlapPer10m: 3       # 10 分钟限抖次数
          minDwellMs: 0          # 最短驻留 ms（0 = 用 intervalMs * 2）
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
- **Tailscale 网卡地址只识别 `100.64.0.0/10`**，且须经 `manualLanUrl` 上报；它与 DSH 内置隧道是两条独立线路。
- 真实效果以手机断 Wi-Fi 走流量、再回 Wi-Fi 的实测为准；面板上的数字只是电脑侧视角。

### 开发

```bash
node --test test/*.test.mjs
```

---

## English

`dsh-mobile-route-priority` is a DSH bundle that steers the mobile app's link choice. It enumerates
every link the phone can take — multiple LAN interface IPs, Tailscale, plugin-configured direct links,
the built-in tunnel and the relay — then picks one by measured latency and stability and rewrites
`preferredLanAddress`, the `manual*` fields and the tailcat switch on `dsh-mobile-plugin`.

LAN addresses are discovered with the same rules as dsh-mobile-plugin: multiple IPs / interfaces,
virtual interfaces filtered by name, and 172.x real Wi-Fi no longer excluded. Plugin-configured direct
links are kept strictly separate from LAN links even when the address is identical (different source
`plugin-config` vs `nic`, shown in separate groups).

Two Tailscale paths are deliberately separate: a `tailscale0` NIC address such as `100.64.19.3` is a
LAN-path (`lan-ts` group, advertised via `manualLanUrl`), while DSH's built-in `tailcat` tunnel goes
through a public relay and is its own line. They rank independently and never overwrite each other —
selecting the Tailscale NIC path does not turn off the DSH tunnel. Note `lan-ts` and the hand-filled
`manual:lanUrl` share the `manualLanUrl` field and cannot both take effect.

Three modes: `lan-first` (LAN links by RTT, then Tailscale NIC, plugin links, DSH tunnel, relay), `auto`
(quality + stability score with switch hysteresis and flap limiting), and `manual` (single select, or
multi select with drag-to-reorder priority). Switching a channel off requires four guard conditions:
the opt-in flag, a genuinely healthy LAN probe, evidence the phone recently used the LAN, and a stable
LAN entry.

### Install

```bash
dsh plugin add dsh-mobile-route-priority --profile web
```

Panel: `http://127.0.0.1:3080/dsh-mobile-route/panel`.

### Limitations

- The phone app keeps its own channel-merge and re-probe logic; this bundle only orchestrates what the
  computer advertises and whether the tunnel is available.
- The built-in tunnel's latency cannot be measured from the host, so it is a fallback rather than a
  speed candidate.
- Only `100.64.0.0/10` is recognised as a Tailscale NIC address (advertised via `manualLanUrl`); it is a separate line from the DSH tunnel.

## License

MIT

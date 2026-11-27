// 配置面板：一个自包含的 HTML 页面，挂在 /dsh-mobile-route/panel。
//
// 主路径刻意用顶层前缀而不是 /api：fnOS 网关只代理它从路由表发现的路径前缀，
// 且把 /api 整个列为保留前缀，所以挂在 /api 下的面板无法从网关（5666）访问。
// /api/mobile-route/* 仍保留，供直连端口与旧链接使用。
//
// 刻意不用前端框架：这个页面要能在插件刚装好、前端包还没热起来的时候打开。
// 样式跟随宿主主题（prefers-color-scheme），不写死品牌色。
'use strict'

export const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机连接选路</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1b1c1f; --muted: #6b7078; --line: #e3e5e8;
    --card: #fafafb; --accent: #2563eb; --ok: #14804a; --warn: #b45309; --bad: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181b; --fg: #e8e9eb; --muted: #9aa0a8; --line: #2d2f34;
      --card: #1e2024; --accent: #6ea0ff; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: var(--bg); color: var(--fg);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 10px; color: var(--muted); font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  .wrap { max-width: 920px; margin: 0 auto; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .ch { display: flex; flex-direction: column; gap: 6px; }
  .ch .top { display: flex; justify-content: space-between; align-items: baseline; }
  .ch .name { font-weight: 600; }
  .ch .addr { color: var(--muted); font-size: 12px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .pill.src { color: var(--accent); border-color: var(--accent); }
  .rtt { font-size: 20px; font-variant-numeric: tabular-nums; }
  .rtt small { font-size: 12px; color: var(--muted); }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { opacity: .9; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .tabs { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .tabs button { border: 0; border-radius: 0; padding: 8px 16px; background: transparent; }
  .tabs button.on { background: var(--accent); color: #fff; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  input[type=number], input[type=text] { font: inherit; width: 110px; padding: 6px 8px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  input[type=range] { width: 160px; }
  .order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .order li { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card); cursor: grab; }
  .order li.dragging { opacity: .4; }
  .order li.dragover { border-color: var(--accent); }
  .order li .idx { color: var(--muted); width: 18px; }
  .order li .grow { flex: 1; }
  .order li button { padding: 2px 8px; }
  .order li .handle { color: var(--muted); cursor: grab; user-select: none; }
  .hist { list-style: none; margin: 0; padding: 0; font-size: 12px; color: var(--muted); max-height: 220px; overflow: auto; }
  .hist li { padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .kv { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .banner { border-radius: 8px; padding: 10px 12px; margin: 12px 0; font-size: 13px; }
  .banner.bad { background: rgba(180,35,24,.10); color: var(--bad); border: 1px solid var(--bad); }
  .banner.ok { background: rgba(20,128,74,.10); color: var(--ok); border: 1px solid var(--ok); }
  .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .muted { color: var(--muted); font-size: 12px; }
  .selbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>手机连接选路</h1>
  <div class="sub">按实测延迟与稳定性决定手机走哪条链路。局域网网卡地址与插件里单独配置的手填链路分开列出、分别控制。改动会写进 dsh-mobile-plugin。</div>

  <div class="card" style="border-color:var(--accent);background:rgba(37,99,235,.06)">
    <div style="font-weight:600;margin-bottom:4px">两条 Tailscale 线路是分开的</div>
    <div class="muted">「局域网·Tailscale 网卡」（如 tailscale0 的 100.64 地址）算局域网内的一条线路，通过 <code>manualLanUrl</code> 上报；「DSH 内置直连隧道」是走公网节点中转的另一条线路。两者独立参与排序，互不覆盖。注意：Tailscale 网卡线路与手填链路里的 <code>manual:lanUrl</code> 共用 <code>manualLanUrl</code> 字段，不能同时生效——以当前选中的那条为准。</div>
  </div>

  <div id="banner"></div>

  <div class="card">
    <div class="kv">
      <span>当前生效：<b id="target">-</b></span>
      <span>原因：<span id="reason">-</span></span>
      <span>上次探测：<span id="probeAt">-</span></span>
      <span>插件状态：<span id="sidecar">-</span></span>
      <span>自愈看门狗：<span id="watchdog">-</span></span>
      <span>自动重启守护：<span id="restartGuard">-</span></span>
    </div>
  </div>

  <h2>模式</h2>
  <div class="tabs" id="modes"></div>
  <div class="sub" style="margin-top:8px" id="modeHelp"></div>

  <h2>可用链路</h2>
  <div class="grid" id="linkGroups"></div>

  <div id="manualSection" style="display:none">
    <h2>手动优先级</h2>
    <div class="selbar">
      <span class="muted">选择方式：</span>
      <div class="tabs" id="selModes">
        <button data-sel="single">单选</button>
        <button data-sel="multi">多选排序</button>
      </div>
      <span class="muted" id="selHint"></span>
    </div>
    <ul class="order" id="order"></ul>
    <div class="muted" style="margin-top:6px">拖动条目或用 ↑↓ 调整顺序；排在最前的优先使用，前面不可用时依次让位。</div>
  </div>

  <div id="autoSection" style="display:none">
    <h2>自动择优策略</h2>
    <div class="grid" id="autoPolicy"></div>
  </div>

  <h2>健康阈值</h2>
  <div class="grid" id="thresholds"></div>

  <h2>开关</h2>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <label class="toggle"><input type="checkbox" id="allowDisableTailcat"> 允许在局域网健康时关闭直连隧道（逼手机走局域网）</label>
    <label class="toggle"><input type="checkbox" id="autoHealSidecar"> 局域网入口挂了时自动重启插件的 sidecar</label>
    <label class="toggle"><input type="checkbox" id="restartGuardEnabled"> 自动重启守护：版本不一致/外壳换代时自动重启 DSH（带 24h 熔断）</label>
    <label class="toggle"><input type="checkbox" id="dryRun"> 观察模式（只算不动手，先看它想切去哪）</label>
    <div class="muted">自动更新已被本插件关闭（防止版本被偷偷升级后热加载未重启）。以后手动更新 dsh-mobile-plugin 后重启一次即可。</div>
  </div>

  <div class="row" style="margin-top:18px">
    <button class="primary" id="save">保存</button>
    <button id="probe">立即探测并应用</button>
    <button id="heal">重启局域网入口</button>
    <button id="unwatchdog">解除自愈熔断</button>
    <button id="restartDsh">立即重启 DSH</button>
    <button id="reset">重置应用状态</button>
  </div>

  <h2>最近事件</h2>
  <ul class="hist" id="history"></ul>
</div>

<script>
(function () {
  var state = null;
  var selMode = 'multi';
  var dragId = null;
  var MODE_HELP = {
    'lan-first': '局域网优先：局域网健康就用它（多条网卡按延迟择优）；之后依次是 Tailscale 网卡线路、插件手填链路、DSH 直连隧道、中转。Tailscale 网卡（局域网）与 DSH 隧道是两条独立线路。',
    'auto': '自动择优：按质量（RTT）和稳定性（可用率、抖动）综合评分挑链路，明显更好才切换，带限抖保护。',
    'manual': '手动顺序：完全按下面勾选并排序的链路走；前一条连续不健康才让位给下一条。'
  };
  var NAMES = { lan: '局域网', 'lan-ts': '局域网·Tailscale 网卡', tailscale: 'Tailscale', manual: '插件手填链路', tailcat: 'DSH 直连隧道', relay: '中转' };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function ago(at) {
    if (!at) return '-';
    var sec = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
    return Math.round(sec / 3600) + ' 小时前';
  }
  /**
   * Resolve an API path against this page's own URL, not the document root.
   * The page may be served directly (path /dsh-mobile-route/panel), under the
   * legacy prefix (path /api/mobile-route/panel) or proxied behind the fnOS
   * gateway (path /app/NAME/dsh-mobile-route/panel), so a root-relative fetch
   * would target the wrong host path in the last case.
   * This page lives one segment under the API prefix, so stripping /panel
   * from location.pathname yields the API base in both cases.
   */
  function apiPath(path) {
    var here = location.pathname;
    // Strip a trailing /panel without a regex: a backslash inside this
    // template literal would be consumed by JS escaping and break the script.
    if (here.slice(-6) === '/panel') here = here.slice(0, -6);
    return here + path;
  }
  function post(path, body) {
    return fetch(apiPath(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (res) { return res.json(); });
  }
  function linkName(link) {
    if (link.group === 'lan') return '局域网 · ' + (link.interface || link.address);
    if (link.group === 'lan-ts') return '局域网·Tailscale 网卡 · ' + (link.interface || link.address);
    if (link.group === 'tailscale') return 'Tailscale · ' + (link.interface || link.address);
    if (link.group === 'manual') return '手填 · ' + (link.field || link.kind || link.address);
    return NAMES[link.group] || link.id;
  }

  function renderModes() {
    var host = $('modes');
    host.innerHTML = '';
    (state.modes || []).forEach(function (mode) {
      var btn = document.createElement('button');
      btn.textContent = mode === 'lan-first' ? '局域网优先' : mode === 'auto' ? '自动择优' : '手动顺序';
      if (state.config.mode === mode) btn.className = 'on';
      btn.onclick = function () { state.config.mode = mode; renderModes(); renderSections(); $('modeHelp').textContent = MODE_HELP[mode] || ''; };
      host.appendChild(btn);
    });
    $('modeHelp').textContent = MODE_HELP[state.config.mode] || '';
  }

  function renderSections() {
    $('manualSection').style.display = state.config.mode === 'manual' ? '' : 'none';
    $('autoSection').style.display = state.config.mode === 'auto' ? '' : 'none';
    if (state.config.mode === 'manual') renderOrder();
    if (state.config.mode === 'auto') renderAutoPolicy();
  }

  function renderLinkGroups() {
    var host = $('linkGroups');
    host.innerHTML = '';
    // 每条链路独立一张卡片：每个局域网 IP、Tailscale、手填链路、隧道、中转
    // 都平铺展示，不再按来源分组，一眼就能看到每条线路的状态。
    var links = state.links || [];
    links.forEach(function (link) {
      var ch = state.channels[link.id] || {};
      var cls = ch.ok ? (ch.fails ? 'warn' : 'ok') : 'bad';
      var label = ch.ok ? (ch.fails ? '不稳定' : '可用') : '不可达';
      var rtt = typeof ch.rttMs === 'number' ? Math.round(ch.rttMs) + '<small> ms</small>' : '<small>时延未知</small>';
      var detail = link.address || (link.group === 'tailcat'
        ? (state.relay && state.relay.tailcat && state.relay.tailcat.ready ? '内置隧道已就绪' : '内置隧道未就绪')
        : (state.relay && state.relay.relayUrl ? state.relay.relayUrl : '未配置'));
      var card = document.createElement('div');
      card.className = 'card ch';
      card.innerHTML = '<div class="top"><span class="name">' + esc(linkName(link)) + '</span>'
        + '<span class="pill ' + cls + '">' + label + '</span></div>'
        + '<div class="addr"><span class="pill src">' + esc(NAMES[link.group] || link.group) + '</span> ' + esc(detail) + '</div>'
        + '<div class="rtt">' + rtt + '</div>'
        + (ch.avgMs != null ? '<div class="muted">均值 ' + Math.round(ch.avgMs) + 'ms · 抖动 ' + Math.round(ch.jitterMs || 0) + 'ms · 可用率 ' + (ch.probes ? Math.round((ch.okCount||0)/ch.probes*100) : 0) + '%</div>' : '')
        + (ch.lastError ? '<div class="addr">' + esc(ch.lastError) + '</div>' : '');
      host.appendChild(card);
    });
  }

  function allLinkIds() { return (state.links || []).map(function (l) { return l.id; }); }
  function selected() {
    var sel = state.config.selection || [];
    return sel.filter(function (id) { return allLinkIds().indexOf(id) >= 0; });
  }
  function setSelected(ids) { state.config.selection = ids; }

  function renderSelModes() {
    var host = $('selModes');
    Array.prototype.forEach.call(host.querySelectorAll('button'), function (btn) {
      btn.className = btn.getAttribute('data-sel') === selMode ? 'on' : '';
    });
    $('selHint').textContent = selMode === 'single' ? '单选：点击一条链路即只用它。' : '多选：勾选多条链路并按顺序排列。';
  }

  function renderOrder() {
    renderSelModes();
    var host = $('order');
    host.innerHTML = '';
    var ids = allLinkIds();
    var chosen = selected();
    if (selMode === 'single') {
      // 单选：每条链路一个单选按钮，当前生效的那条高亮。
      ids.forEach(function (id) {
        var link = (state.links || []).find(function (l) { return l.id === id; });
        var li = document.createElement('li');
        var radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'singleLink'; radio.value = id;
        radio.checked = chosen.length === 1 && chosen[0] === id;
        radio.onchange = function () { setSelected([id]); renderOrder(); };
        li.appendChild(radio);
        var name = document.createElement('span');
        name.className = 'grow'; name.textContent = linkName(link);
        li.appendChild(name);
        host.appendChild(li);
      });
      return;
    }
    // 多选排序：已选条目可拖拽排序，未选条目提供「加入」按钮。
    chosen.forEach(function (id, index) {
      var link = (state.links || []).find(function (l) { return l.id === id; });
      var li = document.createElement('li');
      li.draggable = true;
      li.setAttribute('data-id', id);
      li.ondragstart = function (e) { dragId = id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
      li.ondragend = function () { li.classList.remove('dragging'); dragId = null; };
      li.ondragover = function (e) { e.preventDefault(); li.classList.add('dragover'); };
      li.ondragleave = function () { li.classList.remove('dragover'); };
      li.ondrop = function (e) {
        e.preventDefault(); li.classList.remove('dragover');
        if (!dragId || dragId === id) return;
        var next = chosen.slice();
        var from = next.indexOf(dragId);
        next.splice(from, 1);
        next.splice(next.indexOf(id), 0, dragId);
        setSelected(next); renderOrder();
      };
      var handle = document.createElement('span');
      handle.className = 'handle'; handle.textContent = '⠿';
      var idx = document.createElement('span');
      idx.className = 'idx'; idx.textContent = (index + 1);
      var name = document.createElement('span');
      name.className = 'grow'; name.textContent = linkName(link);
      var up = document.createElement('button');
      up.textContent = '↑'; up.disabled = index === 0;
      up.onclick = function () { move(index, -1); };
      var down = document.createElement('button');
      down.textContent = '↓'; down.disabled = index === chosen.length - 1;
      down.onclick = function () { move(index, 1); };
      var del = document.createElement('button');
      del.textContent = '移除';
      del.onclick = function () { setSelected(chosen.filter(function (x) { return x !== id; })); renderOrder(); };
      li.appendChild(handle); li.appendChild(idx); li.appendChild(name);
      li.appendChild(up); li.appendChild(down); li.appendChild(del);
      host.appendChild(li);
    });
    var rest = ids.filter(function (id) { return chosen.indexOf(id) < 0; });
    if (rest.length) {
      var addRow = document.createElement('div');
      addRow.className = 'row';
      addRow.style.marginTop = '8px';
      rest.forEach(function (id) {
        var link = (state.links || []).find(function (l) { return l.id === id; });
        var btn = document.createElement('button');
        btn.textContent = '+ ' + linkName(link);
        btn.onclick = function () { setSelected(chosen.concat([id])); renderOrder(); };
        addRow.appendChild(btn);
      });
      host.appendChild(addRow);
    }
  }

  function move(index, delta) {
    var next = selected().slice();
    var to = index + delta;
    if (to < 0 || to >= next.length) return;
    var tmp = next[index]; next[index] = next[to]; next[to] = tmp;
    setSelected(next); renderOrder();
  }

  function renderAutoPolicy() {
    var host = $('autoPolicy');
    host.innerHTML = '';
    var p = state.config.autoPolicy || {};
    var fields = [
      ['qualityWeight', '质量权重 (RTT)', 0, 1, 0.05],
      ['stabilityWeight', '稳定性权重', 0, 1, 0.05],
      ['switchRatio', '切换优势阈值', 0, 0.9, 0.05],
      ['maxFlapPer10m', '10 分钟限抖次数', 0, 20, 1],
      ['minDwellMs', '最短驻留 ms (0=自动)', 0, 120000, 1000]
    ];
    fields.forEach(function (f) {
      var label = document.createElement('label');
      label.className = 'field';
      label.textContent = f[1];
      var input = document.createElement('input');
      input.type = 'number';
      input.step = f[4];
      input.value = p[f[0]];
      input.onchange = function () {
        var v = Number(input.value);
        if (isFinite(v)) state.config.autoPolicy[f[0]] = v;
      };
      label.appendChild(input);
      host.appendChild(label);
    });
    var note = document.createElement('div');
    note.className = 'muted';
    note.style.gridColumn = '1 / -1';
    note.textContent = '综合分 = 质量权重 × RTT 得分 + 稳定性权重 × (可用率与抖动得分)。新链路必须比当前高「切换优势阈值」比例、且过了最短驻留时间才会切换；被频繁切回的链路会暂时拉黑。';
    host.appendChild(note);
  }

  function renderThresholds() {
    var host = $('thresholds');
    host.innerHTML = '';
    (state.channelsOrder || []).forEach(function (key) {
      var t = state.config.thresholds[key];
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<div style="font-weight:600;margin-bottom:8px">' + esc(NAMES[key] || key) + '</div>';
      var row = document.createElement('div');
      row.className = 'row';
      [['degradeMs', '降级阈值 ms'], ['restoreMs', '恢复阈值 ms'], ['fails', '连续失败次数']].forEach(function (pair) {
        var label = document.createElement('label');
        label.className = 'field';
        label.textContent = pair[1];
        var input = document.createElement('input');
        input.type = 'number';
        input.value = t[pair[0]];
        input.onchange = function () {
          var v = parseInt(input.value, 10);
          if (isFinite(v) && v > 0) state.config.thresholds[key][pair[0]] = v;
        };
        label.appendChild(input);
        row.appendChild(label);
      });
      card.appendChild(row);
      host.appendChild(card);
    });
  }

  function renderHistory() {
    var host = $('history');
    host.innerHTML = '';
    (state.history || []).forEach(function (entry) {
      var li = document.createElement('li');
      li.textContent = ago(entry.at) + ' · ' + entry.kind + ' · ' + entry.reason;
      host.appendChild(li);
    });
  }

  function renderBanner() {
    var host = $('banner');
    if (state.lastError) {
      host.innerHTML = '<div class="banner bad">最近一次错误：' + esc(state.lastError) + '</div>';
      return;
    }
    var warnings = (state.decision && state.decision.warnings) || [];
    if (warnings.length) {
      host.innerHTML = '<div class="banner bad">' + warnings.map(esc).join('<br>') + '</div>';
      return;
    }
    if (state.config.dryRun) {
      host.innerHTML = '<div class="banner ok">观察模式：现在只计算不执行。</div>';
      return;
    }
    host.innerHTML = '';
  }

  function render() {
    if (!state) return;
    var target = state.decision.target || '-';
    var link = (state.links || []).find(function (l) { return l.id === target; });
    $('target').textContent = link ? linkName(link) : (NAMES[target] || target);
    $('reason').textContent = state.decision.reason || '-';
    $('probeAt').textContent = ago(state.lastProbeAt);
    var sc = state.relay && state.relay.sidecar;
    $('sidecar').textContent = typeof sc === 'string' ? sc : (sc && sc.state) || '未知';
    var wd = state.watchdog || {};
    $('watchdog').textContent = wd.tripped
      ? '已熔断（' + (wd.restartsInWindow || 0) + ' 次重启，' + ago(wd.trippedUntil) + '后恢复）'
      : '正常（窗口内 ' + (wd.restartsInWindow || 0) + ' 次重启）';
    var rg = state.restartGuard || {};
    if (rg.pending) $('restartGuard').textContent = '正在重启 DSH…';
    else if (rg.diskVersion && rg.runningVersion && rg.diskVersion !== rg.runningVersion)
      $('restartGuard').textContent = '版本不一致 ' + esc(rg.runningVersion) + '→' + esc(rg.diskVersion) + '（将自动重启）';
    else $('restartGuard').textContent = (rg.enabled ? '正常' : '已关闭') + ' · 自动更新' + (rg.autoUpdateOff ? '已关' : '开启') + ' · ' + esc(rg.lastResult || '');
    $('allowDisableTailcat').checked = !!state.config.allowDisableTailcat;
    $('autoHealSidecar').checked = !!state.config.autoHealSidecar;
    $('restartGuardEnabled').checked = !!(state.config.restartGuard && state.config.restartGuard.enabled);
    $('dryRun').checked = !!state.config.dryRun;
    renderBanner();
    renderModes();
    renderLinkGroups();
    renderSections();
    renderThresholds();
    renderHistory();
  }

  function load() {
    fetch(apiPath('/state'), { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var wasMode = state && state.config.mode;
        state = data;
        // 单选/多选跟随当前选择长度推断；用户手动切换后本轮内保持。
        if (!selMode) selMode = 'multi';
        render();
      })
      .catch(function (err) { $('banner').innerHTML = '<div class="banner bad">读取状态失败：' + esc(err.message) + '</div>'; });
  }

  Array.prototype.forEach.call($('selModes').querySelectorAll('button'), function (btn) {
    btn.onclick = function () { selMode = btn.getAttribute('data-sel'); renderOrder(); };
  });

  $('save').onclick = function () {
    var patch = {
      mode: state.config.mode,
      selection: state.config.selection || [],
      autoPolicy: state.config.autoPolicy || {},
      thresholds: state.config.thresholds,
      allowDisableTailcat: $('allowDisableTailcat').checked,
      autoHealSidecar: $('autoHealSidecar').checked,
      restartGuard: { enabled: $('restartGuardEnabled').checked },
      dryRun: $('dryRun').checked
    };
    post('/config', patch).then(function (result) {
      if (result.state) { state = result.state; render(); }
      $('banner').innerHTML = result.ok
        ? '<div class="banner ok">已保存' + (result.persisted ? '' : '（本次会话有效，重启后会回到 bundle 行里的配置）') + '</div>'
        : '<div class="banner bad">保存失败：' + esc(result.message || '') + '</div>';
    });
  };
  $('probe').onclick = function () { post('/action', { action: 'probe' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('heal').onclick = function () { post('/action', { action: 'heal' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('reset').onclick = function () { post('/action', { action: 'reset' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('unwatchdog').onclick = function () { post('/action', { action: 'reset-watchdog' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('restartDsh').onclick = function () {
    var btn = this; btn.disabled = true;
    post('/action', { action: 'restart-dsh' }).then(function (r) {
      if (r.state) { state = r.state; render(); }
      $('banner').innerHTML = '<div class="banner ok">已发起重启，DSH 将在几秒内恢复；页面会自动重连。</div>';
    });
  };

  load();
  setInterval(load, 5000);
})();
</script>
</body>
</html>`

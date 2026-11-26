// 配置面板：一个自包含的 HTML 页面，挂在 /api/mobile-route/panel。
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
  .wrap { max-width: 860px; margin: 0 auto; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .ch { display: flex; flex-direction: column; gap: 6px; }
  .ch .top { display: flex; justify-content: space-between; align-items: baseline; }
  .ch .name { font-weight: 600; }
  .ch .addr { color: var(--muted); font-size: 12px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .rtt { font-size: 22px; font-variant-numeric: tabular-nums; }
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
  input[type=number] { font: inherit; width: 92px; padding: 6px 8px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .order li { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  .order li .idx { color: var(--muted); width: 18px; }
  .order li .grow { flex: 1; }
  .order li button { padding: 2px 8px; }
  .hist { list-style: none; margin: 0; padding: 0; font-size: 12px; color: var(--muted); max-height: 220px; overflow: auto; }
  .hist li { padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .kv { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .banner { border-radius: 8px; padding: 10px 12px; margin: 12px 0; font-size: 13px; }
  .banner.bad { background: rgba(180,35,24,.10); color: var(--bad); border: 1px solid var(--bad); }
  .banner.ok { background: rgba(20,128,74,.10); color: var(--ok); border: 1px solid var(--ok); }
  .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>手机连接选路</h1>
  <div class="sub">按实测延迟决定手机该走局域网、Tailscale 还是直连隧道。改动会写进 dsh-mobile-plugin 的候选地址与隧道开关。</div>

  <div id="banner"></div>

  <div class="card">
    <div class="kv">
      <span>当前生效：<b id="target">-</b></span>
      <span>原因：<span id="reason">-</span></span>
      <span>上次探测：<span id="probeAt">-</span></span>
      <span>插件状态：<span id="sidecar">-</span></span>
    </div>
  </div>

  <h2>模式</h2>
  <div class="tabs" id="modes"></div>
  <div class="sub" style="margin-top:8px" id="modeHelp"></div>

  <h2>各通道实测</h2>
  <div class="grid" id="channels"></div>

  <h2>手动顺序（仅「手动」模式生效）</h2>
  <ul class="order" id="order"></ul>

  <h2>阈值</h2>
  <div class="grid" id="thresholds"></div>

  <h2>开关</h2>
  <div class="card" style="display:flex;flex-direction:column;gap:12px">
    <label class="toggle"><input type="checkbox" id="allowDisableTailcat"> 允许在局域网健康时关闭直连隧道（逼手机走局域网）</label>
    <label class="toggle"><input type="checkbox" id="autoHealSidecar"> 局域网入口挂了时自动重启插件的 sidecar</label>
    <label class="toggle"><input type="checkbox" id="dryRun"> 观察模式（只算不动手，先看它想切去哪）</label>
  </div>

  <div class="row" style="margin-top:18px">
    <button class="primary" id="save">保存</button>
    <button id="probe">立即探测并应用</button>
    <button id="heal">重启局域网入口</button>
    <button id="reset">重置应用状态</button>
  </div>

  <h2>最近事件</h2>
  <ul class="hist" id="history"></ul>
</div>

<script>
(function () {
  var state = null;
  var MODE_HELP = {
    'lan-first': '局域网优先：局域网健康就用它；不健康时依次退到 Tailscale、直连隧道、中转。',
    'auto': '自动择优：在健康通道里挑延迟最低的那条，只有明显更快（25% 以上）才切换。',
    'manual': '严格手动：完全按下面的顺序走，前一条连续不健康才让位。'
  };
  var NAMES = { lan: '局域网', tailscale: 'Tailscale', tailcat: '直连隧道', relay: '中转' };

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
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (res) { return res.json(); });
  }

  function renderModes() {
    var host = $('modes');
    host.innerHTML = '';
    (state.modes || []).forEach(function (mode) {
      var btn = document.createElement('button');
      btn.textContent = mode === 'lan-first' ? '局域网优先' : mode === 'auto' ? '自动择优' : '手动顺序';
      if (state.config.mode === mode) btn.className = 'on';
      btn.onclick = function () {
        state.config.mode = mode;
        renderModes();
        $('modeHelp').textContent = MODE_HELP[mode] || '';
      };
      host.appendChild(btn);
    });
    $('modeHelp').textContent = MODE_HELP[state.config.mode] || '';
  }

  function renderChannels() {
    var host = $('channels');
    host.innerHTML = '';
    (state.channelsOrder || []).forEach(function (key) {
      var ch = state.channels[key] || {};
      var addr = key === 'lan' ? state.addresses.lan : key === 'tailscale' ? state.addresses.tailscale : '';
      var cls = ch.ok ? (ch.fails ? 'warn' : 'ok') : 'bad';
      var label = ch.ok ? (ch.fails ? '不稳定' : '可用') : '不可达';
      var rtt = typeof ch.rttMs === 'number' ? Math.round(ch.rttMs) + '<small> ms</small>' : '<small>时延未知</small>';
      var card = document.createElement('div');
      card.className = 'card ch';
      card.innerHTML = '<div class="top"><span class="name">' + esc(NAMES[key] || key) + '</span>'
        + '<span class="pill ' + cls + '">' + label + '</span></div>'
        + '<div class="rtt">' + rtt + '</div>'
        + '<div class="addr">' + esc(addr || (key === 'tailcat' ? (state.relay && state.relay.tailcat && state.relay.tailcat.ready ? '内置隧道已就绪' : '内置隧道未就绪') : key === 'relay' ? (state.relay && state.relay.relayUrl ? state.relay.relayUrl : '未配置中转') : '未找到地址')) + '</div>'
        + (ch.lastError ? '<div class="addr">' + esc(ch.lastError) + '</div>' : '');
      host.appendChild(card);
    });
  }

  function renderOrder() {
    var host = $('order');
    host.innerHTML = '';
    (state.config.order || []).forEach(function (key, index) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="idx">' + (index + 1) + '</span><span class="grow">' + esc(NAMES[key] || key) + '</span>';
      var up = document.createElement('button');
      up.textContent = '↑'; up.disabled = index === 0;
      up.onclick = function () { move(index, -1); };
      var down = document.createElement('button');
      down.textContent = '↓'; down.disabled = index === state.config.order.length - 1;
      down.onclick = function () { move(index, 1); };
      li.appendChild(up); li.appendChild(down);
      host.appendChild(li);
    });
  }

  function move(index, delta) {
    var order = state.config.order.slice();
    var next = index + delta;
    if (next < 0 || next >= order.length) return;
    var tmp = order[index]; order[index] = order[next]; order[next] = tmp;
    state.config.order = order;
    renderOrder();
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
    $('target').textContent = state.decision.target ? (NAMES[state.decision.target] || state.decision.target) : '-';
    $('reason').textContent = state.decision.reason || '-';
    $('probeAt').textContent = ago(state.lastProbeAt);
    $('sidecar').textContent = (state.relay && state.relay.sidecar) || '-';
    $('allowDisableTailcat').checked = !!state.config.allowDisableTailcat;
    $('autoHealSidecar').checked = !!state.config.autoHealSidecar;
    $('dryRun').checked = !!state.config.dryRun;
    renderBanner();
    renderModes();
    renderChannels();
    renderOrder();
    renderThresholds();
    renderHistory();
  }

  function load() {
    fetch('/api/mobile-route/state', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) { state = data; render(); })
      .catch(function (err) { $('banner').innerHTML = '<div class="banner bad">读取状态失败：' + esc(err.message) + '</div>'; });
  }

  $('save').onclick = function () {
    var patch = {
      mode: state.config.mode,
      order: state.config.order,
      thresholds: state.config.thresholds,
      allowDisableTailcat: $('allowDisableTailcat').checked,
      autoHealSidecar: $('autoHealSidecar').checked,
      dryRun: $('dryRun').checked
    };
    post('/api/mobile-route/config', patch).then(function (result) {
      if (result.state) { state = result.state; render(); }
      $('banner').innerHTML = result.ok
        ? '<div class="banner ok">已保存' + (result.persisted ? '' : '（本次会话有效，重启后会回到 bundle 行里的配置）') + '</div>'
        : '<div class="banner bad">保存失败：' + esc(result.message || '') + '</div>';
    });
  };
  $('probe').onclick = function () { post('/api/mobile-route/action', { action: 'probe' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('heal').onclick = function () { post('/api/mobile-route/action', { action: 'heal' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };
  $('reset').onclick = function () { post('/api/mobile-route/action', { action: 'reset' }).then(function (r) { if (r.state) { state = r.state; render(); } }); };

  load();
  setInterval(load, 5000);
})();
</script>
</body>
</html>`

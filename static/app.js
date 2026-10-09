/* Mac 状态监控中心 — 零依赖：SSE + 手写 Canvas
 * 数据 = mactop --headless --format json 原样转发。
 * 布局 = 顶栏 + 4 列网格（3 行指标 + 底部整排进程）。
 * 新增利用的 mactop 域：监听端口明细、内存分段条/压力、包速率、电池、TB 网流量。
 */
(() => {
'use strict';

/* ============================ 工具 ============================ */
const $ = id => document.getElementById(id);
const MONO = '"SF Mono",ui-monospace,Menlo,monospace';
const CL = {
  blue:'#5f9dff', purple:'#8b7cf6', mint:'#4ade80',
  amber:'#e0a34e', red:'#ef6a6a', violet:'#c0b3ff', white:'#e8eefb'
};
const FAINT = 'rgba(255,255,255,.055)';
const DIM = 'rgba(180,195,220,.6)';
const GB = 1073741824;

const clamp = (v,a,b) => v<a?a:v>b?b:v;
const lerp  = (a,b,t) => a+(b-a)*t;
const rgba  = (hex,a) => { const n=parseInt(hex.slice(1),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; };

function fmtBps(b){
  b = Math.max(0, b||0);
  if (b >= 1e9) return (b/1e9).toFixed(2) + ' GB/s';
  if (b >= 1e6) return (b/1e6).toFixed(1) + ' MB/s';
  if (b >= 1e3) return (b/1e3).toFixed(1) + ' KB/s';
  return Math.round(b) + ' B/s';
}
function fmtMB(kb){
  const mb = (kb||0) / 1024;
  return mb >= 1024 ? (mb/1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}
function niceMax(m){
  if (!(m > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  const d = m / p;
  return (d<=1?1 : d<=2?2 : d<=2.5?2.5 : d<=5?5 : 10) * p;
}
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
/* 中点二次贝塞尔：平滑曲线 */
function traceSmooth(ctx, pts){
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++){
    const xm = (pts[i][0]+pts[i+1][0])/2, ym = (pts[i][1]+pts[i+1][1])/2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], xm, ym);
  }
  const n = pts.length;
  ctx.quadraticCurveTo(pts[n-1][0], pts[n-1][1], pts[n-1][0], pts[n-1][1]);
}
function tempColor(t){ return t >= 85 ? CL.red : t >= 70 ? CL.amber : CL.mint; }

/* ==================== 画布挂载 / 渲染调度 ==================== */
const tasks = [], charts = [];
function mountCanvas(id){
  const el = $(id); if (!el) return null;
  const ctx = el.getContext('2d');
  const it = { ctx, w:0, h:0 };
  const fit = () => {
    const r = el.getBoundingClientRect();
    const d = clamp(window.devicePixelRatio || 1, 1, 2);
    it.w = Math.max(1, Math.round(r.width));
    it.h = Math.max(1, Math.round(r.height));
    el.width = it.w*d; el.height = it.h*d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  new ResizeObserver(fit).observe(el);
  fit();
  return it;
}
(function loop(){
  for (const t of tasks) if (t.dirty) { try { t.draw(); } catch (e) { /* 单卡异常不拖垮全局 */ } }
  requestAnimationFrame(loop);
})();

/* ============================ 数据状态 ============================ */
const HIST = 60;
const hist = {
  power:[], netIn:[], netOut:[],
  diskR:[], diskW:[], fan:[], fan2:[], dramR:[], dramW:[]
};
let latest = null, info = null, sortKey = 'cpu', query = '';

function push(a, v){ a.push(v); if (a.length > HIST) a.shift(); }

/* ============================ 环形仪表（270°，环心数字） ============================ */
function addRing(canvasId, colorOf, valOf, tickAt){
  const el = $(canvasId); if (!el) return;
  const ctx = el.getContext('2d');
  const it = { ctx, w:0, h:0 };
  const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
  let v = 0;
  const t = { dirty:true };
  const fit = () => {
    const r = el.getBoundingClientRect();
    const d = clamp(window.devicePixelRatio || 1, 1, 2);
    it.w = Math.max(1, Math.round(r.width));
    it.h = Math.max(1, Math.round(r.height));
    el.width = it.w*d; el.height = it.h*d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  new ResizeObserver(fit).observe(el);
  fit();

  t.draw = () => {
    const target = clamp(valOf(), 0, 100);
    v = Math.abs(target - v) < 0.4 ? target : lerp(v, target, 0.12);
    const { w, h } = it, cx = w/2, cy = h/2;
    const r = Math.min(w, h)/2 - 9;
    ctx.clearRect(0, 0, w, h);

    /* 轨道 */
    ctx.beginPath(); ctx.arc(cx, cy, r, START, START + SWEEP);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.stroke();

    /* 刻度：0/25/50/75/100 */
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++){
      const a = START + SWEEP * (i/4);
      ctx.beginPath();
      ctx.moveTo(cx + (r-5.5) * Math.cos(a), cy + (r-5.5) * Math.sin(a));
      ctx.lineTo(cx + (r+5.5) * Math.cos(a), cy + (r+5.5) * Math.sin(a));
      ctx.stroke();
    }

    /* 告警线 */
    if (tickAt != null){
      const ta = START + SWEEP * (tickAt/100);
      ctx.beginPath();
      ctx.moveTo(cx + (r-9) * Math.cos(ta), cy + (r-9) * Math.sin(ta));
      ctx.lineTo(cx + (r+9) * Math.cos(ta), cy + (r+9) * Math.sin(ta));
      ctx.strokeStyle = rgba(CL.red, .95); ctx.lineWidth = 2.5; ctx.stroke();
    }

    /* 进度弧（更粗，明显可见） */
    const frac = clamp(v, 0, 1);
    if (frac > 0.004){
      const col = colorOf(v);
      ctx.save();
      ctx.shadowColor = rgba(col, .5); ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(cx, cy, r, START, START + SWEEP * frac);
      ctx.strokeStyle = col; ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.stroke(); ctx.restore();
      const ea = START + SWEEP * frac;
      ctx.beginPath();
      ctx.arc(cx + r * Math.cos(ea), cy + r * Math.sin(ea), 3.2, 0, Math.PI*2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    t.dirty = v !== target;
  };
  tasks.push(t); charts.push(t);
}

/* ============================ 折线图（平滑 + 同色填充 + 软网格） ============================ */
function addLineChart(id, series, unitFmt, label){
  const it = mountCanvas(id); if (!it) return;
  const t = { dirty:true };
  t.draw = () => {
    const { ctx, w, h } = it;
    ctx.clearRect(0, 0, w, h);
    let max = 0;
    for (const s of series) for (const v of s.get()) if (v > max) max = v;
    max = niceMax(max);
    const padL = 46, padR = 6, padT = 8, padB = 14;
    const gw = w - padL - padR, gh = h - padT - padB;

    ctx.font = '9.5px ' + MONO;
    for (let i = 0; i <= 4; i++){
      const y = padT + gh * i / 4;
      ctx.strokeStyle = FAINT; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = DIM; ctx.textAlign = 'right';
      ctx.fillText(unitFmt(max * (1 - i/4)), padL - 5, y + 3);
    }
    for (let s = 15; s < HIST; s += 15){
      const x = padL + gw * s / HIST;
      ctx.strokeStyle = FAINT;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke();
    }
    ctx.fillStyle = DIM; ctx.textAlign = 'left';
    ctx.fillText('−60s', padL + 2, h - 2);
    ctx.textAlign = 'right'; ctx.fillText('now', w - padR - 1, h - 2);
    ctx.textAlign = 'left';

    series.forEach((s, si) => {
      const data = s.get();
      if (data.length < 2) return;
      const pts = data.map((val, i) => [
        padL + gw * (i + 0.5) / data.length,
        padT + gh * (1 - clamp(val / max, 0, 1))
      ]);
      ctx.beginPath(); traceSmooth(ctx, pts);
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.lineTo(pts[pts.length-1][0], padT + gh);
      ctx.lineTo(pts[0][0], padT + gh);
      ctx.closePath();
      const grd = ctx.createLinearGradient(0, padT, 0, padT + gh);
      grd.addColorStop(0, rgba(s.color, .2));
      grd.addColorStop(1, rgba(s.color, .01));
      ctx.fillStyle = grd; ctx.fill();
      /* 图例：线尾色点 + 名称（双线时才画） */
      if (series.length > 1 && label){
        const lx = w - padR - 6, ly = padT + 9 + si * 13;
        ctx.beginPath(); ctx.arc(lx - 62, ly - 3, 2.6, 0, Math.PI*2);
        ctx.fillStyle = s.color; ctx.fill();
        ctx.fillStyle = DIM; ctx.textAlign = 'left';
        ctx.fillText(label[si], lx - 54, ly);
      }
    });
    t.dirty = false;
  };
  tasks.push(t); charts.push(t);
}

/* ============================ 每核柱状图（E 蓝 / P 紫） ============================ */
function addCoresChart(id){
  const it = mountCanvas(id); if (!it) return;
  const t = { dirty:true };
  t.draw = () => {
    const { ctx, w, h } = it;
    ctx.clearRect(0, 0, w, h);
    if (!latest) return;
    const cu = latest.core_usages || [];
    const n = cu.length; if (!n) return;
    const eCount = (info && info.e_core_count) || Math.round(n / 3);
    const gh = h - 20;
    const slot = w / n, bw = slot * 0.62;
    const max = niceMax(Math.max(1, ...cu));
    ctx.strokeStyle = FAINT;
    for (let i = 0; i <= 4; i++){
      const y = 4 + gh * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    let peak = 0, peakIdx = 0, sum = 0;
    for (let i = 0; i < n; i++){
      const x = i * slot + (slot - bw) / 2;
      const bh = gh * clamp(cu[i] / max, 0, 1);
      const col = i < eCount ? CL.blue : CL.purple;
      ctx.fillStyle = rgba(col, cu[i] >= 55 ? .95 : .5);
      ctx.fillRect(x, 4 + gh - bh, bw, bh);
      if (cu[i] > peak){ peak = cu[i]; peakIdx = i; }
      sum += cu[i];
    }
    ctx.font = '9px ' + MONO; ctx.fillStyle = DIM;
    ctx.fillText('E ×' + eCount + ' · P ×' + (n - eCount), 2, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText('峰 ' + Math.round(peak) + '% (核' + (peakIdx+1) + ') · 均 ' + Math.round(sum/n) + '%', w - 2, h - 4);
    ctx.textAlign = 'left';
    t.dirty = false;
  };
  tasks.push(t); charts.push(t);
}

/* ============================ 温度分组 ============================ */
function renderTempList(){
  const host = $('temp-list');
  if (!host || !latest || !latest.temperatures) return;
  const groups = (latest.temperatures || []).slice()
    .sort((a, b) => b.avg_celsius - a.avg_celsius).slice(0, 5);
  host.innerHTML = groups.map(g => {
    const col = tempColor(g.avg_celsius);
    const title = `${g.group}：平均 ${g.avg_celsius.toFixed(1)}°C · 最低 ${g.min_celsius.toFixed(1)}°C · ` +
                  `峰值 ${g.max_celsius.toFixed(1)}°C · ${g.sensor_count} 个传感器`;
    return `<div class="tp" title="${esc(title)}">` +
      `<div class="tp-top"><span class="nm">${esc(g.group)}</span>` +
      `<span class="av" style="color:${col}">${Math.round(g.avg_celsius)}°</span></div>` +
      `<span class="tp-bar"><i style="width:${clamp(g.avg_celsius,0,100)}%;background:${rgba(col,.8)}"></i>` +
      `<b style="left:${clamp(g.max_celsius,0,100)}%"></b></span></div>`;
  }).join('');
}

/* ============================ 存储卷 ============================ */
function renderVols(){
  const host = $('vols'); if (!host || !latest || !latest.volumes) return;
  host.innerHTML = (latest.volumes || []).map(v => {
    const hot = v.used_percent >= 85;
    return `<div class="vol" title="${esc(v.name)}：已用 ${v.used_gb.toFixed(1)} GB / 共 ${v.total_gb.toFixed(1)} GB">` +
      `<div class="vol-top"><span>${esc(v.name)}</span>` +
      `<b>${v.used_gb.toFixed(0)} / ${v.total_gb.toFixed(0)} GB · ${v.used_percent.toFixed(0)}%</b></div>` +
      `<div class="vol-bar"><i class="${hot?'hot':''}" style="width:${clamp(v.used_percent,0,100)}%"></i></div></div>`;
  }).join('');
}

/* ============================ 监听端口 ============================ */
function renderPorts(){
  const host = $('portlist');
  if (!host || !latest) return;
  const ports = (latest.ports || []).slice()
    .sort((a, b) => (b.established - a.established) || (b.external - a.external) || (a.port - b.port));
  const psum = latest.ports_summary || {};
  $('sub-ports').textContent = `${psum.total||0} 监听 · ${psum.external||0} 对外 · 建连 ${ports.filter(p=>p.established>0).length}`;
  if (!ports.length){ host.innerHTML = '<div class="tbl-empty">无监听端口</div>'; return; }
  host.innerHTML = ports.slice(0, 20).map(p => {
    const cls = 'pt' + (p.external ? ' ext' : '') + (p.established > 0 ? ' est' : '');
    const title = `${p.command} · ${p.protocol} ${p.bind}:${p.port} · PID ${p.pid} · 用户 ${p.user}` +
                  `${p.external ? ' · 对外开放' : ''}${p.established ? ` · 已建连 ${p.established}` : ''}`;
    return `<div class="${cls}" title="${esc(title)}">` +
      `<span class="po">${p.port}</span>` +
      `<span class="pr">${esc(p.protocol)}${p.external ? '·外' : ''}</span>` +
      `<span class="pc">${esc(p.command)}</span></div>`;
  }).join('');
}

/* ============================ 外设与供电 ============================ */
function renderPeriph(){
  const host = $('plist'); if (!host || !latest) return;
  const ps   = latest.power_supply || {};
  const bat  = latest.battery || {};
  const link = latest.network_links || {};
  const eth  = (link.ethernet || []);
  const up   = eth.filter(l => l.link_up);
  const wifi = link.wifi || {};
  const tb   = (latest.thunderbolt_info && latest.thunderbolt_info.buses) || [];
  const tbUp = tb.filter(b => /^active$/i.test((b.status||'').trim()));
  const rdma = latest.rdma_status || {};
  const psum = latest.ports_summary || {};

  const rows = [
    ['供电', ps.on_ac_power
        ? `AC<em> · 适配器 ${ps.adapter_watts||0}W</em>`
        : (bat.present ? `电池 <em>${bat.percent ?? '—'}%</em>${bat.charging ? ' 充电中' : ''}` : (ps.source || '—'))],
    ['有线', up.length
        ? up.map(l => `${l.name} <em>${l.speed_formatted}</em>`).join(' · ')
        : `${eth.length} 口全 <s>down</s>`],
    ['Wi-Fi', wifi.connected
        ? `${wifi.interface||'—'} <em>${wifi.generation||wifi.phy_mode||'—'}</em> ${wifi.tx_rate_mbps||0}Mbps`
        : '<s>未连接</s>'],
    ['雷电', tb.length
        ? `${tb.length} 总线 · <em>${tbUp.length} 活跃</em>${tbUp.length ? ' · ' + esc(tbUp.map(b => b.name.replace('TB4 Bus ','#')).join(' ')) : ''}`
        : '—'],
    ['RDMA', rdma.available ? '<em>就绪</em>' : `<s>${rdma.status||'不可用'}</s>`],
    ['端口', `${psum.total||0} 监听 · <em>${psum.external||0} 对外</em>`]
  ];
  host.innerHTML = rows.map(([k, v]) =>
    `<div class="pl"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('');
}

/* ============================ 进程 TOP（整排宽表） ============================ */
/* 注意：mactop 的 memory_percent = RSS / 整机内存 ×100（processes.go:136），
 * 192GB 机器上普遍 <1%，用它做阈值会过滤掉全部进程 —— 内存维度改用 RSS(kB)。 */
function procKey(p){
  return sortKey === 'cpu' ? p.cpu_percent
       : sortKey === 'mem' ? (p.rss_kb || 0)
       : p.gpu_ms_per_sec;
}
function renderProcs(){
  const tb = document.querySelector('#proc-table tbody');
  if (!tb || !latest) return;
  const all = (latest.processes || []).slice();
  let rows = all;
  if (query){
    const q = query.toLowerCase();
    rows = all.filter(p => p.command.toLowerCase().includes(q));
  }
  rows.sort((a, b) => procKey(b) - procKey(a));
  /* 仅过滤完全无活动的进程；若过滤后不足 5 行则回退，保证任何排序都有内容 */
  if (!query){
    const filtered = rows.filter(p => sortKey === 'cpu' ? p.cpu_percent >= 0.5 : procKey(p) >= 1);
    rows = filtered.length >= 5 ? filtered : rows.slice(0, Math.min(15, rows.length));
  }
  rows = rows.slice(0, 40);
  const unitName = sortKey === 'cpu' ? 'CPU 占用' : sortKey === 'mem' ? '内存占用' : 'GPU 占用';
  $('sub-procs').textContent = query
    ? `匹配 ${rows.length} / ${all.length}`
    : `${unitName} TOP ${rows.length} / 共 ${all.length}`;
  if (!rows.length){
    tb.innerHTML = '<tr><td class="tbl-empty" colspan="6">无匹配进程</td></tr>';
    return;
  }
  const top = Math.max(...rows.map(procKey), 1);
  tb.innerHTML = rows.map(p => {
    const k = procKey(p);
    const hot = sortKey === 'cpu' ? p.cpu_percent > 25 : sortKey === 'mem' ? p.rss_kb > 4e6 : p.gpu_ms_per_sec > 50;
    const col = sortKey === 'cpu' ? CL.blue : sortKey === 'mem' ? CL.mint : CL.violet;
    const title = `${p.command}\nPID ${p.pid} · RSS ${fmtMB(p.rss_kb)} · CPU ${p.cpu_percent.toFixed(1)}% · ` +
                  `内存 ${p.memory_percent.toFixed(2)}% · GPU ${Math.round(p.gpu_ms_per_sec)} ms/s`;
    return `<tr class="${hot ? 'hot' : ''}" title="${esc(title)}">` +
      `<td class="num">${p.pid}</td>` +
      `<td title="${esc(p.command)}">${esc(p.command)}</td>` +
      `<td><span class="pbar"><i style="width:${clamp(k/top*100, 2, 100)}%;background:${col}"></i></span></td>` +
      `<td class="num">${p.cpu_percent.toFixed(1)}</td>` +
      `<td class="num">${fmtMB(p.rss_kb)}</td>` +
      `<td class="num">${p.gpu_ms_per_sec > 0.5 ? Math.round(p.gpu_ms_per_sec) : '—'}</td></tr>`;
  }).join('');
}

/* ============================ 顶栏 ============================ */
function renderTop(){
  if (!latest) return;
  if (latest.system_info){
    info = latest.system_info;
    $('chip-machine').textContent = info.name || 'Apple Silicon';
    $('chip-cores').textContent = `${info.e_core_count||0}E + ${info.p_core_count||0}P · ${info.core_count||0}核`;
    $('chip-gpu').textContent = `${info.gpu_core_count||0}核 GPU`;
  }
  const ps = latest.power_supply || {};
  const bat = latest.battery || {};
  $('chip-psu').textContent = ps.on_ac_power
    ? `AC 供电` : (bat.present ? `电池 ${bat.percent ?? '—'}%${bat.charging ? ' ⚡' : ''}` : '—');
  const links = latest.network_links || {};
  const upEth = (links.ethernet || []).filter(l => l.link_up);
  const wifi = links.wifi && links.wifi.connected ? links.wifi : null;
  $('chip-link').textContent = upEth.length
    ? upEth.map(l => `${l.name} ${l.speed_formatted}`).join(' · ')
    : (wifi ? `WiFi ${wifi.interface} ${wifi.generation || ''}`.trim() : '链路 —');
  const tb = (latest.thunderbolt_info && latest.thunderbolt_info.buses) || [];
  const tbUp = tb.filter(b => /^active$/i.test((b.status||'').trim()));
  const rdma = latest.rdma_status || {};
  $('chip-tb').textContent = `TB ${tbUp.length}/${tb.length} · RDMA ${rdma.available ? '就绪' : (rdma.status || 'off')}`;

  const pkg = (latest.temperatures||[]).find(g => /package/i.test(g.group)) || {};
  const mx = Math.round(pkg.avg_celsius || (latest.soc_metrics||{}).soc_temp || 0);
  const state = latest.thermal_state || '';
  const bad  = /严重|critical|serious|过热/i.test(state) || mx >= 90;
  const warn = /偏高|fair|warn/i.test(state) || mx >= 78;
  $('thermal-badge').querySelector('.dot').className = 'dot ' + (bad ? 'bad' : warn ? 'warn' : 'ok');
  $('thermal-text').textContent = `${state || '—'} ${mx}°C`;
}
function streamBadge(cls, txt){
  $('stream-badge').querySelector('.dot').className = 'dot ' + cls;
  $('stream-badge').querySelector('.st').textContent = txt;
}

/* ============================ 卡片数字 / 脚注 ============================ */
function renderTexts(){
  if (!latest) return;
  const sm = latest.soc_metrics || {}, mem = latest.memory || {}, nd = latest.net_disk || {};
  const fans = latest.fans || [];

  /* ---- CPU：环心大数字 + E/P 集群数据条 ---- */
  const eA = latest.ecpu_usage || [0,0], pA = latest.pcpu_usage || [0,0];
  const cu = latest.core_usages || [];
  const peakCore = cu.length ? cu.reduce((m, v, i) => v > cu[m] ? i : m, 0) : -1;
  $('num-cpu').textContent = Math.round(latest.cpu_usage||0);
  $('sub-cpu').textContent = `E ${eA[0]||'—'} MHz　|　P ${pA[0]||'—'} MHz`;
  $('cpu-e-bar').style.width = clamp(eA[1]||0, 0, 100) + '%';
  $('cpu-e').textContent = `${Math.round(eA[1]||0)}%`;
  $('cpu-p-bar').style.width = clamp(pA[1]||0, 0, 100) + '%';
  $('cpu-p').textContent = `${Math.round(pA[1]||0)}%`;
  $('cpu-peak-bar').style.width = clamp(cu[peakCore]||0, 0, 100) + '%';
  $('cpu-peak').textContent = peakCore >= 0 ? `核${peakCore+1} ${Math.round(cu[peakCore])}%` : '—';

  /* ---- GPU：环心大数字 + 活跃度/算力数据条 ---- */
  const gm = latest.gpu_metrics || {};
  $('num-gpu').textContent = Math.round(latest.gpu_usage||0);
  $('sub-gpu').textContent = `${gm.freq_mhz||'—'} MHz`;
  const tf32 = latest.tflops_fp32||0, tf16 = latest.tflops_fp16||0;
  const tfMax = Math.max(tf32, tf16, 1);
  $('gpu-act-bar').style.width = clamp(gm.active_percent||0, 0, 100) + '%';
  $('gpu-act').textContent = `${Math.round(gm.active_percent||0)}%`;
  $('gpu-f32-bar').style.width = clamp(tf32/tfMax*100, 0, 100) + '%';
  $('gpu-f32').textContent = `${tf32.toFixed(1)} TF`;
  $('gpu-f16-bar').style.width = clamp(tf16/tfMax*100, 0, 100) + '%';
  $('gpu-f16').textContent = `${tf16.toFixed(1)} TF`;

  /* ---- 内存：环心大数字 + 已用/压缩/可用数据条 ---- */
  const used = mem.used||0, total = mem.total||1, comp = mem.compressed||0, avail = mem.available||0;
  $('num-mem').textContent = Math.round(used/total*100);
  $('sub-mem').textContent = `${(used/GB).toFixed(1)} / ${(total/GB).toFixed(0)} GB`;
  $('mem-used-bar').style.width = clamp(used/total*100, 0, 100) + '%';
  $('mem-used').textContent = `${(used/GB).toFixed(1)} G`;
  $('mem-comp-bar').style.width = clamp(comp/total*100, 0, 100) + '%';
  $('mem-comp').textContent = `${(comp/GB).toFixed(1)} G`;
  $('mem-free-bar').style.width = clamp(avail/total*100, 0, 100) + '%';
  $('mem-free').textContent = `${(avail/GB).toFixed(0)} G`;
  $('sub-mem2').textContent =
    `交换 ${((mem.swap_used||0)/GB).toFixed(1)} / ${((mem.swap_total||0)/GB).toFixed(1)} GB · 压力 ${mem.pressure_state || '—'}`;

  $('num-power').innerHTML = Math.round(sm.system_power||0) + '<em>W</em>';
  const peak = hist.power.length ? Math.max(...hist.power) : 0;
  $('sub-power').innerHTML =
    `GPU ${(sm.gpu_power||0).toFixed(0)} · CPU ${(sm.cpu_power||0).toFixed(0)} · DRAM ${(sm.dram_power||0).toFixed(0)} · ` +
    `SRAM ${(sm.gpu_sram_power||0).toFixed(0)} W　|　整机 ${Math.round(sm.total_power||0)}W · 60s 峰 ${Math.round(peak)}W`;

  $('sub-cores').textContent =
    `E ${Math.round(latest.ecpu_usage ? latest.ecpu_usage[1] : 0)}% · P ${Math.round(latest.pcpu_usage ? latest.pcpu_usage[1] : 0)}%`;

  const pkg = (latest.temperatures||[]).find(g => /package/i.test(g.group)) || {};
  $('num-temp').textContent = Math.round(pkg.avg_celsius||sm.soc_temp||0);
  $('sub-temp').textContent = `封装平均 · SoC ${Math.round(sm.soc_temp||0)}° / GPU ${Math.round(sm.gpu_temp||0)}°`;

  const rpmMax = fans.length ? Math.max(...fans.map(f => f.rpm||0)) : 0;
  $('num-fans').innerHTML = (rpmMax ? rpmMax.toLocaleString('en-US') : '—') + '<em>RPM</em>';
  $('sub-fans').innerHTML = fans.length
    ? `${fans.map(f => (f.name||'Fan').replace('Fan ','F') + ' ' + f.rpm + '/' + (f.target_rpm||0)).join(' · ')} · ` +
      `${fans[0].mode||'—'} · 区间 ${fans[0].min_rpm||0}–${fans[0].max_rpm||0}`
    : '无风扇数据';

  const dramSum = (sm.dram_read_bw_gbs||0) + (sm.dram_write_bw_gbs||0);
  $('num-dram').innerHTML = dramSum.toFixed(0) + '<em>GB/s</em>';
  const ac = sm.ane_cluster_active || [];
  $('sub-dram').innerHTML =
    `ANE <em>${Math.round(sm.ane_active||0)}%</em> · 簇 ×${sm.ane_cluster_count||0} [${ac.map(x => Math.round(x)).join('/')}] · ` +
    `读 ${fmtBps((sm.ane_read_bw_gbs||0)*1e9)} · 写 ${fmtBps((sm.ane_write_bw_gbs||0)*1e9)}`;

  $('sub-net').textContent = `↓ ${fmtBps(nd.in_bytes_per_sec)} · ↑ ${fmtBps(nd.out_bytes_per_sec)}`;
  const links = latest.network_links || {};
  const upEth = (links.ethernet || []).filter(l => l.link_up);
  const wifi = links.wifi && links.wifi.connected;
  const psum = latest.ports_summary || {};
  const tbNet = (latest.tb_net_total_bytes_in_per_sec||0) + (latest.tb_net_total_bytes_out_per_sec||0);
  $('sub-netfoot').innerHTML =
    `链路 ${upEth.length ? upEth[0].name + ' ' + upEth[0].speed_formatted : (wifi ? 'WiFi ' + (links.wifi.generation||'') : '—')}` +
    ` · 包 ${Math.round(nd.in_packets_per_sec||0)}↓/${Math.round(nd.out_packets_per_sec||0)}↑ pps` +
    ` · TB 网 ${fmtBps(tbNet)}`;

  $('sub-disk').textContent = `读 ${fmtBps((nd.read_kbytes_per_sec||0)*1e3)} · 写 ${fmtBps((nd.write_kbytes_per_sec||0)*1e3)}`;
  $('sub-diskfoot').textContent = `IOPS 读 ${Math.round(nd.read_ops_per_sec||0)} · 写 ${Math.round(nd.write_ops_per_sec||0)}`;
}

/* ============================ 组装 ============================ */
addRing('ring-cpu', () => CL.blue,   () => latest ? latest.cpu_usage : 0);
addRing('ring-gpu', () => CL.purple, () => latest ? latest.gpu_usage : 0);
addRing('ring-mem', () => CL.mint,   () => latest ? (latest.memory||{}).used/((latest.memory||{}).total||1)*100 : 0);
addRing('ring-temp', v => tempColor(v),
        () => latest ? Math.round(((latest.temperatures||[]).find(g => /package/i.test(g.group)) || {}).avg_celsius || 0) : 0,
        95);

addLineChart('power-chart', [{ get: () => hist.power, color: CL.purple }], v => Math.round(v) + 'W');
addLineChart('net-chart',   [{ get: () => hist.netIn,  color: CL.blue },
                             { get: () => hist.netOut, color: CL.mint }], fmtBps, ['入', '出']);
addLineChart('disk-chart',  [{ get: () => hist.diskR,  color: CL.violet },
                             { get: () => hist.diskW, color: CL.amber }], fmtBps, ['读', '写']);
addLineChart('fans-chart',  [{ get: () => hist.fan,   color: CL.blue },
                             { get: () => hist.fan2,  color: CL.purple }], v => Math.round(v), ['F0', 'F1']);
addLineChart('dram-chart',  [{ get: () => hist.dramR, color: CL.violet },
                             { get: () => hist.dramW, color: CL.blue }], v => Math.round(v), ['读', '写']);
addCoresChart('cores-chart');

/* ============================ SSE 接入 ============================ */
function ingest(samples){
  if (!samples || !samples.length) return;
  for (const s of samples){
    const sm = s.soc_metrics || {}, nd = s.net_disk || {}, fans = s.fans || [];
    push(hist.power,   sm.system_power || 0);
    push(hist.netIn,  nd.in_bytes_per_sec || 0);
    push(hist.netOut, nd.out_bytes_per_sec || 0);
    push(hist.diskR, (nd.read_kbytes_per_sec || 0) * 1e3);
    push(hist.diskW, (nd.write_kbytes_per_sec || 0) * 1e3);
    push(hist.fan,  fans[0] ? fans[0].rpm : 0);
    push(hist.fan2, fans[1] ? fans[1].rpm : 0);
    push(hist.dramR, sm.dram_read_bw_gbs || 0);
    push(hist.dramW, sm.dram_write_bw_gbs || 0);
  }
  latest = samples[samples.length - 1];
  renderTop(); renderTexts(); renderTempList(); renderVols();
  renderPorts(); renderPeriph(); renderProcs();
  for (const c of charts) c.dirty = true;
}

streamBadge('wait', '连接中…');
const es = new EventSource('/api/stream');
es.onopen = () => streamBadge('ok', '实时');
es.onerror = () => streamBadge('bad', '重连中…');
es.addEventListener('snapshot', ev => ingest((JSON.parse(ev.data) || {}).samples));
es.onmessage = ev => ingest((JSON.parse(ev.data) || {}).samples);

/* ============================ 交互 ============================ */
$('proc-search').addEventListener('input', e => { query = e.target.value.trim(); renderProcs(); });
$('proc-sort').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  sortKey = b.dataset.sort;
  $('proc-sort').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderProcs();
});

/* ============================ 时钟 ============================ */
function tick(){
  const d = new Date();
  $('clock').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}
tick(); setInterval(tick, 1000);
})();
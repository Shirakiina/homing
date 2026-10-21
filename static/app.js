'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  view: 'all',          // all | unread | starred | filtered | channel | tag
  channel: null,
  tag: null,
  ai: null,             // AI 整理设置 {configured, enabled, rules, ...}
  level: '',
  q: '',
  all: [],              // 当前视图已加载的消息（不含级别筛选）
  items: [],            // 实际展示的 = all 按级别筛选后的结果
  hasMore: false,
  loading: false,
  sel: null,            // 当前打开的消息 id
  rows: [],             // 列表实际展示的行：单条消息，或聊天会话（同一会话的消息折叠成一行）
  selConv: null,        // 当前打开的会话键
  conv: null,           // 打开的会话 {key, items(时间正序), hasMore}
  stats: { total: 0, unread: 0, starred: 0, channels: [] },
  levels: [],           // [{key, name, color, aliases, builtin}]，顺序即展示顺序
  info: null,
};

// ------------------------------------------------------------ utils

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 本页标识：写操作带上它，服务端广播 sync 时原样带回，本页据此跳过自己触发的同步
const CLIENT_ID = Math.random().toString(36).slice(2);

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Client': CLIENT_ID },
  };
  const r = await fetch(path, opt);
  if (r.status === 401) toLogin();
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

function toLogin() {
  if (location.hash) sessionStorage.setItem('nc.next', location.hash);
  location.replace('/login');
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------ 级别

const BELL_OFF = '<svg viewBox="0 0 24 24"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>';
const BELL = '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

// 静音（收起）的频道：汇总视图里不显示、不计未读、不弹通知，点进频道照常看
const isMuted = ch => !!S.stats.channels.find(c => c.channel === ch)?.muted;

const levelOf = key => S.levels.find(l => l.key === key)
  || S.levels.find(l => l.key === 'info') || { key, name: key, color: '#8a8d96' };

async function loadLevels() {
  S.levels = await api('/api/levels');
  if (S.level && !S.levels.some(l => l.key === S.level)) S.level = '';
  renderLevels();
}

function renderLevels() {
  const chip = (key, label, color) => `
    <button data-level="${esc(key)}" class="${S.level === key ? 'on' : ''}">
      ${color ? `<i class="lv" style="--c:${esc(color)}"></i>` : ''}${esc(label)}</button>`;
  $('#levels').innerHTML = chip('', '全部') + S.levels.map(l => chip(l.key, l.name, l.color)).join('');
}

const SPARK = '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';

// ------------------------------------------------------------ 频道外观

const BRAND = {
  'mac/com.larksuite.larkapp': ['#3370ff', '飞'], 'mac/com.electron.lark': ['#3370ff', '飞'],
  'mac/com.bytedance.lark': ['#3370ff', '飞'], 'mac/com.tencent.xinwechat': ['#07c160', '微'],
  'mac/com.tencent.qq': ['#12b7f5', 'Q'], 'mac/com.tdesktop.telegram': ['#2aabee', 'T'],
  'mac/net.whatsapp.whatsapp': ['#25d366', 'W'], 'mac/com.apple.mail': ['#1a82fb', '邮'],
  'mac/com.apple.ical': ['#f5463c', '日'], 'mac/com.apple.mobilesms': ['#34c759', '信'],
};
const SOURCE = {
  github: '#24292f', gitlab: '#fc6d26', alertmanager: '#e6522c', grafana: '#f46800',
  feishu: '#3370ff', dingtalk: '#1677ff', slack: '#4a154b', discord: '#5865f2',
};
const PALETTE = ['#5b5bd6', '#0e9f8e', '#d6409f', '#e5484d', '#f76b15', '#3e63dd', '#8e4ec6', '#12a594', '#6e56cf', '#ca244d'];

function hashColor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function look(channel, name, source) {
  if (BRAND[channel]) return { color: BRAND[channel][0], glyph: BRAND[channel][1] };
  const n = (name || channel || '?').trim();
  const glyph = /^[a-z0-9]/i.test(n) ? n.slice(0, 1).toUpperCase() : n.slice(0, 1);
  return { color: SOURCE[source] || hashColor(channel || n), glyph };
}

function avatar(channel, name, source, size = '') {
  const { color, glyph } = look(channel, name, source);
  return `<span class="avatar ${size}" style="background:${color}">${esc(glyph)}</span>`;
}

// ------------------------------------------------------------ 时间

const pad = n => String(n).padStart(2, '0');
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function dayDiff(d) {
  const a = new Date(d); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}
function shortTime(ts) {
  const d = new Date(ts * 1000), sec = (Date.now() - d) / 1000;
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  const dd = dayDiff(d);
  if (dd === 0) return hm(d);
  if (dd === 1) return `昨天 ${hm(d)}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function dayLabel(ts) {
  const d = new Date(ts * 1000), dd = dayDiff(d);
  if (dd === 0) return '今天';
  if (dd === 1) return '昨天';
  const wk = '日一二三四五六'[d.getDay()];
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 · 周${wk}`;
}
function fullTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(d)}:${pad(d.getSeconds())}`;
}

// ------------------------------------------------------------ markdown（够用的子集，先转义再渲染）

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function markdown(src) {
  const lines = esc(src).replace(/\r/g, '').split('\n');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]);
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flush(); out.push('<hr>'); continue; }
    if ((m = line.match(/^&gt;\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flush();
  return out.join('');
}

const plain = s => String(s || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/[*_`#>~]+/g, '')
  .replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------ 路由

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  let m;
  if ((m = h.match(/^m\/(\d+)$/))) return { view: 'all', channel: null, open: +m[1] };
  if (h.startsWith('c/')) return { view: 'channel', channel: h.slice(2) };
  if (h.startsWith('t/')) return { view: 'tag', tag: h.slice(2) };
  if (['unread', 'starred', 'filtered'].includes(h)) return { view: h, channel: null };
  return { view: 'all', channel: null };
}

// ------------------------------------------------------------ 返回键
//
// 手机上的返回键 = 浏览器后退。每打开一层（窄屏详情、侧栏菜单、弹窗）就压一条历史，
// 后退时先关最上面那层；没有浮层时才回到上一个列表视图（这部分由 hash 路由负责）。
// 浮层的历史条目 URL 不变，只带 state.depth，所以后退不会触发 hashchange。

const layers = [];          // [{name, close}]，自底向上
let afterUnwind = null;     // 程序主动后退（history.go）完成后要做的事

function pushLayer(name, close) {
  if (layers.some(l => l.name === name)) return;    // 已开着（如详情里切换消息）
  layers.push({ name, close });
  history.pushState({ depth: layers.length }, '');
}

// 通过界面（关闭按钮、遮罩、Esc）关掉某层时调用：把它和它上面的层对应的历史一起退掉
function popLayer(name) {
  const i = layers.findIndex(l => l.name === name);
  if (i < 0) return;                                // 由后退键关的，历史已经退过了
  const above = layers.splice(i);
  above.slice(1).forEach(l => l.close());
  unwind(above.length);
}

function unwind(n, then = () => {}) {
  afterUnwind = then;
  history.go(-n);
}

window.addEventListener('popstate', e => {
  if (afterUnwind) {
    const f = afterUnwind; afterUnwind = null; f();
    return;
  }
  const depth = e.state?.depth || 0;
  while (layers.length > depth) layers.pop().close();
});

function go(view, arg = null) {
  const hash = view === 'channel' ? `#/c/${encodeURIComponent(arg)}`
    : view === 'tag' ? `#/t/${encodeURIComponent(arg)}` : `#/${view}`;
  // 从浮层里跳转（如侧栏菜单里点频道）：先把浮层的历史退掉，再压新视图，
  // 这样之后按返回是回到上一个视图，而不是回到一个已关闭的菜单
  if (!layers.length) return void (location.hash = hash);
  const n = layers.length;
  while (layers.length) layers.pop().close();
  unwind(n, () => { location.hash = hash; });
}

function showDialog(dlg) {
  dlg.showModal();
  pushLayer(dlg.id, () => dlg.open && dlg.close());
}
// 弹窗不管怎么关的（× 按钮、Esc、点遮罩、保存），open 属性都会被移除。
// 不用 close 事件：它依赖渲染时机，页面在后台时会延后甚至不触发
new MutationObserver(ms => ms.forEach(m => {
  if (m.target.tagName === 'DIALOG' && !m.target.open) popLayer(m.target.id);   // 排除 <details open>
}))
  .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

// 详情只在窄屏下是盖在列表上的浮层；宽屏下它是常驻的一栏，不参与返回
const detailIsOverlay = () => window.innerWidth <= 980;

window.addEventListener('hashchange', applyRoute);

function applyRoute() {
  const r = parseHash();
  S.view = r.view; S.channel = r.channel || null; S.tag = r.tag || null;
  $('#app').classList.remove('menu');
  renderSidebar();
  loadList(true).then(() => { if (r.open) openMessage(r.open); });
}

// ------------------------------------------------------------ 侧栏

async function loadChannels() {
  const before = JSON.stringify(S.stats.conv_unread || {});
  S.stats = await api('/api/channels');
  renderSidebar();
  if (JSON.stringify(S.stats.conv_unread || {}) !== before && S.rows.some(r => r.kind === 'conv')) {
    const list = $('#list'), top = list.scrollTop;
    renderList();
    list.scrollTop = top;
  }
}
const refreshChannels = debounce(loadChannels, 250);

function renderSidebar() {
  const st = S.stats;
  const setCnt = (id, n, hot) => {
    const el = $(id);
    el.textContent = n ? (n > 999 ? '999+' : n) : '';
    el.classList.toggle('hot', !!(hot && n));
  };
  setCnt('#cnt-all', st.total);
  setCnt('#cnt-unread', st.unread, true);
  setCnt('#cnt-starred', st.starred);
  setCnt('#cnt-filtered', st.filtered);
  // 没开 AI、也没有被过滤的消息时，这一项没意义
  $('#nav-filtered').hidden = !(st.filtered || S.ai?.configured);
  $$('.nav-item').forEach(a => a.classList.toggle('on', S.view === a.dataset.view));

  const live = st.channels.filter(c => !c.muted);
  const quiet = st.channels.filter(c => c.muted);
  const mac = live.filter(c => c.channel.startsWith('mac/'));
  const hooks = live.filter(c => !c.channel.startsWith('mac/'));
  const row = c => `
    <a class="ch ${c.muted ? 'muted' : ''} ${S.view === 'channel' && S.channel === c.channel ? 'on' : ''}" data-ch="${esc(c.channel)}" title="${esc(c.channel)}">
      ${avatar(c.channel, c.channel_name, c.source)}
      <span class="ch-name">${esc(c.channel_name)}</span>
      <em class="${c.unread && !c.muted ? 'hot' : ''}">${c.unread || ''}</em>
    </a>`;
  let h = '';
  if (hooks.length) h += `<div class="group-label">Webhook</div>${hooks.map(row).join('')}`;
  if (mac.length) h += `<div class="group-label">Mac 应用</div>${mac.map(row).join('')}`;
  if (quiet.length) {
    // 当前正看着某个静音频道时强制展开，否则选中项藏在折叠里
    const open = localStorage.getItem('nc.quietOpen') === '1' || quiet.some(c => S.view === 'channel' && S.channel === c.channel);
    const n = quiet.reduce((a, c) => a + (c.unread || 0), 0);
    h += `<button class="group-label quiet-toggle ${open ? 'open' : ''}" data-act="toggle-quiet">
        <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>已收起<em>${n || ''}</em></button>
      ${open ? quiet.map(row).join('') : ''}`;
  }
  if (st.tags?.length) h += `<div class="group-label">标签</div><div class="tag-cloud">${st.tags.map(t => `
    <a class="tag ${S.view === 'tag' && S.tag === t.tag ? 'on' : ''}" data-tag="${esc(t.tag)}">
      ${esc(t.tag)}<em>${t.count}</em></a>`).join('')}</div>`;
  if (!h) h = `<div class="side-empty">还没有来源。<br><a data-act="connect">查看接入方式 →</a></div>`;
  $('#channels').innerHTML = h;

  const unread = st.unread;
  document.title = unread ? `(${unread}) 归巢` : '归巢';
  renderViewTitle();
}

function renderViewTitle() {
  let title = { all: '全部', unread: '未读', starred: '星标', filtered: '已过滤' }[S.view];
  if (S.view === 'tag') title = `# ${S.tag}`;
  if (S.view === 'channel') {
    const c = S.stats.channels.find(c => c.channel === S.channel);
    title = c ? c.channel_name : S.channel;
  }
  $('#view-title').textContent = title || '';
  // 静音开关只在单个频道视图里有意义
  const mb = $('#btn-mute'), on = S.view === 'channel' && isMuted(S.channel);
  mb.hidden = S.view !== 'channel';
  mb.classList.toggle('on', on);
  mb.innerHTML = on ? BELL_OFF : BELL;
  mb.title = on ? '已收起：不在「全部」里显示、不提醒。点击恢复' : '收起这个频道：不在「全部」里显示、不提醒';
  $('#view-sub').textContent = S.items.length ? `${S.items.length}${S.hasMore ? '+' : ''} 条` : '';
}

$('#nav').addEventListener('click', e => {
  const a = e.target.closest('.nav-item');
  if (a) go(a.dataset.view);
});
async function setMute(channel, on) {
  await api('/api/mute', { channel, muted: on });
  const c = S.stats.channels.find(x => x.channel === channel);
  if (c) c.muted = on;
  renderSidebar();
  await Promise.all([loadChannels(), S.view === 'channel' ? null : loadList(true, { quiet: true })]);
  toast(on ? `已收起「${c?.channel_name || channel}」，在侧栏底部「已收起」里查看` : `已恢复「${c?.channel_name || channel}」`);
}

// 侧栏频道右键 / 长按菜单
function channelMenu(ch, x, y) {
  closeChannelMenu();
  const on = isMuted(ch);
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = `<button data-act="mute">${on ? BELL : BELL_OFF}${on ? '取消收起' : '收起（不在全部里显示、不提醒）'}</button>`;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  el.addEventListener('click', () => { closeChannelMenu(); setMute(ch, !on); });
}
function closeChannelMenu() { $('.ctx-menu')?.remove(); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('.ctx-menu')) closeChannelMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChannelMenu(); });
$('#channels').addEventListener('contextmenu', e => {     // 手机上长按也会触发 contextmenu
  const a = e.target.closest('.ch');
  if (!a) return;
  e.preventDefault();
  channelMenu(a.dataset.ch, e.clientX, e.clientY);
});
$('#btn-mute').addEventListener('click', () => setMute(S.channel, !isMuted(S.channel)));

$('#channels').addEventListener('click', e => {
  if (e.target.closest('[data-act="toggle-quiet"]')) {
    localStorage.setItem('nc.quietOpen', localStorage.getItem('nc.quietOpen') === '1' ? '0' : '1');
    return renderSidebar();
  }
  const a = e.target.closest('.ch');
  if (a) go('channel', a.dataset.ch);
  const t = e.target.closest('.tag[data-tag]');
  if (t) go('tag', t.dataset.tag);
  if (e.target.closest('[data-act="connect"]')) openConnect();
});

// ------------------------------------------------------------ 列表

function params(extra = {}) {
  const p = new URLSearchParams();
  if (S.view === 'channel') p.set('channel', S.channel);
  if (['unread', 'starred', 'filtered'].includes(S.view)) p.set('view', S.view);
  if (S.view === 'tag') p.set('tag', S.tag);
  if (S.q) p.set('q', S.q);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

// 级别筛选只在已加载的数据上做，不发请求
function applyLevel() {
  S.items = S.level ? S.all.filter(m => m.level === S.level) : S.all.slice();
}

// 筛完不够一屏、服务端又还有更早的消息时，后台悄悄补拉下一页（不闪骨架屏）
function topUp() {
  if (S.level && S.items.length < 30 && S.hasMore) loadList(false);
}

let listSeq = 0;
// quiet：后台同步用，不显示骨架屏、不重置滚动位置
async function loadList(reset, { quiet = false } = {}) {
  if (!reset && (S.loading || !S.hasMore)) return;
  const seq = ++listSeq;
  S.loading = true;
  if (reset && !quiet && !S.all.length) $('#list').innerHTML = '<div class="sk"></div>'.repeat(6);
  const extra = !reset && S.all.length ? { before: S.all[S.all.length - 1].id } : {};
  try {
    const d = await api('/api/messages?' + params({ limit: 100, ...extra }));
    if (seq !== listSeq) return;   // 过期的响应
    S.all = reset ? d.items : S.all.concat(d.items);
    S.hasMore = d.has_more;
    applyLevel();
    const list = $('#list'), top = list.scrollTop;
    renderList();
    list.scrollTop = reset && !quiet ? 0 : top;
  } finally {
    if (seq === listSeq) S.loading = false;
  }
  if (seq === listSeq) topUp();
}

// AI 标题优先；原标题（常是短信发件人）挪到来源行
function displayTitle(m) {
  return m.ai_title || m.title || plain(m.body).slice(0, 80);
}

function itemHtml(m, fresh) {
  const title = displayTitle(m);
  const body = m.ai_summary || (m.title || m.ai_title ? plain(m.body) : '');
  const from = m.ai_title && m.title && m.title !== m.channel_name ? `${m.channel_name} · ${m.title}` : m.channel_name;
  return `
    <div class="item ${m.is_read ? '' : 'unread'} ${m.starred ? 'starred' : ''} ${S.sel === m.id ? 'on' : ''} ${fresh ? 'new' : ''}" data-id="${m.id}">
      <span class="dot"></span>
      <div class="item-av">${avatar(m.channel, m.channel_name, m.source, 'av-md')}<i class="lv" style="--c:${esc(levelOf(m.level).color)}"></i></div>
      <div class="item-main">
        <div class="item-top">
          <span class="from">${esc(from)}</span>
          ${m.ai_status === 'pending' ? `<span class="ai-pending" title="AI 整理中">${SPARK}</span>` : ''}
          <span class="star"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>
          <time title="${fullTime(m.ts)}">${shortTime(m.ts)}</time>
        </div>
        <div class="item-title">${esc(title) || '(无标题)'}</div>
        ${body ? `<div class="item-body">${esc(body.slice(0, 240))}</div>` : ''}
        ${m.tags?.length ? `<div class="item-tags">${m.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
}

// 同一会话只保留最新一条作为会话行。「已过滤」视图逐条看，不折叠
function buildRows() {
  const seen = new Set(), rows = [];
  for (const m of S.items) {
    if (!m.conv || S.view === 'filtered') { rows.push({ kind: 'msg', m }); continue; }
    if (seen.has(m.conv)) continue;
    seen.add(m.conv);
    rows.push({ kind: 'conv', key: m.conv, m });
  }
  return rows;
}

function convUnread(key) {
  const n = S.stats.conv_unread?.[key];
  return n ?? S.all.filter(x => x.conv === key && !x.is_read).length;
}

function convAvatar(m, size) {
  const { glyph } = look(m.conv, m.conv_name, '');
  const app = look(m.channel, m.channel_name, m.source);
  return `<span class="conv-av">
    <span class="avatar ${size}" style="background:${hashColor(m.conv)}">${esc(glyph)}</span>
    <span class="app-badge" style="background:${app.color}" title="${esc(m.channel_name)}">${esc(app.glyph)}</span>
  </span>`;
}

function convRowHtml(r, fresh) {
  const m = r.m, n = convUnread(r.key);
  return `
    <div class="item conv ${n ? 'unread' : ''} ${S.selConv === r.key ? 'on' : ''} ${fresh ? 'new' : ''}" data-conv="${esc(r.key)}">
      <span class="dot"></span>
      <div class="item-av">${convAvatar(m, 'av-md')}</div>
      <div class="item-main">
        <div class="item-top">
          <span class="from">${esc(m.channel_name)}</span>
          <time title="${fullTime(m.ts)}">${shortTime(m.ts)}</time>
        </div>
        <div class="item-title conv-title"><span>${esc(m.conv_name)}</span>${n ? `<em class="conv-n">${n > 99 ? '99+' : n}</em>` : ''}</div>
        <div class="item-body">${esc(plain(m.body).slice(0, 120)) || '&nbsp;'}</div>
      </div>
    </div>`;
}

function renderList(freshId) {
  const el = $('#list');
  S.rows = buildRows();
  if (!S.items.length) {
    const msg = S.q || S.level ? '没有匹配的通知'
      : S.view === 'unread' ? '全部已读，干得漂亮'
      : S.view === 'starred' ? '还没有星标消息'
      : S.view === 'filtered' ? '没有被过滤的消息' : '暂无通知';
    el.innerHTML = `<div class="list-empty">
      <svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
      ${msg}</div>`;
    renderViewTitle();
    return;
  }
  let h = '', last = '';
  for (const r of S.rows) {
    const d = dayLabel(r.m.ts);
    if (d !== last) { h += `<div class="day">${d}</div>`; last = d; }
    h += r.kind === 'conv' ? convRowHtml(r, r.m.id === freshId) : itemHtml(r.m, r.m.id === freshId);
  }
  if (S.hasMore) h += '<div class="more">加载中…</div>';
  el.innerHTML = h;
  renderViewTitle();
}

$('#list').addEventListener('click', e => {
  const it = e.target.closest('.item');
  if (it?.dataset.conv) openConv(it.dataset.conv);
  else if (it) openMessage(+it.dataset.id);
});
$('#list').addEventListener('scroll', e => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) loadList(false);
}, { passive: true });

// 相对时间每分钟刷新一次
setInterval(() => $$('.item time').forEach(t => {
  const m = S.items.find(x => x.id === +t.closest('.item').dataset.id);
  if (m) t.textContent = shortTime(m.ts);
}), 60000);

// ------------------------------------------------------------ 筛选

$('#search').addEventListener('input', debounce(e => { S.q = e.target.value.trim(); loadList(true); }, 200));
// 选中的级别滚入视野，两侧各留出渐隐区的宽度
function revealChip(b) {
  const seg = $('#levels'), pad = 28;
  const left = b.offsetLeft, right = left + b.offsetWidth;   // seg 是 offsetParent
  let to = seg.scrollLeft;
  if (right > seg.scrollLeft + seg.clientWidth - pad) to = right - seg.clientWidth + pad;
  if (left < seg.scrollLeft + pad) to = left - pad;
  seg.scrollTo({ left: Math.max(0, to), behavior: 'smooth' });
}

$('#levels').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S.level = b.dataset.level;
  $$('#levels button').forEach(x => x.classList.toggle('on', x === b));
  revealChip(b);
  applyLevel();
  renderList();
  $('#list').scrollTop = 0;
  topUp();
});

function scope() {
  // 过滤 / 标签 / 星标视图没法用频道+级别表达，直接按当前列表里的 id
  if (['filtered', 'tag', 'starred'].includes(S.view)) return { ids: S.items.map(m => m.id) };
  const sc = {};
  if (S.view === 'channel') sc.channel = S.channel;
  if (S.level) sc.level = S.level;
  return sc;
}

async function pullLatest() {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('spin')) return;
  const newest = S.all.length ? S.all[0].id : 0;
  btn.classList.add('spin');
  try {
    await Promise.all([loadList(true), loadChannels(), loadLevels()]);
    const n = S.all.filter(m => m.id > newest).length;
    toast(newest && n ? `新增 ${n} 条` : '已是最新');
  } catch {
    toast('拉取失败，请检查网络');
  } finally {
    setTimeout(() => btn.classList.remove('spin'), 300);
  }
}
$('#btn-refresh').addEventListener('click', pullLatest);

// ------------------------------------------------------------ 下拉刷新
//
// 手机上列表已经在顶部时继续往下拉：圆钮跟手下移、旋转，拉过阈值松手就拉取最新。
// 拉动期间拦掉列表自己的滚动和回弹（touchmove 不能是 passive）。

const PTR_GO = 64, PTR_MAX = 96;        // 触发阈值、最大下移距离（px，已含阻尼）
const ptr = { y0: null, x0: 0, dist: 0, pulling: false };

function setPull(d, cls = '') {
  const el = $('#ptr');
  el.className = `ptr ${cls}`;
  el.style.setProperty('--pull', `${d}px`);
  el.style.setProperty('--turn', `${d * 4}deg`);
  el.style.setProperty('--op', cls === 'busy' ? 1 : Math.min(1, d / PTR_GO));
}

$('#list').addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || e.currentTarget.scrollTop > 0 || $('#ptr').classList.contains('busy')) return;
  Object.assign(ptr, { y0: e.touches[0].clientY, x0: e.touches[0].clientX, dist: 0, pulling: false });
}, { passive: true });

$('#list').addEventListener('touchmove', e => {
  if (ptr.y0 === null) return;
  const dy = e.touches[0].clientY - ptr.y0, dx = e.touches[0].clientX - ptr.x0;
  if (!ptr.pulling) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;       // 手指抖动，先不判断
    if (dy <= Math.abs(dx)) { ptr.y0 = null; return; }           // 往上划或横着划：交还给列表
    ptr.pulling = true;
    ptr.y0 += 8;
  }
  e.preventDefault();
  ptr.dist = Math.min(PTR_MAX, Math.max(0, e.touches[0].clientY - ptr.y0) * 0.5);
  setPull(ptr.dist, ptr.dist >= PTR_GO ? 'pulling ready' : 'pulling');
}, { passive: false });

async function ptrEnd() {
  const { pulling, dist } = ptr;
  ptr.y0 = null; ptr.pulling = false;
  if (!pulling) return;
  if (dist < PTR_GO) return setPull(0);
  setPull(PTR_GO * 0.75, 'busy');
  // 至少转半秒，网络太快时动画一闪而过反而像没反应
  await Promise.all([pullLatest(), new Promise(r => setTimeout(r, 500))]);
  setPull(0);
}
$('#list').addEventListener('touchend', ptrEnd);
$('#list').addEventListener('touchcancel', ptrEnd);

$('#btn-readall').addEventListener('click', async () => {
  await api('/api/read', scope());
  S.items.forEach(m => { m.is_read = 1; });   // items 与 all 共享对象，all 同步更新
  renderList(); refreshChannels();
  toast('已全部标为已读');
});

$('#btn-clear').addEventListener('click', async () => {
  const label = S.view === 'channel' ? `「${$('#view-title').textContent}」的全部消息` : '当前列表中已加载的消息';
  if (!confirm(`删除${label}？此操作不可撤销。`)) return;
  if (S.view === 'channel') await api('/api/delete', { channel: S.channel });
  else await api('/api/delete', { ids: S.items.map(m => m.id) });
  closeDetail();
  loadList(true); refreshChannels();
  toast('已删除');
});

// ------------------------------------------------------------ 详情

async function openMessage(id) {
  let m;
  try { m = await api(`/api/message/${id}`); } catch { return toast('消息不存在或已删除'); }
  S.sel = id;
  S.selConv = null; S.conv = null;
  $$('.item').forEach(x => x.classList.toggle('on', +x.dataset.id === id));
  $('#app').classList.add('has-detail');
  if (detailIsOverlay()) pushLayer('detail', () => closeDetail());
  renderDetail(m);
  const li = $(`.item[data-id="${id}"]`);
  li?.scrollIntoView({ block: 'nearest' });
  if (!m.is_read) {
    api('/api/read', { ids: [id] });
    const it = S.items.find(x => x.id === id);
    if (it) it.is_read = 1;
    li?.classList.remove('unread');
    refreshChannels();
  }
}

function renderDetail(m) {
  const lv = levelOf(m.level);
  let raw = m.raw || '';
  try { raw = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
  const star = `<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  $('#detail').innerHTML = `
    <article class="detail" data-id="${m.id}">
      <div class="d-bar">
        <button class="icon-btn back" data-act="back" title="返回"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
        <div class="spacer"></div>
        <button class="icon-btn ${m.starred ? 'starred' : ''}" data-act="star" title="星标 (S)">${star}</button>
        <button class="icon-btn" data-act="unread" title="标为未读 (U)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="10"/></svg></button>
        ${S.ai?.configured ? `<button class="icon-btn" data-act="reprocess" title="重新 AI 整理">${SPARK}</button>` : ''}
        ${m.filtered ? '' : `<button class="icon-btn" data-act="spam" title="标为垃圾"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg></button>`}
        <button class="icon-btn" data-act="copy" title="复制内容"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button class="icon-btn" data-act="delete" title="删除 (⌫)"><svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
      <div class="d-head">
        ${avatar(m.channel, m.channel_name, m.source, 'av-lg')}
        <div>
          <div class="d-from">${esc(m.channel_name)}</div>
          <div class="d-meta"><span>${fullTime(m.ts)}</span><span class="sep">·</span><span>${esc(m.source)}</span></div>
        </div>
      </div>
      ${m.filtered ? `
        <div class="d-banner">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
          <span>已被识别为广告 / 垃圾，默认列表中不显示</span>
          <button class="ghost sm" data-act="unspam">不是垃圾</button>
        </div>` : ''}
      ${displayTitle(m) ? `<h1 class="d-title">${esc(displayTitle(m))}</h1>` : ''}
      ${m.ai_title && m.title && m.title !== m.ai_title ? `<div class="d-orig">原标题：${esc(m.title)}</div>` : ''}
      <div class="badges">
        <label class="badge level" style="--c:${esc(lv.color)}" title="修改级别">
          <i class="lv"></i>${esc(lv.name)}
          <svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
          <select data-act="set-level">${S.levels.map(l =>
            `<option value="${esc(l.key)}" ${l.key === lv.key ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        </label>
        ${(m.tags || []).map(t => `<a class="badge tag-link" data-act="tag" data-tag="${esc(t)}"># ${esc(t)}</a>`).join('')}
      </div>
      ${m.ai_summary ? `<div class="d-summary">${SPARK}<p>${esc(m.ai_summary)}</p></div>` : ''}
      ${m.ai_status === 'pending' ? `<div class="d-summary pending">${SPARK}<p>AI 整理中…</p></div>` : ''}
      ${m.ai_status === 'failed' ? `<div class="d-summary failed">${SPARK}<p>AI 整理失败，24 小时内会每半小时自动重试；也可点右上角 ✦ 立即重试</p></div>` : ''}
      <div class="md">${markdown(m.body || '')}</div>
      ${/^https?:\/\//.test(m.url || '') ? `
        <a class="d-link" href="${esc(m.url)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          <span class="u">${esc(m.url)}</span>
          <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
        </a>` : ''}
      ${raw ? `
        <details class="raw">
          <summary><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>原始数据 · ${esc(m.channel)}</summary>
          <pre>${esc(raw)}</pre>
        </details>` : ''}
    </article>`;
  $('#detail').scrollTop = 0;
}

function closeDetail() {
  popLayer('detail');
  S.sel = null;
  S.selConv = null; S.conv = null;
  $('#app').classList.remove('has-detail');
  $$('.item.on').forEach(x => x.classList.remove('on'));
  $('#detail').innerHTML = $('#detail-empty-tpl').innerHTML;
}

// ------------------------------------------------------------ 会话

async function openConv(key) {
  const fresh = S.selConv !== key;
  S.sel = null; S.selConv = key;
  $$('.item').forEach(x => x.classList.toggle('on', x.dataset.conv === key));
  $('#app').classList.add('has-detail');
  if (detailIsOverlay()) pushLayer('detail', () => closeDetail());
  if (fresh) {
    S.conv = { key, items: [], hasMore: false };
    const d = await api('/api/messages?' + new URLSearchParams({ conv: key, limit: 50 }));
    if (S.selConv !== key) return;             // 加载期间用户已切走
    S.conv.items = d.items.reverse();
    S.conv.hasMore = d.has_more;
  }
  renderConv({ toBottom: true });
  $(`.item[data-conv="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  markConvRead(key);
}

function markConvRead(key) {
  if (!convUnread(key)) return;
  api('/api/read', { conv: key });
  S.all.forEach(x => { if (x.conv === key) x.is_read = 1; });
  S.conv?.items.forEach(x => { x.is_read = 1; });
  if (S.stats.conv_unread) S.stats.conv_unread[key] = 0;
  renderList();
  refreshChannels();
}

async function loadOlder() {
  const c = S.conv;
  if (!c || !c.hasMore || c.loading) return;
  c.loading = true;
  const pane = $('#detail'), before = pane.scrollHeight;
  try {
    const d = await api('/api/messages?' + new URLSearchParams({ conv: c.key, limit: 50, before: c.items[0].id }));
    if (S.conv !== c) return;
    c.items = d.items.reverse().concat(c.items);
    c.hasMore = d.has_more;
    renderConv();
    pane.scrollTop += pane.scrollHeight - before;   // 保持当前看到的位置不动
  } finally {
    c.loading = false;
  }
}

function bubbleText(t) {
  return inline(esc(t || '')).replace(/\n/g, '<br>');
}

function renderConv({ toBottom = false } = {}) {
  const c = S.conv, pane = $('#detail');
  if (!c) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  const head = c.items[c.items.length - 1] || S.all.find(x => x.conv === c.key);
  if (!head) return closeDetail();
  let h = '', lastDay = '', lastTs = 0;
  for (const m of c.items) {
    const d = dayLabel(m.ts);
    if (d !== lastDay) { h += `<div class="chat-day"><span>${d}</span></div>`; lastDay = d; lastTs = 0; }
    // 相隔 5 分钟以上才另起一组、显示时间，连发的消息贴在一起
    const gap = m.ts - lastTs > 300;
    const [sender, text] = splitSender(m);
    h += `<div class="bubble-row ${gap ? 'gap' : ''}" data-id="${m.id}">
      ${sender ? `<div class="bubble-sender">${esc(sender)}</div>` : ''}
      <div class="bubble ${m.starred ? 'starred' : ''}">${bubbleText(text) || '<span class="muted">(空)</span>'}</div>
      <time title="${fullTime(m.ts)}">${hm(new Date(m.ts * 1000))}</time>
    </div>`;
    lastTs = m.ts;
  }
  pane.innerHTML = `
    <article class="detail chat" data-conv="${esc(c.key)}">
      <div class="chat-head">
        <button class="icon-btn back" data-act="back" title="返回"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
        ${convAvatar(head, 'av-lg')}
        <div class="chat-title">
          <div class="d-from">${esc(head.conv_name)}</div>
          <div class="d-meta">${esc(head.channel_name)} · ${c.items.length}${c.hasMore ? '+' : ''} 条</div>
        </div>
        <div class="spacer"></div>
        <button class="icon-btn" data-act="del-conv" title="删除这个会话"><svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
      ${c.hasMore ? '<div class="chat-more">上滑加载更早的消息</div>' : '<div class="chat-more">没有更早的消息了</div>'}
      <div class="chat-body">${h}</div>
    </article>`;
  if (toBottom || atBottom) pane.scrollTop = pane.scrollHeight;
}

// 群聊通知的副标题是发言人，入库时并进了正文（「张三 · 内容」），这里拆回来。
// 不去猜「张三：内容」这种写法——单聊里「注意：明天…」也长这样，会误拆
function splitSender(m) {
  const t = m.body || '';
  const mm = t.match(/^([^\n·]{1,24}) · ([\s\S]+)$/);
  return mm && mm[1].trim() !== m.conv_name ? [mm[1].trim(), mm[2]] : ['', t];
}

// 页面在后台时收到的会话消息不算已读；切回来、会话还开着，才标已读
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.selConv) markConvRead(S.selConv);
});

$('#detail').addEventListener('scroll', e => {
  if (S.conv && e.target.scrollTop < 120) loadOlder();
}, { passive: true });

async function deleteConv(key) {
  const name = S.conv?.items.at(-1)?.conv_name || '';
  if (!confirm(`删除和「${name}」的全部消息？此操作不可撤销。`)) return;
  await api('/api/delete', { conv: key });
  S.all = S.all.filter(x => x.conv !== key);
  applyLevel();
  closeDetail();
  renderList();
  refreshChannels();
  toast('已删除会话');
}

async function toggleStar(id) {
  const btn = $('.detail [data-act="star"]');
  const it = S.items.find(x => x.id === id);
  const next = btn ? !btn.classList.contains('starred') : !(it && it.starred);
  await api('/api/star', { id, starred: next });
  btn?.classList.toggle('starred', next);
  if (it) it.starred = next ? 1 : 0;
  $(`.item[data-id="${id}"]`)?.classList.toggle('starred', next);
  refreshChannels();
  toast(next ? '已加星标' : '已取消星标');
}

async function markUnread(id) {
  await api('/api/read', { ids: [id], unread: true });
  const it = S.items.find(x => x.id === id);
  if (it) it.is_read = 0;
  $(`.item[data-id="${id}"]`)?.classList.add('unread');
  refreshChannels();
  toast('已标为未读');
}

async function removeMsg(id) {
  const idx = S.items.findIndex(x => x.id === id);
  await api('/api/delete', { ids: [id] });
  S.all = S.all.filter(x => x.id !== id);
  applyLevel();
  renderList();
  refreshChannels();
  const next = S.items[Math.min(idx, S.items.length - 1)];
  next ? openMessage(next.id) : closeDetail();
}

$('#detail').addEventListener('change', async e => {
  if (e.target.dataset.act !== 'set-level') return;
  const id = +$('.detail').dataset.id, level = e.target.value;
  await api('/api/level', { id, level });
  const it = S.items.find(x => x.id === id);
  if (it) it.level = level;
  // 当前按级别筛选且改成了别的级别：这条会从列表里消失
  applyLevel();
  renderList();
  openMessage(id);
  toast(`已改为「${levelOf(level).name}」`);
});

$('#detail').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = +$('.detail')?.dataset.id;
  const act = b.dataset.act;
  if (act === 'back') closeDetail();
  if (act === 'del-conv') return deleteConv(S.selConv);
  if (act === 'star') toggleStar(id);
  if (act === 'unread') markUnread(id);
  if (act === 'delete') removeMsg(id);
  if (act === 'spam' || act === 'unspam') setSpam(id, act === 'spam');
  if (act === 'reprocess') reprocess(id);
  if (act === 'tag') go('tag', b.dataset.tag);
  if (act === 'copy') {
    const t = [$('.d-title')?.textContent, $('.detail .md')?.innerText].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(t).then(() => toast('已复制'));
  }
});
async function setSpam(id, filtered) {
  await api('/api/spam', { id, filtered });
  const m = await api(`/api/message/${id}`);
  applyUpdate(m);
  refreshChannels();
  toast(filtered ? '已移入「已过滤」' : '已恢复到正常列表');
}

async function reprocess(id) {
  await api('/api/reprocess', { id });
  applyUpdate({ ...(S.all.find(x => x.id === id) || await api(`/api/message/${id}`)), ai_status: 'pending' });
  toast('已提交 AI 重新整理');
}

function closeMenu() {
  popLayer('menu');
  $('#app').classList.remove('menu');
}

$('#scrim').addEventListener('click', () => {
  if ($('#app').classList.contains('menu')) closeMenu();
  else if (detailIsOverlay()) closeDetail();
});
$('#btn-menu').addEventListener('click', () => {
  $('#app').classList.add('menu');
  pushLayer('menu', closeMenu);
});

// ------------------------------------------------------------ 键盘

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if ($$('dialog').some(d => d.open)) return;
  const idx = S.rows.findIndex(r => r.kind === 'conv' ? r.key === S.selConv : r.m.id === S.sel);
  const openRow = r => r && (r.kind === 'conv' ? openConv(r.key) : openMessage(r.m.id));
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (k === 'r') pullLatest();
  else if (k === 'j' || k === 'ArrowDown') {
    e.preventDefault();
    openRow(S.rows[idx + 1] || (idx < 0 && S.rows[0]));
    if (idx >= S.rows.length - 3) loadList(false);
  } else if (k === 'k' || k === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) openRow(S.rows[idx - 1]);
  } else if (!S.sel) return;
  else if (k === 's') toggleStar(S.sel);
  else if (k === 'u') markUnread(S.sel);
  else if (k === 'Backspace' || k === 'Delete' || k === '#') removeMsg(S.sel);
  else if (k === 'Escape') closeDetail();
  else if (k === 'o' || k === 'Enter') $('.d-link')?.click();
});

// ------------------------------------------------------------ 实时

function inView(m) {
  if (!!m.filtered !== (S.view === 'filtered')) return false;
  if (['all', 'unread', 'tag'].includes(S.view) && !S.q && isMuted(m.channel)) return false;
  if (S.view === 'channel' && m.channel !== S.channel) return false;
  if (S.view === 'starred' && !m.starred) return false;
  if (S.view === 'unread' && m.is_read) return false;
  if (S.view === 'tag' && !(m.tags || []).includes(S.tag)) return false;
  if (S.q) {
    const hay = `${m.title} ${m.body} ${m.channel_name} ${m.ai_title} ${m.ai_summary} ${(m.tags || []).join(' ')}`.toLowerCase();
    if (!hay.includes(S.q.toLowerCase())) return false;
  }
  return true;
}

// 一条消息内容变了（AI 整理完、改判垃圾等）：按当前视图决定替换、插入还是移除
function applyUpdate(m) {
  const i = S.all.findIndex(x => x.id === m.id);
  const show = inView(m);
  if (i >= 0 && show) S.all[i] = { ...S.all[i], ...m };
  else if (i >= 0) S.all.splice(i, 1);
  else if (show && (!S.all.length || m.id > S.all[S.all.length - 1].id)) {
    const at = S.all.findIndex(x => x.id < m.id);
    S.all.splice(at < 0 ? S.all.length : at, 0, m);
  }
  applyLevel();
  const list = $('#list'), top = list.scrollTop;
  renderList();
  list.scrollTop = top;
  if (S.sel === m.id) {
    if (show || window.innerWidth <= 980) openMessage(m.id);
    else closeDetail();
  }
  if (S.conv && m.conv === S.conv.key) {
    const j = S.conv.items.findIndex(x => x.id === m.id);
    if (j >= 0 && m.filtered) S.conv.items.splice(j, 1);
    else if (j >= 0) S.conv.items[j] = { ...S.conv.items[j], ...m };
    renderConv();
  }
}

const notifyLater = new Set();     // 等 AI 判完不是垃圾再弹浏览器通知

const resync = debounce(() => { loadList(true, { quiet: true }); refreshChannels(); }, 300);

function connectStream() {
  const es = new EventSource('/api/stream');
  const live = $('#live');
  let dropped = false;
  // 断线期间可能错过消息，重连后补一次全量
  es.onopen = () => { live.className = 'live on'; live.title = '实时连接中'; if (dropped) resync(); };
  es.onerror = () => {
    dropped = true; live.className = 'live off'; live.title = '连接断开，正在重连…';
    fetch('/api/channels').then(r => { if (r.status === 401) toLogin(); }).catch(() => {});
  };
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'new') {
      const m = ev.msg;
      if (inView(m) && !S.all.some(x => x.id === m.id)) {
        S.all.unshift(m);
        applyLevel();
        const list = $('#list'), keep = list.scrollTop > 40;
        const before = list.scrollHeight;
        renderList(m.id);
        // 用户正往下翻时，别把内容顶走
        if (keep) list.scrollTop += list.scrollHeight - before;
      }
      if (S.conv && m.conv === S.conv.key && !m.filtered && !S.conv.items.some(x => x.id === m.id)) {
        S.conv.items.push(m);
        renderConv();
        if (!document.hidden) markConvRead(m.conv);
      }
      refreshChannels();
      if (m.ai_status === 'pending') notifyLater.add(m.id);
      else desktopNotify(m);
    } else if (ev.type === 'update') {
      const m = ev.msg;
      applyUpdate(m);
      refreshChannels();
      if (notifyLater.delete(m.id) && !m.filtered) desktopNotify(m);
    } else if (ev.type === 'sync') {
      if (ev.src !== CLIENT_ID) resync();   // 自己的改动本地已更新，不必重拉
    } else if (ev.type === 'levels') {
      loadLevels().then(() => { resync(); if (S.sel) openMessage(S.sel); });
    }
  };
}

// ------------------------------------------------------------ 浏览器通知

const bell = $('#btn-bell');
const bellOn = () => localStorage.getItem('nc.notify') === '1' && 'Notification' in window && Notification.permission === 'granted';
const paintBell = () => {
  bell.classList.toggle('on', bellOn());
  bell.title = bellOn() ? '浏览器通知：开' : '浏览器通知：关';
};
bell.addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('当前浏览器不支持通知');
  if (bellOn()) { localStorage.setItem('nc.notify', '0'); paintBell(); return toast('已关闭浏览器通知'); }
  const p = await Notification.requestPermission();
  if (p !== 'granted') return toast('通知权限被拒绝，请在浏览器设置中开启');
  localStorage.setItem('nc.notify', '1'); paintBell();
  toast('已开启：页面不在前台时弹出通知');
});
function desktopNotify(m) {
  if (!bellOn() || !document.hidden || isMuted(m.channel)) return;
  const title = displayTitle(m);
  const n = new Notification(`${m.channel_name}${title ? ' · ' + title : ''}`, {
    body: (m.ai_summary || plain(m.body)).slice(0, 180), tag: `nc-${m.id}`, icon: 'icon.svg',
  });
  n.onclick = () => { window.focus(); openMessage(m.id); n.close(); };
}

// ------------------------------------------------------------ 主题

$('#btn-theme').addEventListener('click', () => {
  const root = document.documentElement;
  const cur = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('nc.theme', next);
});
if (!document.documentElement.dataset.theme) {
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('nc.theme')) document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
  });
}

// ------------------------------------------------------------ AI 设置

async function loadAi() {
  S.ai = await api('/api/ai');
  $('#btn-ai').classList.toggle('on', S.ai.configured && S.ai.enabled);
  $('#btn-ai').title = !S.ai.configured ? 'AI 整理：未配置' : S.ai.enabled ? 'AI 整理：开' : 'AI 整理：关';
}

async function openAi() {
  await loadAi();
  const a = S.ai;
  $('#ai-status').innerHTML = a.configured
    ? `<i class="lv" style="--c:var(--success)"></i>已连接 <code>${esc(a.url)}</code>${a.model ? ` · ${esc(a.model.split('/').pop())}` : ''}
       ${a.pending ? `<br>待处理 ${a.pending} 条` : ''}${a.failed ? `${a.pending ? '，' : '<br>'}失败 ${a.failed} 条（可在详情里重试）` : ''}`
    : '<i class="lv"></i>未配置：在服务端设置 <code>HOMING_AI_URL</code>（OpenAI 兼容接口）后重启';
  $('#ai-enabled').checked = a.enabled;
  $('#ai-enabled').disabled = !a.configured;
  $('#ai-rules').value = a.rules || '';
  showDialog($('#ai-dlg'));
}

$('#btn-ai').addEventListener('click', openAi);
$('#ai-cancel').addEventListener('click', () => $('#ai-dlg').close());
$('#ai-save').addEventListener('click', async () => {
  S.ai = await api('/api/ai', { enabled: $('#ai-enabled').checked, rules: $('#ai-rules').value.trim() });
  await loadAi();
  $('#ai-dlg').close();
  toast('AI 设置已保存，对之后的新消息生效');
});
$('#ai-dlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ------------------------------------------------------------ 级别编辑

const GRIP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
const PRESET = ['#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#3e8bf5', '#5b5bd6', '#8e4ec6', '#d6409f', '#8a8d96'];

function lvRow(l) {
  return `
    <div class="lv-row" draggable="true" data-key="${esc(l.key || '')}" data-builtin="${l.builtin ? 1 : 0}">
      <span class="grip" title="拖动排序">${GRIP}</span>
      <label class="swatch" style="--c:${esc(l.color)}" title="颜色">
        <input type="color" value="${esc(l.color)}">
      </label>
      <input type="text" class="name" value="${esc(l.name)}" placeholder="名称" maxlength="12">
      <input type="text" class="alias" value="${esc(l.aliases || '')}" placeholder="别名，逗号分隔（可选）">
      <button class="icon-btn del" ${l.builtin ? 'disabled title="内置级别不可删除，可改名和颜色"' : 'title="删除"'}>
        <svg viewBox="0 0 24 24">${l.builtin
          ? '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
          : '<path d="M18 6 6 18M6 6l12 12"/>'}</svg>
      </button>
    </div>`;
}

function openLevelEditor() {
  $('#lv-rows').innerHTML = S.levels.map(lvRow).join('');
  const fallback = S.levels.find(l => l.key === 'info');
  $('#lv-hint').innerHTML = `例：新建「快递」并加别名 <code>express</code>，推送时 <code>level=快递</code> 或 <code>level=express</code> 都会归到它下面。
    没有匹配的归为「${esc(fallback ? fallback.name : '普通')}」。删除级别后，其下消息同样归入「${esc(fallback ? fallback.name : '普通')}」。`;
  showDialog($('#levels-dlg'));
}

$('#btn-levels').addEventListener('click', openLevelEditor);
$('#lv-add').addEventListener('click', () => {
  const used = $$('#lv-rows .swatch input').map(i => i.value.toLowerCase());
  const color = PRESET.find(c => !used.includes(c)) || PRESET[0];
  $('#lv-rows').insertAdjacentHTML('beforeend', lvRow({ key: '', name: '', color, aliases: '' }));
  $('#lv-rows .lv-row:last-child .name').focus();
});

$('#lv-rows').addEventListener('input', e => {
  if (e.target.type === 'color') e.target.parentElement.style.setProperty('--c', e.target.value);
});
$('#lv-rows').addEventListener('click', e => {
  const del = e.target.closest('.del');
  if (del && !del.disabled) del.closest('.lv-row').remove();
});

// 拖动排序
let dragRow = null;
$('#lv-rows').addEventListener('dragstart', e => {
  // 在输入框里拖选文字时不触发排序
  if (e.target.matches?.('input')) return e.preventDefault();
  dragRow = e.target.closest('.lv-row');
  dragRow?.classList.add('drag');
});
$('#lv-rows').addEventListener('dragover', e => {
  const over = e.target.closest('.lv-row');
  if (!dragRow || !over || over === dragRow) return;
  e.preventDefault();
  const r = over.getBoundingClientRect();
  over.parentNode.insertBefore(dragRow, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
});
$('#lv-rows').addEventListener('dragend', () => { dragRow?.classList.remove('drag'); dragRow = null; });

$('#lv-cancel').addEventListener('click', () => $('#levels-dlg').close());
$('#lv-save').addEventListener('click', async () => {
  const rows = $$('#lv-rows .lv-row');
  const levels = rows.map(r => ({
    key: r.dataset.key, name: $('.name', r).value.trim(),
    color: $('input[type=color]', r).value, aliases: $('.alias', r).value.trim(),
  }));
  const empty = rows.find((r, i) => !levels[i].name);
  if (empty) { $('.name', empty).focus(); return toast('级别名称不能为空'); }
  const names = levels.map(l => l.name);
  if (new Set(names).size !== names.length) return toast('级别名称不能重复');
  const removed = S.levels.filter(l => !levels.some(x => x.key === l.key));
  if (removed.length && !confirm(`删除「${removed.map(l => l.name).join('、')}」？其下的消息将归入「${levelOf('info').name}」。`)) return;
  try {
    S.levels = await api('/api/levels', { levels });
  } catch (err) {
    return toast(String(err.message).replace(/^\d+ bad request: /, ''));
  }
  $('#levels-dlg').close();
  renderLevels();
  loadList(true);
  toast('级别已保存');
});
$('#levels-dlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ------------------------------------------------------------ 接入指南

const RECIPES = [
  {
    key: 'curl', name: 'curl',
    code: u => `curl -X POST '${u}' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "title": "快递已签收",
    "body": "您的包裹已放入 **3 号柜**，取件码 \`8261\`",
    "level": "完成",
    "url": "https://example.com/track/42",
    "tags": ["快递"]
  }'

# 最简：纯文本（首行作标题）
echo "信用卡还款提醒\\n本期账单 ¥1,280，9 月 28 日到期" | curl -X POST --data-binary @- '${u}'`,
    note: () => `字段都可选。<code>level</code> 填级别名称或别名：${S.levels.map(l => `<code>${esc(l.name)}</code>`).join(' ')}，可在筛选栏右侧的 ✎ 里增改。`,
  },
  {
    key: 'get', name: 'GET / 快捷指令',
    code: u => `${u}${u.includes('?') ? '&' : '?'}title=${encodeURIComponent('提醒')}&body=${encodeURIComponent('该喝水了')}&level=info`,
    note: '适合 iOS 快捷指令、浏览器书签、IFTTT 这类只能发 GET 的地方。',
  },
  {
    key: 'sms', name: '短信',
    code: u => `# iPhone：快捷指令 → 自动化 → 新建「信息」自动化
#   触发：收到信息（可限定发件人或关键词）→ 选「立即运行」
#   操作：获取 URL 内容
#     URL      ${u}
#     方法     POST
#     请求体   JSON
#       from     =  快捷指令输入 → 发件人
#       content  =  快捷指令输入 → 内容

# Android：SmsForwarder 等短信转发 app，发送通道选 Webhook
#   URL       ${u}
#   方法      POST
#   消息模板  {"from":"[from]","content":"[content]"}`,
    note: '发件人作为标题、短信内容作为正文。Android 模板里的占位符以所用 app 的说明为准。想单独归类可再加 <code>"level":"短信"</code>（先在 ✎ 里建好这个级别）。',
  },
  {
    key: 'mac', name: 'macOS 转发',
    code: (u, base) => `# 在要转发通知的 Mac 上，编辑仓库里的 mac/config.py
RECEIVER = "${base}/notify"
TOKEN    = "<与本服务 config.py 中的 TOKEN 一致>"

# 然后安装 / 重启转发服务（无人值守的专用 Mac 加 --headless）
cd mac && ./install.sh`,
    note: '把这台 Mac 的系统通知原样转发过来，需要先给 Python 授予「完全磁盘访问权限」，详见仓库 mac/README.md。消息会按 app 出现在侧栏「Mac 应用」分组下。',
  },
  {
    key: 'github', name: 'GitHub',
    code: u => `Settings → Webhooks → Add webhook

Payload URL    ${u}
Content type   application/json
Events         按需勾选（push / pull_request / issues /
               workflow_run / release …）`,
    note: '通过 <code>X-GitHub-Event</code> 自动识别，推送、PR、Issue、Actions 结果都会整理成可读的标题。GitHub 需要能访问到本机，公网场景可配合内网穿透。',
  },
  {
    key: 'gitlab', name: 'GitLab',
    code: u => `Settings → Webhooks

URL            ${u}
Trigger        Push / Merge request / Pipeline / Job / Issue …`,
    note: '通过 <code>X-Gitlab-Event</code> 自动识别。Pipeline 失败会标为错误级别。',
  },
  {
    key: 'alertmanager', name: 'Alertmanager',
    code: u => `# alertmanager.yml
receivers:
  - name: homing
    webhook_configs:
      - url: '${u}'
        send_resolved: true`,
    note: 'firing 标为错误（或按 severity 标签），resolved 标为成功。',
  },
  {
    key: 'grafana', name: 'Grafana',
    code: u => `Alerting → Contact points → New

Integration    Webhook
URL            ${u}
HTTP Method    POST`,
    note: 'Grafana 统一告警与 Alertmanager 结构相同，会自动识别。',
  },
  {
    key: 'bot', name: '飞书 / 钉钉 / Slack',
    code: u => `# 已有脚本在往 IM 机器人发消息？把 webhook 地址换成：
${u}

# 以下格式都能直接识别，无需改代码：
#   飞书/Lark   {"msg_type":"text"|"post"|"interactive", ...}
#   钉钉/企微    {"msgtype":"text"|"markdown"|"link", ...}
#   Slack       {"text": ..., "blocks": [...]}
#   Discord     {"content": ..., "embeds": [...]}`,
    note: '适合把原本发到群里的机器人消息收拢到这里。',
  },
];

let recipe = RECIPES[0];

async function openConnect() {
  if (!S.info) S.info = await api('/api/info');
  const hosts = [S.info.public_url, location.origin,
    ...S.info.ips.map(ip => `http://${ip}:${S.info.port}`), `http://127.0.0.1:${S.info.port}`];
  $('#cx-host').innerHTML = [...new Set(hosts.filter(Boolean))].map(h => `<option>${h}</option>`).join('');
  $('#cx-tabs').innerHTML = RECIPES.map(r => `<button data-k="${r.key}" class="${r === recipe ? 'on' : ''}">${r.name}</button>`).join('');
  $('#cx-token-hint').innerHTML = '地址里已带上推送 token，请勿公开。也可以改用 Header：<code>X-Token</code> 或 <code>Authorization: Bearer</code>。';
  paintConnect();
  showDialog($('#connect'));
}

function paintConnect() {
  const base = $('#cx-host').value;
  const ch = encodeURIComponent($('#cx-channel').value.trim() || 'default');
  const tk = `?token=${S.info.token}`;
  const url = `${base}/hook/${ch}${tk}`;
  $('#cx-url').textContent = url;
  $('#cx-code').textContent = recipe.code(url, base);
  $('#cx-note').innerHTML = typeof recipe.note === 'function' ? recipe.note() : (recipe.note || '');
  $$('#cx-tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === recipe.key));
}

$('#btn-connect').addEventListener('click', openConnect);
$('#btn-logout').addEventListener('click', async () => {
  if (!confirm('退出登录？')) return;
  await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.replace('/login');
});
$('#cx-host').addEventListener('change', paintConnect);
$('#cx-channel').addEventListener('input', paintConnect);
$('#cx-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) { recipe = RECIPES.find(r => r.key === b.dataset.k); paintConnect(); }
});
$('#connect').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.close();   // 点遮罩关闭
  const c = e.target.closest('[data-copy]');
  if (c) navigator.clipboard.writeText($(c.dataset.copy).textContent).then(() => toast('已复制'));
});
$('#btn-test').addEventListener('click', async () => {
  await api('/api/test', {});
  toast('测试消息已发送');
});

// ------------------------------------------------------------ 启动

const tpl = document.createElement('template');
tpl.id = 'detail-empty-tpl';
tpl.innerHTML = $('#detail').innerHTML;
document.body.appendChild(tpl);

paintBell();
Promise.all([loadLevels(), loadAi(), loadChannels()]).then(applyRoute);
connectStream();

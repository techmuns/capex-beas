// public/js/brief.js
// The "Brief" slide-in subscribe panel. Fully additive — if this script or the
// /api routes aren't available, the dashboard is unaffected and the panel shows a
// friendly message instead of breaking. Talks to the Pages Functions:
//   POST /api/subscribe   { email, cadence, time, filter }
//   POST /api/send-now    { email, filter }

const state = { cadence: 'weekday', filter: 'all', open: false };

// Inject the drawer's own styles so the feature is self-contained.
const style = document.createElement('style');
style.textContent = `
  .brief-overlay{position:fixed;inset:0;background:rgba(20,21,42,.38);opacity:0;pointer-events:none;transition:opacity .2s ease;z-index:60}
  .brief-overlay.show{opacity:1;pointer-events:auto}
  .brief-drawer{position:fixed;top:0;right:0;height:100%;width:min(420px,92vw);background:var(--card,#fff);border-left:1px solid var(--line,#ECEAF6);
    box-shadow:-24px 0 60px rgba(20,21,42,.18);transform:translateX(100%);transition:transform .26s cubic-bezier(.4,0,.2,1);z-index:61;overflow-y:auto}
  .brief-drawer.show{transform:translateX(0)}
  .brief-pad{padding:22px 22px 30px}
  .brief-seg{display:flex;gap:6px;background:#F3F1FB;border:1px solid var(--line,#ECEAF6);border-radius:12px;padding:4px}
  .brief-seg button{flex:1;border:none;background:none;padding:9px 8px;border-radius:9px;font:600 13px Inter,sans-serif;color:var(--muted,#6b7280);cursor:pointer;transition:all .15s}
  .brief-seg button.on{background:linear-gradient(90deg,var(--i1,#6366F1),var(--i2,#8B5CF6));color:#fff;box-shadow:0 4px 12px rgba(99,102,241,.3)}
  .brief-field{width:100%;border:1px solid var(--line,#ECEAF6);border-radius:12px;padding:11px 13px;font:400 14px Inter,sans-serif;color:var(--ink,#14152A);outline:none;background:#fff}
  .brief-field:focus{border-color:var(--i2,#8B5CF6);box-shadow:0 0 0 3px rgba(139,92,246,.15)}
  .brief-label{font:600 11px Inter,sans-serif;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 7px;display:block}
  .brief-primary{width:100%;border:none;border-radius:12px;padding:13px;font:700 14px Inter,sans-serif;color:#fff;cursor:pointer;
    background:linear-gradient(90deg,var(--i1,#6366F1),var(--i2,#8B5CF6) 55%,var(--pink,#EC4899));box-shadow:0 10px 24px rgba(139,92,246,.32)}
  .brief-primary:disabled{opacity:.6;cursor:default}
  .brief-ghost{width:100%;border:1px solid var(--line,#ECEAF6);border-radius:12px;padding:12px;font:600 13px Inter,sans-serif;color:var(--i1,#6366F1);background:#fff;cursor:pointer}
  .brief-ghost:hover{background:#F5F3FF}
  .brief-msg{font:500 13px Inter,sans-serif;border-radius:10px;padding:10px 12px;margin-top:12px;line-height:1.5}
  .brief-msg.ok{background:rgba(16,185,129,.1);color:#047857}
  .brief-msg.err{background:rgba(244,63,94,.1);color:#be123c}
  .brief-x{background:none;border:none;cursor:pointer;color:var(--muted,#6b7280);padding:4px;border-radius:8px}
  .brief-x:hover{background:#F3F1FB}
`;
document.head.appendChild(style);

const overlay = document.createElement('div');
overlay.className = 'brief-overlay';
const drawer = document.createElement('aside');
drawer.className = 'brief-drawer';
drawer.setAttribute('role', 'dialog');
drawer.setAttribute('aria-label', 'Subscribe to the Capex Brief');
drawer.innerHTML = `
  <div class="brief-pad">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
      <div>
        <div class="font-display" style="font-size:20px;font-weight:700;color:var(--ink,#14152A)">Get the Capex Brief</div>
        <div style="font-size:13px;color:var(--muted,#6b7280);margin-top:2px">A Munshot newspaper-style email — only on days a company changes its capex plan.</div>
      </div>
      <button class="brief-x" id="briefClose" aria-label="Close"><i data-lucide="x"></i></button>
    </div>

    <label class="brief-label">Your email</label>
    <input class="brief-field" id="briefEmail" type="email" inputmode="email" placeholder="you@company.com" autocomplete="email" />

    <label class="brief-label">How often</label>
    <div class="brief-seg" id="briefCadence">
      <button data-v="weekday" class="on">Every weekday</button>
      <button data-v="daily">Every day</button>
    </div>

    <label class="brief-label">Time (IST)</label>
    <input class="brief-field" id="briefTime" type="time" value="08:00" />

    <label class="brief-label">What to include</label>
    <div class="brief-seg" id="briefFilter">
      <button data-v="all" class="on">All</button>
      <button data-v="increases">Increases</button>
      <button data-v="decreases">Decreases</button>
    </div>

    <div style="margin-top:20px"><button class="brief-primary" id="briefSub">Subscribe</button></div>
    <div style="text-align:center;font-size:11px;color:var(--muted,#6b7280);margin:12px 0">— or —</div>
    <div><button class="brief-ghost" id="briefNow"><i data-lucide="send" style="width:14px;height:14px;vertical-align:-2px"></i> Email me this now</button></div>

    <div id="briefMsg" class="brief-msg" style="display:none"></div>
    <div style="font-size:11px;color:var(--muted,#6b7280);margin-top:16px;line-height:1.5">
      We'll send a confirmation email first. One-click unsubscribe in every email. Source-backed — every figure links its official BSE filing.
    </div>
  </div>`;
document.body.append(overlay, drawer);
if (window.lucide) window.lucide.createIcons();

const $ = (id) => drawer.querySelector(id);
const msgEl = $('#briefMsg');
function msg(kind, text) { msgEl.style.display = 'block'; msgEl.className = `brief-msg ${kind}`; msgEl.textContent = text; }
function clearMsg() { msgEl.style.display = 'none'; msgEl.textContent = ''; }

function openDrawer() { state.open = true; overlay.classList.add('show'); drawer.classList.add('show'); setTimeout(() => $('#briefEmail').focus(), 260); }
function closeDrawer() { state.open = false; overlay.classList.remove('show'); drawer.classList.remove('show'); }

document.getElementById('briefBtn')?.addEventListener('click', openDrawer);
$('#briefClose').addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) closeDrawer(); });

// segmented controls
function wireSeg(sel, key) {
  const root = $(sel);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state[key] = b.dataset.v;
    for (const x of root.children) x.classList.toggle('on', x === b);
  });
}
wireSeg('#briefCadence', 'cadence');
wireSeg('#briefFilter', 'filter');

async function post(path, payload) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body };
  } catch { return { status: 0, ok: false, body: {} }; }
}
const emailVal = () => $('#briefEmail').value.trim();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// Our API always returns JSON with an `ok` field. Anything else — a network error
// (status 0), or an HTML 404/405/501/503 from a host without the Functions deployed
// — means the subscription API isn't switched on here, so degrade gracefully.
const notConfigured = (r) => r.status === 0 || !r.body || typeof r.body.ok === 'undefined';

async function withBusy(btn, label, fn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = orig; }
}

$('#briefSub').addEventListener('click', () => withBusy($('#briefSub'), 'Subscribing…', async () => {
  clearMsg();
  const email = emailVal();
  if (!validEmail(email)) return msg('err', 'Please enter a valid email address.');
  const r = await post('/api/subscribe', { email, cadence: state.cadence, time: $('#briefTime').value || '08:00', filter: state.filter });
  if (notConfigured(r)) return msg('err', 'Subscriptions aren’t switched on yet — please check back soon.');
  if (r.ok && r.body.ok) return msg('ok', r.body.note || 'Subscribed — check your inbox to confirm.');
  msg('err', r.body.error || 'Something went wrong. Please try again.');
}));

$('#briefNow').addEventListener('click', () => withBusy($('#briefNow'), 'Sending…', async () => {
  clearMsg();
  const email = emailVal();
  if (!validEmail(email)) return msg('err', 'Please enter a valid email address.');
  const r = await post('/api/send-now', { email, filter: state.filter });
  if (notConfigured(r)) return msg('err', 'Email isn’t switched on yet — please check back soon.');
  if (r.ok && r.body.ok) return msg('ok', r.body.note || 'Sent — check your inbox.');
  msg('err', r.body.error || r.body.note || 'Could not send right now. Please try again.');
}));

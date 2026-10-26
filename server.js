// Servidor de Diego's Pizza (demo). Sin dependencias: solo Node 18+.
// Sirve el sitio y el panel, guarda los pedidos en un archivo JSON y avisa en vivo con SSE.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@diegospizza.cl').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'diegos2026';
const INDEX = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find(f => fs.existsSync(f));

const DEF_SETTINGS = () => ({ open: true, fee: 2000, eta: '30–40 min', unavail: [] });
let db = { init: false, seq: 100, orders: [], settings: DEF_SETTINGS() };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
let timer;
const persist = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('No se pudo guardar:', e.message); } }, 150); };
const tokens = new Set();
const streams = new Set();
const broadcast = () => { for (const r of streams) { try { r.write('data: 1\n\n'); } catch (e) {} } };
const hits = new Map();
const limited = (ip) => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > 20; };

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 600000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });
const authed = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); return t && tokens.has(t); };
const str = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
const num = (v, min, max) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min; };
const int = (v, min, max) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : 0; };
const bool = v => !!v;
const STATUS = ['nuevo', 'preparacion', 'listo', 'camino', 'entregado', 'cancelado'];


const MESA_STATUS = ['abierta', 'porcobrar', 'pagada', 'unida', 'cancelado'];
const METHODS = ['efectivo', 'tarjeta', 'transferencia', 'local'];
const rid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
function cleanMesaItem(i) {
  const o = {
    iid: str(i.iid, 40) || rid('i'), key: str(i.key, 80), id: str(i.id, 60), name: str(i.name, 80), variant: str(i.variant, 60), v: str(i.v, 40),
    qty: num(i.qty, 1, 50), price: num(i.price, 0, 100000), rid: num(i.rid, 1, 99) || 1,
    station: i.station === 'sanguches' ? 'sanguches' : 'pizzas', sentAt: int(i.sentAt, 0, 9e15), note: str(i.note, 200),
    ready: bool(i.ready), served: bool(i.served), voided: bool(i.voided), paid: bool(i.paid)
  };
  if (i.readyAt) o.readyAt = int(i.readyAt, 0, 9e15);
  return o.name ? o : null;
}
function mergeItems(old, inc) {
  const out = old.map(i => ({ ...i })), m = new Map(out.map(i => [i.iid, i]));
  for (const n of inc) {
    const o = m.get(n.iid);
    if (!o) { out.push(n); m.set(n.iid, n); continue; }
    for (const f of ['ready', 'served', 'voided', 'paid']) if (n[f]) o[f] = true;
    if (n.readyAt && !o.readyAt) o.readyAt = n.readyAt;
  }
  return out.slice(0, 300);
}
function cleanPayment(p) {
  return {
    id: str(p.id, 40) || rid('p'), t: int(p.t, 0, 9e15), method: METHODS.includes(p.method) ? p.method : 'efectivo',
    amount: int(p.amount, 0, 5e6), tip: int(p.tip, 0, 5e6), split: ['total', 'persona', 'partes', 'platillo'].includes(p.split) ? p.split : 'total',
    doc: p.doc === 'factura' ? 'factura' : 'boleta', rut: str(p.rut, 20), razon: str(p.razon, 80)
  };
}
// Documento de mesa/mostrador (solo el panel autenticado puede crearlo o modificarlo).
function cleanMesa(b, id, old) {
  const inc = (Array.isArray(b.items) ? b.items : []).slice(0, 300).map(cleanMesaItem).filter(Boolean);
  const items = old ? mergeItems(old.items || [], inc) : inc;
  const pm = new Map((old ? old.payments || [] : []).map(p => [p.id, p]));
  (Array.isArray(b.payments) ? b.payments : []).slice(0, 60).map(cleanPayment).forEach(p => { if (!pm.has(p.id)) pm.set(p.id, p); });
  const payments = [...pm.values()].slice(0, 80);
  let status = MESA_STATUS.includes(b.status) ? b.status : 'abierta';
  if (old && ['pagada', 'unida', 'cancelado'].includes(old.status)) status = old.status; // estados finales no se reabren
  const total = items.filter(i => !i.voided).reduce((a, i) => a + i.price * i.qty, 0);
  const t = Date.now();
  return {
    id, num: 0, type: 'mesa', kind: b.kind === 'mostrador' ? 'mostrador' : 'mesa', label: str(b.label, 40),
    createdAt: old ? old.createdAt : int(b.createdAt, 0, 9e15) || t, openedAt: old ? old.openedAt : int(b.openedAt, 0, 9e15) || t,
    status, table: b.table ? str(b.table, 40) : null, guests: num(b.guests, 1, 60) || 1, waiter: str(b.waiter, 40),
    items, payments, rounds: Math.max(old ? old.rounds || 0 : 0, num(b.rounds, 0, 99)),
    closedAt: ['pagada', 'unida', 'cancelado'].includes(status) ? ((old && old.closedAt) || int(b.closedAt, 0, 9e15) || t) : null,
    requestedAt: (old && old.requestedAt) || (b.requestedAt ? int(b.requestedAt, 0, 9e15) : null),
    mergedInto: b.mergedInto ? str(b.mergedInto, 40) : (old && old.mergedInto) || null,
    name: '', phone: '', address: '', notes: '', pay: '', driver: null, paid: false, subtotal: total, fee: 0, total,
    source: 'panel', demo: bool(b.demo || (old && old.demo)),
    history: (Array.isArray(b.history) ? b.history : []).slice(-30).map(h => ({ s: str(h.s, 20), t: int(h.t, 0, 9e15) }))
  };
}
function normalizeSeed(o) {
  if (o && o.type === 'mesa' && o.id) return cleanMesa(o, str(o.id, 40), null);
  return o;
}
function cleanTables(a) {
  return a.slice(0, 40).map(t => ({ id: str(t.id, 30) || rid('t'), name: str(t.name, 30) || 'Mesa', seats: num(t.seats, 1, 30) || 4, x: Math.min(95, Math.max(0, Number(t.x) || 0)), y: Math.min(90, Math.max(0, Number(t.y) || 0)) }));
}
function applySettings(s, b) {
  if ('open' in b) s.open = !!b.open;
  if ('fee' in b) s.fee = num(b.fee, 0, 50000);
  if ('eta' in b) s.eta = str(b.eta, 30) || s.eta;
  if (Array.isArray(b.unavail)) s.unavail = b.unavail.slice(0, 200).map(x => str(x, 60));
  if (Array.isArray(b.tables)) s.tables = cleanTables(b.tables);
  if (Array.isArray(b.waiters)) s.waiters = b.waiters.slice(0, 20).map(x => str(x, 30)).filter(Boolean);
  if ('kdsLate' in b) s.kdsLate = num(b.kdsLate, 1, 120) || 15;
  if (b.shift && typeof b.shift === 'object') s.shift = { open: !!b.shift.open, openedAt: int(b.shift.openedAt, 0, 9e15), fondo: int(b.shift.fondo, 0, 1e8), by: str(b.shift.by, 40) };
  if (Array.isArray(b.shifts)) s.shifts = b.shifts.slice(0, 20).map(c => ({
    openedAt: int(c.openedAt, 0, 9e15), closedAt: int(c.closedAt, 0, 9e15), fondo: int(c.fondo, 0, 1e8), sales: int(c.sales, 0, 1e10), tips: int(c.tips, 0, 1e10),
    expected: int(c.expected, -1e10, 1e10), counted: int(c.counted, 0, 1e10), diff: int(c.diff, -1e10, 1e10), note: str(c.note, 200)
  }));
}
const PUBLIC_KEYS = ['open', 'fee', 'eta', 'unavail'];
const publicSettings = (s) => Object.fromEntries(PUBLIC_KEYS.map(k => [k, s[k]]));
const trim = () => {
  if (db.orders.length <= 1500) return;
  const done = new Set(['entregado', 'cancelado', 'pagada', 'unida']);
  db.orders.sort((a, b) => a.createdAt - b.createdAt);
  let extra = db.orders.length - 1500;
  db.orders = db.orders.filter(o => !(extra > 0 && done.has(o.status) && extra--));
};

function cleanOrder(b) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map(i => ({
    key: str(i.key, 80), id: str(i.id, 60), name: str(i.name, 80), variant: str(i.variant, 60), v: str(i.v, 40),
    qty: num(i.qty, 1, 50), price: num(i.price, 0, 100000)
  })).filter(i => i.name);
  if (!items.length) return null;
  const type = b.type === 'retiro' ? 'retiro' : 'delivery';
  const pay = ['efectivo', 'transferencia', 'local'].includes(b.pay) ? b.pay : 'efectivo';
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const fee = type === 'delivery' ? db.settings.fee : 0;
  const t = Date.now();
  return {
    id: 'o' + t.toString(36) + crypto.randomBytes(3).toString('hex'), num: ++db.seq, createdAt: t, status: 'nuevo',
    type, name: str(b.name, 80), phone: str(b.phone, 30), address: type === 'delivery' ? str(b.address, 160) : '',
    notes: str(b.notes, 300), pay: type === 'delivery' && pay === 'local' ? 'efectivo' : pay,
    cashFrom: b.cashFrom ? num(b.cashFrom, 0, 1000000) : null, paid: false, items, subtotal, fee, total: subtotal + fee,
    driver: null, source: b.source === 'panel' ? 'panel' : 'web', history: [{ s: 'nuevo', t }]
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  try {
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': ok\n\n'); streams.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(ka); streams.delete(res); });
      return;
    }
    if (p === '/api/settings' && m === 'GET') return send(res, 200, { settings: authed(req) ? db.settings : publicSettings(db.settings), init: db.init });
    if (p === '/api/settings' && m === 'PUT') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const b = await body(req), s = db.settings;
      applySettings(s, b);
      persist(); broadcast(); return send(res, 200, s);
    }
    if (p === '/api/login' && m === 'POST') {
      if (limited(ip + 'l')) return send(res, 429, { error: 'rate' });
      const b = await body(req);
      if (str(b.email, 100).toLowerCase() === ADMIN_EMAIL && String(b.pass || '') === ADMIN_PASS) {
        const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); return send(res, 200, { token: t });
      }
      return send(res, 401, { error: 'bad' });
    }
    if (p === '/api/orders' && m === 'GET') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      return send(res, 200, db.orders);
    }
    if (p === '/api/orders' && m === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'rate' });
      if (!db.settings.open) return send(res, 409, { error: 'closed' });
      const o = cleanOrder(await body(req));
      if (!o || !o.name || o.phone.replace(/\D/g, '').length < 8) return send(res, 400, { error: 'invalid' });
      db.orders.push(o); trim(); persist(); broadcast(); return send(res, 201, o);
    }
    const mo = p.match(/^\/api\/orders\/([\w-]+)$/);
    if (mo && m === 'GET') { const o = db.orders.find(x => x.id === mo[1]); return o && (o.type !== 'mesa' || authed(req)) ? send(res, 200, o) : send(res, 404, { error: 'nf' }); }
    if (mo && m === 'PUT') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const b = await body(req), old = db.orders.find(x => x.id === mo[1]);
      if (old && old.type !== 'mesa') return send(res, 400, { error: 'type' });
      if (!old && b.type !== 'mesa') return send(res, 400, { error: 'type' });
      const doc = cleanMesa(b, mo[1], old || null);
      if (old) db.orders[db.orders.indexOf(old)] = doc; else db.orders.push(doc);
      trim(); persist(); broadcast(); return send(res, 200, doc);
    }
    if (mo && m === 'PATCH') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const o = db.orders.find(x => x.id === mo[1]); if (!o) return send(res, 404, { error: 'nf' });
      const b = await body(req);
      if (STATUS.includes(b.status)) o.status = b.status;
      if ('driver' in b) o.driver = b.driver ? str(b.driver, 40) : null;
      if ('paid' in b) o.paid = !!b.paid;
      if (Array.isArray(b.history)) o.history = b.history.slice(-30).map(h => ({ s: str(h.s, 20), t: num(h.t, 0, 9e15) }));
      if (Array.isArray(b.items) && o.type !== 'mesa') { // solo marcas de cocina; nombres y precios no se tocan
        b.items.forEach((n, k) => { if (o.items[k] && n && n.name === o.items[k].name) { o.items[k].ready = !!n.ready; if (n.ready) o.items[k].readyAt = num(n.readyAt, 0, 9e15) || Date.now(); else delete o.items[k].readyAt; } });
      }
      persist(); broadcast(); return send(res, 200, o);
    }
    if (p === '/api/seed' && m === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      if (!db.init) { const b = await body(req); const arr = Array.isArray(b.orders) ? b.orders.slice(0, 30).map(normalizeSeed) : []; db.orders.push(...arr.map(o => Object.assign(o, { demo: true }))); db.seq = Math.max(db.seq, ...db.orders.map(o => o.num || 0)); if (b.settings && typeof b.settings === 'object') applySettings(db.settings, b.settings); db.init = true; persist(); broadcast(); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/reset' && m === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const b = await body(req); const arr = Array.isArray(b.orders) ? b.orders.slice(0, 30).map(normalizeSeed) : [];
      db.orders = arr.map(o => Object.assign(o, { demo: true })); db.seq = Math.max(100, ...db.orders.map(o => o.num || 0));
      db.settings = DEF_SETTINGS(); if (b.settings && typeof b.settings === 'object') applySettings(db.settings, b.settings); db.init = true; persist(); broadcast(); return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'nf' });
    // sitio (y /panel) -> index.html
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    fs.createReadStream(INDEX).pipe(res);
  } catch (e) {
    send(res, 400, { error: 'bad request' });
  }
});
server.listen(PORT, () => console.log(`Diego's Pizza demo en http://localhost:${PORT}  (panel: /panel)`));

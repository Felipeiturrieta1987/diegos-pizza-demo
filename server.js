// Servidor de Diego's Pizza (demo). Sin dependencias: solo Node 18+.
// Sirve el sitio y el panel, guarda los pedidos en un archivo JSON y avisa en vivo con SSE.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'data.json');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@diegospizza.cl').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'diegos2026';
const INDEX = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find(f => fs.existsSync(f));

let db = { init: false, seq: 100, orders: [], settings: { open: true, fee: 2000, eta: '30–40 min', unavail: [] } };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
let timer;
const persist = () => { clearTimeout(timer); timer = setTimeout(() => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('No se pudo guardar:', e.message); } }, 150); };
const tokens = new Set();
const streams = new Set();
const broadcast = () => { for (const r of streams) { try { r.write('data: 1\n\n'); } catch (e) {} } };
const hits = new Map();
const limited = (ip) => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > 20; };

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 200000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });
const authed = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); return t && tokens.has(t); };
const str = (v, n) => String(v == null ? '' : v).slice(0, n).trim();
const num = (v, min, max) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : min; };
const STATUS = ['nuevo', 'preparacion', 'listo', 'camino', 'entregado', 'cancelado'];

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
    if (p === '/api/settings' && m === 'GET') return send(res, 200, { settings: db.settings, init: db.init });
    if (p === '/api/settings' && m === 'PUT') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const b = await body(req), s = db.settings;
      if ('open' in b) s.open = !!b.open;
      if ('fee' in b) s.fee = num(b.fee, 0, 50000);
      if ('eta' in b) s.eta = str(b.eta, 30) || s.eta;
      if (Array.isArray(b.unavail)) s.unavail = b.unavail.slice(0, 200).map(x => str(x, 60));
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
      db.orders.push(o); persist(); broadcast(); return send(res, 201, o);
    }
    const mo = p.match(/^\/api\/orders\/([\w-]+)$/);
    if (mo && m === 'GET') { const o = db.orders.find(x => x.id === mo[1]); return o ? send(res, 200, o) : send(res, 404, { error: 'nf' }); }
    if (mo && m === 'PATCH') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const o = db.orders.find(x => x.id === mo[1]); if (!o) return send(res, 404, { error: 'nf' });
      const b = await body(req);
      if (STATUS.includes(b.status)) o.status = b.status;
      if ('driver' in b) o.driver = b.driver ? str(b.driver, 40) : null;
      if ('paid' in b) o.paid = !!b.paid;
      if (Array.isArray(b.history)) o.history = b.history.slice(-30).map(h => ({ s: str(h.s, 20), t: num(h.t, 0, 9e15) }));
      persist(); broadcast(); return send(res, 200, o);
    }
    if (p === '/api/seed' && m === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      if (!db.init) { const b = await body(req); const arr = Array.isArray(b.orders) ? b.orders.slice(0, 20) : []; db.orders.push(...arr.map(o => Object.assign(o, { demo: true }))); db.seq = Math.max(db.seq, ...db.orders.map(o => o.num || 0)); db.init = true; persist(); broadcast(); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/reset' && m === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'auth' });
      const b = await body(req); const arr = Array.isArray(b.orders) ? b.orders.slice(0, 20) : [];
      db.orders = arr.map(o => Object.assign(o, { demo: true })); db.seq = Math.max(100, ...db.orders.map(o => o.num || 0));
      db.settings = { open: true, fee: 2000, eta: '30–40 min', unavail: [] }; db.init = true; persist(); broadcast(); return send(res, 200, { ok: true });
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

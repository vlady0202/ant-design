// Kraken Futures REST client (v3) and the broker mirror used by the 24/7 runner.
// Demo by default: https://demo-futures.kraken.com. Keys come only from environment variables.
import crypto from 'node:crypto';

export function createKraken({ key, secret, base = 'https://demo-futures.kraken.com/derivatives', fetchImpl = fetch }) {
  let n = 0;
  async function call(method, path, params = {}, auth = true) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
    const ep = '/api/v3/' + path;
    const url = base + ep + (method === 'GET' && qs ? '?' + qs : '');
    const headers = {};
    if (auth) {
      // Authent = base64(HMAC-SHA512(base64decode(secret), SHA256(postData + nonce + endpointPath)))
      const nonce = String(Date.now()) + String(n++ % 1000).padStart(3, '0');
      const digest = crypto.createHash('sha256').update(qs + nonce + ep).digest();
      headers.APIKey = key;
      headers.Nonce = nonce;
      headers.Authent = crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(digest).digest('base64');
    }
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetchImpl(url, { method, headers, body: method === 'POST' ? qs : undefined });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok || j.result === 'error') throw new Error(`Kraken ${path}: ${j.error || ('HTTP ' + r.status)}`);
    return j;
  }
  return {
    call,
    instruments: () => call('GET', 'instruments', {}, false),
    positions: () => call('GET', 'openpositions'),
    orders: () => call('GET', 'openorders'),
    accounts: () => call('GET', 'accounts'),
    send: p => call('POST', 'sendorder', p),
    edit: p => call('POST', 'editorder', p),
    cancel: id => call('POST', 'cancelorder', { order_id: id }),
    cancelAll: symbol => call('POST', 'cancelallorders', symbol ? { symbol } : {}),
  };
}

const KSYM = s => 'PF_' + (s === 'BTC' ? 'XBT' : s) + 'USD';
const FROMK = k => k.replace(/^PF_/, '').replace(/USD$/, '').replace(/^XBT$/, 'BTC');

function orderId(res) {
  const st = res && res.sendStatus;
  if (!st || (st.status && st.status !== 'placed' && st.status !== 'edited')) throw new Error('orden rechazada (' + ((st && st.status) || 'sin respuesta') + ')');
  return st.order_id;
}

// Mirrors the bot's positions onto Kraken. S is the bot state (mutated), cmds the app's commands,
// K a client from createKraken (or null when the secrets are missing).
export async function syncBroker(S, cmds, K, now = Date.now()) {
  const B = S.broker = Object.assign({ map: {}, since: 0, killT: 0, err: '', snap: null }, S.broker || {});
  const log = m => { (S.log = S.log || []).unshift({ t: now, m: '[Kraken demo] ' + m }); if (S.log.length > 150) S.log.length = 150; };
  const on = S.set && S.set.broker === 'kraken-demo';
  const kill = (cmds || []).filter(c => c.type === 'kill' && c.t > B.killT).pop();
  if (!on && !kill) { B.snap = null; B.err = ''; return; }
  if (!K) { B.err = 'Faltan los secretos KRAKEN_DEMO_KEY y KRAKEN_DEMO_SECRET en GitHub (Settings → Secrets and variables → Actions).'; return; }
  try {
    const ins = await K.instruments();
    const I = Object.fromEntries((ins.instruments || []).map(x => [x.symbol, x]));
    const rp = (sym, p) => { const t = +(I[sym] && I[sym].tickSize) || 0.0001; return +(Math.round(p / t) * t).toFixed(10); };
    const rs = (sym, q) => { const d = I[sym] && I[sym].contractValueTradePrecision != null ? +I[sym].contractValueTradePrecision : 3; const f = 10 ** Math.max(0, d); return Math.floor(q * f + 1e-9) / f; };
    const close = x => K.send({ orderType: 'mkt', symbol: x.symbol, side: x.side === 'long' ? 'sell' : 'buy', size: x.size, reduceOnly: true });
    const cancelIds = async m => { for (const id of [m.slId, m.tp1Id, m.tp2Id]) if (id) { try { await K.cancel(id); } catch {} } };

    if (kill) {
      B.killT = kill.t;
      await K.cancelAll();
      for (const x of (await K.positions()).openPositions || []) await close(x);
      B.map = {}; S.set.broker = 'off';
      log('Parada de emergencia: órdenes canceladas, posiciones cerradas y conexión desactivada.');
    } else {
      if (!B.since) { B.since = now; log('Conexión activada: se replicarán las operaciones nuevas del bot.'); }
      // 1) new bot positions -> market entry + reduce-only stop and targets on the exchange
      for (const p of S.positions || []) {
        if (B.map[p.id] || p.t < B.since) continue;
        const sym = KSYM(p.sym), d = p.dir || 1;
        if (!I[sym]) { B.map[p.id] = { skip: 1 }; log(`${p.sym}: Kraken no tiene el perpetuo ${sym}; no se replica.`); continue; }
        const size = rs(sym, p.qty);
        if (!(size > 0)) { B.map[p.id] = { skip: 1 }; log(`${p.sym}: tamaño demasiado pequeño para Kraken; no se replica.`); continue; }
        const exit = d > 0 ? 'sell' : 'buy';
        orderId(await K.send({ orderType: 'mkt', symbol: sym, side: d > 0 ? 'buy' : 'sell', size, cliOrdId: 'cb-' + p.id }));
        const m = { sym, dir: d, size, t: now };
        m.slId = orderId(await K.send({ orderType: 'stp', symbol: sym, side: exit, size, stopPrice: rp(sym, p.sl), reduceOnly: true, triggerSignal: 'mark' }));
        const q1 = rs(sym, p.qty0 * 0.5), q2 = rs(sym, p.qty0 * 0.3);
        if (!p.tp1hit && q1 > 0) m.tp1Id = orderId(await K.send({ orderType: 'lmt', symbol: sym, side: exit, size: q1, limitPrice: rp(sym, p.tp1), reduceOnly: true }));
        if (!p.tp2hit && q2 > 0) m.tp2Id = orderId(await K.send({ orderType: 'lmt', symbol: sym, side: exit, size: q2, limitPrice: rp(sym, p.tp2), reduceOnly: true }));
        B.map[p.id] = m;
        log(`${d > 0 ? 'Largo' : 'Corto'} ${p.sym}: ${size} a mercado · stop ${rp(sym, p.sl)} · TP1 ${rp(sym, p.tp1)} · TP2 ${rp(sym, p.tp2)}`);
      }
      // 2) reconcile every mirrored position
      const xp = (await K.positions()).openPositions || [], xo = (await K.orders()).openOrders || [];
      for (const [id, m] of Object.entries(B.map)) {
        if (m.skip || m.closed) continue;
        const p = (S.positions || []).find(x => x.id === id), x = xp.find(z => z.symbol === m.sym), name = FROMK(m.sym);
        if (!x) { await cancelIds(m); m.closed = now; log(`${name}: la posición se cerró en Kraken (stop u objetivo).`); continue; }
        if (!p) { await cancelIds(m); await close(x); m.closed = now; log(`${name}: el bot cerró la posición; cerrada también en Kraken (${x.size}).`); continue; }
        const want = rp(m.sym, p.sl), so = xo.find(o => o.order_id === m.slId), exit = x.side === 'long' ? 'sell' : 'buy';
        if (!so) {
          m.slId = orderId(await K.send({ orderType: 'stp', symbol: m.sym, side: exit, size: x.size, stopPrice: want, reduceOnly: true, triggerSignal: 'mark' }));
          log(`${name}: stop repuesto en ${want}.`);
        } else if (Math.abs(+so.stopPrice - want) > 1e-9 || Math.abs(+so.unfilledSize - +x.size) > 1e-9) {
          await K.edit({ orderId: m.slId, size: x.size, stopPrice: want });
          log(`${name}: stop actualizado a ${want} (${x.size}).`);
        }
      }
      // keep only recent closed entries
      for (const [id, m] of Object.entries(B.map)) if ((m.closed || m.skip) && now - (m.closed || m.t || now) > 7 * 864e5) delete B.map[id];
    }
    const xp = (await K.positions()).openPositions || [], xo = (await K.orders()).openOrders || [];
    let acc = {};
    try { acc = (await K.accounts()).accounts || {}; } catch {}
    const flex = acc.flex || {};
    B.snap = {
      t: now,
      equity: +(flex.portfolioValue ?? flex.balanceValue ?? NaN),
      available: +(flex.availableMargin ?? NaN),
      positions: xp.map(x => ({ sym: FROMK(x.symbol), side: x.side, size: +x.size, price: +x.price })),
      orders: xo.length,
    };
    B.err = '';
  } catch (e) {
    B.err = String(e && e.message || e);
    log('Error: ' + B.err);
  }
}

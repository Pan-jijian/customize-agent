#!/usr/bin/env node
// 深入 undici pool 每个连接的 inflight/pending 状态
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
ws.onopen = async () => {
  try {
    await send('Runtime.enable', {});
    const expr = `(() => {
      try {
        const out = [];
        const agent = globalThis[Symbol.for('undici.globalDispatcher.2')];
        const clientsSym = Object.getOwnPropertySymbols(agent).find(s => String(s) === 'Symbol(clients)');
        const clients = agent[clientsSym];
        for (const [origin, pool] of clients) {
          out.push('POOL ' + String(origin));
          const pcSym = Object.getOwnPropertySymbols(pool).find(s => String(s) === 'Symbol(clients)');
          const poolClients = pool[pcSym];
          out.push('  pool.clients length=' + poolClients.length);
          for (const conn of poolClients) {
            const connSyms = Object.getOwnPropertySymbols(conn);
            const info = connSyms.map(s => {
              const v = conn[s];
              const sn = String(s);
              if (sn.includes('pending') || sn.includes('inflight') || sn.includes('queue') || sn.includes('size') || sn.includes('closed') || sn.includes('destroy') || sn.includes('idle') || sn.includes('connected')) {
                if (v instanceof Map) return sn + ':Map(' + v.size + ')';
                if (typeof v === 'number') return sn + ':' + v;
                if (Array.isArray(v)) return sn + ':Arr(' + v.length + ')';
                return sn + ':' + (v && v.constructor ? v.constructor.name : typeof v);
              }
              return null;
            }).filter(Boolean);
            out.push('  conn: ' + info.join(' | '));
          }
        }
        return out.join('\\n');
      } catch (e) { return 'ERR: ' + (e.stack || e.message).slice(0, 400); }
    })()`;
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(res.result?.result?.value ?? JSON.stringify(res));
  } catch (e) {
    console.error('ERR', e.message);
  }
  setTimeout(() => process.exit(0), 1000);
};
ws.onerror = (e) => { console.error('WS ERROR', e.message); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 25000);

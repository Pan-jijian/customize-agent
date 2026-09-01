#!/usr/bin/env node
// 查 undici 全局 dispatcher 的连接池 pending/queue 状态
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
        // 所有 undici 相关全局 symbol
        for (const k of Object.getOwnPropertySymbols(globalThis)) {
          const key = String(k);
          if (/undici/i.test(key)) {
            const v = globalThis[k];
            out.push('GLOBAL ' + key + ' => ' + (v && v.constructor ? v.constructor.name : typeof v));
            if (v && typeof v === 'object') {
              const syms = Object.getOwnPropertySymbols(v);
              for (const s of syms) {
                const sv = v[s];
                let desc = String(s).slice(0, 40);
                if (sv instanceof Map) {
                  desc += ' Map(' + sv.size + ')';
                  for (const [origin, pool] of sv) {
                    const psyms = Object.getOwnPropertySymbols(pool);
                    const poolInfo = psyms.map(ps => {
                      const pv = pool[ps];
                      const sn = String(ps).slice(0, 40);
                      if (pv instanceof Map) return sn + ':Map(' + pv.size + ')';
                      if (pv instanceof Set) return sn + ':Set(' + pv.size + ')';
                      if (Array.isArray(pv)) return sn + ':Arr(' + pv.length + ')';
                      if (typeof pv === 'number' || typeof pv === 'string') return sn + ':' + pv;
                      return sn + ':' + (pv && pv.constructor ? pv.constructor.name : typeof pv);
                    });
                    desc += ' | pool[' + String(origin).slice(0, 30) + ']: ' + poolInfo.join(', ');
                  }
                } else if (Array.isArray(sv)) {
                  desc += ' Arr(' + sv.length + ')';
                } else if (typeof sv === 'number' || typeof sv === 'string' || typeof sv === 'boolean') {
                  desc += ' =' + sv;
                }
                out.push('  ' + desc);
              }
            }
          }
        }
        return out.join('\\n') || 'NO_UNDICI_GLOBAL';
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

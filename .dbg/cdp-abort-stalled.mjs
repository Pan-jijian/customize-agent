#!/usr/bin/env node
// 强制销毁 undici 池中挂起的连接（pending 请求以错误结束），触发上层重试/失败路径
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
        const agent = globalThis[Symbol.for('undici.globalDispatcher.2')];
        const clientsSym = Object.getOwnPropertySymbols(agent).find(s => String(s) === 'Symbol(clients)');
        const pools = agent[clientsSym];
        let destroyed = 0;
        for (const [origin, pool] of pools) {
          const pcSym = Object.getOwnPropertySymbols(pool).find(s => String(s) === 'Symbol(clients)');
          const conns = pool[pcSym] || [];
          for (const conn of conns) {
            const qSym = Object.getOwnPropertySymbols(conn).find(s => String(s) === 'Symbol(queue)');
            const q = conn[qSym];
            const busyCount = q ? q.length : 0;
            if (busyCount > 0 && typeof conn.destroy === 'function') {
              conn.destroy(new Error('manual-abort-stalled-llm-request'));
              destroyed += 1;
            }
          }
        }
        return 'DESTROYED: ' + destroyed;
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

#!/usr/bin/env node
// 深度诊断：活动资源 + undici 连接池 pending + 主线程栈
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
    // 1. Node 活动资源
    const r1 = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        resources: process.getActiveResourcesInfo().reduce((a,c)=>{a[c]=(a[c]||0)+1;return a;},{}),
      })`,
      returnByValue: true,
    });
    console.log('RESOURCES:', r1.result?.result?.value || JSON.stringify(r1));

    // 2. undici 连接池状态（用内部 symbols 看 pending/queue）
    const r2 = await send('Runtime.evaluate', {
      expression: `(() => {
        try {
          const createRequire = require('module').createRequire(process.cwd() + '/noop.js');
          const sym = createRequire('undici/lib/core/symbols.js');
          const d = sym.getGlobalDispatcher ? sym.getGlobalDispatcher() : null;
          if (!d) {
            try {
              const ud = createRequire('undici');
              d = ud.getGlobalDispatcher();
            } catch (e2) { return 'NO_DISPATCHER: ' + e2.message; }
          }
          const clients = d[sym.kClients] || d[kClientsSym] || null;
          const out = [];
          for (const [origin, pool] of (clients || [])) {
            const st = pool[sym.kPool] ? {
              connected: pool[sym.kPool]?.length || 0,
              size: pool[sym.kPool]?.length || 0,
            } : null;
            out.push({
              origin: String(origin),
              pending: pool[sym.kPending]?.size ?? (pool[sym.kPending]?.length ?? '?'),
              queue: pool[sym.kQueue]?.length ?? '?',
              connected: pool[sym.kPool]?.length ?? '?',
            });
          }
          return 'POOLS: ' + JSON.stringify(out);
        } catch (e) { return 'ERR: ' + (e.stack || e.message).slice(0, 600); }
      })()`,
      returnByValue: true,
    });
    console.log('UNDICI:', r2.result?.result?.value || JSON.stringify(r2));

    // 3. 主线程栈
    const r3 = await send('Debugger.enable', {});
    const r4 = await send('Debugger.pause', {});
    await new Promise(r => setTimeout(r, 1500));
    const r5 = await send('Debugger.paused', {});
    // 等待 paused 事件后抓栈
    await new Promise(r => setTimeout(r, 800));
    const r6 = await send('Debugger.resume', {});
    console.log('PAUSE_OK');
  } catch (e) {
    console.error('ERR', e.message);
  }
  setTimeout(() => process.exit(0), 2000);
};
ws.onerror = (e) => { console.error('WS ERROR', e.message); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);

#!/usr/bin/env node
// 连接 next-server inspector，dump 事件循环活动句柄（定时器/请求）与异步栈线索
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
    pending.get(msg.id)(msg.result || msg.error);
    pending.delete(msg.id);
  }
};
ws.onopen = async () => {
  try {
    await send('Runtime.enable', {});
    const expr = `JSON.stringify({
      handles: process._getActiveHandles().map(h => h.constructor ? h.constructor.name : typeof h).reduce((a,c)=>{a[c]=(a[c]||0)+1;return a;},{}),
      requests: process._getActiveRequests().map(r => r.constructor ? r.constructor.name : typeof r).reduce((a,c)=>{a[c]=(a[c]||0)+1;return a;},{}),
    })`;
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(res.result?.value || JSON.stringify(res));
  } catch (e) {
    console.error('ERR', e);
  }
  process.exit(0);
};
ws.onerror = (e) => { console.error('WS ERROR', e.message); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);

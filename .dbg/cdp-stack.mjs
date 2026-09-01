#!/usr/bin/env node
// 抓 next-server 全部 JS 线程的异步调用栈（挂起在哪个 await）
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const framesByThread = [];
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
    return;
  }
  if (msg.method === 'Debugger.paused' && msg.params) {
    const cf = msg.params.callFrames || [];
    const thread = msg.params.hitBreakpoints ? 'main' : 'worker';
    const summary = cf.slice(0, 25).map((f) => {
      const loc = f.location || {};
      return `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-2).join('/')}:${loc.lineNumber}`;
    });
    framesByThread.push({ thread, summary });
    send('Debugger.resume', {});
  }
};
ws.onopen = async () => {
  try {
    await send('Debugger.enable', {});
    await send('Debugger.pause', {});
    await new Promise((r) => setTimeout(r, 2500));
    for (const t of framesByThread) {
      console.log(`\n=== ${t.thread} (${t.summary.length} frames) ===`);
      for (const line of t.summary) console.log('  ' + line);
    }
  } catch (e) {
    console.error('ERR', e);
  }
  process.exit(0);
};
ws.onerror = (e) => { console.error('WS ERROR', e.message); process.exit(1); };
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);

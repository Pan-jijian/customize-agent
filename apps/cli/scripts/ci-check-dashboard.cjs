const paths = ['/api/health', '/overview', '/api/config/providers', '/api/config/models', '/api/kb/features', '/api/system/stats'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  let last = '';
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const rows = [];
      for (const path of paths) {
        const res = await fetchWithTimeout('http://localhost:17321' + path, 5000);
        const text = await res.text();
        rows.push([path, res.status, text.slice(0, 120).replace(/\n/g, ' ')]);
      }
      for (const row of rows) console.log(row[0], row[1], row[2]);
      if (rows.every(row => row[1] < 500)) return;
      last = JSON.stringify(rows);
    } catch (error) {
      last = error && error.stack ? error.stack : String(error);
      console.log(last);
    }
    await sleep(2000);
  }
  console.error(last);
  process.exit(1);
})();

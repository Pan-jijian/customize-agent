export const dashboardStyles = `
:root {
  color-scheme: light;
  --bg:#f5f5f7;
  --bg-glass:rgba(255,255,255,.72);
  --panel:rgba(255,255,255,.86);
  --panel-solid:#ffffff;
  --line:rgba(60,60,67,.16);
  --line-strong:rgba(60,60,67,.26);
  --text:#1d1d1f;
  --muted:#6e6e73;
  --accent:#007aff;
  --accent-2:#5856d6;
  --danger:#ff3b30;
  --ok:#34c759;
  --warn:#ff9500;
  --shadow:0 18px 45px rgba(0,0,0,.08);
  --shadow-soft:0 8px 24px rgba(0,0,0,.06);
}
* { box-sizing: border-box; }
html { background:var(--bg); }
body {
  margin:0; min-height:100vh; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at 15% 0%, rgba(0,122,255,.12), transparent 28rem),
    radial-gradient(circle at 85% 8%, rgba(88,86,214,.10), transparent 26rem),
    linear-gradient(180deg, #fbfbfd 0%, var(--bg) 100%);
  color:var(--text);
}
header {
  position: sticky; top:0; z-index:10; backdrop-filter: saturate(180%) blur(22px); -webkit-backdrop-filter: saturate(180%) blur(22px);
  padding:20px max(32px, calc((100vw - 1480px) / 2 + 32px)); border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:18px;
  background:var(--bg-glass);
}
main { padding:28px 32px 40px; max-width:1480px; margin:0 auto; }
main, aside, main > div { min-width:0; }
.page { display:none; }
.page.active { display:block; }
.topbar { flex-wrap:nowrap; justify-content:flex-start; overflow-x:auto; padding-bottom:2px; scrollbar-width:none; }
.topbar::-webkit-scrollbar { display:none; }
.topbar > * { flex:0 0 auto; }
.tab { background:rgba(255,255,255,.72); border-radius:999px; padding:9px 15px; color:var(--muted); }
.tab.active { background:#1d1d1f; color:white; border-color:#1d1d1f; }
section {
  position:relative; overflow:visible;
  background:var(--panel); border:1px solid rgba(255,255,255,.7); border-radius:26px; padding:20px; box-shadow:var(--shadow-soft);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
}
section:has(.custom-select.open), section.select-host-open { z-index:10000; }
section:hover { box-shadow:var(--shadow); transform:translateY(-1px); transition:.2s ease; }
h1 { font-size:24px; margin:0; letter-spacing:-.02em; font-weight:700; }
h2 { font-size:12px; margin:0 0 14px; color:var(--muted); text-transform:uppercase; letter-spacing:.12em; font-weight:700; }
h3 { font-size:15px; margin:14px 0 8px; }
.subtitle { margin-top:6px; color:var(--muted); font-size:14px; }
button, input, select {
  min-width:0; background:rgba(255,255,255,.88); color:var(--text); border:1px solid var(--line); border-radius:14px; padding:10px 13px; outline:none;
  font: inherit; box-shadow: inset 0 0 0 1px rgba(255,255,255,.25);
}
select {
  min-width:132px; appearance:none; -webkit-appearance:none; padding-right:34px;
  background-image:linear-gradient(45deg, transparent 50%, #6e6e73 50%), linear-gradient(135deg, #6e6e73 50%, transparent 50%);
  background-position:calc(100% - 18px) 50%, calc(100% - 12px) 50%; background-size:6px 6px, 6px 6px; background-repeat:no-repeat;
}
button { cursor:pointer; white-space:nowrap; transition:.16s ease; font-weight:600; }
button:hover { border-color:rgba(0,122,255,.35); transform:translateY(-1px); box-shadow:0 8px 18px rgba(0,122,255,.12); }
button.primary { background:linear-gradient(180deg, #0a84ff, #007aff); border-color:transparent; color:white; box-shadow:0 10px 22px rgba(0,122,255,.24); }
input { width:100%; }
input::placeholder { color:#a1a1a6; }
input:focus, select:focus { border-color:rgba(0,122,255,.55); box-shadow:0 0 0 4px rgba(0,122,255,.12); }
.row { display:flex; gap:10px; margin-bottom:10px; align-items:center; }
.row input { flex:1; }
.stack { display:grid; gap:10px; }
.stack.compact { gap:8px; }
.field-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:center; }
.field-row:has(input + input + button) { grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) auto; }
.helper-title { font-size:15px; font-weight:700; color:var(--text); margin:2px 0 6px; }
.helper-text { color:var(--muted); font-size:13px; line-height:1.6; margin-bottom:12px; overflow-wrap:anywhere; }
.upload-card { display:flex; gap:14px; align-items:center; border:1.5px dashed rgba(0,122,255,.32); background:rgba(0,122,255,.06); border-radius:20px; padding:16px; cursor:pointer; margin-bottom:10px; }
.upload-card:hover { background:rgba(0,122,255,.10); border-color:rgba(0,122,255,.55); }
button.loading, .upload-card.loading { position:relative; pointer-events:none; opacity:.82; cursor:progress; }
button.loading::after, .upload-card.loading::after { content:''; width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; display:inline-block; margin-left:8px; vertical-align:-2px; animation:spin .8s linear infinite; }
.upload-card.loading::after { margin-left:auto; color:#007aff; width:18px; height:18px; }
button:disabled { cursor:progress; }
@keyframes spin { to { transform:rotate(360deg); } }
.upload-card input { display:none; }
.upload-card b { display:block; font-size:15px; }
.upload-card span { display:block; color:var(--muted); font-size:12px; line-height:1.45; margin-top:3px; overflow-wrap:anywhere; }
.upload-icon { width:38px; height:38px; flex:0 0 38px; border-radius:50%; display:grid; place-items:center; background:#007aff; color:white; font-weight:800; font-size:20px; }
.advanced-block { margin-top:12px; border:1px solid var(--line); border-radius:16px; padding:10px 12px; background:rgba(255,255,255,.55); }
.advanced-block summary { cursor:pointer; color:var(--muted); font-size:13px; font-weight:600; margin-bottom:8px; }
.divider { height:1px; background:var(--line); margin:16px 0; }
.search-bar { display:grid; grid-template-columns: 170px minmax(0, 1fr) auto; gap:10px; align-items:end; }
.filter-bar { display:grid; grid-template-columns: repeat(2, minmax(180px, 260px)); gap:10px; align-items:end; margin:12px 0 14px; }
.select-wrap { position:relative; display:grid; gap:5px; color:var(--muted); font-size:12px; font-weight:600; min-width:0; overflow:visible; }
.select-wrap.compact { min-width:130px; }
.language-select { width:96px; min-width:96px; }
.language-select select { min-width:96px; width:96px; cursor:pointer; }
.select-wrap select { width:100%; }
.select-native-hidden { position:absolute !important; opacity:0 !important; pointer-events:none !important; width:1px !important; height:1px !important; }
.custom-select { position:relative; min-width:0; z-index:1; }
.custom-select.open { z-index:10001; }
.custom-select-trigger { width:100%; justify-content:space-between; text-align:left; display:flex; align-items:center; gap:10px; background:rgba(255,255,255,.88); color:var(--text); border:1px solid var(--line); border-radius:14px; padding:10px 13px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.25); }
.custom-select-trigger::after { content:'⌄'; color:var(--muted); font-size:13px; line-height:1; display:inline-flex; align-items:center; justify-content:center; transform:translateY(-1px); flex:0 0 auto; }
.custom-select.open .custom-select-trigger { border-color:rgba(0,122,255,.55); box-shadow:0 0 0 4px rgba(0,122,255,.12); }
.custom-select-menu { display:none; position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:10002; max-height:260px; overflow:auto; padding:6px; border:1px solid var(--line); border-radius:16px; background:rgba(255,255,255,.98); box-shadow:0 18px 40px rgba(0,0,0,.16); backdrop-filter:blur(16px); }
.custom-select.open .custom-select-menu { display:block; }
.custom-select-option { display:block; width:100%; border:0; box-shadow:none; background:transparent; text-align:left; color:var(--text); border-radius:10px; padding:9px 10px; white-space:normal; }
.custom-select-option:hover, .custom-select-option.active { background:rgba(0,122,255,.10); color:var(--accent); transform:none; box-shadow:none; }
.config-row { display:grid; grid-template-columns:90px minmax(0, 1fr); gap:10px; align-items:start; padding:8px 0; border-top:1px solid var(--line); }
.config-row:first-child { border-top:0; }
.config-row b, .config-row span { min-width:0; overflow-wrap:anywhere; line-height:1.5; }
.file-group { border:1px solid var(--line); border-radius:18px; background:rgba(255,255,255,.58); margin-top:10px; overflow:hidden; }
.file-group summary { cursor:pointer; padding:12px 14px; font-weight:700; display:flex; justify-content:space-between; align-items:center; }
.file-group summary span { color:var(--muted); font-size:12px; }
.file-item { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:12px; padding:12px 14px; border-top:1px solid var(--line); align-items:center; }
.file-main { min-width:0; }
.file-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.file-actions button { padding:7px 9px; font-size:12px; }
.grid { display:grid; gap:20px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.panel-gap { margin-top:20px; }
.stat-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin:10px 0 12px; }
.metric { background:linear-gradient(180deg, #fff, #f7f7fa); border:1px solid var(--line); border-radius:18px; padding:14px; }
.metric b { display:block; font-size:24px; margin-top:4px; letter-spacing:-.03em; }
.metric span { color:var(--muted); font-size:12px; }
.stat { display:flex; justify-content:space-between; align-items:flex-start; color:var(--muted); margin:8px 0; gap:12px; }
.stat b { color:var(--text); }
.card { border-top:1px solid var(--line); padding:14px 0; }
.card:first-child { border-top:0; padding-top:0; }
.path { color:var(--accent); font-size:13px; overflow-wrap:anywhere; word-break:normal; font-weight:600; line-height:1.45; }
.meta { color:var(--muted); font-size:12px; overflow-wrap:anywhere; word-break:normal; line-height:1.55; min-width:0; }
.badge { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:3px 9px; font-size:12px; color:var(--muted); margin:3px 5px 3px 0; background:rgba(255,255,255,.7); }
.badge.ok { color:#1d7f3a; border-color:rgba(52,199,89,.28); background:rgba(52,199,89,.10); }
.badge.warn { color:#9a5a00; border-color:rgba(255,149,0,.30); background:rgba(255,149,0,.10); }
#capabilities { max-height: 460px; overflow:auto; padding-right:4px; }
#results .card { background:var(--panel-solid); border-radius:20px; border:1px solid var(--line); margin-top:12px; padding:16px; box-shadow:var(--shadow-soft); }
.status { color:var(--muted); min-height:20px; font-size:12px; margin-top:8px; }
.status.ok { color:var(--ok); }
.status.error { color:var(--danger); }
.toolbar { display:flex; gap:10px; align-items:center; justify-content:flex-end; }
pre { white-space:pre-wrap; word-break:break-word; color:#3a3a3c; margin:10px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.55; }
.subsection { margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }
.modal-backdrop { position:fixed; inset:0; z-index:20000; display:grid; place-items:center; background:rgba(15,23,42,.35); backdrop-filter:blur(10px); }
.modal-backdrop[hidden] { display:none; }
.modal-card { width:min(520px, calc(100vw - 32px)); background:rgba(255,255,255,.98); border:1px solid var(--line); border-radius:24px; box-shadow:0 28px 70px rgba(0,0,0,.22); padding:22px; }
.modal-card h3 { margin:0 0 8px; }
.modal-card p { white-space:pre-wrap; color:var(--muted); margin:0 0 14px; }
.modal-input { width:100%; box-sizing:border-box; margin:0 0 14px; border:1px solid var(--line); border-radius:14px; padding:11px 12px; font:inherit; }
.modal-actions { display:flex; justify-content:flex-end; gap:10px; }
button.danger { background:linear-gradient(135deg,#ff3b30,#ff6b5f); color:white; border-color:rgba(255,59,48,.25); }
@media (max-width: 1080px) { .grid { grid-template-columns:1fr; } }
@media (max-width: 680px) { main { padding:16px; } header { padding:16px; align-items:flex-start; flex-direction:column; } .toolbar { width:100%; justify-content:flex-start; flex-wrap:wrap; } .row { flex-direction:column; align-items:stretch; } .search-bar, .filter-bar { grid-template-columns:1fr; } select { width:100%; } .field-row, .field-row:has(input + input + button), .file-item, .config-row { grid-template-columns:1fr; } .file-actions { justify-content:flex-start; } .stat-grid { grid-template-columns:1fr; } .upload-card { align-items:flex-start; } }
`;

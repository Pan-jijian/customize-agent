import type { DashboardMessages } from './dashboard-i18n.js';

export function renderDashboardClient(messages: DashboardMessages): string {
  return `
const M = ${JSON.stringify(messages)};
let allKbFiles = [];
function formatText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(formatText).filter(Boolean).join(', ');
  if (typeof value === 'object') return Object.entries(value).map(([key, val]) => key + '=' + formatText(val)).join(', ');
  return String(value);
}
function switchLanguage(locale) {
  const url = new URL(window.location.href);
  url.searchParams.set('lang', locale);
  window.location.href = url.toString();
}
async function withButtonLoading(button, task) {
  const target = button || null;
  const canDisable = target && 'disabled' in target;
  if (target) {
    if (canDisable) target.disabled = true;
    target.classList.add('loading');
    target.setAttribute('aria-busy', 'true');
  }
  try {
    return await task();
  } finally {
    if (target) {
      if ('disabled' in target) target.disabled = false;
      target.classList.remove('loading');
      if (canReplaceText) target.textContent = original;
    }
  }
}
async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      throw new Error(body.error || body.message || text);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text);
      throw error;
    }
  }
  return res.json();
}
function showPage(page) {
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + page));
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.page === page));
}
async function load() {
  await Promise.all([
    safeLoad(loadStats, 'stats'),
    safeLoad(loadConfig, 'config'),
    safeLoad(loadProjects, 'projects'),
    safeLoad(loadCapabilities, 'capabilities'),
    safeLoad(loadRelationships, 'relationships'),
    safeLoad(loadFiles, 'filesPanel'),
    safeLoad(loadIgnoreRules, 'ignorePanel'),
    safeLoad(loadDuplicates, 'duplicates'),
  ]);
  enhanceCustomSelects();
}
async function safeLoad(fn, targetId) {
  try {
    await fn();
  } catch (error) {
    const el = document.getElementById(targetId);
    if (el) el.innerHTML = '<div class="meta">' + M.loadFailed + ': ' + escapeHtml(error.message || String(error)) + '</div>';
  }
}
async function loadStats() {
  const data = await api('/api/kb/stats');
  document.getElementById('stats').innerHTML = renderStats(M.project, data.project) + renderStats(M.global, data.global);
}
function renderStats(title, stats) {
  return '<h3>' + escapeHtml(title) + '</h3>' +
    '<div class="stat-grid">' +
    '<div class="metric"><span>' + M.files + '</span><b>' + stats.fileCount + '</b></div>' +
    '<div class="metric"><span>' + M.chunks + '</span><b>' + stats.chunkCount + '</b></div>' +
    '<div class="metric"><span>' + M.size + '</span><b>' + formatBytes(stats.totalSizeBytes) + '</b></div>' +
    '</div>' +
    '<div class="meta">' + escapeHtml(stats.kbPath) + '</div>';
}
async function loadConfig() {
  const data = await api('/api/kb/config');
  document.getElementById('config').innerHTML =
    '<div class="config-row"><b>' + M.projectId + '</b><span>' + escapeHtml(data.projectId) + '</span></div>' +
    '<div class="config-row"><b>' + M.path + '</b><span>' + escapeHtml(data.kbPath) + '</span></div>';
  const categoryEl = document.getElementById('categoryDirs');
  if (categoryEl) {
    const dirs = data.categoryDirs || {};
    categoryEl.innerHTML = Object.entries(dirs).map(([category, dir]) => '<div class="config-row"><b>' + categoryLabel(category) + '</b><span>' + escapeHtml(dir) + '</span></div>').join('') || '<div class="meta">' + M.noCategoryDirs + '</div>';
  }
}
async function loadProjects() {
  const data = await api('/api/kb/projects');
  document.getElementById('projects').innerHTML = data.projects.length
    ? data.projects.map(p => '<div class="card"><div class="path">' + escapeHtml(p.projectName || p.projectId) + '</div><div class="meta">' + escapeHtml(p.projectRoot) + '</div><span class="badge ok">' + p.fileCount + ' files</span><span class="badge">' + p.chunkCount + ' chunks</span></div>').join('')
    : '<div class="meta">' + M.noProjects + '</div>';
}
async function loadCapabilities() {
  const data = await api('/api/kb/capabilities');
  const builtIns = data.capabilities.map(item => '<div class="card"><div class="path">' + escapeHtml(formatText(item.category) + ' / ' + formatText(item.format)) + '</div><div><span class="badge ok">' + M.vectorizable + '</span><span class="badge ' + (item.builtInTool ? 'ok' : 'warn') + '">' + M.builtInTool + ': ' + (item.builtInTool ? M.yes : M.plugin) + '</span></div><div class="meta">' + M.extraction + ': ' + escapeHtml(formatText(item.extraction)) + '</div>' + (item.note ? '<div class="meta">' + escapeHtml(formatText(item.note)) + '</div>' : '') + '</div>').join('');
  const plugins = (data.externalExtractors || []).map(item => '<div class="card"><div class="path">' + M.plugin + ': ' + escapeHtml(formatText(item.name)) + '</div><span class="badge ' + (item.available ? 'ok' : 'warn') + '">' + (item.available ? M.available : M.unavailable) + '</span><div class="meta">' + escapeHtml([item.category, (item.formats || []).join('/'), (item.extensions || []).join('/')].filter(Boolean).map(formatText).join(' · ')) + '</div></div>').join('');
  document.getElementById('capabilities').innerHTML = builtIns + (plugins ? '<h3>' + M.externalPlugins + '</h3>' + plugins : '');
}
async function search(button) {
  const q = document.getElementById('query').value.trim();
  const scope = document.getElementById('scope').value;
  if (!q) return;
  await withButtonLoading(button, async () => {
    try {
      const data = await api('/api/kb/search?q=' + encodeURIComponent(q) + '&scope=' + scope);
      document.getElementById('results').innerHTML = data.results.length
        ? data.results.map(r => '<div class="card"><div class="path">' + escapeHtml(formatText(r.filePath)) + '</div><div class="meta"><span class="badge">' + M.scope + ': ' + formatText(r.scope) + '</span><span class="badge ok">' + M.score + ': ' + Number(r.score).toFixed(3) + '</span><span class="badge">' + escapeHtml(formatText(r.collection)) + '</span></div><pre>' + escapeHtml(formatText(r.content).slice(0, 700)) + '</pre></div>').join('')
        : '<div class="meta">' + M.noResults + '</div>';
    } catch (error) {
      document.getElementById('results').innerHTML = '<div class="meta">' + M.failed + ': ' + escapeHtml(error.message || String(error)) + '</div>';
    }
  }, M.loading);
}
async function syncNow(button) {
  await withButtonLoading(button, async () => {
    await api('/api/kb/reindex', { method:'POST' });
    await load();
  }, M.loading);
}
async function uploadFiles() {
  const input = document.getElementById('uploadFile');
  const files = Array.from(input.files || []);
  if (files.length === 0) return;
  const uploadCard = document.querySelector('.upload-card');
  await withButtonLoading(uploadCard, async () => {
    await runOp(async () => {
      let uploaded = 0;
      for (const file of files) {
        const contentBase64 = await readFileAsBase64(file);
        await api('/api/kb/upload', { method:'POST', body: JSON.stringify({ fileName: file.name, contentBase64 }) });
        uploaded++;
      }
      return M.uploadSuccess + ': ' + uploaded + ' ' + M.files;
    });
    input.value = '';
  }, M.loading);
}
async function runOp(operation) {
  setStatus('opsStatus', M.loading);
  try {
    const message = await operation();
    await load();
    setStatus('opsStatus', message || M.ok, true);
  } catch (error) {
    await load();
    setStatus('opsStatus', M.failed + ': ' + error.message, false, true);
  }
}
async function loadRelationships() {
  const data = await api('/api/kb/relationships');
  const relationships = data.relationships || [];
  document.getElementById('relationships').innerHTML = relationships.length
    ? relationships.slice(0, 80).map(r => '<div class="card"><div><span class="badge ok">' + escapeHtml(r.relationshipType) + '</span><span class="badge">' + Number(r.confidence).toFixed(2) + '</span></div><div class="meta">' + escapeHtml(r.sourceFile) + ' → ' + escapeHtml(r.targetFile) + '</div><div class="meta">' + escapeHtml(r.detail || '') + '</div></div>').join('')
    : '<div class="meta">' + M.noRelationships + '</div>';
  renderRelationshipSummary(relationships);
}
function renderRelationshipSummary(relationships) {
  const counts = new Map();
  for (const item of relationships) counts.set(item.relationshipType, (counts.get(item.relationshipType) || 0) + 1);
  document.getElementById('relationshipSummary').innerHTML = counts.size
    ? Array.from(counts.entries()).map(([type, count]) => '<div class="stat"><span>' + escapeHtml(type) + '</span><b>' + count + '</b></div>').join('')
    : '<div class="meta">' + M.noRelationships + '</div>';
}
async function loadFiles() {
  const data = await api('/api/kb/files');
  allKbFiles = data.files || [];
  renderFilesSyncStatus(data.sync);
  renderFileFilters();
  renderFiles();
  await loadFailedFiles();
}
async function loadFailedFiles() {
  const panel = document.getElementById('failedFilesPanel');
  if (!panel) return;
  const data = await api('/api/kb/failed-files');
  const failed = data.failedFiles || [];
  panel.innerHTML = failed.length ? failed.map(item => '<div class="file-item failed-file"><div class="file-main"><div class="path">' + escapeHtml(item.file.relativePath) + '</div><div class="meta">' + M.reason + ': ' + escapeHtml(formatText(item.reason)) + '</div><div class="meta">' + escapeHtml(formatText(item.file.format)) + ' · ' + formatBytes(item.file.fileSize) + '</div></div><div class="file-actions"><button onclick="retryFailedFile(this.dataset.path, this)" data-path="' + escapeAttr(item.file.relativePath) + '">' + M.retryIndex + '</button><button class="danger" onclick="deleteFileWithModal(this.dataset.path, this)" data-path="' + escapeAttr(item.file.relativePath) + '">' + M.delete + '</button></div></div>').join('') : '<div class="meta">' + M.noFailedFiles + '</div>';
}
async function retryFailedFile(filePath, button) {
  await withButtonLoading(button, async () => {
    await runOp(async () => {
      await api('/api/kb/failed-files/' + encodeURIComponent(filePath), { method:'POST' });
      return M.retryStarted;
    });
    await loadFiles();
  }, M.loading);
}
function renderFilesSyncStatus(sync) {
  const el = document.getElementById('filesSyncStatus');
  if (!el || !sync) return;
  const changed = (sync.newFiles?.length || 0) + (sync.modifiedFiles?.length || 0) + (sync.deletedFiles?.length || 0);
  const skipped = sync.skippedFiles?.length || 0;
  if (skipped > 0) {
    el.className = 'status error';
    el.textContent = M.filesSyncSkipped.replace('{count}', skipped);
  } else if (changed > 0) {
    el.className = 'status success';
    el.textContent = M.filesSyncChanged.replace('{count}', changed);
  } else {
    el.className = 'status success';
    el.textContent = M.filesSyncUnchanged;
  }
}
function renderFileFilters() {
  document.querySelectorAll('section.select-host-open').forEach(el => el.classList.remove('select-host-open'));
  document.querySelectorAll('.custom-select').forEach(el => el.remove());
  document.querySelectorAll('select.select-native-hidden').forEach(el => { el.classList.remove('select-native-hidden'); delete el.dataset.enhanced; });
  const typeEl = document.getElementById('fileTypeFilter');
  const folderEl = document.getElementById('folderFilter');
  if (!typeEl || !folderEl) return;
  const currentType = typeEl.value || 'all';
  const currentFolder = folderEl.value || 'all';
  const types = [...new Set(allKbFiles.map(file => file.category || 'other'))].sort();
  const folders = [...new Set(allKbFiles.map(file => firstFolder(file.relativePath)))].sort();
  typeEl.innerHTML = '<option value="all">' + M.allTypes + '</option>' + types.map(type => '<option value="' + escapeAttr(type) + '">' + categoryLabel(type) + '</option>').join('');
  folderEl.innerHTML = '<option value="all">' + M.allFolders + '</option>' + folders.map(folder => '<option value="' + escapeAttr(folder) + '">' + escapeHtml(folder) + '</option>').join('');
  typeEl.value = types.includes(currentType) ? currentType : 'all';
  folderEl.value = folders.includes(currentFolder) ? currentFolder : 'all';
  enhanceCustomSelects();
}
function renderFiles() {
  const type = document.getElementById('fileTypeFilter')?.value || 'all';
  const folder = document.getElementById('folderFilter')?.value || 'all';
  const files = allKbFiles.filter(file => (type === 'all' || file.category === type) && (folder === 'all' || firstFolder(file.relativePath) === folder));
  const groups = files.reduce((acc, file) => {
    const key = file.category || 'other';
    (acc[key] ||= []).push(file);
    return acc;
  }, {});
  const entries = Object.entries(groups);
  document.getElementById('filesPanel').innerHTML = entries.length ? entries.map(([category, items]) => '<details class="file-group" open><summary>' + categoryLabel(category) + ' <span>' + items.length + '</span></summary>' + items.map(file => '<div class="file-item"><div class="file-main"><div class="path">' + escapeHtml(file.relativePath) + '</div><div class="meta">' + escapeHtml(formatText(file.format)) + ' · ' + formatBytes(file.fileSize) + ' · ' + escapeHtml(firstFolder(file.relativePath)) + '</div></div><div class="file-actions"><button onclick="quickTag(this.dataset.path, this)" data-path="' + escapeAttr(file.relativePath) + '">' + M.tag + '</button><button onclick="ignoreSimilar(this.dataset.path, this)" data-path="' + escapeAttr(file.relativePath) + '">' + M.ignoreSimilar + '</button><button class="danger" onclick="deleteFileWithModal(this.dataset.path, this)" data-path="' + escapeAttr(file.relativePath) + '">' + M.delete + '</button></div></div>').join('') + '</details>').join('') : '<div class="meta">' + M.noFilteredFiles + '</div>';
}
function firstFolder(relativePath) {
  return String(relativePath || '').split('/')[0] || M.rootFolder;
}
async function deleteFileWithModal(filePath, button) {
  const ok = await openModal({ title: M.deleteConfirmTitle, message: M.deleteConfirmMessage + '\\n' + filePath, confirmText: M.delete, danger: true });
  if (!ok) return;
  await withButtonLoading(button, async () => {
    await runOp(async () => api('/api/kb/files/' + encodeURIComponent(filePath), { method:'DELETE' }));
    await loadFiles();
  }, M.loading);
}
async function quickTag(filePath, button) {
  const value = await openModal({ title: M.tag, message: M.tagPrompt, inputValue: M.defaultTag, confirmText: M.confirm });
  if (!value) return;
  const tags = String(value).split(',').map(t => t.trim()).filter(Boolean);
  await withButtonLoading(button, async () => runOp(async () => api('/api/kb/tags', { method:'POST', body: JSON.stringify({ filePath, tags }) })), M.loading);
}
async function ignoreSimilar(filePath, button) {
  const ext = filePath.includes('.') ? '*.' + filePath.split('.').pop() : filePath;
  const pattern = await openModal({ title: M.ignore, message: M.ignorePrompt, inputValue: '**/' + ext, confirmText: M.confirm });
  if (!pattern) return;
  await withButtonLoading(button, async () => runOp(async () => api('/api/kb/ignore', { method:'POST', body: JSON.stringify({ pattern }) })), M.loading);
}
function categoryLabel(category) {
  return M.categoryLabels?.[category] || category;
}
async function loadTags() {
  const data = await api('/api/kb/tags');
  const tags = data.tags || [];
  document.getElementById('tagsPanel').innerHTML = tags.length
    ? tags.slice(0, 100).map(t => '<div class="card"><span class="badge ok">' + escapeHtml(t.tag) + '</span><div class="meta">' + escapeHtml(t.filePath) + '</div></div>').join('')
    : '<div class="meta">' + M.noTags + '</div>';
}
async function loadIgnoreRules() {
  const data = await api('/api/kb/ignore');
  const rules = data.rules || [];
  document.getElementById('ignorePanel').innerHTML = rules.length
    ? rules.map(rule => '<div class="card"><span class="badge ' + (rule.enabled ? 'ok' : 'warn') + '">' + (rule.enabled ? M.enabled : M.disabled) + '</span><div class="path">' + escapeHtml(rule.pattern) + '</div></div>').join('')
    : '<div class="meta">' + M.noIgnoreRules + '</div>';
}
async function loadDuplicates() {
  const data = await api('/api/kb/duplicates');
  const duplicates = data.duplicates || [];
  document.getElementById('duplicates').innerHTML = duplicates.length
    ? duplicates.slice(0, 50).map(d => '<div class="card"><div class="path">' + escapeHtml(d.contentHash.slice(0, 16)) + '</div>' + d.files.map(f => '<div class="meta">' + escapeHtml(f.projectId + ': ' + f.relativePath) + '</div>').join('') + '</div>').join('')
    : '<div class="meta">' + M.noDuplicates + '</div>';
}
function openModal(options) {
  return new Promise(resolve => {
    const backdrop = document.getElementById('modalBackdrop');
    const title = document.getElementById('modalTitle');
    const message = document.getElementById('modalMessage');
    const cancel = document.getElementById('modalCancel');
    const confirm = document.getElementById('modalConfirm');
    title.textContent = options.title || '';
    message.textContent = options.message || '';
    message.querySelectorAll('input').forEach(input => input.remove());
    const input = options.inputValue != null ? document.createElement('input') : undefined;
    if (input) {
      input.className = 'modal-input';
      input.value = options.inputValue;
      message.after(input);
    }
    cancel.textContent = M.cancel;
    confirm.textContent = options.confirmText || M.confirm;
    confirm.classList.toggle('danger', Boolean(options.danger));
    const cleanup = value => {
      backdrop.hidden = true;
      cancel.onclick = null;
      confirm.onclick = null;
      input?.remove();
      resolve(value);
    };
    cancel.onclick = () => cleanup(false);
    confirm.onclick = () => cleanup(input ? input.value : true);
    backdrop.hidden = false;
    input?.focus();
  });
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function setStatus(id, text, ok, error) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = error ? 'status error' : ok ? 'status ok' : 'status';
  el.textContent = text;
}
function enhanceCustomSelects() {
  document.querySelectorAll('select').forEach(select => {
    if (select.classList.contains('native-select') || select.classList.contains('select-native-hidden') || select.dataset.enhanced === 'true') return;
    select.dataset.enhanced = 'true';
    select.classList.add('select-native-hidden');
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    wrapper.append(trigger, menu);
    select.insertAdjacentElement('afterend', wrapper);
    const sync = () => {
      const selected = select.options[select.selectedIndex];
      trigger.textContent = selected ? selected.textContent : '';
      menu.innerHTML = '';
      Array.from(select.options).forEach(option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'custom-select-option' + (option.value === select.value ? ' active' : '');
        button.textContent = option.textContent;
        button.onclick = () => {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          wrapper.classList.remove('open');
          wrapper.closest('section')?.classList.remove('select-host-open');
          sync();
        };
        menu.appendChild(button);
      });
    };
    trigger.onclick = event => {
      event.stopPropagation();
      document.querySelectorAll('.custom-select.open').forEach(el => { if (el !== wrapper) { el.classList.remove('open'); el.closest('section')?.classList.remove('select-host-open'); } });
      const isOpen = wrapper.classList.toggle('open');
      wrapper.closest('section')?.classList.toggle('select-host-open', isOpen);
    };
    select.addEventListener('change', sync);
    sync();
  });
}
document.addEventListener('click', () => document.querySelectorAll('.custom-select.open').forEach(el => { el.classList.remove('open'); el.closest('section')?.classList.remove('select-host-open'); }));
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return value.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
load().catch(err => document.body.insertAdjacentHTML('beforeend', '<pre>' + escapeHtml(String(err)) + '</pre>'));
`;
}

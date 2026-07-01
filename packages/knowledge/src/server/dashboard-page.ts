import type { DashboardLocale, DashboardMessages } from './dashboard-i18n.js';
import { dashboardStyles } from './dashboard-styles.js';
import { renderDashboardClient } from './dashboard-client.js';

export interface DashboardPageOptions {
  locale: DashboardLocale;
  messages: DashboardMessages;
}

export function renderDashboardHtml(options: DashboardPageOptions): string {
  const { locale, messages } = options;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(messages.title)}</title>
<style>${dashboardStyles}</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(messages.title)}</h1>
    <div class="subtitle">${escapeHtml(messages.subtitle)}</div>
  </div>
  <div class="toolbar topbar">
    <button class="tab active" data-page="overview" onclick="showPage('overview')">${escapeHtml(messages.overviewTab)}</button>
    <button class="tab" data-page="files" onclick="showPage('files')">${escapeHtml(messages.filesTab)}</button>
    <button class="tab" data-page="settings" onclick="showPage('settings')">${escapeHtml(messages.settingsTab)}</button>
    <label class="select-wrap compact language-select"><select id="languageSelect" class="native-select" aria-label="${escapeAttr(messages.language)}" onchange="switchLanguage(this.value)"><option value="zh-CN" ${locale === 'zh-CN' ? 'selected' : ''}>中文</option><option value="en-US" ${locale === 'en-US' ? 'selected' : ''}>English</option></select></label>
    <button id="syncButton" class="primary" onclick="syncNow(this)">${escapeHtml(messages.syncNow)}</button>
  </div>
</header>
<main>
  <div id="page-overview" class="page active">
    <section>
      <h2>${escapeHtml(messages.search)}</h2>
      <div class="helper-text">${escapeHtml(messages.searchHelp)}</div>
      <div class="search-bar">
        <label class="select-wrap"><span>${escapeHtml(messages.scopeLabel)}</span><select id="scope"><option value="all">${escapeHtml(messages.scopeAll)}</option><option value="project">${escapeHtml(messages.scopeProject)}</option><option value="global">${escapeHtml(messages.scopeGlobal)}</option></select></label>
        <input id="query" placeholder="${escapeAttr(messages.searchPlaceholder)}" onkeydown="if(event.key==='Enter') search(document.getElementById('searchButton'))" />
        <button id="searchButton" class="primary" onclick="search(this)">${escapeHtml(messages.search)}</button>
      </div>
      <div id="results"></div>

    </section>
    <section class="panel-gap upload-summary">
      <h2>${escapeHtml(messages.fileOps)}</h2>
      <div class="helper-title">${escapeHtml(messages.uploadTitle)}</div>
      <div class="helper-text">${escapeHtml(messages.uploadHelp)}</div>
      <div class="upload-card" onclick="document.getElementById('uploadFile').click()">
        <input id="uploadFile" type="file" multiple onchange="uploadFiles()" />
        <div class="upload-icon">↑</div>
        <div><b>${escapeHtml(messages.uploadChoose)}</b><span>${escapeHtml(messages.uploadSupport)}</span></div>
      </div>
      <div id="opsStatus" class="status"></div>
    </section>
    <div class="grid panel-gap">
      <section>
        <h2>${escapeHtml(messages.stats)}</h2>
        <div id="stats">${escapeHtml(messages.loading)}</div>
      </section>
      <section>
        <h2>${escapeHtml(messages.config)}</h2>
        <div id="config">${escapeHtml(messages.loading)}</div>
      </section>
    </div>
    <div class="grid panel-gap">
      <section>
        <h2>${escapeHtml(messages.relationshipSummary)}</h2>
        <div id="relationshipSummary">${escapeHtml(messages.loading)}</div>
      </section>
      <section>
        <h2>${escapeHtml(messages.duplicates)}</h2>
        <div id="duplicates">${escapeHtml(messages.loading)}</div>
      </section>
    </div>
  </div>

  <div id="page-files" class="page">
    <section>
      <h2>${escapeHtml(messages.filesTitle)}</h2>
      <div class="helper-text">${escapeHtml(messages.filesHelp)}</div>
      <div class="filter-bar">
        <label class="select-wrap"><span>${escapeHtml(messages.fileType)}</span><select id="fileTypeFilter" onchange="renderFiles()"><option value="all">${escapeHtml(messages.allTypes)}</option></select></label>
        <label class="select-wrap"><span>${escapeHtml(messages.folderDir)}</span><select id="folderFilter" onchange="renderFiles()"><option value="all">${escapeHtml(messages.allFolders)}</option></select></label>
      </div>
      <div id="filesSyncStatus" class="status"></div>
      <div id="filesPanel">${escapeHtml(messages.loading)}</div>
      <div class="subsection">
        <h3>${escapeHtml(messages.failedFilesTitle)}</h3>
        <div class="helper-text">${escapeHtml(messages.failedFilesHelp)}</div>
        <div id="failedFilesPanel">${escapeHtml(messages.loading)}</div>
      </div>
    </section>
  </div>

  <div id="page-settings" class="page">
    <div class="grid">
      <section>
        <h2>${escapeHtml(messages.capabilities)}</h2>
        <div id="capabilities">${escapeHtml(messages.loading)}</div>
      </section>
      <section>
        <h2>${escapeHtml(messages.categoryDirs)}</h2>
        <div class="helper-text">${escapeHtml(messages.categoryDirsHelp)}</div>
        <div id="categoryDirs">${escapeHtml(messages.loading)}</div>
      </section>
    </div>
    <div class="grid panel-gap">
      <section>
        <h2>${escapeHtml(messages.ignoreRules)}</h2>
        <div id="ignorePanel">${escapeHtml(messages.loading)}</div>
      </section>
      <section>
        <h2>${escapeHtml(messages.projects)}</h2>
        <div id="projects">${escapeHtml(messages.loading)}</div>
      </section>
    </div>
    <section class="panel-gap">
      <h2>${escapeHtml(messages.relationships)}</h2>
      <div id="relationships">${escapeHtml(messages.loading)}</div>
    </section>
  </div>
</main>
<div id="modalBackdrop" class="modal-backdrop" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
    <h3 id="modalTitle"></h3>
    <p id="modalMessage"></p>
    <div class="modal-actions">
      <button id="modalCancel" type="button"></button>
      <button id="modalConfirm" class="danger" type="button"></button>
    </div>
  </div>
</div>
<script>${renderDashboardClient(messages)}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

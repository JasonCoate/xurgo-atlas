import * as http from 'node:http';
import * as express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { ZodError } from 'zod';
import { Project } from '../core/project.js';
import { isPathTraversal } from '../core/patch.js';
import { ProjectResolver } from './types.js';
import {
  handleContextPack,
  handleManifest,
  handleRead,
  handleReadSection,
  handleStatus,
} from './tools.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface HttpServerOptions {
  host: string;
  port: number;
  allowedOrigins?: ReadonlyArray<string | RegExp>;
  rest?: RestApiOptions;
}

export interface RestProjectSummary {
  projectId: string;
  createdAt?: string;
  updatedAt?: string;
  default?: boolean;
}

export interface RestApiOptions {
  resolveProject: ProjectResolver;
  listProjects: () => Promise<RestProjectSummary[]> | RestProjectSummary[];
}

// ── Default allowed origins ────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS: ReadonlyArray<string | RegExp> = [
  'null',
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https?:\/\/localhost(?::\d+)?$/,
];

const MCP_DEBUG_LOG_ENV_VAR = 'XURGO_ATLAS_DEBUG_MCP';
const MCP_LOG_COMPONENT = 'mcp-http';

let mcpRequestCounter = 0;

function isVerboseMcpLoggingEnabled(): boolean {
  return process.env[MCP_DEBUG_LOG_ENV_VAR] === '1';
}

function nextMcpCorrelationId(): string {
  mcpRequestCounter += 1;
  return `mcp-${process.pid}-${mcpRequestCounter}`;
}

function logMcpJson(event: {
  severity: 'debug' | 'info' | 'warn' | 'error';
  eventCode: string;
  correlationId: string;
  errorCategory?: string;
  request?: Record<string, string | number | boolean | null | undefined>;
}): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      component: MCP_LOG_COMPONENT,
      ...event,
    }),
  );
}

function logMcpDebug(event: Parameters<typeof logMcpJson>[0]): void {
  if (isVerboseMcpLoggingEnabled()) {
    logMcpJson(event);
  }
}

function logMcpEvent(event: Parameters<typeof logMcpJson>[0]): void {
  logMcpJson(event);
}

function getMcpRequestSummary(req: { method: string; path: string; body: unknown; headers: http.IncomingHttpHeaders }): Record<string, string | number | boolean | null | undefined> {
  return {
    method: req.method,
    path: req.path,
    originPresent: typeof req.headers.origin === 'string',
    contentLength: typeof req.headers['content-length'] === 'string' ? Number(req.headers['content-length']) : null,
    hasBody: req.body !== undefined && req.body !== null,
    bodyKind: Array.isArray(req.body) ? 'array' : typeof req.body,
  };
}

function categorizeMcpError(err: unknown): string {
  if (err instanceof Error && err.name) {
    return err.name;
  }
  return typeof err;
}

// ── Minimal read-only UI assets ───────────────────────────────────────

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Xurgo Atlas</title>
  <link rel="stylesheet" href="/ui/styles.css">
  <script defer src="/ui/app.js"></script>
</head>
<body>
  <div id="app" class="shell">
    <header class="topbar">
      <div>
        <h1>Xurgo Atlas</h1>
        <p id="projectMeta" class="muted">Loading project context...</p>
      </div>
      <div class="actions">
        <select id="projectSelect" aria-label="Project"></select>
        <button id="copyContext" type="button">Copy Context</button>
      </div>
    </header>
    <main class="layout">
      <aside class="sidebar">
        <div class="sidebarHeader">
          <h2>Manifest</h2>
          <span id="manifestMeta" class="muted"></span>
        </div>
        <nav id="docNav" class="docNav" aria-label="Documents"></nav>
      </aside>
      <section class="viewerPane">
        <div class="viewerToolbar">
          <div>
            <h2 id="viewTitle">STATUS.md</h2>
            <p id="viewMeta" class="muted"></p>
          </div>
          <div class="actions">
            <select id="sectionSelect" aria-label="Section"></select>
            <button id="copySection" type="button">Copy Section</button>
            <button id="copyDocument" type="button">Copy Document</button>
          </div>
        </div>
        <article id="viewer" class="viewer" aria-live="polite"></article>
      </section>
    </main>
  </div>
</body>
</html>`;

const UI_CSS = `
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #17202a;
  --muted: #657384;
  --line: #d9dee7;
  --accent: #1f6feb;
  --accent-soft: #e8f0fe;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, select {
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}
button {
  padding: 0 12px;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }
select { padding: 0 28px 0 10px; }
.shell { min-height: 100vh; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
h1, h2, p { margin: 0; }
h1 { font-size: 18px; }
h2 { font-size: 15px; }
.muted { color: var(--muted); font-size: 12px; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.layout {
  display: grid;
  grid-template-columns: minmax(240px, 320px) 1fr;
  min-height: calc(100vh - 65px);
}
.sidebar {
  border-right: 1px solid var(--line);
  background: #fbfcfd;
  overflow: auto;
}
.sidebarHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--line);
}
.docNav {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
}
.docButton {
  width: 100%;
  min-height: 58px;
  padding: 8px 10px;
  text-align: left;
  border-radius: 6px;
}
.docButton.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.docPath {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.docSummary {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
.viewerPane {
  min-width: 0;
  background: var(--panel);
}
.viewerToolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.viewer {
  max-width: 980px;
  padding: 22px 28px 48px;
  line-height: 1.58;
}
.viewer h1 { font-size: 26px; margin: 0 0 14px; }
.viewer h2 { font-size: 20px; margin: 24px 0 10px; }
.viewer h3 { font-size: 17px; margin: 20px 0 8px; }
.viewer p, .viewer ul, .viewer ol, .viewer pre { margin: 0 0 14px; }
.viewer code, .viewer pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.viewer pre {
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #f8fafc;
}
.viewer blockquote {
  margin: 0 0 14px;
  padding-left: 12px;
  border-left: 3px solid var(--line);
  color: var(--muted);
}
.error {
  color: #9a3412;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 6px;
  padding: 10px 12px;
}
@media (max-width: 760px) {
  .topbar, .viewerToolbar { align-items: flex-start; flex-direction: column; }
  .layout { grid-template-columns: 1fr; }
  .sidebar { max-height: 38vh; border-right: 0; border-bottom: 1px solid var(--line); }
  .viewer { padding: 18px; }
}
`;

const UI_JS = `
const state = {
  projectId: null,
  branch: 'main',
  manifest: null,
  currentPath: 'STATUS.md',
  currentContent: '',
  currentRevision: null,
  headings: [],
};

const els = {
  projectMeta: document.getElementById('projectMeta'),
  projectSelect: document.getElementById('projectSelect'),
  manifestMeta: document.getElementById('manifestMeta'),
  docNav: document.getElementById('docNav'),
  viewTitle: document.getElementById('viewTitle'),
  viewMeta: document.getElementById('viewMeta'),
  viewer: document.getElementById('viewer'),
  sectionSelect: document.getElementById('sectionSelect'),
  copyDocument: document.getElementById('copyDocument'),
  copySection: document.getElementById('copySection'),
  copyContext: document.getElementById('copyContext'),
};

async function api(path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method || 'GET', path, true);
    request.setRequestHeader('Content-Type', 'application/json');
    request.onload = () => {
      let data = {};
      try {
        data = request.responseText ? JSON.parse(request.responseText) : {};
      } catch (err) {
        reject(new Error('Invalid JSON response'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        const message = data && data.error ? data.error.message : 'Request failed';
        reject(new Error(message));
        return;
      }
      resolve(data);
    };
    request.onerror = () => reject(new Error('Network request failed'));
    request.send(options.body || null);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMarkdown(markdown) {
  const lines = markdown.split('\\n');
  const html = [];
  let inCode = false;
  let listOpen = false;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push('<p>' + paragraph.map(escapeHtml).join(' ') + '</p>');
      paragraph = [];
    }
  }
  function closeList() {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  }

  for (const line of lines) {
    if (/^ {0,3}\x60{3}/.test(line)) {
      flushParagraph();
      closeList();
      html.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(escapeHtml(line) + '\\n');
      continue;
    }
    const heading = line.match(/^(#{1,6})\\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push('<h' + level + '>' + escapeHtml(heading[2]) + '</h' + level + '>');
      continue;
    }
    const bullet = line.match(/^[-*]\\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push('<li>' + escapeHtml(bullet[1]) + '</li>');
      continue;
    }
    if (/^>\\s?/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<blockquote>' + escapeHtml(line.replace(/^>\\s?/, '')) + '</blockquote>');
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  if (inCode) {
    html.push('</code></pre>');
  }
  return html.join('\\n');
}

function collectHeadings(markdown) {
  const counts = new Map();
  const headings = [];
  let inCode = false;
  markdown.split('\\n').forEach((line, index) => {
    if (/^ {0,3}\x60{3}/.test(line)) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;
    const match = line.match(/^(#{1,6})\\s+(.*)$/);
    if (!match) return;
    const text = match[2].replace(/\\s+#+\\s*$/, '').trim();
    const key = match[1].length + ':' + text.toLowerCase();
    const occurrence = (counts.get(key) || 0) + 1;
    counts.set(key, occurrence);
    headings.push({
      heading: text,
      level: match[1].length,
      occurrence,
      line: index + 1,
    });
  });
  return headings;
}

function setMeta(data) {
  state.currentRevision = data.revision || null;
  els.projectMeta.textContent = 'Project ' + state.projectId + ' | branch ' + (data.branch || state.branch);
  els.viewMeta.textContent = [
    'projectId=' + state.projectId,
    'branch=' + (data.branch || state.branch),
    data.revision ? 'revision=' + data.revision.slice(0, 12) : null,
    data.path ? 'path=' + data.path : null,
  ].filter(Boolean).join(' | ');
}

function renderNav() {
  const documents = state.manifest && Array.isArray(state.manifest.documents)
    ? state.manifest.documents
    : [];
  els.manifestMeta.textContent = documents.length + ' docs';
  els.docNav.replaceChildren();
  documents.forEach((doc) => {
    if (!doc || !doc.path) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'docButton' + (doc.path === state.currentPath ? ' active' : '');
    const path = document.createElement('span');
    path.className = 'docPath';
    path.textContent = doc.path;
    const summary = document.createElement('span');
    summary.className = 'docSummary';
    summary.textContent = doc.summary || doc.role || '';
    button.append(path, summary);
    button.addEventListener('click', () => loadDocument(doc.path));
    els.docNav.appendChild(button);
  });
}

function renderSections() {
  els.sectionSelect.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'Whole document';
  els.sectionSelect.appendChild(all);
  state.headings.forEach((heading, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = '#'.repeat(heading.level) + ' ' + heading.heading;
    els.sectionSelect.appendChild(option);
  });
}

async function loadProjects() {
  const data = await api('/projects');
  const projects = data.projects || [];
  els.projectSelect.replaceChildren();
  projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = project.projectId;
    option.textContent = project.projectId;
    option.selected = Boolean(project.default);
    els.projectSelect.appendChild(option);
  });
  const selected = projects.find((project) => project.default) || projects[0];
  if (!selected) {
    throw new Error('No registered projects');
  }
  state.projectId = selected.projectId;
  els.projectSelect.value = state.projectId;
}

async function loadManifest() {
  state.manifest = await api('/projects/' + encodeURIComponent(state.projectId) + '/manifest?branch=' + encodeURIComponent(state.branch));
  renderNav();
}

async function loadDocument(path) {
  state.currentPath = path;
  els.viewTitle.textContent = path;
  els.viewer.innerHTML = '<p class="muted">Loading...</p>';
  renderNav();
  const data = await api('/projects/' + encodeURIComponent(state.projectId) + '/docs/' + encodeURIComponent(path) + '?branch=' + encodeURIComponent(state.branch) + '&maxChars=80000');
  state.currentContent = data.content || '';
  state.headings = collectHeadings(state.currentContent);
  setMeta(data);
  renderSections();
  els.viewer.innerHTML = renderMarkdown(state.currentContent);
  renderNav();
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand || !document.execCommand('copy')) {
      throw new Error('Clipboard API is unavailable');
    }
  } finally {
    textarea.remove();
  }
}

async function copySelectedSection() {
  const index = Number(els.sectionSelect.value);
  if (!Number.isInteger(index) || !state.headings[index]) {
    await copyText(state.currentContent);
    return;
  }
  const heading = state.headings[index];
  const params = new URLSearchParams({
    path: state.currentPath,
    heading: heading.heading,
    level: String(heading.level),
    occurrence: String(heading.occurrence),
    includeHeading: 'true',
    maxChars: '80000',
    branch: state.branch,
  });
  const data = await api('/projects/' + encodeURIComponent(state.projectId) + '/sections?' + params.toString());
  await copyText(data.content || '');
}

async function copyContextPack() {
  const data = await api('/projects/' + encodeURIComponent(state.projectId) + '/context-pack', {
    method: 'POST',
    body: JSON.stringify({
      branch: state.branch,
      maxChars: 8000,
      paths: state.currentPath === 'STATUS.md' ? [] : [state.currentPath],
    }),
  });
  const parts = [
    'projectId: ' + data.projectId,
    'branch: ' + data.branch,
    'revision: ' + data.revision,
    '',
  ];
  (data.items || []).forEach((item) => {
    parts.push('## ' + item.kind + ': ' + item.path);
    if (item.heading) parts.push('heading: ' + item.heading);
    if (item.truncated) parts.push('[truncated]');
    parts.push(item.content || '');
    parts.push('');
  });
  await copyText(parts.join('\\n'));
}

function showError(err) {
  els.viewer.innerHTML = '<div class="error">' + escapeHtml(err.message || String(err)) + '</div>';
}

els.projectSelect.addEventListener('change', async () => {
  try {
    state.projectId = els.projectSelect.value;
    await loadManifest();
    await loadDocument('STATUS.md');
  } catch (err) {
    showError(err);
  }
});
els.copyDocument.addEventListener('click', () => copyText(state.currentContent).catch(showError));
els.copySection.addEventListener('click', () => copySelectedSection().catch(showError));
els.copyContext.addEventListener('click', () => copyContextPack().catch(showError));

(async function init() {
  try {
    await loadProjects();
    await loadManifest();
    await loadDocument('STATUS.md');
  } catch (err) {
    showError(err);
  }
})();
`;

// ── CORS helpers ───────────────────────────────────────────────────────

function setCorsHeaders(
  res: http.ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlyArray<string | RegExp>,
): void {
  // Set Access-Control-Allow-Origin if origin is allowed
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // No origin header (non-browser client) - allow
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  // These headers are safe to always set
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlyArray<string | RegExp>,
): boolean {
  if (!origin) {
    return true; // No origin header = non-browser client, allow
  }

  for (const allowed of allowedOrigins) {
    if (typeof allowed === 'string') {
      if (origin === allowed) return true;
    } else if (allowed instanceof RegExp) {
      if (allowed.test(origin)) return true;
    }
  }

  return false;
}

// ── REST helpers ──────────────────────────────────────────────────────

class RestError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getQueryString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getOptionalPositiveInt(
  value: string | string[] | undefined,
  name: string,
): number | undefined {
  const raw = getQueryString(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RestError(400, 'invalid_input', `${name} must be a positive integer`, { [name]: raw });
  }
  return parsed;
}

function getOptionalNonNegativeInt(
  value: string | string[] | undefined,
  name: string,
): number | undefined {
  const raw = getQueryString(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RestError(400, 'invalid_input', `${name} must be a non-negative integer`, { [name]: raw });
  }
  return parsed;
}

function getOptionalBoolean(
  value: string | string[] | undefined,
  name: string,
): boolean | undefined {
  const raw = getQueryString(value);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new RestError(400, 'invalid_input', `${name} must be a boolean`, { [name]: raw });
}

async function resolveRestProject(
  rest: RestApiOptions,
  projectId: string,
): Promise<Project> {
  try {
    return await rest.resolveProject(projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RestError(404, 'project_not_found', message, { projectId });
  }
}

function parseToolJson(result: {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}): Record<string, unknown> {
  const text = result.content?.[0]?.text ?? '{}';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (result.isError) {
      throw restErrorFromToolError(parsed);
    }
    return parsed;
  } catch (err) {
    if (err instanceof RestError) {
      throw err;
    }
    if (result.isError) {
      throw new RestError(500, 'handler_error', text);
    }
    throw new RestError(500, 'invalid_handler_response', 'REST handler could not parse tool response');
  }
}

function restErrorFromToolError(payload: Record<string, unknown>): RestError {
  const message = typeof payload.error === 'string'
    ? payload.error
    : 'Request failed';
  const lower = message.toLowerCase();
  let status = 500;
  let code = 'handler_error';

  if (lower.includes('path traversal')) {
    status = 400;
    code = 'unsafe_path';
  } else if (lower.includes('not in the list of atlas-owned managed documents')) {
    status = 403;
    code = 'untracked_path';
  } else if (lower.includes('not found') || lower.includes('missing')) {
    status = 404;
    code = 'not_found';
  } else if (lower.includes('invalid') || lower.includes('required')) {
    status = 400;
    code = 'invalid_input';
  }

  return new RestError(status, code, message, payload);
}

async function ensureRestReadablePath(project: Project, branch: string, filePath: string): Promise<void> {
  if (isPathTraversal(filePath)) {
    throw new RestError(
      400,
      'unsafe_path',
      `Path traversal detected: "${filePath}" is outside the project scope`,
      { path: filePath },
    );
  }

  if (!(await project.isPathOwned(branch, filePath))) {
    throw new RestError(
      403,
      'untracked_path',
      `Path "${filePath}" is not in the list of Atlas-owned managed documents`,
      { path: filePath },
    );
  }
}

function sendRestError(res: express.Response, err: unknown): void {
  if (err instanceof RestError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? {},
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: 'Invalid request',
        details: { issues: err.issues },
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message,
      details: {},
    },
  });
}

function restReadArgs(
  projectId: string,
  path: string,
  query: express.Request['query'],
): Record<string, unknown> {
  return {
    projectId,
    path,
    branch: getQueryString(query.branch as string | string[] | undefined),
    maxChars: getOptionalPositiveInt(query.maxChars as string | string[] | undefined, 'maxChars'),
    offset: getOptionalNonNegativeInt(query.offset as string | string[] | undefined, 'offset'),
  };
}

function registerReadOnlyRestRoutes(
  app: express.Express,
  rest: RestApiOptions,
): void {
  app.get('/projects', async (_req, res) => {
    try {
      const projects = await rest.listProjects();
      res.json({ projects });
    } catch (err) {
      sendRestError(res, err);
    }
  });

  app.get('/projects/:projectId/status', async (req, res) => {
    try {
      const project = await resolveRestProject(rest, req.params.projectId);
      const data = parseToolJson(await handleStatus(project, {
        projectId: req.params.projectId,
        branch: getQueryString(req.query.branch as string | string[] | undefined),
        maxChars: getOptionalPositiveInt(req.query.maxChars as string | string[] | undefined, 'maxChars'),
      }));
      res.json(data);
    } catch (err) {
      sendRestError(res, err);
    }
  });

  app.get('/projects/:projectId/manifest', async (req, res) => {
    try {
      const project = await resolveRestProject(rest, req.params.projectId);
      const data = parseToolJson(await handleManifest(project, {
        projectId: req.params.projectId,
        branch: getQueryString(req.query.branch as string | string[] | undefined),
        maxDocuments: getOptionalPositiveInt(req.query.maxDocuments as string | string[] | undefined, 'maxDocuments'),
        includeRaw: getOptionalBoolean(req.query.includeRaw as string | string[] | undefined, 'includeRaw'),
        validatePaths: getOptionalBoolean(req.query.validatePaths as string | string[] | undefined, 'validatePaths'),
      }));
      res.json(data);
    } catch (err) {
      sendRestError(res, err);
    }
  });

  app.get(/^\/projects\/([^/]+)\/docs\/(.+)$/, async (req, res) => {
    try {
      const projectId = decodeURIComponent(req.params[0]);
      const docPath = decodeURIComponent(req.params[1]);
      const project = await resolveRestProject(rest, projectId);
      await ensureRestReadablePath(project, getQueryString(req.query.branch as string | string[] | undefined) ?? 'main', docPath);
      const data = parseToolJson(await handleRead(project, restReadArgs(projectId, docPath, req.query)));
      res.json(data);
    } catch (err) {
      sendRestError(res, err);
    }
  });

  app.get('/projects/:projectId/sections', async (req, res) => {
    try {
      const project = await resolveRestProject(rest, req.params.projectId);
      const sectionPath = getQueryString(req.query.path as string | string[] | undefined);
      if (sectionPath) {
        await ensureRestReadablePath(project, getQueryString(req.query.branch as string | string[] | undefined) ?? 'main', sectionPath);
      }
      const data = parseToolJson(await handleReadSection(project, {
        projectId: req.params.projectId,
        path: sectionPath,
        branch: getQueryString(req.query.branch as string | string[] | undefined),
        revision: getQueryString(req.query.revision as string | string[] | undefined),
        heading: getQueryString(req.query.heading as string | string[] | undefined),
        level: getOptionalPositiveInt(req.query.level as string | string[] | undefined, 'level'),
        occurrence: getOptionalPositiveInt(req.query.occurrence as string | string[] | undefined, 'occurrence'),
        includeHeading: getOptionalBoolean(req.query.includeHeading as string | string[] | undefined, 'includeHeading'),
        maxChars: getOptionalPositiveInt(req.query.maxChars as string | string[] | undefined, 'maxChars'),
        offset: getOptionalNonNegativeInt(req.query.offset as string | string[] | undefined, 'offset'),
      }));
      res.json(data);
    } catch (err) {
      sendRestError(res, err);
    }
  });

  app.post('/projects/:projectId/context-pack', async (req, res) => {
    try {
      const project = await resolveRestProject(rest, req.params.projectId);
      const body = typeof req.body === 'object' && req.body !== null
        ? req.body as Record<string, unknown>
        : {};
      const data = parseToolJson(await handleContextPack(project, {
        ...body,
        projectId: req.params.projectId,
      }));
      res.json(data);
    } catch (err) {
      sendRestError(res, err);
    }
  });
}

// ── HTTP Server ────────────────────────────────────────────────────────

/**
 * Start an HTTP server that wraps an MCP Server with Streamable HTTP transport.
 *
 * The server exposes:
 *   - GET  /health   → { "status": "ok" }
 *   - GET  /projects and read-only project context routes when configured
 *   - POST /mcp      → MCP JSON-RPC endpoint
 *   - OPTIONS /mcp or * → CORS preflight
 *
 * Origin validation is applied to all /mcp requests.
 * CORS headers are set on every response.
 */
export async function startHttpServer(
  createMcpServer: () => Server, // Factory function to create MCP server per request
  options: HttpServerOptions,
): Promise<{ server: http.Server }> {
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;

  // Create Express app with SDK helper (includes json body parsing and host validation)
  const app = createMcpExpressApp({ host: options.host });

  // Custom middleware to set CORS headers on all responses
  app.use((req, res, next) => {
    setCorsHeaders(res, req.headers.origin, allowedOrigins);
    next();
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(['/', '/ui'], (_req, res) => {
    res.type('html').send(UI_HTML);
  });

  app.get('/ui/app.js', (_req, res) => {
    res.type('application/javascript').send(UI_JS);
  });

  app.get('/ui/styles.css', (_req, res) => {
    res.type('text/css').send(UI_CSS);
  });

  if (options.rest) {
    registerReadOnlyRestRoutes(app, options.rest);
  }

  // MCP endpoint
  app.post('/mcp', async (req, res) => {
    // Create a new MCP server and transport for each request (stateless)
    let server: Server | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    const correlationId = nextMcpCorrelationId();
    
    try {
      logMcpDebug({
        severity: 'debug',
        eventCode: 'MCP_REQUEST_RECEIVED',
        correlationId,
        request: getMcpRequestSummary(req),
      });
      
      // Validate Origin
      const origin = req.headers.origin as string | undefined;
      if (!isOriginAllowed(origin, allowedOrigins)) {
        logMcpEvent({
          severity: 'warn',
          eventCode: 'MCP_ORIGIN_REJECTED',
          correlationId,
          errorCategory: 'origin_not_allowed',
          request: {
            method: req.method,
            path: req.path,
            originPresent: typeof origin === 'string',
          },
        });
        // Do not set CORS headers for disallowed origin
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Origin not allowed' },
        });
        return;
      }
      
      logMcpDebug({
        severity: 'debug',
        eventCode: 'MCP_ORIGIN_ACCEPTED',
        correlationId,
        request: {
          method: req.method,
          path: req.path,
          originPresent: typeof origin === 'string',
        },
      });

      // Create new MCP server and transport for this request
      server = createMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      
      // Connect the MCP server to the transport
      await server.connect(transport);
      
      // Handle the MCP request
      await transport.handleRequest(req, res, req.body);
      logMcpDebug({
        severity: 'debug',
        eventCode: 'MCP_REQUEST_HANDLED',
        correlationId,
      });
      
      // Close transport and server when response closes
      res.on('close', async () => {
        logMcpDebug({
          severity: 'debug',
          eventCode: 'MCP_RESPONSE_CLOSED',
          correlationId,
        });
        try {
          if (transport) await transport.close();
        } catch (e) {
          // Ignore errors on close
        }
        try {
          if (server) await server.close();
        } catch (e) {
          // Ignore errors on close
        }
      });
    } catch (err) {
      logMcpEvent({
        severity: 'error',
        eventCode: 'MCP_REQUEST_FAILED',
        correlationId,
        errorCategory: categorizeMcpError(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
        });
      } else {
        res.end();
      }
      // Clean up on error
      try {
        if (transport) await transport.close();
      } catch (e) { /* ignore */ }
      try {
        if (server) await server.close();
      } catch (e) { /* ignore */ }
    }
  });

  // Handle OPTIONS for /mcp (CORS preflight)
  app.options('/mcp', (_req, res) => {
    res.sendStatus(204);
  });

  // 404 for everything else
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Create the Node.js HTTP server from the Express app
  const server = http.createServer(app);

  // Start listening
  return new Promise((resolve, reject) => {
    server.listen(options.port, options.host, () => {
      resolve({ server });
    });
    server.on('error', reject);
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────────

export async function closeHttpServer(
  server: http.Server
): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

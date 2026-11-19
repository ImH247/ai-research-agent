// 브라우저 백엔드 래퍼 (SITE_SPEC 5장). 화면 코드는 예전 HTTP API와 같은 이름(api.*, ApiError, download)을 쓴다.
// 모든 오류를 ApiError(code, message, status)로 통일한다. API 키는 백엔드 메서드 인자로만 넘긴다(URL·로그·DOM 금지).
// ?mock=1이면 tests/fakes.js의 가짜 LLM·검색 도구와 메모리 저장소를 쓴다(실제 API 호출 없음).

import { createBackend, BackendError } from './engine/backend.js';
import { IndexedDBStorage, MemoryStorage } from './engine/storage.js';
import { LLM } from './engine/llm.js';
import { TOOL_FUNCS } from './engine/tools.js';
import { MODELS } from './engine/models.js';
import { toast } from './ui.js';

export class ApiError extends Error {
  constructor(code, message, status = 0, data = null) {
    super(message || '요청을 처리하지 못했습니다.');
    this.name = 'ApiError';
    this.code = code || 'unknown';
    this.status = status;
    this.data = data;
  }
}

/** 테스트 모드(?mock=1) 여부 */
export const MOCK = (() => {
  try { return new URLSearchParams(location.search).get('mock') === '1'; } catch { return false; }
})();

const LOCK_NAME = 'ai-research-agent:tab';
/** 탭 넘겨받기에 쓰는 BroadcastChannel 이름 */
export const TAB_CHANNEL = 'ai-research-agent';
const SAMPLE_BASE = new URL('../../data/samples/', import.meta.url);

let backend = null;
let backendPromise = null;
let lockHeld = false;
let releaseLock = null;  // 쥐고 있는 Web Lock을 놓는 함수
let stopped = false;     // 다른 탭에 넘겨줘서 이 탭의 백엔드를 멈췄는지

function loadSample(path) {
  return fetch(new URL(String(path), SAMPLE_BASE), { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`sample ${r.status}`);
    return r.text();
  });
}

/** 한 번에 한 탭만: 페이지가 살아 있는 동안 배타 Web Lock을 쥔다. 잠금을 못 얻으면 false. */
function acquireTabLock() {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks || typeof locks.request !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        // 페이지를 닫거나 다른 탭에 넘겨줄 때까지 쥐고 있는다
        return new Promise((done) => { releaseLock = () => { releaseLock = null; done(); }; });
      }).catch(() => resolve(true));
    } catch {
      resolve(true); // 잠금 기능이 막혀 있으면 보호 없이 계속
    }
  });
}

async function buildBackend() {
  if (MOCK) {
    const fakes = await import('../../tests/fakes.js');
    return createBackend({
      storage: new MemoryStorage(),
      llmFactory: (o) => new fakes.FakeLLM({ delay: 300, webSearch: true, model: o?.model || undefined }),
      tools: fakes.makeFakeTools({ fail: [] }),
      loadSample,
      listModels: async () => MODELS.map((m) => m.id),
    });
  }
  return createBackend({
    storage: new IndexedDBStorage(),
    llmFactory: (o) => new LLM(o),
    tools: TOOL_FUNCS,
    loadSample,
  });
}

/**
 * 백엔드를 만든다(한 번만). 결과: {ok: true} | {ok: false, reason: 'other_tab'}.
 * 다른 탭이 잠금을 쥐고 있으면 백엔드를 만들지 않는다(같은 IndexedDB를 두 탭이 쓰면 서로의 실행을 망가뜨린다).
 */
export function startBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      if (stopped) return { ok: false, reason: 'taken_over' };
      if (!MOCK && !lockHeld) {
        if (!(await acquireTabLock())) {
          backendPromise = null; // 나중에 다시 잠금을 시도할 수 있게 실패는 기억하지 않는다
          return { ok: false, reason: 'other_tab' };
        }
        lockHeld = true;
      }
      const b = await buildBackend();
      await b.ready;
      backend = b;
      return { ok: true };
    })();
    backendPromise.catch(() => { backendPromise = null; });
  }
  return backendPromise;
}

/** 탭 넘겨받기를 쓸 수 있는지(테스트 모드는 잠금을 쓰지 않으므로 제외) */
export function canTakeOver() {
  return !MOCK && typeof BroadcastChannel === 'function'
    && typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
}

/**
 * 다른 탭에 사이트를 넘겨준다: 백엔드를 멈추고 Web Lock을 놓는다. 진행 중인 실행이 있으면 false.
 * 이후 이 탭의 api 호출은 모두 other_tab 오류가 된다.
 */
export async function yieldTab() {
  if (api.hasActiveRuns()) return false;
  stopped = true;
  const b = backend;
  backend = null;
  backendPromise = null;
  if (b && typeof b.dispose === 'function') {
    try { await b.dispose(); } catch { /* 멈추는 중 오류는 무시 */ }
  }
  lockHeld = false;
  if (releaseLock) releaseLock();
  return true;
}

async function getBackend() {
  if (stopped) throw new ApiError('other_tab', '이 사이트를 다른 탭에서 열었습니다.', 409);
  if (backend) return backend;
  const res = await startBackend();
  if (!res.ok || !backend) throw new ApiError('other_tab', '이 사이트가 다른 탭에서 열려 있습니다.', 409);
  return backend;
}

/** BackendError 등 모든 오류 → ApiError */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof BackendError || (err && typeof err.code === 'string' && typeof err.message === 'string')) {
    return new ApiError(err.code, err.message, Number(err.status) || 400);
  }
  if (err && err.name === 'QuotaExceededError') {
    return new ApiError('storage_error', '브라우저 저장 공간이 부족합니다. 오래된 기록을 지워 주세요.', 500);
  }
  if (globalThis.console) console.error('[api] 처리하지 못한 오류:', err?.name || typeof err);
  return new ApiError('internal', '요청을 처리하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.', 500);
}

async function call(name, ...args) {
  const b = await getBackend();
  try {
    return await b[name](...args);
  } catch (err) {
    throw toApiError(err);
  }
}

// ───────────────────────── 파일 저장 · 새 창 ─────────────────────────

function toBlob({ mime, data }) {
  if (data instanceof Blob) return data;
  return new Blob([data ?? ''], { type: mime || 'application/octet-stream' });
}

function asText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data ?? '');
}

/** {filename, mime, data(string|Uint8Array|Blob)}를 파일로 저장하고 파일 이름을 돌려준다 */
export function saveFile(file) {
  const name = String(file?.filename || 'download');
  const url = URL.createObjectURL(toBlob(file || {}));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return name;
}

function htmlName(filename) {
  const base = String(filename || 'report').replace(/\.[A-Za-z0-9]+$/, '');
  return `${base}.html`;
}

function whenLoaded(w, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let ready = false;
      try { ready = w.closed || w.document.readyState === 'complete'; } catch { ready = true; }
      if (ready || Date.now() - t0 > timeout) resolve();
      else setTimeout(tick, 60);
    };
    tick();
  });
}

/** 새 창을 연다. 반드시 클릭 처리 함수 안에서 (await 전에) 불러야 팝업 차단을 피한다. */
function openBlankWindow() {
  let w = null;
  try { w = window.open('', '_blank'); } catch { w = null; }
  if (!w) return null;
  try {
    w.document.title = '불러오는 중…';
    w.document.body.textContent = '불러오는 중…';
    w.document.body.style.font = '14px system-ui, sans-serif';
    w.document.body.style.padding = '24px';
  } catch { /* 무시 */ }
  return w;
}

function writeWindow(w, html) {
  w.document.open();
  w.document.write(html);
  w.document.close();
  try { w.opener = null; } catch { /* 무시 */ }
}

/**
 * HTML 문서를 새 창에 띄운다. source = HTML 문자열 | Promise | () => Promise, 결과가 {filename, data}여도 된다.
 * print=true면 로드가 끝난 뒤 인쇄 창을 연다. 팝업이 막히면 HTML 파일로 저장하고 안내한다.
 * 클릭 처리 함수 안에서 곧바로 불러야 한다(창을 먼저 열고 내용은 나중에 쓴다).
 * 결과: {mode: 'open'|'print'|'saved', filename}
 */
export function openHtml(source, { print = false, filename = 'report.html' } = {}) {
  const w = openBlankWindow();
  return (async () => {
    let value;
    try {
      value = typeof source === 'function' ? await source() : await source;
    } catch (err) {
      try { if (w && !w.closed) w.close(); } catch { /* 무시 */ }
      throw toApiError(err);
    }
    const isFile = value && typeof value === 'object' && !(value instanceof Uint8Array) && 'data' in value;
    const html = asText(isFile ? value.data : value);
    const name = htmlName(isFile && value.filename ? value.filename : filename);
    if (!w || w.closed) {
      saveFile({ filename: name, mime: 'text/html;charset=utf-8', data: html });
      toast(print
        ? `팝업이 막혀 ${name} 파일로 저장했습니다. 파일을 열어 인쇄 → 'PDF로 저장'을 고르세요.`
        : `팝업이 막혀 ${name} 파일로 저장했습니다. 내려받은 파일을 열어 보세요.`, 'info', { duration: 10000 });
      return { mode: 'saved', filename: name };
    }
    writeWindow(w, html);
    if (print) {
      await whenLoaded(w);
      setTimeout(() => {
        try { if (!w.closed) { w.focus(); w.print(); } } catch { /* 무시 */ }
      }, 150);
      return { mode: 'print', filename: name };
    }
    return { mode: 'open', filename: name };
  })();
}

/** 결과물을 새 창에 연다(결과 화면의 "인쇄용으로 열기"). 클릭 처리 함수 안에서 곧바로 부른다. */
export function openExport(id, fmt = 'html', { print = false } = {}) {
  return openHtml(() => call('exportFile', id, fmt), { print });
}

/**
 * 결과물을 만들어 저장한다. PDF(print: true)는 새 창에서 인쇄 창을 연다.
 * 결과: {filename, mode: 'saved'|'print'|'open'}. 클릭 처리 함수 안에서 곧바로 불러야 PDF 창이 막히지 않는다.
 */
export function save(id, fmt) {
  if (fmt === 'pdf') {
    return openHtml(() => call('exportFile', id, fmt), { print: true, filename: 'report.html' });
  }
  return (async () => {
    const file = await call('exportFile', id, fmt);
    if (file && file.print) {
      return openHtml(file, { print: true, filename: file.filename });
    }
    return { filename: saveFile(file), mode: 'saved' };
  })();
}

/** 예전 이름 그대로: 파일을 만들어 저장하고 파일 이름(문자열)을 돌려준다 */
export async function download(id, fmt) {
  const res = await save(id, fmt);
  if (res.mode === 'print') return `${res.filename.replace(/\.html$/, '.pdf')} (인쇄 창에서 'PDF로 저장')`;
  return res.filename;
}

/** 조사 파일(.json)을 저장하고 파일 이름을 돌려준다 */
export async function saveRunFile(id) {
  const file = await call('exportRunFile', id);
  return saveFile(file);
}

/** @deprecated 서버가 없어 URL이 없다. openExport()를 쓴다. 남은 호출이 깨지지 않게 빈 창 주소를 돌려준다. */
export function exportUrl() {
  return 'about:blank';
}

// ───────────────────────── API ─────────────────────────

export const api = {
  config: () => call('config'),
  checkKey: (apiKey) => call('checkKey', apiKey || ''),
  listRuns: () => call('listRuns'),
  createRun: (body) => call('createRun', body),
  run: (id) => call('run', id),
  events: (id, after = 0, previewFrom = 0) => call('events', id, Math.max(0, after | 0), Math.max(0, previewFrom | 0)),
  submitPlan: (id, decision) => call('submitPlan', id, decision),
  cancel: (id) => call('cancel', id),
  remove: (id) => call('remove', id),
  result: (id) => call('result', id),
  qa: (id) => call('qa', id),
  ask: (id, body) => call('ask', id, body),
  slides: (id, body = {}) => call('slides', id, body),
  exportFile: (id, fmt) => call('exportFile', id, fmt),
  // 새 기능
  resume: (id, body = {}) => call('resume', id, body),
  finishEarly: (id) => call('finishEarly', id),
  rename: (id, title) => call('rename', id, title),
  exportRunFile: (id) => call('exportRunFile', id),
  importRunFile: (textOrBytes) => call('importRunFile', textOrBytes),
  rewriteReport: (id, body = {}) => call('rewriteReport', id, body),
  refinePrompt: (body = {}) => call('refinePrompt', body),
  /** 진행 중 실행이 있는지 (동기, beforeunload용) */
  hasActiveRuns: () => {
    try { return !!(backend && backend.hasActiveRuns()); } catch { return false; }
  },
  // 파일 도우미
  download,
  save,
  saveFile,
  saveRunFile,
  openHtml,
  openExport,
  exportUrl,
  mock: MOCK,
};

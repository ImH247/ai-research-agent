// 시작점: 백엔드 시작(한 탭 잠금), 설정 로드, 테마, API 키 상태, 셸(왼쪽 사이드바·좁은 화면 위쪽 바와 서랍·설정 창·안내 띠),
// 해시 라우터, 조사 파일 열기(끌어다 놓기 포함), 떠나기 경고. 사이드바의 조사 기록 목록은 history.js가 그린다.

import {
  api, ApiError, MOCK, startBackend, canTakeOver, yieldTab, TAB_CHANNEL,
} from './api.js';
import {
  store, getApiKey, setApiKey, clearApiKey, isKeyRemembered, keyTail, saveTheme, demoSpeedPref,
  sidebarOpenPref, saveSidebarOpen, saveSkin,
} from './store.js';
import {
  h, icon, button, setBusy, toast, modal, emptyState, clear, str, arr, obj, ACTIVE_STATUSES, uid,
} from './ui.js';
import { mountCompose } from './views/compose.js';
import { mountRun } from './views/run.js';
import { openHelp, startDemo } from './onboarding.js';
import { mountHistory } from './history.js';

const APP_NAME = 'AI Research Agent';
const RUN_TABS = new Set(['report', 'evidence', 'verify', 'process', 'qa']);
const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';
const MAX_RUN_FILE = 20 * 1024 * 1024;
const NARROW_QUERY = '(max-width: 899px)'; // app.css 21번의 좁은 화면(위쪽 바 + 서랍) 기준과 같다
const SIDE_OPEN_MIN_WIDTH = 1280;          // 저장값이 없을 때 이 폭 이상이면 사이드바를 펼친 채 시작한다

let shell = null;        // 셸 요소 참조
let current = null;      // {key, unmount}
let runsTimer = 0;
let runsLoading = false;

// ───────────────────────── 라우팅 ─────────────────────────

/** 해시 이동. 같은 해시면 다시 그린다. */
export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) route(true);
  else location.hash = target;
}

function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts[0] === 'run' && parts[1] && /^[A-Za-z0-9_-]{1,80}$/.test(parts[1])) {
    const tab = RUN_TABS.has(parts[2]) ? parts[2] : null;
    return { name: 'run', runId: parts[1], tab, key: `run:${parts[1]}` };
  }
  return { name: 'compose', key: 'compose' };
}

function route(force = false) {
  if (!shell) return;
  const r = parseHash();
  const view = r.name === 'run' ? 'run' : 'home';
  if (document.body.dataset.view !== view) document.body.dataset.view = view;

  // 같은 실행의 탭만 바뀌면 뷰에게 맡긴다
  if (!force && current && current.key === r.key && typeof current.unmount?.update === 'function') {
    if (current.unmount.update({ runId: r.runId, tab: r.tab }) !== false) return;
  }
  const prev = current;
  if (current && typeof current.unmount === 'function') {
    try { current.unmount(); } catch (err) { console.error(err); }
  }
  current = null;
  const main = shell.main;
  clear(main);
  main.classList.remove('is-entering');
  void main.offsetWidth;
  main.classList.add('is-entering');
  const container = h('div', { class: 'view' });
  // 진행·결과 화면: 맨 위에 "← 처음 화면" 링크를 둔다(사이드바를 접었거나 좁은 화면일 때도 바로 돌아갈 수 있게).
  // run.js는 받은 상자의 내용을 통째로 바꾸므로(replaceChildren) 링크와 화면 내용을 따로 담는다.
  let target = container;
  if (r.name === 'run') {
    target = h('div', { class: 'view-body' });
    container.append(
      h('div', { class: 'back-row' },
        h('a', { class: 'back-link', href: '#/' }, icon('arrow-left', 14), h('span', null, '처음 화면'))),
      target);
  }
  main.append(container);
  document.title = APP_NAME;
  let unmount = null;
  try {
    unmount = r.name === 'run' ? mountRun(target, { runId: r.runId, tab: r.tab }) : mountCompose(target, {});
  } catch (err) {
    console.error(err);
    target.append(emptyState({ icon: 'alert-triangle', title: '화면을 그리지 못했습니다', text: str(err?.message) }));
  }
  const hadView = !!prev;
  current = { key: r.key, unmount };
  window.scrollTo(0, 0);
  // 이전 화면과 함께 초점 요소가 사라졌으면 body에 떨어진 초점을 본문 영역으로 옮긴다
  const active = document.activeElement;
  if (hadView && (!active || active === document.body || !active.isConnected)) {
    try { main.focus({ preventScroll: true }); } catch { /* 초점 이동 실패는 무시 */ }
  }
}

// ───────────────────────── 테마 ─────────────────────────

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

function setTheme(theme) {
  const t = saveTheme(theme);
  applyTheme(t);
  store.set({ theme: t });
}

const THEME_OPTS = [
  ['light', 'sun', '라이트'],
  ['dark', 'moon', '다크'],
  ['system', 'monitor', '시스템 설정'],
];

/**
 * 3칸 테마 세그먼트(설정 창·펼친 사이드바가 같은 상태를 쓴다). compact면 아이콘만(사이드바).
 * 구독 해제 함수를 함께 돌려준다.
 */
function themeControl({ compact = false } = {}) {
  const wrap = h('div', { class: ['seg', 'theme-seg', compact ? 'seg-icons' : ''], role: 'group', 'aria-label': '테마' });
  const render = () => {
    const theme = store.get().theme;
    wrap.replaceChildren(...THEME_OPTS.map(([id, ic, label]) => h('button', {
      type: 'button', class: 'seg-btn', title: label, 'aria-label': `테마: ${label}`,
      'aria-pressed': theme === id ? 'true' : 'false',
      onClick: () => setTheme(id),
    }, icon(ic, compact ? 15 : 16), compact ? null : h('span', { 'aria-hidden': 'true' }, label))));
  };
  render();
  const unsub = store.subscribe((s, p) => { if (s.theme !== p.theme) render(); });
  return [wrap, unsub];
}

// ───────────────────────── 디자인(스킨) ─────────────────────────
// DESIGN_LAVENDER 3절. boot.js가 첫 화면 전에 <html data-skin>과 파비콘을 정하고, 설정 창에서 바꾸면 여기서 바로 적용한다.

function applySkin(skin) {
  const s = skin === 'classic' ? 'classic' : 'lavender';
  document.documentElement.dataset.skin = s;
  const link = document.querySelector('link[rel="icon"]');
  const href = link?.getAttribute(`data-href-${s}`); // boot.js가 남겨 둔 두 주소(없으면 그대로 둔다)
  if (link && href && link.getAttribute('href') !== href) link.setAttribute('href', href);
}

function setSkin(skin) {
  const s = saveSkin(skin);
  applySkin(s);
}

const SKIN_OPTS = [
  ['lavender', '라벤더'],
  ['classic', '클래식'],
];

/** 2칸 디자인 세그먼트(설정 창). 구독 해제 함수를 함께 돌려준다. */
function skinControl() {
  const wrap = h('div', { class: 'seg theme-seg skin-seg', role: 'group', 'aria-label': '디자인' });
  const render = () => {
    const skin = store.get().skin;
    wrap.replaceChildren(...SKIN_OPTS.map(([id, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-label': `디자인: ${label}`,
      'aria-pressed': skin === id ? 'true' : 'false',
      onClick: () => setSkin(id),
    }, h('span', { 'aria-hidden': 'true' }, label))));
  };
  render();
  const unsub = store.subscribe((s, p) => { if (s.skin !== p.skin) render(); });
  return [wrap, unsub];
}

/** 접은 사이드바의 테마 버튼: 누를 때마다 라이트 → 다크 → 시스템 순환. 구독 해제 함수를 함께 돌려준다. */
function themeCycleButton() {
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon side-btn side-theme-cycle' });
  const idx = () => Math.max(0, THEME_OPTS.findIndex(([id]) => id === store.get().theme));
  const render = () => {
    const [, ic, label] = THEME_OPTS[idx()];
    const [, , nextLabel] = THEME_OPTS[(idx() + 1) % THEME_OPTS.length];
    const text = `테마: ${label}(누르면 ${nextLabel})`;
    btn.setAttribute('aria-label', text);
    btn.title = text;
    btn.replaceChildren(icon(ic, 18));
  };
  btn.addEventListener('click', () => setTheme(THEME_OPTS[(idx() + 1) % THEME_OPTS.length][0]));
  render();
  const unsub = store.subscribe((s, p) => { if (s.theme !== p.theme) render(); });
  return [btn, unsub];
}

// ───────────────────────── API 키 ─────────────────────────

async function checkKeyNow(key) {
  const k = key ?? getApiKey();
  if (!k) {
    store.set({ keyStatus: { state: 'none', message: '', models: null } });
    return store.get().keyStatus;
  }
  store.set({ keyStatus: { ...store.get().keyStatus, state: 'unchecked', checking: true } });
  try {
    const res = await api.checkKey(k);
    if (res && res.ok) {
      store.set({ keyStatus: { state: 'ok', message: '', models: arr(res.models) } });
    } else {
      const e = obj(res?.error);
      store.set({ keyStatus: { state: 'error', message: str(e.message, '키를 확인하지 못했습니다.'), code: str(e.code), models: null } });
    }
  } catch (err) {
    store.set({ keyStatus: { state: 'unchecked', message: str(err?.message, '키를 확인하지 못했습니다.'), models: null } });
  }
  return store.get().keyStatus;
}

function keyStatusText(ks) {
  const tail = keyTail();
  switch (ks.state) {
    case 'ok':
      return { label: `API 키 ··${tail}`, sub: `확인됨 · 모델 ${arr(ks.models).length}개 사용 가능`, tone: 'good' };
    case 'error':
      return { label: tail ? `API 키 ··${tail}` : 'API 키', sub: ks.message || '키 오류', tone: 'critical' };
    case 'unchecked':
      return { label: `API 키 ··${tail}`, sub: ks.checking ? '확인하는 중…' : '아직 확인하지 않음', tone: 'warning' };
    default:
      return { label: 'API 키 입력', sub: '조사를 시작하려면 필요합니다', tone: 'neutral' };
  }
}

/**
 * API 키 창을 연다 (결과 화면의 질문하기에서도 쓴다).
 * opts.offerDemo: 키 없이 "조사 시작"을 눌렀을 때 — 창 안에 "키 없이 데모로 보기" 버튼을 둔다.
 */
export function openKeyDialog(opts = {}) {
  const { offerDemo = false } = obj(opts);
  const inputId = uid('key');
  const hintId = uid('key-hint');
  const input = h('input', {
    id: inputId, class: 'input input-mono', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: MOCK ? '테스트 모드: 아무 글자나 입력' : 'sk-ant-…', 'aria-describedby': hintId, value: getApiKey(),
  });
  const reveal = h('button', {
    type: 'button', class: 'input-addon btn btn-ghost btn-icon btn-sm', 'aria-label': '키 보기', 'aria-pressed': 'false',
    onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
      reveal.setAttribute('aria-label', show ? '키 숨기기' : '키 보기');
      reveal.replaceChildren(icon(show ? 'eye-off' : 'eye', 16));
      input.focus();
    },
  }, icon('eye', 16));
  const remember = h('input', { type: 'checkbox', class: 'checkbox', checked: isKeyRemembered() });
  const status = h('div', { class: 'key-status', 'aria-live': 'polite' });

  const renderStatus = () => {
    const t = keyStatusText(store.get().keyStatus);
    status.replaceChildren(
      h('span', { class: ['status-dot', `tone-${t.tone}`] }),
      h('span', { class: 'key-status-text' }, h('b', null, t.label), ' · ', t.sub));
  };
  renderStatus();
  const unsub = store.subscribe((s, p) => { if (s.keyStatus !== p.keyStatus) renderStatus(); });

  let dlg = null;
  const demoBtn = offerDemo ? button('키 없이 데모로 보기', { kind: 'secondary', size: 'sm', icon: 'play' }) : null;
  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      dlg?.close();
      startDemo(demoSpeedPref());
    });
  }

  const keyTitleId = uid('set-key');
  const themeTitleId = uid('set-theme');
  const [themeSeg, unsubTheme] = themeControl();
  const skinTitleId = uid('set-skin');
  const skinHintId = uid('set-skin-hint');
  const [skinSeg, unsubSkin] = skinControl();
  skinSeg.setAttribute('aria-describedby', skinHintId);
  const keySection = h('section', { class: 'settings-sec key-form', 'aria-labelledby': keyTitleId },
    h('h3', { class: 'settings-sec-title', id: keyTitleId }, 'API 키'),
    h('div', { class: 'note note-info' }, icon('shield-check', 16),
      h('span', null, 'API 키는 이 브라우저에만 저장되고 Anthropic API(api.anthropic.com)로만 전송됩니다. 이 사이트에는 서버가 없습니다. ',
        h('a', { href: KEY_CONSOLE_URL, target: '_blank', rel: 'noopener noreferrer', class: 'key-console-link' },
          '키 발급 페이지', icon('external-link', 12)))),
    h('label', { class: 'field-label', htmlFor: inputId }, 'Anthropic API 키'),
    h('div', { class: 'input-group' }, input, reveal),
    h('p', { class: 'field-hint', id: hintId }, MOCK
      ? '테스트 모드에서는 키를 실제로 쓰지 않습니다. 화면에는 끝 4자리만 표시됩니다.'
      : '화면에는 끝 4자리만 표시됩니다. 사용 요금은 이 키의 계정으로 청구됩니다.'),
    h('label', { class: 'check-row' }, remember,
      h('span', null, h('span', { class: 'check-title' }, '이 브라우저에 저장'),
        h('span', { class: 'check-desc' }, '끄면 이 탭을 닫을 때 키가 지워집니다.'))),
    status,
    demoBtn ? h('div', { class: 'key-demo' },
      h('div', { class: 'key-demo-text' },
        h('b', null, '키가 없어도 둘러볼 수 있습니다'),
        h('span', null, '기록된 샘플 조사를 재생합니다(지금 적은 주제가 아니라 샘플 주제입니다). 적어 둔 글은 그대로 남습니다.')),
      demoBtn) : null);
  const themeSection = h('section', { class: 'settings-sec', 'aria-labelledby': themeTitleId },
    h('h3', { class: 'settings-sec-title', id: themeTitleId }, '화면 테마'),
    themeSeg);
  const skinSection = h('section', { class: 'settings-sec', 'aria-labelledby': skinTitleId },
    h('h3', { class: 'settings-sec-title', id: skinTitleId }, '디자인'),
    skinSeg,
    h('p', { class: 'field-hint', id: skinHintId }, '클래식은 이전 디자인입니다.'));
  const body = h('div', { class: 'settings-form' }, keySection, themeSection, skinSection);

  dlg = modal({
    title: '설정',
    body,
    onClose: () => { unsub(); unsubTheme(); unsubSkin(); },
    actions: [
      {
        label: '지우기', kind: 'ghost', icon: 'trash',
        onClick: () => {
          clearApiKey();
          input.value = '';
          remember.checked = false;
          toast('API 키를 지웠습니다.', 'info');
          input.focus();
        },
      },
      { label: '닫기', kind: 'secondary', onClick: ({ close }) => close() },
      {
        label: '확인', kind: 'primary', icon: 'check',
        onClick: async ({ close, button: btn }) => {
          const k = input.value.trim();
          if (!k) {
            store.set({ keyStatus: { state: 'none', message: '키를 입력해 주세요.', models: null } });
            status.replaceChildren(h('span', { class: 'status-dot tone-critical' }), h('span', { class: 'key-status-text' }, '키를 입력해 주세요.'));
            input.focus();
            return;
          }
          setApiKey(k, remember.checked);
          setBusy(btn, true, '확인하는 중…');
          const ks = await checkKeyNow(k);
          setBusy(btn, false);
          if (ks.state === 'ok') {
            toast(`키를 확인했습니다. 모델 ${arr(ks.models).length}개를 쓸 수 있습니다.`, 'success');
            close();
          } else {
            input.focus();
          }
        },
      },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dlg.el.querySelector('.modal-foot .btn-primary')?.click();
    }
  });
  return dlg;
}

/**
 * 사이드바의 설정 버튼(button.side-key): 톱니 아이콘 + 키 상태 점, "설정 · API 키 ··1234"와 상태 문구.
 * 접은 상태에서는 글자를 화면에서만 숨기므로(.side-label) 이름은 그대로 읽힌다. 누르면 설정 창(API 키).
 * 구독 해제 함수를 함께 돌려준다.
 */
function sideKeyButton() {
  const btn = h('button', { type: 'button', class: 'side-key', 'aria-haspopup': 'dialog', onClick: () => openKeyDialog() });
  const render = () => {
    const ks = store.get().keyStatus;
    const t = keyStatusText(ks);
    // 키가 없으면 점이 눈에 띄게(주의 색) 보인다
    const tone = ks.state === 'none' ? 'warning' : t.tone;
    btn.replaceChildren(
      h('span', { class: 'side-key-icon', 'aria-hidden': 'true' },
        icon('settings', 18), h('span', { class: ['status-dot', `tone-${tone}`] })),
      h('span', { class: 'side-key-text side-label' },
        h('span', { class: 'side-key-label' }, `설정 · ${t.label}`),
        h('span', { class: 'side-key-sub' }, t.sub)));
    btn.title = `설정 (API 키: ${t.sub})`;
  };
  render();
  const unsub = store.subscribe((s, p) => { if (s.keyStatus !== p.keyStatus || s.config !== p.config) render(); });
  return [btn, unsub];
}

// ───────────────────────── 기록 목록 (그리기는 history.js, 사이드바 안) ─────────────────────────

/** 기록 목록을 다시 불러온다 */
export async function refreshRuns() {
  if (runsLoading) return;
  runsLoading = true;
  try {
    const res = await api.listRuns();
    store.set({ runs: arr(res?.runs) });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'other_tab') console.warn('[기록] 목록을 불러오지 못했습니다:', str(err?.code));
    if (store.get().runs === null) store.set({ runs: [] });
  } finally {
    runsLoading = false;
    scheduleRunsRefresh();
  }
}

function scheduleRunsRefresh() {
  clearTimeout(runsTimer);
  const runs = arr(store.get().runs);
  const active = runs.some((r) => ACTIVE_STATUSES.has(r?.status));
  if (active) runsTimer = setTimeout(refreshRuns, document.hidden ? 15000 : 5000);
}

// ───────────────────────── 조사 파일 열기 ─────────────────────────

let importBusy = false;

function isJsonFile(f) {
  return !!f && (/\.json$/i.test(f.name || '') || /json/i.test(f.type || ''));
}

async function importFile(file) {
  if (!file) return;
  if (importBusy) { toast('다른 파일을 여는 중입니다.', 'info'); return; }
  if (!isJsonFile(file)) { toast('조사 파일(.json)만 열 수 있습니다.', 'error'); return; }
  if (file.size > MAX_RUN_FILE) { toast('파일이 너무 큽니다. 20MB까지 열 수 있습니다.', 'error'); return; }
  importBusy = true;
  const pending = toast('조사 파일을 여는 중…', 'info', { duration: 20000 });
  try {
    const text = await file.text();
    const res = await api.importRunFile(text);
    const id = str(res?.id);
    pending.close();
    toast('조사 파일을 열었습니다.', 'success');
    await refreshRuns();
    if (id) navigate(`#/run/${encodeURIComponent(id)}`);
  } catch (err) {
    pending.close();
    const msg = str(err?.message);
    toast(err?.code === 'invalid_file' || !msg
      ? `조사 파일을 열지 못했습니다. ${msg || '이 사이트에서 저장한 조사 파일이 아닙니다.'}`
      : msg, 'error', { duration: 7000 });
  } finally {
    importBusy = false;
  }
}

let fileInput = null; // 숨은 파일 선택 칸(하나만 만들어 둔다)

/** "조사 파일 열기": 파일 선택 창을 연다(사이드바 아래쪽 버튼이 부른다). 고른 파일은 importFile로 가져온다. */
export function pickRunFile() {
  if (!fileInput || !fileInput.isConnected) {
    fileInput = h('input', {
      type: 'file', accept: '.json,application/json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true',
      onChange: () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        importFile(f);
      },
    });
    document.body.append(fileInput);
  }
  fileInput.click();
}

function dragHasFiles(e) {
  const types = e.dataTransfer?.types;
  return !!types && [...types].includes('Files');
}

/** 창 어디에든 .json 파일을 끌어다 놓으면 가져온다(끄는 동안 화면 전체 안내) */
function wireDropImport() {
  const overlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, icon('upload', 20),
      h('div', { class: 'drop-title' }, '놓으면 조사 파일을 엽니다'),
      h('div', { class: 'drop-text' }, '이 사이트에서 저장한 .json 파일')));
  overlay.hidden = true;
  document.body.append(overlay);
  let depth = 0;
  const hide = () => { depth = 0; overlay.hidden = true; };
  window.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    // 창 밖으로 나가면 relatedTarget이 없다
    if (!depth || !e.relatedTarget) hide();
  });
  window.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    hide();
    const files = [...(e.dataTransfer?.files || [])];
    importFile(files.find(isJsonFile) || files[0]);
  });
  window.addEventListener('blur', hide);
}

// ───────────────────────── 셸 ─────────────────────────

function renderBanners() {
  if (!shell) return;
  const { config } = store.get();
  const storage = obj(config?.storage);
  const items = [];
  if (MOCK) {
    items.push(h('div', { class: 'banner banner-mock', role: 'status' }, icon('info', 14),
      h('span', null, h('b', null, '테스트 모드 — 실제 API를 호출하지 않습니다'),
        h('span', { class: 'banner-sub' }, ' · 키 칸에는 아무 글자나 넣으면 되고, 새로고침하면 기록이 사라집니다.'))));
  } else if (config && storage.persistent === false) {
    items.push(h('div', { class: 'banner banner-warn', role: 'status' }, icon('alert-triangle', 14),
      h('span', null, str(storage.warning, '이 브라우저에서는 기록을 저장할 수 없습니다. 탭을 닫으면 조사 기록이 사라집니다.'))));
  }
  shell.banners.replaceChildren(...items);
}

// ── 왼쪽 사이드바 aside.side (LAYOUT_V3 1절) ──
// 넓은 화면: div.app.is-side-open이면 펼침(--side-w), 아니면 아이콘 줄(--rail-w). prefs.sidebarOpen에 저장한다.
// 좁은 화면(≤899px): 위쪽 바(header.topbar)의 메뉴 버튼으로 여는 서랍(body.drawer-open). 서랍은 늘 펼친 모양이고 저장하지 않는다.

function isNarrow() {
  return !!shell?.mq?.matches;
}

/** 접은 상태에서 보이지 않는 것(기록 목록·검색·조사 파일 열기·테마 세그먼트)은 초점도 받지 않게 한다 */
function syncSideInert() {
  if (!shell) return;
  const collapsed = !isNarrow() && !shell.sideOpen;
  for (const el of shell.collapsibles) el.inert = collapsed;
}

/** 넓은 화면의 펼침/접힘. save=true면 사용자가 고른 값으로 저장한다. */
function setSideOpen(open, save = false) {
  if (!shell) return;
  shell.sideOpen = !!open;
  shell.app.classList.toggle('is-side-open', shell.sideOpen);
  const t = shell.sideToggle;
  const label = shell.sideOpen ? '사이드바 접기' : '사이드바 펼치기 (조사 기록)';
  t.setAttribute('aria-expanded', shell.sideOpen ? 'true' : 'false');
  t.setAttribute('aria-label', label);
  t.title = label;
  t.replaceChildren(icon(shell.sideOpen ? 'panel-left-close' : 'panel-left-open', 18));
  if (save) saveSidebarOpen(shell.sideOpen);
  syncSideInert();
}

function openDrawer() {
  if (!shell || !isNarrow()) return;
  document.body.classList.add('drawer-open');
  shell.menuBtn.setAttribute('aria-expanded', 'true');
  shell.appMain.inert = true; // 서랍이 열려 있는 동안 뒤쪽(위쪽 바·띠·본문)은 초점과 보조 기술에서 빠진다
  syncSideInert();
  try { shell.sideNew.focus({ preventScroll: true }); } catch { /* 무시 */ }
}

/** 서랍을 닫는다(Esc · 가림막 · 닫기 버튼 · 화면 이동). focus면 초점을 메뉴 버튼으로 돌려준다. */
function closeDrawer({ focus = true } = {}) {
  if (!shell || !document.body.classList.contains('drawer-open')) return;
  document.body.classList.remove('drawer-open');
  shell.menuBtn.setAttribute('aria-expanded', 'false');
  shell.appMain.inert = false;
  if (focus && isNarrow()) {
    try { shell.menuBtn.focus({ preventScroll: true }); } catch { /* 무시 */ }
  }
}

function wordmark() {
  return h('a', { class: 'wordmark', href: '#/', 'aria-label': `${APP_NAME} 처음 화면`, title: APP_NAME },
    h('span', { class: 'logo' }, icon('logo', 16)),
    h('span', { class: 'wordmark-text', 'aria-hidden': 'true' }, APP_NAME));
}

/** "새 조사": 이미 처음 화면이면 화면을 다시 그린다(해시가 그대로라 hashchange가 오지 않는다) */
function onNewClick() {
  if (location.hash === '#/' || !location.hash) navigate('#/');
}

/**
 * 펼친 상태: 머리(워드마크 · 접기) · 새 조사 · 기록 · 아래쪽(조사 파일 열기 · 도움말 · 설정 · 테마).
 * 접은 상태: 로고 · 펼치기 · 새 조사 · (빈 공간) · 도움말 · 설정 · 테마 순환 — 같은 요소에서 글자만 숨긴다(app.css).
 */
function renderSide(cleanups) {
  const toggle = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm side-btn side-toggle', 'aria-controls': 'side',
    onClick: () => setSideOpen(!shell?.sideOpen, true),
  });
  const closeBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm side-close', 'aria-label': '메뉴 닫기', title: '메뉴 닫기',
    onClick: () => closeDrawer(),
  }, icon('x', 16));
  const newBtn = h('a', { class: 'btn btn-primary side-btn side-new', href: '#/', title: '새 조사', onClick: onNewClick },
    icon('plus', 16), h('span', { class: 'btn-label side-label' }, '새 조사'));

  const history = mountHistory();
  cleanups.push(() => history.destroy());

  const openFile = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm side-tool side-open-file',
    title: '저장해 둔 조사 파일(.json)을 엽니다. 창에 끌어다 놓아도 됩니다.',
    onClick: () => { closeDrawer(); pickRunFile(); },
  }, icon('folder-open', 16), h('span', { class: 'btn-label' }, '조사 파일 열기'));
  const helpBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm side-btn side-tool side-help', title: '처음 사용 안내를 다시 봅니다',
    onClick: () => { closeDrawer(); openHelp(); },
  }, icon('help', 16), h('span', { class: 'btn-label side-label' }, '도움말'));
  const [keyBtn, unsubKey] = sideKeyButton();
  const [themeSeg, unsubTheme] = themeControl({ compact: true });
  const themeRow = h('div', { class: 'side-theme' },
    h('span', { class: 'side-theme-label', 'aria-hidden': 'true' }, '화면 테마'), themeSeg);
  const [themeCycle, unsubCycle] = themeCycleButton();
  cleanups.push(unsubKey, unsubTheme, unsubCycle);

  const side = h('aside', { class: 'side', id: 'side', 'aria-label': '사이드바' },
    h('div', { class: 'side-head' }, wordmark(), toggle, closeBtn),
    newBtn,
    history.el,
    h('div', { class: 'side-foot' },
      h('div', { class: 'side-tools' }, openFile, helpBtn),
      keyBtn,
      themeRow,
      themeCycle));
  // 서랍 안의 링크(새 조사 · 워드마크 · 기록 항목)를 누르면 서랍을 닫는다. 같은 실행을 다시 눌러 해시가 그대로여도 닫힌다.
  side.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a[href]')) closeDrawer();
  });
  return { side, toggle, newBtn, collapsibles: [history.el, openFile, themeRow] };
}

/** 좁은 화면의 위쪽 바: 메뉴 · 로고 · 워드마크 · 새 조사. result.js가 '.topbar' 높이로 고정 탭 줄 위치를 맞춘다. */
function renderTopbar() {
  const menuBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon topbar-menu', 'aria-label': '메뉴 열기', title: '메뉴 (조사 기록)',
    'aria-controls': 'side', 'aria-expanded': 'false', onClick: openDrawer,
  }, icon('menu', 18));
  const topbar = h('header', { class: 'topbar' }, menuBtn, wordmark(),
    h('a', { class: 'btn btn-secondary btn-sm topbar-new', href: '#/', onClick: onNewClick },
      icon('plus', 14), h('span', { class: 'btn-label' }, '새 조사')));
  return { topbar, menuBtn };
}

function renderShell(root) {
  const cleanups = [];
  const banners = h('div', { class: 'banners' });
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const s = renderSide(cleanups);
  const { topbar, menuBtn } = renderTopbar();
  const scrim = h('div', { class: 'side-scrim', 'aria-hidden': 'true', onClick: () => closeDrawer() });
  const appMain = h('div', { class: 'app-main' }, topbar, banners, main);
  const saved = sidebarOpenPref();
  const open = saved ?? window.innerWidth >= SIDE_OPEN_MIN_WIDTH;
  // 처음부터 클래스를 붙여 두어 시작할 때 폭 전환이 보이지 않게 한다
  const app = h('div', { class: ['app', open ? 'is-side-open' : ''] }, s.side, scrim, appMain);

  root.replaceChildren(
    h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); } }, '본문으로 건너뛰기'),
    app);

  let mq = null;
  try { mq = window.matchMedia(NARROW_QUERY); } catch { mq = null; }
  shell = {
    main, banners, app, appMain, menuBtn, mq, cleanups,
    side: s.side, sideToggle: s.toggle, sideNew: s.newBtn, collapsibles: s.collapsibles, sideOpen: open,
  };
  setSideOpen(open);

  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !document.body.classList.contains('drawer-open')) return;
    if (document.querySelector('.modal-root, .popover')) return; // 창·메뉴가 먼저 닫힌다
    closeDrawer();
    e.preventDefault(); // 같은 Esc가 화면 쪽 처리(조사 설정 시트 닫기 등)로 한 번 더 넘어가지 않게 한다
  };
  const onHash = () => closeDrawer();
  const onMq = () => {
    if (!isNarrow()) closeDrawer({ focus: false }); // 넓어지면 서랍 상태를 거둔다
    syncSideInert();
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  try { mq?.addEventListener('change', onMq); } catch { /* 오래된 브라우저: 처음 값만 쓴다 */ }
  cleanups.push(
    () => document.removeEventListener('keydown', onKey),
    () => window.removeEventListener('hashchange', onHash),
    () => { try { mq?.removeEventListener('change', onMq); } catch { /* 무시 */ } },
    store.subscribe((s2, p) => { if (s2.config !== p.config) renderBanners(); }));
  renderBanners();
}

// ───────────────────────── 시작 ─────────────────────────

function renderBootError(root, err) {
  const retry = button('새로고침', { kind: 'primary', icon: 'refresh', onClick: () => location.reload() });
  root.replaceChildren(h('div', { class: 'boot-error' },
    h('div', { class: 'boot-error-card card' },
      h('span', { class: 'logo logo-lg' }, icon('logo', 20)),
      h('h1', { class: 'boot-error-title' }, '사이트를 시작하지 못했습니다'),
      h('p', { class: 'boot-error-text' },
        str(err?.message, '브라우저가 오래되었거나 일부 기능이 막혀 있을 수 있습니다. 새로고침해 보세요.')),
      err?.code ? h('p', { class: 'mono boot-error-code' }, str(err.code)) : null,
      retry)));
}

const TAKEOVER_TIMEOUT = 2000;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 다른 탭이 이미 사이트를 쓰고 있을 때 전체 화면 안내. 가능하면 "이 탭에서 계속하기"로 넘겨받는다. */
function renderTabNotice(root) {
  const takeover = canTakeOver();
  const reload = button('새로고침', { kind: takeover ? 'secondary' : 'primary', icon: 'refresh', onClick: () => location.reload() });
  const msg = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const showMsg = (text) => { msg.replaceChildren(icon('alert-triangle', 14), h('span', null, text)); msg.hidden = false; };
  const takeBtn = takeover ? button('이 탭에서 계속하기', { kind: 'primary', icon: 'play' }) : null;
  if (takeBtn) takeBtn.addEventListener('click', () => requestTakeover(takeBtn, msg, showMsg));
  root.replaceChildren(h('div', { class: 'boot-error' },
    h('div', { class: 'boot-error-card card', role: 'alert' },
      h('span', { class: 'logo logo-lg' }, icon('logo', 20)),
      h('h1', { class: 'boot-error-title' }, '이 사이트가 다른 탭에서 열려 있습니다.'),
      h('p', { class: 'boot-error-text' }, takeover
        ? '이 탭에서 계속하면 다른 탭은 멈춥니다. 또는 그 탭을 사용하세요.'
        : '그 탭을 사용하거나 닫은 뒤 새로고침하세요.'),
      h('p', { class: 'field-hint' }, '두 탭이 같은 기록을 함께 쓰면 진행 중인 조사가 망가질 수 있어 한 번에 한 탭에서만 엽니다.'),
      msg,
      takeBtn,
      reload)));
  requestAnimationFrame(() => (takeBtn || reload).focus());
}

/** 잠금을 쥔 탭에 넘겨 달라고 요청한다(BroadcastChannel). 2초 안에 답이 없으면 잠금을 한 번 더 시도한다. */
let takeoverBusy = false;
async function requestTakeover(btn, msg, showMsg) {
  if (takeoverBusy) return;
  takeoverBusy = true;
  msg.hidden = true;
  setBusy(btn, true, '넘겨받는 중…');
  const id = uid('tab');
  let ch = null;
  try { ch = new BroadcastChannel(TAB_CHANNEL); } catch { ch = null; }
  const reply = await new Promise((resolve) => {
    if (!ch) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), TAKEOVER_TIMEOUT);
    ch.onmessage = (e) => {
      const d = obj(e.data);
      if (d.id && d.id !== id) return; // 다른 탭의 요청에 대한 답
      if (d.type === 'takeover-granted' || d.type === 'takeover-denied') { clearTimeout(timer); resolve(d); }
    };
    try { ch.postMessage({ type: 'takeover-request', id }); } catch { clearTimeout(timer); resolve(null); }
  });
  try { if (ch) ch.close(); } catch { /* 무시 */ }

  if (reply && reply.type === 'takeover-denied') {
    takeoverBusy = false;
    setBusy(btn, false);
    showMsg('다른 탭에서 조사가 진행 중입니다. 그 탭에서 계속하거나 조사가 끝난 뒤 다시 시도하세요.');
    return;
  }
  // 넘겨받았으면 잠금이 풀릴 때까지 잠깐씩 기다리며 다시 시도하고, 답이 없었으면 한 번만 시도한다
  const tries = reply ? 8 : 1;
  for (let i = 0; i < tries; i += 1) {
    let started = null;
    try { started = await startBackend(); } catch { started = null; }
    if (started && started.ok) { takeoverBusy = false; boot(); return; }
    if (i < tries - 1) await wait(250);
  }
  takeoverBusy = false;
  if (!btn.isConnected) return;
  setBusy(btn, false);
  showMsg(reply
    ? '다른 탭이 아직 사이트를 놓지 않았습니다. 잠시 뒤 새로고침하세요.'
    : '다른 탭이 응답하지 않습니다. 그 탭을 닫은 뒤 새로고침하세요.');
}

/** 이 탭이 잠금을 쥐고 있을 때: 새 탭의 넘겨받기 요청에 답한다 */
function listenForTakeover(root) {
  if (!canTakeOver()) return;
  let ch = null;
  try { ch = new BroadcastChannel(TAB_CHANNEL); } catch { return; }
  let yielding = false;
  ch.onmessage = async (e) => {
    const d = obj(e.data);
    if (d.type !== 'takeover-request' || yielding) return;
    const id = str(d.id) || null;
    if (api.hasActiveRuns()) {
      ch.postMessage({ type: 'takeover-denied', reason: 'active', id });
      return;
    }
    yielding = true;
    let ok = false;
    try { ok = await yieldTab(); } catch { ok = false; }
    if (!ok) {
      // 그 사이 조사가 시작되었으면 넘겨주지 않는다
      yielding = false;
      ch.postMessage({ type: 'takeover-denied', reason: 'active', id });
      return;
    }
    stopThisTab();
    renderYieldedNotice(root);
    ch.postMessage({ type: 'takeover-granted', id });
    try { ch.close(); } catch { /* 무시 */ }
  };
}

/** 넘겨준 탭의 화면·주기 작업을 멈춘다 */
function stopThisTab() {
  clearTimeout(runsTimer);
  if (current && typeof current.unmount === 'function') {
    try { current.unmount(); } catch (err) { console.error(err); }
  }
  current = null;
  // 사이드바 기록(구독·타이머·hashchange)·설정 버튼·테마·서랍 이벤트를 정리한다
  for (const fn of shell?.cleanups || []) {
    try { fn(); } catch (err) { console.error(err); }
  }
  shell = null;
  for (const el of document.querySelectorAll('.modal-root, .popover')) el.remove();
  document.body.classList.remove('has-modal', 'drawer-open', 'has-runbar');
  delete document.body.dataset.view;
}

/** 다른 탭이 넘겨받은 뒤 이 탭에 보이는 전체 화면 안내 */
function renderYieldedNotice(root) {
  const reopen = button('이 탭에서 다시 열기', { kind: 'primary', icon: 'refresh', onClick: () => location.reload() });
  document.title = APP_NAME;
  root.replaceChildren(h('div', { class: 'boot-error' },
    h('div', { class: 'boot-error-card card', role: 'status' },
      h('span', { class: 'logo logo-lg' }, icon('logo', 20)),
      h('h1', { class: 'boot-error-title' }, '이 사이트를 다른 탭에서 열었습니다.'),
      h('p', { class: 'boot-error-text' }, '이 탭은 닫아도 됩니다.'),
      reopen)));
}

/** 진행 중인 조사가 있으면 닫기·새로고침 전에 브라우저 기본 확인 창을 띄운다 (F3) */
function onBeforeUnload(e) {
  if (!api.hasActiveRuns()) return undefined;
  e.preventDefault();
  e.returnValue = '';
  return '';
}

let wired = false; // 창 전체 이벤트는 한 번만 단다

async function boot() {
  const root = document.getElementById('app');
  applyTheme(store.get().theme);
  applySkin(store.get().skin);
  let config;
  try {
    const started = await startBackend();
    if (!started.ok) { renderTabNotice(root); return; }
    config = await api.config();
  } catch (err) {
    console.error('[시작] 백엔드를 시작하지 못했습니다:', str(err?.code) || str(err?.name));
    renderBootError(root, err);
    return;
  }
  store.set({ config: obj(config) });
  if (getApiKey()) store.set({ keyStatus: { state: 'unchecked', message: '', models: null } });

  if (!shell) renderShell(root);
  if (!wired) {
    wired = true;
    wireDropImport();
    listenForTakeover(root);
    window.addEventListener('hashchange', () => route());
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', () => {
      if (shell && !document.hidden && arr(store.get().runs).some((r) => ACTIVE_STATUSES.has(r?.status))) refreshRuns();
    });
  }
  route(true);
  refreshRuns();
  if (getApiKey()) checkKeyNow();
}

boot();

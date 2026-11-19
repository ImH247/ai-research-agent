// 시작점: 백엔드 시작(한 탭 잠금), 설정 로드, 테마, API 키 상태, 셸(사이드바·기록·키·테마·안내 띠), 해시 라우터,
// 조사 파일 열기(끌어다 놓기 포함), 떠나기 경고.

import {
  api, ApiError, MOCK, startBackend, saveRunFile, canTakeOver, yieldTab, TAB_CHANNEL,
} from './api.js';
import {
  store, getApiKey, setApiKey, clearApiKey, isKeyRemembered, keyTail, saveTheme, demoSpeedPref,
} from './store.js';
import {
  h, icon, button, setBusy, toast, modal, confirmDialog, menu, emptyState, skeleton, clear,
  fmtMinutes, fmtInt, stageLabel, str, arr, obj, num, STATUS_LABEL, ACTIVE_STATUSES, uid,
} from './ui.js';
import { mountCompose } from './views/compose.js';
import { mountRun } from './views/run.js';
import { openHelp, startDemo } from './onboarding.js';

const APP_NAME = 'AI Research Agent';
const RUN_TABS = new Set(['report', 'evidence', 'verify', 'process', 'qa']);
const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';
const MAX_TITLE = 80;
const MAX_RUN_FILE = 20 * 1024 * 1024;

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
  closeDrawer();
  highlightHistory(r.runId || null);

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
  main.append(container);
  document.title = APP_NAME;
  let unmount = null;
  try {
    unmount = r.name === 'run' ? mountRun(container, { runId: r.runId, tab: r.tab }) : mountCompose(container, {});
  } catch (err) {
    console.error(err);
    container.append(emptyState({ icon: 'alert-triangle', title: '화면을 그리지 못했습니다', text: str(err?.message) }));
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

function themeControl() {
  const opts = [
    ['light', 'sun', '라이트'],
    ['dark', 'moon', '다크'],
    ['system', 'monitor', '시스템 설정'],
  ];
  const wrap = h('div', { class: 'seg seg-icons', role: 'group', 'aria-label': '테마' });
  const render = () => {
    const theme = store.get().theme;
    wrap.replaceChildren(...opts.map(([id, ic, label]) => h('button', {
      type: 'button', class: 'seg-btn', title: label, 'aria-label': `테마: ${label}`,
      'aria-pressed': theme === id ? 'true' : 'false',
      onClick: () => setTheme(id),
    }, icon(ic, 16))));
  };
  render();
  store.subscribe((s, p) => { if (s.theme !== p.theme) render(); });
  return wrap;
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

  const body = h('div', { class: 'key-form' },
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

  dlg = modal({
    title: 'API 키',
    body,
    onClose: () => unsub(),
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

function keyButton() {
  const btn = h('button', { type: 'button', class: 'key-btn', onClick: () => openKeyDialog() });
  const render = () => {
    const t = keyStatusText(store.get().keyStatus);
    btn.replaceChildren(
      h('span', { class: 'key-btn-icon' }, icon('key', 16), h('span', { class: ['status-dot', 'status-dot-sm', `tone-${t.tone}`] })),
      h('span', { class: 'key-btn-text' }, h('span', { class: 'key-btn-label' }, t.label), h('span', { class: 'key-btn-sub' }, t.sub)));
    btn.setAttribute('aria-label', `API 키 설정: ${t.label}, ${t.sub}`);
  };
  render();
  store.subscribe((s, p) => { if (s.keyStatus !== p.keyStatus || s.config !== p.config) render(); });
  return btn;
}

// ───────────────────────── 기록 목록 ─────────────────────────

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

function runTitle(r) {
  return str(r.custom_title).trim() || str(r.topic).trim() || str(r.prompt).trim() || '제목 없는 조사';
}

function historySub(r, cfg) {
  if (ACTIVE_STATUSES.has(r.status)) {
    if (r.status === 'awaiting_plan') return '계획 검토를 기다리는 중';
    if (r.status === 'queued') return '시작 대기 중';
    return `${stageLabel(r.stage, cfg)} 단계`;
  }
  if (r.status === 'error') return '오류로 멈춤';
  if (r.status === 'cancelled') return '중단됨';
  if (r.status === 'interrupted') return '페이지를 닫아 멈춤';
  const parts = [str(r.model_label) || str(r.model)];
  const el = num(r.elapsed_s);
  if (el !== null) parts.push(fmtMinutes(el));
  const inc = num(obj(r.counts).included);
  if (inc !== null) parts.push(`채택 ${fmtInt(inc)}건`);
  return parts.filter(Boolean).join(' · ');
}

function historyItem(r, cfg, activeId) {
  const id = str(r.id);
  const status = str(r.status, 'done');
  const topic = runTitle(r);
  const running = ACTIVE_STATUSES.has(status);
  const finished = !!r.has_result || status === 'done';
  const more = h('button', {
    type: 'button', class: 'hist-more btn btn-ghost btn-icon btn-sm', 'aria-label': `${topic} 메뉴`, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu(more, [
        {
          label: '이름 바꾸기', icon: 'edit', disabled: !!r.sample,
          note: r.sample ? '샘플은 이름을 바꿀 수 없습니다' : null,
          onClick: () => renameRun(r),
        },
        {
          label: '조사 파일 저장', icon: 'download', disabled: !finished,
          note: finished ? null : '끝난 조사만 저장할 수 있습니다',
          title: "이 사이트의 '조사 파일 열기'로 다른 컴퓨터에서도 결과를 다시 볼 수 있습니다.",
          onClick: () => exportRun(id),
        },
        { separator: true },
        {
          label: '삭제', icon: 'trash', danger: true, disabled: !!r.sample || running,
          note: r.sample ? '샘플은 삭제할 수 없습니다' : running ? '진행 중에는 삭제할 수 없습니다' : null,
          onClick: () => deleteRun(id, topic),
        },
      ]);
    },
  }, icon('more-horizontal', 16));

  const tags = [];
  if (r.sample) tags.push(h('span', { class: 'tag' }, '샘플'));
  if (r.demo) tags.push(h('span', { class: 'tag' }, '데모'));
  if (r.imported) tags.push(h('span', { class: 'tag' }, '가져옴'));
  if (r.parent_id) tags.push(h('span', { class: 'tag', title: '보고서 다시 쓰기로 만든 결과' }, '다시 씀'));
  if (r.resumable && !running) tags.push(h('span', { class: 'tag tag-accent', title: '멈춘 단계부터 이어서 진행할 수 있습니다' }, '이어서 가능'));

  return h('li', { class: 'hist-li' },
    h('a', {
      class: ['hist-item', id === activeId ? 'is-current' : ''], href: `#/run/${encodeURIComponent(id)}`,
      'aria-current': id === activeId ? 'page' : null, dataset: { id },
      title: topic,
    },
    h('span', { class: ['status-dot', `st-${status}`], role: 'img', 'aria-label': STATUS_LABEL[status] || status }),
    h('span', { class: 'hist-body' },
      h('span', { class: 'hist-topic' }, topic),
      h('span', { class: 'hist-sub' }, tags, h('span', { class: 'hist-sub-text' }, historySub(r, cfg))))),
    more);
}

function renameRun(r) {
  const id = str(r.id);
  const inputId = uid('rename');
  const input = h('input', {
    id: inputId, class: 'input', type: 'text', maxlength: String(MAX_TITLE), autocomplete: 'off',
    value: str(r.custom_title).trim() || str(r.topic).trim(),
  });
  const counter = h('span', { class: 'field-hint num' });
  const sync = () => { counter.textContent = `${fmtInt([...input.value].length)} / ${MAX_TITLE}`; };
  input.addEventListener('input', sync);
  sync();
  const dlg = modal({
    title: '이름 바꾸기',
    body: h('div', { class: 'key-form' },
      h('label', { class: 'field-label', htmlFor: inputId }, '기록에 보일 이름'),
      input,
      h('div', { class: 'rename-foot' },
        h('span', { class: 'field-hint' }, '비워 두면 원래 주제로 돌아갑니다.'), counter)),
    actions: [
      { label: '취소', kind: 'secondary' },
      {
        label: '저장', kind: 'primary', icon: 'check',
        onClick: async ({ close, button: btn }) => {
          setBusy(btn, true, '저장하는 중…');
          try {
            await api.rename(id, input.value.trim());
            close();
            toast('이름을 바꿨습니다.', 'success');
            refreshRuns();
          } catch (err) {
            setBusy(btn, false);
            toast(str(err?.message, '이름을 바꾸지 못했습니다.'), 'error');
          }
        },
      },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      dlg.el.querySelector('.modal-foot .btn-primary')?.click();
    }
  });
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

async function exportRun(id) {
  try {
    const name = await saveRunFile(id);
    toast(`조사 파일을 저장했습니다: ${name}`, 'success');
  } catch (err) {
    toast(str(err?.message, '조사 파일을 저장하지 못했습니다.'), 'error');
  }
}

async function deleteRun(id, topic) {
  const ok = await confirmDialog(`"${topic.length > 60 ? `${topic.slice(0, 59)}…` : topic}" 기록을 삭제할까요? 보고서와 Q&A 기록도 함께 지워지며 되돌릴 수 없습니다.`, '삭제', { title: '기록 삭제', danger: true });
  if (!ok) return;
  try {
    await api.remove(id);
    toast('기록을 삭제했습니다.', 'success');
    if (parseHash().runId === id) navigate('#/');
    refreshRuns();
  } catch (err) {
    toast(str(err?.message, '삭제하지 못했습니다.'), 'error');
  }
}

function matchesQuery(r, q) {
  if (!q) return true;
  return [r.custom_title, r.topic, r.prompt].some((v) => str(v).toLocaleLowerCase().includes(q));
}

function renderHistory() {
  if (!shell) return;
  const { runs, config, historyQuery } = store.get();
  const list = shell.history;
  const activeId = parseHash().runId || null;
  // 항목 메뉴가 열려 있으면 닫힌 뒤에 다시 그린다
  if (list.querySelector('.hist-more[aria-expanded="true"]')) {
    setTimeout(renderHistory, 1500);
    return;
  }
  if (runs === null) {
    list.replaceChildren(h('li', { class: 'hist-skel' }, skeleton(4)));
    return;
  }
  if (!runs.length) {
    list.replaceChildren(h('li', { class: 'hist-empty' }, '아직 조사 기록이 없습니다. 주제를 적고 첫 조사를 시작해 보세요.'));
    return;
  }
  const q = str(historyQuery).trim().toLocaleLowerCase();
  const shown = runs.filter((r) => r && r.id && matchesQuery(r, q));
  if (!shown.length) {
    list.replaceChildren(h('li', { class: 'hist-empty' }, '검색 결과가 없습니다'));
    return;
  }
  list.replaceChildren(...shown.map((r) => historyItem(r, config, activeId)));
}

function historySearch() {
  const input = h('input', {
    class: 'input hist-search-input', type: 'search', placeholder: '기록 검색', autocomplete: 'off', spellcheck: 'false',
    'aria-label': '기록 검색 (주제·프롬프트·이름)', value: str(store.get().historyQuery),
  });
  const clearBtn = h('button', {
    type: 'button', class: 'hist-search-clear btn btn-ghost btn-icon btn-xs', 'aria-label': '검색어 지우기',
    onClick: () => { input.value = ''; update(); input.focus(); },
  }, icon('x', 14));
  clearBtn.hidden = !input.value;
  let timer = 0;
  function update() {
    clearBtn.hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(() => store.set({ historyQuery: input.value }), 120);
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; update(); }
  });
  return h('div', { class: 'hist-search', role: 'search' },
    h('span', { class: 'hist-search-icon', 'aria-hidden': 'true' }, icon('search', 14)), input, clearBtn);
}

function highlightHistory(activeId) {
  if (!shell) return;
  for (const a of shell.history.querySelectorAll('.hist-item')) {
    const on = a.dataset.id === activeId;
    a.classList.toggle('is-current', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
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

function openFileButton() {
  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true',
    onChange: () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      importFile(f);
    },
  });
  const btn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm sidebar-tool',
    title: '저장해 둔 조사 파일(.json)을 엽니다. 창에 끌어다 놓아도 됩니다.',
    onClick: () => { closeDrawer(); fileInput.click(); },
  }, icon('folder-open', 14), h('span', { class: 'btn-label' }, '조사 파일 열기'));
  return [btn, fileInput];
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

function openDrawer() {
  document.body.classList.add('drawer-open');
  shell.menuBtn.setAttribute('aria-expanded', 'true');
  shell.sidebar.querySelector('.btn-new')?.focus();
}
function closeDrawer() {
  if (!shell) return;
  const wasOpen = document.body.classList.contains('drawer-open');
  document.body.classList.remove('drawer-open');
  shell.menuBtn.setAttribute('aria-expanded', 'false');
  // 서랍 안에 있던 초점이 숨겨진 사이드바에 남지 않게 메뉴 버튼으로 돌려준다(메뉴 버튼은 좁은 화면에서만 보인다)
  if (wasOpen && shell.sidebar.contains(document.activeElement) && getComputedStyle(shell.menuBtn).display !== 'none') {
    try { shell.menuBtn.focus({ preventScroll: true }); } catch { /* 무시 */ }
  }
}

function wordmark() {
  return h('a', { class: 'wordmark', href: '#/', 'aria-label': `${APP_NAME} 처음 화면` },
    h('span', { class: 'logo' }, icon('logo', 16)),
    h('span', { class: 'wordmark-text' }, APP_NAME));
}

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

function renderShell(root) {
  const history = h('ul', { class: 'hist-list', 'aria-label': '조사 기록' });
  const newBtn = h('a', { class: 'btn btn-primary btn-new', href: '#/', onClick: () => { if (location.hash === '#/' || !location.hash) navigate('#/'); } },
    icon('plus', 16), h('span', { class: 'btn-label' }, '새 조사'));
  const helpBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm sidebar-tool', title: '처음 사용 안내를 다시 봅니다',
    onClick: () => { closeDrawer(); openHelp(); },
  }, icon('help', 14), h('span', { class: 'btn-label' }, '도움말'));
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': '사이드바' },
    h('div', { class: 'sidebar-head' }, wordmark(),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm drawer-close', 'aria-label': '메뉴 닫기', onClick: closeDrawer }, icon('x', 16))),
    h('div', { class: 'sidebar-new' }, newBtn),
    h('nav', { class: 'sidebar-nav', 'aria-label': '조사 기록' },
      h('div', { class: 'sidebar-label' },
        h('span', null, '기록'),
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-icon btn-xs', 'aria-label': '기록 새로 고침', title: '새로 고침',
          onClick: () => refreshRuns(),
        }, icon('refresh', 14))),
      historySearch(),
      history),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'sidebar-tools' }, openFileButton(), helpBtn),
      keyButton(), themeControl()));

  const menuBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '메뉴 열기', 'aria-controls': 'sidebar', 'aria-expanded': 'false',
    onClick: openDrawer,
  }, icon('menu', 18));
  const topbar = h('header', { class: 'topbar' }, menuBtn, wordmark(),
    h('a', { class: 'btn btn-secondary btn-sm topbar-new', href: '#/' }, icon('plus', 14), h('span', { class: 'btn-label' }, '새 조사')));
  const banners = h('div', { class: 'banners' });
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const scrim = h('div', { class: 'drawer-scrim', onClick: closeDrawer });

  root.replaceChildren(
    h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); main.focus(); } }, '본문으로 건너뛰기'),
    h('div', { class: 'app' }, sidebar, scrim, h('div', { class: 'app-main' }, topbar, banners, main)));

  shell = { sidebar, history, main, banners, menuBtn };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && !document.querySelector('.modal-root, .popover')) closeDrawer();
  });
  store.subscribe((s, p) => {
    if (s.runs !== p.runs || s.config !== p.config || s.historyQuery !== p.historyQuery) renderHistory();
    if (s.config !== p.config) renderBanners();
  });
  renderHistory();
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
  shell = null;
  for (const el of document.querySelectorAll('.modal-root, .popover')) el.remove();
  document.body.classList.remove('has-modal', 'drawer-open', 'has-runbar');
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

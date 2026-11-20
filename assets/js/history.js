// 조사 기록(LAYOUT_V3 1.3절): 왼쪽 사이드바의 세로 목록 — 검색, 새로 고침, 지금 보고 있는 실행 표시,
// 항목 메뉴(이름 바꾸기 · 조사 파일 저장 · 삭제), 태그. main.js가 사이드바 안에 한 번 붙이고 페이지가 살아 있는 동안 쓴다.
// main.js와 서로 가져오지만, main.js의 것은 함수 안에서만 쓴다(모듈 최상위에서 쓰지 않음).

import { api, saveRunFile } from './api.js';
import { store } from './store.js';
import {
  h, icon, setBusy, toast, modal, confirmDialog, menu, skeleton,
  fmtMinutes, fmtInt, stageLabel, str, arr, obj, num, STATUS_LABEL, ACTIVE_STATUSES, uid,
} from './ui.js';
import { refreshRuns, navigate } from './main.js';

const MAX_TITLE = 80;

/** 주소의 #/run/<id>에서 지금 보고 있는 실행 id를 꺼낸다(없으면 '') */
function currentRunId() {
  const m = /^#\/run\/([^/?#]+)/.exec(globalThis.location?.hash || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
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

function historyItem(r, cfg) {
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
    h('a', { class: 'hist-item', href: `#/run/${encodeURIComponent(id)}`, dataset: { id }, title: topic },
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
    // 지운 실행을 보고 있었으면 처음 화면으로 간다. 아니면 지금 화면을 두고 목록만 새로 고친다.
    if (currentRunId() === id) navigate('#/');
    refreshRuns();
  } catch (err) {
    toast(str(err?.message, '삭제하지 못했습니다.'), 'error');
  }
}

function matchesQuery(r, q) {
  if (!q) return true;
  return [r.custom_title, r.topic, r.prompt].some((v) => str(v).toLocaleLowerCase().includes(q));
}

/**
 * 왼쪽 사이드바의 조사 기록 목록을 만든다(LAYOUT_V3 1.3). 카드 격자·"모두 보기" 없이 전부 보여 주고 목록만 스크롤된다.
 * main.js가 사이드바 안에 한 번 붙인다. 넘겨준 탭(stopThisTab)에서는 destroy()로 구독·타이머·hashchange를 정리한다.
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function mountHistory() {
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };
  let destroyed = false;

  const count = h('span', { class: 'sh-count num', hidden: true });
  const list = h('ul', { class: 'hist-list', id: uid('hist'), 'aria-label': '조사 기록 목록' });

  // 검색 입력(기존 .hist-search 그대로)
  const searchInput = h('input', {
    class: 'input hist-search-input', type: 'search', placeholder: '기록 검색', autocomplete: 'off', spellcheck: 'false',
    'aria-label': '기록 검색 (주제·프롬프트·이름)', value: str(store.get().historyQuery),
  });
  let searchTimer = 0;
  const updateSearch = () => {
    clearBtn.hidden = !searchInput.value;
    cancel(searchTimer);
    searchTimer = later(() => store.set({ historyQuery: searchInput.value }), 120);
  };
  const clearBtn = h('button', {
    type: 'button', class: 'hist-search-clear btn btn-ghost btn-icon btn-xs', 'aria-label': '검색어 지우기',
    onClick: () => { searchInput.value = ''; updateSearch(); searchInput.focus(); },
  }, icon('x', 14));
  clearBtn.hidden = !searchInput.value;
  searchInput.addEventListener('input', updateSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; updateSearch(); }
  });
  const search = h('div', { class: 'hist-search', role: 'search' },
    h('span', { class: 'hist-search-icon', 'aria-hidden': 'true' }, icon('search', 14)), searchInput, clearBtn);

  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-xs sh-refresh', 'aria-label': '기록 새로 고침', title: '새로 고침',
    onClick: () => refreshRuns(),
  }, icon('refresh', 14));

  const el = h('section', { class: 'side-history', 'aria-label': '조사 기록' },
    h('div', { class: 'sh-head' }, h('span', { class: 'sh-title' }, '기록'), count, refreshBtn),
    search,
    list);

  /** 지금 보고 있는 실행 줄을 표시하고, reveal이면 목록 안에서 보이게 스크롤한다(창은 움직이지 않는다) */
  function syncCurrent(reveal = false) {
    const cur = currentRunId();
    let hit = null;
    for (const a of list.querySelectorAll('.hist-item')) {
      const on = !!cur && a.dataset.id === cur;
      a.classList.toggle('is-current', on);
      if (on) { a.setAttribute('aria-current', 'page'); hit = a; } else a.removeAttribute('aria-current');
    }
    if (!reveal || !hit) return;
    const box = list.getBoundingClientRect();
    if (!box.height) return; // 접힌 사이드바·닫힌 서랍
    const r = hit.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop -= box.top - r.top + 4;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom + 4;
  }
  const onHash = () => syncCurrent(true);
  window.addEventListener('hashchange', onHash);

  let retryTimer = 0;
  let revealed = false;
  function render() {
    if (destroyed) return;
    // 항목 메뉴가 열려 있으면 닫힌 뒤에 다시 그린다
    if (list.querySelector('.hist-more[aria-expanded="true"]')) {
      if (!retryTimer) retryTimer = later(() => { retryTimer = 0; render(); }, 1500);
      return;
    }
    const { runs, config, historyQuery } = store.get();
    if (runs === null) {
      count.hidden = true;
      list.setAttribute('aria-busy', 'true');
      list.replaceChildren(h('li', { class: 'hist-skel' }, skeleton(3)));
      return;
    }
    list.removeAttribute('aria-busy');
    const all = arr(runs).filter((r) => r && r.id);
    count.textContent = fmtInt(all.length);
    count.hidden = !all.length;
    if (!all.length) {
      list.replaceChildren(h('li', { class: 'hist-empty' }, '아직 조사 기록이 없습니다. 주제를 적고 첫 조사를 시작해 보세요.'));
      return;
    }
    const q = str(historyQuery).trim().toLocaleLowerCase();
    const shown = all.filter((r) => matchesQuery(r, q));
    if (!shown.length) {
      list.replaceChildren(h('li', { class: 'hist-empty' }, '검색 결과가 없습니다'));
      return;
    }
    // 다시 그려도 키보드 초점이 있던 항목을 잃지 않게 한다
    const active = document.activeElement;
    const focusId = active && list.contains(active) ? active.closest('.hist-li')?.querySelector('.hist-item')?.dataset.id : null;
    const focusMore = !!(active && active.classList?.contains('hist-more'));
    const scrollTop = list.scrollTop;
    list.replaceChildren(...shown.map((r) => historyItem(r, config)));
    list.scrollTop = scrollTop;
    if (focusId) {
      const a = [...list.querySelectorAll('.hist-item')].find((x) => x.dataset.id === focusId);
      const target = focusMore ? a?.parentElement?.querySelector('.hist-more') : a;
      try { target?.focus({ preventScroll: true }); } catch { /* 무시 */ }
    }
    // 처음 목록이 채워질 때만 지금 실행이 보이게 스크롤한다(주기적 새로 고침은 스크롤을 건드리지 않는다)
    syncCurrent(!revealed);
    revealed = true;
  }

  const unsub = store.subscribe((s, p) => {
    if (s.runs !== p.runs || s.config !== p.config || s.historyQuery !== p.historyQuery) render();
  });
  render();

  return {
    el,
    destroy() {
      destroyed = true;
      unsub();
      window.removeEventListener('hashchange', onHash);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

// 조사 기록(LAYOUT_V2 2절): 처음 화면 아래쪽의 카드 격자 — 검색, 조사 파일 열기, 새로 고침, 모두 보기,
// 항목 메뉴(이름 바꾸기 · 조사 파일 저장 · 삭제), 태그. main.js의 사이드바 기록 코드를 옮겨 온 것이다.
// main.js와 서로 가져오지만, main.js의 것은 함수 안에서만 쓴다(모듈 최상위에서 쓰지 않음).

import { api, saveRunFile } from './api.js';
import { store } from './store.js';
import {
  h, icon, setBusy, toast, modal, confirmDialog, menu, skeleton,
  fmtMinutes, fmtInt, stageLabel, str, arr, obj, num, STATUS_LABEL, ACTIVE_STATUSES, uid,
} from './ui.js';
import { refreshRuns, pickRunFile } from './main.js';

const MAX_TITLE = 80;
const DEFAULT_LIMIT = 6;

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
    // 처음 화면에 있으므로 이동하지 않고 목록만 새로 고친다
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
 * 처음 화면의 조사 기록 구역을 만든다.
 * @param {{limit?: number}} opts limit: 처음에 보여 줄 개수(기본 6). 검색 중에는 무시한다.
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function mountHistory(opts = {}) {
  const limit = Math.max(1, Math.floor(Number(obj(opts).limit)) || DEFAULT_LIMIT);
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };
  let destroyed = false;

  const listId = uid('hist');
  const count = h('span', { class: 'hh-count num', hidden: true });
  const list = h('ul', { class: 'hist-list hist-grid', id: listId, 'aria-label': '조사 기록 목록' });
  const moreBtn = h('button', {
    type: 'button', class: 'hh-more btn btn-ghost btn-sm', hidden: true, 'aria-controls': listId, 'aria-expanded': 'false',
    onClick: () => store.set({ historyExpanded: !store.get().historyExpanded }),
  });

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

  const openBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm hh-tool',
    title: '저장해 둔 조사 파일(.json)을 엽니다. 창에 끌어다 놓아도 됩니다.',
    onClick: () => pickRunFile(),
  }, icon('folder-open', 14), h('span', { class: 'btn-label' }, '조사 파일 열기'));
  const refreshBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm hh-tool', 'aria-label': '기록 새로 고침', title: '새로 고침',
    onClick: () => refreshRuns(),
  }, icon('refresh', 14));

  const el = h('section', { class: 'home-history', 'aria-label': '조사 기록' },
    h('div', { class: 'hh-head' },
      h('h2', { class: 'hh-title' }, '최근 조사', count),
      h('div', { class: 'hh-tools' }, search, openBtn, refreshBtn)),
    list,
    moreBtn);

  let retryTimer = 0;
  function render() {
    if (destroyed) return;
    // 항목 메뉴가 열려 있으면 닫힌 뒤에 다시 그린다
    if (list.querySelector('.hist-more[aria-expanded="true"]')) {
      if (!retryTimer) retryTimer = later(() => { retryTimer = 0; render(); }, 1500);
      return;
    }
    const { runs, config, historyQuery, historyExpanded } = store.get();
    moreBtn.hidden = true;
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
    let shown = all.filter((r) => matchesQuery(r, q));
    if (!shown.length) {
      list.replaceChildren(h('li', { class: 'hist-empty' }, '검색 결과가 없습니다'));
      return;
    }
    if (!q && shown.length > limit) {
      const expanded = !!historyExpanded;
      moreBtn.textContent = expanded ? '접기' : `기록 모두 보기 (${fmtInt(shown.length)}개)`;
      moreBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      moreBtn.hidden = false;
      if (!expanded) shown = shown.slice(0, limit);
    }
    // 다시 그려도 키보드 초점이 있던 항목을 잃지 않게 한다
    const active = document.activeElement;
    const focusId = active && list.contains(active) ? active.closest('.hist-li')?.querySelector('.hist-item')?.dataset.id : null;
    const focusMore = !!(active && active.classList?.contains('hist-more'));
    list.replaceChildren(...shown.map((r) => historyItem(r, config)));
    if (focusId) {
      const a = [...list.querySelectorAll('.hist-item')].find((x) => x.dataset.id === focusId);
      const target = focusMore ? a?.parentElement?.querySelector('.hist-more') : a;
      try { target?.focus({ preventScroll: true }); } catch { /* 무시 */ }
    }
  }

  const unsub = store.subscribe((s, p) => {
    if (s.runs !== p.runs || s.config !== p.config || s.historyQuery !== p.historyQuery || s.historyExpanded !== p.historyExpanded) render();
  });
  render();

  return {
    el,
    destroy() {
      destroyed = true;
      unsub();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

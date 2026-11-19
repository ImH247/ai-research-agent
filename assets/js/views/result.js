// 결과 화면 (FRONTEND 6): 머리(주제·메타·내려받기) + 탭 5개(report|evidence|verify|process|qa).
// backend.result(id)를 한 번 받아 모든 탭이 공유한다. 탭 내용은 처음 열 때 만든다.
// XSS 규칙: innerHTML에는 백엔드가 만든 report_html, answer_html만 넣는다(trustedFragment 한 곳).
// 그 밖의 문자열은 모두 h()/textContent로 넣는다.

import * as API from '../api.js';
import { store, getApiKey } from '../store.js';
import { navigate, openKeyDialog } from '../main.js';
import {
  h, icon, str, arr, obj, num, uid, button, setBusy, toast, menu, modal, badge, verdictBadge, kindBadge,
  strengthBadge, directionText, emptyState, skeleton, spinner, attachCitePopovers, copyText, autosize, wireTablist,
  fmtInt, fmtCost, fmtMinutes, fmtDateTime, truncate, safeHref, fmtAuthors, studyTypeLabel,
  KIND_LABEL, DIRECTION_LABEL, VERDICT_LABEL,
} from '../ui.js';
import { eventRow, reflectionCard } from './run.js';
import { rankedBars, segmentedBar, columnBars, segmentedRows, hideTooltip } from '../charts.js';
import { openRewriteDialog } from './rewrite.js';

// 파일 저장·새 창은 api.js의 공용 도우미를 쓴다(팝업 차단·인쇄 처리가 한 곳에 있다)
const api = API.api;
const downloadFile = (id, fmt) => API.download(id, fmt);
const openHtmlWindow = (html, opts) => API.openHtml(html, opts);
/** {filename, mime, data}를 파일로 저장한다 → 파일 이름 */
const saveFile = (file) => API.saveFile(obj(file));

const TOOL_FALLBACK = { web_search: '웹 검색' };

const APP_NAME = 'AI Research Agent';

const TABS = [
  { id: 'report', label: '보고서', icon: 'file-text' },
  { id: 'evidence', label: '근거', icon: 'list' },
  { id: 'verify', label: '검증', icon: 'shield-check' },
  { id: 'process', label: '과정', icon: 'route' },
  { id: 'qa', label: '질문하기', icon: 'message' },
];
const TAB_IDS = new Set(TABS.map((t) => t.id));

const FORMAT_SHORT = {
  md: 'Markdown', html: 'HTML', pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint',
  bib: 'BibTeX', ris: 'RIS', csv: 'CSV', json: 'JSON', zip: 'ZIP',
};
const FORMAT_ICON = {
  md: 'file-text', html: 'file-text', pdf: 'file-text', docx: 'file-text', pptx: 'presentation',
  bib: 'book', ris: 'book', csv: 'database', json: 'database', zip: 'download',
};
const FORMAT_ORDER = ['md', 'html', 'pdf', 'docx', 'pptx', 'bib', 'ris', 'csv', 'json'];

// 결과 방향: 대상마다 색을 고정한다(FRONTEND 9.5). 해당 없음·미분류는 중립 조각 하나로 합친다.
const DIRECTION_SERIES = [
  { key: 'positive', label: '긍정', color: 'var(--chart-1)' },
  { key: 'negative', label: '부정', color: 'var(--chart-2)' },
  { key: 'mixed', label: '혼재', color: 'var(--chart-3)' },
  { key: 'null', label: '효과 없음', color: 'var(--chart-4)' },
];
// 판정: 상태색은 판정 표시에만, 항상 아이콘 + 글자와 함께
const VERDICT_SERIES = [
  { key: 'supported', label: VERDICT_LABEL.supported, color: 'var(--good)', icon: 'check' },
  { key: 'partially supported', label: VERDICT_LABEL['partially supported'], color: 'var(--warning)', icon: 'wave' },
  { key: 'not in source text', label: VERDICT_LABEL['not in source text'], color: 'var(--neutral)', icon: 'minus' },
  { key: 'contradicted', label: VERDICT_LABEL.contradicted, color: 'var(--critical)', icon: 'x' },
  { key: 'not checked', label: VERDICT_LABEL['not checked'], color: 'var(--border-strong)', icon: 'minus' },
];
const COVERAGE_LABEL = { good: '충분', adequate: '충분', sufficient: '충분', partial: '부분', poor: '부족', none: '없음', missing: '없음' };
const NONE = '__none';

const CITE_RE = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g;

// ───────────────────────── 작은 도우미 ─────────────────────────

/** 문자열 목록 정리: 빈 값과 "…(+3)" 같은 생략 표시를 뺀다 */
function texts(list) {
  return arr(list).map((x) => str(x).trim()).filter((x) => x && !/^…/.test(x));
}

function isReduced() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function scrollBehavior() {
  return isReduced() ? 'auto' : 'smooth';
}

function sidNum(s) {
  const m = str(s?.sid).match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function countBy(list, keyFn) {
  const out = {};
  for (const it of list) {
    const k = keyFn(it);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function nonEmpty(o) {
  const v = obj(o);
  return Object.keys(v).length ? v : null;
}

function citeChip(sid) {
  return h('a', { class: 'cite', href: `#ref-${sid}`, dataset: { sid }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, sid);
}

const UNKNOWN_CITE_TITLE = '수집한 출처 목록에 없는 인용입니다';

/** 출처 목록에 없는 인용 ID: 지어낸 인용일 수 있으므로 반드시 보이게 표시한다 */
function unknownCiteAttrs(el, id) {
  if (!el.getAttribute('title')) el.setAttribute('title', UNKNOWN_CITE_TITLE);
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', `${id}: ${UNKNOWN_CITE_TITLE}`);
  return el;
}

function unknownCite(id) {
  return unknownCiteAttrs(h('span', { class: 'cite-unknown' }, id), id);
}

/**
 * 텍스트 안의 [S12] · [S1, S2] 인용을 칩으로 바꾼 노드 목록.
 * 문자열을 인용 패턴으로 나눠 요소를 만든다(innerHTML을 쓰지 않는다). 문헌 목록에 없는 ID는 span.cite-unknown으로 표시한다.
 */
function citeNodes(text, hasSid) {
  const s = str(text);
  const out = [];
  const re = new RegExp(CITE_RE.source, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const ids = m[1].split(/\s*[,;]\s*/);
    const span = h('span', { class: 'cites' }, '[');
    ids.forEach((id, i) => {
      if (i) span.append(', ');
      span.append(hasSid(id) ? citeChip(id) : unknownCite(id));
    });
    span.append(']');
    out.push(span);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const BLOCKED_TAGS = 'script,style,iframe,frame,frameset,object,embed,link,meta,base,form,input,button,textarea,select,svg,math';

/**
 * 백엔드가 만든 HTML(report_html·answer_html 전용)을 비활성 template에서 해석해 조각으로 돌려준다.
 * 백엔드가 이미 안전하게 만들지만, 한 번 더 스크립트·이벤트 속성·위험한 URL을 걷어 낸다.
 */
function trustedFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = str(html); // 허용된 두 값(report_html, answer_html)만 이 함수로 들어온다
  const frag = tpl.content;
  frag.querySelectorAll(BLOCKED_TAGS).forEach((el) => el.remove());
  frag.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || n === 'srcdoc'
        || (['src', 'href', 'xlink:href', 'action', 'formaction'].includes(n) && /^\s*(javascript|data|vbscript):/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    }
  });
  frag.querySelectorAll('a[href]').forEach((a) => {
    if (a.classList.contains('cite')) {
      a.setAttribute('aria-haspopup', 'dialog');
      a.setAttribute('aria-expanded', 'false');
      return;
    }
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) { a.dataset.inpage = href.slice(1); return; }
    const safe = safeHref(href);
    if (!safe) { a.removeAttribute('href'); return; }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  // .cites는 font-size 0으로 괄호·쉼표를 숨긴다: 그 밖의 맨 글자(예전 렌더러의 목록에 없는 ID)는 보이는 조각으로 바꾼다
  frag.querySelectorAll('.cites').forEach((g) => {
    for (const t of [...g.childNodes]) {
      if (t.nodeType !== Node.TEXT_NODE || /^[\s[\],;]*$/.test(t.data)) continue;
      const parts = t.data.split(/([^\s[\],;]+)/).filter(Boolean)
        .map((p) => (/^[\s[\],;]+$/.test(p) ? p : unknownCite(p)));
      t.replaceWith(...parts);
    }
  });
  frag.querySelectorAll('.cite-unknown').forEach((el) => unknownCiteAttrs(el, el.textContent.trim()));
  frag.querySelectorAll('table').forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains('prose-table')) return;
    const wrap = h('div', { class: 'prose-table', tabindex: '0', role: 'region', 'aria-label': '표 (가로로 스크롤할 수 있습니다)' });
    t.replaceWith(wrap);
    wrap.append(t);
  });
  return frag;
}

/** 상단 고정 영역(좁은 화면의 상단 바 + 탭 줄) 높이 */
function topbarHeight() {
  const tb = document.querySelector('.topbar');
  if (!tb) return 0;
  return getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect().height : 0;
}

function tile(label, value, hint) {
  return h('div', { class: 'tile' },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-value num' }, value),
    hint ? h('span', { class: 'tile-hint' }, hint) : null);
}

function sectionCard(title, { aside, step, actions, cls } = {}, ...children) {
  return h('section', { class: ['card', 'r-card', cls] },
    h('div', { class: 'card-head' },
      h('h2', { class: 'r-card-title' }, step ? h('span', { class: 'step-no num', 'aria-hidden': 'true' }, step) : null, title),
      aside || actions ? h('div', { class: 'r-card-aside' }, aside ? h('span', { class: 'card-aside' }, aside) : null, actions || null) : null),
    children);
}

function bulletList(items, render = (x) => x) {
  const list = arr(items);
  if (!list.length) return null;
  return h('ul', { class: 'r-bullets' }, list.map((x) => h('li', null, render(x))));
}

// ───────────────────────── 진입점 ─────────────────────────

/**
 * 결과 화면을 그린다. 해제 함수를 돌려주며, 해제 함수의 .update({tab})는 같은 실행 안에서 탭만 바꾼다.
 */
export function mountResult(container, { runId, tab, status, fromLive } = {}) {
  const st = {
    R: null, raw: null, tab: TAB_IDS.has(tab) ? tab : 'report', disposed: false,
    views: new Map(), // tabId → {onShow, select}
    cleanups: [], pendingSid: null,
  };
  const snap = obj(status);
  const root = h('div', { class: 'page result' });
  container.replaceChildren(root);
  const initialTopic = str(snap.topic).trim() || str(snap.prompt).trim();
  if (initialTopic && !fromLive) document.title = `${truncate(initialTopic, 40)} — ${APP_NAME}`;

  let tabButtons = new Map();
  let panels = new Map();
  let tabsSentinel = null;
  let qaBadge = null;

  const cfg = () => obj(store.get().config);
  const addCleanup = (fn) => { if (typeof fn === 'function') st.cleanups.push(fn); };

  // ── 로딩 · 오류 ──
  function showSkeleton() {
    root.replaceChildren(
      h('div', { class: 'result-head', 'aria-busy': 'true' },
        h('div', { class: 'skel skel-line', style: { width: '120px' } }),
        h('div', { class: 'skel skel-title' }),
        h('div', { class: 'skel skel-line', style: { width: '55%' } }),
        h('div', { class: 'result-actions' }, [96, 96, 120].map((w) => h('div', { class: 'skel skel-btn', style: { width: `${w}px` } })))),
      h('div', { class: 'result-tabs is-skeleton' }, TABS.map(() => h('div', { class: 'skel skel-line', style: { width: '64px' } }))),
      h('div', { class: 'report-layout' },
        h('div', { class: 'toc-rail' }, skeleton(6)),
        h('div', { class: 'report-main' }, h('div', { class: 'card' }, skeleton(8, { block: true })))),
      h('p', { class: 'sr-only', role: 'status' }, '결과를 불러오는 중입니다.'));
  }

  function showError(err) {
    const noResult = err?.status === 404 || err?.code === 'no_result' || err?.code === 'not_found';
    root.replaceChildren(h('div', { class: 'result-error' }, emptyState(noResult
      ? {
        icon: 'file-text', title: '이 조사의 결과 파일을 찾을 수 없습니다',
        text: '결과가 저장되지 않았거나 삭제되었습니다. 같은 주제로 새 조사를 시작할 수 있습니다.',
        action: h('div', { class: 'result-error-actions' },
          button('다시 불러오기', { kind: 'secondary', icon: 'refresh', onClick: () => { showSkeleton(); load(); } }),
          button('새 조사', { kind: 'primary', icon: 'plus', onClick: () => navigate('#/') })),
      }
      : {
        icon: 'alert-triangle', title: '결과를 불러오지 못했습니다', text: str(err?.message, '알 수 없는 오류가 발생했습니다.'),
        action: button('다시 시도', { kind: 'primary', icon: 'refresh', onClick: () => { showSkeleton(); load(); } }),
      })));
  }

  async function load() {
    try {
      const data = await api.result(runId);
      if (st.disposed) return;
      st.raw = obj(data);
      st.R = normalize(obj(data));
      build();
      // 진행 화면에서 막 넘어왔으면 이전 스크롤 위치가 아니라 결과 맨 위부터 보여 준다
      if (fromLive && !st.pendingSid) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    } catch (err) {
      if (!st.disposed) showError(err);
    }
  }

  // ── 데이터 정리 ──
  function normalize(R) {
    const sources = arr(R.sources).filter((s) => s && typeof s === 'object' && str(s.sid).trim());
    const byId = new Map(sources.map((s) => [str(s.sid).trim(), s]));
    const hasIncludedFlag = sources.some((s) => Object.prototype.hasOwnProperty.call(s, 'included'));
    return {
      ...R,
      meta: obj(R.meta),
      stats: obj(R.stats),
      understanding: obj(R.understanding),
      plan: obj(R.plan),
      syntheses: obj(R.syntheses),
      verification: obj(R.verification),
      reflections: arr(R.reflections).filter((x) => x && typeof x === 'object'),
      trace: arr(R.trace).filter((x) => x && typeof x === 'object'),
      qa: arr(R.qa).filter((x) => x && typeof x === 'object'),
      toc: arr(R.toc).filter((t) => t && str(t.id).trim() && str(t.title).trim()),
      sources, byId, hasIncludedFlag,
      included: hasIncludedFlag ? sources.filter((s) => s.included === true) : sources,
      subqs: arr(obj(R.plan).sub_questions).filter((q) => q && typeof q === 'object' && str(q.id).trim()),
    };
  }

  const hasSid = (sid) => !!st.R && st.R.byId.has(sid);

  // ── 화면 조립 ──
  function build() {
    const R = st.R;
    const topic = str(R.topic).trim() || str(R.prompt).trim() || runId;
    if (!fromLive) document.title = `${truncate(topic, 40)} — ${APP_NAME}`;

    tabButtons = new Map();
    panels = new Map();
    tabsSentinel = h('div', { class: 'result-tabs-sentinel', 'aria-hidden': 'true' });
    const counts = {
      evidence: R.included.length || null,
      verify: arr(R.verification.checks).length || null,
      qa: R.qa.length || null,
    };
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '결과 보기' }, TABS.map((t) => {
      const b = h('button', {
        type: 'button', role: 'tab', id: `rtab-${t.id}`, class: 'tab', 'aria-controls': `rpanel-${t.id}`,
        'aria-selected': 'false', tabindex: '-1', onClick: () => selectTab(t.id, { push: true }),
      }, icon(t.icon, 16), h('span', null, t.label),
      t.id === 'qa'
        ? (qaBadge = h('span', { class: 'badge num', hidden: !counts.qa }, counts.qa ? String(counts.qa) : ''))
        : counts[t.id] ? h('span', { class: 'badge num' }, fmtInt(counts[t.id])) : null);
      tabButtons.set(t.id, b);
      return b;
    }));
    wireTablist(tablist, (btn) => selectTab(btn.id.replace('rtab-', ''), { push: true }));

    const panelEls = TABS.map((t) => {
      const p = h('section', { class: ['result-panel', `panel-${t.id}`], role: 'tabpanel', id: `rpanel-${t.id}`, 'aria-labelledby': `rtab-${t.id}`, tabindex: '-1', hidden: true });
      panels.set(t.id, p);
      return p;
    });

    root.replaceChildren(
      buildHeader(topic),
      tabsSentinel,
      h('div', { class: 'result-tabs' }, tablist),
      h('div', { class: 'result-panels' }, panelEls));
    selectTab(st.tab, { initial: true });
  }

  function selectTab(id, { push = false, initial = false } = {}) {
    const next = TAB_IDS.has(id) ? id : 'report';
    const changed = next !== st.tab;
    st.tab = next;
    if (!st.R || !panels.size) return;
    for (const [tid, b] of tabButtons) {
      const on = tid === next;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.setAttribute('tabindex', on ? '0' : '-1');
    }
    for (const [tid, p] of panels) p.hidden = tid !== next;
    hideTooltip();
    let view = st.views.get(next);
    if (!view) {
      view = buildPanel(next, panels.get(next)) || {};
      st.views.set(next, view);
    }
    if (push) {
      const target = `#/run/${encodeURIComponent(runId)}/${next}`;
      if (location.hash !== target) location.hash = target;
    }
    // 탭 줄 아래로 스크롤해 있었다면 새 탭 내용이 위에서부터 보이게 한다
    if (!initial && changed && tabsSentinel) {
      const y = tabsSentinel.getBoundingClientRect().top + window.scrollY - topbarHeight();
      if (window.scrollY > y) window.scrollTo({ top: y, behavior: 'auto' });
    }
    if (typeof view.onShow === 'function') view.onShow();
  }

  function goEvidence(sid) {
    st.pendingSid = sid;
    if (st.tab === 'evidence') {
      const v = st.views.get('evidence');
      if (v && typeof v.onShow === 'function') v.onShow();
    } else {
      selectTab('evidence', { push: true });
    }
  }

  function buildPanel(id, panel) {
    try {
      if (id === 'report') return buildReport(panel);
      if (id === 'evidence') return buildEvidence(panel);
      if (id === 'verify') return buildVerify(panel);
      if (id === 'process') return buildProcess(panel);
      if (id === 'qa') return buildQa(panel);
    } catch (err) {
      console.error(err);
      panel.replaceChildren(emptyState({ icon: 'alert-triangle', title: '이 탭을 그리지 못했습니다', text: str(err?.message, '데이터 형식이 예상과 다릅니다.') }));
    }
    return {};
  }

  // ───────────────────────── 머리 ─────────────────────────

  function formatInfo(fmt) {
    return arr(cfg().formats).find((f) => f && f.id === fmt) || null;
  }
  function formatLabel(fmt) {
    return FORMAT_SHORT[fmt] || str(formatInfo(fmt)?.label) || fmt.toUpperCase();
  }

  const inflight = new Set();
  let menuBusy = 0;

  // 인쇄용 HTML: openHtml()이 클릭 순간 빈 창을 먼저 열고, 내용은 만든 뒤 써 넣는다(팝업 차단 회피). 한 번 만든 HTML은 다시 쓴다.
  let printHtml = '';
  let printPending = null;
  function preparePrintHtml() {
    if (printHtml) return Promise.resolve(printHtml);
    if (printPending) return printPending;
    printPending = (async () => {
      // 결과물은 백엔드(api.exportFile)로만 만든다. 실패하면 오류가 openHtml까지 올라가 토스트로 보인다.
      const f = obj(await api.exportFile(runId, 'html'));
      const html = typeof f.data === 'string' ? f.data : '';
      printHtml = html;
      return html;
    })().finally(() => { printPending = null; });
    return printPending;
  }

  /** 클릭 처리 함수 안에서 곧바로 부른다(await 전에 openHtml이 창을 연다) */
  function openPrintable(btn) {
    if (btn.classList.contains('is-busy')) return;
    let pending;
    try {
      pending = openHtmlWindow(printHtml || (async () => {
        const html = await preparePrintHtml();
        if (!html) throw new Error('인쇄용 문서를 만들지 못했습니다.');
        return html;
      }), { print: false, filename: 'report.html' });
    } catch (err) {
      toast(str(err?.message, '인쇄용 문서를 열지 못했습니다.'), 'error');
      return;
    }
    setBusy(btn, true, '여는 중…');
    Promise.resolve(pending)
      .catch((err) => { if (!st.disposed) toast(str(err?.message, '인쇄용 문서를 열지 못했습니다.'), 'error'); })
      .finally(() => setBusy(btn, false));
  }

  async function doDownload(fmt, btn, { fromMenu = false } = {}) {
    if (inflight.has(fmt)) return;
    inflight.add(fmt);
    const label = formatLabel(fmt);
    if (fromMenu) { menuBusy += 1; if (menuBusy === 1) setBusy(btn, true, `${label} 준비 중…`); } else setBusy(btn, true, '준비 중…');
    try {
      // PDF는 download()가 인쇄 창을 연다(막히면 HTML 파일로 내려받는다)
      const name = str(await downloadFile(runId, fmt));
      if (st.disposed) return;
      if (fmt === 'pdf') {
        // 팝업이 막혀 HTML로 저장했으면 download()가 이미 안내했다
        if (!/\.html?$/i.test(name)) toast("인쇄 창을 열었습니다. 대상에서 'PDF로 저장'을 선택하세요.", 'info', { duration: 6000 });
      } else toast(name ? `내려받았습니다: ${name}` : '내려받았습니다.', 'success');
    } catch (err) {
      if (st.disposed) return;
      toast(`${label} 파일을 만들지 못했습니다. ${str(err?.message)}`.trim(), 'error', { duration: 6000 });
    } finally {
      inflight.delete(fmt);
      if (fromMenu) { menuBusy = Math.max(0, menuBusy - 1); if (menuBusy === 0) setBusy(btn, false); } else setBusy(btn, false);
    }
  }

  function buildHeader(topic) {
    const R = st.R;
    const m = R.meta;
    const usage = obj(m.usage);
    const counts = obj(m.counts);
    const conf = obj(m.config);
    const collected = num(counts.collected) ?? num(R.stats.total_collected) ?? R.sources.length;
    const included = num(counts.included) ?? num(R.stats.included) ?? R.included.length;
    const yearFrom = num(m.year_from);
    const yearReason = str(m.year_from_reason).trim();
    const metaItems = [
      str(m.model_label).trim() || str(m.model).trim() || null,
      num(m.elapsed_s) !== null ? fmtMinutes(m.elapsed_s) : null,
      h('span', null, '수집 ', h('b', { class: 'num' }, fmtInt(collected)), ' / 채택 ', h('b', { class: 'num' }, fmtInt(included))),
      num(usage.calls) !== null ? h('span', null, 'LLM 호출 ', h('b', { class: 'num' }, fmtInt(usage.calls)), '회') : null,
      num(usage.cost_usd) !== null ? h('span', null, '약 ', h('b', { class: 'num' }, fmtCost(usage.cost_usd))) : null,
      h('span', { title: yearReason || null }, yearFrom !== null ? `검색 기간 ${yearFrom}년 이후` : '검색 기간 제한 없음',
        str(m.year_from_source) === 'agent' ? h('span', { class: 'meta-soft' }, ' (에이전트 판단)') : null),
    ].filter(Boolean);

    const parentId = str(R.parent_id) || str(m.parent_id) || str(snap.parent_id);
    if (parentId) {
      // 다른 컴퓨터에서 가져온 다시 쓰기 실행은 원래 실행이 이 브라우저에 없을 수 있다(목록을 못 불러왔으면 있다고 본다)
      const runs = store.get().runs;
      const parentHere = !Array.isArray(runs) || runs.some((r) => r && str(r.id) === parentId);
      metaItems.push(parentHere
        ? h('a', { class: 'meta-link', href: `#/run/${encodeURIComponent(parentId)}` }, icon('file-text', 14), '원래 결과 보기')
        : h('span', { class: 'meta-soft' }, '원래 결과는 이 브라우저에 없습니다'));
    }
    if (m.finished_early === true || R.finished_early === true) {
      metaItems.push(h('span', { title: '사용자 요청으로 추가 조사를 멈추고 그때까지 모은 근거로 보고서를 썼습니다' },
        icon('file-text', 14), '일찍 마무리함'));
    }
    if (R.budget_hit === true || m.budget_hit === true) {
      const cap = num(R.budget_cap_usd) ?? num(m.budget_cap_usd);
      metaItems.push(h('span', { class: 'meta-warn', title: cap !== null ? `한도 ${fmtCost(cap)}에 닿아 추가 조사를 멈추고 보고서를 썼습니다` : null },
        icon('alert-triangle', 14), '비용 한도 도달'));
    }

    const tags = [
      badge('완료', 'good', 'check'),
      m.sample || snap.sample ? h('span', { class: 'tag' }, '샘플') : null,
      m.demo || snap.demo ? h('span', { class: 'tag' }, '데모') : null,
      R.imported || snap.imported ? h('span', { class: 'tag' }, '가져옴') : null,
      m.rewrite || snap.rewrite ? h('span', { class: 'tag' }, '다시 쓴 보고서') : null,
      str(m.finished_at) ? h('span', { class: 'result-date' }, fmtDateTime(m.finished_at, { withYear: true })) : null,
    ];

    // 실행 때 고른 형식 → 버튼, 나머지 → 메뉴
    const known = arr(cfg().formats).map((f) => str(f?.id)).filter(Boolean);
    const allFormats = known.length ? known : FORMAT_ORDER;
    const chosen = [...new Set([...arr(conf.formats), ...arr(snap.formats)].map((f) => str(f)).filter((f) => f && (allFormats.includes(f) || FORMAT_SHORT[f])))];
    const primary = chosen.length ? chosen.slice(0, 4) : ['md'];
    const dlButtons = primary.map((fmt, i) => {
      const info = formatInfo(fmt);
      const b = button(formatLabel(fmt), { kind: i === 0 ? 'primary' : 'secondary', icon: 'download', title: str(info?.label) || null });
      b.addEventListener('click', () => doDownload(fmt, b));
      return b;
    });
    const moreBtn = button('다른 형식', { kind: 'secondary', iconRight: 'chevron-down', cls: 'btn-more' });
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.addEventListener('click', () => {
      if (moreBtn.classList.contains('is-busy')) return;
      const items = allFormats.map((fmt) => {
        const info = formatInfo(fmt);
        const unavailable = info && info.available === false;
        return {
          label: str(info?.label) || formatLabel(fmt),
          icon: FORMAT_ICON[fmt] || 'download',
          note: unavailable ? (str(info.note) || '인쇄 창에서 PDF로 저장합니다') : (inflight.has(fmt) ? '준비 중…' : `.${fmt}`),
          disabled: inflight.has(fmt),
          onClick: () => doDownload(fmt, moreBtn, { fromMenu: true }),
        };
      });
      items.push({ separator: true });
      items.push({ label: '전체 묶음 (ZIP)', icon: 'download', note: '지금까지 만든 결과물 + result.json', disabled: inflight.has('zip'), onClick: () => doDownload('zip', moreBtn, { fromMenu: true }) });
      menu(moreBtn, items, { placement: 'bottom-start' });
    });

    // 조사 파일(.json): '조사 파일 열기'로 다른 컴퓨터에서도 다시 볼 수 있다
    const runFileBtn = button('조사 파일 저장', {
      kind: 'secondary', icon: 'database', title: "이 사이트의 '조사 파일 열기'로 다른 컴퓨터에서도 결과를 다시 볼 수 있습니다.",
    });
    runFileBtn.addEventListener('click', async () => {
      if (runFileBtn.classList.contains('is-busy')) return;
      setBusy(runFileBtn, true, '저장하는 중…');
      try {
        const res = await api.exportRunFile(runId);
        const name = typeof res === 'string' ? res : obj(res).data !== undefined ? saveFile(res) : str(obj(res).filename);
        if (!st.disposed) toast(name ? `조사 파일을 저장했습니다: ${name}` : '조사 파일을 저장했습니다.', 'success');
      } catch (err) {
        if (!st.disposed) toast(`조사 파일을 저장하지 못했습니다. ${str(err?.message)}`.trim(), 'error', { duration: 6000 });
      } finally {
        setBusy(runFileBtn, false);
      }
    });

    const rewriteBtn = button('보고서 다시 쓰기', { kind: 'ghost', icon: 'edit', title: '같은 근거로 보고서만 다시 씁니다(API 키 필요)' });
    rewriteBtn.addEventListener('click', () => openRewriteDialog({ runId, result: st.raw || R }));

    const md = str(R.report_markdown);
    const copyBtn = button('Markdown 복사', { kind: 'ghost', icon: 'copy', disabled: !md.trim() });
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(md);
      toast(ok ? '보고서 Markdown을 클립보드에 복사했습니다.' : '복사하지 못했습니다. 브라우저 권한을 확인해 주세요.', ok ? 'success' : 'error');
    });
    const rerunBtn = button('같은 설정으로 다시 조사', { kind: 'ghost', icon: 'refresh' });
    rerunBtn.addEventListener('click', () => {
      const pconf = { ...conf };
      const prefill = { prompt: str(R.prompt).trim() || topic, config: pconf };
      // 데모·다시 쓰기는 비용 한도를 강제로 비워 두므로, 그 값을 사용자의 '한도 없음' 선택으로 넘기지 않는다
      const isDemo = !!(m.demo || snap.demo);
      const isRewrite = !!(parentId || m.rewrite || snap.rewrite);
      if (isDemo || isRewrite) delete pconf.max_cost_usd;
      if (isDemo) prefill.demo = true;
      if (isRewrite) prefill.rewrite = true;
      store.set({ prefill });
      navigate('#/');
    });

    return h('header', { class: 'result-head' },
      h('div', { class: 'result-tags' }, tags),
      h('h1', { class: 'result-title' }, topic),
      h('p', { class: 'result-meta' }, metaItems.map((it, i) => [i ? h('span', { class: 'meta-dot', 'aria-hidden': 'true' }, '·') : null, h('span', { class: 'meta-item' }, it)])),
      str(m.note).trim() ? h('div', { class: 'note result-note' }, icon('info', 16), h('span', null, str(m.note))) : null,
      h('div', { class: 'result-actions' },
        h('div', { class: 'result-dl', role: 'group', 'aria-label': '내려받기' }, dlButtons, moreBtn, runFileBtn),
        h('div', { class: 'result-more' }, rewriteBtn, rerunBtn, copyBtn)));
  }

  // ───────────────────────── 탭 1 보고서 ─────────────────────────

  function buildReport(panel) {
    const R = st.R;
    const html = str(R.report_html);
    if (!html.trim()) {
      const md = str(R.report_markdown).trim();
      panel.append(md
        ? h('div', { class: 'report-layout no-toc' }, h('div', { class: 'report-main' },
          h('div', { class: 'note' }, icon('info', 16), h('span', null, '서식이 적용된 본문이 없어 원문(Markdown)을 그대로 보여 줍니다.')),
          h('pre', { class: 'report-plain' }, md)))
        : emptyState({ icon: 'file-text', title: '보고서 본문이 없습니다', text: '이 실행에는 보고서가 저장되지 않았습니다. 근거·과정 탭에서 수집한 자료를 확인할 수 있습니다.' }));
      return {};
    }

    const article = h('article', { class: 'prose report-body', 'aria-label': '보고서 본문' });
    article.append(trustedFragment(html));
    article.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[data-inpage]') : null;
      if (!a) return;
      e.preventDefault();
      const target = article.querySelector(`#${CSS.escape(a.dataset.inpage)}`);
      if (target) target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    });
    addCleanup(attachCitePopovers(article, R.byId, { onOpenEvidence: (sid) => goEvidence(sid) }));

    const toc = R.toc;
    const heads = toc.map((t) => article.querySelector(`#${CSS.escape(str(t.id))}`)).filter(Boolean);
    const linkSets = [];
    let activeId = '';
    const inlineToc = toc.length ? h('details', { class: 'toc-inline' }) : null;

    function jump(id) {
      const target = article.querySelector(`#${CSS.escape(id)}`);
      if (!target) return;
      target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      setActive(id);
      if (inlineToc) inlineToc.open = false;
    }
    function tocList() {
      const links = new Map();
      const list = h('ol', { class: 'toc-list' }, toc.map((t) => {
        const id = str(t.id);
        const lvl = num(t.level) ?? 2;
        const a = h('a', {
          class: ['toc-link', `toc-l${Math.min(Math.max(lvl, 1), 4)}`],
          href: `#/run/${encodeURIComponent(runId)}/report`, dataset: { target: id },
          onClick: (e) => { e.preventDefault(); jump(id); },
        }, str(t.title));
        links.set(id, a);
        return h('li', null, a);
      }));
      linkSets.push(links);
      return list;
    }
    function setActive(id) {
      if (id === activeId) return;
      activeId = id;
      for (const links of linkSets) {
        for (const [lid, a] of links) {
          if (lid === id) a.setAttribute('aria-current', 'location');
          else a.removeAttribute('aria-current');
        }
      }
      // 목차 레일이 길면 현재 항목이 보이게
      const railLink = linkSets[0]?.get(id);
      const rail = railLink?.closest('.toc-rail-scroll');
      if (rail && railLink) {
        const rr = rail.getBoundingClientRect();
        const lr = railLink.getBoundingClientRect();
        if (lr.top < rr.top || lr.bottom > rr.bottom) rail.scrollTop += lr.top - rr.top - rr.height / 3;
      }
    }

    let raf = 0;
    function spy() {
      raf = 0;
      if (panel.hidden || !heads.length) return;
      const line = topbarHeight() + 96;
      let cur = heads[0].id;
      for (const el of heads) {
        if (el.getBoundingClientRect().top <= line) cur = el.id;
        else break;
      }
      // 맨 아래에 닿으면 마지막 절
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = heads[heads.length - 1].id;
      setActive(cur);
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    addCleanup(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    });

    const rail = toc.length ? h('nav', { class: 'toc-rail', 'aria-label': '목차' },
      h('div', { class: 'toc-title' }, '목차'),
      h('div', { class: 'toc-rail-scroll' }, tocList())) : null;
    if (inlineToc) {
      inlineToc.append(
        h('summary', { class: 'toc-summary' }, icon('list', 16), h('span', null, '목차'),
          h('span', { class: 'toc-count num' }, `${toc.length}개 절`), icon('chevron-down', 16, 'toc-caret')),
        h('nav', { 'aria-label': '목차' }, tocList()));
    }

    const printLink = button('인쇄용으로 열기', { kind: 'secondary', size: 'sm', icon: 'external-link', title: '새 창에서 인쇄용 문서를 엽니다' });
    printLink.addEventListener('click', () => openPrintable(printLink));
    const citeCount = article.querySelectorAll('a.cite').length;

    panel.append(h('div', { class: ['report-layout', toc.length ? '' : 'no-toc'] },
      rail,
      h('div', { class: 'report-main' },
        inlineToc,
        h('div', { class: 'report-tools' },
          h('span', { class: 'report-hint' }, icon('info', 14),
            citeCount ? `인용 칩(${fmtInt(citeCount)}개)을 누르거나 가리키면 출처를 볼 수 있습니다.` : '본문에 연결된 인용이 없습니다.'),
          printLink),
        article)));

    return { onShow: () => { requestAnimationFrame(spy); } };
  }

  // ───────────────────────── 탭 2 근거 ─────────────────────────

  function buildEvidence(panel) {
    const R = st.R;
    const stats = R.stats;
    const inc = R.included;
    const all = R.sources;
    const vf = R.verification;

    // 숫자 타일
    const citedCount = num(vf.cited_ids) ?? all.filter((s) => s.cited === true).length;
    panel.append(h('div', { class: 'tiles r-tiles' },
      tile('수집', fmtInt(num(stats.total_collected) ?? num(R.meta.counts?.collected) ?? all.length)),
      tile('채택', fmtInt(num(stats.included) ?? inc.length), '관련성 2 이상'),
      tile('중복 병합', fmtInt(num(stats.duplicates_merged) ?? num(R.meta.counts?.merged))),
      tile('본문 인용', fmtInt(citedCount), '보고서에서 인용한 문헌')));

    // 차트 (채택 문헌 기준; stats가 없으면 문헌 목록에서 계산)
    const basis = `채택 ${fmtInt(inc.length || num(stats.included))}건 기준`;
    const byStudy = nonEmpty(stats.by_study_type) || countBy(inc, (s) => str(s.study_type).trim());
    const byKind = nonEmpty(stats.by_kind) || countBy(inc, (s) => str(s.kind).trim());
    const byDir = nonEmpty(stats.by_direction) || countBy(inc, (s) => str(s.direction).trim());
    const byYear = nonEmpty(stats.by_year) || countBy(inc.filter((s) => num(s.year) !== null), (s) => String(s.year));

    const studyItems = Object.entries(byStudy).map(([k, v]) => ({ label: k ? studyTypeLabel(k) : '미분류', value: num(v) ?? 0 }));
    const kindItems = Object.entries(byKind).map(([k, v]) => ({ label: KIND_LABEL[k] || k || '미분류', value: num(v) ?? 0 }));
    const dirItems = DIRECTION_SERIES.map((d) => ({ label: d.label, value: num(byDir[d.key]) ?? 0, color: d.color }));
    const known = new Set(DIRECTION_SERIES.map((d) => d.key));
    let na = 0;
    let unk = 0;
    for (const [k, v] of Object.entries(byDir)) {
      if (known.has(k)) continue;
      if (k === 'not applicable') na += num(v) ?? 0;
      else unk += num(v) ?? 0;
    }
    if (na || unk) dirItems.push({ label: na && unk ? '해당 없음·미분류' : na ? '해당 없음' : '미분류', value: na + unk, color: 'var(--chart-none)' });

    const yearKeys = Object.keys(byYear).map((k) => Number(k)).filter((y) => Number.isInteger(y) && y > 1000 && y < 3000).sort((a, b) => a - b);
    const yearItems = [];
    if (yearKeys.length) {
      const span = yearKeys[yearKeys.length - 1] - yearKeys[0];
      const years = span <= 40 ? Array.from({ length: span + 1 }, (_, i) => yearKeys[0] + i) : yearKeys;
      for (const y of years) yearItems.push({ label: String(y), value: num(byYear[String(y)]) ?? 0 });
    }
    const unknownYear = Object.entries(byYear).filter(([k]) => !/^\d{4}$/.test(k)).reduce((s, [, v]) => s + (num(v) ?? 0), 0);
    if (unknownYear) yearItems.push({ label: '미상', value: unknownYear });

    panel.append(h('div', { class: 'chart-grid' },
      h('div', { class: 'card chart-card' }, rankedBars(studyItems, { title: '연구 유형', subtitle: basis })),
      h('div', { class: 'card chart-card' }, segmentedBar(dirItems, { title: '결과 방향', subtitle: basis })),
      h('div', { class: 'card chart-card' }, columnBars(yearItems, { title: '출판 연도', subtitle: basis })),
      h('div', { class: 'card chart-card' }, rankedBars(kindItems, { title: '출판 유형', subtitle: basis }))));

    // ── 필터 ──
    const f = { q: '', included: R.hasIncludedFlag, cited: false, kind: '', design: '', dir: '', subq: '' };
    const sort = { key: 'score', dir: 'desc' };
    let selected = null;
    const hay = new Map(all.map((s) => [s, [s.sid, s.title, fmtAuthors(s.authors, 50), s.venue, s.key_finding].map((x) => str(x)).join(' \u0001 ').toLowerCase()]));

    const kinds = [...new Set(all.map((s) => str(s.kind).trim()).filter(Boolean))]
      .sort((a, b) => (Object.keys(KIND_LABEL).indexOf(a) + 99) % 99 - (Object.keys(KIND_LABEL).indexOf(b) + 99) % 99);
    const designCounts = countBy(all, (s) => str(s.study_type).trim());
    const designs = Object.keys(designCounts).filter(Boolean).sort((a, b) => designCounts[b] - designCounts[a]);
    const dirKeys = ['positive', 'negative', 'mixed', 'null', 'not applicable'].filter((k) => all.some((s) => str(s.direction).trim() === k));
    const subqIds = [...new Set([...R.subqs.map((q) => str(q.id)), ...all.flatMap((s) => texts(s.subqs))])].filter((x) => /^Q\d+$/.test(x))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const subqText = new Map(R.subqs.map((q) => [str(q.id), str(q.question)]));

    function selectEl(label, value, options, onChange) {
      const id = uid('ev-sel');
      const sel = h('select', { id, class: 'input ev-select', onChange: (e) => onChange(e.target.value) },
        h('option', { value: '' }, '전체'),
        options.map(([v, l]) => h('option', { value: v }, l)));
      sel.value = value;
      return { el: h('div', { class: 'ev-field' }, h('label', { class: 'ev-field-label', htmlFor: id }, label), sel), sel };
    }
    function toggleEl(label, value, onChange, hint) {
      const b = h('button', {
        type: 'button', role: 'switch', class: 'ev-toggle', 'aria-checked': value ? 'true' : 'false', title: hint || null,
        onClick: () => { const on = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', on ? 'true' : 'false'); onChange(on); },
      }, h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })), h('span', null, label));
      return b;
    }

    const searchInput = h('input', {
      type: 'search', class: 'input ev-search-input', placeholder: '제목·저자·학술지·핵심 결과 검색', 'aria-label': '문헌 검색', autocomplete: 'off',
    });
    let searchTimer = 0;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { f.q = searchInput.value.trim().toLowerCase(); render(); }, 120);
    });
    const incToggle = toggleEl('채택만', f.included, (on) => { f.included = on; render(); }, '관련성 2 이상으로 채택된 문헌만 보기');
    const citedToggle = toggleEl('인용된 것만', f.cited, (on) => { f.cited = on; render(); }, '보고서 본문에서 인용한 문헌만 보기');
    const kindSel = selectEl('출판 유형', f.kind, kinds.map((k) => [k, KIND_LABEL[k] || k]), (v) => { f.kind = v; render(); });
    const designSel = selectEl('연구 설계', f.design, [...designs.map((d) => [d, studyTypeLabel(d)]), ...(designCounts[''] ? [[NONE, '미분류']] : [])], (v) => { f.design = v; render(); });
    const dirSel = selectEl('방향', f.dir, [...dirKeys.map((k) => [k, DIRECTION_LABEL[k] || k]), ...(all.some((s) => !str(s.direction).trim()) ? [[NONE, '미분류']] : [])], (v) => { f.dir = v; render(); });
    const subqSel = selectEl('하위 질문', f.subq, subqIds.map((q) => [q, subqText.get(q) ? `${q} · ${truncate(subqText.get(q), 36)}` : q]), (v) => { f.subq = v; render(); });
    const countEl = h('span', { class: 'ev-count num', role: 'status', 'aria-live': 'polite' });
    const resetBtn = button('필터 초기화', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => resetFilters() });

    function isFiltered() {
      return !!(f.q || f.cited || f.kind || f.design || f.dir || f.subq || f.included !== R.hasIncludedFlag);
    }
    function resetFilters({ keepIncluded = false } = {}) {
      f.q = ''; f.cited = false; f.kind = ''; f.design = ''; f.dir = ''; f.subq = '';
      if (!keepIncluded) f.included = R.hasIncludedFlag;
      searchInput.value = '';
      kindSel.sel.value = ''; designSel.sel.value = ''; dirSel.sel.value = ''; subqSel.sel.value = '';
      incToggle.setAttribute('aria-checked', f.included ? 'true' : 'false');
      citedToggle.setAttribute('aria-checked', 'false');
      render();
    }

    panel.append(h('div', { class: 'ev-filters', role: 'search', 'aria-label': '문헌 필터' },
      h('div', { class: 'ev-filter-top' },
        h('div', { class: 'ev-search' }, icon('search', 16, 'ev-search-icon'), searchInput),
        h('div', { class: 'ev-toggles' }, incToggle, citedToggle)),
      h('div', { class: 'ev-filter-row' }, kindSel.el, designSel.el, dirSel.el, subqSel.el,
        h('div', { class: 'ev-filter-end' }, countEl, resetBtn))));

    // ── 표 ──
    const tbody = h('tbody');
    const sortButtons = new Map();
    function sortHead(key, label, cls) {
      const b = h('button', { type: 'button', class: 'th-sort', onClick: () => {
        if (sort.key === key) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
        else { sort.key = key; sort.dir = 'desc'; }
        render();
      } }, label, h('span', { class: 'th-sort-ic' }));
      const th = h('th', { scope: 'col', class: ['num', cls] }, b);
      sortButtons.set(key, { th, b });
      return th;
    }
    const table = h('table', { class: 'table ev-table' },
      h('caption', { class: 'sr-only' }, '수집 문헌 목록. 행을 선택하면 상세 정보가 표시됩니다.'),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'col-id' }, 'ID'),
        h('th', { scope: 'col', class: 'col-doc' }, '문헌'),
        sortHead('year', '연도', 'col-year'),
        h('th', { scope: 'col', class: 'col-kind' }, '유형'),
        h('th', { scope: 'col', class: 'col-design' }, '설계'),
        h('th', { scope: 'col', class: 'col-dir' }, '방향'),
        sortHead('score', '점수', 'col-score'),
        sortHead('citations', '피인용', 'col-cites'),
        h('th', { scope: 'col', class: 'col-cited' }, h('span', { title: '보고서 본문 인용 여부' }, '인용')))),
      tbody);
    const tableWrap = h('div', { class: 'table-wrap ev-table-wrap' }, table);
    const emptyBox = h('div', { class: 'ev-empty', hidden: true });
    const detail = h('aside', { class: 'card ev-detail', 'aria-label': '문헌 상세', tabindex: '-1' });
    const evMain = h('div', { class: 'ev-main' }, h('div', { class: 'ev-list' }, tableWrap, emptyBox), detail);
    panel.append(evMain);

    const rowCache = new Map();
    function rowFor(s) {
      let tr = rowCache.get(s);
      if (tr) return tr;
      const sid = str(s.sid);
      const score = num(s.score);
      const cites = num(s.citations);
      const year = num(s.year);
      const byline = [fmtAuthors(s.authors, 3), str(s.venue).trim()].filter(Boolean).join(' · ');
      tr = h('tr', {
        tabindex: '0', dataset: { sid }, class: s.included === false ? 'is-excluded' : '',
        onClick: () => select(sid),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(sid); } },
      },
      h('td', { class: 'col-id mono' }, sid),
      h('td', { class: 'col-doc' },
        h('div', { class: 'ev-title' }, h('span', { class: 'ev-sid-inline mono' }, sid), str(s.title, '제목 정보 없음')),
        byline ? h('div', { class: 'ev-byline' }, byline) : null,
        s.included === false ? h('span', { class: 'tag ev-excl' }, '미채택') : null),
      h('td', { class: 'num col-year' }, year === null ? '—' : String(year)),
      h('td', { class: 'col-kind' }, str(s.kind).trim() ? kindBadge(s.kind) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'col-design' }, str(s.study_type).trim() ? studyTypeLabel(s.study_type) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'col-dir' }, directionText(s.direction)),
      h('td', { class: 'num col-score' }, score === null ? '—' : score.toFixed(2)),
      h('td', { class: 'num col-cites' }, cites === null ? '—' : fmtInt(cites)),
      h('td', { class: 'col-cited' }, s.cited === true
        ? h('span', { class: 'ev-cited' }, icon('check', 14), h('span', { class: 'sr-only' }, '인용됨'))
        : h('span', { class: 'muted', 'aria-label': '인용 안 됨' }, '—')));
      rowCache.set(s, tr);
      return tr;
    }

    function matches(s) {
      if (f.included && s.included !== true) return false;
      if (f.cited && s.cited !== true) return false;
      if (f.kind && str(s.kind).trim() !== f.kind) return false;
      if (f.design) {
        const d = str(s.study_type).trim();
        if (f.design === NONE ? d !== '' : d !== f.design) return false;
      }
      if (f.dir) {
        const d = str(s.direction).trim();
        if (f.dir === NONE ? d !== '' : d !== f.dir) return false;
      }
      if (f.subq && !arr(s.subqs).includes(f.subq)) return false;
      if (f.q && !hay.get(s).includes(f.q)) return false;
      return true;
    }
    function sortValue(s) {
      if (sort.key === 'year') return num(s.year);
      if (sort.key === 'citations') return num(s.citations);
      return num(s.score);
    }
    let visible = [];
    function render() {
      visible = all.filter(matches);
      visible.sort((a, b) => {
        const va = sortValue(a);
        const vb = sortValue(b);
        if (va === null && vb === null) return sidNum(a) - sidNum(b);
        if (va === null) return 1;
        if (vb === null) return -1;
        return (sort.dir === 'desc' ? vb - va : va - vb) || sidNum(a) - sidNum(b);
      });
      tbody.replaceChildren(...visible.map(rowFor));
      for (const [key, { th, b }] of sortButtons) {
        const on = key === sort.key;
        if (on) th.setAttribute('aria-sort', sort.dir === 'desc' ? 'descending' : 'ascending');
        else th.removeAttribute('aria-sort');
        b.querySelector('.th-sort-ic').replaceChildren(icon(on ? (sort.dir === 'desc' ? 'arrow-down' : 'arrow-up') : 'chevron-down', 12));
        b.setAttribute('aria-label', `${b.firstChild.textContent} 기준 정렬${on ? (sort.dir === 'desc' ? ' (내림차순)' : ' (오름차순)') : ''}`);
      }
      for (const [s, tr] of rowCache) tr.classList.toggle('is-selected', str(s.sid) === selected);
      countEl.textContent = `${fmtInt(visible.length)}건 표시 · 전체 ${fmtInt(all.length)}건`;
      resetBtn.hidden = !isFiltered();
      const empty = !visible.length;
      tableWrap.hidden = empty;
      emptyBox.hidden = !empty;
      if (empty) {
        emptyBox.replaceChildren(emptyState({
          icon: 'search', title: all.length ? '조건에 맞는 문헌이 없습니다' : '수집된 문헌이 없습니다',
          text: all.length ? '검색어를 줄이거나 필터를 풀어 보세요.' : '이 실행에는 문헌 목록이 저장되지 않았습니다.',
          action: all.length ? button('필터 초기화', { kind: 'secondary', icon: 'refresh', onClick: () => resetFilters() }) : null,
        }));
      }
    }

    const narrowMq = window.matchMedia('(max-width: 1199px)');
    function renderDetail() {
      const s = selected ? R.byId.get(selected) : null;
      if (!s) {
        detail.classList.add('is-empty');
        detail.replaceChildren(h('div', { class: 'ev-detail-empty' },
          h('div', { class: 'empty-icon' }, icon('book', 20)),
          h('div', { class: 'ev-detail-empty-title' }, '문헌을 선택하세요'),
          h('p', { class: 'empty-text' }, '표에서 행을 누르면 초록, 방법, 표본, 핵심 결과와 한계가 여기에 표시됩니다.')));
        return;
      }
      detail.classList.remove('is-empty');
      detail.replaceChildren(sourceDetail(s, { onClose: () => { selected = null; render(); renderDetail(); } }));
    }
    function select(sid, { scrollRow = false } = {}) {
      selected = sid;
      for (const [s, tr] of rowCache) tr.classList.toggle('is-selected', str(s.sid) === sid);
      renderDetail();
      const tr = [...rowCache.entries()].find(([s]) => str(s.sid) === sid)?.[1];
      if (scrollRow && tr && tr.isConnected) tr.scrollIntoView({ block: 'center', behavior: 'auto' });
      if (narrowMq.matches) detail.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    }

    function sourceDetail(s, { onClose }) {
      const sid = str(s.sid);
      const href = safeHref(s.url);
      const doi = safeHref(s.doi);
      const score = num(s.score);
      const rel = num(s.relevance);
      const cred = num(s.credibility);
      const cites = num(s.citations);
      const byline = [fmtAuthors(s.authors, 8), num(s.year) ?? '', str(s.venue).trim()].filter((x) => x !== '' && x !== null).join(' · ');
      const yesNo = (v) => (v === true ? '예' : v === false ? '아니오' : '—');
      const field = (label, value, cls) => (str(value).trim()
        ? h('section', { class: ['ev-sec', cls] }, h('h4', { class: 'ev-sec-title' }, label), h('p', null, str(value))) : null);
      const subqs = texts(s.subqs);
      const queries = texts(s.queries);
      return h('div', { class: 'ev-detail-inner' },
        h('div', { class: 'ev-detail-head' },
          h('div', { class: 'src-badges' },
            h('span', { class: 'badge badge-id' }, sid),
            str(s.kind).trim() ? kindBadge(s.kind) : null,
            str(s.study_type).trim() ? badge(studyTypeLabel(s.study_type)) : null,
            s.included === false ? h('span', { class: 'tag' }, '미채택') : null),
          button('상세 닫기', { kind: 'ghost', size: 'sm', icon: 'x', iconOnly: true, onClick: onClose })),
        h('h3', { class: 'ev-detail-title' }, str(s.title, '제목 정보 없음')),
        byline ? h('p', { class: 'ev-detail-byline' }, byline) : null,
        href || (doi && doi !== href) ? h('div', { class: 'ev-links' },
          href ? h('a', { class: 'btn btn-secondary btn-sm', href, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link', 14), h('span', { class: 'btn-label' }, '원문 열기')) : null,
          doi && doi !== href ? h('a', { class: 'btn btn-ghost btn-sm', href: doi, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link', 14), h('span', { class: 'btn-label' }, 'DOI')) : null) : null,
        h('dl', { class: 'ev-facts' },
          h('div', null, h('dt', null, '방향'), h('dd', null, directionText(s.direction))),
          h('div', null, h('dt', null, '점수'), h('dd', { class: 'num' }, score === null ? '—' : score.toFixed(2))),
          h('div', null, h('dt', null, '관련성'), h('dd', { class: 'num' }, rel === null ? '—' : `${rel} / 3`)),
          h('div', null, h('dt', null, '신뢰도'), h('dd', { class: 'num' }, cred === null ? '—' : cred.toFixed(2))),
          h('div', null, h('dt', null, '피인용'), h('dd', { class: 'num' }, cites === null ? '—' : fmtInt(cites))),
          h('div', null, h('dt', null, '출처'), h('dd', null, str(s.origin).trim() || '—')),
          h('div', null, h('dt', null, '채택'), h('dd', null, yesNo(s.included))),
          h('div', null, h('dt', null, '본문 인용'), h('dd', null, yesNo(s.cited)))),
        str(s.key_finding).trim() ? h('section', { class: 'ev-sec ev-finding' }, h('h4', { class: 'ev-sec-title' }, '핵심 결과'), h('p', null, str(s.key_finding))) : null,
        field('초록', s.abstract, 'ev-abstract'),
        field('방법', s.method),
        field('표본', s.sample),
        field('한계', s.limitation),
        subqs.length ? h('section', { class: 'ev-sec' }, h('h4', { class: 'ev-sec-title' }, '관련 하위 질문'),
          h('ul', { class: 'ev-subqs' }, subqs.map((q) => h('li', null, h('span', { class: 'badge badge-id' }, q),
            h('span', null, subqText.get(q) ? truncate(subqText.get(q), 140) : ''))))) : null,
        queries.length ? h('section', { class: 'ev-sec' }, h('h4', { class: 'ev-sec-title' }, '찾은 검색어'),
          h('ul', { class: 'ev-queries' }, queries.map((q) => h('li', { class: 'mono' }, q)))) : null);
    }

    render();
    renderDetail();

    return {
      onShow: () => {
        const sid = st.pendingSid;
        st.pendingSid = null;
        if (!sid) return;
        const s = R.byId.get(sid);
        if (!s) { toast(`${sid} 문헌을 목록에서 찾을 수 없습니다.`, 'error'); return; }
        if (!matches(s)) {
          resetFilters({ keepIncluded: true });
          if (!matches(s)) { f.included = false; incToggle.setAttribute('aria-checked', 'false'); render(); }
        }
        requestAnimationFrame(() => select(sid, { scrollRow: true }));
      },
    };
  }

  // ───────────────────────── 탭 3 검증 ─────────────────────────

  function buildVerify(panel) {
    const R = st.R;
    const v = R.verification;
    const checks = arr(v.checks).filter((c) => c && typeof c === 'object');
    if (!checks.length && num(v.cited_ids) === null && num(v.claims_total) === null) {
      panel.append(emptyState({ icon: 'shield-check', title: '인용 검증 기록이 없습니다', text: '이 실행에는 인용 검증 결과가 저장되지 않았습니다. 보고서 탭의 인용 칩으로 출처를 직접 확인할 수 있습니다.' }));
      return {};
    }
    const unknown = arr(v.unknown_ids);
    const isRevised = (c) => !!str(c.revised).trim() || !!str(c.verdict_after).trim();
    const after = (c) => (isRevised(c) && str(c.verdict_after).trim() ? str(c.verdict_after).trim() : str(c.verdict).trim());
    const before = (c) => str(c.verdict).trim();
    const tally = (fn) => countBy(checks, fn);
    const tb = tally(before);
    const ta = tally(after);
    const revisedCount = checks.filter(isRevised).length;

    panel.append(h('div', { class: 'tiles r-tiles' },
      tile('인용 ID', fmtInt(v.cited_ids), '본문에 쓰인 서로 다른 출처 ID'),
      tile('인용 문장', fmtInt(v.claims_total), '인용이 달린 문장 수'),
      tile('검증 문장', fmtInt(checks.length), '초록과 대조한 표본'),
      tile('제거된 미존재 ID', fmtInt(unknown.length), unknown.length ? texts(unknown).slice(0, 6).join(', ') : '문헌 목록에 없는 ID')));

    // 판정 집계 수정 전 → 수정 후 (같은 축의 두 막대)
    const cats = VERDICT_SERIES.filter((c) => c.key !== 'not checked' || tb['not checked'] || ta['not checked']);
    const extraKeys = [...new Set([...Object.keys(tb), ...Object.keys(ta)])].filter((k) => !VERDICT_SERIES.some((c) => c.key === k));
    for (const k of extraKeys) cats.push({ key: k, label: k || '미확인', color: 'var(--neutral)', icon: 'minus' });
    const supB = tb.supported || 0;
    const supA = ta.supported || 0;
    panel.append(sectionCard('판정 집계', { aside: '수정 전 → 수정 후' },
      h('p', { class: 'vf-lead' },
        `표본 ${fmtInt(checks.length)}문장 중 완전 지지 `, h('b', { class: 'num' }, fmtInt(supB)), '문장',
        revisedCount ? [' → 수정·재검증 후 ', h('b', { class: 'num' }, fmtInt(supA)), '문장'] : null,
        revisedCount ? ` (수정 ${fmtInt(revisedCount)}문장)` : ''),
      segmentedRows([
        { name: '수정 전', values: tb },
        { name: '수정 후', values: ta },
      ], cats, { title: '인용 검증 판정', total: checks.length, unit: '문장' })));

    // 문장 카드
    let mode = 'all';
    const list = h('ol', { class: 'claim-list' });
    const notSupported = checks.filter((c) => before(c) !== 'supported').length;
    const segBtns = [
      ['all', `전체 ${checks.length}`],
      ['revised', `수정된 문장 ${revisedCount}`],
      ['issue', `처음 판정이 지지가 아닌 문장 ${notSupported}`],
    ].map(([k, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': k === mode ? 'true' : 'false',
      onClick: () => { mode = k; segBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === mode ? 'true' : 'false')); renderList(); },
      dataset: { k },
    }, label));

    function claimCard(c, i) {
      const rev = isRevised(c);
      return h('li', { class: ['claim', rev ? 'is-revised' : ''] },
        h('div', { class: 'claim-head' },
          h('span', { class: 'claim-no num' }, `#${i + 1}`),
          verdictBadge(before(c)),
          rev ? [icon('arrow-right', 14, 'claim-arrow'), h('span', { class: 'claim-after-label' }, '재검증'), verdictBadge(after(c))] : null),
        h('p', { class: ['claim-text', rev ? 'is-old' : ''] }, rev ? h('span', { class: 'claim-label' }, '원래 문장') : null, citeNodes(c.claim, hasSid)),
        str(c.note).trim() ? h('p', { class: 'claim-note' }, h('span', { class: 'claim-label' }, '검증 메모'), str(c.note)) : null,
        rev && str(c.revised).trim() ? h('div', { class: 'claim-revised' },
          h('p', { class: 'claim-text' }, h('span', { class: 'claim-label' }, '수정한 문장'), citeNodes(c.revised, hasSid)),
          str(c.note_after).trim() ? h('p', { class: 'claim-note' }, h('span', { class: 'claim-label' }, '재검증 메모'), str(c.note_after)) : null) : null);
    }
    function renderList() {
      const items = checks.map((c, i) => [c, i]).filter(([c]) => (mode === 'revised' ? isRevised(c) : mode === 'issue' ? before(c) !== 'supported' : true));
      list.replaceChildren(...(items.length
        ? items.map(([c, i]) => claimCard(c, i))
        : [h('li', { class: 'claim-empty' }, '해당하는 문장이 없습니다.')]));
    }
    renderList();

    panel.append(sectionCard('검증한 문장', { aside: `${fmtInt(checks.length)}문장`, cls: 'claims-card' },
      h('div', { class: 'note vf-sample' }, icon('info', 16),
        h('span', null, `이 검증은 인용 문장 ${num(v.claims_total) !== null ? `${fmtInt(v.claims_total)}개 중 ` : ''}${fmtInt(checks.length)}개를 골라 초록과 대조한 표본 검사이며, 모든 문장을 확인한 전수 감사가 아닙니다.`)),
      checks.length ? h('div', { class: 'seg vf-filter', role: 'group', 'aria-label': '문장 필터' }, segBtns) : null,
      checks.length ? list : h('p', { class: 'muted' }, '표본으로 검사한 문장이 없습니다.')));

    addCleanup(attachCitePopovers(panel, R.byId, { onOpenEvidence: (sid) => goEvidence(sid) }));
    return {};
  }

  // ───────────────────────── 탭 4 과정 ─────────────────────────

  function buildProcess(panel) {
    const R = st.R;
    const u = R.understanding;
    const m = R.meta;
    const toolLabel = (name) => str(arr(cfg().tools).find((t) => t && t.name === name)?.label) || TOOL_FALLBACK[name] || str(name).replace(/^search_/, '');

    // ① 주제 이해
    const kv = [];
    const addKv = (label, value) => { if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) kv.push([label, value]); };
    addKv('핵심 주제', str(u.core_topic).trim());
    addKv('영문 주제', str(u.topic_en).trim());
    addKv('분야', str(u.discipline).trim());
    addKv('연구 유형', str(u.research_type).trim());
    const concepts = arr(u.key_concepts).filter((c) => (typeof c === 'string' ? c.trim() && !/^…/.test(c.trim()) : c && typeof c === 'object'));
    if (concepts.length) {
      addKv('핵심 개념', h('ul', { class: 'concepts' }, concepts.map((c) => {
        if (typeof c === 'string') return h('li', { class: 'concept' }, h('span', { class: 'concept-term' }, c));
        const syn = texts(c.synonyms);
        return h('li', { class: 'concept' },
          h('span', { class: 'concept-term' }, str(c.term)),
          str(c.english).trim() ? h('span', { class: 'concept-en' }, str(c.english)) : null,
          syn.length ? h('span', { class: 'concept-syn' }, syn.map((x) => h('span', { class: 'tag' }, x))) : null);
      })));
    }
    addKv('독립변수', bulletList(texts(u.independent_variables)));
    addKv('종속변수', bulletList(texts(u.dependent_variables)));
    addKv('조절·맥락 변수', bulletList(texts(u.moderators_or_context)));
    addKv('모집단', str(u.population).trim());
    addKv('모호성', bulletList(texts(u.ambiguities)));
    addKv('범위 결정', str(u.scope_decision).trim());
    const yf = num(m.year_from) ?? num(u.search_start_year);
    const yReason = str(m.year_from_reason).trim() || str(u.search_window_reason).trim();
    addKv('검색 기간', h('div', null,
      h('div', { class: 'kv-strong' }, yf !== null ? `${yf}년 이후` : '제한 없음',
        str(m.year_from_source) ? h('span', { class: 'meta-soft' }, str(m.year_from_source) === 'user' ? ' · 사용자 지정' : ' · 에이전트 판단') : null),
      yReason ? h('p', { class: 'kv-sub' }, yReason) : null));
    addKv('사용자 요구', bulletList(texts(u.user_requirements)));
    const disabled = texts(m.disabled_tools);
    addKv('사용하지 못한 도구', disabled.length ? h('div', { class: 'chip-row' }, disabled.map((t) => h('span', { class: 'db-chip' }, toolLabel(t)))) : null);

    panel.append(sectionCard('주제 이해', { step: '1' },
      kv.length
        ? h('dl', { class: 'kv' }, kv.map(([k, val]) => h('div', { class: 'kv-row' }, h('dt', null, k), h('dd', null, val))))
        : h('p', { class: 'muted' }, '주제 이해 단계의 기록이 없습니다.')));

    // ② 조사 계획
    const perSubq = obj(R.stats.per_subq);
    const added = new Set();
    for (const t of R.trace) {
      if (str(t.kind) !== 'replan') continue;
      const mm = str(t.msg).match(/(Q\d+)\s*:/);
      if (mm) added.add(mm[1]);
    }
    const planItems = R.subqs.map((q) => planItem(q));
    const inc = texts(R.plan.inclusion_criteria);
    const suc = texts(R.plan.success_criteria);
    const expandAll = button('모두 펼치기', { kind: 'ghost', size: 'sm', icon: 'chevron-down' });
    expandAll.addEventListener('click', () => {
      const open = !planItems.every((d) => d.open);
      planItems.forEach((d) => { d.open = open; });
      expandAll.querySelector('.btn-label').textContent = open ? '모두 접기' : '모두 펼치기';
    });

    function planItem(q) {
      const id = str(q.id);
      const syn = obj(R.syntheses[id]);
      const n = num(perSubq[id]);
      const queries = texts(q.search_queries);
      const tools = texts(q.preferred_tools);
      const findings = arr(syn.key_findings).filter((x) => x && typeof x === 'object' && str(x.finding).trim());
      const group = (title, items) => (items.length ? h('div', { class: 'pq-group' }, h('h4', { class: 'pq-group-title' }, title),
        h('ul', { class: 'r-bullets' }, items.map((t) => h('li', null, citeNodes(t, hasSid))))) : null);
      return h('details', { class: 'pq' },
        h('summary', { class: 'pq-sum' },
          h('span', { class: 'badge badge-id' }, id),
          h('span', { class: 'pq-main' },
            h('span', { class: 'pq-q' }, str(q.question, '질문 내용 없음')),
            h('span', { class: 'pq-meta' },
              str(q.perspective).trim() ? h('span', null, str(q.perspective)) : null,
              n !== null ? h('span', { class: 'num' }, `채택 ${fmtInt(n)}건`) : null,
              added.has(id) ? h('span', { class: 'tag tag-accent' }, '재계획으로 추가') : null)),
          h('span', { class: 'pq-side' }, str(syn.evidence_strength).trim() ? strengthBadge(syn.evidence_strength) : h('span', { class: 'muted pq-nosyn' }, '종합 없음'),
            icon('chevron-down', 16, 'pq-caret'))),
        h('div', { class: 'pq-body' },
          str(q.rationale).trim() ? h('p', { class: 'pq-rationale' }, h('span', { class: 'claim-label' }, '이유'), str(q.rationale)) : null,
          queries.length || tools.length ? h('div', { class: 'pq-search' },
            tools.length ? h('div', { class: 'chip-row' }, tools.map((t) => h('span', { class: 'db-chip' }, toolLabel(t)))) : null,
            queries.length ? h('ul', { class: 'pq-queries' }, queries.map((x) => h('li', { class: 'mono' }, x))) : null) : null,
          str(syn.answer).trim() ? h('div', { class: 'pq-group' }, h('h4', { class: 'pq-group-title' }, '종합 답변'), h('p', { class: 'pq-answer' }, citeNodes(syn.answer, hasSid))) : null,
          findings.length ? h('div', { class: 'pq-group' }, h('h4', { class: 'pq-group-title' }, '핵심 발견'),
            h('ol', { class: 'pq-findings' }, findings.map((x) => {
              const srcs = texts(x.sources).filter((s) => !str(x.finding).includes(s));
              return h('li', null, citeNodes(x.finding, hasSid),
                srcs.length ? h('span', { class: 'pq-srcs' }, ' ', srcs.map((s) => (hasSid(s) ? citeChip(s) : h('span', { class: 'mono' }, s)))) : null);
            }))) : null,
          group('합의', texts(syn.consensus)),
          group('충돌', texts(syn.disagreements)),
          group('연구 공백', texts(syn.gaps)),
          !Object.keys(syn).length ? h('p', { class: 'muted' }, '이 하위 질문의 종합 결과가 없습니다.') : null));
    }

    panel.append(sectionCard('조사 계획', { step: '2', aside: `하위 질문 ${R.subqs.length}개`, actions: planItems.length ? expandAll : null },
      inc.length || suc.length ? h('details', { class: 'criteria' },
        h('summary', null, icon('chevron-right', 14, 'criteria-caret'), '선정 기준과 성공 기준'),
        h('div', { class: 'criteria-grid' },
          inc.length ? h('div', null, h('h4', { class: 'pq-group-title' }, '선정 기준'), bulletList(inc)) : null,
          suc.length ? h('div', null, h('h4', { class: 'pq-group-title' }, '성공 기준'), bulletList(suc)) : null)) : null,
      planItems.length ? h('div', { class: 'pq-list' }, planItems) : h('p', { class: 'muted' }, '조사 계획 기록이 없습니다.')));

    // ⑥ 자기 비판
    const refl = R.reflections;
    panel.append(sectionCard('자기 비판', { step: '6', aside: refl.length ? `${refl.length}라운드` : '' },
      refl.length ? h('div', { class: 'refl-list' }, refl.map((r) => reflectionRound(r))) : h('p', { class: 'muted' }, '자기 비판 기록이 없습니다.')));

    function reflectionRound(r) {
      const assess = arr(r.subq_assessment).filter((a) => a && typeof a === 'object' && str(a.id).trim());
      const follow = arr(r.followup_queries).filter((x) => x && typeof x === 'object' && str(x.query).trim());
      const newQs = arr(r.new_sub_questions).filter((x) => x && typeof x === 'object' && str(x.question).trim());
      return h('div', { class: 'refl-round' },
        reflectionCard(r),
        assess.length || follow.length || newQs.length ? h('div', { class: 'refl-extra' },
          assess.length ? h('div', { class: 'refl-block' }, h('h4', { class: 'pq-group-title' }, '하위 질문별 평가'),
            h('ul', { class: 'refl-assess' }, assess.map((a) => {
              const cov = str(a.coverage).trim();
              return h('li', null, h('span', { class: 'badge badge-id' }, str(a.id)),
                cov ? h('span', { class: ['tag', `cov-${cov}`] }, COVERAGE_LABEL[cov] || cov) : null,
                h('span', { class: 'refl-issue' }, str(a.issue)));
            }))) : null,
          follow.length ? h('div', { class: 'refl-block' }, h('h4', { class: 'pq-group-title' }, `추가 검색 ${follow.length}건`),
            h('ul', { class: 'refl-follow' }, follow.map((x) => h('li', null,
              str(x.subq_id).trim() ? h('span', { class: 'badge badge-id' }, str(x.subq_id)) : null,
              str(x.tool).trim() ? h('span', { class: 'db-chip' }, toolLabel(x.tool)) : null,
              h('span', { class: 'mono refl-query' }, str(x.query)))))) : null,
          newQs.length ? h('div', { class: 'refl-block' }, h('h4', { class: 'pq-group-title' }, `새 하위 질문 ${newQs.length}개`),
            h('ul', { class: 'r-bullets' }, newQs.map((x) => h('li', null, h('span', { class: 'refl-newq' }, str(x.question)),
              str(x.perspective).trim() ? h('span', { class: 'meta-soft' }, ` · ${str(x.perspective)}`) : null)))) : null) : null);
    }

    // 수행 기록
    const conf = cfg();
    const feed = h('ol', { class: 'feed trace-feed' }, R.trace.map((ev) => eventRow(ev, conf)));
    const fullBox = h('div', { class: 'events-full', hidden: true });
    const allBtn = button('전체 이벤트 보기', { kind: 'secondary', size: 'sm', icon: 'list' });
    let fullLoaded = null;
    let showingFull = false;
    allBtn.addEventListener('click', async () => {
      if (showingFull) {
        showingFull = false;
        fullBox.hidden = true;
        feed.hidden = false;
        allBtn.querySelector('.btn-label').textContent = '전체 이벤트 보기';
        return;
      }
      if (!fullLoaded) {
        setBusy(allBtn, true, '불러오는 중…');
        try {
          fullLoaded = await loadAllEvents();
        } catch (err) {
          setBusy(allBtn, false);
          if (st.disposed) return;
          fullBox.hidden = false;
          fullBox.replaceChildren(h('div', { class: 'note' }, icon('alert-triangle', 16), h('span', null, `이벤트를 불러오지 못했습니다. ${str(err?.message)}`)));
          return;
        }
        setBusy(allBtn, false);
        if (st.disposed) return;
        fullBox.replaceChildren(
          h('p', { class: 'events-count' }, `이벤트 ${fmtInt(fullLoaded.length)}건 (오래된 순)`),
          fullLoaded.length
            ? h('ol', { class: 'feed events-scroll', tabindex: '0', 'aria-label': '전체 이벤트' }, fullLoaded.map((ev) => eventRow(ev, conf)))
            : h('p', { class: 'muted' }, '기록된 이벤트가 없습니다.'));
      }
      showingFull = true;
      fullBox.hidden = false;
      feed.hidden = true;
      allBtn.querySelector('.btn-label').textContent = '요약 기록으로 돌아가기';
    });

    panel.append(sectionCard('수행 기록', { aside: `요약 ${fmtInt(R.trace.length)}건`, actions: allBtn },
      R.trace.length ? feed : h('p', { class: 'muted', id: uid('trace-empty') }, '요약 기록이 없습니다. 전체 이벤트를 불러와 확인할 수 있습니다.'),
      fullBox));
    addCleanup(attachCitePopovers(panel, R.byId, { onOpenEvidence: (sid) => goEvidence(sid) }));
    return {};
  }

  async function loadAllEvents() {
    const seen = new Map();
    let after = 0;
    for (let i = 0; i < 200; i += 1) {
      const res = obj(await api.events(runId, after, 0));
      const evs = arr(res.events).filter((e) => e && typeof e === 'object');
      if (!evs.length) break;
      let maxSeq = after;
      for (const e of evs) {
        const seq = num(e.seq);
        if (seq !== null) { seen.set(seq, e); maxSeq = Math.max(maxSeq, seq); } else seen.set(`x${seen.size}`, e);
      }
      const next = Math.max(num(res.next) ?? 0, maxSeq);
      if (next <= after) break;
      after = next;
    }
    return [...seen.values()].sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
  }

  // ───────────────────────── 탭 5 질문하기 ─────────────────────────

  function buildQa(panel) {
    const R = st.R;
    // 데모는 실행마다 정해진다: 데모 실행은 키 없이 근거 검색으로 답한다(키가 있으면 실제 모델)
    const isDemoRun = !!(R.meta.demo || snap.demo);
    const needsKey = () => !isDemoRun && !getApiKey();
    let pending = false;
    let lastQuestion = '';

    const list = h('ol', { class: 'qa-list', 'aria-label': '질문과 답변' });
    const liveEl = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const emptyEl = h('li', { class: 'qa-empty' },
      h('div', { class: 'empty-icon' }, icon('message', 20)),
      h('div', { class: 'qa-empty-title' }, '이 조사의 근거에 대해 물어보세요'),
      h('p', { class: 'empty-text' }, '답변은 채택한 문헌과 보고서 내용만을 바탕으로 하며, 근거가 부족하면 부족하다고 답합니다.'));

    function sourcesList(ids) {
      const valid = texts(ids);
      if (!valid.length) return null;
      return h('div', { class: 'qa-sources' },
        h('div', { class: 'qa-sources-title' }, `답변 근거 ${valid.length}건`),
        h('ul', null, valid.map((sid) => {
          const s = R.byId.get(sid);
          if (!s) return h('li', null, h('span', { class: 'badge badge-id' }, sid));
          const by = [fmtAuthors(s.authors, 2), num(s.year) ?? ''].filter((x) => x !== '').join(', ');
          return h('li', null, h('button', {
            type: 'button', class: 'qa-src', onClick: () => goEvidence(sid), title: '근거 탭에서 보기',
          }, h('span', { class: 'badge badge-id' }, sid), h('span', { class: 'qa-src-title' }, str(s.title, '제목 정보 없음')),
          by ? h('span', { class: 'qa-src-by' }, by) : null, icon('chevron-right', 14, 'qa-src-go')));
        })));
    }

    function questionBlock(q) {
      return h('div', { class: 'qa-q' }, h('span', { class: 'qa-who' }, '질문'), h('p', { class: 'qa-q-text' }, q));
    }

    function qaItem(item) {
      const answerHtml = str(item.answer_html);
      const answer = h('div', { class: 'prose qa-answer' });
      if (answerHtml.trim()) answer.append(trustedFragment(answerHtml));
      else if (str(item.answer_markdown).trim()) answer.append(h('p', { class: 'qa-plain' }, citeNodes(item.answer_markdown, hasSid)));
      else answer.append(h('p', { class: 'muted' }, '답변 내용이 없습니다.'));
      return h('li', { class: 'qa-item' },
        questionBlock(str(item.question, '(질문 없음)')),
        h('div', { class: 'qa-a' },
          h('div', { class: 'qa-a-head' }, h('span', { class: 'qa-who' }, '답변'),
            str(item.ts) ? h('span', { class: 'qa-time' }, fmtDateTime(item.ts)) : null),
          answer,
          sourcesList(item.sources)));
    }

    function pendingItem(q) {
      return h('li', { class: 'qa-item is-pending', 'aria-busy': 'true' },
        questionBlock(q),
        h('div', { class: 'qa-a' },
          h('div', { class: 'qa-a-head' }, h('span', { class: 'qa-who' }, '답변')),
          h('div', { class: 'qa-wait' }, spinner(14), h('span', null, '근거를 찾아 답을 쓰는 중입니다…')),
          skeleton(3)));
    }

    function errorItem(q, err) {
      const code = str(err?.code);
      const keyIssue = code === 'no_api_key' || code === 'auth' || code === 'invalid_api_key' || err?.status === 401;
      return h('li', { class: 'qa-item is-error' },
        questionBlock(q),
        h('div', { class: 'qa-a qa-error', role: 'alert' },
          h('div', { class: 'qa-error-msg' }, icon('alert-triangle', 16),
            h('span', null, str(err?.message, '답변을 받지 못했습니다.'))),
          h('div', { class: 'qa-error-actions' },
            keyIssue ? button('API 키 입력', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => openKeyDialog() }) : null,
            button('다시 묻기', { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: (e) => { e.currentTarget.closest('.qa-item')?.remove(); syncEmpty(); send(q); } }))));
    }

    function syncEmpty() {
      const hasItems = !!list.querySelector('.qa-item');
      if (hasItems) emptyEl.remove();
      else if (!emptyEl.isConnected) list.prepend(emptyEl);
    }

    R.qa.forEach((item) => list.append(qaItem(item)));
    syncEmpty();

    // 추천 질문
    const weak = R.subqs.find((q) => ['weak', 'insufficient'].includes(str(obj(R.syntheses[str(q.id)]).evidence_strength)));
    const suggestions = [
      '가장 확실한 근거로 뒷받침되는 결론은 무엇인가요?',
      '연구 결과가 서로 엇갈리는 지점과 그 이유를 정리해 주세요.',
      weak ? `${str(weak.id)}의 근거가 약한 이유와 이를 보완할 연구 설계는 무엇인가요?` : '이 주제로 후속 연구를 한다면 어떤 설계가 좋을까요?',
    ];
    const suggestRow = h('div', { class: 'qa-suggest' },
      h('span', { class: 'qa-suggest-label' }, '추천 질문'),
      h('div', { class: 'chips' }, suggestions.map((s) => h('button', {
        type: 'button', class: 'chip chip-example', title: s, onClick: () => { input.value = s; autosize(input, 200); send(s); },
      }, h('span', { class: 'chip-text' }, s)))));

    const input = h('textarea', {
      class: 'qa-input', rows: '1', maxlength: '2000', placeholder: '이 조사의 근거에 대해 질문하세요', 'aria-label': '질문 입력',
    });
    const sendBtn = button('보내기', { kind: 'primary', icon: 'send' });
    const keyNote = h('div', { class: 'qa-key-note' });
    function renderKeyNote() {
      if (isDemoRun && !getApiKey()) keyNote.replaceChildren(icon('info', 14), h('span', null, '데모 실행: 키 없이 관련 근거 상위 항목으로 답합니다. 키를 넣으면 실제 모델이 답합니다.'));
      else if (needsKey()) {
        keyNote.replaceChildren(icon('key', 14), h('span', null, '질문하려면 API 키가 필요합니다.'),
          h('button', { type: 'button', class: 'link-btn', onClick: () => openKeyDialog() }, '키 입력'));
      } else keyNote.replaceChildren(icon('info', 14), h('span', null, 'Enter로 보내기 · Shift+Enter로 줄바꿈'));
    }
    renderKeyNote();
    addCleanup(store.subscribe(() => renderKeyNote()));

    input.addEventListener('input', () => autosize(input, 200));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(input.value);
      }
    });
    sendBtn.addEventListener('click', () => send(input.value));

    async function send(text) {
      const q = str(text).trim();
      if (!q) { input.focus(); return; }
      if (pending) return;
      if (needsKey()) {
        toast('질문하려면 API 키를 입력해 주세요.', 'info');
        openKeyDialog();
        return;
      }
      pending = true;
      lastQuestion = q;
      input.value = '';
      autosize(input, 200);
      setBusy(sendBtn, true, '답변 중…');
      suggestRow.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const li = pendingItem(q);
      list.append(li);
      syncEmpty();
      li.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      liveEl.textContent = '답변을 기다리는 중입니다.';
      const body = { question: q };
      const key = getApiKey();
      if (key) body.api_key = key;
      if (str(R.meta.model)) body.model = str(R.meta.model);
      try {
        const res = obj(await api.ask(runId, body));
        if (st.disposed) return;
        const item = {
          question: str(res.question) || q, answer_markdown: str(res.answer_markdown), answer_html: str(res.answer_html),
          sources: arr(res.sources), ts: str(res.ts) || new Date().toISOString(),
        };
        R.qa.push(item);
        const node = qaItem(item);
        li.replaceWith(node);
        // 답변이 도착하면 화면 안으로 가져온다(움직임 줄이기 설정이면 바로)
        requestAnimationFrame(() => { if (!st.disposed && node.isConnected) node.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() }); });
        if (qaBadge) { qaBadge.textContent = String(R.qa.length); qaBadge.hidden = false; }
        liveEl.textContent = '답변을 받았습니다.';
      } catch (err) {
        if (st.disposed) return;
        li.replaceWith(errorItem(q, err));
        liveEl.textContent = '답변을 받지 못했습니다.';
        if (!input.value) { input.value = lastQuestion; autosize(input, 200); }
      } finally {
        pending = false;
        if (!st.disposed) {
          setBusy(sendBtn, false);
          suggestRow.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          input.focus({ preventScroll: true });
        }
      }
    }

    panel.append(h('div', { class: 'qa' },
      h('div', { class: 'qa-intro' },
        h('h2', { class: 'section-title' }, '이 조사에 질문하기'),
        h('p', { class: 'section-aside' }, `채택 문헌 ${fmtInt(R.included.length)}건과 보고서만 근거로 답합니다. 인용 칩으로 출처를 바로 확인할 수 있습니다.`)),
      list, liveEl,
      h('div', { class: 'qa-composer' },
        suggestRow,
        h('div', { class: 'qa-box' }, input, sendBtn),
        keyNote)));

    addCleanup(attachCitePopovers(list, R.byId, { onOpenEvidence: (sid) => goEvidence(sid) }));
    return { onShow: () => { if (!pending) requestAnimationFrame(() => autosize(input, 200)); } };
  }

  // ───────────────────────── 시작 · 해제 ─────────────────────────

  showSkeleton();
  load();

  const unmount = () => {
    st.disposed = true;
    for (const fn of st.cleanups) { try { fn(); } catch (e) { console.error(e); } }
    st.cleanups = [];
    hideTooltip();
  };
  // 같은 실행 안에서 탭만 바뀔 때(main.js → run.js → 여기) 다시 받지 않고 탭만 바꾼다
  unmount.update = ({ tab: t } = {}) => {
    selectTab(TAB_IDS.has(t) ? t : 'report');
    return true;
  };
  return unmount;
}

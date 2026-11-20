// UI 공용 도구: DOM 빌더, 아이콘, 토스트, 모달, 팝오버, 포맷터, 라벨, 출처 카드·인용 칩.
// XSS 규칙: 이 모듈은 innerHTML을 쓰지 않는다. 모든 문자열은 텍스트 노드로 들어간다.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'readOnly', 'multiple']);

let uidSeq = 0;
/** 접두사가 붙은 고유 id */
export function uid(prefix = 'u') {
  uidSeq += 1;
  return `${prefix}-${uidSeq}`;
}

// ───────────────────────── DOM 삽입 보정 ─────────────────────────
// 브라우저의 append · prepend · replaceChildren 등은 null을 "null"이라는 글자로 넣는다.
// 화면 코드가 `조건 ? 요소 : null` 형태로 자식을 넘기므로, 빈 값(null · undefined · false)은 건너뛰게 한 번만 보정한다.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ['append', 'prepend', 'replaceChildren', 'before', 'after', 'replaceWith']) {
    const native = proto[name];
    if (typeof native !== 'function') continue;
    proto[name] = function (...nodes) {
      return native.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
    };
  }
}

// ───────────────────────── DOM 빌더 ─────────────────────────

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

function classValue(v) {
  if (Array.isArray(v)) return v.flat(Infinity).filter(Boolean).join(' ');
  return v ? String(v) : '';
}

/** h('div', {class, dataset, style, onClick, 'aria-label'}, ...children) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'innerHTML' || k === 'outerHTML') continue; // 의도적으로 막는다
      if (k === 'class' || k === 'className') {
        const cv = classValue(v);
        if (cv) el.className = cv;
      } else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
      } else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (PROP_KEYS.has(k)) {
        el[k] = v;
      } else if (k === 'htmlFor') {
        el.setAttribute('for', v);
      } else if (v === false) {
        if (k.startsWith('aria-')) el.setAttribute(k, 'false');
      } else if (v === true) {
        el.setAttribute(k, k.startsWith('aria-') ? 'true' : '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

/** 요소의 자식을 모두 지운다 */
export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

/** 텍스트 안전 문자열 */
export function str(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function arr(v) {
  return Array.isArray(v) ? v : [];
}

export function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ───────────────────────── 아이콘 ─────────────────────────
// 24 격자, stroke=currentColor, 굵기 1.5, 둥근 끝. 문자열 = path d, {c} = 원, {e} = 타원.

const ICONS = {
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18M6 6l12 12'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m18 15-6-6-6 6'],
  'chevron-right': ['m9 18 6-6-6-6'],
  'chevron-left': ['m15 18-6-6 6-6'],
  download: ['M12 3v12M7 10l5 5 5-5M5 21h14'],
  'file-text': ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5M9 13h6M9 17h6'],
  presentation: ['M3 4h18M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4M12 16v4M8 20h8'],
  play: ['M7 4.5v15a.5.5 0 0 0 .8.4l11.4-7.5a.5.5 0 0 0 0-.8L7.8 4.1a.5.5 0 0 0-.8.4z'],
  stop: ['M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z'],
  clock: [{ c: [12, 12, 9] }, 'M12 7v5l3 2'],
  'alert-triangle': ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4M12 17h.01'],
  info: [{ c: [12, 12, 9] }, 'M12 16v-4M12 8h.01'],
  key: [{ c: [8, 15, 4] }, 'M10.8 12.2 20 3M17 6l3 3M14.5 8.5l2 2'],
  sun: [{ c: [12, 12, 4] }, 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  moon: ['M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z'],
  monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8M12 17v4'],
  trash: ['M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6'],
  'external-link': ['M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  copy: ['M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  refresh: ['M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8', 'M21 3v5h-5M3 21v-5h5'],
  search: [{ c: [11, 11, 7] }, 'm20 20-4-4'],
  message: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  list: ['M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'],
  'bar-chart': ['M3 3v18h18', 'M8 16v-4M13 16V8M18 16v-7'],
  'shield-check': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'],
  route: [{ c: [6, 19, 3] }, { c: [18, 5, 3] }, 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15'],
  sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', { c: [12, 12, 3] }],
  'eye-off': ['M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2', 'M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M14.1 14.1a3 3 0 1 1-4.2-4.2', 'M2 2l20 20'],
  'arrow-up': ['M12 19V5M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14M19 12l-7 7-7-7'],
  'arrow-right': ['M5 12h14M12 5l7 7-7 7'],
  'arrow-left': ['M19 12H5M12 19l-7-7 7-7'],
  settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', { c: [12, 12, 3] }],
  'more-horizontal': [{ c: [5, 12, 1 ] }, { c: [12, 12, 1] }, { c: [19, 12, 1] }],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  database: [{ e: [12, 5, 9, 3] }, 'M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5', 'M3 12c0 1.7 4 3 9 3s9-1.3 9-3'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  send: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4z'],
  wave: ['M3 12c1.5-2.5 3-2.5 4.5 0s3 2.5 4.5 0 3-2.5 4.5 0 3 2.5 4.5 0'],
  loader: ['M12 3a9 9 0 1 0 9 9'],
  logo: [{ c: [10.5, 10.5, 5.5] }, 'm15 15 5 5', 'M8 10.5h5'],
  help: [{ c: [12, 12, 9] }, 'M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9M12 17h.01'],
  upload: ['M12 15V3M7 8l5-5 5 5M5 21h14'],
  'folder-open': ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1', 'M3 7v11a2 2 0 0 0 2 2h13l3-8H7l-3 8'],
  wand: ['M15 4V2M15 10V8M11 6H9M21 6h-2M18.2 3.8 17 5M18.2 8.2 17 7', 'M13 9 3 19l2 2L15 11z'],
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  'x-circle': [{ c: [12, 12, 9] }, 'm15 9-6 6M9 9l6 6'],
};

/** icon('check', 16) → <svg> */
export function icon(name, size = 16, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name}${extraClass ? ` ${extraClass}` : ''}`);
  for (const part of ICONS[name] || ICONS.info) {
    let node;
    if (typeof part === 'string') {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', part);
    } else if (part.c) {
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', part.c[0]);
      node.setAttribute('cy', part.c[1]);
      node.setAttribute('r', part.c[2]);
      if (name === 'more-horizontal') node.setAttribute('fill', 'currentColor');
    } else if (part.e) {
      node = document.createElementNS(SVG_NS, 'ellipse');
      node.setAttribute('cx', part.e[0]);
      node.setAttribute('cy', part.e[1]);
      node.setAttribute('rx', part.e[2]);
      node.setAttribute('ry', part.e[3]);
    }
    if (node) svg.append(node);
  }
  return svg;
}

export function spinner(size = 16) {
  return h('span', { class: 'spinner', role: 'presentation', style: { '--sz': `${size}px` } });
}

// ───────────────────────── 버튼 ─────────────────────────

const busyState = new WeakMap();

/** button('저장', {kind: 'primary'|'secondary'|'ghost'|'danger', icon, size: 'sm'|'lg', onClick}) */
export function button(label, opts = {}) {
  const { kind = 'secondary', icon: ic, iconRight, size, onClick, type = 'button', title, disabled, ariaLabel, cls, iconOnly } = opts;
  const classes = ['btn', `btn-${kind}`, size ? `btn-${size}` : '', iconOnly ? 'btn-icon' : '', cls];
  return h('button', {
    type, class: classes, title, disabled: !!disabled,
    'aria-label': ariaLabel || (iconOnly ? label : undefined),
    onClick,
  },
  ic ? icon(ic, size === 'sm' ? 14 : 16) : null,
  iconOnly ? null : h('span', { class: 'btn-label' }, label),
  iconRight ? icon(iconRight, size === 'sm' ? 14 : 16) : null);
}

/** 버튼을 진행 중 상태로 바꾸거나 되돌린다 */
export function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (busyState.has(btn)) return;
    busyState.set(btn, { nodes: [...btn.childNodes], disabled: btn.disabled });
    const label = busyLabel || btn.querySelector('.btn-label')?.textContent || '';
    btn.replaceChildren(spinner(14), label ? h('span', { class: 'btn-label' }, label) : null);
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
  } else {
    const saved = busyState.get(btn);
    if (!saved) return;
    busyState.delete(btn);
    btn.replaceChildren(...saved.nodes);
    btn.disabled = saved.disabled;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
  }
}

// ───────────────────────── 포맷터 ─────────────────────────

const intFmt = new Intl.NumberFormat('ko-KR');

export function fmtInt(n) {
  const v = num(typeof n === 'string' && n.trim() !== '' ? Number(n) : n);
  return v === null ? '—' : intFmt.format(Math.round(v));
}

/** 큰 수를 짧게: 419170 → 419k, 1234567 → 1.23M */
export function fmtCompact(n) {
  const v = num(n);
  if (v === null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fmtCost(usd) {
  const v = num(usd);
  if (v === null) return '—';
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 초 → mm:ss 또는 h:mm:ss */
export function fmtDuration(seconds) {
  const v = num(seconds);
  if (v === null || v < 0) return '—';
  const s = Math.floor(v);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
}

/** 초 → "n분" / "1시간 5분" / "1분 미만" */
export function fmtMinutes(seconds) {
  const v = num(seconds);
  if (v === null || v < 0) return '—';
  if (v < 60) return '1분 미만';
  const m = Math.round(v / 60);
  if (m < 60) return `${m}분`;
  const hh = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hh}시간 ${rest}분` : `${hh}시간`;
}

function parseDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 시각 → "11월 16일 15:30" (올해가 아니면 연도 포함) */
export function fmtDateTime(iso, { withYear } = {}) {
  const d = parseDate(iso);
  if (!d) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withYear || !sameYear ? `${d.getFullYear()}년 ${date} ${time}` : `${date} ${time}`;
}

/** ISO 시각 → "15:31:02" (활동 기록용) */
export function fmtTime(iso) {
  const d = parseDate(iso);
  if (!d) {
    const m = typeof iso === 'string' ? iso.match(/(\d{2}:\d{2}:\d{2})/) : null;
    return m ? m[1] : '';
  }
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function truncate(s, n = 120) {
  const t = str(s);
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}

/** http(s) URL만 돌려준다 */
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : null;
}

/** 저자 목록 → "Kim, Lee, Park 외" */
export function fmtAuthors(authors, max = 3) {
  const list = arr(authors).map((a) => str(a).trim()).filter((a) => a && !/^…/.test(a));
  if (!list.length) return '';
  return list.length > max ? `${list.slice(0, max).join(', ')} 외` : list.join(', ');
}

// ───────────────────────── 라벨 ─────────────────────────
// exporters/theme.py와 같은 한국어 라벨

export const VERDICT_LABEL = {
  supported: '지지', 'partially supported': '부분 지지',
  'not in source text': '초록에 없음', contradicted: '상충', 'not checked': '미확인',
};
export const KIND_LABEL = { 'peer-reviewed': '동료심사', academic: '학술', preprint: '프리프린트', web: '웹' };
export const DIRECTION_LABEL = {
  positive: '긍정', negative: '부정', mixed: '혼재', null: '효과 없음', 'not applicable': '해당 없음', '': '미분류',
};
export const STRENGTH_LABEL = { strong: '강함', moderate: '중간', weak: '약함', insufficient: '불충분' };
// 연구 설계 표시 이름(화면용 보조 사전; 없으면 원문 그대로)
export const STUDY_TYPE_LABEL = {
  'RCT/experiment': 'RCT/실험', 'quasi-experiment': '준실험', longitudinal: '종단 연구',
  'survey/correlational': '설문/상관', 'mixed methods': '혼합 방법', qualitative: '질적 연구',
  'meta-analysis/systematic review': '메타분석/체계적 고찰', 'review/commentary': '리뷰/논평',
  'report/web article': '보고서/웹 문서', 'theoretical/conceptual': '이론/개념', other: '기타',
};
export const STATUS_LABEL = {
  queued: '대기 중', running: '진행 중', awaiting_plan: '검토 대기', done: '완료',
  error: '오류', cancelled: '중단됨', interrupted: '중단됨',
};
export const ACTIVE_STATUSES = new Set(['queued', 'running', 'awaiting_plan']);

const STAGE_FALLBACK = {
  understand: '주제 이해', plan: '조사 계획', act: '문헌 탐색', evaluate: '문헌 평가', synthesize: '근거 종합',
  reflect: '자기 비판', report: '보고서 작성', verify: '인용 검증', export: '결과물 생성', system: '시스템', done: '완료',
};
export const DEFAULT_STAGES = ['understand', 'plan', 'act', 'evaluate', 'synthesize', 'reflect', 'report', 'verify']
  .map((id) => ({ id, label: STAGE_FALLBACK[id], description: '' }));

export function stageLabel(stageId, config) {
  const id = str(stageId);
  const found = arr(config?.stages).find((s) => s && s.id === id);
  return str(found?.label) || STAGE_FALLBACK[id] || id || '—';
}

export function studyTypeLabel(t) {
  const s = str(t).trim();
  return STUDY_TYPE_LABEL[s] || s;
}

// ───────────────────────── 배지 ─────────────────────────

export function badge(text, kind = '', iconName = null, extra = {}) {
  return h('span', { class: ['badge', kind ? `badge-${kind}` : ''], ...extra }, iconName ? icon(iconName, 12) : null, text);
}

const VERDICT_STYLE = {
  supported: ['good', 'check'], 'partially supported': ['warning', 'wave'],
  'not in source text': ['neutral', 'minus'], contradicted: ['critical', 'x'], 'not checked': ['neutral', 'minus'],
};

export function verdictBadge(verdict) {
  const v = str(verdict).trim();
  const [kind, ic] = VERDICT_STYLE[v] || ['neutral', 'minus'];
  return badge(VERDICT_LABEL[v] || v || '미확인', kind, ic, { dataset: { verdict: v } });
}

export function kindBadge(kind) {
  const k = str(kind).trim();
  return badge(KIND_LABEL[k] || k || '유형 미상', '');
}

const STRENGTH_LEVEL = { strong: 3, moderate: 2, weak: 1, insufficient: 0 };

/** 근거 강도: 막대 3칸 + 글자 (상태색을 쓰지 않는다) */
export function strengthBadge(strength) {
  const s = str(strength).trim();
  const level = STRENGTH_LEVEL[s] ?? 0;
  const meter = h('span', { class: 'meter', 'aria-hidden': 'true' },
    [1, 2, 3].map((i) => h('i', { class: i <= level ? 'on' : '' })));
  return h('span', { class: 'badge badge-strength', dataset: { strength: s } }, meter, STRENGTH_LABEL[s] || s || '미평가');
}

const DIRECTION_SYMBOL = { positive: '▲', negative: '▼', mixed: '◆', null: '○', 'not applicable': '–', '': '–' };

export function directionText(direction) {
  const d = str(direction).trim();
  return h('span', { class: 'direction', dataset: { dir: d || 'none' } },
    h('span', { class: 'direction-sym', 'aria-hidden': 'true' }, DIRECTION_SYMBOL[d] ?? '–'),
    DIRECTION_LABEL[d] ?? d);
}

// ───────────────────────── 빈 상태 · 스켈레톤 ─────────────────────────

export function emptyState({ icon: ic = 'info', title, text, action } = {}) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(ic, 20)),
    title ? h('div', { class: 'empty-title' }, title) : null,
    text ? h('p', { class: 'empty-text' }, text) : null,
    action || null);
}

export function skeleton(lines = 3, { block = false } = {}) {
  return h('div', { class: 'skel-group', 'aria-hidden': 'true' },
    block ? h('div', { class: 'skel skel-block' }) : null,
    Array.from({ length: lines }, (_, i) => h('div', { class: 'skel skel-line', style: { width: `${[92, 78, 64, 85, 55][i % 5]}%` } })));
}

// ───────────────────────── 토스트 ─────────────────────────

function toastRoot() {
  let root = document.getElementById('toasts');
  if (!root) {
    root = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(root);
  }
  return root;
}

/** toast(message, 'success'|'error'|'info', {duration, action: {label, onClick}}) */
export function toast(message, kind = 'info', { duration = 4000, action = null } = {}) {
  const ic = kind === 'success' ? 'check' : kind === 'error' ? 'alert-triangle' : 'info';
  // action = {label, onClick}: 토스트 안의 버튼(예: "되돌리기"). 누르면 토스트가 닫힌다.
  const actBtn = action && action.label ? h('button', {
    type: 'button', class: 'toast-action',
    onClick: () => { remove(); if (typeof action.onClick === 'function') action.onClick(); },
  }, str(action.label)) : null;
  const el = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
    icon(ic, 16), h('span', { class: 'toast-msg' }, str(message)), actBtn,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': '알림 닫기', onClick: () => remove() }, icon('x', 14)));
  let timer = 0;
  const remove = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 180);
  };
  const root = toastRoot();
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  timer = setTimeout(remove, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(remove, 1500); });
  return { close: remove };
}

// ───────────────────────── 모달 ─────────────────────────

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** 닫히는 중이 아닌 창 가운데 맨 위(가장 나중에 붙은) 창 */
function topmostRoot() {
  const roots = document.querySelectorAll('.modal-root:not(.is-leaving)');
  return roots.length ? roots[roots.length - 1] : null;
}

/**
 * modal({title, body, actions: [{label, kind, icon, onClick({close, button}), autofocus}], onClose, dismissible})
 * onClick이 없으면 누를 때 닫힌다.
 */
export function modal({ title, body, actions = [], onClose, dismissible = true, size = '' } = {}) {
  const prevFocus = document.activeElement;
  const titleId = uid('modal-title');
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('is-leaving');
    setTimeout(() => {
      root.remove();
      if (!document.querySelector('.modal-root')) document.body.classList.remove('has-modal');
    }, 140);
    restoreFocus();
    if (onClose) onClose(result);
  };

  // 닫힌 뒤 초점: 원래 요소가 살아 있고 닫히는 다른 창 안에 있지 않으면 그쪽으로, 아니면 남은 맨 위 창으로
  function restoreFocus() {
    const leaving = prevFocus && typeof prevFocus.closest === 'function' ? prevFocus.closest('.modal-root.is-leaving') : null;
    if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus) && !leaving) {
      prevFocus.focus();
      return;
    }
    const top = topmostRoot();
    const dlg = top ? top.querySelector('.modal') : null;
    if (dlg) (focusables(dlg)[0] || dlg).focus();
  }

  let autofocusEl = null;
  const buttons = actions.map((a) => {
    const b = button(a.label, { kind: a.kind || 'secondary', icon: a.icon, disabled: a.disabled });
    b.addEventListener('click', () => {
      if (typeof a.onClick === 'function') a.onClick({ close, button: b });
      else close(a.value);
    });
    if (a.autofocus) autofocusEl = b;
    return b;
  });

  const dialog = h('div', { class: ['modal', size ? `modal-${size}` : ''], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'modal-head' },
      h('h2', { class: 'modal-title', id: titleId }, str(title)),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '닫기', onClick: () => close() }, icon('x', 16))),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-foot' }, buttons) : null);

  const root = h('div', { class: 'modal-root' },
    h('div', { class: 'modal-scrim', onClick: () => { if (dismissible) close(); } }),
    dialog);

  function onKey(e) {
    if (closed) return;
    // 창이 겹쳐 있으면 맨 위 창만 Esc·Tab을 처리한다
    if (topmostRoot() !== root) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.popover')) return; // 팝오버가 먼저 닫힌다
      e.preventDefault();
      if (dismissible) close();
    } else if (e.key === 'Tab') {
      const list = focusables(dialog);
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  }

  document.body.append(root);
  document.body.classList.add('has-modal');
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => {
    const target = autofocusEl || dialog.querySelector('[autofocus]') || focusables(dialog.querySelector('.modal-body'))[0] || buttons[buttons.length - 1];
    if (target) target.focus();
  });
  return { close, el: dialog };
}

/** confirmDialog('삭제할까요?', '삭제') → Promise<boolean> */
export function confirmDialog(message, confirmLabel = '확인', { title = '확인', danger = false, cancelLabel = '취소' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v, close) => { answered = true; resolve(v); close(); };
    modal({
      title,
      body: h('p', { class: 'modal-text' }, str(message)),
      actions: [
        { label: cancelLabel, kind: 'secondary', onClick: ({ close }) => done(false, close) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', autofocus: true, onClick: ({ close }) => done(true, close) },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

// ───────────────────────── 팝오버 ─────────────────────────

let activePopover = null;

/**
 * popover(anchorEl, contentEl, {placement: 'bottom-start'|'bottom-end'|'top-start'|'top-end', className, onClose,
 *   role, label, returnFocus, keepOthers}) → {close, el, place}
 * 화면 밖으로 나가지 않게 위치를 보정하고, Esc·바깥 클릭으로 닫힌다.
 */
export function popover(anchorEl, contentEl, opts = {}) {
  const { placement = 'bottom-start', offset = 6, className = '', onClose, role = 'dialog', label, returnFocus = null, keepOthers = false } = opts;
  if (activePopover && !keepOthers) activePopover.close();
  const el = h('div', { class: ['popover', className], role, 'aria-label': label, tabindex: '-1' }, contentEl);
  let closed = false;

  function place() {
    if (closed) return;
    if (!anchorEl || !anchorEl.isConnected) { close(); return; }
    const r = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const m = 8;
    el.style.maxWidth = `${vw - m * 2}px`;
    el.style.maxHeight = `${vh - m * 2}px`;
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    const wantTop = placement.startsWith('top');
    const below = r.bottom + offset;
    const above = r.top - offset - ph;
    let top = wantTop ? above : below;
    if (!wantTop && below + ph > vh - m && above >= m) top = above;
    if (wantTop && above < m && below + ph <= vh - m) top = below;
    top = Math.min(Math.max(top, m), Math.max(m, vh - ph - m));
    let left = placement.endsWith('end') ? r.right - pw : r.left;
    left = Math.min(Math.max(left, m), Math.max(m, vw - pw - m));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.dataset.side = top < r.top ? 'top' : 'bottom';
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      const target = returnFocus || anchorEl;
      if (target && target.isConnected) target.focus();
    }
  }
  function onDown(e) {
    if (el.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
    close();
  }
  const onScroll = () => place();

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    el.remove();
    if (activePopover && activePopover.el === el) activePopover = null;
    if (onClose) onClose();
  }

  document.body.append(el);
  place();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  const api = { close, el, place, get closed() { return closed; } };
  activePopover = api;
  return api;
}

/** 메뉴 팝오버: items = [{label, icon, onClick, danger, disabled, note}] */
export function menu(anchorEl, items, opts = {}) {
  let pop = null;
  const list = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) => it.separator
      ? h('div', { class: 'menu-sep', role: 'separator' })
      : h('button', {
        type: 'button', role: 'menuitem', class: ['menu-item', it.danger ? 'is-danger' : ''], disabled: !!it.disabled,
        title: it.title,
        onClick: () => { pop?.close(); if (typeof it.onClick === 'function') it.onClick(); },
      }, it.icon ? icon(it.icon, 16) : h('span', { class: 'menu-gap' }),
      h('span', { class: 'menu-label' }, it.label, it.note ? h('span', { class: 'menu-note' }, it.note) : null))));
  list.addEventListener('keydown', (e) => {
    const btns = [...list.querySelectorAll('.menu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  });
  anchorEl.setAttribute('aria-expanded', 'true');
  pop = popover(anchorEl, list, {
    placement: opts.placement || 'bottom-end', className: 'popover-menu', role: 'presentation',
    onClose: () => { anchorEl.setAttribute('aria-expanded', 'false'); if (opts.onClose) opts.onClose(); },
  });
  requestAnimationFrame(() => list.querySelector('.menu-item:not([disabled])')?.focus());
  return pop;
}

// ───────────────────────── 출처 카드 · 인용 칩 ─────────────────────────

/** 출처 팝오버 카드 (FRONTEND 9.3) */
export function sourceCard(source, { onOpenEvidence } = {}) {
  const s = obj(source);
  const sid = str(s.sid).trim() || '?';
  const hasData = !!(s.title || s.key_finding || s.venue);
  const badges = h('div', { class: 'src-badges' },
    h('span', { class: 'badge badge-id' }, sid),
    s.kind ? kindBadge(s.kind) : null,
    str(s.study_type).trim() ? badge(studyTypeLabel(s.study_type)) : null);

  if (!hasData) {
    return h('div', { class: 'src-card' }, badges,
      h('p', { class: 'src-missing' }, '이 출처 정보를 문헌 목록에서 찾을 수 없습니다.'));
  }

  const byline = [fmtAuthors(s.authors), num(s.year) ?? str(s.year), str(s.venue)].filter((x) => x !== '' && x !== null).join(' · ');
  const score = num(s.score);
  const cites = num(s.citations);
  const href = safeHref(s.url) || safeHref(s.doi);
  const actions = [];
  if (href) {
    actions.push(h('a', { class: 'btn btn-secondary btn-sm', href, target: '_blank', rel: 'noopener noreferrer' },
      icon('external-link', 14), h('span', { class: 'btn-label' }, '원문 열기')));
  }
  if (typeof onOpenEvidence === 'function') {
    actions.push(button('근거 탭에서 보기', { kind: 'ghost', size: 'sm', icon: 'list', onClick: () => onOpenEvidence(sid, s) }));
  }
  return h('div', { class: 'src-card' },
    badges,
    h('div', { class: 'src-title' }, str(s.title, '제목 정보 없음')),
    byline ? h('div', { class: 'src-byline' }, byline) : null,
    str(s.key_finding).trim() ? h('p', { class: 'src-finding' }, s.key_finding) : null,
    h('div', { class: 'src-meta' },
      directionText(s.direction),
      score !== null ? h('span', { class: 'src-meta-item' }, '점수 ', h('b', { class: 'num' }, score.toFixed(2))) : null,
      cites !== null ? h('span', { class: 'src-meta-item' }, '피인용 ', h('b', { class: 'num' }, fmtInt(cites))) : null),
    actions.length ? h('div', { class: 'src-actions' }, actions) : null);
}

function citeSid(a) {
  const d = str(a.dataset.sid).trim();
  if (d) return d;
  const href = str(a.getAttribute('href'));
  const m = href.match(/#ref-([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return a.textContent.replace(/[[\]\s,]/g, '');
}

/**
 * 컨테이너 안의 모든 a.cite에 출처 팝오버를 연결한다(위임 방식). 해제 함수를 돌려준다.
 * 호버(짧은 지연)·포커스·클릭으로 열리고, 클릭의 기본 이동은 막으며, Esc로 닫힌다.
 */
export function attachCitePopovers(containerEl, sourcesById, { onOpenEvidence } = {}) {
  if (!containerEl) return () => {};
  const lookup = (sid) => (sourcesById instanceof Map ? sourcesById.get(sid) : obj(sourcesById)[sid]);
  let pop = null;
  let chip = null;
  let openTimer = 0;
  let closeTimer = 0;

  for (const a of containerEl.querySelectorAll('a.cite')) {
    a.setAttribute('aria-haspopup', 'dialog');
    a.setAttribute('aria-expanded', 'false');
  }

  const closeNow = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (pop) pop.close();
  };
  const scheduleClose = (delay = 220) => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeNow, delay);
  };

  function open(a) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (pop && chip === a) return;
    if (pop) pop.close();
    const sid = citeSid(a);
    const src = lookup(sid);
    const card = sourceCard(src || { sid }, {
      onOpenEvidence: typeof onOpenEvidence === 'function' ? (id, s) => { closeNow(); onOpenEvidence(id, s); } : null,
    });
    chip = a;
    a.setAttribute('aria-expanded', 'true');
    const p = popover(a, card, {
      placement: 'bottom-start', className: 'popover-source', label: `출처 ${sid}`, returnFocus: a,
      onClose: () => {
        a.setAttribute('aria-expanded', 'false');
        if (pop === p) { pop = null; chip = null; }
      },
    });
    pop = p;
    p.el.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    p.el.addEventListener('mouseleave', () => scheduleClose());
    p.el.addEventListener('focusout', (e) => {
      if (!p.el.contains(e.relatedTarget) && e.relatedTarget !== a) scheduleClose(120);
    });
  }

  const findChip = (t) => (t instanceof Element ? t.closest('a.cite') : null);
  const onOver = (e) => {
    const a = findChip(e.target);
    if (!a || !containerEl.contains(a)) return;
    if (chip === a) { clearTimeout(closeTimer); return; }
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(a), 280);
  };
  const onOut = (e) => {
    const a = findChip(e.target);
    if (!a) return;
    if (a.contains(e.relatedTarget)) return;
    clearTimeout(openTimer);
    if (chip === a) scheduleClose();
  };
  const onFocusIn = (e) => {
    const a = findChip(e.target);
    if (a && a.matches(':focus-visible')) open(a);
  };
  const onFocusOut = (e) => {
    const a = findChip(e.target);
    if (!a || chip !== a) return;
    if (pop && pop.el.contains(e.relatedTarget)) return;
    scheduleClose(120);
  };
  const onClick = (e) => {
    const a = findChip(e.target);
    if (!a) return;
    e.preventDefault();
    if (pop && chip === a) { closeNow(); return; }
    open(a);
  };

  containerEl.addEventListener('mouseover', onOver);
  containerEl.addEventListener('mouseout', onOut);
  containerEl.addEventListener('focusin', onFocusIn);
  containerEl.addEventListener('focusout', onFocusOut);
  containerEl.addEventListener('click', onClick);
  return () => {
    closeNow();
    containerEl.removeEventListener('mouseover', onOver);
    containerEl.removeEventListener('mouseout', onOut);
    containerEl.removeEventListener('focusin', onFocusIn);
    containerEl.removeEventListener('focusout', onFocusOut);
    containerEl.removeEventListener('click', onClick);
  };
}

// ───────────────────────── 기타 ─────────────────────────

/** 클립보드 복사(실패하면 false) */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(str(text));
    return true;
  } catch {
    try {
      const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
      ta.value = str(text);
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** textarea 높이를 내용에 맞춘다 */
export function autosize(ta, maxPx = 480) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, maxPx)}px`;
  ta.style.overflowY = ta.scrollHeight + 2 > maxPx ? 'auto' : 'hidden';
}

/** 탭 목록에 화살표 키 이동을 붙인다 (role=tablist 안의 [role=tab]) */
export function wireTablist(tablistEl, onSelect) {
  tablistEl.addEventListener('keydown', (e) => {
    const tabs = [...tablistEl.querySelectorAll('[role="tab"]:not([disabled])')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next].focus();
    if (onSelect) onSelect(tabs[next]);
  });
}

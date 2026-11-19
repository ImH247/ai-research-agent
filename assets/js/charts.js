// 차트: 순위 가로 막대 · 분할 막대 · 세로 막대 (FRONTEND 7, 9.5).
// 분할 막대 여러 줄(segmentedRows)은 같은 범주를 같은 축에서 비교한다(검증 탭의 수정 전 → 수정 후).
// 외부 라이브러리 없이 CSS 막대로 그린다. 모든 함수는 DOM 요소를 돌려주는 순수 함수다.
// 항목 형식: {label, value, color?, hint?}. 색은 CSS 변수 문자열(예: 'var(--chart-1)')만 받는다.
// 모든 글자는 textContent로 들어간다(innerHTML 사용 없음).

import { h, icon, uid } from './ui.js';

const nf = new Intl.NumberFormat('ko-KR');
const pf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

function toNum(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 항목 정리: 이름이 없거나 값이 숫자가 아니면 0으로 */
function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({ ...it, label: String(it.label ?? '').trim() || '미분류', value: toNum(it.value) }));
}

function fmtValue(v, unit) {
  return `${nf.format(v)}${unit || ''}`;
}

/** 비율 문자열: 12.5% */
export function fmtShare(value, total) {
  if (!total) return '0%';
  return `${pf.format((value / total) * 100)}%`;
}

// ───────────────────────── 툴팁 (공용 1개) ─────────────────────────

let tipEl = null;
let tipOwner = null;

function tipRoot() {
  if (!tipEl || !tipEl.isConnected) {
    tipEl = h('div', { class: 'chart-tip', role: 'tooltip', id: 'chart-tip', hidden: true });
    document.body.append(tipEl);
  }
  return tipEl;
}

function placeTip(x, y) {
  const el = tipRoot();
  const m = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left = x + 14;
  let top = y - ht - 10;
  if (left + w > vw - m) left = x - w - 14;
  if (left < m) left = m;
  if (top < m) top = y + 18;
  if (top + ht > vh - m) top = vh - ht - m;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** 툴팁을 보여 준다. content = {title, value, share, note} */
export function showTooltip(content, x, y, owner = null) {
  const el = tipRoot();
  const c = content || {};
  el.replaceChildren(
    h('div', { class: 'chart-tip-title' },
      c.color ? h('span', { class: 'chart-swatch', style: { '--c': c.color }, 'aria-hidden': 'true' }) : null,
      String(c.title ?? '')),
    h('div', { class: 'chart-tip-row' },
      c.value !== undefined ? h('b', { class: 'num' }, String(c.value)) : null,
      c.share ? h('span', { class: 'chart-tip-share num' }, c.share) : null),
    c.note ? h('div', { class: 'chart-tip-note' }, String(c.note)) : null);
  el.hidden = false;
  tipOwner = owner;
  placeTip(x, y);
}

export function hideTooltip(owner = null) {
  if (!tipEl) return;
  if (owner && tipOwner && owner !== tipOwner) return;
  tipEl.hidden = true;
  tipOwner = null;
}

/**
 * 요소에 툴팁을 붙인다. getContent() → {title, value, share, note, color}.
 * 마우스 위치를 따라가고, 키보드 포커스에서는 요소 위쪽에 띄운다.
 */
export function attachTooltip(el, getContent) {
  const content = () => (typeof getContent === 'function' ? getContent() : getContent);
  el.addEventListener('pointerenter', (e) => showTooltip(content(), e.clientX, e.clientY, el));
  el.addEventListener('pointermove', (e) => { if (tipOwner === el) placeTip(e.clientX, e.clientY); });
  el.addEventListener('pointerleave', () => hideTooltip(el));
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTooltip(content(), r.left + Math.min(r.width, 160) / 2, r.top, el);
  });
  el.addEventListener('blur', () => hideTooltip(el));
  return el;
}

// 스크롤하면 툴팁을 숨긴다(위치가 어긋나므로)
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => hideTooltip(), { passive: true, capture: true });
}

// ───────────────────────── 공용 틀 ─────────────────────────

/** 같은 숫자를 보여 주는 작은 표 */
function dataTable(rows, { unit, total, nameHead = '항목' }) {
  return h('table', { class: 'chart-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, nameHead),
      h('th', { scope: 'col', class: 'num' }, '값'),
      h('th', { scope: 'col', class: 'num' }, '비율'))),
    h('tbody', null, rows.map((r) => h('tr', null,
      h('th', { scope: 'row' },
        r.color ? h('span', { class: 'chart-swatch', style: { '--c': r.color }, 'aria-hidden': 'true' }) : null,
        r.label,
        r.hint ? h('span', { class: 'chart-table-hint' }, r.hint) : null),
      h('td', { class: 'num' }, fmtValue(r.value, unit)),
      h('td', { class: 'num' }, fmtShare(r.value, total))))),
    h('tfoot', null, h('tr', null,
      h('th', { scope: 'row' }, '합계'),
      h('td', { class: 'num' }, fmtValue(total, unit)),
      h('td', { class: 'num' }, total ? '100%' : '—'))));
}

/**
 * 차트 카드 틀: 제목 + "표로 보기" 토글 + 막대 영역 + 표.
 * marks는 role="img"와 요약 aria-label을 받는다(표 보기 버튼과 표는 그대로 읽힌다).
 */
function frame({ title, subtitle, kind, marks, table, summary, legend, empty }) {
  const tableId = uid('chart-table');
  const body = h('div', { class: 'chart-body' });
  const tableWrap = h('div', { class: 'chart-table-wrap', id: tableId, hidden: true }, table);
  const toggle = h('button', {
    type: 'button', class: 'chart-toggle', 'aria-pressed': 'false', 'aria-controls': tableId,
    onClick: () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      tableWrap.hidden = !on;
      body.hidden = on;
      toggleLabel.textContent = on ? '차트로 보기' : '표로 보기';
      toggle.replaceChildren(icon(on ? 'bar-chart' : 'list', 14), toggleLabel);
      hideTooltip();
    },
  });
  const toggleLabel = h('span', null, '표로 보기');
  toggle.append(icon('list', 14), toggleLabel);

  if (empty) {
    body.append(h('p', { class: 'chart-empty' }, '표시할 데이터가 없습니다.'));
    toggle.disabled = true;
  } else {
    marks.setAttribute('role', 'img');
    marks.setAttribute('aria-label', summary);
    body.append(marks);
    if (legend) body.append(legend);
  }
  return h('figure', { class: ['chart', `chart-${kind}`] },
    h('div', { class: 'chart-head' },
      h('figcaption', { class: 'chart-title' }, title || '',
        subtitle ? h('span', { class: 'chart-sub' }, subtitle) : null),
      toggle),
    body, tableWrap);
}

function summaryText(title, rows, unit, total) {
  const parts = rows.map((r) => `${r.label} ${fmtValue(r.value, unit)}(${fmtShare(r.value, total)})`);
  return `${title || '차트'}: ${parts.join(', ')}`;
}

// ───────────────────────── 순위 가로 막대 ─────────────────────────

/**
 * 크기 비교용 순위 막대(한 색상). 큰 값부터, maxItems를 넘으면 나머지를 otherLabel로 합친다.
 * options: {title, subtitle, unit='건', maxItems=8, otherLabel='기타', color='var(--chart-seq)'}
 */
export function rankedBars(items, options = {}) {
  const { title = '', subtitle = '', unit = '건', maxItems = 8, otherLabel = '기타', color = 'var(--chart-seq)' } = options;
  const clean = cleanItems(items).filter((it) => it.value > 0);
  // 이미 '기타'인 항목은 접는 칸과 합친다
  const named = clean.filter((it) => it.label !== otherLabel).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ko'));
  let otherValue = clean.filter((it) => it.label === otherLabel).reduce((s, it) => s + it.value, 0);
  let otherHint = [];
  let rows = named;
  const limit = Math.max(1, maxItems - (otherValue > 0 ? 1 : 0));
  if (named.length > limit || (otherValue > 0 && named.length >= maxItems)) {
    const keep = Math.max(1, maxItems - 1);
    rows = named.slice(0, keep);
    const rest = named.slice(keep);
    otherValue += rest.reduce((s, it) => s + it.value, 0);
    otherHint = rest.map((it) => it.label);
  }
  if (otherValue > 0) rows = [...rows, { label: otherLabel, value: otherValue, hint: otherHint.length ? `${otherHint.length}개 항목 합침` : '' }];
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;

  const marks = h('div', { class: 'rbars' }, rows.map((r) => {
    const share = fmtShare(r.value, total);
    const row = h('div', { class: 'rbar' },
      h('span', { class: 'rbar-label', title: r.label }, r.label),
      h('span', { class: 'rbar-track' },
        h('span', { class: 'rbar-fill', style: { '--p': (r.value / max).toFixed(4), '--c': r.color || color } }),
        h('span', { class: 'rbar-value num' }, nf.format(r.value))));
    attachTooltip(row, () => ({
      title: r.label, value: fmtValue(r.value, unit), share: `전체의 ${share}`,
      note: r.hint ? `${otherHint.slice(0, 6).join(', ')}${otherHint.length > 6 ? ' 외' : ''}` : '', color: r.color || color,
    }));
    return row;
  }));

  return frame({
    title, subtitle, kind: 'ranked', marks, empty: !rows.length,
    summary: summaryText(title, rows, unit, total),
    table: dataTable(rows, { unit, total }),
  });
}

// ───────────────────────── 분할 막대(구성비) ─────────────────────────

/**
 * 구성비를 보여 주는 분할 막대 1개 + 범례 + 조각 아래 글자 라벨.
 * 항목 순서와 색은 호출자가 고정한다(순환 금지).
 * options: {title, subtitle, unit='건', total, legend=true, labels=true, compact=false, ariaLabel, legendIcons}
 *   item.icon(선택): 범례에 함께 보일 아이콘 이름(판정 표시용 — 색만으로 구분하지 않기 위해)
 */
export function segmentedBar(items, options = {}) {
  const { title = '', subtitle = '', unit = '건', legend = true, labels = true, compact = false } = options;
  const rows = cleanItems(items);
  const visible = rows.filter((r) => r.value > 0);
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const total = toNum(options.total) || sum;

  const bar = h('div', { class: 'seg-bar' }, visible.map((r) => {
    const seg = h('span', {
      class: 'seg-part', style: { '--w': String(r.value), '--c': r.color || 'var(--chart-none)' },
    });
    attachTooltip(seg, () => ({ title: r.label, value: fmtValue(r.value, unit), share: fmtShare(r.value, total), color: r.color }));
    return seg;
  }));
  // 비어 있는 몫(total이 합보다 큰 경우)
  if (total > sum) bar.append(h('span', { class: 'seg-part seg-rest', style: { '--w': String(total - sum) } }));

  const labelRow = labels ? h('div', { class: 'seg-labels', 'aria-hidden': 'true' },
    visible.map((r) => h('span', { class: 'seg-label num', style: { '--w': String(r.value) }, title: `${r.label} ${fmtValue(r.value, unit)}` },
      fmtShare(r.value, total))),
    total > sum ? h('span', { class: 'seg-label', style: { '--w': String(total - sum) } }) : null) : null;

  const marks = h('div', { class: ['seg-chart', compact ? 'is-compact' : ''] }, bar, labelRow);

  const legendEl = legend ? h('ul', { class: 'chart-legend' }, rows.map((r) => h('li', { class: ['legend-item', r.value ? '' : 'is-zero'] },
    h('span', { class: 'chart-swatch', style: { '--c': r.color || 'var(--chart-none)' }, 'aria-hidden': 'true' }),
    r.icon ? icon(r.icon, 12, 'legend-icon') : null,
    h('span', { class: 'legend-label' }, r.label),
    h('span', { class: 'legend-value num' }, nf.format(r.value)),
    h('span', { class: 'legend-share num' }, fmtShare(r.value, total))))) : null;

  return frame({
    title, subtitle, kind: 'segmented', marks, legend: legendEl, empty: !visible.length,
    summary: options.ariaLabel || summaryText(title, rows, unit, total),
    table: dataTable(rows, { unit, total }),
  });
}

// ───────────────────────── 분할 막대 여러 줄(같은 축 비교) ─────────────────────────

/**
 * 같은 범주를 여러 줄의 분할 막대로 비교한다(예: 판정 집계 수정 전 → 수정 후). 범례 1개를 함께 쓴다.
 * rows: [{name, values: {key: 값}}], cats: [{key, label, color, icon?}] — 순서와 색은 호출자가 고정한다.
 * options: {title, subtitle, unit='건', total}
 */
export function segmentedRows(rows, cats, options = {}) {
  const { title = '', subtitle = '', unit = '건' } = options;
  const series = (Array.isArray(cats) ? cats : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ ...c, label: String(c.label ?? c.key ?? '').trim() || '미분류' }));
  const lines = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object').map((r) => {
    const vals = r.values && typeof r.values === 'object' ? r.values : {};
    const parts = series.map((c) => ({ ...c, value: toNum(vals[c.key]) }));
    const sum = parts.reduce((s, p) => s + p.value, 0);
    return { name: String(r.name ?? '').trim(), parts, sum, total: toNum(options.total) || sum };
  });
  const empty = !lines.some((l) => l.sum > 0);

  const marks = h('div', { class: 'seg-rows' }, lines.map((l) => {
    const bar = h('div', { class: 'seg-bar' }, l.parts.filter((p) => p.value > 0).map((p) => {
      const seg = h('span', { class: 'seg-part', style: { '--w': String(p.value), '--c': p.color || 'var(--chart-none)' } });
      attachTooltip(seg, () => ({ title: `${l.name} · ${p.label}`, value: fmtValue(p.value, unit), share: fmtShare(p.value, l.total), color: p.color }));
      return seg;
    }));
    if (l.total > l.sum) bar.append(h('span', { class: 'seg-part seg-rest', style: { '--w': String(l.total - l.sum) } }));
    return h('div', { class: 'seg-row' },
      h('span', { class: 'seg-row-name' }, l.name),
      bar,
      h('span', { class: 'seg-row-total num' }, fmtValue(l.sum, unit)));
  }));

  // 범례: 범주마다 줄별 값을 "a → b"로
  const legendEl = h('ul', { class: 'chart-legend' }, series.map((c, i) => {
    const values = lines.map((l) => l.parts[i].value);
    return h('li', { class: ['legend-item', values.some((v) => v > 0) ? '' : 'is-zero'] },
      h('span', { class: 'chart-swatch', style: { '--c': c.color || 'var(--chart-none)' }, 'aria-hidden': 'true' }),
      c.icon ? icon(c.icon, 12, 'legend-icon') : null,
      h('span', { class: 'legend-label' }, c.label),
      h('span', { class: 'legend-value num' }, values.map((v) => nf.format(v)).join(' → ')));
  }));

  const table = h('table', { class: 'chart-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, '항목'),
      lines.map((l) => h('th', { scope: 'col', class: 'num' }, l.name)))),
    h('tbody', null, series.map((c, i) => h('tr', null,
      h('th', { scope: 'row' },
        c.color ? h('span', { class: 'chart-swatch', style: { '--c': c.color }, 'aria-hidden': 'true' }) : null,
        c.label),
      lines.map((l) => h('td', { class: 'num' }, `${fmtValue(l.parts[i].value, unit)} (${fmtShare(l.parts[i].value, l.total)})`))))),
    h('tfoot', null, h('tr', null,
      h('th', { scope: 'row' }, '합계'),
      lines.map((l) => h('td', { class: 'num' }, fmtValue(l.sum, unit))))));

  const summary = `${title || '차트'}: ${lines.map((l) => `${l.name} — ${l.parts.filter((p) => p.value > 0)
    .map((p) => `${p.label} ${fmtValue(p.value, unit)}`).join(', ') || '없음'}`).join(' / ')}`;
  return frame({ title, subtitle, kind: 'rows', marks, legend: legendEl, empty, summary, table });
}

// ───────────────────────── 세로 막대(연도) ─────────────────────────

/**
 * 순서가 있는 범주(연도 등)의 세로 막대. 항목 순서를 그대로 쓴다.
 * options: {title, subtitle, unit='건', color='var(--chart-seq)', nameHead='연도'}
 */
export function columnBars(items, options = {}) {
  const { title = '', subtitle = '', unit = '건', color = 'var(--chart-seq)', nameHead = '연도' } = options;
  const rows = cleanItems(items);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;

  const marks = h('div', { class: 'cbars', style: { '--n': String(Math.max(rows.length, 1)) } }, rows.map((r) => {
    const col = h('div', { class: 'cbar' },
      h('span', { class: 'cbar-area' },
        h('span', { class: 'cbar-value num' }, r.value ? nf.format(r.value) : ''),
        h('span', { class: ['cbar-fill', r.value ? '' : 'is-zero'], style: { '--p': (r.value / max).toFixed(4), '--c': r.color || color } })),
      h('span', { class: 'cbar-label num' }, r.label));
    attachTooltip(col, () => ({ title: r.label, value: fmtValue(r.value, unit), share: `전체의 ${fmtShare(r.value, total)}`, color: r.color || color }));
    return col;
  }));

  return frame({
    title, subtitle, kind: 'columns', marks, empty: !total,
    summary: summaryText(title, rows, unit, total),
    table: dataTable(rows, { unit, total, nameHead }),
  });
}

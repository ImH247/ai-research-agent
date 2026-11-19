// 발표 슬라이드(.pptx) 내보내기. 원본: docs/reference/python/exporters/pptx_export.py (python-pptx) → vendor/pptxgenjs.js
//
// 16:9 빈 슬라이드 위에 격자(여백 · 제목 영역 · 본문 영역 · 꼬리말)를 한 번 정해 두고 모든 도형을 직접 배치한다.
// PowerPoint는 글자를 알아서 줄여 주지 않으므로, 글자 수 · 글자 크기 · 상자 너비로 필요한 줄 수를 어림해
// 글자 크기 단계를 고르고, 넘치면 '(계속)' 슬라이드로 넘긴다.
// pptxgenjs가 직접 지정하지 못하는 것(차트 글자의 한글 글꼴, 글머리 기호 색, 계열별 데이터 레이블 색)은
// 만든 뒤 zip 안의 XML을 고쳐 맞춘다.
import PptxGenJS from '../../../vendor/pptxgenjs.js';
import JSZip from '../../../vendor/jszip.js';
import * as theme from './theme.js';
import { VERDICTS, arr, citeReGlobal, authorsText, citedIds, metaInfo, shortCite, sourcesById, verdictTally, fmtInt } from './common.js';
import { clip, fallbackOutline, normalizeOutline } from './slides.js';

// ---------------------------------------------------------------- 격자 (단위: 인치)
const W = 13.333, H = 7.5;
const ML = 0.6;                       // 좌우 여백
const CW = W - 2 * ML;                // 본문 너비
const KICK_Y = 0.36, KICK_H = 0.34;   // 머리말 위 작은 글(구역 이름)
const TITLE_Y = 0.70, TITLE_H = 0.88; // 슬라이드 제목
const RULE_Y = 1.64;                  // 제목 아래 강조선
const TOP = 1.9, BOTTOM = 6.75;       // 본문 영역
const CH = BOTTOM - TOP;
const FOOT_Y = 6.98, FOOT_H = 0.3;    // 꼬리말
const MX = 0.05, MY = 0.03;           // 글상자 안쪽 여백
const CELL_MX = 0.08, CELL_MY = 0.05; // 표 칸 안쪽 여백
const INDENT = 0.24;                  // 글머리 기호 들여쓰기

// 글자 크기 단계 (pt)
const TITLE_TIERS = [28, 24, 20];
const BODY_TIERS = [20, 18, 16, 14];
const SMALL_TIERS = [16, 14, 13, 12];
const PER_SLIDE = 5;                  // 슬라이드당 글머리 항목 최대 수

// 줄 수 어림값: 한글 등 전각 1em, 영문 0.58em, 줄바꿈 손실 10%, 줄 간격 1.3배(맑은 고딕)
const WRAP = 1.1, LINE = 1.3;
const FONT = theme.FONT_KO;

const TXT = {
  ko: {
    product: 'AI Research Agent', cont: '(계속)', none: '자료 없음',
    summary_k: '핵심 요약', summary_t: '한눈에 보는 결론',
    design_k: '연구 설계', design_t: '에이전트 8단계와 수집 규모', pipeline: '에이전트 파이프라인', scale: '수집 규모',
    tiles: ['수집 문헌', '채택 문헌', '중복 판본 병합', 'LLM 호출', '소요 시간(분)'],
    n_subq: '하위 질문', unit_q: '개', window: '검색 기간', model: '모델', disabled: '제외된 도구',
    stages: [['주제 이해', '개념·변수·기간'], ['계획 수립', '하위 질문 설계'], ['문헌 탐색', '학술 DB·웹 검색'],
      ['근거 평가', '관련성·신뢰도'], ['종합', '하위 질문별'], ['성찰', '재조사 판단'],
      ['보고서', '브리프 작성'], ['인용 검증', '초록 대조']],
    subq_k: '하위 질문', subq_t: '연구 질문을 나눈 방식', cols_q: ['ID', '관점', '하위 질문'],
    ev_k: '근거 프로필', ev_t: '채택 문헌의 구성', study: '연구 유형', year: '출판 연도', direction: '결과 방향',
    other: '기타', included: '채택 문헌',
    strength: '근거 강도', related: '관련 근거', unit_src: '건', subq: '하위 질문',
    agree_k: '일치와 상충', agree_t: '연구들이 일치하는 점과 엇갈리는 점', agree: '일치하는 점', conflict: '상충하는 점',
    gaps_k: '연구 공백', gaps_t: '아직 답하지 못한 질문',
    future_k: '향후 연구', future_t: '제안하는 후속 연구',
    fields: [['question', '연구 질문'], ['design', '설계'], ['sample', '표본'], ['contribution', '기대 기여']],
    must_k: '필독 문헌', must_t: '먼저 읽을 문헌', cols_m: ['순위', '문헌', '읽을 이유'],
    lim_k: '한계와 인용 검증', lim_t: '이 브리프의 한계', check: '인용 검증', before: '수정 전', after: '수정 후',
    verdict: '판정', fig: ['인용 ID', '없는 ID', '검증 문장'], no_lim: '기재된 한계가 없습니다.',
    refs_k: '참고문헌', refs_t: '슬라이드에 인용한 문헌',
    collected: '수집', inc: '채택', unit: '건',
  },
  en: {
    product: 'AI Research Agent', cont: '(cont.)', none: 'No data',
    summary_k: 'Executive summary', summary_t: 'Key conclusions at a glance',
    design_k: 'Research design', design_t: 'Eight-stage agent pipeline and scale', pipeline: 'Agent pipeline',
    scale: 'Scale', tiles: ['Collected', 'Included', 'Duplicates merged', 'LLM calls', 'Minutes'],
    n_subq: 'Sub-questions', unit_q: '', window: 'Search window', model: 'Model', disabled: 'Disabled tools',
    stages: [['Understand', 'concepts, scope'], ['Plan', 'sub-questions'], ['Search', 'databases + web'],
      ['Evaluate', 'relevance'], ['Synthesize', 'per question'], ['Reflect', 're-search?'],
      ['Report', 'write brief'], ['Verify', 'check citations']],
    subq_k: 'Sub-questions', subq_t: 'How the question was broken down', cols_q: ['ID', 'Perspective', 'Sub-question'],
    ev_k: 'Evidence profile', ev_t: 'What the included sources look like', study: 'Study type',
    year: 'Publication year', direction: 'Result direction', other: 'Other', included: 'Included',
    strength: 'Evidence strength', related: 'Related sources', unit_src: '', subq: 'Sub-question',
    agree_k: 'Agreement and conflict', agree_t: 'Where studies agree and where they differ', agree: 'Agreement',
    conflict: 'Conflict',
    gaps_k: 'Research gaps', gaps_t: 'Questions not yet answered',
    future_k: 'Future research', future_t: 'Proposed follow-up studies',
    fields: [['question', 'Question'], ['design', 'Design'], ['sample', 'Sample'], ['contribution', 'Expected contribution']],
    must_k: 'Must-read sources', must_t: 'Read these first', cols_m: ['Rank', 'Source', 'Why read it'],
    lim_k: 'Limitations and citation check', lim_t: 'Limitations of this brief', check: 'Citation check',
    before: 'Before', after: 'After', verdict: 'Verdict', fig: ['Cited ids', 'Unknown ids', 'Claims checked'],
    no_lim: 'No limitations were listed.',
    refs_k: 'References', refs_t: 'Sources cited in these slides',
    collected: 'collected', inc: 'included', unit: '',
  },
};
const STRENGTH_EN = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak', insufficient: 'Insufficient' };
const VERDICT_EN = {
  'supported': 'Supported', 'partially supported': 'Partly supported',
  'not in source text': 'Not in abstract', 'contradicted': 'Contradicted',
};
const DIRECTIONS = Object.keys(theme.DIRECTION_LABEL);   // 고정 순서 → 계열색 고정
const STRENGTH_COLOR = { strong: theme.ACCENT_DARK, moderate: theme.ACCENT, weak: theme.INK_2, insufficient: theme.MUTED };
// 밝은 계열색에는 진한 글자 (중립 회색도 흰 글자가 잘 안 보여 진한 글자로)
const DARK_LABEL_ON = new Set(['EDA100', 'E87BA4', '1BAF7A', theme.NEUTRAL_FILL]);

// ---------------------------------------------------------------- 글자 맞춤 어림

const em = (cp) => (cp >= 0x1100 ? 1.0 : 0.58);

function emWidth(s) {
  let n = 0;
  for (const ch of s) n += em(ch.codePointAt(0));
  return n;
}

/** 너비 width(인치) 상자에 size pt로 쓸 때 필요한 줄 수(어림). */
export function textLines(text, size, width) {
  const per = Math.max((width * 72) / size, 1.0);
  return String(text ?? '').split('\n').reduce((acc, part) => acc + Math.max(1, Math.ceil((emWidth(part) * WRAP) / per)), 0);
}

/** 문단 [[글, 크기]]에 필요한 높이(인치, 안쪽 여백 포함). gap = 문단 사이 간격(pt). */
export function textHeight(paras, width, gap = 0, indent = 0) {
  const w = width - 2 * MX - indent;
  const h = paras.reduce((acc, [t, s]) => acc + (textLines(t, s, w) * s * LINE) / 72, 0);
  return h + (gap * Math.max(paras.length - 1, 0)) / 72 + 2 * MY;
}

function bulletsHeight(items, size, width) {
  return textHeight(items.map((t) => [t, size]), width, size * 0.5, INDENT);
}

/** 가장 큰 글자 크기를 고르고, 가장 작은 크기로도 넘치면 글을 줄인다 → [글, 크기] */
export function fitText(text, width, height, tiers) {
  text = String(text ?? '');
  for (const size of tiers) {
    if (textHeight([[text, size]], width) <= height) return [text, size];
  }
  const size = tiers[tiers.length - 1];
  while (text.length > 8 && textHeight([[text, size]], width) > height) {
    const next = clip(text, Math.floor(text.length * 0.85));
    if (next.length >= text.length) break;      // 더 줄지 않으면 멈춘다
    text = next;
  }
  return [text, size];
}

/** 글머리 항목을 슬라이드 단위로 나누고 각 묶음의 글자 크기를 고른다 → [[항목들, 크기]] */
export function paginate(items, width, height, tiers, per = PER_SLIDE) {
  if (!items.length) return [];
  const n = Math.ceil(items.length / per);
  const k = Math.ceil(items.length / n);
  let out = [];
  for (let i = 0; i < items.length; i += k) {
    let chunk = items.slice(i, i + k);
    let size = tiers.find((s) => bulletsHeight(chunk, s, width) <= height);
    if (size === undefined && chunk.length > 1) {
      const half = Math.floor((chunk.length + 1) / 2);
      out = out.concat(paginate(chunk.slice(0, half), width, height, tiers, per),
        paginate(chunk.slice(half), width, height, tiers, per));
      continue;
    }
    if (size === undefined) {           // 항목 하나가 너무 길면 줄인다
      let text;
      [text, size] = fitText(chunk[0], width - INDENT, height, tiers.slice(-1));
      chunk = [text];
    }
    out.push([chunk, size]);
  }
  return out;
}

// ---------------------------------------------------------------- 글 · 도형 헬퍼

/** 정수는 천 단위 쉼표, 그 밖의 값은 그대로(null은 0). */
function num(v) {
  if (v === null || v === undefined) return '0';
  return Number.isInteger(v) ? fmtInt(v) : String(v);
}

const cleanOne = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const stripChars = (s, chars) => {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a += 1;
  while (b > a && chars.includes(s[b - 1])) b -= 1;
  return s.slice(a, b);
};
const pts = (inch) => Math.round(inch * 72 * 100) / 100;

/** 본문과 [S#] 인용을 나눈다. 인용은 작고 흐린 글자로. → [[글, 크기, 색, 굵게]] */
function citeRuns(text, size, color = theme.INK) {
  const out = [];
  let pos = 0;
  for (const m of text.matchAll(citeReGlobal())) {
    if (m.index > pos) out.push([text.slice(pos, m.index), size, color, false]);
    out.push([m[0], Math.max(size - 4, 9), theme.MUTED, false]);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push([text.slice(pos), size, color, false]);
  return out.length ? out : [[text, size, color, false]];
}

/** paras(각 항목은 문자열 또는 [[글, 크기, 색, 굵게]] 목록) → pptxgenjs 글 조각 목록 */
function textObjs(paras, { size = 14, color = theme.INK, bold = false, align = null, bullets = false, gap = 0 } = {}) {
  const out = [];
  paras.forEach((para, i) => {
    const runs = Array.isArray(para) ? para : [[para, size, color, bold]];
    const last = i === paras.length - 1;
    runs.forEach(([t, s, c, b], j) => {
      const o = { fontFace: FONT, fontSize: s, color: c, bold: !!b, lang: 'ko-KR' };
      if (align) o.align = align;
      if (gap && !last) o.paraSpaceAfter = gap;
      if (bullets && j === 0) o.bullet = { characterCode: '2022', indent: pts(INDENT) };
      if (j === runs.length - 1 && !last) o.breakLine = true;
      out.push({ text: String(t ?? ''), options: o });
    });
  });
  return out;
}

/** 글상자 공통 옵션 */
function frameOpts({ anchor = 'top', margins = [MX, MY] } = {}) {
  return {
    valign: anchor, wrap: true, fit: 'none',
    // pptxgenjs 글상자 여백 순서: [왼쪽, 오른쪽, 아래, 위] (pt)
    margin: [pts(margins[0]), pts(margins[0]), pts(margins[1]), pts(margins[1])],
  };
}

function textbox(slide, x, y, w, h, paras, opts = {}) {
  slide.addText(textObjs(paras, opts), { x, y, w, h, ...frameOpts(opts) });
}

function rectOpts(x, y, w, h, fill, rounded = false, line = null) {
  return {
    x, y, w, h,
    fill: { color: fill },
    line: line ? { color: line, width: 0.75 } : { type: 'none' },
    ...(rounded ? { rectRadius: 0.08 * Math.min(w, h) } : {}),
  };
}

function rect(slide, x, y, w, h, fill, rounded = false, line = null) {
  slide.addShape(rounded ? 'roundRect' : 'rect', rectOpts(x, y, w, h, fill, rounded, line));
}

/** 글이 든 도형(칩 · 타일 · 배지) */
function shapeText(slide, x, y, w, h, fill, paras, opts = {}) {
  slide.addText(textObjs(paras, opts), {
    ...rectOpts(x, y, w, h, fill, true), shape: 'roundRect', ...frameOpts(opts),
  });
}

function bulletBox(slide, x, y, w, h, items, size) {
  const paras = items.map((t) => citeRuns(String(t), size));
  textbox(slide, x, y, w, h, paras, { bullets: true, gap: size * 0.5 });
}

// 표 칸 값: 문자열, 또는 { paras: [문자열 | run 목록] } (여러 단락)
function cellParaList(val) {
  return (val && typeof val === 'object' && !Array.isArray(val) && Array.isArray(val.paras)) ? val.paras : [val];
}

function cellParas(val, size) {
  return cellParaList(val).map((p) => (Array.isArray(p)
    ? [p.map((r) => r[0]).join(''), Math.max(...p.map((r) => r[1]))]
    : [String(p ?? ''), size]));
}

function rowHeight(row, widths, size) {
  let need = 0;
  row.forEach((val, j) => {
    const w = widths[j];
    const h = cellParas(val, size).reduce((acc, [t, s]) => acc + (textLines(t, s, w - 2 * CELL_MX) * s * LINE) / 72, 0)
      + 2 * CELL_MY + 0.02;
    need = Math.max(need, h);
  });
  return need;
}

/** 표: rows는 칸 값 목록. 행 높이는 내용으로 어림해 지정한다. */
function table(slide, x, y, widths, rows, header, size = 12) {
  const heights = [rowHeight(header, widths, size), ...rows.map((r) => rowHeight(r, widths, size))];
  const data = [header, ...rows].map((row, i) => row.map((val) => {
    const paras = i === 0
      ? [[[String(val), size, theme.SURFACE, true]]]
      : cellParaList(val).map((p) => (Array.isArray(p) ? p : citeRuns(String(p ?? ''), size)));
    return {
      text: textObjs(paras, { size }),
      options: {
        fill: { color: i === 0 ? theme.ACCENT : (i % 2 ? theme.SURFACE : theme.SURFACE_ALT) },
        margin: [CELL_MY, CELL_MX, CELL_MY, CELL_MX], valign: 'middle',
      },
    };
  }));
  slide.addTable(data, {
    x, y, w: widths.reduce((a, b) => a + b, 0), colW: widths, rowH: heights,
    autoPage: false, fontFace: FONT, border: { type: 'solid', pt: 1, color: theme.SURFACE },
  });
}

/** 행을 슬라이드 단위로 나눈다(행 수 per 이하, 높이 height 이하). */
function tablePages(rows, widths, height, size, per = 6) {
  const pages = [];
  const head = rowHeight(widths.map(() => '가'), widths, size);
  let cur = [], used = head;
  for (const r of rows) {
    const h = rowHeight(r, widths, size);
    if (cur.length && (cur.length >= per || used + h > height)) {
      pages.push(cur);
      cur = [];
      used = head;
    }
    cur.push(r);
    used += h;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/** 표 칸 글을 maxLines 줄 안으로 줄인다. */
function fitCell(text, width, size, maxLines) {
  text = String(text ?? '');
  while (text.length > 8 && textLines(text, size, width - 2 * CELL_MX) > maxLines) {
    const next = clip(text, Math.floor(text.length * 0.85));
    if (next.length >= text.length) break;
    text = next;
  }
  return text;
}

// ---------------------------------------------------------------- 차트 데이터

/** 연구 유형: 많은 순으로 최대 7개 + 나머지를 합친 '기타' 한 줄. labels가 있으면 표시 이름으로 바꾼다.
 *  원래 유형이 'other'이거나 비어 있는 것도 '기타'에 합쳐 같은 이름이 두 번 나오지 않게 한다. */
export function studyTypeRows(stats, other, labels = null) {
  labels = labels || {};
  const named = [];
  let rest = 0;
  const entries = Object.entries(stats?.by_study_type || {})
    .map(([k, v]) => [String(k), parseInt(v, 10) || 0])
    .sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries) {
    if (v <= 0) continue;
    if (k === '' || k === 'other' || named.length >= 7) rest += v;
    else named.push([labels[k] ?? k, v]);
  }
  return rest ? [...named, [other, rest]] : named;
}

export function yearRows(stats) {
  return Object.entries(stats?.by_year || {}).map(([k, v]) => [String(k), parseInt(v, 10) || 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 결과 방향: [키, 개수]. 개수 0은 뺀다. */
export function directionRows(stats) {
  const d = stats?.by_direction || {};
  const keys = [...DIRECTIONS, ...Object.keys(d).filter((k) => !DIRECTIONS.includes(k))];
  return keys.map((k) => [k, parseInt(d[k], 10) || 0]).filter(([, v]) => v > 0);
}

// ---------------------------------------------------------------- 덱

class Deck {
  constructor(result, outline) {
    this.r = result;
    this.o = outline || {};
    this.lang = result.lang === 'ko' ? 'ko' : 'en';
    this.T = TXT[this.lang];
    this.pptx = new PptxGenJS();
    this.pptx.layout = 'LAYOUT_WIDE';          // 13.333 × 7.5 인치
    this.pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
    this.count = 0;
    this.topic = result.topic || result.prompt || this.o.title || '';
    this.sources = sourcesById(result);
    this.syn = (result.syntheses && typeof result.syntheses === 'object') ? result.syntheses : {};
    const plan = result.plan?.sub_questions;
    this.plan = (Array.isArray(plan) ? plan : []).filter((q) => q && typeof q === 'object');
    this.chartLabelColors = [];               // 차트 순번별 계열 데이터 레이블 색 (나중에 XML에 반영)
  }

  // --- 공통 틀
  strengthLabel(s) {
    return (this.lang === 'ko' ? theme.STRENGTH_LABEL : STRENGTH_EN)[s] ?? (s || '-');
  }

  verdictLabel(v) {
    return (this.lang === 'ko' ? theme.VERDICT_LABEL : VERDICT_EN)[v] ?? v;
  }

  directionLabel(d) {
    if (this.lang === 'ko') return theme.DIRECTION_LABEL[d] ?? d;
    return { '': 'Unclassified', 'null': 'No effect' }[d] ?? (d.charAt(0).toUpperCase() + d.slice(1).toLowerCase());
  }

  newSlide() {
    this.count += 1;
    return this.pptx.addSlide();
  }

  /** 머리말(구역 이름 · 제목 · 강조선)과 꼬리말(주제 · 쪽 번호)이 있는 슬라이드. */
  slide(kicker, title) {
    const s = this.newSlide();
    const [k, ks] = fitText(kicker, CW, KICK_H, [12]);
    textbox(s, ML, KICK_Y, CW, KICK_H, [k], { size: ks, color: theme.ACCENT, bold: true });
    const [t, ts] = fitText(title, CW, TITLE_H, TITLE_TIERS);
    textbox(s, ML, TITLE_Y, CW, TITLE_H, [t], { size: ts, color: theme.INK, bold: true, anchor: 'bottom' });
    rect(s, ML, RULE_Y, 0.9, 0.05, theme.ACCENT);
    rect(s, ML + 0.9, RULE_Y + 0.02, CW - 0.9, 0.01, theme.RULE);
    const [foot, fs] = fitText(this.topic, CW - 1.2, FOOT_H, [10]);
    textbox(s, ML, FOOT_Y, CW - 1.2, FOOT_H, [foot], { size: fs, color: theme.MUTED });
    textbox(s, W - ML - 1.0, FOOT_Y, 1.0, FOOT_H, [String(this.count)], { size: 10, color: theme.MUTED, align: 'right' });
    return s;
  }

  bulletSlides(kicker, title, items, tiers = BODY_TIERS) {
    paginate(items, CW, CH, tiers).forEach(([chunk, size], i) => {
      const s = this.slide(kicker, i === 0 ? title : `${title} ${this.T.cont}`);
      bulletBox(s, ML, TOP, CW, CH, chunk, size);
    });
  }

  chart(slide, dir, x, y, w, h, cats, series, colors, { legend = false, labelsInside = false, reverse = false, hideCats = false } = {}) {
    const data = series.map(([name, vals]) => ({ name, labels: cats, values: vals }));
    const max = Math.max(...series.flatMap(([, v]) => v), 1);
    const opts = {
      x, y, w, h,
      barDir: dir, barGrouping: labelsInside ? 'stacked' : 'clustered',
      chartColors: colors, showTitle: false,
      showLegend: legend, legendPos: 'b', legendFontSize: 11, legendFontFace: FONT, legendColor: theme.INK_2,
      showValue: true, dataLabelFormatCode: '0', dataLabelFontSize: 11, dataLabelFontFace: FONT,
      dataLabelColor: labelsInside ? theme.SURFACE : theme.INK_2,
      dataLabelPosition: labelsInside ? 'ctr' : 'outEnd',
      valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
      valAxisMinVal: 0,
      catAxisLabelFontSize: 11, catAxisLabelFontFace: FONT, catAxisLabelColor: theme.INK_2,
      catAxisLineShow: true, catAxisLineColor: theme.RULE,
      barGapWidthPct: labelsInside ? 30 : 45,
    };
    if (!labelsInside) opts.valAxisMaxVal = Math.round(max * 1.18 * 100) / 100;
    if (labelsInside) opts.barOverlapPct = 100;
    if (reverse) opts.catAxisOrientation = 'maxMin';      // 많은 것이 위로
    if (hideCats) opts.catAxisHidden = true;
    slide.addChart('bar', data, opts);
    this.chartLabelColors.push(labelsInside
      ? colors.map((c) => (DARK_LABEL_ON.has(c) ? theme.INK : theme.SURFACE))
      : null);
  }

  // --- a. 표지
  titleSlide() {
    const { T } = this;
    const m = metaInfo(this.r);
    const s = this.newSlide();
    rect(s, 0, 0, 0.22, H, theme.ACCENT);
    rect(s, 0.22, H - 0.9, W - 0.22, 0.9, theme.SURFACE_ALT);
    textbox(s, 1.0, 0.9, 8.0, 0.4, [T.product], { size: 14, color: theme.ACCENT, bold: true });
    const [title, size] = fitText(this.o.title || this.topic, 11.3, 2.7, [40, 36, 32, 28, 24]);
    textbox(s, 1.0, 1.55, 11.3, 2.7, [title], { size, color: theme.INK, bold: true, anchor: 'bottom' });
    rect(s, 1.0, 4.45, 1.2, 0.06, theme.ACCENT);
    if (this.o.subtitle) {
      const [sub, ss] = fitText(this.o.subtitle, 11.3, 0.9, [20, 18, 16]);
      textbox(s, 1.0, 4.7, 11.3, 0.9, [sub], { size: ss, color: theme.INK_2 });
    }
    const parts = [m.date, m.model, `${T.collected} ${num(m.collected)}${T.unit}`,
      `${T.inc} ${num(m.included)}${T.unit}`, `${T.window}: ${m.window}`];
    const [line, ls] = fitText(parts.filter(Boolean).join(' · '), 11.3, 0.62, [13, 12]);
    textbox(s, 1.0, H - 0.78, 11.3, 0.62, [line], { size: ls, color: theme.INK_2, anchor: 'middle' });
  }

  // --- b. 핵심 요약
  summary() {
    const items = this.o.summary || [];
    if (items.length) this.bulletSlides(this.T.summary_k, this.T.summary_t, items);
    else {
      const s = this.slide(this.T.summary_k, this.T.summary_t);
      textbox(s, ML, TOP, CW, 0.5, [this.T.none], { size: 16, color: theme.MUTED });
    }
  }

  // --- c. 연구 설계
  design() {
    const { T } = this;
    const m = metaInfo(this.r);
    const s = this.slide(T.design_k, T.design_t);
    textbox(s, ML, TOP, CW, 0.36, [T.pipeline], { size: 13, color: theme.MUTED, bold: true });
    let gap = 0.12, n = T.stages.length;
    const cw = (CW - gap * (n - 1)) / n, cy = TOP + 0.45, chh = 1.3;
    rect(s, ML, cy + chh / 2 - 0.01, CW, 0.02, theme.RULE);
    T.stages.forEach(([label, desc], i) => {
      const x = ML + i * (cw + gap);
      shapeText(s, x, cy, cw, chh, theme.ACCENT_SOFT,
        [[[String(i + 1).padStart(2, '0'), 11, theme.ACCENT, true]], [[label, 14, theme.INK, true]], [[desc, 10, theme.INK_2, false]]],
        { align: 'center', anchor: 'middle' });
    });
    const ty = TOP + 2.15;
    textbox(s, ML, ty, CW, 0.36, [T.scale], { size: 13, color: theme.MUTED, bold: true });
    const vals = [m.collected, m.included, m.merged, m.calls, m.minutes];
    gap = 0.2;
    n = vals.length;
    const tw = (CW - gap * (n - 1)) / n;
    vals.forEach((v, i) => {
      const x = ML + i * (tw + gap);
      shapeText(s, x, ty + 0.45, tw, 1.35, theme.SURFACE_ALT,
        [[[num(v), 30, theme.ACCENT_DARK, true]], [[T.tiles[i], 12, theme.INK_2, false]]],
        { align: 'center', anchor: 'middle' });
    });
    const disabled = this.r.meta?.disabled_tools || [];
    const parts = [`${T.n_subq} ${this.plan.length}${T.unit_q}`, `${T.window}: ${m.window}`, `${T.model}: ${m.model || '-'}`];
    if (disabled.length) parts.push(`${T.disabled}: ${disabled.map(String).join(', ')}`);
    const [line, ls] = fitText(parts.join(' · '), CW, 0.6, [14, 13, 12]);
    textbox(s, ML, BOTTOM - 0.6, CW, 0.6, [line], { size: ls, color: theme.INK_2 });
  }

  // --- d. 하위 질문 표
  subquestions() {
    const { T } = this;
    if (!this.plan.length) return;
    const widths = [0.9, 2.9, CW - 3.8];
    const rows = this.plan.map((q) => [clip(q.id, 8), fitCell(clip(q.perspective, 80), widths[1], 12, 3),
      fitCell(clip(q.question, 260), widths[2], 12, 5)]);
    tablePages(rows, widths, CH, 12).forEach((page, i) => {
      const s = this.slide(T.subq_k, i === 0 ? T.subq_t : `${T.subq_t} ${T.cont}`);
      table(s, ML, TOP, widths, page, T.cols_q);
    });
  }

  // --- e. 근거 프로필
  evidence() {
    const { T } = this;
    const stats = this.r.stats || {};
    const labels = this.lang === 'ko' ? theme.STUDY_TYPE_LABEL : null;
    const studies = studyTypeRows(stats, T.other, labels), years = yearRows(stats), dirs = directionRows(stats);
    if (!(studies.length || years.length || dirs.length)) return;
    const s = this.slide(T.ev_k, T.ev_t);
    const lw = 6.2, rx = ML + 6.6, rw = CW - 6.6;
    const title = (x, y, w, text) => textbox(s, x, y, w, 0.4, [text], { size: 14, color: theme.INK, bold: true });
    const empty = (x, y, w) => textbox(s, x, y, w, 0.4, [T.none], { size: 12, color: theme.MUTED });

    title(ML, TOP, lw, T.study);
    if (studies.length) {
      this.chart(s, 'bar', ML, TOP + 0.45, lw, CH - 0.45, studies.map(([k]) => k),
        [[T.included, studies.map(([, v]) => v)]], [theme.SEQUENTIAL], { reverse: true });
    } else empty(ML, TOP + 0.45, lw);
    title(rx, TOP, rw, T.year);
    if (years.length) {
      this.chart(s, 'col', rx, TOP + 0.45, rw, 2.2, years.map(([k]) => k),
        [[T.included, years.map(([, v]) => v)]], [theme.SEQUENTIAL]);
    } else empty(rx, TOP + 0.45, rw);
    title(rx, TOP + 2.85, rw, T.direction);
    if (dirs.length) {
      this.chart(s, 'bar', rx, TOP + 3.3, rw, CH - 3.3, [T.included],
        dirs.map(([k, v]) => [this.directionLabel(k), [v]]),
        dirs.map(([k]) => theme.DIRECTION_COLOR[k] ?? theme.NEUTRAL_FILL),
        { legend: true, labelsInside: true, hideCats: true });
    } else empty(rx, TOP + 3.3, rw);
  }

  // --- f. 하위 질문별 결과
  findings() {
    const { T } = this;
    const plan = Object.fromEntries(this.plan.map((q) => [q.id, q]));
    const bw = 8.4, px = ML + 8.8, pw = CW - 8.8;
    for (const f of this.o.findings || []) {
      const qid = f.subq_id || '';
      const q = plan[f.subq_id] || {};
      const syn = this.syn[qid] || {};
      const kicker = stripChars(`${qid} · ${cleanOne(q.question || q.perspective || '')}`, ' ·');
      const headline = f.headline || qid;
      let pages = paginate(f.bullets || [], bw, CH, BODY_TIERS);
      if (!pages.length) pages = [[[], BODY_TIERS[0]]];
      pages.forEach(([chunk, size], i) => {
        const s = this.slide(kicker, i === 0 ? headline : `${headline} ${T.cont}`);
        if (chunk.length) bulletBox(s, ML, TOP, bw, CH, chunk, size);
        this.strengthPanel(s, px, pw, f, syn, q);
        const notes = syn.answer || '';
        if (notes) s.addNotes(String(notes));
      });
    }
  }

  strengthPanel(s, x, w, f, syn, q) {
    const { T } = this;
    rect(s, x, TOP, w, 1.75, theme.SURFACE_ALT, true);
    textbox(s, x + 0.2, TOP + 0.15, w - 0.4, 0.34, [T.strength], { size: 12, color: theme.MUTED, bold: true });
    const st = f.strength || 'insufficient';
    shapeText(s, x + 0.2, TOP + 0.55, 1.6, 0.5, STRENGTH_COLOR[st] || theme.MUTED, [this.strengthLabel(st)],
      { size: 16, color: theme.SURFACE, bold: true, align: 'center', anchor: 'middle' });
    const n = arr(syn.sources).length;
    textbox(s, x + 0.2, TOP + 1.2, w - 0.4, 0.36, [`${T.related} ${n}${T.unit_src}`], { size: 12, color: theme.INK_2 });
    const question = cleanOne(q.question || '');
    if (question) {
      const y = TOP + 1.95, h = CH - 1.95;
      rect(s, x, y, w, h, theme.SURFACE, true, theme.RULE);
      textbox(s, x + 0.2, y + 0.12, w - 0.4, 0.34, [T.subq], { size: 12, color: theme.MUTED, bold: true });
      const [text, size] = fitText(question, w - 0.4, h - 0.6, [13, 12, 11]);
      textbox(s, x + 0.2, y + 0.48, w - 0.4, h - 0.6, [text], { size, color: theme.INK_2 });
    }
  }

  // --- g. 일치와 상충
  agreement() {
    const { T } = this;
    const agree = this.o.agreements || [], conflict = this.o.conflicts || [];
    if (!(agree.length || conflict.length)) return;
    const cw = (CW - 0.4) / 2;
    const iw = cw - 0.5, ih = CH - 0.85;
    const tiers = [16, 14];          // 두 칸이라 좁으므로, 14pt로도 넘치면 다음 슬라이드로 넘긴다
    const pa = paginate(agree, iw, ih, tiers, 4), pc = paginate(conflict, iw, ih, tiers, 4);
    for (let i = 0; i < Math.max(pa.length, pc.length); i += 1) {
      const s = this.slide(T.agree_k, i === 0 ? T.agree_t : `${T.agree_t} ${T.cont}`);
      const sizes = [pa, pc].filter((p) => i < p.length).map((p) => p[i][1]);
      [[T.agree, pa, theme.ACCENT], [T.conflict, pc, theme.INK_2]].forEach(([label, pages, color], j) => {
        const x = ML + j * (cw + 0.4);
        rect(s, x, TOP, cw, CH, theme.SURFACE_ALT, true);
        rect(s, x + 0.25, TOP + 0.2, 0.5, 0.06, color);
        textbox(s, x + 0.25, TOP + 0.3, iw, 0.42, [label], { size: 16, color, bold: true });
        if (i < pages.length) bulletBox(s, x + 0.25, TOP + 0.8, iw, ih, pages[i][0], Math.min(...sizes));
      });
    }
  }

  // --- h. 연구 공백
  gaps() {
    if ((this.o.gaps || []).length) this.bulletSlides(this.T.gaps_k, this.T.gaps_t, this.o.gaps);
  }

  // --- i. 향후 연구
  future() {
    const { T } = this;
    const studies = (this.o.future_studies || []).filter((st) => st && typeof st === 'object');
    if (!studies.length) return;
    const cw = (CW - 0.3 * (studies.length - 1)) / studies.length;
    const iw = cw - 0.4;
    const cardParas = (st, size) => {
      const paras = [[[String(st.title || ''), size + 2, theme.INK, true]]];
      for (const [key, label] of T.fields) {
        if (st[key]) paras.push([[label, size - 1, theme.ACCENT, true]], [[String(st[key]), size, theme.INK_2, false]]);
      }
      return paras;
    };
    const fits = (st, size) => {
      const flat = cardParas(st, size).map((p) => [p.map((r) => r[0]).join(''), p[0][1]]);
      return textHeight(flat, iw, 4) <= CH - 0.3;
    };
    const size = [13, 12, 11].find((sz) => studies.every((st) => fits(st, sz)));
    if (size) {
      const s = this.slide(T.future_k, T.future_t);
      studies.forEach((st, i) => {
        const x = ML + i * (cw + 0.3);
        rect(s, x, TOP, cw, CH, theme.SURFACE_ALT, true);
        rect(s, x + 0.2, TOP + 0.15, 0.5, 0.06, theme.ACCENT);
        textbox(s, x + 0.2, TOP + 0.25, iw, CH - 0.35, cardParas(st, size), { gap: 4 });
      });
      return;
    }
    studies.forEach((st, i) => {      // 글이 길면 연구 하나에 슬라이드 하나
      const s = this.slide(`${T.future_k} ${i + 1}/${studies.length}`, String(st.title || ''));
      const fields = T.fields.filter(([key]) => st[key]).map(([key, label]) => [label, String(st[key])]);
      const colw = (CW - 0.4) / 2;
      fields.forEach(([label, text], j) => {
        const x = ML + (j % 2) * (colw + 0.4), y = TOP + Math.floor(j / 2) * (CH / 2);
        const bh = CH / 2 - 0.2;
        rect(s, x, y, colw, bh, theme.SURFACE_ALT, true);
        textbox(s, x + 0.2, y + 0.12, colw - 0.4, 0.38, [label], { size: 13, color: theme.ACCENT, bold: true });
        const [body, bs] = fitText(text, colw - 0.4, bh - 0.62, [18, 16, 14, 13]);
        textbox(s, x + 0.2, y + 0.52, colw - 0.4, bh - 0.62, [body], { size: bs, color: theme.INK });
      });
    });
  }

  // --- j. 필독 문헌
  mustRead() {
    const { T } = this;
    const items = (this.o.must_read || []).filter((m) => m && typeof m === 'object');
    const widths = [0.8, 5.4, CW - 6.2];
    const rows = items.map((m, i) => {
      const src = this.sources[m.sid] || {};
      const cite = `[${m.sid}] ${shortCite(src)}`;
      const title = fitCell(clip(src.title, 140), widths[1], 11, 3);
      return [String(i + 1), { paras: [[[cite, 12, theme.INK, true]], [[title, 11, theme.INK_2, false]]] },
        fitCell(m.why || '', widths[2], 12, 4)];
    });
    if (!rows.length) return;
    tablePages(rows, widths, CH, 12).forEach((page, i) => {
      const s = this.slide(T.must_k, i === 0 ? T.must_t : `${T.must_t} ${T.cont}`);
      table(s, ML, TOP, widths, page, T.cols_m);
    });
  }

  // --- k. 한계와 인용 검증
  limitations() {
    const { T } = this;
    const lw = 7.3, px = ML + 7.7, pw = CW - 7.7;
    let pages = paginate(this.o.limitations || [], lw, CH, [...SMALL_TIERS, 11]);
    if (!pages.length) pages = [[[], 14]];
    pages.forEach(([chunk, size], i) => {
      const s = this.slide(T.lim_k, i === 0 ? T.lim_t : `${T.lim_t} ${T.cont}`);
      if (chunk.length) bulletBox(s, ML, TOP, lw, CH, chunk, size);
      else textbox(s, ML, TOP, lw, 0.5, [T.no_lim], { size: 16, color: theme.MUTED });
      this.checkPanel(s, px, pw);
    });
  }

  checkPanel(s, x, w) {
    const { T } = this;
    const v = this.r.verification || {};
    const checks = (Array.isArray(v.checks) ? v.checks : []).filter((c) => c && typeof c === 'object');
    rect(s, x, TOP, w, CH, theme.SURFACE_ALT, true);
    textbox(s, x + 0.25, TOP + 0.15, w - 0.5, 0.42, [T.check], { size: 16, color: theme.INK, bold: true });
    const figs = [v.cited_ids || 0, arr(v.unknown_ids).length, checks.length];
    const fw = (w - 0.5) / 3;
    T.fig.forEach((label, i) => {
      textbox(s, x + 0.25 + i * fw, TOP + 0.65, fw, 0.95,
        [[[num(figs[i]), 24, theme.ACCENT_DARK, true]], [[label, 11, theme.MUTED, false]]]);
    });
    const before = verdictTally(checks), after = verdictTally(checks, true);
    const y = TOP + 1.85, cols = [w - 0.5 - 2.0, 1.0, 1.0];
    const hx = [x + 0.25, x + 0.25 + cols[0], x + 0.25 + cols[0] + cols[1]];
    [T.verdict, T.before, T.after].forEach((label, j) => {
      textbox(s, hx[j], y, cols[j], 0.34, [label], { size: 11, color: theme.MUTED, bold: true, align: j === 0 ? 'left' : 'right' });
    });
    rect(s, x + 0.25, y + 0.38, w - 0.5, 0.01, theme.RULE);
    VERDICTS.forEach((key, i) => {
      const ry = y + 0.48 + i * 0.5;
      rect(s, hx[0], ry + 0.12, 0.14, 0.14, theme.VERDICT_COLOR[key]);
      textbox(s, hx[0] + 0.22, ry, cols[0] - 0.22, 0.4, [this.verdictLabel(key)], { size: 13, color: theme.INK });
      textbox(s, hx[1], ry, cols[1], 0.4, [String(before[key])], { size: 13, color: theme.INK_2, align: 'right' });
      textbox(s, hx[2], ry, cols[2], 0.4, [String(after[key])], { size: 13, color: theme.INK, bold: true, align: 'right' });
    });
  }

  // --- l. 참고문헌
  references() {
    const { T } = this;
    const texts = [this.o.title || '', this.o.subtitle || ''];
    for (const key of ['summary', 'agreements', 'conflicts', 'gaps', 'limitations']) texts.push(...(this.o[key] || []));
    for (const f of this.o.findings || []) texts.push(f.headline || '', ...(f.bullets || []));
    for (const st of this.o.future_studies || []) texts.push(...Object.values(st || {}).map(String));
    const ids = new Set(citedIds(texts.map(String).join('\n')));
    for (const m of this.o.must_read || []) if (m?.sid) ids.add(m.sid);
    const sorted = [...ids].filter((i) => this.sources[i]).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
    if (!sorted.length) return;
    const entries = sorted.map((sid) => {
      const src = this.sources[sid];
      const body = `${authorsText(src) || src.venue || 'n.a.'} (${src.year || 'n.d.'}). ${src.title || ''}. ${src.venue || ''}`.trim();
      return `[${sid}] ` + clip(body.replace(/[. ]+$/, '') + '.', 230);
    });
    paginate(entries, CW, CH, [13, 12, 11], 9).forEach(([chunk, size], i) => {
      const s = this.slide(T.refs_k, i === 0 ? T.refs_t : `${T.refs_t} ${T.cont}`);
      const paras = chunk.map((line) => {
        const m = /^(\[S\d+\] )([\s\S]*)$/.exec(line);
        return m ? [[m[1], size, theme.ACCENT, true], [m[2], size, theme.INK, false]] : [[line, size, theme.INK, false]];
      });
      textbox(s, ML, TOP, CW, CH, paras, { gap: size * 0.5 });
    });
  }

  async build() {
    this.pptx.title = clip(this.topic, 200);
    this.pptx.author = 'AI Research Agent';
    this.pptx.company = 'AI Research Agent';
    for (const step of ['titleSlide', 'summary', 'design', 'subquestions', 'evidence', 'findings',
      'agreement', 'gaps', 'future', 'mustRead', 'limitations', 'references']) {
      this[step]();
    }
    const raw = await this.pptx.write({ outputType: 'uint8array' });
    return patchPackage(raw, this.chartLabelColors);
  }
}

// ---------------------------------------------------------------- 만든 뒤 XML 손질

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// latin 뒤에 ea · cs가 이미 있을 수 있다(범례는 latin + cs). 스키마 순서 latin → ea → cs를 지키고 겹치지 않게 한다
const LATIN_RUN = new RegExp(`<a:latin typeface="${esc(FONT)}"([^>]*)/>(\\s*<a:ea\\b[^>]*/>)?(\\s*<a:cs\\b[^>]*/>)?`, 'g');
const addEastAsian = (all, attrs, ea, cs) => (ea ? all
  : `<a:latin typeface="${FONT}"${attrs}/><a:ea typeface="${FONT}"/>${cs ? cs.trim() : `<a:cs typeface="${FONT}"/>`}`);

/** pptxgenjs 결과 zip을 고친다: 차트 글자에 동아시아 글꼴, 글머리 기호 색, 쌓은 막대의 계열별 레이블 색. */
async function patchPackage(raw, chartLabelColors) {
  const zip = await JSZip.loadAsync(raw);
  const names = Object.keys(zip.files);
  for (const name of names) {
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/.test(name);
    const chartNo = /^ppt\/charts\/chart(\d+)\.xml$/.exec(name);
    if (!isSlide && !chartNo) continue;
    let xml = await zip.file(name).async('string');
    const before = xml;
    // 라틴 글꼴만 지정된 곳에 동아시아 · 복합 글꼴을 붙인다 (한글이 대체 글꼴로 나오지 않게)
    xml = xml.replace(LATIN_RUN, addEastAsian);
    if (isSlide) {
      xml = xml.replace(/<a:buSzPct val="100000"\/><a:buChar /g,
        `<a:buClr><a:srgbClr val="${theme.ACCENT}"/></a:buClr><a:buSzPct val="100000"/><a:buChar `);
    }
    if (chartNo) {
      const colors = chartLabelColors[parseInt(chartNo[1], 10) - 1];
      if (colors) {
        let k = 0;
        xml = xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
          const c = colors[k++];
          if (!c) return ser;
          return ser.replace(/(<c:dLbls>[\s\S]*?<c:txPr>[\s\S]*?<a:defRPr[^>]*>\s*<a:solidFill>\s*<a:srgbClr val=")[0-9A-Fa-f]{6}/,
            `$1${c}`);
        });
      }
    }
    if (xml !== before) zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** result(PYTHON_SPEC 3.2)와 슬라이드 개요로 발표 슬라이드를 만들어 바이트(Uint8Array)로 돌려준다.
 *  outline이 null이면 규칙 기반 개요(fallbackOutline)를 쓴다. */
export async function buildPptx(result, outline = null) {
  result = (result && typeof result === 'object') ? result : {};
  const o = outline ? normalizeOutline(outline, result) : fallbackOutline(result);
  return new Deck(result, o).build();
}

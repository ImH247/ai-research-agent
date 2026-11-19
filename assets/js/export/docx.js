// Word(.docx) 보고서 내보내기. result 객체(PYTHON_SPEC 3.2) 하나로 표지 · 목차 · 본문 · 부록 A~D를 만든다.
// 원본: docs/reference/python/exporters/docx_export.py (python-docx) → vendor/docx.js
//
// - 본문 Markdown은 정규식이 아니라 markdown-it 토큰을 차례로 읽어 Word 단락 · 목록 · 표로 바꾼다.
// - [S12] 같은 인용은 부록 B 참고문헌 항목의 책갈피(ref_S12)로 가는 문서 내부 링크가 된다.
// - 목차는 Word가 채우는 TOC 필드다(문서를 열 때 필드 업데이트를 묻도록 설정).
// - 한글 · 영문 글꼴은 모두 '맑은 고딕'(동아시아 글꼴 포함)으로 직접 지정한다.
import {
  Document, Packer, Paragraph, TextRun, Tab, Table, TableRow, TableCell, ExternalHyperlink,
  InternalHyperlink, Bookmark, Header, Footer, PageNumber, TableOfContents,
} from '../../../vendor/docx.js';
import MarkdownIt from '../../../vendor/markdown-it.js';
import {
  VERDICTS, citeReGlobal, labels, includedSources, referenceSources, metaInfo, verdictTally,
  shortCite, authorsText, fmtInt,
} from './common.js';
import {
  ACCENT, ACCENT_DARK, DIRECTION_LABEL, FONT_KO, FONT_MONO, INK, INK_2, KIND_LABEL, MUTED, RULE,
  SURFACE_ALT, VERDICT_COLOR, VERDICT_LABEL,
} from './theme.js';

const MD = new MarkdownIt('commonmark', { html: false }).enable('table');
// XML 1.0에서 쓸 수 없는 문자 (짝이 없는 서로게이트 포함)
const BAD_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udfff]/gu;
const BR_RE = /<br\s*\/?>/gi;            // 표 칸 안의 <br> (이스케이프된 것도 토큰에서는 같은 글자)
const SID_FULL = /^S\d+$/;

const CM = 566.929;                       // 1cm = 566.9 twip
const tw = (cm) => Math.round(cm * CM);
const PAGE_W = 21.0, PAGE_H = 29.7, MARGIN = 2.2;   // A4, cm
const TEXT_W = PAGE_W - 2 * MARGIN;                  // 세로 페이지 본문 폭 16.6cm
// 제목 수준별 (글자 크기 pt, 색, 앞 간격 pt, 뒤 간격 pt)
const HEADING = { 1: [20, ACCENT_DARK, 18, 8], 2: [15, ACCENT_DARK, 16, 6], 3: [12.5, INK, 12, 4], 4: [11, INK_2, 10, 3] };
const LIST_INDENT = 425, LIST_HANG = 283;           // 목록 수준별 들여쓰기 · 내어쓰기 (twip)

const KO = { ascii: FONT_KO, hAnsi: FONT_KO, eastAsia: FONT_KO, cs: FONT_KO };
const MONO = { ascii: FONT_MONO, hAnsi: FONT_MONO, eastAsia: FONT_KO, cs: FONT_MONO };

// 이 형식에만 필요한 문구 (나머지는 common.labels)
const TEXT = {
  ko: {
    duration: '소요 시간', tokens_fmt: (i, o) => `입력 ${i} · 출력 ${o}`, calls_fmt: (n) => `${n}회`, count_fmt: (a, b) => `${a} / ${b}건`,
    toc_wait: '(목차를 만들려면 필드를 업데이트하세요)',
    toc_hint: "목차가 비어 있거나 쪽 번호가 맞지 않으면 목차를 마우스 오른쪽 단추로 누르고 '필드 업데이트'를 고르세요.",
    empty_body: '보고서 본문이 없습니다.', no_sources: '채택된 문헌이 없습니다.', no_checks: '검증한 문장이 없습니다.',
    no_trace: '수행 기록이 없습니다.', verdict: '판정', unknown: '목록에 없는 인용 ID', cites: (n) => `피인용 ${n}회`,
    trace_cols: ['시각', '단계', '내용'],
  },
  en: {
    duration: 'Duration', tokens_fmt: (i, o) => `in ${i} · out ${o}`, calls_fmt: (n) => `${n}`, count_fmt: (a, b) => `${a} / ${b}`,
    toc_wait: '(update fields to build the table of contents)',
    toc_hint: "If the contents are empty or page numbers are wrong, right-click the table of contents and choose 'Update Field'.",
    empty_body: 'The report body is empty.', no_sources: 'No included sources.', no_checks: 'No claims were checked.',
    no_trace: 'No trace recorded.', verdict: 'Verdict', unknown: 'Cited ids not in the list', cites: (n) => `cited by ${n}`,
    trace_cols: ['Time', 'Stage', 'Message'],
  },
};
const STAGE_KO = {
  understand: '주제 이해', plan: '계획 수립', act: '자료 탐색', evaluate: '문헌 평가', synthesize: '종합',
  reflect: '비평', report: '보고서 작성', verify: '인용 검증', export: '내보내기', system: '시스템',
};

/** XML에 넣을 수 없는 제어 문자를 지운 문자열. */
function clean(text) {
  return (text === null || text === undefined ? '' : String(text)).replace(BAD_XML, '');
}

function num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? fmtInt(v) : clean(v);
}

const isHttp = (url) => url.startsWith('http://') || url.startsWith('https://');

// ---------- 낮은 수준 헬퍼 ----------

/** run 서식. fmt: bold, italic, code, color, size(pt), underline */
function runOpts(fmt) {
  const o = { font: fmt.code ? MONO : KO };
  if (fmt.bold) o.bold = true;
  if (fmt.italic) o.italics = true;
  if (fmt.color) o.color = fmt.color;
  if (fmt.size) o.size = Math.round(fmt.size * 2);
  if (fmt.underline) o.underline = { type: 'single' };
  if (fmt.code) o.shading = { type: 'clear', color: 'auto', fill: SURFACE_ALT };
  return o;
}

/** 글을 TextRun 목록으로. 글 속 \n은 줄바꿈, \t는 탭. */
function runs(text, fmt = {}) {
  const o = runOpts(fmt);
  const out = [];
  clean(text).split('\n').forEach((line, k) => {
    const children = [];
    line.split('\t').forEach((piece, j) => {
      if (j) children.push(new Tab());
      if (piece) children.push(piece);
    });
    if (k || children.length) out.push(new TextRun(k ? { ...o, break: 1, children } : { ...o, children }));
  });
  return out;
}

const border = (color = RULE, size = 6, space = 1) => ({ style: 'single', size, color, space });
const shade = (fill = SURFACE_ALT) => ({ type: 'clear', color: 'auto', fill });

/** 단락 서식 (python _pfmt와 같은 단위: pt · cm) → docx 단락 옵션 */
function paraOpts(f) {
  const o = {};
  const spacing = {};
  if (f.before !== undefined) spacing.before = Math.round(f.before * 20);
  if (f.after !== undefined) spacing.after = Math.round(f.after * 20);
  if (f.line !== undefined) { spacing.line = Math.round(f.line * 240); spacing.lineRule = 'auto'; }
  if (Object.keys(spacing).length) o.spacing = spacing;
  const indent = {};
  if (f.leftTw !== undefined) indent.left = f.leftTw;
  else if (f.left !== undefined) indent.left = tw(f.left);
  if (f.first !== undefined) {
    if (f.first < 0) indent.hanging = tw(-f.first);
    else indent.firstLine = tw(f.first);
  }
  if (Object.keys(indent).length) o.indent = indent;
  if (f.keep) o.keepNext = true;
  if (f.align) o.alignment = f.align;
  if (f.heading) o.heading = `Heading${f.heading}`;
  if (f.pageBreakBefore) o.pageBreakBefore = true;
  if (f.border) o.border = f.border;
  if (f.shading) o.shading = f.shading;
  if (f.numbering) o.numbering = f.numbering;
  return o;
}

/** 채워 가는 단락. 문서에 넣을 때(build) docx Paragraph가 된다. */
class P {
  constructor(fmt = {}) {
    this.fmt = fmt;
    this.kids = [];
  }

  build() {
    return new Paragraph({ ...paraOpts(this.fmt), children: this.kids });
  }
}

// ---------- 문서 작성기 ----------

class Writer {
  constructor(result) {
    // 문헌은 S 번호가 올바른 객체만 쓴다 (이상한 항목 때문에 공통 헬퍼가 죽지 않게)
    const sources = (Array.isArray(result.sources) ? result.sources : [])
      .filter((s) => s && typeof s === 'object' && SID_FULL.test(String(s.sid ?? '')));
    this.result = { ...result, sources };
    this.L = labels(this.result);
    this.T = TEXT[this.result.lang] || TEXT.en;
    this.included = includedSources(this.result);
    this.refs = referenceSources(this.result);
    this.refIds = new Set(this.refs.map((s) => s.sid));
    this.breakNext = false;
    this.sections = [];
    this.blocks = null;
    this.numbering = new Map();     // reference → 번호 정의
    this.listCount = 0;
    this.newSection(false);
  }

  // --- 구역 ---
  newSection(landscape) {
    this.blocks = [];
    this.sections.push({ landscape, blocks: this.blocks });
  }

  sectionHeader() {
    // 머리말: 짧은 주제, 꼬리말: 가운데 쪽 번호
    const topic = clean(this.result.topic || '');
    const short = [...topic].length <= 40 ? topic : [...topic].slice(0, 39).join('').trimEnd() + '…';
    const header = new Header({
      children: [new Paragraph({
        ...paraOpts({ after: 0, line: 1.0, border: { bottom: border(RULE, 4, 4) } }),
        children: runs(short, { size: 8.5, color: MUTED }),
      })],
    });
    const footer = new Footer({
      children: [new Paragraph({
        ...paraOpts({ after: 0, line: 1.0, align: 'center' }),
        children: [new TextRun({ ...runOpts({ size: 9, color: MUTED }), children: [PageNumber.CURRENT] })],
      })],
    });
    return { headers: { default: header }, footers: { default: footer } };
  }

  // --- 단락 · 인라인 ---
  para(fmt = {}) {
    const p = new P({ ...fmt });
    if (this.breakNext) {
      p.fmt.pageBreakBefore = true;
      this.breakNext = false;
    }
    this.blocks.push(p);
    return p;
  }

  /** 문헌 번호 → 참고문헌 책갈피로 가는 내부 링크 */
  citeLink(sid, fmt) {
    return new InternalHyperlink({ anchor: `ref_${sid}`, children: runs(sid, { ...fmt, color: ACCENT, underline: false }) });
  }

  /** 외부 링크(http/https만). 그 외 주소는 그냥 글자로 둔다. */
  link(kids, url, text, fmt) {
    url = clean(url).trim();
    if (!isHttp(url)) {
      kids.push(...runs(text, fmt));
      return;
    }
    kids.push(new ExternalHyperlink({ link: url, children: runs(text, { ...fmt, color: ACCENT, underline: true }) }));
  }

  /** 글자를 run으로 넣는다. <br>은 줄바꿈, 참고문헌에 있는 [S12]는 내부 링크. */
  text(kids, s, fmt, cite = true) {
    s = clean(s).replace(BR_RE, '\n');
    if (!cite) {
      kids.push(...runs(s, fmt));
      return;
    }
    let pos = 0;
    for (const m of s.matchAll(citeReGlobal())) {
      if (m.index > pos) kids.push(...runs(s.slice(pos, m.index), fmt));
      const ids = m[0].match(/S\d+/g) || [];
      kids.push(...runs('[', fmt));
      ids.forEach((sid, k) => {
        if (k) kids.push(...runs(', ', fmt));
        if (this.refIds.has(sid)) kids.push(this.citeLink(sid, fmt));
        else kids.push(...runs(sid, fmt));
      });
      kids.push(...runs(']', fmt));
      pos = m.index + m[0].length;
    }
    if (pos < s.length) kids.push(...runs(s.slice(pos), fmt));
  }

  /** markdown-it 인라인 토큰(굵게 · 기울임 · 코드 · 링크 · 줄바꿈)을 단락 p에 넣는다. */
  inline(p, children, base = {}) {
    base = { ...(base || {}) };
    const fmt = { ...base };
    const buf = [];
    let target = p.kids;
    let link = null;
    const flush = () => {
      if (buf.length) {
        this.text(target, buf.join(''), { ...fmt }, link === null);
        buf.length = 0;
      }
    };
    const closeLink = () => {
      if (link && link.kids.length) p.kids.push(new ExternalHyperlink({ link: link.url, children: link.kids }));
      link = null;
      target = p.kids;
    };
    for (const c of children || []) {
      const typ = c.type;
      if (typ === 'text' || typ === 'text_special' || typ === 'html_inline') buf.push(c.content);
      else if (typ === 'softbreak') buf.push(' ');
      else if (typ === 'hardbreak') buf.push('\n');
      else if (typ === 'image') buf.push(c.content);
      else {
        flush();
        if (typ === 'strong_open') fmt.bold = true;
        else if (typ === 'strong_close') fmt.bold = base.bold || false;
        else if (typ === 'em_open') fmt.italic = true;
        else if (typ === 'em_close') fmt.italic = base.italic || false;
        else if (typ === 'code_inline') target.push(...runs(c.content, { ...fmt, code: true }));
        else if (typ === 'link_open') {
          const url = clean(c.attrGet('href') || '').trim();
          if (isHttp(url) && link === null) {
            link = { url, kids: [] };
            target = link.kids;
            fmt.color = ACCENT;
            fmt.underline = true;
          }
        } else if (typ === 'link_close' && link !== null) {
          closeLink();
          fmt.color = base.color;
          fmt.underline = false;
        }
      }
    }
    flush();
    if (link) closeLink();
  }

  /** 짧은 Markdown 글(검증 문장 등)을 인라인으로 해석해 넣는다. */
  inlineMd(p, text, base = {}) {
    const tokens = text ? MD.parseInline(clean(text), {}) : [];
    this.inline(p, tokens.length ? tokens[0].children : [], base);
  }

  // --- 목록 번호 정의 ---
  levels(ordered, startLevel = -1, start = 1) {
    return [0, 1, 2].map((i) => ({
      level: i,
      format: ordered ? ['decimal', 'lowerLetter', 'lowerRoman'][i] : 'bullet',
      text: ordered ? `%${i + 1}.` : '•◦▪'[i],
      alignment: 'left',
      start: i === startLevel ? start : 1,
      style: {
        paragraph: { indent: { left: LIST_INDENT * (i + 1), hanging: LIST_HANG } },
        run: { font: KO, color: ordered ? INK_2 : ACCENT },
      },
    }));
  }

  /** 글머리표 목록은 번호 정의 하나를 같이 쓰고, 번호 목록은 목록마다 새로 시작한다. */
  listNum(ordered, level, start) {
    if (!ordered) {
      if (!this.numbering.has('bullet')) this.numbering.set('bullet', { reference: 'bullet', levels: this.levels(false) });
      return { reference: 'bullet', instance: 0 };
    }
    const ref = start === 1 ? 'ordered' : `ordered_${level}_${start}`;
    if (!this.numbering.has(ref)) {
      this.numbering.set(ref, { reference: ref, levels: start === 1 ? this.levels(true) : this.levels(true, level, start) });
    }
    this.listCount += 1;
    return { reference: ref, instance: this.listCount };
  }

  // --- 본문 Markdown ---
  markdown(text) {
    const tokens = MD.parse(clean(text), {});
    const lists = [];        // [{num, first}] 바깥 → 안쪽
    let quote = 0;
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      const typ = t.type;
      if (typ === 'heading_open') {
        const level = Math.min(parseInt(t.tag.slice(1), 10) || 1, 4);
        const p = this.para({ heading: level });
        this.inline(p, tokens[i + 1]?.children);
        i += 3;
        continue;
      }
      if (typ === 'paragraph_open') {
        const p = this.para();
        this.block(p, lists, quote);
        this.inline(p, tokens[i + 1]?.children, quote ? { color: MUTED } : {});
        i += 3;
        continue;
      }
      if (typ === 'table_open') {
        let j = i;
        while (j < tokens.length && tokens[j].type !== 'table_close') j += 1;
        this.mdTable(tokens.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (typ === 'bullet_list_open' || typ === 'ordered_list_open') {
        const level = Math.min(lists.length, 2);
        const ordered = typ === 'ordered_list_open';
        const start = ordered ? (parseInt(t.attrGet('start') || '1', 10) || 1) : 1;
        lists.push({ num: this.listNum(ordered, level, start), first: true });
      } else if (typ === 'bullet_list_close' || typ === 'ordered_list_close') {
        lists.pop();
      } else if (typ === 'list_item_open' && lists.length) {
        lists[lists.length - 1].first = true;
      } else if (typ === 'blockquote_open') {
        quote += 1;
      } else if (typ === 'blockquote_close') {
        quote -= 1;
      } else if (typ === 'fence' || typ === 'code_block') {
        this.code(t.content, lists, quote);
      } else if (typ === 'hr') {
        this.rule();
      }
      i += 1;
    }
  }

  /** 목록 · 인용 안의 단락 서식. */
  block(p, lists, quote) {
    if (lists.length) {
      const level = Math.min(lists.length - 1, 2);
      const top = lists[lists.length - 1];
      if (top.first) {
        p.fmt.numbering = { ...top.num, level };
        top.first = false;
      } else {
        p.fmt.leftTw = LIST_INDENT * (level + 1);
      }
      p.fmt.after = 3;
    } else if (quote) {
      p.fmt.left = 0.5 * quote;
      p.fmt.after = 4;
      p.fmt.border = { left: border(RULE, 12, 8) };
    }
  }

  code(content, lists = [], quote = 0) {
    const left = (LIST_INDENT * Math.min(lists.length, 3)) / 567 + 0.5 * quote + 0.15;
    const p = this.para({ before: 2, after: 8, line: 1.0, left, shading: shade() });
    p.kids.push(...runs(String(content || '').replace(/\n+$/, ''), { code: true, size: 9 }));
  }

  rule() {
    this.para({ before: 4, after: 10, line: 1.0, border: { bottom: border(RULE, 6, 1) } });
  }

  // --- 표 ---
  /** 칸 단락 */
  cellPara(fmt = {}) {
    return new P({ before: 0, after: 1, line: 1.15, ...fmt });
  }

  /** 테두리 · 칸 여백 · 머리글 행(음영, 쪽마다 반복)을 갖춘 표. cells: [[P]] */
  table(widthsCm, cells, { header = true, borders = 'all' } = {}) {
    const widths = widthsCm.map(tw);
    const total = widths.reduce((a, b) => a + b, 0);
    const line = { style: 'single', size: 4, color: RULE, space: 0 };
    const none = { style: 'none', size: 0, color: 'auto', space: 0 };
    const all = borders === 'all';
    const rows = (cells.length ? cells : [widths.map(() => this.cellPara())]).map((row, r) => new TableRow({
      tableHeader: header && r === 0,
      children: widths.map((w, c) => new TableCell({
        width: { size: w, type: 'dxa' },
        ...(header && r === 0 ? { shading: shade() } : {}),
        children: [(row[c] || this.cellPara()).build()],
      })),
    }));
    const tbl = new Table({
      width: { size: total, type: 'dxa' },
      columnWidths: widths,
      layout: 'fixed',
      borders: {
        top: line, bottom: line, insideHorizontal: line,
        left: all ? line : none, right: all ? line : none, insideVertical: all ? line : none,
      },
      margins: { top: 45, bottom: 45, left: 90, right: 90 },
      rows,
    });
    this.blocks.push(tbl);
    return tbl;
  }

  /** 표 바로 뒤의 간격 단락(표 두 개가 붙어 하나로 합쳐지는 것도 막는다). */
  afterTable() {
    this.para({ before: 0, after: 4, line: 1.0 });
  }

  mdTable(tokens) {
    const rows = [];
    let cur = null;
    for (const t of tokens) {
      if (t.type === 'tr_open') {
        cur = [];
        rows.push(cur);
      } else if (t.type === 'inline' && cur !== null) {
        cur.push(t);
      }
    }
    if (!rows.length) return;
    const ncol = Math.max(...rows.map((r) => r.length)) || 1;
    // 열 폭: 칸 글자 수 평균에 비례하되 너무 좁거나 넓지 않게
    const weights = [];
    for (let c = 0; c < ncol; c += 1) {
      const lens = rows.filter((r) => c < r.length).map((r) => [...r[c].content].length);
      weights.push(Math.min(Math.max(lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1), 6), 70));
    }
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.max((TEXT_W * w) / total, 1.6));
    const scale = TEXT_W / widths.reduce((a, b) => a + b, 0);
    const cells = rows.map((rowTokens, r) => Array.from({ length: ncol }, (_, c) => {
      const p = this.cellPara();
      if (c < rowTokens.length) this.inline(p, rowTokens[c].children, { size: 9, bold: r === 0 });
      return p;
    }));
    this.table(widths.map((w) => w * scale), cells);
    this.afterTable();
  }

  /** parts: [[글, fmt]] — '\n'은 줄바꿈. */
  cellText(parts, pfmt = {}) {
    const p = this.cellPara(pfmt);
    for (const [text, fmt] of parts) {
      if (text) this.text(p.kids, text, fmt, false);
    }
    return p;
  }

  // --- 표지 · 목차 ---
  cover() {
    const { L, T } = this;
    const m = metaInfo(this.result);
    this.para({ before: 0, after: 4 }).kids.push(...runs(L.title, { bold: true, size: 10, color: ACCENT }));
    const topic = this.result.topic || this.result.prompt || L.title;
    this.para({ after: 14, line: 1.2 }).kids.push(...runs(topic, { bold: true, size: 24, color: INK }));

    const ko = this.result.lang === 'ko';
    const pairs = [
      [L.gen, m.date], [L.model, m.model], [L.window, m.window],
      [L.stats, T.count_fmt(num(m.collected), num(m.included))
        + ` (${L.merged} ${num(m.merged)} · ${L.sent} ${num(m.report_evidence)})`],
      [T.duration, `${num(m.minutes)}${ko ? '' : ' '}${L.minutes}`],
      [L.calls, T.calls_fmt(num(m.calls))],
      [L.tokens, T.tokens_fmt(num(m.input_tokens), num(m.output_tokens))],
    ];
    if (typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd)) pairs.push([L.cost, `$${m.cost_usd.toFixed(2)}`]);
    if (pairs.length % 2) pairs.push(['', '']);
    const cells = [];
    for (let k = 0; k < pairs.length; k += 2) {
      const row = [];
      for (const [label, value] of pairs.slice(k, k + 2)) {
        row.push(this.cellText([[label, { size: 8.5, color: MUTED, bold: true }]]));
        row.push(this.cellText([[value, { size: 9 }]]));
      }
      cells.push(row);
    }
    this.table([2.6, 5.7, 2.6, 5.7], cells, { header: false, borders: 'rows' });
    if (m.note) {
      this.para({ before: 6, after: 0, line: 1.25 }).kids.push(...runs(m.note, { size: 8.5, italic: true, color: MUTED }));
    }
    this.rule();

    this.para({ before: 6, after: 4, keep: true }).kids.push(...runs(L.contents, { bold: true, size: 13, color: ACCENT_DARK }));
    // 목차 필드: Word가 문서를 열 때 업데이트를 묻고 채운다. 그 전에는 자리 글자를 보인다
    const placeholder = new Paragraph({
      ...paraOpts({ after: 4 }),
      children: runs(T.toc_wait, { color: MUTED }),
    });
    this.blocks.push(new TableOfContents(L.contents, {
      hyperlink: true,
      headingStyleRange: '1-3',
      hideTabAndPageNumbersInWebView: true,
      useAppliedParagraphOutlineLevel: true,
      contentChildren: [placeholder],
    }));
    this.para({ after: 0, line: 1.2 }).kids.push(...runs(T.toc_hint, { size: 8.5, color: MUTED }));
  }

  // --- 부록 ---
  appendixA() {
    const { L } = this;
    this.newSection(true);
    this.para({ heading: 1 }).kids.push(...runs(L.tableA));
    if (!this.included.length) {
      this.para().kids.push(...runs(this.T.no_sources, { color: MUTED }));
    } else {
      const muted = { size: 8.5, color: MUTED };
      const cells = [L.cols.map((col) => this.cellText([[col, { size: 8.5, bold: true }]]))];
      for (const s of this.included) {
        const id = this.cellPara();
        if (this.refIds.has(s.sid)) id.kids.push(this.citeLink(s.sid, { size: 8.5, bold: true }));
        else id.kids.push(...runs(s.sid, { size: 8.5, bold: true }));
        const kind = KIND_LABEL[s.kind || ''] ?? (s.kind || '');
        const kindLine = [kind, s.study_type || ''].filter(Boolean).join(' · ');
        const d = s.direction || '';
        const score = s.score;
        cells.push([
          id,
          this.cellText([[shortCite(s), { size: 8.5, bold: true }],
            ['\n' + (s.title || ''), { size: 8.5, italic: true }],
            [kindLine ? '\n' + kindLine : '', muted]]),
          this.cellText([[s.method || '', { size: 8.5 }], [s.sample ? '\n' + s.sample : '', muted]]),
          this.cellText([[s.key_finding || '', { size: 8.5 }]]),
          this.cellText([[DIRECTION_LABEL[d] ?? d, { size: 8.5 }],
            [typeof score === 'number' && Number.isFinite(score) ? `\n${score.toFixed(2)}` : '', muted]]),
        ]);
      }
      this.table([1.5, 6.2, 5.6, 9.6, 2.4], cells);
    }
    this.newSection(false);          // 다시 세로 페이지
  }

  appendixB() {
    const { L, T } = this;
    this.para({ heading: 1 }).kids.push(...runs(L.refB));
    if (!this.refs.length) this.para().kids.push(...runs(T.no_sources, { color: MUTED }));
    const seen = new Set();
    for (const s of this.refs) {
      const sid = s.sid;
      const p = this.para({ after: 5, line: 1.25, left: 1.3, first: -1.3 });
      const run = runs(sid, { bold: true, size: 9.5, color: ACCENT_DARK });
      if (seen.has(sid)) p.kids.push(...run);
      else {
        p.kids.push(new Bookmark({ id: `ref_${sid}`, children: run }));
        seen.add(sid);
      }
      const f = { size: 9.5 };
      const head = [authorsText(s) || s.venue || '', `(${s.year || 'n.d.'})`].filter(Boolean).join(' ');
      p.kids.push(...runs(`\t${head}. `, f));
      p.kids.push(...runs(s.title || '', { ...f, italic: true }));
      p.kids.push(...runs('. ', f));
      if (s.venue) p.kids.push(...runs(`${s.venue}. `, f));
      const url = clean(s.url || s.doi || '').trim();
      if (isHttp(url)) this.link(p.kids, url, url, { size: 9 });
      const tail = [KIND_LABEL[s.kind || ''] ?? (s.kind || '')];
      if (Number.isInteger(s.citations)) tail.push(T.cites(fmtInt(s.citations)));
      tail.push(s.origin || '');
      p.kids.push(...runs('\n' + tail.filter(Boolean).join(' · '), { size: 8.5, color: MUTED }));
    }
  }

  verdictTag(p, verdict, size = 9) {
    const label = VERDICT_LABEL[verdict] ?? (verdict || '?');
    p.kids.push(...runs(`[${label}]`, { bold: true, size, color: VERDICT_COLOR[verdict] || MUTED }));
  }

  appendixC() {
    const { L, T } = this;
    const ver = this.result.verification || {};
    const checks = (Array.isArray(ver.checks) ? ver.checks : []).filter((c) => c && typeof c === 'object');
    this.breakNext = true;
    this.para({ heading: 1 }).kids.push(...runs(L.verC));
    const line = `${L.cited} ${num(ver.cited_ids ?? 0)} · ${L.claims} ${num(ver.claims_total ?? 0)} · ${L.checked} ${checks.length}`;
    this.para({ after: 4 }).kids.push(...runs(line, { size: 9.5, color: INK_2 }));
    const unknown = (Array.isArray(ver.unknown_ids) ? ver.unknown_ids : []).map(clean);
    if (unknown.length) {
      this.para({ after: 4 }).kids.push(...runs(`${T.unknown}: ${unknown.join(', ')}`, { size: 9.5, color: VERDICT_COLOR.contradicted }));
    }
    if (!checks.length) {
      this.para().kids.push(...runs(T.no_checks, { color: MUTED }));
      return;
    }
    const before = verdictTally(checks);
    const after = verdictTally(checks, true);
    const cells = [[T.verdict, L.before, L.after].map((h) => this.cellText([[h, { size: 9, bold: true }]]))];
    for (const v of VERDICTS) {
      cells.push([
        this.cellText([[VERDICT_LABEL[v] ?? v, { size: 9, bold: true, color: VERDICT_COLOR[v] || MUTED }]]),
        this.cellText([[String(before[v]), { size: 9 }]], { align: 'right' }),
        this.cellText([[String(after[v]), { size: 9 }]], { align: 'right' }),
      ]);
    }
    this.table([4.0, 2.4, 2.4], cells);
    this.afterTable();
    checks.forEach((c, idx) => {
      const k = idx + 1;
      let p = this.para({ before: 6, after: 2, line: 1.3, left: 0.7, first: -0.7, keep: true });
      p.kids.push(...runs(`${k}.\t`, { bold: true, size: 9.5 }));
      this.verdictTag(p, c.verdict || '');
      p.kids.push(...runs(' ', {}));
      this.inlineMd(p, c.claim || '', { size: 9.5 });
      if (c.note) this.para({ after: 2, line: 1.25, left: 0.7 }).kids.push(...runs(c.note, { size: 8.5, color: MUTED }));
      if (c.revised) {
        p = this.para({ after: 2, line: 1.3, left: 0.7 });
        p.kids.push(...runs(`${L.after}: `, { bold: true, size: 9.5, color: ACCENT_DARK }));
        this.inlineMd(p, c.revised, { size: 9.5 });
        p.kids.push(...runs(' ', {}));
        this.verdictTag(p, c.verdict_after || 'not checked');
        if (c.note_after) {
          this.para({ after: 2, line: 1.25, left: 0.7 }).kids.push(...runs(c.note_after, { size: 8.5, color: MUTED }));
        }
      }
    });
  }

  appendixD() {
    const { T } = this;
    const trace = (Array.isArray(this.result.trace) ? this.result.trace : []).filter((t) => t && typeof t === 'object');
    this.breakNext = true;
    this.para({ heading: 1 }).kids.push(...runs(this.L.traceD));
    if (!trace.length) {
      this.para().kids.push(...runs(T.no_trace, { color: MUTED }));
      return;
    }
    const ko = this.result.lang === 'ko';
    const cells = [T.trace_cols.map((h) => this.cellText([[h, { size: 8.5, bold: true }]]))];
    for (const t of trace) {
      const ts = String(t.ts || '');
      const stage = String(t.stage || '');
      cells.push([
        this.cellText([[ts.length >= 19 ? ts.slice(11, 19) : ts, { size: 8.5, color: MUTED }]]),
        this.cellText([[ko ? (STAGE_KO[stage] ?? stage) : stage, { size: 8.5 }]]),
        this.cellText([[t.msg || '', { size: 8.5 }]]),
      ]);
    }
    this.table([1.8, 2.3, TEXT_W - 4.1], cells);
  }

  // --- 문서 조립 ---
  styles() {
    const heading = (level) => {
      const [size, color, before, after] = HEADING[level];
      return {
        run: { font: KO, size: Math.round(size * 2), bold: true, italics: false, color },
        paragraph: {
          ...paraOpts({ before, after, line: 1.2, keep: true }),
          outlineLevel: level - 1,
          ...(level === 1 ? { border: { bottom: border(RULE, 6, 4) } } : {}),
        },
      };
    };
    return {
      default: {
        document: {
          run: { font: KO, size: 21, color: INK, language: { value: 'en-US', eastAsia: 'ko-KR' } },
          paragraph: paraOpts({ after: 6, line: 1.35 }),
        },
        heading1: heading(1), heading2: heading(2), heading3: heading(3), heading4: heading(4),
        hyperlink: { run: { color: ACCENT, underline: { type: 'single' } } },
      },
    };
  }

  build() {
    const page = (landscape) => ({
      size: { width: tw(PAGE_W), height: tw(PAGE_H), orientation: landscape ? 'landscape' : 'portrait' },
      margin: {
        top: tw(MARGIN), right: tw(MARGIN), bottom: tw(MARGIN), left: tw(MARGIN),
        header: tw(1.1), footer: tw(1.1),
      },
    });
    const sections = this.sections.map((sec, i) => ({
      properties: { ...(i ? { type: 'nextPage' } : {}), page: page(sec.landscape) },
      ...this.sectionHeader(),
      children: sec.blocks.map((b) => (b instanceof P ? b.build() : b)),
    }));
    const title = [...clean(this.result.topic || this.result.prompt || '')].slice(0, 250).join('');
    return new Document({
      creator: 'AI Research Agent',
      lastModifiedBy: 'AI Research Agent',
      title,
      subject: this.L.title,
      description: '',
      keywords: '',
      features: { updateFields: true },        // 문서를 열 때 Word가 필드(목차) 업데이트를 묻게 한다
      styles: this.styles(),
      numbering: { config: [...this.numbering.values()] },
      sections,
    });
  }
}

/** result(PYTHON_SPEC 3.2)로 Word 보고서를 만들어 바이트(Uint8Array)로 돌려준다. */
export async function buildDocx(result) {
  result = (result && typeof result === 'object') ? result : {};
  const w = new Writer(result);
  w.cover();
  w.breakNext = true;                    // 본문은 새 쪽에서 시작
  const body = typeof result.report_markdown === 'string' ? result.report_markdown : '';
  if (body.trim()) w.markdown(body);
  else w.para().kids.push(...runs(w.T.empty_body, { color: MUTED }));
  w.appendixA();
  w.appendixB();
  w.appendixC();
  w.appendixD();
  const buf = await Packer.toArrayBuffer(w.build());
  return new Uint8Array(buf);
}

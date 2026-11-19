// HTML 보고서: 웹 화면용 본문 조각(renderFragment)과 인쇄·PDF용 단독 문서(buildHtml).
//
// 보안: report_markdown은 LLM이, 문헌 필드는 공개 웹이 만든 글이다. markdown-it의 html 옵션을 끄고(태그는 전부 글자로
// 이스케이프됨), 부록에 직접 넣는 글은 전부 escapeHtml, 주소는 safeUrl(http/https만)을 거친다.
// 결과에 <script>나 on... 이벤트 속성, javascript: 주소가 들어갈 수 없다. buildHtml은 스크립트를 전혀 넣지 않는다
// (인쇄는 화면이 새 창에서 print()를 부른다 — CSP 때문).
import MarkdownIt from '../../../vendor/markdown-it.js';
import * as theme from './theme.js';
import {
  CITE_RE, VERDICTS, arr, authorsText, citeReGlobal, fmtInt, includedSources, labels, metaInfo, referenceSources,
  safeUrl, shortCite, sourcesById, verdictTally,
} from './common.js';

const BR_RE = /&lt;br\s*\/?&gt;/gi;                      // 이스케이프된 <br>, <br/>, <br />
const CITE_LINK_RE = /(\[S\d+(?:\s*,\s*S\d+)*\])\(/g;   // [S12](설명) 이 링크로 해석되지 않게
const EXTRA = {
  ko: {
    duration: '소요 시간', request: '요청', unknown: '미존재 ID', none: '없음', link: '원문', cites: '인용',
    via: '출처', relevance: '관련성', credibility: '신뢰도', limitation: '한계', empty: '채택된 문헌이 없습니다.',
    no_checks: '검증한 문장이 없습니다.', no_trace: '기록이 없습니다.', tally: '판정 집계',
  },
  en: {
    duration: 'Duration', request: 'Request', unknown: 'unknown ids', none: 'none', link: 'link', cites: 'cites',
    via: 'via', relevance: 'relevance', credibility: 'credibility', limitation: 'Limitation',
    empty: 'No included sources.', no_checks: 'No claims were checked.', no_trace: 'No trace entries.',
    tally: 'Verdict tally',
  },
};
const STAGE_KO = {
  understand: '주제 이해', plan: '계획', act: '탐색', evaluate: '평가', synthesize: '종합',
  reflect: '비평', report: '보고서', verify: '검증', export: '내보내기', system: '시스템',
};

// 파이썬 html.escape(quote=True)와 같은 이스케이프
export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
const esc = escapeHtml;

// ---------------------------------------------------------------- Markdown 렌더러

// 이미 이스케이프된(또는 안전한) 글의 [S12] 인용에서 known에 있는 ID만 링크로 감싼다. 대괄호·쉼표는 그대로.
// 목록에 없는 ID는 화면에서 따로 표시할 수 있게 span.cite-unknown으로 감싼다.
export function linkCites(text, known) {
  const has = known instanceof Set ? (x) => known.has(x) : (x) => (known || []).includes(x);
  const one = (sid) => (has(sid)
    ? `<a class="cite" data-sid="${sid}" href="#ref-${sid}">${sid}</a>`
    : `<span class="cite-unknown">${sid}</span>`);
  // 줄 끝에서 대괄호와 ID가 갈라지지 않게 한 덩어리(span.cites)로 묶는다
  return String(text ?? '').replace(citeReGlobal(),
    (m) => '<span class="cites">' + m.replace(/S\d+/g, one) + '</span>');
}

// h2·h3에 sec-N id를 달고 목차를 모으며(env.toc가 있을 때), 텍스트 속 인용을 링크로 바꾼다
function citeCoreRule(state) {
  const env = state.env || {};
  const toc = env.toc;
  const known = env.known || new Set();
  let n = 0;
  const textToken = (content) => {
    const t = new state.Token('text', '', 0);
    t.content = content;
    return t;
  };
  state.tokens.forEach((tok, i) => {
    if (tok.type === 'heading_open' && (tok.tag === 'h2' || tok.tag === 'h3') && Array.isArray(toc)) {
      n += 1;
      tok.attrSet('id', `sec-${n}`);
      const inline = state.tokens[i + 1];
      const title = (inline?.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline')
        .map((c) => c.content).join('');
      toc.push({ id: `sec-${n}`, level: parseInt(tok.tag.slice(1), 10), title: title.trim() });
    }
    if (tok.type !== 'inline' || !tok.children) return;
    const out = [];
    let inLink = 0;
    for (const child of tok.children) {
      if (child.type === 'link_open') inLink += 1;
      if (child.type === 'link_close') inLink -= 1;
      if (child.type !== 'text' || inLink || !CITE_RE.test(child.content)) {
        out.push(child);
        continue;
      }
      let pos = 0;
      for (const m of child.content.matchAll(citeReGlobal())) {
        if (m.index > pos) out.push(textToken(child.content.slice(pos, m.index)));
        const htmlTok = new state.Token('html_inline', '', 0);
        // 인용 표기 자체는 [S숫자, S숫자] 꼴이라 이스케이프할 글자가 없다
        htmlTok.content = linkCites(m[0], known);
        out.push(htmlTok);
        pos = m.index + m[0].length;
      }
      if (pos < child.content.length) out.push(textToken(child.content.slice(pos)));
    }
    tok.children = out;
  });
}

function makeMd() {
  const md = new MarkdownIt('commonmark', { html: false }).enable('table');
  md.core.ruler.push('cite_links', citeCoreRule);
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const href = String(tok.attrGet('href') || '');
    const low = href.toLowerCase();
    if (low.startsWith('http://') || low.startsWith('https://')) {
      tok.attrSet('target', '_blank');
      tok.attrSet('rel', 'noopener noreferrer');
    } else if (!href.startsWith('#')) {
      // mailto:·ftp:·상대 경로·프로토콜 상대(//host) 등은 살아 있는 링크로 두지 않는다(글자는 남김)
      tok.attrs = (tok.attrs || []).filter(([k]) => k !== 'href');
    }
    return self.renderToken(tokens, idx, options);
  };
  // 그림은 외부 리소스를 부르므로 살아 있는 <img>로 두지 않고 대체 글만 남긴다
  md.renderer.rules.image = (tokens, idx, options, env, self) => esc(self.renderInlineAsText(tokens[idx].children || [], options, env));
  md.renderer.rules.table_open = () => '<div class="tbl"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  return md;
}

let MD = null;   // 규칙만 담은 객체라 여러 실행이 함께 써도 된다(실행별 값은 env로 넘김)
function getMd() {
  if (!MD) MD = makeMd();
  return MD;
}

function render(text, known = [], toc = null) {
  const env = { known: new Set(known), toc };
  const html = getMd().render(String(text || '').replace(CITE_LINK_RE, '$1\\('), env);
  return html.replace(BR_RE, '<br>');
}

// 안전한 Markdown → HTML (Q&A 답변 등). knownIds에 있는 인용만 링크가 된다. 제목 id는 달지 않는다.
export function renderMarkdown(text, knownIds = []) {
  return render(text, knownIds || [], null);
}

// 웹 화면 보고서 탭용 본문 HTML과 목차
export function renderFragment(result) {
  const toc = [];
  const html = render(result?.report_markdown || '', Object.keys(sourcesById(result)), toc);
  return { html, toc };
}

// ---------------------------------------------------------------- 단독 문서

const X_ = (result) => EXTRA[result?.lang === 'ko' ? 'ko' : 'en'];

// 한국어 보고서만 theme의 한국어 라벨을 쓰고, 영어 보고서는 원래 값
function labelOf(table, key, result) {
  key = key || '';
  if (result?.lang !== 'ko') return key;
  return Object.hasOwn(table, key) ? table[key] : key;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function badge(verdict, result, prefix = '', suffix = '') {
  const color = theme.VERDICT_COLOR[verdict] || theme.NEUTRAL;
  const text = labelOf(theme.VERDICT_LABEL, verdict, result) || '-';
  return `<span class="badge" style="--c:#${color}">${esc(prefix + text + suffix)}</span>`;
}

function cover(result) {
  const L = labels(result); const X = X_(result); const m = metaInfo(result);
  const topic = result.topic || result.prompt || L.title;
  const items = [[L.gen, m.date], [L.model, m.model], [L.window, m.window],
    [L.stats, `${m.collected} / ${m.included} (${L.merged} ${m.merged})`]];
  if (m.minutes) items.push([X.duration, `${m.minutes.toFixed(1)} ${L.minutes}`]);
  if (m.calls) {
    const tokens = fmtInt((Number(m.input_tokens) || 0) + (Number(m.output_tokens) || 0));
    items.push([L.calls, result.lang === 'ko' ? `${m.calls}회 · ${L.tokens} ${tokens}` : `${m.calls} · ${tokens} ${L.tokens}`]);
  }
  if (m.cost_usd !== null && m.cost_usd !== undefined) items.push([L.cost, `$${(Number(m.cost_usd) || 0).toFixed(2)}`]);
  const meta = items.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('');
  const prompt = String(result.prompt || '').trim();
  const out = [`<header class="cover"><div class="kicker">${esc(L.title)}</div><h1 class="title">${esc(topic)}</h1>`];
  if (prompt && prompt !== topic) out.push(`<p class="prompt"><span>${esc(X.request)}</span> ${esc(prompt)}</p>`);
  out.push(`<dl class="meta">${meta}</dl>`);
  if (m.note) out.push(`<p class="note">${esc(m.note)}</p>`);
  out.push('</header>');
  return out.join('');
}

// 문서 목차: 본문 h2·h3 + 부록 A~D (buildHtml이 쓰는 것과 같은 목록)
export function documentToc(result, toc) {
  const L = labels(result);
  return [...(toc || []), ...[['a', 'tableA'], ['b', 'refB'], ['c', 'verC'], ['d', 'traceD']]
    .map(([c, k]) => ({ id: `appx-${c}`, level: 2, title: L[k] }))];
}

function tocHtml(result, toc) {
  const L = labels(result);
  const lis = documentToc(result, toc)
    .map((t) => `<li class="l${t.level}"><a href="#${esc(t.id)}">${esc(t.title)}</a></li>`).join('');
  return `<nav class="toc"><h2>${esc(L.contents)}</h2><ol>${lis}</ol></nav>`;
}

function appendixA(result) {
  const L = labels(result); const X = X_(result);
  const rows = includedSources(result).map((s) => {
    const score = isNum(s.score) ? s.score.toFixed(2) : '-';
    const cred = isNum(s.credibility) ? s.credibility.toFixed(2) : '-';
    const lim = s.limitation ? `<span class="sub">${esc(X.limitation)}: ${esc(s.limitation)}</span>` : '';
    return `<tr><td class="sid">${esc(s.sid || '')}</td>`
      + `<td><b>${esc(shortCite(s))}</b><span class="sub">${esc(s.title || '')}</span>`
      + `<span class="tag">${esc(labelOf(theme.KIND_LABEL, s.kind, result))}</span> `
      + `<span class="sub inline">${esc(s.study_type || '')}</span></td>`
      + `<td>${esc(s.method || '')}<span class="sub">${esc(s.sample || '')}</span></td>`
      + `<td>${esc(s.key_finding || '')}${lim}</td>`
      + `<td><span class="dir">${esc(labelOf(theme.DIRECTION_LABEL, s.direction, result) || '-')}</span>`
      + `<span class="score">${score}</span><span class="sub">${esc(X.relevance)} ${esc(String(s.relevance || '-'))}`
      + ` · ${esc(X.credibility)} ${cred}</span></td></tr>`;
  });
  const body = rows.join('') || `<tr><td colspan="5" class="empty">${esc(X.empty)}</td></tr>`;
  const head = L.cols.map((c) => `<th>${esc(c)}</th>`).join('');
  return `<section class="appendix wide" id="appx-a"><h2>${esc(L.tableA)}</h2>`
    + '<table class="evidence"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5">'
    + `</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function appendixB(result) {
  const L = labels(result); const X = X_(result);
  const items = referenceSources(result).map((s) => {
    const sid = esc(s.sid);
    const url = safeUrl(s);
    const link = url ? ` <a class="out" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : '';
    const cites = s.citations !== null && s.citations !== undefined ? `${X.cites} ${s.citations}` : '';
    const info = [cites, s.origin ? `${X.via} ${s.origin}` : ''].filter((x) => x).join(' · ');
    const infoHtml = info ? ` <span class="sub2">${esc(info)}</span>` : '';
    return `<li id="ref-${sid}"><span class="rid">[${sid}]</span><div>`
      + `${esc(authorsText(s) || s.venue || '')} (${esc(String(s.year || 'n.d.'))}). `
      + `<cite>${esc(s.title || '')}</cite>. `
      + `${s.venue ? '<i>' + esc(s.venue) + '</i>. ' : ''}`
      + `<span class="tag">${esc(labelOf(theme.KIND_LABEL, s.kind, result))}</span>`
      + `${infoHtml}${link}</div></li>`;
  });
  const body = items.join('') || `<li class="empty">${esc(X.empty)}</li>`;
  return `<section class="appendix" id="appx-b"><h2>${esc(L.refB)}</h2><ol class="refs">${body}</ol></section>`;
}

function appendixC(result, known) {
  const L = labels(result); const X = X_(result);
  const v = result.verification || {};
  const checks = (Array.isArray(v.checks) ? v.checks : []).filter((c) => c && typeof c === 'object');
  const stats = [[L.cited, v.cited_ids ?? '-'], [X.unknown, arr(v.unknown_ids).join(', ') || X.none],
    [L.claims, v.claims_total ?? '-'], [L.checked, checks.length]];
  const out = [`<section class="appendix" id="appx-c"><h2>${esc(L.verC)}</h2><dl class="kv">`,
    stats.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(val))}</dd></div>`).join(''), '</dl>'];
  if (checks.length) {
    out.push('<div class="tallies">');
    for (const [name, after] of [[L.before, false], [L.after, true]]) {
      const t = verdictTally(checks, after);
      out.push(`<div class="tally"><span class="tl">${esc(name)}</span>`
        + VERDICTS.map((k) => badge(k, result, '', ` ${t[k]}`)).join('') + '</div>');
    }
    out.push('</div>');
  } else {
    out.push(`<p class="empty">${esc(X.no_checks)}</p>`);
  }
  for (const c of checks) {
    const verdict = c.verdict || '';
    const color = theme.VERDICT_COLOR[verdict] || theme.NEUTRAL;
    const card = [`<div class="claim" style="--c:#${color}">${badge(verdict, result)}`,
      `<p class="ct">“${linkCites(esc(c.claim || ''), known)}”</p>`];
    if (c.note) card.push(`<p class="cn">${esc(c.note)}</p>`);
    if (c.revised) {
      card.push(`<div class="revised">${badge(c.verdict_after || 'not checked', result, L.after + ': ')}`
        + `<p class="ct">“${linkCites(esc(c.revised), known)}”</p>`
        + (c.note_after ? `<p class="cn">${esc(c.note_after)}</p>` : '') + '</div>');
    }
    out.push(card.join('') + '</div>');
  }
  out.push('</section>');
  return out.join('');
}

function appendixD(result) {
  const L = labels(result); const X = X_(result);
  const ko = result.lang === 'ko';
  const items = arr(result.trace).filter((t) => t && typeof t === 'object').map((t) => {
    const stage = String(t.stage || '');
    const name = ko ? (Object.hasOwn(STAGE_KO, stage) ? STAGE_KO[stage] : stage)
      : (stage ? stage.charAt(0).toUpperCase() + stage.slice(1).toLowerCase() : '');
    return `<li><time>${esc(String(t.ts || '').slice(11, 19))}</time><span class="stage">${esc(name)}</span>`
      + `<span class="msg">${esc(t.msg || '')}</span></li>`;
  });
  const body = items.length ? `<ol class="timeline">${items.join('')}</ol>` : `<p class="empty">${esc(X.no_trace)}</p>`;
  return `<section class="appendix" id="appx-d"><h2>${esc(L.traceD)}</h2>${body}</section>`;
}

export function reportCss() {
  const t = theme;
  return `
:root{--accent:#${t.ACCENT};--accent-dark:#${t.ACCENT_DARK};--accent-soft:#${t.ACCENT_SOFT};--ink:#${t.INK};--ink2:#${t.INK_2};
--muted:#${t.MUTED};--rule:#${t.RULE};--surface:#${t.SURFACE};--alt:#${t.SURFACE_ALT}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--alt);color:var(--ink);font-family:${t.FONT_STACK_CSS};font-size:15px;line-height:1.7;
word-break:keep-all;overflow-wrap:break-word;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:860px;margin:32px auto;padding:56px 64px;background:var(--surface);border-radius:8px;
box-shadow:0 1px 3px rgba(21,23,28,.06),0 8px 24px rgba(21,23,28,.05)}
a{color:var(--accent);text-underline-offset:2px}
.cover{padding-bottom:22px;margin-bottom:28px;border-bottom:2px solid var(--accent)}
.kicker{color:var(--accent);font-weight:700;font-size:.8em;letter-spacing:.08em}
.cover h1.title{font-size:1.9em;line-height:1.35;margin:.3em 0 .5em;letter-spacing:-.015em;font-weight:800}
.prompt{color:var(--ink2);font-size:.92em;margin:0 0 12px}
.prompt span{color:var(--muted);font-weight:600;margin-right:4px}
dl.meta,dl.kv{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0;font-size:.85em}
dl.meta div,dl.kv div{display:flex;gap:6px}
dl.meta dt,dl.kv dt{color:var(--muted)}
dl.meta dd,dl.kv dd{margin:0;font-weight:600}
.note{margin:16px 0 0;padding:10px 14px;background:var(--accent-soft);border-left:3px solid var(--accent);
font-size:.87em;color:var(--ink2);border-radius:0 4px 4px 0}
.toc{margin:0 0 36px}
.toc h2{font-size:1.05em;border:0;margin:0 0 8px;padding:0;color:var(--muted);letter-spacing:.04em}
.toc ol{list-style:none;margin:0;padding:0;columns:2;column-gap:36px;font-size:.9em}
.toc li{break-inside:avoid;margin:0 0 3px}
.toc li.l3{padding-left:14px;font-size:.92em;color:var(--ink2)}
.toc a{color:inherit;text-decoration:none}
.toc a:hover{color:var(--accent)}
h1,h2,h3,h4{line-height:1.4;letter-spacing:-.01em}
.report h1{font-size:1.45em;margin:0 0 .8em}
h2{font-size:1.4em;margin:2.2em 0 .7em;padding-bottom:.3em;border-bottom:1px solid var(--rule)}
h3{font-size:1.13em;margin:1.8em 0 .6em;color:var(--accent-dark)}
h4{font-size:1em;margin:1.4em 0 .5em}
p{margin:0 0 .8em}
ul,ol{margin:0 0 .9em;padding-left:1.4em}
li{margin:.2em 0}
li>ul,li>ol{margin:.25em 0}
blockquote{margin:0 0 1em;padding:.2em 1em;border-left:3px solid var(--rule);color:var(--ink2)}
hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
code{font-family:${t.FONT_MONO},ui-monospace,monospace;font-size:.88em;background:var(--alt);padding:.1em .35em;border-radius:3px}
pre{background:var(--alt);padding:12px 14px;border-radius:6px;overflow-x:auto}
pre code{padding:0;background:none}
.cites{white-space:nowrap;color:var(--muted)}
a.cite{display:inline-block;padding:0 .35em;margin:0 .1em;border-radius:4px;background:var(--accent-soft);
color:var(--accent-dark);font-size:.76em;font-weight:600;line-height:1.55;text-decoration:none;vertical-align:.1em}
a.cite:hover{background:var(--accent);color:#fff}
.cite-unknown{color:var(--muted);text-decoration:line-through dotted}
.tbl{overflow-x:auto;margin:1em 0 1.3em}
table{border-collapse:collapse;width:100%;font-size:.86em;line-height:1.55}
th,td{border:1px solid var(--rule);padding:.45em .6em;vertical-align:top;text-align:left}
thead th{background:var(--alt);font-weight:700;white-space:nowrap}
.appendix{margin-top:3.5em}
.appendix h2{margin-top:0;border-bottom:2px solid var(--accent)}
table.evidence{font-size:.78em;table-layout:fixed}
.evidence col.c1{width:6%} .evidence col.c2{width:24%} .evidence col.c3{width:22%}
.evidence col.c4{width:36%} .evidence col.c5{width:12%}
.evidence td.sid{font-weight:700;color:var(--accent-dark);white-space:nowrap}
.sub{display:block;color:var(--muted);font-size:.92em;margin-top:2px}
.sub.inline{display:inline}
.sub2{color:var(--muted);font-size:.9em}
.tag{display:inline-block;padding:0 .45em;margin-top:3px;border:1px solid var(--rule);border-radius:3px;
font-size:.85em;color:var(--ink2);background:var(--surface)}
.dir{display:block;font-weight:600}
.score{display:block;font-variant-numeric:tabular-nums}
.empty{color:var(--muted)}
ol.refs{list-style:none;padding:0;margin:0;font-size:.88em}
.refs li{display:grid;grid-template-columns:3.8em 1fr;gap:.6em;padding:.45em .4em;margin:0;border-bottom:1px solid var(--alt)}
.refs li:target{background:var(--accent-soft)}
.refs .rid{font-weight:700;color:var(--accent-dark)}
.refs cite{font-style:normal;font-weight:600}
.refs a.out{display:block;font-size:.9em;word-break:break-all}
.tallies{margin:14px 0 18px;display:grid;gap:6px}
.tally{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.tally .tl{min-width:5em;font-size:.85em;color:var(--muted);font-weight:600}
.badge{display:inline-flex;align-items:center;gap:5px;padding:0 .6em;border:1px solid var(--rule);border-radius:999px;
font-size:.76em;font-weight:700;line-height:1.8;color:var(--ink);background:var(--surface);white-space:nowrap}
.badge::before{content:"";width:.6em;height:.6em;border-radius:50%;background:var(--c)}
.claim{border:1px solid var(--rule);border-left:4px solid var(--c);border-radius:6px;padding:10px 14px;margin:10px 0;font-size:.92em}
.claim .ct{margin:.4em 0 .2em}
.claim .cn{margin:0;color:var(--ink2);font-size:.92em}
.revised{margin-top:8px;padding:8px 12px;background:var(--alt);border-radius:4px}
ol.timeline{list-style:none;margin:0 0 0 6px;padding:0;border-left:2px solid var(--rule);font-size:.84em}
.timeline li{position:relative;margin:0;padding:.25em 0 .45em 1.2em;line-height:1.55}
.timeline li::before{content:"";position:absolute;left:-6px;top:.6em;width:10px;height:10px;border-radius:50%;
background:var(--surface);border:2px solid var(--accent)}
.timeline time{font-family:${t.FONT_MONO},monospace;color:var(--muted);margin-right:.6em}
.timeline .stage{font-weight:700;color:var(--accent-dark);margin-right:.5em}
@media (max-width:720px){.doc{margin:0;padding:28px 18px;border-radius:0} .toc ol{columns:1}}
@page{size:A4;margin:18mm 16mm}
@page wide{size:A4 landscape;margin:12mm 12mm}
@media print{
body{background:#fff;font-size:10.5pt;line-height:1.65}
.doc{max-width:none;margin:0;padding:0;box-shadow:none;border-radius:0}
.toc{break-after:page}
.tbl{overflow:visible}
thead{display:table-header-group}
tr,.claim,.refs li,.timeline li,.tally{break-inside:avoid}
h1,h2,h3,h4{break-after:avoid}
.appendix{break-before:page;margin-top:0}
.wide{page:wide}
a{text-decoration:none}
a.cite:hover{background:var(--accent-soft);color:var(--accent-dark)}
}
`;
}

// 단독으로 열리는 완성 HTML 문서(CSS 내장, 외부 리소스·스크립트 없음).
// autoPrint는 호환용으로만 받고 쓰지 않는다: 인쇄는 화면이 새 창에서 print()를 부른다(CSP).
export function buildHtml(result, { autoPrint = false } = {}) {   // eslint-disable-line no-unused-vars
  result = result || {};
  const L = labels(result);
  const known = new Set(referenceSources(result).map((s) => s.sid));   // 부록 B에 있는 문헌만 링크 (끊긴 링크 방지)
  const body = String(result.report_markdown || '').replace(/^\s*#\s[^\n]*\n/, '');   // 본문 첫 제목은 표지와 겹쳐 뺀다
  const toc = [];
  const report = render(body, known, toc);
  const topic = result.topic || result.prompt || L.title;
  const lang = result.lang === 'ko' ? 'ko' : 'en';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(topic)} · ${esc(L.title)}</title><style>${reportCss()}</style></head><body>`
    + `<main class="doc">${cover(result)}${tocHtml(result, toc)}<article class="report">${report}</article>`
    + `${appendixA(result)}${appendixB(result)}${appendixC(result, known)}${appendixD(result)}</main>`
    + '</body></html>';
}

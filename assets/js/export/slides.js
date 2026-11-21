// 발표 자료 구성안(deck plan, version 2): 보고서를 잘라 붙이지 않고 발표의 흐름으로 따로 짠다 (docs/SLIDES_V2.md 1·2절).
//
// - makeDeck(llm, result): LLM 1회 호출로 구성안을 만든다(실패하면 null).
// - fallbackDeck(result): LLM 없이 보고서의 완결된 문장만 골라 규칙으로 만든다(항상 성공).
// - normalizeDeck(deck, result, source): 길이·개수 제한을 지키고 모든 키를 채운다. 내용을 지어내지 않는다.
// 그리기는 pptx.js가 맡는다. 이 파일은 "무엇을 말할지"만 정한다.
import { CITE_RE, citedIds, metaInfo, shortCite, sourcesById } from './common.js';
// JSON Schema 축약 헬퍼와 시스템 프롬프트는 엔진과 같은 원본을 쓴다(둘 다 브라우저 전역에 손대지 않는 작은 모듈)
import { A, E, O, S } from '../engine/schema.js';
import { ABSTRACT_RULE, SYS_BASE } from '../engine/prompts.js';

export const STRENGTHS = ['strong', 'moderate', 'weak', 'insufficient'];
const SOURCES = ['llm', 'sample', 'rules'];
const NOTE_KEYS = ['opening', 'answer', 'landscape', 'strength', 'tension', 'gaps', 'next', 'cautions', 'closing'];

// 개수 · 길이 제한(SLIDES_V2 1.1). 길이는 em 폭: 한글 등 전각 1, 그 밖의 글자 0.55
export const DECK_LIMITS = {
  title: 44, subtitle: 60, question: 70,
  context: { max: 3, len: 56 },
  answer: 84, answer_caveat: 84,
  messages: { min: 3, max: 5 },
  headline: 46, takeaway: 78, message_notes: 520,
  points: { min: 2, max: 3 }, figure: 9, text: 54, detail: 56, sids: 3,
  agree: { max: 3, len: 58 }, conflict: { max: 3, len: 58 }, conflict_why: 110,
  gaps: { max: 4, gap: 40, why: 76 },
  next_studies: { max: 3, title: 40, design: 58, sample: 58, payoff: 58 },
  cautions: { max: 4, len: 66 },
  takeaways: { max: 3, len: 44 }, closing: 60,
  must_read: { max: 5, why: 70 },
  subq_label: 44, notes: 420,
};

// 구성안의 모양에서 version · source를 뺀 것(모든 속성 필수, 추가 속성 없음 — 구조화 출력 규칙)
export const DECK_SCHEMA = O({
  title: S, subtitle: S, question: S, context: A(S), answer: S, answer_caveat: S,
  messages: A(O({
    headline: S,
    points: A(O({ figure: S, text: S, detail: S, sids: A(S) })),
    takeaway: S, strength: E(...STRENGTHS), subq_ids: A(S), notes: S,
  })),
  agree: A(S), conflict: A(S), conflict_why: S,
  gaps: A(O({ gap: S, why: S })),
  next_studies: A(O({ title: S, design: S, sample: S, payoff: S })),
  cautions: A(S), takeaways: A(S), closing: S,
  must_read: A(O({ sid: S, why: S })),
  subq_labels: A(O({ id: S, label: S })),
  notes: O(Object.fromEntries(NOTE_KEYS.map((k) => [k, S]))),
});

// 저장소에 남아 있는 v1 개요(version 없음)는 false → 버리고 새로 만든다
export function isDeck(x) {
  return Boolean(x && x.version === 2 && Array.isArray(x.messages));
}

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
// 인용 표기와 그 앞의 공백("… 줄었다 [S1]" → "… 줄었다")
const citeWs = () => new RegExp('\\s*' + CITE_RE.source, 'g');

// ---------------------------------------------------------------- 글자 폭 (em)

// 한글 · 한자 · 가나 · 전각 기호는 1em, 나머지(영문 · 숫자 · 공백 · 문장부호)는 0.55em으로 어림한다
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣ힰ-퟿豈-﫿︰-﹏＀-｠￠-￦]/;
const NARROW = 0.55;
const charEm = (ch) => (WIDE.test(ch) ? 1 : NARROW);

// 글의 em 폭. [S12] · [S3, S4] 같은 인용 표기는 세지 않는다(슬라이드에서 작게 따로 보이므로)
export function emLen(text) {
  let n = 0;
  for (const ch of String(text ?? '').replace(citeWs(), '')) n += charEm(ch);
  return Math.round(n * 100) / 100;   // 0.55를 여러 번 더할 때 생기는 부동소수 오차를 없앤다
}

// 앞에서부터 budget em에 들어가는 글자 수(문자열 길이). 서로게이트 쌍은 한 글자로 다룬다
function fitIndex(s, budget) {
  let em = 0; let i = 0;
  for (const ch of s) {
    const w = charEm(ch);
    if (em + w > budget + 1e-9) break;
    em += w; i += ch.length;
  }
  return i;
}

// ---------------------------------------------------------------- 글 다듬기

// XML에 쓸 수 없는 글자를 뺀다: 제어 문자(탭 · 줄바꿈은 둔다), 짝 없는 서로게이트, U+FFFE · U+FFFF.
// LLM 답이나 가져온 조사 파일에 섞여 들어오면 PowerPoint가 파일을 복구해야 한다고 하고 그 글을 버린다.
export function stripControl(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    const ok = cp < 0x20 ? (cp === 0x09 || cp === 0x0A || cp === 0x0D)
      : !(cp >= 0xD800 && cp <= 0xDFFF) && cp !== 0xFFFE && cp !== 0xFFFF;
    if (ok) out += ch;
  }
  return out;
}

// 제어 문자 · Markdown 강조 · <br> · 연속 공백을 걷어 낸 한 줄 문자열
export function clean(text) {
  let s = stripControl(text);
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '');
  return s.replace(/\s+/g, ' ').trim();
}

function rstripChars(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

// 문장 단위로 나눈다. 인용만 남은 조각("[S1].")과 'et al.' 같은 약어 뒤는 앞 문장에 붙인다
const CITE_ONLY = new RegExp(`^(?:${CITE_RE.source}\\s*)+[.]?$`);
const ABBREV = /(?:\bet al|\be\.g|\bi\.e|\bvs|\bcf|\bFig|\bNo|\b[A-Z])\.$/;
export function sentences(text) {
  const out = [];
  for (const part of clean(text).split(/(?<=[.!?。])\s+/)) {
    if (!part) continue;
    const prev = out[out.length - 1];
    if (prev && (CITE_ONLY.test(part) || ABBREV.test(prev))) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out;
}

// 목록을 예고하는 문장("다음과 같다", "…:")은 슬라이드에서 혼자 뜻이 없다
const isLeadIn = (s) => /[:：]$/.test(s) || s.includes('다음과 같') || /as follows/i.test(s);

// 절 경계(쉼표 · 세미콜론 · 대시 · 쌍점), 없으면 단어 경계에서 budget em 안으로 자른다(… 붙이기 전)
export function cut(body, budget) {
  const i = fitIndex(body, budget);
  let head = body.slice(0, i);
  if (i < body.length && !/\s/.test(body[i])) {   // 단어 가운데에서 잘렸다
    const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' — '), head.lastIndexOf(': '));
    const space = head.lastIndexOf(' ');
    if (clause >= head.length * 0.6) head = head.slice(0, clause);
    else if (space >= head.length * 0.5) head = head.slice(0, space);
  }
  // 닫히지 않은 괄호가 남으면 괄호 앞에서 끊는다("시험(RCT…" 대신 "시험…")
  const open = head.lastIndexOf('(');
  if (open > head.length * 0.5 && head.indexOf(')', open) < 0) head = head.slice(0, open);
  return rstripChars(head, ' ,;:·(—–-').trim();
}

// n em 이내로 줄인다. ① 문장 끝에서 자를 수 있으면 거기서(인용은 제자리에 둔다)
// ② 아니면 절·단어 경계에서 자르고 '…'. 인용은 중간에서 자르지 않고, 앞의 3개를 끝에 모아 둔다
export function clip(text, n) {
  const s = clean(text);
  if (emLen(s) <= n) return s;
  let kept = '';
  for (const sent of sentences(s)) {
    const next = kept ? `${kept} ${sent}` : sent;
    if (emLen(next) > n) break;
    kept = next;
  }
  if (kept && emLen(kept) >= n * 0.35) return kept;
  const ids = citedIds(s).slice(0, 3);
  const head = cut(s.replace(citeWs(), '').trim(), n - NARROW);   // '…' 한 글자 자리를 남긴다
  return `${head}…` + (ids.length ? ` [${ids.join(', ')}]` : '');
}

// 앞에서부터 완결된 문장만(n em 이내). 첫 문장이 짧을 때만 둘째 문장을 잇는다. 첫 문장이 넘치면 ''
export function firstSentences(text, n, max = 2) {
  let out = '';
  for (const sent of sentences(text)) {
    if (isLeadIn(sent)) continue;
    const next = out ? `${out} ${sent}` : sent;
    if (emLen(next) > n) break;
    out = next;
    if (--max === 0 || emLen(out) >= n * 0.5) break;
  }
  return out;
}

const dropPeriod = (s) => String(s).replace(/[.。]$/, '');

// ---------------------------------------------------------------- 정규화

// 글 안의 인용에서 result.sources에 없는 id를 뺀다("[S3, S999]" → "[S3]", "[S999]"는 앞 공백과 함께 사라진다)
function keepKnownCites(text, known) {
  return text.replace(citeWs(), (m) => {
    const all = m.match(/S\d+/g) || [];
    const ids = all.filter((id) => id in known);
    if (ids.length === all.length) return m;
    return ids.length ? `${m.match(/^\s*/)[0]}[${ids.join(', ')}]` : '';
  });
}

// 문자열(또는 숫자)만 받아 다듬고 n em에 맞춘다. 그 밖의 값은 ''
function fit(value, n, known) {
  const raw = isStr(value) ? value : (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
  return clip(keepKnownCites(clean(raw), known), n);
}

// 큰 숫자 칸: 잘린 숫자는 틀린 숫자이므로 9em을 넘으면 자르지 않고 비운다
function fitFigure(value, known) {
  const s = fit(value, 1000, known).replace(citeWs(), '').trim();
  return emLen(s) <= DECK_LIMITS.figure ? s : '';
}

// 문자열 목록: 빈 값 · 중복 제거, 개수 k, 길이 n
function strs(value, k, n, known) {
  const out = [];
  for (const v of list(value)) {
    const s = fit(v, n, known);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, k);
}

// 문헌 id 목록: '[S3]' · 'S3' 모두 받고, 있는 문헌만, 중복 없이 k개까지
function sidList(value, known, k) {
  const raw = isStr(value) ? value.match(/S\d+/g) || [] : list(value);
  const out = [];
  for (const v of raw) {
    const sid = isStr(v) ? clean(v).replace(/^\[+|\]+$/g, '') : '';
    if (sid && sid in known && !out.includes(sid)) out.push(sid);
  }
  return out.slice(0, k);
}

const synOf = (r) => (isObj(r.syntheses) ? r.syntheses : {});

// 하위 질문 id(계획 순서). 계획이 비었으면 종합의 키 순서
function subqOrder(r) {
  const ids = [];
  for (const q of list(r.plan?.sub_questions)) {
    if (isObj(q) && isStr(q.id) && q.id && !ids.includes(q.id)) ids.push(q.id);
  }
  return ids.length ? ids : Object.keys(synOf(r));
}

function strengthOf(r, qid) {
  const s = synOf(r)[qid];
  return isObj(s) && STRENGTHS.includes(s.evidence_strength) ? s.evidence_strength : '';
}

// 여러 하위 질문 가운데 가장 약한 근거 강도. 하나도 없으면 'insufficient'
function weakest(r, qids) {
  const found = qids.map((q) => STRENGTHS.indexOf(strengthOf(r, q))).filter((i) => i >= 0);
  return found.length ? STRENGTHS[Math.max(...found)] : 'insufficient';
}

// 보고서에 나오는 수(천 단위 쉼표를 뺀 표기)와 그 값. 인용 표기 [S12]와 문헌 · 하위 질문 id(S12 · Q3)의 숫자는 세지 않는다
function briefNumbers(md) {
  const text = clean(isStr(md) ? md : '').replace(citeWs(), ' ').replace(/\b[SQ]\d+\b/g, ' ').replace(/(\d),(?=\d{3})/g, '$1');
  const tokens = text.match(/\d+(?:\.\d+)?/g) || [];
  return { strings: new Set(tokens), values: new Set(tokens.map(Number)) };
}

// 큰 숫자 칸에는 보고서에 있는 수만 쓴다: 소수는 같은 표기가, 정수는 같은 값(0 = 0.0)이 보고서에 있어야 한다.
// 모델이 반올림했거나(56.7% → 57%) 지어낸 수는 비운다. 보고서가 없으면 확인할 수 없으므로 그대로 둔다
function grounded(figure, nums) {
  if (!figure || !nums.strings.size) return figure;
  const tokens = figure.replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || [];
  const ok = tokens.every((n) => (n.includes('.') ? nums.strings.has(n) : nums.values.has(Number(n))));
  return ok ? figure : '';
}

function normMessage(m, r, known, order, nums) {
  if (!isObj(m)) return null;
  const L = DECK_LIMITS;
  const points = [];
  for (const p of list(m.points)) {
    if (!isObj(p)) continue;
    const point = { figure: grounded(fitFigure(p.figure, known), nums), text: fit(p.text, L.text, known),
      detail: fit(p.detail, L.detail, known), sids: sidList(p.sids, known, L.sids) };
    if (point.text || point.figure) points.push(point);
  }
  const subq_ids = [];
  for (const q of list(m.subq_ids)) {
    const id = isStr(q) ? clean(q) : '';
    if (order.includes(id) && !subq_ids.includes(id)) subq_ids.push(id);
  }
  const msg = {
    headline: fit(m.headline, L.headline, known),
    points: points.slice(0, L.points.max),
    takeaway: fit(m.takeaway, L.takeaway, known),
    // 근거 강도: 답하는 하위 질문들의 종합 가운데 가장 약한 것(다른 슬라이드 · 부록과 어긋나지 않게).
    // 종합에 강도가 없을 때만 모델이 적은 값을 쓴다
    strength: subq_ids.some((q) => strengthOf(r, q)) ? weakest(r, subq_ids)
      : (STRENGTHS.includes(m.strength) ? m.strength : 'insufficient'),
    subq_ids,
    notes: fit(m.notes, L.message_notes, known),
  };
  if (!msg.headline) {
    // 제목(주장)이 비었으면 요지나 첫 카드의 글을 제목으로 쓴다(제목 없는 주장 슬라이드를 만들지 않는다)
    const fromTakeaway = fit(msg.takeaway.replace(citeWs(), ''), L.headline, known);
    if (fromTakeaway) { msg.headline = fromTakeaway; msg.takeaway = ''; }
    else if (msg.points.length) msg.headline = fit(msg.points[0].text || msg.points[0].figure, L.headline, known);
  }
  return msg.headline ? msg : null;
}

// 구성안에 올려도 되는 문헌: 보고서에 인용되었거나 하위 질문 종합에 쓰인 것.
// 수집만 하고 채택하지 않은 문헌의 id를 모델이 잘못 적어도 슬라이드 · 필독 문헌 · 참고문헌에 오르지 않게 한다.
// (보고서도 종합도 없는 결과는 걸러 낼 기준이 없으므로 있는 문헌을 모두 받는다)
function citable(r) {
  const all = sourcesById(r);
  const ids = new Set(citedIds(r.report_markdown));
  for (const syn of Object.values(synOf(r))) {
    for (const id of list(isObj(syn) ? syn.sources : null)) ids.add(id);
  }
  if (!ids.size) return all;
  const out = Object.create(null);
  for (const sid of Object.keys(all)) if (ids.has(sid)) out[sid] = all[sid];
  return out;
}

// 구성안을 제한(개수 · 길이)에 맞추고 모든 키를 채운다. 어떤 입력이 와도 같은 모양을 돌려주고,
// 내용을 지어내지 않는다(다듬기 · 자르기 · 없는 문헌 id 지우기 · 빈 값 채우기만). 다시 넣어도 그대로 나온다
export function normalizeDeck(deck, result, source) {
  const d = isObj(deck) ? deck : {};
  const r = isObj(result) ? result : {};
  const known = citable(r);
  const L = DECK_LIMITS;
  const t = (v, n) => fit(v, n, known);
  const order = subqOrder(r);
  const nums = briefNumbers(r.report_markdown);

  const messages = list(d.messages).map((m) => normMessage(m, r, known, order, nums)).filter(Boolean);

  const gaps = [];
  for (const g of list(d.gaps)) {
    const item = isObj(g) ? { gap: t(g.gap, L.gaps.gap), why: t(g.why, L.gaps.why) } : { gap: t(g, L.gaps.gap), why: '' };
    if (item.gap && !gaps.some((x) => x.gap === item.gap)) gaps.push(item);
  }

  const studies = [];
  for (const st of list(d.next_studies)) {
    if (!isObj(st)) continue;
    const N = L.next_studies;
    const item = { title: t(st.title, N.title), design: t(st.design, N.design), sample: t(st.sample, N.sample),
      payoff: t(st.payoff, N.payoff) };
    if (item.title) studies.push(item);
  }

  const must = [];
  for (const m of list(d.must_read)) {
    const [sid] = sidList([isObj(m) ? m.sid : m], known, 1);
    if (sid && !must.some((x) => x.sid === sid)) must.push({ sid, why: isObj(m) ? t(m.why, L.must_read.why) : '' });
  }

  // 하위 질문마다 하나씩, 계획 순서로. 구성안에 없거나 빈 이름은 규칙(보고서 제목)으로 채운다
  const given = Object.create(null);
  for (const x of list(d.subq_labels)) {
    if (isObj(x) && isStr(x.id) && !(x.id in given)) given[x.id] = t(x.label, L.subq_label);
  }
  const rule = Object.create(null);
  if (order.some((id) => !given[id])) for (const x of subqLabels(r)) rule[x.id] = x.label;
  const subq_labels = order.map((id) => ({ id, label: given[id] || rule[id] || id }));

  const notesIn = isObj(d.notes) ? d.notes : {};
  const notes = Object.fromEntries(NOTE_KEYS.map((k) => [k, t(notesIn[k], L.notes)]));

  return {
    version: 2,
    source: SOURCES.includes(source) ? source : (SOURCES.includes(d.source) ? d.source : 'rules'),
    title: t(d.title, L.title) || t(r.topic || r.prompt, L.title),
    subtitle: t(d.subtitle, L.subtitle),
    question: t(d.question, L.question),
    context: strs(d.context, L.context.max, L.context.len, known),
    answer: t(d.answer, L.answer),
    answer_caveat: t(d.answer_caveat, L.answer_caveat),
    messages: messages.slice(0, L.messages.max),
    agree: strs(d.agree, L.agree.max, L.agree.len, known),
    conflict: strs(d.conflict, L.conflict.max, L.conflict.len, known),
    conflict_why: t(d.conflict_why, L.conflict_why),
    gaps: gaps.slice(0, L.gaps.max),
    next_studies: studies.slice(0, L.next_studies.max),
    cautions: strs(d.cautions, L.cautions.max, L.cautions.len, known),
    takeaways: strs(d.takeaways, L.takeaways.max, L.takeaways.len, known),
    closing: t(d.closing, L.closing),
    must_read: must.slice(0, L.must_read.max),
    subq_labels,
    notes,
  };
}

// ---------------------------------------------------------------- LLM 구성안

// 프롬프트에 주는 길이: 한국어는 em 그대로 글자 수, 그 밖의 언어는 em ÷ 0.55(좁은 글자 기준).
// 제한의 80%만 알려 준다: 모델은 글자 수를 정확히 세지 못하므로, 조금 넘겨도 normalizeDeck이 자르지 않게 여유를 둔다
// (이 길이까지는 슬라이드에서 글자 크기를 줄이지 않고도 들어간다)
const ASK = 0.8;
// 한 글자가 1em인 언어(한국어 · 일본어 · 중국어). 이런 언어에 좁은 글자 기준 글자 수를 알려 주면 제한을 넘겨 잘린다
const wideLang = (lang) => ['ko', 'ja', 'zh'].includes(String(lang || '').slice(0, 2).toLowerCase());
const chars = (em, lang) => Math.floor((wideLang(lang) ? em : em / NARROW) * ASK);

function subqLines(r) {
  const syn = synOf(r);
  const rows = [];
  for (const q of list(r.plan?.sub_questions)) {
    if (!isObj(q) || !q.id) continue;
    const s = isObj(syn[q.id]) ? syn[q.id] : {};
    const n = Array.isArray(s.sources) ? s.sources.length
      : list(r.sources).filter((x) => x && x.included && list(x.subqs).includes(q.id)).length;
    rows.push(`- ${q.id}: ${clean(q.question)} (evidence strength: ${strengthOf(r, q.id) || 'insufficient'}; ${n} sources)`);
  }
  return rows.join('\n') || '- (none)';
}

// 인용해도 되는 문헌: 보고서에 인용되었고 result.sources에 실제로 있는 것만(id · 짧은 표기 · 연구 유형)
function citableLines(r) {
  const known = sourcesById(r);
  const rows = citedIds(r.report_markdown).filter((sid) => sid in known).map((sid) => {
    const s = known[sid];
    return `- ${sid}: ${shortCite(s)}${s.study_type ? ` · ${clean(s.study_type)}` : ''}`;
  });
  return rows.join('\n') || '- (none)';
}

function limitLines(lang) {
  const L = DECK_LIMITS;
  const c = (em) => chars(em, lang);
  const unit = wideLang(lang)
    ? `characters (a ${lang === 'ko' ? 'Hangul syllable' : 'CJK character'} counts 1; Latin letters, digits, spaces and punctuation count about 0.5)`
    : 'characters';
  return `Length limits, in ${unit}. [S12]-style ids are not counted. These are hard limits: text over a limit is cut.
- title ${c(L.title)}, subtitle ${c(L.subtitle)}, question ${c(L.question)}, each context item ${c(L.context.len)}
- answer ${c(L.answer)}, answer_caveat ${c(L.answer_caveat)}
- messages[].headline ${c(L.headline)}, takeaway ${c(L.takeaway)}, notes ${c(L.message_notes)}
- points[].figure ${c(L.figure)}, text ${c(L.text)}, detail ${c(L.detail)}; at most ${L.sids} sids per point
- each agree / conflict item ${c(L.agree.len)}, conflict_why ${c(L.conflict_why)}
- gaps[].gap ${c(L.gaps.gap)}, gaps[].why ${c(L.gaps.why)}
- next_studies[].title ${c(L.next_studies.title)}, design / sample / payoff ${c(L.next_studies.design)} each
- each caution ${c(L.cautions.len)}, each takeaway ${c(L.takeaways.len)}, closing ${c(L.closing)}
- must_read[].why ${c(L.must_read.why)}, subq_labels[].label ${c(L.subq_label)}, each deck-level note ${c(L.notes)}`;
}

// 완성된 브리프로 발표 구성안을 짠다(LLM 1회). 호출이 실패하면(null) null
export async function makeDeck(llm, result) {
  const r = isObj(result) ? result : {};
  const L = DECK_LIMITS;
  const lang = r.lang || 'en';
  const info = metaInfo(r);
  const window = r.meta?.year_from ? `${r.meta.year_from} onward` : 'no limit';
  const prompt = `Design the slides for a 15-20 minute talk about the finished research brief below.

Topic: ${r.topic || r.prompt || ''}
Output language: "${lang}"

Sub-questions:
${subqLines(r)}

Scale of the evidence: ${info.collected} records collected, ${info.merged} duplicate versions merged, ${info.included} sources included. Search window: ${window}.

Sources you may cite (cited in the brief):
${citableLines(r)}

Research brief (Markdown):
"""${isStr(r.report_markdown) ? r.report_markdown.replaceAll('"""', "'''") : ''}"""

How to build the talk:
- You are preparing a TALK, not a summary. Design what the audience should hear and remember. Do not copy the brief's section order: order the messages as a story, the most solid finding first and the most important caveat last.
- One claim per slide. Each messages[].headline is a short complete sentence that states the claim, not a topic label.
- ${L.messages.min} to ${L.messages.max} messages. Each has ${L.points.min}-${L.points.max} points. Prefer points that carry a number from the brief: put the number with its unit in figure (e.g. "56.7%", "3.02x", "A- → A"), say in text what it measures, and give the design, sample or condition in detail. If a point has no number, leave figure "". Never invent, round or convert numbers; copy them exactly as the brief states them.
- Write for a screen, not a page: points[].text and points[].detail are short phrases without filler words (the subject is already in the headline). The full explanation belongs in notes, not on the slide.
- takeaway: the "so what" of that slide in one sentence.
- strength: the evidence strength of the sub-questions the message answers (from the list above); subq_ids: those sub-question ids.
- messages[].notes: what the presenter would SAY on that slide: 3-5 spoken sentences in a natural register, keeping the [S12]-style ids on the statements they support.
- title: the topic as a presentation title (a question or a message is fine). subtitle: one line under it.
- question: the question put to the audience, in one sentence. context: 2-3 short facts from the brief that explain why the question matters now.
- answer: the bottom line in one sentence. answer_caveat: the most important condition on it (evidence level, population, setting).
- agree: up to ${L.agree.max} points where the studies agree. conflict: up to ${L.conflict.max} points where they disagree. conflict_why: why they disagree, in one sentence. Keep the [S12] ids.
- gaps: up to ${L.gaps.max} research gaps (gap: a short statement; why: what is missing or why it matters).
- next_studies: up to ${L.next_studies.max} studies from the brief's future-research section (title, design, sample, payoff = expected contribution).
- cautions: up to ${L.cautions.max} things to keep in mind when reading these results (the brief's limitations).
- takeaways: exactly three things to remember. closing: one last sentence.
- must_read: up to ${L.must_read.max} sources to read first (sid, and why in one sentence).
- subq_labels: a short name for every sub-question above, in the same order, in the output language.
- notes (deck level): what the presenter would say on the other slides, 2-4 spoken sentences each: opening (the question), answer (the bottom line), landscape (how the evidence was collected and what kinds of studies it holds), strength (how solid the evidence is for each sub-question), tension (agreements and conflicts), gaps, next (the proposed studies), cautions, closing (the three takeaways).

Grounding:
- Use only what the brief says. Do not add facts, numbers, studies or sources.
- Every id in sids and must_read must be one of the sources listed above and must support that statement. Give 1-${L.sids} sids per point when the brief cites one.
- If the brief gives no basis for an item, return an empty list or an empty string instead.

${limitLines(lang)}

Write all text in language "${lang}".${lang === 'ko' ? ' Slide text (headline, points, takeaway, lists) uses the plain written form ("…줄어든다"); notes use the polite spoken form ("…줄었습니다").' : ''}`;
  const out = await llm.json(SYS_BASE + ' ' + ABSTRACT_RULE, prompt, DECK_SCHEMA, { effort: 'medium', maxTokens: 16000 });
  if (out === null || out === undefined) return null;
  return normalizeDeck(out, r, 'llm');
}

// ---------------------------------------------------------------- 보고서 읽기 (규칙 구성안용)

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;
const splitLines = (md) => (isStr(md) ? md : '').split(LINE_BREAK);

// '## ' 절 단위로 나눈다 → [[제목, 줄 목록]]
export function sections(md) {
  const out = [];
  for (const line of splitLines(md)) {
    if (line.startsWith('## ')) out.push([clean(line.slice(3)), []]);
    else if (out.length) out[out.length - 1][1].push(line);
  }
  return out;
}

// "1. 핵심 요약"처럼 번호가 붙은 절
export function numbered(md) {
  return sections(md).filter((s) => /^\d+[.)]?\s/.test(s[0]));
}

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// 맨 위 수준 목록 항목 → { text, kids: 하위 항목들, more: 들여 쓴 이어지는 문단 }
export function listItems(lines) {
  const items = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    const last = items[items.length - 1];
    if (m && !m[1]) items.push({ text: m[2], kids: [], more: [] });
    else if (m && last) last.kids.push(m[2]);
    else if (last && /^\s+\S/.test(line)) last.more.push(line.trim());
  }
  return items;
}

// "**굵은 머리 문장.** 나머지" → { head, rest }. 머리가 없으면 head = ''
function splitHead(text) {
  const m = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(String(text).trim());
  return m ? { head: clean(m[1]), rest: m[2] } : { head: '', rest: text };
}

// 여러 하위 질문의 목록에서 번갈아 하나씩 뽑아 중복 없이 모은다
export function roundRobin(lists) {
  const out = []; let i = 0;
  while (lists.some((x) => i < x.length)) {
    for (const x of lists) {
      if (i < x.length && isStr(x[i])) {
        const s = clean(x[i]);
        if (s && !out.includes(s)) out.push(s);
      }
    }
    i += 1;
  }
  return out;
}

const FIELDS = {
  design: ['설계', '연구 설계', 'design', 'study design'],
  sample: ['표본', '대상', 'sample', 'participants'],
  payoff: ['기대 기여', '기여', 'expected contribution', 'contribution'],
};

// "향후 연구" 절의 '### 연구 1: …' 묶음 → [{ title, design, sample, payoff }] (값은 다듬기 전 글)
export function futureStudies(md) {
  const sec = sections(md).find((s) => s[0].includes('향후') || s[0].toLowerCase().includes('future'));
  if (!sec) return [];
  const studies = []; let cur = null;
  for (const line of sec[1]) {
    if (line.startsWith('### ')) {
      const title = clean(line.slice(4)).replace(/^(연구|Study)\s*\d+\s*[:.．]\s*/i, '');
      cur = { title, lines: [] };
      studies.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return studies.map((st) => {
    const row = { title: st.title, design: '', sample: '', payoff: '' };
    for (const { text, kids } of listItems(st.lines)) {
      const { head, rest } = splitHead(text);
      const label = rstripChars(head, ':：').trim().toLowerCase();
      for (const [key, names] of Object.entries(FIELDS)) {
        if (names.includes(label) && !row[key]) row[key] = clean(rest) || kids.map((k) => endSentence(clean(k))).join(' ');
      }
    }
    return row;
  });
}

// 마침표 없는 항목("…센서 [S1]")을 문장으로 이어 붙일 때 끝에 '.'을 단다
const endSentence = (s) => (!s || /[.!?。:]$/.test(s) ? s : `${s}.`);

// 보고서의 '### Q3. … — 근거 강도: …' 제목 → { Q3: '…' }
function headingLabels(md) {
  const out = Object.create(null);
  for (const line of splitLines(md)) {
    const m = /^###\s+(Q\d+)\s*[.:)．]?\s+(.+)$/.exec(line);
    if (!m || m[1] in out) continue;
    out[m[1]] = clean(m[2].split(/\s+[—–-]+\s+(?:\*\*)?(?:근거\s*강도|evidence strength)/i)[0]);
  }
  return out;
}

// 하위 질문의 짧은 이름(계획 순서): 보고서 제목 → 계획의 perspective → question → id
export function subqLabels(result) {
  const r = isObj(result) ? result : {};
  const fromMd = headingLabels(r.report_markdown);
  const plan = Object.create(null);
  for (const q of list(r.plan?.sub_questions)) if (isObj(q) && isStr(q.id)) plan[q.id] ??= q;
  return subqOrder(r).map((id) => {
    const q = plan[id] || {};
    const label = [fromMd[id], q.perspective, q.question].map((x) => (isStr(x) ? clip(x, DECK_LIMITS.subq_label) : ''))
      .find(Boolean);
    return { id, label: label || id };
  });
}

// ---------------------------------------------------------------- 규칙 구성안

// 문장의 첫 "숫자+단위"를 큰 숫자 칸에 쓴다: 56.7%, 3.02배, 453명, 0.0%~100.0%, 7.0→3.5 Ω/sq, 0.05달러 …
// 단위 없는 숫자는 쓰지 않는다(무엇의 수인지 알 수 없고, 연도 · 번호일 때가 많다). 연도(2025년, 2023–2026년)도 쓰지 않는다.
// 9em에 들어가는 것이 없으면 ''. 단위는 긴 것을 먼저 적는다(%p가 %보다, Ω/sq가 Ω보다 먼저 맞도록)
const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const UNIT = String.raw`%p|%|배|명|건|편|쌍|개월|개|점|회|종|곳|시간|분(?![석야류포리산해자량])|년|달러|Ω\/sq|Ω|[µμ]m|nm|mm|cm|kPa|ppm|ppb|x|times|pp|SD`;
// 모양: (±)숫자(단위) [~ – → - 숫자](단위).  "6-7 µm" · "7.0→3.5 Ω/sq" 같은 범위 · 변화도 한 덩어리로 잡는다.
// 앞에 빼기표(- · − · –)가 붙은 수는 잡지 않는다(부호를 떼면 뜻이 반대가 된다)
const FIGURE_RE = new RegExp(
  String.raw`(?<![\w.,−–-])(?:±\s?)?${NUM}(?:\s?(?:${UNIT}))?(?:\s?[~–→-]\s?${NUM})?(?:\s?(?:${UNIT}))?(?![A-Za-z\d])`, 'g');
const HAS_UNIT = new RegExp(String.raw`\d\s?(?:${UNIT})`);
const YEAR_ONLY = /^(?:19|20)\d{2}(?:\s?[~–→-]\s?(?:19|20)\d{2})?\s?년?$/;
// 한글 단위(명 · 건 · 개 · 년 …) 바로 뒤에 올 수 있는 글자: 조사 · 접미사의 첫 글자.
// 그 밖의 한글이 이어지면 단위가 아니라 더 긴 낱말의 앞부분이다("3개국" · "4년제" · "2.4 개념적" · "4.3 종합")
const PARTICLE = '을를이가은는의에와과도만로으까부였입인임씩당쯤간째나며고라보뿐밖마정미초';
const HANGUL = /[가-힣]/;

export function figureOf(sentence) {
  const s = clean(sentence).replace(citeWs(), '');
  for (const m of s.matchAll(FIGURE_RE)) {
    const fig = m[0].trim();
    if (!HAS_UNIT.test(fig) || YEAR_ONLY.test(fig)) continue;
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    const next = after.charAt(0);
    // 단위 뒤에 글자가 더 이어지면 다른 단위 · 다른 낱말이다("0.5 Ω/cm", "3개국")
    if (next === '/' || (HANGUL.test(fig.slice(-1)) && HANGUL.test(next) && !PARTICLE.includes(next))) continue;
    if (/^\s?(?:CI\b|신뢰구간)/i.test(after)) continue;             // "95% CI"는 결과가 아니라 신뢰수준
    if (/\d\s?(?:to|에서|부터)\s$/.test(before)) continue;           // "0.2에서 0.5 SD" · "0.2 to 0.5 SD": 범위의 뒤쪽 값만 잡혔다
    if (emLen(fig) <= DECK_LIMITS.figure) return fig;
  }
  return '';
}

// 인용을 지우면 문장이 깨지는 경우("[S9]는 효과가 없었다"): 인용이 문장 첫머리나 쉼표·괄호 바로 뒤에 온다
const CITE_AS_NOUN = new RegExp(String.raw`(?:^|[(,;:·]\s*)\[S\d+`);

// 카드는 혼자 읽히므로 문장 첫머리의 접속어("반면", "그러나" …)는 뗀다
const CONNECTIVE = /^(?:반면|그러나|하지만|또한|한편|다만|However|Moreover|In contrast|Also),?\s+/i;
// 앞 문장을 가리키는 문장("…이 그 예다", "이는 …")은 혼자 뜻이 약하다 → 카드 후보 가운데 가장 뒤로
const ANAPHOR = /그 예다|이에 해당|^(?:이는|이것은|이 결과는|이러한|하나는|다른 하나는|This|These|Such)\s/;

// 문장 하나 → 근거 카드. 54em에 들어가지 않거나 인용을 지우면 깨지는 문장은 쓰지 않는다(null)
function toPoint(sentence, extraIds = []) {
  if (CITE_AS_NOUN.test(sentence)) return null;
  const text = dropPeriod(sentence.replace(citeWs(), '').trim().replace(CONNECTIVE, ''));
  if (!text || emLen(text) > DECK_LIMITS.text) return null;
  const sids = [...new Set([...citedIds(sentence), ...extraIds])].slice(0, DECK_LIMITS.sids);
  return { figure: figureOf(text), text, detail: '', sids };
}

// 후보 문장에서 카드 3장까지: 숫자나 인용이 있는 문장(근거)을 먼저, 앞 문장을 가리키는 문장은 마지막에 고른다.
// 보여 줄 때는 보고서의 원래 순서를 지킨다
function pickPoints(candidates) {
  const points = [];
  for (const c of candidates) {
    const p = isStr(c) ? toPoint(c) : c;
    if (p && !points.some((x) => x.text === p.text)) points.push(p);
  }
  const rankOf = (p) => (ANAPHOR.test(p.text) ? 2 : p.figure || p.sids.length ? 0 : 1);
  const ranked = points.map((p, i) => ({ p, i, rank: rankOf(p) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, DECK_LIMITS.points.max);
  return ranked.sort((a, b) => a.i - b.i).map((x) => x.p);
}

// 인용 id가 가장 많이 겹치는 하위 질문(겹치는 것이 없으면 '')
function bestSubq(r, ids, order) {
  let best = ''; let bestN = 0;
  for (const q of order) {
    const s = synOf(r)[q];
    const n = isObj(s) ? list(s.sources).filter((x) => ids.includes(x)).length : 0;
    if (n > bestN) { best = q; bestN = n; }
  }
  return best;
}

// 한계가 n em을 넘는 주장은 버리고 다음 후보를 쓴다. 끝내 없으면 첫 후보(normalizeDeck이 자른다)
function firstFitting(candidates, n) {
  const all = candidates.map((c) => clean(c)).filter(Boolean);
  return all.find((c) => emLen(c) <= n) || all[0] || '';
}

// 주장 후보: 주장 전체 → 그 안의 문장들 → "A지만, B" · "A, but B"의 B(대조 뒤가 말하려는 요지다)
function claimCandidates(claim) {
  const tail = clean(claim).split(/(?:지만|으나|는데),\s+|,\s+but\s+|;\s+/);
  const last = tail.length > 1 ? tail[tail.length - 1] : '';
  return [claim, ...sentences(claim), last ? last[0].toUpperCase() + last.slice(1) : ''];
}

// 요약 글머리표 하나 → 메시지 한 장. 굵은 머리 문장 = 주장, 나머지 문장과 하위 항목 = 근거 후보
function messageFromBullet(item, r, order) {
  const { head, rest } = splitHead(item.text);
  const restSents = sentences(rest);
  const claim = head || restSents.shift() || '';
  const kids = item.kids.map(clean);
  const candidates = [...restSents, ...kids, ...item.more.flatMap(sentences)].filter((s) => !isLeadIn(s));
  const ids = citedIds([item.text, ...item.kids, ...item.more].join(' '));
  const q = bestSubq(r, ids, order);
  const whole = [clean(item.text), ...kids.map(endSentence), ...item.more].join(' ');
  return {
    headline: dropPeriod(firstFitting(claimCandidates(claim), DECK_LIMITS.headline)),
    points: pickPoints(candidates), takeaway: '', strength: q ? strengthOf(r, q) : '', subq_ids: q ? [q] : [],
    notes: whole,
  };
}

// 요약 절이 없을 때: 하위 질문별 종합 → 메시지(주장 = 답의 첫 문장, 근거 = 주요 결과 앞의 3개)
function messageFromSynthesis(r, q) {
  const s = isObj(synOf(r)[q]) ? synOf(r)[q] : {};
  const answer = sentences(s.answer).map((x) => x.replace(citeWs(), '').trim());
  const points = list(s.key_findings).filter(isObj).slice(0, 3).map((kf) => {
    const ids = list(kf.sources).filter((x) => isStr(x) && /^S\d+$/.test(x));
    const first = sentences(kf.finding)[0] || '';
    return toPoint(first, ids);
  });
  return {
    headline: dropPeriod(firstFitting(answer.flatMap(claimCandidates), DECK_LIMITS.headline)),
    points: pickPoints(points.filter(Boolean)), takeaway: '', strength: strengthOf(r, q), subq_ids: [q],
    notes: clean(s.answer),
  };
}

// 글머리표 → 주의할 점: "굵은 머리 문장 + 다음 한 문장", 길면 다음 문장만, 그것도 길면 머리 문장만
function cautionFrom(item) {
  const { head, rest } = splitHead(item.text);
  const next = sentences(rest)[0] || endSentence(clean(item.kids[0] || ''));
  const n = DECK_LIMITS.cautions.len;
  if (!head) return firstSentences(rest, n, 1) || clean(rest);
  return firstFitting([next ? `${endSentence(head)} ${next}` : head, next, head], n);
}

// 보고서의 "연구 공백" 절: "**모집단 공백**" 머리 = gap, 첫 하위 항목(또는 나머지 글)의 첫 문장 = why
function gapsFromReport(md) {
  const sec = sections(md).find((s) => s[0].includes('공백') || /\bgaps?\b/i.test(s[0]));
  if (!sec) return [];
  const L = DECK_LIMITS.gaps;
  const out = [];
  for (const item of listItems(sec[1])) {
    const { head, rest } = splitHead(item.text);
    const gap = head ? dropPeriod(head) : firstSentences(rest, L.gap, 1);
    const whyFrom = head ? (clean(rest) || clean(item.kids[0] || '')) : '';
    if (gap && emLen(gap) <= L.gap) out.push({ gap, why: firstSentences(whyFrom, L.why, 1) });
  }
  return out;
}

// "직접적인 상충은 없다" 같은 문장(상충 칸에 혼자 있으면 뜻이 없다)
const NO_CONFLICT = /(?:상충|충돌)[^.]{0,12}(?:없|관찰되지 않)|no (?:direct )?(?:conflict|contradiction)/i;

// 향후 연구의 제목: 길면 ' — ' · ':' 앞의 본제목만 쓴다
function studyTitle(title) {
  const n = DECK_LIMITS.next_studies.title;
  return firstFitting([title, ...clean(title).split(/\s+[—–]\s+|:\s+/)], n);
}

// LLM 없이 규칙으로 구성안을 만든다. 보고서와 종합에서 완결된 문장만 골라 쓰고, 어떤 result가 와도 죽지 않는다
export function fallbackDeck(result) {
  const r = isObj(result) ? result : {};
  const L = DECK_LIMITS;
  const ko = r.lang === 'ko';
  const md = isStr(r.report_markdown) ? r.report_markdown : '';
  const syn = synOf(r);
  const order = subqOrder(r);
  const nums = numbered(md);
  const topic = clean(r.topic || r.prompt) || (ko ? '연구 브리프' : 'Research brief');
  const included = Number(metaInfo(r).included) || 0;

  // 핵심 메시지: 요약 절의 글머리표마다 한 장, 없으면 하위 질문별 종합
  const bullets = nums.length ? listItems(nums[0][1]) : [];
  let messages = bullets.slice(0, L.messages.max).map((b) => messageFromBullet(b, r, order));
  if (!messages.length) messages = order.slice(0, L.messages.max).map((q) => messageFromSynthesis(r, q));
  messages = messages.filter((m) => m.headline || m.points.length);

  // 한 문장 결론 = 첫 글머리표의 주장. 단서 = 근거가 '약함' 이하인 하위 질문 수
  const first = bullets.length ? splitHead(bullets[0].text) : { head: '', rest: '' };
  const answer = first.head || firstSentences(first.rest, L.answer, 1) || (messages[0]?.headline ?? '');
  const weak = order.filter((q) => ['weak', 'insufficient'].includes(strengthOf(r, q) || 'insufficient')).length;
  const caveat = weak < 1 ? ''
    : ko ? `하위 질문 ${order.length}개 중 ${weak}개는 근거가 '약함' 이하다.`
      : `${weak} of ${order.length} sub-questions have weak or insufficient evidence.`;

  // 일치 · 상충 · 공백: 하위 질문마다 번갈아 뽑아 완결된 문장만
  const vals = order.map((q) => (isObj(syn[q]) ? syn[q] : {}));
  const pool = (key, n) => roundRobin(vals.map((v) => list(v[key]))).map((s) => firstSentences(s, n)).filter(Boolean);
  // "직접적인 상충은 없다"는 문장은 그 뒤 문장(실제 차이)을 쓰고, 그런 것만 있으면 한 번만 남긴다
  const conflicts = roundRobin(vals.map((v) => list(v.disagreements))).map((s) => {
    const rest = sentences(s).filter((x) => !NO_CONFLICT.test(x)).map((x) => x.replace(CONNECTIVE, ''));
    return firstSentences(rest.join(' '), L.conflict.len);
  }).filter(Boolean);
  const noConflict = pool('disagreements', L.conflict.len).filter((x) => NO_CONFLICT.test(x)).slice(0, 1);
  let gaps = gapsFromReport(md);
  if (!gaps.length) gaps = pool('gaps', L.gaps.gap).map((gap) => ({ gap: dropPeriod(gap), why: '' }));

  // 주의할 점: '한계' 절(없으면 마지막 번호 절)의 글머리표
  const limSec = nums.find((s) => s[0].includes('한계') || /limitation/i.test(s[0])) || (nums.length > 1 ? nums[nums.length - 1] : null);
  const cautions = limSec ? listItems(limSec[1]).map(cautionFrom) : [];

  const studies = futureStudies(md).map((st) => {
    const N = L.next_studies;
    const field = (v, n) => firstSentences(v, n) || clean(v);
    return { title: studyTitle(st.title), design: field(st.design, N.design), sample: field(st.sample, N.sample),
      payoff: field(st.payoff, N.payoff) };
  });

  // 필독 문헌: 본문에 인용된 문헌을 점수순으로
  const inText = new Set(citedIds(md));
  const must = list(r.sources).filter((s) => isObj(s) && s.sid && (s.cited || inText.has(s.sid)))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, L.must_read.max)
    .map((s) => ({ sid: s.sid, why: firstSentences(s.key_finding, L.must_read.why, 1) || clean(s.key_finding || s.title) }));

  // 기억할 세 가지 = 앞의 메시지 제목(44em에 들어가는 것부터)
  const heads = messages.map((m) => m.headline).filter(Boolean);
  const takeaways = [...heads.filter((h) => emLen(h) <= L.takeaways.len), ...heads.filter((h) => emLen(h) > L.takeaways.len)]
    .slice(0, L.takeaways.max);
  takeaways.sort((a, b) => heads.indexOf(a) - heads.indexOf(b));

  return normalizeDeck({
    title: topic,
    subtitle: included ? (ko ? `채택 문헌 ${included}건으로 본 연구 브리프` : `A research brief from ${included} sources`)
      : (ko ? '연구 브리프' : 'A research brief'),
    question: topic,
    context: [],
    answer: endSentence(clean(answer)),
    answer_caveat: caveat,
    messages,
    agree: pool('consensus', L.agree.len),
    conflict: conflicts.length ? conflicts : noConflict,
    conflict_why: '',
    gaps,
    next_studies: studies,
    cautions,
    takeaways,
    closing: '',
    must_read: must,
    subq_labels: subqLabels(r),
    notes: {},
  }, r, 'rules');
}

// 슬라이드 개요: 완성된 브리프를 발표용 개요로 압축한다.
//
// - makeOutline(llm, result): LLM 1회 호출로 개요를 만든다(실패하면 null).
// - fallbackOutline(result): LLM 없이 syntheses · report_markdown에서 규칙으로 만든다(항상 성공).
// - normalizeOutline(outline, result): 개수·길이 제한을 지키게 다듬고 모든 키를 채운다.
// 두 개요는 같은 모양이다(PYTHON_SPEC 4.7).
import { CITE_RE, citedIds, headCut, sourcesById } from './common.js';
// JSON Schema 축약 헬퍼와 시스템 프롬프트는 엔진과 같은 원본을 쓴다(둘 다 브라우저 전역에 손대지 않는 작은 모듈)
import { A, E, O, S } from '../engine/schema.js';
import { ABSTRACT_RULE, SYS_BASE } from '../engine/prompts.js';

export const STRENGTHS = ['strong', 'moderate', 'weak', 'insufficient'];
export const FUTURE_KEYS = ['title', 'question', 'design', 'sample', 'contribution'];

// 개수 · 글자 수 제한 (PYTHON_SPEC 4.7의 개수 + 슬라이드에 들어가는 길이)
export const LIMITS = {
  title: 120, subtitle: 100, headline: 80,
  summary: [5, 110], bullets: [4, 120], agreements: [4, 130], conflicts: [4, 130],
  gaps: [6, 120], limitations: [5, 130], must_read: [5, 120], findings: 10,
  future_studies: 3,
  future_field: { title: 60, question: 160, design: 160, sample: 120, contribution: 150 },
};

export const OUTLINE_SCHEMA = O({
  title: S, subtitle: S, summary: A(S),
  findings: A(O({ subq_id: S, headline: S, bullets: A(S), strength: E(...STRENGTHS) })),
  agreements: A(S), conflicts: A(S), gaps: A(S),
  future_studies: A(O({ title: S, question: S, design: S, sample: S, contribution: S })),
  must_read: A(O({ sid: S, why: S })),
  limitations: A(S),
});

const SENT_END = /[.!?。](?=\s|$)/g;
const citeWs = () => new RegExp('\\s*' + CITE_RE.source, 'g');
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- 글자 다듬기

// Markdown 강조·<br>·연속 공백을 걷어 낸 한 줄 문자열
export function clean(text) {
  let s = String(text ?? '');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replaceAll('**', '').replaceAll('__', '').replaceAll('`', '');
  return s.replace(/\s+/g, ' ').trim();
}

function rstripChars(s, chars) {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

// n자 이내에서 문장 끝, 없으면 단어 경계에서 자른다
function cut(s, n) {
  const ends = [...s.matchAll(SENT_END)].map((m) => m.index + m[0].length).filter((e) => e <= n);
  if (ends.length && ends[ends.length - 1] >= n * 0.5) return s.slice(0, ends[ends.length - 1]).trim();
  let head = headCut(s, n - 1);
  const sp = head.lastIndexOf(' ');
  if (sp >= n * 0.5) head = head.slice(0, sp);
  return rstripChars(head, ' ,;:·(—-') + '…';
}

// n자 이내로 줄인다. 인용 [S#]는 중간에서 자르지 않고, 잘라야 하면 앞의 3개를 문장 끝에 모아 둔다
export function clip(text, n) {
  const s = clean(text);
  if (s.length <= n) return s;
  const ids = citedIds(s).slice(0, 3);
  const tail = ids.length ? ` [${ids.join(', ')}]` : '';
  let body = s.replace(citeWs(), '').trim();
  const room = Math.max(n - tail.length, 10);
  if (body.length > room) body = cut(body, room);
  if (tail && body.endsWith('.')) return body.slice(0, -1) + tail + '.';
  return body + tail;
}

function sentences(text) {
  return clean(text).split(/(?<=[.!?。])\s+/).filter((x) => x);
}

// 앞 문장 한두 개(n자 이내). 목록을 예고하는 문장('다음과 같다', ':')은 건너뛴다
export function firstSentences(text, n) {
  let out = ''; let count = 0;
  for (const sent of sentences(text)) {
    if (out && (sent.endsWith(':') || sent.includes('다음과 같') || sent.toLowerCase().includes('as follows'))) continue;
    if (!out) out = sent;
    else if (out.length + 1 + sent.length <= n) out += ' ' + sent;
    else break;
    count += 1;
    if (count === 2) break;
  }
  return clip(out, n);
}

// 문자열 목록: 빈 값·중복 제거, 개수 k, 길이 n
function strs(value, k, n) {
  const out = [];
  for (const v of Array.isArray(value) ? value : []) {
    const s = isStr(v) ? clip(v, n) : '';
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, k);
}

// ---------------------------------------------------------------- 정규화

// 개요를 제한(개수 · 글자 수)에 맞추고 모든 키를 채운다. 어떤 입력이 와도 같은 모양을 돌려준다
export function normalizeOutline(outline, result) {
  const o = isObj(outline) ? outline : {};
  result = result || {};
  const syn = isObj(result.syntheses) ? result.syntheses : {};
  const known = sourcesById(result);
  const L = LIMITS;
  const topic = result.topic || result.prompt || '';
  const list = (v) => (Array.isArray(v) ? v : []);

  const findings = [];
  for (const f of list(o.findings)) {
    if (!isObj(f)) continue;
    const qid = headCut(clean(f.subq_id), 12);
    let strength = f.strength;
    if (!STRENGTHS.includes(strength)) {
      strength = (Object.hasOwn(syn, qid) && isObj(syn[qid]) ? syn[qid] : {}).evidence_strength;
      strength = STRENGTHS.includes(strength) ? strength : 'insufficient';
    }
    const headline = clip(f.headline, L.headline);
    const bullets = strs(f.bullets, ...L.bullets);
    if (headline || bullets.length) findings.push({ subq_id: qid, headline, bullets, strength });
  }

  const future = [];
  for (const st of list(o.future_studies)) {
    if (isObj(st) && clean(st.title)) {
      future.push(Object.fromEntries(FUTURE_KEYS.map((k) => [k, clip(isStr(st[k]) ? st[k] : '', L.future_field[k])])));
    }
  }

  const must = []; const seen = new Set();
  for (const m of list(o.must_read)) {
    const sid = isObj(m) ? clean(m.sid).replace(/^[[\]]+|[[\]]+$/g, '') : '';
    if (sid && sid in known && !seen.has(sid)) {
      seen.add(sid);
      must.push({ sid, why: clip(isStr(m.why) ? m.why : '', L.must_read[1]) });
    }
  }

  return {
    title: clip(isStr(o.title) ? o.title : '', L.title) || clip(topic, L.title),
    subtitle: clip(isStr(o.subtitle) ? o.subtitle : '', L.subtitle),
    summary: strs(o.summary, ...L.summary),
    findings: findings.slice(0, L.findings),
    agreements: strs(o.agreements, ...L.agreements),
    conflicts: strs(o.conflicts, ...L.conflicts),
    gaps: strs(o.gaps, ...L.gaps),
    future_studies: future.slice(0, L.future_studies),
    must_read: must.slice(0, L.must_read[0]),
    limitations: strs(o.limitations, ...L.limitations),
  };
}

// ---------------------------------------------------------------- LLM 개요

function subqLines(result) {
  const syn = isObj(result.syntheses) ? result.syntheses : {};
  const rows = [];
  for (const q of result.plan?.sub_questions || []) {
    if (!isObj(q)) continue;
    const strength = (isObj(syn[q.id]) ? syn[q.id].evidence_strength : null) || 'insufficient';
    rows.push(`- ${q.id}: ${q.question ?? ''} (evidence strength: ${strength})`);
  }
  return rows.join('\n') || '- (none)';
}

// 완성된 브리프를 발표용 개요로 압축한다(LLM 1회). 호출이 실패하면(null) null
export async function makeOutline(llm, result) {
  result = result || {};
  const L = LIMITS;
  const lang = result.lang || 'en';
  const prompt = `Condense the finished research brief below into an outline for a seminar presentation.

Topic: ${result.topic || result.prompt || ''}

Sub-questions (with evidence strength):
${subqLines(result)}

Research brief (Markdown):
"""${result.report_markdown || ''}"""

Rules:
- Use only what the brief says. Do not add facts, numbers, studies or sources.
- Keep the [S12]-style citation ids on the statements they support. Never invent ids.
- One idea per bullet, written as a short presentable sentence.
- title: the topic as a presentation title (under ${L.title} characters). subtitle: one short line (under ${L.subtitle} characters).
- summary: at most ${L.summary[0]} bullets, each under ${L.summary[1]} characters.
- findings: one item per sub-question in the order above, with its subq_id, a one-line headline (under ${L.headline} characters), at most ${L.bullets[0]} bullets (each under ${L.bullets[1]} characters) and its evidence strength.
- agreements: at most ${L.agreements[0]} points where studies agree; conflicts: at most ${L.conflicts[0]} points where they conflict and why (each under ${L.conflicts[1]} characters).
- gaps: at most ${L.gaps[0]} research gaps (each under ${L.gaps[1]} characters).
- future_studies: at most ${L.future_studies} studies from the brief's future-research section (title, question, design, sample, expected contribution; each field under 150 characters).
- must_read: at most ${L.must_read[0]} sources; every sid must be an id that appears in the brief; why = one sentence on why to read it.
- limitations: at most ${L.limitations[0]} limitations of the brief (each under ${L.limitations[1]} characters).
- Write all text in language "${lang}".`;
  const out = await llm.json(SYS_BASE + ' ' + ABSTRACT_RULE, prompt, OUTLINE_SCHEMA, { effort: 'medium', maxTokens: 16000 });
  if (out === null || out === undefined) return null;
  return normalizeOutline(out, result);
}

// ---------------------------------------------------------------- 규칙 기반 개요

const LINE_BREAK = new RegExp('\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]');
const splitLines = (md) => String(md || '').split(LINE_BREAK);

// '## ' 절 단위로 나눈다 → [[제목, 줄 목록]]
function sections(md) {
  const out = [];
  for (const line of splitLines(md)) {
    if (line.startsWith('## ')) out.push([clean(line.slice(3)), []]);
    else if (out.length) out[out.length - 1][1].push(line);
  }
  return out;
}

function numbered(md) {
  return sections(md).filter((s) => /^\d+[.)]?\s/.test(s[0]));
}

const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

// 맨 위 수준 목록 항목 → [[본문, 하위 항목들]]
function listItems(lines) {
  const items = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m && !m[1]) items.push([m[2], []]);
    else if (m && items.length) items[items.length - 1][1].push(m[2]);
  }
  return items;
}

// 짧은 머리 항목(굵은 소제목)이면 첫 하위 항목을 이어 붙인다
function itemText(top, children) {
  top = clean(top);
  if (top.length < 30 && children.length) return `${top} ${clean(children[0])}`;
  return top;
}

// 여러 하위 질문의 목록에서 번갈아 하나씩 뽑아 중복 없이 모은다
function roundRobin(lists) {
  const out = []; let i = 0;
  while (lists.some((x) => i < x.length)) {
    for (const x of lists) {
      if (i < x.length) {
        const s = clean(x[i]);
        if (s && !out.includes(s)) out.push(s);
      }
    }
    i += 1;
  }
  return out;
}

const FIELDS = {
  question: ['연구 질문', '질문', 'research question', 'question'],
  design: ['설계', '연구 설계', 'design', 'study design'],
  sample: ['표본', '대상', 'sample', 'participants'],
  contribution: ['기대 기여', '기여', 'expected contribution', 'contribution'],
};
const LABEL = /^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/;

function futureStudies(md) {
  const sec = sections(md).find((s) => s[0].includes('향후') || s[0].toLowerCase().includes('future'));
  if (!sec) return [];
  const studies = []; let cur = null;
  for (const line of sec[1]) {
    if (line.startsWith('### ')) {
      const title = clean(line.slice(4)).replace(/^(연구|Study)\s*\d+\s*[:.．]\s*/i, '');
      cur = { title, items: [] };
      studies.push(cur);
    } else if (cur) {
      const m = ITEM.exec(line);
      if (m && !m[1]) cur.items.push([m[2], []]);
      else if (m && cur.items.length) cur.items[cur.items.length - 1][1].push(clean(m[2]));
    }
  }
  return studies.map((st) => {
    const row = Object.fromEntries(FUTURE_KEYS.map((k) => [k, '']));
    row.title = st.title;
    for (const [top, kids] of st.items) {
      const m = LABEL.exec(top.trim());
      if (!m) continue;
      const label = rstripChars(clean(m[1]), ':：').trim().toLowerCase();
      for (const [key, names] of Object.entries(FIELDS)) {
        if (names.includes(label) && !row[key]) row[key] = clean(m[2]) || kids.join(' ');
      }
    }
    return row;
  });
}

// LLM 없이 규칙으로 개요를 만든다. 어떤 result가 와도 같은 모양을 돌려준다
export function fallbackOutline(result) {
  result = result || {};
  const L = LIMITS;
  const md = result.report_markdown || '';
  const syn = isObj(result.syntheses) ? result.syntheses : {};
  const planIds = (result.plan?.sub_questions || []).filter((q) => isObj(q) && q.id).map((q) => q.id);
  const order = [...planIds.filter((q) => Object.hasOwn(syn, q)), ...Object.keys(syn).filter((q) => !planIds.includes(q))];
  const nums = numbered(md);

  const findings = order.map((qid) => {
    const s = isObj(syn[qid]) ? syn[qid] : {};
    const bullets = [];
    for (const kf of Array.isArray(s.key_findings) ? s.key_findings : []) {
      if (!isObj(kf)) continue;
      const ids = (Array.isArray(kf.sources) ? kf.sources : []).filter(isStr).slice(0, 3);
      const tail = ids.length ? ` [${ids.join(', ')}]` : '';
      const body = firstSentences(clean(kf.finding).replace(citeWs(), ''), L.bullets[1] - tail.length);
      if (body) bullets.push(rstripChars(body, '.') + tail + (body.endsWith('.') ? '.' : ''));
    }
    return { subq_id: qid, headline: firstSentences(s.answer, L.headline), bullets, strength: s.evidence_strength };
  });

  let summary = [];
  if (nums.length) summary = listItems(nums[0][1]).map(([t, k]) => firstSentences(itemText(t, k), L.summary[1]));
  if (!summary.length) summary = findings.filter((f) => f.headline).map((f) => f.headline);

  let limitations = [];
  if (nums.length > 1) {
    limitations = listItems(nums[nums.length - 1][1]).map(([t, k]) => firstSentences(itemText(t, k), L.limitations[1]));
  }

  const sources = (Array.isArray(result.sources) ? result.sources : []).filter(isObj);
  const inText = new Set(citedIds(md));
  const cited = sources.filter((s) => s.sid && (s.cited || inText.has(s.sid)))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const must = cited.slice(0, 5).map((s) => ({ sid: s.sid, why: s.key_finding || s.title || '' }));

  const lang = result.lang;
  const nQ = order.length; const nInc = sources.filter((s) => s.included).length;
  const subtitle = lang === 'ko' ? `연구 브리프 · 하위 질문 ${nQ}개 · 채택 문헌 ${nInc}건`
    : `Research brief · ${nQ} sub-questions · ${nInc} included sources`;

  const vals = order.map((q) => (isObj(syn[q]) ? syn[q] : {}));
  const lists = (key) => vals.map((v) => (Array.isArray(v[key]) ? v[key] : []));
  return normalizeOutline({
    title: result.topic || result.prompt || (lang === 'ko' ? '연구 브리프' : 'Research brief'),
    subtitle,
    summary,
    findings,
    agreements: roundRobin(lists('consensus')),
    conflicts: roundRobin(lists('disagreements')),
    gaps: roundRobin(lists('gaps')),
    future_studies: futureStudies(md),
    must_read: must,
    limitations,
  }, result);
}

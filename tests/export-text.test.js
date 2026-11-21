// 결과물(텍스트 형식) 테스트: 두 샘플로 md · html · bib · ris · csv · json을 만들고 구조를 확인한다. 네트워크 없이 돈다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from '../vendor/jszip.js';
import * as theme from '../assets/js/export/theme.js';
import { citedIds, includedSources, referenceSources, shortCite, metaInfo } from '../assets/js/export/common.js';
import { buildMarkdown } from '../assets/js/export/markdown.js';
import { buildHtml, renderFragment, renderMarkdown, linkCites } from '../assets/js/export/html.js';
import { buildBibtex, buildCsv, buildRis, parseCsv, CSV_COLUMNS } from '../assets/js/export/refs.js';
import { DECK_LIMITS, DECK_SCHEMA, STRENGTHS, clip, emLen, fallbackDeck, figureOf, isDeck, makeDeck, normalizeDeck, numbered,
  sections, subqLabels } from '../assets/js/export/slides.js';
import { FakeLLM } from './fakes.js';
import { FORMATS, exportBundle, exportFile, filenameFor, slugify } from '../assets/js/export/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_IDS = ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication'];
const samples = Object.fromEntries(SAMPLE_IDS.map((id) => [id,
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'result.json'), 'utf8'))]));
const TEXT_FORMATS = ['md', 'html', 'pdf', 'bib', 'ris', 'csv', 'json'];
// 발표 구성안(v2)의 키 순서 (docs/SLIDES_V2.md 1절)
const DECK_KEYS = ['version', 'source', 'title', 'subtitle', 'question', 'context', 'answer', 'answer_caveat', 'messages',
  'agree', 'conflict', 'conflict_why', 'gaps', 'next_studies', 'cautions', 'takeaways', 'closing', 'must_read',
  'subq_labels', 'notes'];
const NOTE_KEYS = ['opening', 'answer', 'landscape', 'strength', 'tension', 'gaps', 'next', 'cautions', 'closing'];

// 구성안의 모양과 모든 길이·개수 제한, 문헌 id가 result에 있는지 확인한다
function assertDeck(d, r) {
  const L = DECK_LIMITS;
  assert.deepEqual(Object.keys(d), DECK_KEYS);
  assert.equal(d.version, 2);
  assert.ok(isDeck(d));
  const known = new Set((r?.sources || []).filter((s) => s && s.sid).map((s) => s.sid));
  const short = (s, n, what) => {
    assert.equal(typeof s, 'string', what);
    assert.ok(emLen(s) <= n, `${what} (${emLen(s)} > ${n}): ${s}`);
    for (const id of (s.match(/\[S\d+(?:\s*,\s*S\d+)*\]/g) || []).join(' ').match(/S\d+/g) || []) {
      assert.ok(known.has(id), `${what}: 없는 문헌 ${id}`);
    }
  };
  const many = (xs, k, n, what) => {
    assert.ok(Array.isArray(xs) && xs.length <= k, what);
    xs.forEach((x, i) => short(x, n, `${what}[${i}]`));
  };
  for (const k of ['title', 'subtitle', 'question', 'answer', 'answer_caveat', 'conflict_why', 'closing']) short(d[k], L[k], k);
  many(d.context, L.context.max, L.context.len, 'context');
  many(d.agree, L.agree.max, L.agree.len, 'agree');
  many(d.conflict, L.conflict.max, L.conflict.len, 'conflict');
  many(d.cautions, L.cautions.max, L.cautions.len, 'cautions');
  many(d.takeaways, L.takeaways.max, L.takeaways.len, 'takeaways');
  assert.ok(d.messages.length <= L.messages.max);
  for (const m of d.messages) {
    assert.deepEqual(Object.keys(m), ['headline', 'points', 'takeaway', 'strength', 'subq_ids', 'notes']);
    short(m.headline, L.headline, 'headline'); short(m.takeaway, L.takeaway, 'takeaway');
    short(m.notes, L.message_notes, 'message.notes');
    assert.ok(STRENGTHS.includes(m.strength), m.strength);
    assert.ok(m.points.length <= L.points.max);
    for (const p of m.points) {
      assert.deepEqual(Object.keys(p), ['figure', 'text', 'detail', 'sids']);
      short(p.figure, L.figure, 'figure'); short(p.text, L.text, 'text'); short(p.detail, L.detail, 'detail');
      assert.ok(p.sids.length <= L.sids);
      for (const sid of p.sids) assert.ok(known.has(sid), sid);
    }
  }
  assert.ok(d.gaps.length <= L.gaps.max);
  for (const g of d.gaps) { short(g.gap, L.gaps.gap, 'gap'); short(g.why, L.gaps.why, 'gap.why'); }
  assert.ok(d.next_studies.length <= L.next_studies.max);
  for (const st of d.next_studies) {
    assert.deepEqual(Object.keys(st), ['title', 'design', 'sample', 'payoff']);
    for (const k of Object.keys(st)) short(st[k], L.next_studies[k], `next_studies.${k}`);
  }
  assert.ok(d.must_read.length <= L.must_read.max);
  for (const m of d.must_read) { assert.ok(known.has(m.sid), m.sid); short(m.why, L.must_read.why, 'must_read.why'); }
  for (const x of d.subq_labels) short(x.label, L.subq_label, 'subq_label');
  assert.deepEqual(Object.keys(d.notes), NOTE_KEYS);
  for (const k of NOTE_KEYS) short(d.notes[k], L.notes, `notes.${k}`);
}

// 코드 블록 밖의 ##/### 제목
function mdHeadings(md) {
  const out = []; let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{2,3}\s/.test(line)) out.push(line);
  }
  return out;
}

// 이스케이프되지 않은 중괄호 짝 검사
function bracesBalanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}

function assertInert(html) {
  assert.doesNotMatch(html, /<script/i, 'script 태그');
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, '이벤트 속성');
  assert.doesNotMatch(html, /href\s*=\s*["']?\s*(javascript|vbscript|data):/i, '위험한 주소');
  assert.doesNotMatch(html, /href\s*=\s*["']?\/\//i, '프로토콜 상대 주소');
  assert.doesNotMatch(html, /<(img|iframe|object|embed|link|meta http-equiv|base|form|svg)\b/i, '외부 리소스 태그');
}

for (const id of SAMPLE_IDS) {
  const r = samples[id];
  describe(`샘플 ${id}`, () => {
    test('Markdown: 부록 네 개, 채택 문헌마다 표 한 줄', () => {
      const md = buildMarkdown(r);
      for (const h of ['## 부록 A. 근거 비교표', '## 부록 B. 참고문헌', '## 부록 C. 인용 검증', '## 부록 D. 에이전트 수행 기록']) {
        assert.ok(md.includes('\n' + h + '\n'), h);
      }
      assert.ok(md.startsWith('# 연구 조사 보고서\n'));
      const a = md.indexOf('## 부록 A.'); const b = md.indexOf('## 부록 B.');
      const rows = md.slice(a, b).split('\n').filter((l) => /^\| S\d+ \|/.test(l));
      const inc = includedSources(r);
      assert.equal(rows.length, inc.length);
      assert.ok(inc.length > 0);
      for (const row of rows) assert.equal(row.split(' | ').length, 5, row.slice(0, 40));
      const refs = md.slice(b, md.indexOf('## 부록 C.')).split('\n').filter((l) => l.startsWith('- **[S'));
      assert.equal(refs.length, referenceSources(r).length);
      const trace = md.slice(md.indexOf('## 부록 D.')).split('\n').filter((l) => l.startsWith('- `'));
      assert.equal(trace.length, (r.trace || []).length);
      assert.ok(md.includes('in ' + metaInfo(r).input_tokens.toLocaleString('en-US')));
    });

    test('본문 조각: 인용 링크는 있는 문헌만, 목차 = 제목', () => {
      const { html, toc } = renderFragment(r);
      const sids = new Set(r.sources.map((s) => s.sid));
      const linked = [...html.matchAll(/href="#ref-(S\d+)"/g)].map((m) => m[1]);
      assert.ok(linked.length > 10);
      for (const sid of linked) assert.ok(sids.has(sid), sid);
      // 본문에서 인용된 ID가 모두 링크 또는 cite-unknown으로 처리됨
      const cited = citedIds(r.report_markdown);
      for (const sid of cited) assert.ok(html.includes(`data-sid="${sid}"`) || html.includes(`cite-unknown">${sid}<`), sid);
      const heads = mdHeadings(r.report_markdown);
      assert.equal(toc.length, heads.length);
      toc.forEach((t, i) => {
        assert.equal(t.id, `sec-${i + 1}`);
        assert.equal(t.level, heads[i].startsWith('### ') ? 3 : 2);
        assert.ok(html.includes(`<h${t.level} id="${t.id}">`), t.id);
        assert.ok(t.title.length > 0);
      });
      assert.equal(toc[0].title, '1. 핵심 요약');
      assertInert(html);
    });

    test('단독 HTML: 모든 내부 링크의 대상이 있고 외부 리소스·스크립트가 없다', () => {
      const html = buildHtml(r);
      assert.ok(html.startsWith('<!doctype html><html lang="ko">'));
      assert.ok(html.trimEnd().endsWith('</html>'));
      assert.ok(html.includes('<style>') && html.includes('@page wide'));
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      assert.ok(targets.length > 20);
      for (const t of targets) assert.ok(ids.has(t), `#${t}`);
      for (const s of referenceSources(r)) assert.ok(ids.has(`ref-${s.sid}`));
      for (const x of ['appx-a', 'appx-b', 'appx-c', 'appx-d']) assert.ok(ids.has(x));
      assert.equal((html.match(/<tr><td class="sid">/g) || []).length, includedSources(r).length);
      // 바깥 링크는 새 창 + rel
      for (const m of html.matchAll(/<a [^>]*href="https?:[^>]*>/g)) assert.ok(m[0].includes('rel="noopener noreferrer"'), m[0]);
      assert.doesNotMatch(html, /<link|@import|url\(/i);
      assertInert(html);
    });

    test('BibTeX: 키가 겹치지 않고 중괄호 짝이 맞다', () => {
      const bib = buildBibtex(r);
      const entries = bib.trim().split(/\n\n(?=@)/);
      assert.equal(entries.length, referenceSources(r).length);
      const keys = entries.map((e) => /^@(article|misc)\{([^,\s]+),\n/.exec(e)?.[2]);
      for (const k of keys) assert.ok(k && /^[a-z0-9]+[A-Za-z0-9]*$/.test(k), String(k));
      assert.equal(new Set(keys).size, keys.length);
      for (const e of entries) {
        assert.ok(bracesBalanced(e), e.slice(0, 80));
        assert.ok(e.endsWith('\n}'));
        assert.match(e, /note = \{(Preprint; )?S\d+/);
      }
    });

    test('RIS: TY와 ER 수 = 채택 문헌 수', () => {
      const ris = buildRis(r);
      const lines = ris.split('\n');
      const n = referenceSources(r).length;
      assert.equal(lines.filter((l) => l.startsWith('TY  - ')).length, n);
      assert.equal(lines.filter((l) => l === 'ER  - ').length, n);
      for (const l of lines) if (l) assert.match(l, /^[A-Z][A-Z0-9]  - /);
    });

    test('CSV: 행 수 = 수집 문헌 + 머리글, 다시 읽어도 같다', () => {
      const csv = buildCsv(r);
      assert.ok(csv.startsWith('﻿sid,included,'));
      const rows = parseCsv(csv);
      assert.equal(rows.length, r.sources.length + 1);
      assert.deepEqual(rows[0], CSV_COLUMNS);
      for (const row of rows) assert.equal(row.length, CSV_COLUMNS.length);
      const col = (name) => CSV_COLUMNS.indexOf(name);
      const bySid = Object.fromEntries(r.sources.map((s) => [s.sid, s]));
      for (const row of rows.slice(1)) {
        const s = bySid[row[col('sid')]];
        assert.ok(s, row[0]);
        assert.equal(row[col('title')], String(s.title ?? ''));
        assert.equal(row[col('abstract')], String(s.abstract ?? ''));
        assert.equal(row[col('included')], s.included ? 'TRUE' : 'FALSE');
        assert.equal(row[col('authors')], (s.authors || []).join('; '));
      }
      const nums = rows.slice(1).map((x) => parseInt(x[0].slice(1), 10));
      assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
    });

    test('규칙 구성안: 모양 · 제한 · 문헌 id · 완결된 문장', () => {
      const d = fallbackDeck(r);
      assertDeck(d, r);
      assert.equal(d.source, 'rules');
      assert.equal(d.title, r.topic);
      assert.equal(d.subtitle, `채택 문헌 ${r.meta.counts.included}건으로 본 연구 브리프`);
      assert.ok(d.answer.length > 0);
      assert.ok(d.messages.length >= 3 && d.messages.length <= 5, String(d.messages.length));
      for (const m of d.messages) {
        assert.ok(m.headline.length > 0);
        assert.ok(!m.headline.endsWith('…'), `제목이 문장 중간에서 잘림: ${m.headline}`);
        assert.ok(m.points.length >= 1 && m.points.length <= 3, m.headline);
        for (const p of m.points) {
          assert.ok(p.text && !p.text.endsWith('…'), `카드가 문장 중간에서 잘림: ${p.text}`);
          // 큰 숫자는 그 카드의 글에 실제로 있는 값이다
          if (p.figure) assert.ok(p.text.includes(p.figure), `${p.figure} / ${p.text}`);
        }
        for (const q of m.subq_ids) assert.ok(r.plan.sub_questions.some((x) => x.id === q), q);
      }
      assert.ok(d.must_read.length > 0);
      assert.equal(d.takeaways.length, 3);
      assert.ok(d.gaps.length > 0 && d.next_studies.length > 0 && d.cautions.length > 0);
      assert.deepEqual(d.subq_labels.map((x) => x.id), r.plan.sub_questions.map((q) => q.id));
      for (const x of d.subq_labels) assert.ok(x.label && !x.label.endsWith('…'), x.label);
      assert.deepEqual(d.subq_labels, subqLabels(r));
      assert.deepEqual(normalizeDeck(d, r), d);   // 이미 정규화된 구성안은 그대로(멱등)
    });

    const planFile = path.join(ROOT, 'data', 'samples', id, 'slides.json');
    test('미리 만든 구성안(slides.json)은 정규화해도 그대로', { skip: !fs.existsSync(planFile) }, () => {
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      assert.equal(plan.source, 'sample');
      assert.ok(isDeck(plan));
      const n = normalizeDeck(plan, r, 'sample');
      assert.deepEqual(n, plan);   // deepEqual은 키 순서를 따지지 않는다
      assertDeck(n, r);
    });
  });
}

describe('빈 결과 · 일부만 있는 결과', () => {
  const partial = {
    topic: 'Partial', lang: 'en', report_markdown: '# T\n## One [S1]\nText [S1, S9].\n### Sub `code`\n',
    sources: [{ sid: 'S1', included: true, title: 'A', authors: null, year: null, score: null },
      { sid: 'S2' }, { title: 'no sid' }, null],
    verification: { checks: [{ claim: null }, null, { verdict: 'contradicted', revised: 'x [S1]' }] },
    trace: [null, { msg: 'm' }], meta: { usage: {}, counts: null },
    syntheses: { Q1: null, Q2: { key_findings: [null, { finding: 'F [S1].', sources: ['S1', 3] }] } },
    plan: { sub_questions: [null, { id: 'Q2' }] },
  };
  for (const [name, r] of [['빈 객체', {}], ['null', null], ['일부', partial]]) {
    test(`${name}: 모든 텍스트 형식과 구성안이 죽지 않는다`, async () => {
      for (const fmt of TEXT_FORMATS) {
        const out = await exportFile(r, fmt);
        assert.equal(typeof out.data, 'string', fmt);
        assert.ok(out.filename.length > 0);
      }
      const d = fallbackDeck(r);
      assertDeck(d, r);
      assert.deepEqual(normalizeDeck(d, r), d);
      assertDeck(normalizeDeck(null, r), r);
      const f = renderFragment(r);
      assert.ok(Array.isArray(f.toc));
      assertInert(buildHtml(r));
    });
  }
  test('일부: 목차와 인용 처리', () => {
    const { html, toc } = renderFragment(partial);
    assert.deepEqual(toc.map((t) => [t.id, t.level, t.title]), [['sec-1', 2, 'One [S1]'], ['sec-2', 3, 'Sub code']]);
    assert.ok(html.includes('<span class="cite-unknown">S9</span>'));
    assert.ok(html.includes('href="#ref-S1"'));
    const md = buildMarkdown(partial);
    assert.ok(md.includes('## Appendix D. Agent trace'));
    assert.equal(buildRis(partial).split('\n').filter((l) => l.startsWith('TY')).length, 1);
    assert.equal(parseCsv(buildCsv(partial)).length, 4);
    assert.equal(buildBibtex({}), '');
  });
});

describe('보안: 단독 HTML과 조각은 실행되는 내용이 없다', () => {
  const evil = {
    topic: '<script>alert(1)</script><b>"T"</b>', prompt: '<img src=x onerror=alert(1)>', lang: 'ko',
    report_markdown: [
      '# 제목', '## 1. <script>alert(1)</script> 요약',
      '<script>alert("x")</script>', '<img src=x onerror="alert(1)">',
      '[js](javascript:alert(1)) [JS](JAVASCRIPT:alert(1)) [pr](//evil.example/x) [rel](./a.html) [mail](mailto:a@b.c)',
      '[ok](https://example.com/a?b=1) [anchor](#ref-S1) ![pic](https://evil.example/p.png) <a href="javascript:x">a</a>',
      '[S1](javascript:alert(1)) [S2]', '', '| a | b |', '|---|---|', '| x<br>y | <br onclick=alert(1)> |',
      '<iframe src="https://e"></iframe> <svg onload=alert(1)>',
    ].join('\n'),
    sources: [{ sid: 'S1', included: true, title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)',
      authors: ['<script>x</script> Smith'], venue: '<b>v</b>', kind: '<i>k', limitation: '"><script>',
      key_finding: '<svg onload=alert(1)>', direction: '<x>', study_type: "'><img>" },
    { sid: 'S2', included: true, title: 't', url: '//evil.example', doi: 'javascript:1' }],
    verification: { checks: [{ claim: '<script>c</script> [S1]', verdict: '<b>', note: '<img onerror=1>',
      revised: '"><img src=x onerror=1> [S1]', verdict_after: 'supported', note_after: '<script>' }],
    unknown_ids: ['<script>'], cited_ids: '<b>' },
    trace: [{ ts: '2026-01-01T00:00:00<script>', stage: '<script>', msg: '<img src=x onerror=1>' }],
    meta: { note: '<script>alert(1)</script>', model_label: '<img onerror=1>' },
  };

  test('buildHtml', () => {
    const html = buildHtml(evil);
    assertInert(html);
    assert.ok(html.includes('<title>&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;&quot;T&quot;&lt;/b&gt; · '));
    assert.ok(html.includes('<td>x<br>y</td>'), '표 칸의 <br>만 되돌린다');
    assert.ok(html.includes('&lt;br onclick=alert(1)&gt;'));
    assert.ok(html.includes('<a target="_blank" rel="noopener noreferrer" href="https://example.com/a?b=1">')
      || html.includes('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">'));
    assert.ok(html.includes('<a href="#ref-S1">anchor</a>'));
    assert.ok(!html.includes('href="javascript'), 'javascript 링크');
    assert.ok(!html.includes('href="./a.html"') && !html.includes('href="mailto'));
    assert.ok(!/href="[^"]*evil/.test(html), 'evil 주소가 링크로 남지 않는다');
  });

  test('renderFragment · renderMarkdown · linkCites', () => {
    assertInert(renderFragment(evil).html);
    const qa = renderMarkdown(evil.report_markdown, ['S1']);
    assertInert(qa);
    assert.doesNotMatch(qa, /id="sec-/);
    assert.equal(linkCites('[S1, S2]', ['S1']),
      '<span class="cites">[<a class="cite" data-sid="S1" href="#ref-S1">S1</a>, <span class="cite-unknown">S2</span>]</span>');
    // [S12](설명)은 링크가 되지 않고 인용으로 남는다
    assert.ok(renderMarkdown('see [S1](x)', ['S1']).includes('<a class="cite" data-sid="S1" href="#ref-S1">S1</a>]</span>(x)'));
    // 코드 안의 인용은 그대로
    assert.ok(renderMarkdown('`[S1]`', ['S1']).includes('<code>[S1]</code>'));
  });

  test('Markdown·참고문헌은 글자 그대로(HTML 아님)', () => {
    const bib = buildBibtex(evil);
    for (const e of bib.trim().split(/\n\n(?=@)/)) assert.ok(bracesBalanced(e));
    assert.ok(buildRis(evil).includes('TI  - <img src=x onerror=alert(1)>'));
  });
});

describe('파일 이름 · 형식', () => {
  test('slugify', () => {
    assert.equal(slugify('생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향'), '생성형_AI_활용이_대학원생의_연구_생산성과_연구_품질에_미치는_영향');
    assert.equal(slugify('a<b>:c"d/e\\f|g?h*i'), 'a_b_c_d_e_f_g_h_i');
    assert.equal(slugify('  ..//  '), 'research');
    assert.equal(slugify(''), 'research');
    assert.equal(slugify(null), 'research');
    assert.equal(slugify('ㄱㄴ ㅏㅣ 漢字 é'), 'ㄱㄴ_ㅏㅣ');
    assert.equal(slugify('x'.repeat(39) + ' y'), 'x'.repeat(39));
    assert.ok(slugify('가'.repeat(100)).length === 40);
  });

  test('filenameFor', () => {
    const r = { topic: '롤러를 활용한 센서: 제작/공정?' };
    assert.equal(filenameFor(r, 'docx'), '롤러를_활용한_센서_제작_공정_report.docx');
    assert.equal(filenameFor(r, 'pptx'), '롤러를_활용한_센서_제작_공정_slides.pptx');
    assert.equal(filenameFor(r, 'bib'), '롤러를_활용한_센서_제작_공정_references.bib');
    assert.equal(filenameFor(r, 'ris'), '롤러를_활용한_센서_제작_공정_references.ris');
    assert.equal(filenameFor(r, 'csv'), '롤러를_활용한_센서_제작_공정_evidence.csv');
    assert.equal(filenameFor(r, 'json'), '롤러를_활용한_센서_제작_공정_result.json');
    assert.equal(filenameFor({ prompt: 'only prompt' }, 'md'), 'only_prompt_report.md');
    assert.equal(filenameFor({}, 'html'), 'research_report.html');
    assert.throws(() => filenameFor(r, 'exe'), /알 수 없는 형식/);
    assert.throws(() => filenameFor(r, 'constructor'), /알 수 없는 형식/);
  });

  test('FORMATS 순서와 pdf 설명', () => {
    assert.deepEqual(FORMATS.map((f) => f.id), ['md', 'html', 'pdf', 'docx', 'pptx', 'bib', 'ris', 'csv', 'json']);
    assert.equal(FORMATS.find((f) => f.id === 'pdf').description, "인쇄 창에서 'PDF로 저장'");
    for (const f of FORMATS) for (const k of ['id', 'label', 'ext', 'mime', 'description', 'group']) assert.ok(f[k], `${f.id}.${k}`);
  });

  test('exportFile: 텍스트 형식 7개', async () => {
    const r = samples[SAMPLE_IDS[0]];
    const md = await exportFile(r, 'md');
    assert.equal(md.mime, 'text/markdown; charset=utf-8');
    assert.equal(md.filename, '생성형_AI_활용이_대학원생의_연구_생산성과_연구_품질에_미치는_영향_report.md');
    assert.equal(md.data, buildMarkdown(r));
    const html = await exportFile(r, 'html');
    assert.equal(html.data, buildHtml(r));
    const pdf = await exportFile(r, 'pdf');
    assert.equal(pdf.print, true);
    assert.equal(pdf.mime, 'text/html');
    assert.ok(pdf.data.startsWith('<!doctype html>'));
    assert.ok(pdf.filename.endsWith('_report.pdf'));
    assert.ok((await exportFile(r, 'bib')).data.startsWith('@'));
    assert.ok((await exportFile(r, 'ris')).data.startsWith('TY  - '));
    assert.ok((await exportFile(r, 'csv')).data.startsWith('﻿'));
    const json = await exportFile(r, 'json');
    assert.deepEqual(JSON.parse(json.data), r);
    await assert.rejects(exportFile(r, 'exe'), /알 수 없는 형식/);
  });

  test('exportBundle: 올바른 zip', async () => {
    const r = samples[SAMPLE_IDS[1]];
    const files = [];
    for (const fmt of ['md', 'html', 'pdf', 'csv']) files.push(await exportFile(r, fmt));
    files.push({ filename: 'bin.dat', data: new Uint8Array([1, 2, 3]).buffer });
    const zipBytes = await exportBundle(r, files);
    assert.ok(zipBytes instanceof Uint8Array);
    assert.equal(zipBytes[0], 0x50); assert.equal(zipBytes[1], 0x4b);
    const zip = await JSZip.loadAsync(zipBytes);
    const names = Object.keys(zip.files).sort();
    const slug = slugify(r.topic);
    assert.deepEqual(names, ['bin.dat', 'result.json', `${slug}_evidence.csv`, `${slug}_report.html`, `${slug}_report.md`].sort());
    assert.equal(await zip.file(`${slug}_report.md`).async('string'), buildMarkdown(r));
    assert.deepEqual(JSON.parse(await zip.file('result.json').async('string')), r);
    assert.deepEqual([...await zip.file('bin.dat').async('uint8array')], [1, 2, 3]);
    // 객체 형태 + pdf만 있을 때는 .html로 들어간다
    const z2 = await JSZip.loadAsync(await exportBundle(r, { [pdfName(r)]: 'x' }));
    assert.ok(z2.file(pdfName(r)) && z2.file('result.json'));
    const z3 = await JSZip.loadAsync(await exportBundle(r, [await exportFile(r, 'pdf')]));
    assert.ok(z3.file(`${slug}_report.html`));
  });
});

function pdfName(r) { return filenameFor(r, 'pdf'); }

describe('발표 구성안: 글자 폭과 자르기', () => {
  test('emLen: 한글 1, 그 밖의 글자 0.55, 인용 표기는 세지 않는다', () => {
    assert.equal(emLen('가나다'), 3);
    assert.equal(emLen('abc'), 1.65);
    assert.equal(emLen('가 a'), 2.1);
    assert.equal(emLen('줄었다 [S12].'), emLen('줄었다.'));
    assert.equal(emLen('a [S3, S4] b [S5][S6]'), emLen('a b'));
    assert.equal(emLen(''), 0);
    assert.equal(emLen(null), 0);
    assert.equal(emLen('x'.repeat(20)), 11);   // 부동소수 오차 없이
  });

  test('clip: 문장 끝 → 절·단어 경계 + …, 인용은 자르지 않는다', () => {
    assert.equal(clip('짧은 글 [S1].', 10), '짧은 글 [S1].');
    // 문장 끝에서 자를 수 있으면 거기서(인용은 제자리)
    assert.equal(clip('첫 문장이다 [S1]. 둘째 문장은 아주 길어서 들어가지 않는다 [S2].', 12), '첫 문장이다 [S1].');
    // 문장 끝이 없으면 단어 경계에서 자르고 …, 인용 id는 끝에 3개까지
    const c = clip('가나다라 마바사아 자차카타 파하가나 다라마바 [S1][S2][S3][S4]', 12);
    assert.equal(c, '가나다라 마바사아…' + ' [S1, S2, S3]');
    assert.ok(emLen(c) <= 12);
    // 절 경계(쉼표)를 단어 경계보다 먼저 쓴다
    assert.equal(clip('하나 둘 셋 넷 다섯 여섯, 일곱 여덟 아홉 열 열하나 열둘', 20), '하나 둘 셋 넷 다섯 여섯…');
    // 영어 단어 가운데에서 자르지 않는다
    const en = clip('The quick brown fox jumps over the lazy dog again and again', 12);
    assert.ok(en.endsWith('…') && emLen(en) <= 12, en);
    assert.ok(/^The quick brown( fox)?…$/.test(en), en);
    for (const s of [c, en]) assert.equal(clip(s, 12), s);   // 다시 잘라도 같다
  });
});

describe('발표 구성안: 큰 숫자(figureOf)', () => {
  test('숫자+단위를 한 덩어리로 잡는다(Ω · Ω/sq · µm · 달러 · %p · 개월 …)', () => {
    assert.equal(figureOf('저항 평균 99.63 Ω(SD 8.10 Ω)'), '99.63 Ω');
    assert.equal(figureOf('0.05달러 미만'), '0.05달러');
    assert.equal(figureOf('3.02배 높았다'), '3.02배');
    assert.equal(figureOf('변화 3.2%p'), '3.2%p', '%p가 %보다 먼저 맞는다');
  });

  test('범위 · 변화 · ± 도 한 덩어리', () => {
    assert.equal(figureOf('면저항 7.0→3.5 Ω/sq'), '7.0→3.5 Ω/sq');
    assert.equal(figureOf('폭 6-7 µm'), '6-7 µm');
    assert.equal(figureOf('폭 6-7 μm'), '6-7 μm', '그리스 문자 뮤(μ)도');
    assert.equal(figureOf('(±25 µm)'), '±25 µm');
    assert.equal(figureOf('0.0%~100.0% 범위'), '0.0%~100.0%');
  });

  test('연도와 단위 없는 숫자는 건너뛴다', () => {
    assert.equal(figureOf('2025년 이후 문헌 37건'), '37건');
    assert.equal(figureOf('2023–2026년 문헌이 60%'), '60%');
    assert.equal(figureOf('2023–2026년'), '');
    assert.equal(figureOf('p = 0.05 수준'), '');
    assert.equal(figureOf('효과크기는 0.45였다'), '');
  });

  test('첫 번째 것을 쓴다 · 영어 문장 · 너무 긴 숫자는 쓰지 않는다', () => {
    assert.equal(figureOf('56.7%, 전문직에서 40%'), '56.7%');
    assert.equal(figureOf('12개월 추적에서 3.2%p'), '12개월');
    assert.equal(figureOf('fell by 40% in 2023'), '40%');
    const long = '12,345,678,901,234명';
    assert.ok(emLen(long) > DECK_LIMITS.figure);
    assert.equal(figureOf(`${long}이 응답`), '');
    assert.ok(emLen(figureOf('1,234,567,890명이 응답')) <= DECK_LIMITS.figure);
  });

  test('빼기표가 붙은 수는 쓰지 않는다(부호를 떼면 뜻이 반대가 된다)', () => {
    const MINUS = String.fromCharCode(0x2212), ENDASH = String.fromCharCode(0x2013);
    assert.equal(figureOf(`효과 크기 ${MINUS}0.3 SD였다`), '');
    assert.equal(figureOf(`변화율 ${ENDASH}12%였다`), '');
    assert.equal(figureOf('-12.5% 감소'), '');
    assert.equal(figureOf('효과크기는 0.3 SD였다'), '0.3 SD', '부호가 없으면 그대로');
  });

  test('단위가 더 긴 낱말 · 다른 단위의 앞부분이면 쓰지 않는다', () => {
    for (const t of ['3개국 연구', '전국 20개교', '4년제 대학생', '석사 2년차', '2.4 개념적 모호성', '4.3 종합 판단', '약 2 명확한',
      '약 0.5 Ω/cm를 기록했다']) assert.equal(figureOf(t), '', t);
    // 조사 · 접미사가 붙은 단위는 그대로 쓴다
    assert.equal(figureOf('표본은 453명으로 늘었다'), '453명');
    assert.equal(figureOf('3년간 추적했다'), '3년');
    assert.equal(figureOf('참가자 100명당 3건'), '100명');
    assert.equal(figureOf('5개로 나뉜다'), '5개');
    assert.equal(figureOf('작성 시간은 대학원생에서 56.7% 줄었다'), '56.7%', "'에서'는 범위가 아닐 때도 많다");
  });

  test('신뢰수준과 범위의 뒤쪽 값은 결과가 아니다', () => {
    assert.equal(figureOf('OR 2.1 (95% CI 1.2-3.4)'), '');
    assert.equal(figureOf('ranged from 0.2 to 0.5 SD'), '');
    assert.equal(figureOf('0.2에서 0.5 SD까지'), '');
    assert.equal(figureOf('2023년부터 40% 증가했다'), '40%');
  });
});

describe('발표 구성안: 보고서 줄 나누기', () => {
  // U+2028(줄 구분자) · U+2029(문단 구분자)는 글자 그대로 쓰지 않고 코드로 만든다
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

  test('sections · numbered는 U+2028 · U+2029에서도 줄을 나눈다', () => {
    const md = `## 1. 요약${LS}본문 하나${PS}## 참고${LS}- x${PS}## 2) 결론${LS}끝`;
    assert.deepEqual(sections(md), [['1. 요약', ['본문 하나']], ['참고', ['- x']], ['2) 결론', ['끝']]]);
    assert.deepEqual(numbered(md), [['1. 요약', ['본문 하나']], ['2) 결론', ['끝']]]);
  });

  test('소스 파일에 U+2028 · U+2029 글자가 그대로 들어 있지 않다', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(ROOT, 'assets', 'js'));
    walk(path.join(ROOT, 'tests'));
    assert.ok(files.length > 10, `파일 ${files.length}개`);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!src.includes(LS) && !src.includes(PS), path.relative(ROOT, f));
    }
  });
});

describe('발표 구성안: normalizeDeck', () => {
  const r = samples[SAMPLE_IDS[0]];
  const known = new Set(r.sources.map((s) => s.sid));
  assert.ok(known.has('S3') && known.has('S15') && !known.has('S999'));

  test('어떤 입력이 와도 같은 모양(빈 값으로 채운다)', () => {
    for (const x of [null, undefined, 5, 'x', [], {}, { messages: 'bad', notes: [], gaps: {}, subq_labels: null }]) {
      for (const res of [r, null, {}]) {
        const d = normalizeDeck(x, res);
        assert.deepEqual(Object.keys(d), DECK_KEYS);
        assert.deepEqual(Object.keys(d.notes), NOTE_KEYS);
        assert.deepEqual(d.messages, []);
        assert.equal(d.source, 'rules');
      }
    }
    const d = normalizeDeck({}, r);
    assert.equal(d.title, r.topic);   // 표지 제목이 비면 주제
    assert.deepEqual(d.subq_labels.map((x) => x.id), r.plan.sub_questions.map((q) => q.id));
    assert.deepEqual(d.subq_labels, subqLabels(r));
    assertDeck(d, r);
  });

  test('source: 인자 → 입력의 source → rules', () => {
    assert.equal(normalizeDeck({ source: 'sample' }, r).source, 'sample');
    assert.equal(normalizeDeck({ source: 'sample' }, r, 'llm').source, 'llm');
    assert.equal(normalizeDeck({ source: 'bogus' }, r).source, 'rules');
    assert.equal(normalizeDeck({}, r, 'bogus').source, 'rules');
  });

  test('없는 문헌 id는 sids · must_read · 글 안에서 지운다', () => {
    const d = normalizeDeck({
      answer: '시간이 줄었다 [S3, S999]. 품질은 엇갈린다 [S999].',
      agree: ['일치한다 [S999][S15]', '[S999]'],
      messages: [{ headline: 'h', points: [{ figure: '40%', text: 't [S999]', detail: '', sids: ['S999', '[S15]', 'S15', 'S3', 'S55', 'S7'] }],
        takeaway: '', strength: 'weak', subq_ids: ['Q1', 'Q99', 'Q1', 3], notes: '노트 [S15, S999]' }],
      must_read: [{ sid: '[S15]', why: 'w [S999]' }, { sid: 'S15', why: 'dup' }, { sid: 'S999', why: 'x' }, { sid: 'constructor' }, null],
    }, r);
    assert.equal(d.answer, '시간이 줄었다 [S3]. 품질은 엇갈린다.');
    assert.deepEqual(d.agree, ['일치한다[S15]']);
    const m = d.messages[0];
    assert.equal(m.points[0].text, 't');
    assert.deepEqual(m.points[0].sids, ['S15', 'S3', 'S55']);   // 있는 것만, 중복 없이, 3개까지
    assert.deepEqual(m.subq_ids, ['Q1']);
    assert.equal(m.notes, '노트 [S15]');
    assert.deepEqual(d.must_read, [{ sid: 'S15', why: 'w' }]);
  });

  test('길이 · 개수 제한', () => {
    const long = '가'.repeat(200);
    const msg = (i) => ({ headline: `제목 ${i}`, points: [1, 2, 3, 4].map((k) => ({ figure: '1,234,567,890,123,456명', text: `${long} ${k}`, detail: long, sids: [] })),
      takeaway: long, strength: 'strong', subq_ids: [], notes: long });
    const d = normalizeDeck({
      title: long, subtitle: long, question: long, context: [long, 'a', 'a', 'b', 'c'], answer: long,
      messages: [1, 2, 3, 4, 5, 6, 7].map(msg), agree: ['a', 'b', 'c', 'd'], conflict: [long],
      gaps: [1, 2, 3, 4, 5].map((k) => ({ gap: `g${k}`, why: long })), next_studies: [1, 2, 3, 4].map((k) => ({ title: `t${k}`, design: long })),
      cautions: ['1', '2', '3', '4', '5'], takeaways: ['1', '2', '3', '4'], must_read: [...known].slice(0, 7).map((sid) => ({ sid, why: long })),
      notes: { opening: long.repeat(5) },
    }, r);
    assertDeck(d, r);
    assert.equal(d.messages.length, 5);
    assert.deepEqual(d.messages.map((m) => m.headline), ['제목 1', '제목 2', '제목 3', '제목 4', '제목 5']);
    assert.equal(d.messages[0].points.length, 3);
    assert.equal(d.messages[0].points[0].figure, '');   // 9em을 넘는 숫자는 자르지 않고 비운다
    assert.ok(d.messages[0].points[0].text.endsWith('…'));
    assert.deepEqual(d.context, [clip(long, DECK_LIMITS.context.len), 'a', 'b']);
    assert.equal(d.agree.length, 3);
    assert.equal(d.gaps.length, 4);
    assert.equal(d.next_studies.length, 3);
    assert.deepEqual(d.next_studies[0].sample, '');
    assert.equal(d.cautions.length, 4);
    assert.equal(d.takeaways.length, 3);
    assert.equal(d.must_read.length, 5);
    assert.equal(d.title, '가'.repeat(43) + '…');   // 43em + '…'(0.55em) ≤ 44em
    assert.deepEqual(normalizeDeck(d, r), d);   // 멱등
  });

  test('근거 강도: 답하는 하위 질문의 종합 가운데 가장 약한 값. 종합이 없을 때만 구성안의 값, 그것도 없으면 insufficient', () => {
    const strength = (m) => normalizeDeck({ messages: [{ headline: 'h', ...m }] }, r).messages[0].strength;
    assert.equal(r.syntheses.Q1.evidence_strength, 'moderate');
    assert.equal(r.syntheses.Q2.evidence_strength, 'weak');
    assert.equal(strength({ strength: 'bogus', subq_ids: ['Q1'] }), 'moderate');
    assert.equal(strength({ strength: 'bogus', subq_ids: ['Q1', 'Q2'] }), 'weak');
    assert.equal(strength({ subq_ids: [] }), 'insufficient');
    // 모델이 적은 값이 종합과 다르면 종합을 따른다(메시지 슬라이드의 막대가 부록 A와 어긋나지 않게)
    assert.equal(strength({ strength: 'strong', subq_ids: ['Q2'] }), 'weak');
    assert.equal(strength({ strength: 'strong', subq_ids: [] }), 'strong', '하위 질문이 없으면 구성안의 값');
  });

  test('큰 숫자는 보고서에 있는 수만 남긴다(반올림 · 지어낸 수는 비운다)', () => {
    const fig = (figure) => normalizeDeck({ messages: [{ headline: 'h', points: [{ figure, text: 't' }] }] }, r).messages[0].points[0].figure;
    assert.ok(r.report_markdown.includes('56.7%') && r.report_markdown.includes('3.02배'));
    assert.equal(fig('56.7%'), '56.7%');
    assert.equal(fig('3.02배'), '3.02배');
    assert.equal(fig('A- → A'), 'A- → A', '숫자가 없는 표기는 그대로');
    assert.equal(fig('57%'), '', '반올림한 수');
    assert.equal(fig('3.0배'), '', '소수는 같은 표기가 보고서에 있어야 한다');
    assert.equal(fig('12,345,678,901%'), '', '지어낸 수');
    assert.equal(fig('0~100%'), '0~100%', '정수는 같은 값이면 된다(0 = 0.0)');
    // 보고서가 없으면 확인할 수 없으므로 그대로 둔다
    assert.equal(normalizeDeck({ messages: [{ headline: 'h', points: [{ figure: '57%', text: 't' }] }] }, {}).messages[0].points[0].figure, '57%');
  });

  test('채택하지 않은 문헌의 id는 구성안에 오르지 않는다', () => {
    const cited = new Set(citedIds(r.report_markdown));
    const used = new Set(Object.values(r.syntheses).flatMap((s) => s.sources || []));
    const stray = r.sources.find((s) => !cited.has(s.sid) && !used.has(s.sid));
    assert.ok(stray, '샘플에 인용되지 않은 문헌이 있어야 한다');
    const d = normalizeDeck({ messages: [{ headline: 'h', points: [{ text: `주장 [${stray.sid}]`, sids: [stray.sid, 'S15'] }] }],
      must_read: [{ sid: stray.sid, why: '이유' }, { sid: 'S15', why: '이유' }] }, r);
    assert.deepEqual(d.messages[0].points[0].sids, ['S15']);
    assert.equal(d.messages[0].points[0].text, '주장');
    assert.deepEqual(d.must_read.map((m) => m.sid), ['S15']);
  });

  test('제어 문자는 구성안에 남지 않는다', () => {
    const soh = String.fromCharCode(1), nul = String.fromCharCode(0);
    const d = normalizeDeck({ title: `제목${soh}하나${nul}`, messages: [{ headline: `주장${soh}`, notes: `노트${soh}` }] }, r);
    assert.equal(d.title, '제목하나');
    assert.equal(d.messages[0].headline, '주장');
    assert.equal(d.messages[0].notes, '노트');
  });

  test('isDeck: v1 개요와 이상한 값은 false', () => {
    assert.equal(isDeck({ title: 't', subtitle: '', summary: [], findings: [], agreements: [], conflicts: [], gaps: [],
      future_studies: [], must_read: [], limitations: [] }), false);
    for (const x of [null, undefined, {}, { version: 2 }, { version: '2', messages: [] }, { version: 1, messages: [] }]) assert.equal(isDeck(x), false);
    assert.equal(isDeck({ version: 2, messages: [] }), true);
    assert.equal(isDeck(normalizeDeck(null, null)), true);
  });
});

describe('발표 구성안: makeDeck (가짜 LLM)', () => {
  const r = samples[SAMPLE_IDS[0]];
  test('스키마 · 옵션을 넘기고 결과를 정규화한다', async () => {
    const calls = [];
    const llm = {
      async json(system, prompt, schema, opts) {
        calls.push({ system, prompt, schema, opts });
        return { title: 'T'.repeat(300), messages: [{ headline: 'h', points: [{ figure: '40%', text: 'x [S999]', sids: ['S999', 'S15'] }], strength: 'bogus', subq_ids: ['Q1'] }],
          must_read: [{ sid: 'S99999' }], subq_labels: [{ id: 'Q1', label: '측정' }] };
      },
    };
    const d = await makeDeck(llm, r);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema, DECK_SCHEMA);
    assert.deepEqual(calls[0].opts, { effort: 'medium', maxTokens: 16000 });
    assert.ok(calls[0].system.startsWith('You are a rigorous research assistant agent'));
    assert.ok(calls[0].system.includes('not stated in the abstract'));
    const p = calls[0].prompt;
    assert.ok(p.includes('TALK, not a summary'));
    assert.ok(p.includes('Write all text in language "ko".'));
    assert.ok(p.includes(r.report_markdown), '보고서 전문');
    assert.ok(p.includes(`- Q1: ${r.plan.sub_questions[0].question} (evidence strength: moderate; ${r.syntheses.Q1.sources.length} sources)`));
    assert.ok(p.includes(`${r.meta.counts.collected} records collected`) && p.includes(`${r.meta.counts.included} sources included`));
    assert.ok(p.includes('Search window: 2022 onward.'));
    assert.ok(p.includes('- S15: '), '인용할 수 있는 문헌 목록');
    assert.ok(p.includes(`headline ${Math.floor(DECK_LIMITS.headline * 0.8)},`), '한국어는 제한의 80%를 글자 수 그대로 알려 준다');
    assert.ok(p.includes(`detail ${Math.floor(DECK_LIMITS.detail * 0.8)};`));
    assert.ok(p.includes(`each agree / conflict item ${Math.floor(DECK_LIMITS.agree.len * 0.8)},`));
    assert.ok(p.includes(`design / sample / payoff ${Math.floor(DECK_LIMITS.next_studies.design * 0.8)} each`));
    // 오늘 줄인 제한(detail 56, agree 58, next_studies 58)의 80%
    assert.ok(p.includes('detail 44;') && p.includes('item 46,') && p.includes('payoff 46 each'));
    assert.equal(d.source, 'llm');
    assert.equal(emLen(d.title), DECK_LIMITS.title);
    assert.deepEqual(d.messages[0].points[0], { figure: '40%', text: 'x', detail: '', sids: ['S15'] });
    assert.equal(d.messages[0].strength, 'moderate');
    assert.deepEqual(d.must_read, []);
    assert.equal(d.subq_labels[0].label, '측정');
    assert.equal(d.subq_labels.length, r.plan.sub_questions.length);
    assertDeck(d, r);
  });

  test('영어 결과에는 em ÷ 0.55 글자 수의 80%를 알려 준다', async () => {
    let prompt = '';
    await makeDeck({ json: async (s, p) => { prompt = p; return {}; } }, { ...r, lang: 'en' });
    assert.ok(prompt.includes(`headline ${Math.floor((DECK_LIMITS.headline / 0.55) * 0.8)},`), 'headline 66');
    const en = (em) => Math.floor((em / 0.55) * 0.8);
    assert.ok(prompt.includes(`detail ${en(DECK_LIMITS.detail)};`), 'detail 81');
    assert.ok(prompt.includes(`each agree / conflict item ${en(DECK_LIMITS.agree.len)},`), 'agree 84');
    assert.ok(prompt.includes(`design / sample / payoff ${en(DECK_LIMITS.next_studies.design)} each`), 'next_studies 84');
    assert.ok(prompt.includes('Write all text in language "en".'));
  });

  test('한 글자가 1em인 언어(일본어 · 중국어)에는 한국어처럼 em 기준 글자 수를 알려 준다', async () => {
    for (const lang of ['ja', 'zh', 'zh-TW']) {
      let prompt = '';
      await makeDeck({ json: async (s, p) => { prompt = p; return {}; } }, { ...r, lang });
      assert.ok(prompt.includes(`headline ${Math.floor(DECK_LIMITS.headline * 0.8)},`), lang);
      assert.ok(prompt.includes('a CJK character counts 1'), lang);
    }
  });

  test('보고서 안의 큰따옴표 세 개는 프롬프트의 인용 구역을 닫지 못한다', async () => {
    const q3 = '"'.repeat(3);
    let prompt = '';
    await makeDeck({ json: async (s, p) => { prompt = p; return {}; } }, { ...r, report_markdown: `앞 ${q3} 가운데 ${q3} 뒤` });
    assert.equal(prompt.split(q3).length, 3, '여는 것과 닫는 것 두 개뿐이어야 한다');
    assert.ok(prompt.includes("앞 ''' 가운데 ''' 뒤"));
  });

  test('발표자 노트는 한 번의 응답에 들어가는 길이로 묶는다', () => {
    const L = DECK_LIMITS;
    // 가장 길게 써도(메시지 5개 + 슬라이드 노트 9개) 6천 자를 넘지 않는다
    assert.ok(L.messages.max * L.message_notes + 9 * L.notes <= 6500, `${L.messages.max * L.message_notes + 9 * L.notes}`);
  });

  test('LLM이 null · undefined면 null', async () => {
    assert.equal(await makeDeck({ json: async () => null }, r), null);
    assert.equal(await makeDeck({ json: async () => undefined }, r), null);
  });

  test('FakeLLM도 DECK_SCHEMA에 유효한 구성안으로 답한다', async () => {
    for (const res of [r, samples[SAMPLE_IDS[1]], {}]) {
      const llm = new FakeLLM();
      const d = await makeDeck(llm, res);
      assert.deepEqual(llm.calls, ['deck']);
      assertDeck(d, res);
      assert.equal(d.messages.length, 3);
    }
    // 가짜 구성안의 id는 모두 실제 문헌이라 정규화에서 빠지는 것이 없다
    const llm = new FakeLLM();
    let prompt = '';
    const spy = { json: async (s, p, schema, o) => { prompt = p; return llm.json(s, p, schema, o); } };
    const d = await makeDeck(spy, r);
    const raw = await llm.json('', prompt, DECK_SCHEMA);
    const ids = raw.messages.flatMap((m) => m.points.flatMap((x) => x.sids));
    assert.ok(ids.length > 0);
    for (const sid of ids) assert.ok(r.sources.some((s) => s.sid === sid), sid);
    assert.deepEqual(d.messages.map((m) => m.points.map((x) => x.sids)), raw.messages.map((m) => m.points.map((x) => x.sids)));
  });

  test('스키마는 strict 구조화 출력 규칙을 지키고 모든 키가 필수다', () => {
    const walk = (s) => {
      if (s.type === 'object') {
        assert.equal(s.additionalProperties, false);
        assert.deepEqual(s.required, Object.keys(s.properties));
        Object.values(s.properties).forEach(walk);
      } else if (s.type === 'array') walk(s.items);
    };
    walk(DECK_SCHEMA);
    assert.deepEqual(DECK_SCHEMA.required, DECK_KEYS.filter((k) => k !== 'version' && k !== 'source'));
    const msg = DECK_SCHEMA.properties.messages.items;
    assert.deepEqual(msg.required, ['headline', 'points', 'takeaway', 'strength', 'subq_ids', 'notes']);
    assert.deepEqual(msg.properties.strength.enum, STRENGTHS);
    assert.deepEqual(msg.properties.points.items.required, ['figure', 'text', 'detail', 'sids']);
    assert.deepEqual(DECK_SCHEMA.properties.notes.required, NOTE_KEYS);
    assert.equal(FakeLLM.stageOf(DECK_SCHEMA), 'deck');
  });
});

test('공통 표기 · 테마', () => {
  assert.equal(shortCite({ authors: ['John Smith', 'B'], year: 2024 }), 'Smith et al. (2024)');
  assert.equal(shortCite({ authors: ['Kim J'], year: null }), 'Kim (n.d.)');
  assert.equal(shortCite({ authors: [], venue: 'Nature' }), 'Nature (n.d.)');
  assert.equal(shortCite({}), 'n.a. (n.d.)');
  assert.deepEqual(citedIds('a [S3, S12] b [S3] [S7]'), ['S3', 'S12', 'S7']);
  assert.equal(theme.DIRECTION_COLOR.positive, theme.SERIES[0]);
  assert.equal(theme.STUDY_TYPE_LABEL.other, '기타');
});

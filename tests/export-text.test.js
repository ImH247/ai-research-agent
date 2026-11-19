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
import { OUTLINE_SCHEMA, fallbackOutline, makeOutline, normalizeOutline, LIMITS } from '../assets/js/export/slides.js';
import { FORMATS, exportBundle, exportFile, filenameFor, slugify } from '../assets/js/export/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_IDS = ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication'];
const samples = Object.fromEntries(SAMPLE_IDS.map((id) => [id,
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'result.json'), 'utf8'))]));
const TEXT_FORMATS = ['md', 'html', 'pdf', 'bib', 'ris', 'csv', 'json'];
const OUTLINE_KEYS = ['title', 'subtitle', 'summary', 'findings', 'agreements', 'conflicts', 'gaps', 'future_studies',
  'must_read', 'limitations'];

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

    test('규칙 기반 개요: 모양과 제한', () => {
      const o = fallbackOutline(r);
      assert.deepEqual(Object.keys(o), OUTLINE_KEYS);
      assert.ok(o.findings.length > 0 && o.findings.length <= LIMITS.findings);
      assert.ok(o.summary.length > 0 && o.summary.length <= 5);
      for (const s of o.summary) assert.ok(s.length <= LIMITS.summary[1] + 2, s);
      for (const f of o.findings) {
        assert.ok(['strong', 'moderate', 'weak', 'insufficient'].includes(f.strength));
        assert.ok(f.bullets.length <= 4);
        for (const b of f.bullets) assert.ok(b.length <= LIMITS.bullets[1] + 2, b);
      }
      const sids = new Set(r.sources.map((s) => s.sid));
      for (const m of o.must_read) assert.ok(sids.has(m.sid));
      assert.ok(o.must_read.length > 0 && o.must_read.length <= 5);
      assert.equal(o.title, r.topic);
      assert.deepEqual(normalizeOutline(o, r), o);   // 이미 정규화된 개요는 그대로
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
    test(`${name}: 모든 텍스트 형식과 개요가 죽지 않는다`, async () => {
      for (const fmt of TEXT_FORMATS) {
        const out = await exportFile(r, fmt);
        assert.equal(typeof out.data, 'string', fmt);
        assert.ok(out.filename.length > 0);
      }
      const o = fallbackOutline(r);
      assert.deepEqual(Object.keys(o), OUTLINE_KEYS);
      assert.deepEqual(Object.keys(normalizeOutline(null, r)), OUTLINE_KEYS);
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

describe('LLM 개요 (가짜 LLM)', () => {
  const r = samples[SAMPLE_IDS[0]];
  test('makeOutline은 스키마·옵션을 넘기고 결과를 정규화한다', async () => {
    const calls = [];
    const llm = {
      async json(system, prompt, schema, opts) {
        calls.push({ system, prompt, schema, opts });
        return {
          title: 'T'.repeat(300), subtitle: 'sub', summary: ['a [S1]', 'a [S1]', '', 5, 'b'],
          findings: [{ subq_id: 'Q1', headline: 'h', bullets: ['x'], strength: 'bogus' }, 'bad', { subq_id: 'Q9' }],
          agreements: [], conflicts: [], gaps: ['g'], limitations: ['l'],
          future_studies: [{ title: 'f', question: 1 }, { title: '' }],
          must_read: [{ sid: '[S1]', why: 'w' }, { sid: 'S1', why: 'dup' }, { sid: 'S99999' }, { sid: 'constructor' }, null],
        };
      },
    };
    const o = await makeOutline(llm, r);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema, OUTLINE_SCHEMA);
    assert.deepEqual(calls[0].opts, { effort: 'medium', maxTokens: 16000 });
    assert.ok(calls[0].system.startsWith('You are a rigorous research assistant agent'));
    assert.ok(calls[0].system.includes("not stated in the abstract"));
    assert.ok(calls[0].prompt.includes('Write all text in language "ko".'));
    assert.ok(calls[0].prompt.includes(`- Q1: ${r.plan.sub_questions[0].question}`));
    assert.equal(o.title.length, 120);
    assert.equal(o.title.endsWith('…'), true);
    assert.deepEqual(o.summary, ['a [S1]', 'b']);
    assert.equal(o.findings.length, 1);
    assert.equal(o.findings[0].strength, r.syntheses.Q1.evidence_strength);
    assert.deepEqual(o.must_read, [{ sid: 'S1', why: 'w' }]);
    assert.deepEqual(o.future_studies, [{ title: 'f', question: '', design: '', sample: '', contribution: '' }]);
  });
  test('LLM이 null이면 null', async () => {
    assert.equal(await makeOutline({ json: async () => null }, r), null);
  });
  test('스키마는 strict 구조화 출력 규칙을 지킨다', () => {
    const walk = (s) => {
      if (s.type === 'object') {
        assert.equal(s.additionalProperties, false);
        assert.deepEqual(s.required, Object.keys(s.properties));
        Object.values(s.properties).forEach(walk);
      } else if (s.type === 'array') walk(s.items);
    };
    walk(OUTLINE_SCHEMA);
    assert.deepEqual(OUTLINE_SCHEMA.required, OUTLINE_KEYS.slice(0, 3).concat(['findings', 'agreements', 'conflicts', 'gaps', 'future_studies', 'must_read', 'limitations']));
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

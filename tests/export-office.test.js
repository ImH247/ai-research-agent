// Word · PowerPoint 내보내기 테스트 (네트워크 없이). 두 샘플과 일부러 만든 결과로 zip 구조 · XML을 확인하고,
// python(python-docx · python-pptx)이 있으면 tests/check_office.py로 다시 열어 구조를 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from '../vendor/jszip.js';
import { buildDocx } from '../assets/js/export/docx.js';
import { buildPptx } from '../assets/js/export/pptx.js';
import { fallbackOutline } from '../assets/js/export/slides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication'];
const loadSample = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'result.json'), 'utf8'));
const FONT = '맑은 고딕';

async function unzip(u8) {
  assert.ok(u8 instanceof Uint8Array, 'Uint8Array를 돌려줘야 한다');
  assert.equal(u8[0], 0x50);   // 'PK'
  assert.equal(u8[1], 0x4b);
  return JSZip.loadAsync(u8);
}
const read = (zip, name) => zip.file(name).async('string');

// 표 칸 <br>, 인용문, 구분선, 코드, 중첩 · 번호 목록(3부터), 외부 링크, 목록에 없는 인용, 제어 문자를 담은 결과
function syntheticResult() {
  const md = [
    '## 1. 요약',
    '본문 [S1]과 [S1, S2], 없는 인용 [S99]. **굵게** *기울임* `code` [링크](https://example.org) [나쁜 링크](javascript:alert(1))\u0007',
    '',
    '> 인용문 단락 [S2]',
    '',
    '---',
    '',
    '3. 셋째',
    '4. 넷째',
    '   - 안쪽 글머리',
    '     1. 더 안쪽 번호',
    '',
    '```',
    'const x = 1;',
    '```',
    '',
    '| 항목 | 내용 |',
    '|---|---|',
    '| 첫 줄<br>둘째 줄 | 값 [S1] |',
    '',
    '### 1.1 하위 제목',
    '마지막 단락.',
  ].join('\n');
  const src = (n, extra = {}) => ({
    sid: `S${n}`, title: `Title ${n}`, authors: ['John Smith', 'Kim J'], year: 2024, venue: 'Journal',
    url: `https://doi.org/10.1/${n}`, kind: 'peer-reviewed', included: true, score: 0.9 - n / 10, cited: true,
    direction: 'positive', study_type: 'RCT/experiment', method: 'RCT', sample: 'n=10', key_finding: '효과 있음', citations: 3,
    ...extra,
  });
  return {
    topic: '테스트 주제: 아주 긴 제목이 머리말에서 잘리는지 확인하기 위한 예시 문장입니다',
    prompt: '테스트', lang: 'ko',
    meta: { model_label: 'Fake', created_at: '2026-11-18T10:00:00', elapsed_s: 125, year_from: 2020,
      usage: { calls: 3, input_tokens: 1234, output_tokens: 567, cost_usd: 0.12 }, counts: { collected: 3, included: 2 } },
    plan: { sub_questions: [{ id: 'Q1', question: '질문 하나?', perspective: '관점' }] },
    syntheses: { Q1: { answer: '답 [S1]', sources: ['S1'], evidence_strength: 'moderate', key_findings: [{ finding: '발견 [S1]', sources: ['S1'] }] } },
    reflections: [],
    report_markdown: md,
    verification: { cited_ids: 2, unknown_ids: ['S99'], claims_total: 2,
      checks: [{ claim: '주장 **하나** [S1]', verdict: 'partially supported', note: '메모', revised: '고친 주장 [S1]', verdict_after: 'supported' }] },
    stats: { by_study_type: { 'RCT/experiment': 2, other: 1 }, by_year: { 2024: 2 }, by_direction: { positive: 1, '': 1 } },
    sources: [src(1), src(2, { direction: '', score: null }), src(3, { included: false }), { sid: 'bad' }, null],
    trace: [{ ts: '2026-11-18T10:00:05', stage: 'plan', msg: '계획' }],
  };
}

function pythonOk() {
  const r = spawnSync('python', ['-X', 'utf8', '-c', 'import docx, pptx, lxml'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xo_'));
const written = [];
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

for (const id of SAMPLES) {
  test(`docx: ${id}`, async () => {
    const r = loadSample(id);
    const u8 = await buildDocx(r);
    const zip = await unzip(u8);
    for (const name of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml']) {
      assert.ok(zip.file(name), `${name} 없음`);
    }
    const doc = await read(zip, 'word/document.xml');
    assert.match(doc, /<w:instrText[^>]*>TOC /);
    assert.match(doc, /w:orient="landscape"/);
    assert.ok((doc.match(/<w:bookmarkStart /g) || []).length >= 10);
    assert.ok((doc.match(/<w:hyperlink[^>]*w:anchor="ref_S\d+"/g) || []).length >= 10);
    assert.match(doc, /<w:tblHeader\/>/);
    assert.match(doc, /부록 A\. 근거 비교표/);
    assert.match(doc, /부록 D\. 에이전트 수행 기록/);
    const styles = await read(zip, 'word/styles.xml');
    assert.match(styles, new RegExp(`<w:rFonts[^>]*w:eastAsia="${FONT}"`));
    assert.match(await read(zip, 'word/settings.xml'), /<w:updateFields/);
    const file = path.join(tmp, `${id.slice(7, 11)}.docx`);
    fs.writeFileSync(file, u8);
    written.push(file);
  });

  test(`pptx: ${id}`, async () => {
    const r = loadSample(id);
    const u8 = await buildPptx(r);
    const zip = await unzip(u8);
    assert.ok(zip.file('ppt/presentation.xml'));
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const charts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    assert.ok(slides.length >= 12, `슬라이드 ${slides.length}개`);
    assert.equal(charts.length, 3);
    const pres = await read(zip, 'ppt/presentation.xml');
    assert.match(pres, /<p:sldSz cx="12192000" cy="6858000"/);
    for (const name of [...slides, ...charts]) {
      const xml = await read(zip, name);
      // 글꼴 요소가 겹치면 PowerPoint가 파일을 열지 않는다
      assert.doesNotMatch(xml, /<a:cs\b[^>]*\/>\s*<a:cs\b/, name);
      assert.doesNotMatch(xml, /<a:ea\b[^>]*\/>\s*<a:ea\b/, name);
    }
    for (const name of charts) {
      assert.match(await read(zip, name), new RegExp(`<a:ea typeface="${FONT}"`), name);
    }
    const all = (await Promise.all(slides.map((n) => read(zip, n)))).join('');
    assert.match(all, /<a:buClr><a:srgbClr val="2456C9"\/><\/a:buClr>/);
    const file = path.join(tmp, `${id.slice(7, 11)}.pptx`);
    fs.writeFileSync(file, u8);
    written.push(file);
  });
}

test('docx: 여러 Markdown 요소와 이상한 값', async () => {
  const zip = await unzip(await buildDocx(syntheticResult()));
  const doc = await read(zip, 'word/document.xml');
  assert.match(doc, /<w:br\/>/);                                   // 표 칸 <br>
  assert.match(doc, /<w:left w:val="single"[^>]*w:sz="12"/);       // 인용문 왼쪽 선
  assert.match(doc, /<w:hyperlink[^>]*w:anchor="ref_S2"/);
  assert.doesNotMatch(doc, /ref_S99/);                             // 목록에 없는 인용은 링크가 아니다
  assert.doesNotMatch(doc, /\u0007/);
  assert.match(doc, /const x = 1;/);
  const num = await read(zip, 'word/numbering.xml');
  assert.match(num, /<w:start w:val="3"\/>/);                      // 3부터 시작하는 번호 목록
  const rels = await read(zip, 'word/_rels/document.xml.rels');
  assert.match(rels, /https:\/\/example\.org/);
  assert.doesNotMatch(rels, /javascript:/);                        // http(s) 외 주소는 링크가 되지 않는다
});

test('빈 결과도 죽지 않는다', async () => {
  const d = await unzip(await buildDocx({}));
  assert.match(await read(d, 'word/document.xml'), /The report body is empty\./);
  const p = await unzip(await buildPptx({}));
  assert.ok(p.file('ppt/presentation.xml'));
  await unzip(await buildDocx(null));
  await unzip(await buildPptx(null, null));
});

test('pptx: 개요를 넘기면 그 내용을 쓴다', async () => {
  const r = syntheticResult();
  const outline = { ...fallbackOutline(r), title: '개요 제목 테스트', summary: ['요약 하나 [S1]', '요약 둘'],
    must_read: [{ sid: 'S1', why: '이유' }], future_studies: [{ title: '후속 연구', question: '질문', design: '설계' }] };
  const zip = await unzip(await buildPptx(r, outline));
  const all = (await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map((n) => read(zip, n)))).join('');
  assert.match(all, /개요 제목 테스트/);
  assert.match(all, /요약 하나/);
  assert.match(all, /후속 연구/);
});

test('python-docx · python-pptx로 다시 열어 구조 검사', async (t) => {
  if (!pythonOk()) {
    t.skip('python 또는 python-docx/python-pptx가 없어 건너뜀');
    return;
  }
  assert.equal(written.length, 4, '샘플 파일이 먼저 만들어져야 한다');
  const r = spawnSync('python', ['-X', 'utf8', path.join(ROOT, 'tests', 'check_office.py'), ...written], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal((r.stdout.match(/^OK /gm) || []).length, 4, r.stdout);
});

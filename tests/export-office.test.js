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
import { fallbackDeck, normalizeDeck } from '../assets/js/export/slides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication'];
const loadSample = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'result.json'), 'utf8'));
// 샘플마다 미리 만들어 둔 발표 구성안(SLIDES_V2 5절)
const loadPlan = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'slides.json'), 'utf8'));
const FONT = '맑은 고딕';

async function unzip(u8) {
  assert.ok(u8 instanceof Uint8Array, 'Uint8Array를 돌려줘야 한다');
  assert.equal(u8[0], 0x50);   // 'PK'
  assert.equal(u8[1], 0x4b);
  return JSZip.loadAsync(u8);
}
const read = (zip, name) => zip.file(name).async('string');
const slideNo = (n) => parseInt(/(\d+)\.xml$/.exec(n)[1], 10);
const slideNames = (zip) => Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => slideNo(a) - slideNo(b));
const chartNames = (zip) => Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
// <a:t> 글을 XML 문자 참조를 풀어 이어 붙인다
const texts = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&'));
const allSlideText = async (zip) => (await Promise.all(slideNames(zip).map((n) => read(zip, n)))).map((x) => texts(x).join('')).join('\n');

/** 발표 슬라이드 zip 검사: 16:9, XML 안전성(엔터티 · 제어 문자 · 글꼴 요소 중복), 차트 한글 글꼴, 모든 슬라이드의 발표자 노트 */
async function checkPptx(u8, { charts = 3 } = {}) {
  const zip = await unzip(u8);
  assert.ok(zip.file('ppt/presentation.xml'));
  const pres = await read(zip, 'ppt/presentation.xml');
  assert.match(pres, /<p:sldSz cx="12192000" cy="6858000"/);
  const slides = slideNames(zip), chartList = chartNames(zip);
  assert.equal(chartList.length, charts, `차트 ${chartList.length}개`);
  for (const name of [...slides, ...chartList]) {
    const xml = await read(zip, name);
    // 글꼴 요소가 겹치면 PowerPoint가 파일을 열지 않는다
    assert.doesNotMatch(xml, /<a:cs\b[^>]*\/>\s*<a:cs\b/, name);
    assert.doesNotMatch(xml, /<a:ea\b[^>]*\/>\s*<a:ea\b/, name);
    assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/, `${name}: 이스케이프되지 않은 &`);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, `${name}: 제어 문자`);
  }
  for (const name of chartList) {
    assert.match(await read(zip, name), new RegExp(`<a:ea typeface="${FONT}"`), name);
  }
  // 발표자 노트: 모든 슬라이드에 쪽 번호 말고 글이 있다
  for (const name of slides) {
    const n = slideNo(name);
    const file = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    assert.ok(file, `슬라이드 ${n}: 노트 없음`);
    const words = texts(await file.async('string')).filter((t) => t.trim() && t.trim() !== String(n));
    assert.ok(words.length, `슬라이드 ${n}: 노트가 비었다`);
  }
  return { zip, slides };
}

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

  test(`pptx: ${id} (샘플 구성안)`, async () => {
    const r = loadSample(id);
    const plan = loadPlan(id);
    const u8 = await buildPptx(r, plan);
    const { zip, slides } = await checkPptx(u8);
    // 표지 · 질문 · 결론 · 방법 · 근거 지형 + 메시지마다 한 장 + 마무리 · 부록
    assert.ok(slides.length >= 5 + plan.messages.length + 6 && slides.length <= 40, `슬라이드 ${slides.length}개`);
    const all = await allSlideText(zip);
    const d = normalizeDeck(plan, r);
    for (const t of [d.title, d.question, d.answer, ...d.messages.map((m) => m.headline), d.messages[0].points[0].figure,
      d.messages[0].takeaway, d.takeaways[0], d.gaps[0].gap, d.next_studies[0].title]) {
      assert.ok(all.includes(t), `슬라이드에 없음: ${t}`);
    }
    // 메시지 슬라이드의 노트는 구성안의 message.notes
    const notes = texts(await read(zip, 'ppt/notesSlides/notesSlide6.xml')).join('');
    assert.ok(notes.includes(d.messages[0].notes.slice(0, 30)), '첫 메시지 노트');
    assert.ok(!all.includes('(계속)'), "'(계속)' 슬라이드는 만들지 않는다");
    const file = path.join(tmp, `${id.slice(7, 11)}.pptx`);
    fs.writeFileSync(file, u8);
    written.push(file);
  });

  test(`pptx: ${id} (규칙 구성안)`, async () => {
    const r = loadSample(id);
    const u8 = await buildPptx(r);
    const { zip, slides } = await checkPptx(u8);
    assert.ok(slides.length >= 12 && slides.length <= 40, `슬라이드 ${slides.length}개`);
    const d = normalizeDeck(fallbackDeck(r), r);
    const all = await allSlideText(zip);
    for (const m of d.messages) assert.ok(all.includes(m.headline), `메시지 제목 없음: ${m.headline}`);
    assert.ok(all.includes('보고서의 문장을 규칙에 따라 고른 구성안'), '구성안 출처 안내');
    const file = path.join(tmp, `${id.slice(7, 11)}_rules.pptx`);
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
  // 통계 · 검증 · 문헌이 없는 결과에 최소 구성안(메시지 하나, 카드 둘, 선택 목록은 모두 빈 값)
  const plan = { version: 2, title: '최소', messages: [{ headline: '하나', points: [{ figure: '', text: '숫자 없음' },
    { figure: '12%', text: '숫자 있음', sids: ['S1'] }] }] };
  const { zip } = await checkPptx(await buildPptx({ lang: 'ko', stats: {}, verification: {} }, plan), { charts: 0 });
  const all = await allSlideText(zip);
  assert.match(all, /자료 없음/);
  assert.match(all, /숫자 있음/);
});

test('pptx: 구성안의 글과 이상한 값', async () => {
  const r = syntheticResult();
  const plan = {
    version: 2, title: '구성안 제목 테스트', question: '질문 & <테스트>?', context: ['맥락 하나'], answer: '한 문장 결론 [S1]',
    messages: [{ headline: '메시지 제목 테스트', strength: 'strong', subq_ids: ['Q1'], notes: '노트 문장 [S1, S99]',
      // 큰 숫자는 보고서에 있는 수만 남는다: '4배'의 4는 보고서에 있고('4. 넷째'), 77.7은 없다
      points: [{ figure: '4배', text: '카드 글', detail: '보충', sids: ['S1', 'S99'] }, { figure: '77.7%', text: '두 번째 카드', sids: [] }],
      takeaway: '요지 한 줄' }],
    agree: ['일치 [S1]'], conflict: [], gaps: [{ gap: '공백 하나', why: '' }],
    next_studies: [{ title: '후속 연구', design: '설계', sample: '', payoff: '' }], must_read: [{ sid: 'S1', why: '이유' }],
  };
  const { zip } = await checkPptx(await buildPptx(r, plan));
  const all = await allSlideText(zip);
  for (const t of ['구성안 제목 테스트', '질문 & <테스트>?', '메시지 제목 테스트', '4배', '두 번째 카드', '요지 한 줄', '일치', '공백 하나', '후속 연구']) {
    assert.ok(all.includes(t), `슬라이드에 없음: ${t}`);
  }
  assert.ok(!all.includes('77.7'), '보고서에 없는 수는 큰 숫자로 쓰지 않는다');
  assert.ok(!all.includes('S99'), '없는 문헌 id는 지운다');
  assert.ok(all.includes('Smith et al. (2024) · S1'), '출처 줄');
});

test('pptx: v2 구성안이 아니면(v1 개요 · 엉뚱한 값) 규칙 구성안을 쓴다', async () => {
  const r = loadSample(SAMPLES[0]);
  const rules = await allSlideText(await unzip(await buildPptx(r)));
  const v1 = { title: 'v1 개요 제목', summary: ['요약 하나'], findings: [{ subq_id: 'Q1', headline: 'v1 제목', bullets: ['글머리'] }] };
  for (const junk of [v1, { version: 2 }, { version: 1, messages: [] }, 'deck', 42, []]) {
    const all = await allSlideText(await unzip(await buildPptx(r, junk)));
    assert.equal(all, rules, JSON.stringify(junk).slice(0, 40));
  }
});

test('python-docx · python-pptx로 다시 열어 구조 검사', async (t) => {
  if (!pythonOk()) {
    t.skip('python 또는 python-docx/python-pptx가 없어 건너뜀');
    return;
  }
  assert.equal(written.length, 6, '샘플 파일이 먼저 만들어져야 한다');
  const r = spawnSync('python', ['-X', 'utf8', path.join(ROOT, 'tests', 'check_office.py'), ...written], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal((r.stdout.match(/^OK /gm) || []).length, 6, r.stdout);
});

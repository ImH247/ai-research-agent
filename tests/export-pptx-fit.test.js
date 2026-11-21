// PowerPoint 글 맞추기 테스트 (네트워크 · PowerPoint 없이).
// pptx.js의 줄 수 셈(textLines) · 높이(textHeight) · 글자 크기 고르기(fitText) · 줄 길이 고르기(balancedWidth)와,
// 두 샘플을 손으로 쓴 구성안으로 만든 슬라이드의 XML(카드 글상자 · 부록 A · 잘린 글 '…')을 확인한다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from '../vendor/jszip.js';
import { balancedWidth, buildPptx, fitText, textHeight, textLines } from '../assets/js/export/pptx.js';
import { normalizeDeck } from '../assets/js/export/slides.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication'];
const loadSample = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'result.json'), 'utf8'));
const loadPlan = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'samples', id, 'slides.json'), 'utf8'));
const MX = 0.05;          // pptx.js의 글상자 안쪽 좌우 여백(인치)

// XML 문자 참조를 푼다
const unescape = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const runs = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescape(m[1]));
// 글상자(<p:sp>)마다 문단(<a:p>)의 글 목록
const shapes = (xml) => xml.split('<p:sp>').slice(1).map((sp) => [...sp.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
  .map((m) => runs(m[1]).join('')));

// 샘플 하나를 손으로 쓴 구성안으로 만들어 슬라이드 XML을 차례대로 돌려준다
async function slidesOf(id) {
  const r = loadSample(id), plan = loadPlan(id);
  const zip = await JSZip.loadAsync(await buildPptx(r, plan));
  const no = (n) => parseInt(/(\d+)\.xml$/.exec(n)[1], 10);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => no(a) - no(b));
  const xmls = await Promise.all(names.map((n) => zip.file(n).async('string')));
  return { r, plan, xmls };
}
// 샘플마다 한 번만 만든다(처음 부를 때)
const cache = {};
const built = (id) => (cache[id] ??= slidesOf(id));

describe('pptx 글 맞추기: textLines', () => {
  test('PowerPoint처럼 낱말 단위로 넘긴다(겹침 회귀): 3줄', () => {
    // 전체 폭 ÷ 줄 폭으로 세면 2줄이지만, 통째로 다음 줄로 넘어간 낱말이 남긴 빈자리 때문에 PowerPoint는 3줄로 쓴다
    assert.equal(textLines('2026년 미국 STEM 박사논문 중 AI 텍스트 비율', 18, 3.084, true), 3);
  });

  test('한 줄 · 빈 글 · 줄바꿈', () => {
    assert.equal(textLines('짧은 글', 18, 5), 1);
    assert.equal(textLines('', 18, 3), 1);
    assert.equal(textLines(null, 18, 3), 1);
    assert.equal(textLines('가\n나', 18, 3), 2);
    assert.equal(textLines('가\n\n나', 18, 3), 3, '빈 줄도 한 줄');
  });

  test('한 줄보다 긴 낱말은 글자 단위로 끊는다(멈추지 않는다)', () => {
    const n = textLines('a'.repeat(500), 18, 1);
    assert.ok(n > 1 && n < 500, `${n}줄`);
    const url = textLines('보기: https://example.org/' + 'x'.repeat(200), 12, 1.5);
    assert.ok(Number.isInteger(url) && url > 2, `${url}줄`);
    assert.ok(textLines('가'.repeat(30), 18, 0.01) >= 30, '아주 좁아도 끝난다');
  });

  test('라틴 글자는 굵게 쓰면 줄이 줄지 않는다', () => {
    for (const t of ['Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', 'The quick brown fox jumps over the lazy dog again and again',
      'AI-assisted writing improved fluency scores in 12 of 14 studies']) {
      for (const w of [1, 1.5, 2, 3]) assert.ok(textLines(t, 18, w, true) >= textLines(t, 18, w, false), `${t} @${w}`);
    }
    assert.ok(textLines('Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', 18, 2, true) > textLines('Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww', 18, 2, false));
  });

  test('폭이 좁아지면 줄 수는 줄지 않는다', () => {
    const widths = [8, 6, 5, 4, 3.5, 3.084, 3, 2.5, 2, 1.5, 1, 0.5];
    for (const t of ['2026년 미국 STEM 박사논문 중 AI 텍스트 비율', 'The quick brown fox jumps over the lazy dog again and again',
      '가나다라 마바사아 자차카타 파하가나 다라마바', 'R2R 스크린 인쇄로 동시에 만든 가스 센서 7.0→3.5 Ω/sq']) {
      for (const bold of [false, true]) {
        const lines = widths.map((w) => textLines(t, 18, w, bold));
        for (let i = 1; i < lines.length; i += 1) assert.ok(lines[i] >= lines[i - 1], `${t}: ${lines.join(',')}`);
      }
    }
  });

  test('textHeight: 줄 수 × 크기 × 1.2 + 문단 간격 + 위아래 여백', () => {
    const one = textHeight([['짧은 글', 18]], 5);
    assert.ok(Math.abs(one - ((18 * 1.2) / 72 + 2 * 0.03)) < 1e-9, String(one));
    const two = textHeight([['짧은 글', 18], ['둘째', 12]], 5, 6);
    assert.ok(Math.abs(two - ((18 * 1.2 + 12 * 1.2 + 6) / 72 + 2 * 0.03)) < 1e-9, String(two));
  });
});

describe('pptx 글 맞추기: balancedWidth', () => {
  const t = '2026년 미국 STEM 박사논문 중 AI 텍스트 비율';

  test('한 줄짜리 글은 너비 그대로', () => {
    assert.equal(balancedWidth('짧은 글', 18, 5, true), 5);
    assert.equal(balancedWidth('', 18, 5), 5);
  });

  test('여러 줄 글: 줄 수가 그대로인 가장 좁은 너비(+ 여유 2%)', () => {
    for (const [text, size, width, bold] of [[t, 18, 5, true], [t, 18, 3.084, true],
      ['생성형 AI는 대학원생의 연구를 더 낫게 만드는가: 문헌 86건이 말하는 것', 28, 11.8, true],
      ['The quick brown fox jumps over the lazy dog again and again', 16, 4, false]]) {
      const bw = balancedWidth(text, size, width, bold);
      const lines = textLines(text, size, width - 2 * MX, bold);
      assert.ok(lines >= 2, text);
      assert.ok(bw < width && bw > 0, `${text}: ${bw} < ${width}`);
      // 돌려준 너비에서 안쪽 여백을 빼고 세어도(2% 여유 포함) 줄 수가 늘지 않는다
      assert.ok(textLines(text, size, bw - 2 * MX, bold) <= lines, `${text}: 줄 수가 늘었다`);
      // 그보다 조금만 좁아도 줄이 는다(가장 좁은 너비)
      assert.ok(textLines(text, size, bw - 2 * MX - 0.02, bold) > textLines(text, size, bw - 2 * MX, bold), `${text}: 더 좁힐 수 있다`);
    }
  });

  test('주어진 너비보다 넓어지지 않는다', () => {
    for (const w of [0.5, 1, 2, 3, 3.084, 4, 6, 12]) {
      for (const text of [t, '가'.repeat(60), 'a'.repeat(80)]) assert.ok(balancedWidth(text, 18, w, true) <= w, `${text} @${w}`);
    }
  });
});

describe('pptx 글 맞추기: fitText', () => {
  test('들어가는 가장 큰 크기를 고른다', () => {
    assert.deepEqual(fitText('짧은 글', 3, 1, [24, 20, 16]), ['짧은 글', 24]);
    const t = '가나다라 마바사아 자차카타 파하가나 다라마바';
    const [text, size] = fitText(t, 3, 0.5, [24, 20, 16, 12]);
    assert.equal(text, t);
    assert.ok(textHeight([[t, size]], 3) <= 0.5);
    const bigger = [24, 20, 16, 12].filter((s) => s > size);
    for (const s of bigger) assert.ok(textHeight([[t, s]], 3) > 0.5, `${s}pt도 들어간다`);
  });

  test('가장 작은 크기로도 넘치면 글을 줄인다(들어가거나 4글자까지)', () => {
    for (const [t, w, h, tiers] of [['가'.repeat(400), 2, 0.4, [14, 12]], ['가나다라마바사아자차'.repeat(5), 1, 0.3, [24, 20, 16]],
      ['word '.repeat(300), 3, 0.6, [14, 12]]]) {
      const [text, size] = fitText(t, w, h, tiers);
      assert.equal(size, tiers[tiers.length - 1]);
      assert.ok(text.length < t.length);
      assert.ok(text.length <= 4 || textHeight([[text, size]], w) <= h, `${text.length}글자가 넘친다`);
    }
  });
});

describe('pptx: 손으로 쓴 구성안의 슬라이드', () => {
  test('핵심 메시지 카드: 주장과 보충은 한 글상자의 두 문단', async () => {
    const { r, plan, xmls } = await built(SAMPLES[0]);
    const d = normalizeDeck(plan, r);
    const msgSlides = xmls.filter((x) => runs(x).some((t) => t.startsWith('핵심 메시지 ')));
    assert.equal(msgSlides.length, d.messages.length);
    msgSlides.forEach((x, i) => {
      const boxes = shapes(x);
      for (const p of d.messages[i].points) {
        assert.ok(p.text && p.detail, '샘플 구성안의 카드에는 보충이 있다');
        assert.ok(boxes.some((ps) => ps.length === 2 && ps[0] === p.text && ps[1] === p.detail), `한 상자에 없음: ${p.text}`);
        // 주장만 따로 든 글상자는 없다
        assert.ok(!boxes.some((ps) => ps.length === 1 && ps[0] === p.text), `주장이 따로 있다: ${p.text}`);
      }
    });
  });

  for (const id of SAMPLES) {
    test(`부록 A는 원래 질문을 줄이지 않고 보여 준다: ${id}`, async () => {
      const { r, xmls } = await built(id);
      const appA = xmls.filter((x) => runs(x).some((t) => t.startsWith('A · 하위 질문과 근거 강도')));
      assert.ok(appA.length >= 1);
      const all = appA.map((x) => runs(x).join('\n')).join('\n');
      const q0 = r.plan.sub_questions[0].question;
      assert.ok(all.includes(q0.split(' ').slice(-3).join(' ')), `질문의 끝이 없음: ${q0}`);
      for (const q of r.plan.sub_questions) assert.ok(all.includes(q.question.replace(/\s+/g, ' ').trim()), `질문 전문이 없음: ${q.id}`);
      for (const x of appA) for (const t of runs(x)) assert.ok(!t.endsWith('…'), `잘린 글: ${t}`);
    });

    test(`손으로 쓴 구성안은 줄이지 않고 들어간다(… 없음): ${id}`, async () => {
      const { xmls } = await built(id);
      xmls.forEach((x, i) => {
        for (const t of runs(x)) assert.ok(!t.endsWith('…'), `슬라이드 ${i + 1}: ${t}`);
      });
    });
  }
});

// 결과와 구성안을 바꿔 가며 만든 슬라이드 XML(차례대로)
async function xmlsOf(r, plan) {
  const zip = await JSZip.loadAsync(await buildPptx(r, plan));
  const no = (n) => parseInt(/(\d+)\.xml$/.exec(n)[1], 10);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => no(a) - no(b));
  return Promise.all(names.map((n) => zip.file(n).async('string')));
}
// 글 t가 든 글상자의 너비(인치). 도형 크기는 EMU(1인치 = 914400)로 적힌다
function boxWidthOf(xml, t) {
  for (const sp of xml.split('<p:sp>').slice(1)) {
    if (!runs(sp).includes(t)) continue;
    const m = /<a:ext cx="(\d+)"/.exec(sp);
    if (m) return Number(m[1]) / 914400;
  }
  return null;
}

describe('pptx: 넘치기 쉬운 글(검토에서 찾은 것)', () => {
  test('저자가 없어 표기가 긴 문헌도 카드의 출처 줄은 한 줄이다(연도는 남긴다)', async () => {
    const r = loadSample(SAMPLES[0]), plan = loadPlan(SAMPLES[0]);
    const sid = plan.messages[0].points[0].sids[0];
    const src = r.sources.find((s) => s.sid === sid);
    src.authors = [];
    src.venue = 'Proceedings of the 2024 Conference on Empirical Methods in Natural Language Processing';
    src.year = 2024;
    const xmls = await xmlsOf(r, plan);
    const slide = xmls.find((x) => runs(x).some((t) => t.startsWith('핵심 메시지 1 ')));
    const line = runs(slide).find((t) => t.includes(`· ${sid}`));
    assert.ok(line, '출처 줄이 없다');
    assert.ok(line.includes('…') && line.includes('(2024)'), line);
    assert.equal(textLines(line, 11, boxWidthOf(slide, line) - 2 * MX), 1, line);
    // 부록 B의 문헌 표기도 한 줄
    const must = { ...plan, must_read: [{ sid, why: '먼저 읽을 문헌' }] };
    const app = (await xmlsOf(r, must)).find((x) => runs(x).some((t) => t.startsWith('B · ')));
    const cite = runs(app).find((t) => t.includes('(2024)'));
    assert.ok(cite && cite.includes('…'), String(cite));
    assert.equal(textLines(`${cite}${sid}`, 14, boxWidthOf(app, cite) - 2 * MX, true), 1, cite);
  });

  test("영어 자료: 가장 긴 강도 이름 'Insufficient'도 글자 칸에 한 줄로 들어간다", async () => {
    const r = { ...loadSample(SAMPLES[0]), lang: 'en' };
    r.syntheses = Object.fromEntries(Object.entries(r.syntheses).map(([k, v]) => [k, { ...v, evidence_strength: 'insufficient' }]));
    const plan = loadPlan(SAMPLES[0]);
    plan.messages.forEach((m) => { m.strength = 'insufficient'; });
    const xmls = await xmlsOf(r, plan);
    let seen = 0;
    for (const x of xmls) {
      for (const sp of x.split('<p:sp>').slice(1)) {
        if (!runs(sp).includes('Insufficient')) continue;
        const cx = /<a:ext cx="(\d+)"/.exec(sp), sz = /<a:rPr[^>]*\bsz="(\d+)"/.exec(sp);
        if (!cx || !sz || runs(sp).length !== 1) continue;      // 칩처럼 다른 글과 함께 든 상자는 따로 맞춘다
        seen += 1;
        assert.equal(textLines('Insufficient', Number(sz[1]) / 100, Number(cx[1]) / 914400 - 2 * MX, true), 1);
      }
    }
    assert.ok(seen >= plan.messages.length, `강도 글자 ${seen}곳`);
  });

  test('제어 문자는 슬라이드 XML에 들어가지 않는다(파일이 깨지지 않게)', async () => {
    const bell = String.fromCharCode(7), soh = String.fromCharCode(1);
    const r = loadSample(SAMPLES[0]), plan = loadPlan(SAMPLES[0]);
    plan.title = `제목${soh} 하나`;            // 파일 속성(docProps/core.xml)의 제목으로도 들어간다
    plan.answer = `결론${soh}입니다`;
    plan.messages[0].points[0].text = `주장${bell} 하나`;
    r.meta = { ...r.meta, model_label: `모델${bell}이름` };
    const zip = await JSZip.loadAsync(await buildPptx(r, plan));
    for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml'))) {
      const xml = await zip.file(name).async('string');
      for (const ch of xml) {
        const cp = ch.codePointAt(0);
        assert.ok(cp >= 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D, `${name}: U+${cp.toString(16)}`);
      }
    }
    const all = (await xmlsOf(r, plan)).map((x) => runs(x).join('\n')).join('\n');
    assert.ok(all.includes('결론입니다') && all.includes('주장 하나'));
  });

  test('인용 표기 [S#]는 11pt보다 작게 쓰지 않는다', async () => {
    const { xmls } = await built(SAMPLES[1]);
    let cites = 0;
    for (const x of xmls) {
      for (const m of x.matchAll(/<a:rPr[^>]*\bsz="(\d+)"[^>]*>(?:(?!<\/a:r>)[\s\S])*?<a:t>(\[S\d+(?:, S\d+)*\])<\/a:t>/g)) {
        cites += 1;
        assert.ok(Number(m[1]) >= 1100, `${m[2]} ${m[1]}`);
      }
    }
    assert.ok(cites > 0, '인용 표기가 하나도 없다');
  });

  test('제목이 빈 메시지는 요지나 첫 카드의 글이 제목이 된다(제목 없는 주장 슬라이드를 만들지 않는다)', () => {
    const r = loadSample(SAMPLES[0]);
    const d = normalizeDeck({ messages: [
      { headline: '', takeaway: '요지가 제목이 된다 [S15]', points: [{ text: '카드 하나', sids: ['S15'] }] },
      { headline: '', takeaway: '', points: [{ figure: '40%', text: '카드의 글이 제목이 된다', sids: ['S55'] }] },
      { headline: '', takeaway: '', points: [] },
    ] }, r, 'llm');
    assert.equal(d.messages.length, 2, '아무것도 없는 메시지는 뺀다');
    assert.equal(d.messages[0].headline, '요지가 제목이 된다');
    assert.equal(d.messages[0].takeaway, '', '같은 문장을 두 번 쓰지 않는다');
    assert.equal(d.messages[1].headline, '카드의 글이 제목이 된다');
  });
});

// 화면 연결 점검: 화면 코드(compose·run·result·rewrite·onboarding)가 부르는 순서 그대로 백엔드를 몰아 본다.
// 1) 백엔드 직접(MemoryStorage + FakeLLM + 가짜 검색 도구): 작성 → 폴링(미리보기 포함) → 계획 수정 승인 → 결과 → 내보내기
//    → 조사 파일 저장·열기 → 이름 바꾸기 → 보고서 다시 쓰기 → 주제 다듬기 → 데모(속도 5) → 새로고침 흉내 후 이어서 진행.
// 2) assets/js/api.js(?mock=1 경로)를 최소 DOM 흉내로 불러와 api.* 이름이 백엔드 메서드와 맞는지, 오류가 ApiError로 바뀌는지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createBackend } from '../assets/js/engine/backend.js';
import { MemoryStorage } from '../assets/js/engine/storage.js';
import { FakeLLM, makeFakeTools } from './fakes.js';

const KEY = 'sk-ant-api03-TESTSECRET_uiwiring_key-000111222';
const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향';
const ACTIVE = ['queued', 'running', 'awaiting_plan'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadSample = (p) => readFile(new URL(`../data/samples/${p}`, import.meta.url), 'utf8');
const cpLen = (s) => [...String(s)].length;

function mk({ storage = new MemoryStorage(), llm = () => new FakeLLM({ delay: 2 }), sampleSpeed = 1 } = {}) {
  const b = createBackend({ storage, llmFactory: llm, tools: makeFakeTools({ fail: [] }), loadSample, sampleSpeed });
  return { b, storage };
}

async function waitFor(fn, ms = 20000, step = 5) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await sleep(step);
  }
}

/**
 * run.js의 폴링을 흉내 낸다: next 커서, 코드포인트 미리보기 커서(previewPos), 보고서 재시작 처리.
 * onStatus(status)가 true를 돌려주면 그 자리에서 멈춘다(계획 검토 등).
 */
async function pollLikeRunView(b, id, c, onStatus = null) {
  for (;;) {
    const sentPos = c.previewPos;
    const res = await b.events(id, c.next, sentPos);
    assert.ok(Array.isArray(res.events));
    assert.equal(typeof res.next, 'number');
    for (const ev of res.events) {
      assert.ok(ev.seq > c.lastSeq, `seq가 되돌아감: ${ev.seq} <= ${c.lastSeq}`);
      c.lastSeq = ev.seq;
      c.events.push(ev);
    }
    c.next = Math.max(c.next, res.next, c.lastSeq);
    const restart = sentPos > 0 && res.events.some((ev) => ev.kind === 'stage' && ev.stage === 'report' && ev.data?.status === 'start');
    const pv = res.preview;
    if (pv) {
      assert.equal(typeof pv.text, 'string');
      assert.ok(pv.from <= pv.total);
      if (pv.from < sentPos || restart) {
        c.preview = pv.from === 0 ? pv.text : '';
        c.previewPos = pv.from === 0 ? cpLen(pv.text) : 0;
      } else if (pv.from === sentPos) {
        c.preview += pv.text;
        c.previewPos = pv.from + cpLen(pv.text);
      }
      assert.ok(c.previewPos <= pv.total);
      c.sawPreview = c.sawPreview || pv.text.length > 0;
    }
    const st = res.status;
    if (onStatus && onStatus(st)) return st;
    if (!ACTIVE.includes(st.status) && !res.events.length) return st;
    await sleep(3);
  }
}

const cursor = () => ({ next: 0, lastSeq: 0, events: [], preview: '', previewPos: 0, sawPreview: false });

test('화면 흐름 그대로: 작성 → 계획 수정 → 결과 → 내보내기 → 조사 파일 → 이름 → 다시 쓰기 → 다듬기', async () => {
  const { b } = mk();
  await b.ready;

  // 작성 화면이 읽는 설정
  const cfg = await b.config();
  for (const k of ['models', 'depths', 'formats', 'stages', 'limits', 'storage', 'demo_sample', 'max_prompt', 'refine_model', 'report_lengths']) {
    assert.ok(k in cfg, `config.${k} 없음`);
  }
  assert.deepEqual(cfg.limits.max_cost_usd, [0, 100]);
  assert.equal(cfg.demo, false);
  assert.equal(cfg.server_key, false);

  // compose.js start()와 같은 본문
  const created = await b.createRun({
    prompt: PROMPT, model: cfg.models[0].id, depth: 'quick', options: {}, language: 'ko', year_from: null,
    human_in_the_loop: true, formats: ['md', 'pptx'], max_cost_usd: 6.5, api_key: KEY,
  });
  assert.match(created.id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(created.status.config.max_cost_usd, 6.5);
  assert.equal(b.hasActiveRuns(), true);
  const id = created.id;

  // 계획 검토가 올 때까지 폴링
  const c = cursor();
  const waiting = await pollLikeRunView(b, id, c, (st) => st.status === 'awaiting_plan');
  assert.equal(waiting.status, 'awaiting_plan');
  const subqs = waiting.plan?.sub_questions || [];
  assert.ok(subqs.length >= 2, '계획에 하위 질문이 없다');
  // run.js 편집기처럼: 원래 항목을 펼치고 id·question만 바꿔 보낸다(하나 지움, 첫 질문 수정)
  const edited = subqs.slice(0, -1).map((sq, i) => ({ ...sq, id: sq.id ?? `q${i}`, question: i === 0 ? `${sq.question} (수정함)` : sq.question }));
  assert.deepEqual(await b.submitPlan(id, { action: 'approve', sub_questions: edited }), { ok: true });
  await assert.rejects(b.submitPlan(id, { action: 'approve' }), (e) => e.code === 'not_awaiting' && e.status === 409);

  const fin = await pollLikeRunView(b, id, c);
  assert.equal(fin.status, 'done', JSON.stringify(fin.error));
  assert.equal(b.hasActiveRuns(), false);
  assert.ok(c.events.length > 10);
  if (c.sawPreview) assert.ok(c.preview.length > 0);

  // 결과 화면
  const res = await b.result(id);
  assert.equal(typeof res.report_html, 'string');
  assert.ok(res.report_html.length > 100);
  assert.ok(Array.isArray(res.toc));
  assert.ok(Array.isArray(res.qa));
  assert.ok(res.exports && 'md' in res.exports && 'pptx' in res.exports);
  assert.ok(res.plan.sub_questions.some((q) => q.question.endsWith('(수정함)')), '수정한 계획이 반영되지 않음');
  assert.equal(res.plan.sub_questions.length, edited.length);

  // 내보내기: pdf는 인쇄용 HTML(print: true), md는 글, pptx는 zip 바이트
  const pdf = await b.exportFile(id, 'pdf');
  assert.equal(pdf.print, true);
  assert.match(pdf.mime, /^text\/html/);
  assert.match(pdf.data, /^<!doctype html>/i);
  assert.doesNotMatch(pdf.data, /<script/i);
  const md = await b.exportFile(id, 'md');
  assert.equal(typeof md.data, 'string');
  assert.match(md.filename, /\.md$/);
  const pptx = await b.exportFile(id, 'pptx');
  assert.ok(pptx.data instanceof Uint8Array);
  assert.equal(String.fromCharCode(pptx.data[0], pptx.data[1]), 'PK');
  assert.match(pptx.filename, /\.pptx$/);
  const html = await b.exportFile(id, 'html');
  assert.match(html.data, /^<!doctype html>/i);

  // 발표 자료 다시 구성(result.js 대화상자): 지금 출처를 보여 주고, 키로 다시 구성한 뒤 PowerPoint를 내려받는다
  assert.ok(['llm', 'sample', 'rules'].includes(res.slides_source));
  assert.equal(res.slides_source, 'llm');
  await assert.rejects(b.slides(id, {}), (e) => e.code === 'no_api_key' && e.status === 400);
  assert.deepEqual(await b.slides(id, { api_key: KEY, model: cfg.models[0].id }), { ok: true, llm: true, source: 'llm' });
  const pptx2 = await b.exportFile(id, 'pptx');
  assert.equal(String.fromCharCode(pptx2.data[0], pptx2.data[1]), 'PK');
  assert.equal((await b.result(id)).slides_source, 'llm');

  // 조사 파일 저장 → 열기
  const rf = await b.exportRunFile(id);
  assert.equal(rf.mime, 'application/json');
  assert.equal(typeof rf.data, 'string');
  assert.match(rf.filename, /\.json$/);
  assert.ok(!rf.data.includes(KEY), '조사 파일에 API 키가 들어감');
  const imp = await b.importRunFile(rf.data);
  const runs1 = (await b.listRuns()).runs;
  const impSum = runs1.find((r) => r.id === imp.id);
  assert.equal(impSum.imported, true);
  assert.equal(impSum.has_result, true);
  assert.equal(impSum.resumable, false);
  assert.equal((await b.result(imp.id)).imported, true);
  await assert.rejects(b.importRunFile('{"nope": 1}'), (e) => e.code === 'invalid_file');

  // 이름 바꾸기(기록 메뉴)
  const rn = await b.rename(id, '  내   조사 제목  ');
  assert.deepEqual(rn, { ok: true, custom_title: '내 조사 제목' });
  assert.equal((await b.listRuns()).runs.find((r) => r.id === id).custom_title, '내 조사 제목');
  await b.rename(imp.id, '가져온 조사');
  const sampleId = runs1.find((r) => r.sample)?.id;
  assert.ok(sampleId);
  await assert.rejects(b.rename(sampleId, 'x'));

  // 보고서 다시 쓰기(rewrite.js 본문)
  const rw = await b.rewriteReport(id, { api_key: KEY, model: cfg.models[0].id, language: 'en', length: 'short', extra: '정책 시사점을 더 자세히' });
  assert.ok(rw.id && rw.id !== id);
  assert.equal(rw.status.parent_id, id);
  assert.ok(rw.status.rewrite);
  const rwDone = await b.waitForRun(rw.id);
  assert.equal(rwDone.status, 'done', JSON.stringify(rwDone.error));
  const rwRes = await b.result(rw.id);
  assert.equal(rwRes.parent_id, id);
  // 가져온 실행도 다시 쓸 수 있다(md만)
  const rw2 = await b.rewriteReport(imp.id, { api_key: KEY });
  assert.equal((await b.waitForRun(rw2.id)).status, 'done');

  // 주제 다듬기(compose.js)
  const rp = await b.refinePrompt({ api_key: KEY, prompt: PROMPT, language: 'ko' });
  assert.equal(rp.suggestions.length, 3);
  for (const s of rp.suggestions) for (const k of ['prompt', 'focus', 'why']) assert.equal(typeof s[k], 'string');
  assert.ok(Array.isArray(rp.questions));
  await assert.rejects(b.refinePrompt({ prompt: PROMPT }), (e) => e.code === 'no_api_key');

  // 삭제(기록 메뉴): 샘플은 막힘
  assert.deepEqual(await b.remove(imp.id), { ok: true });
  await assert.rejects(b.remove(sampleId));
  await b.dispose();
});

test('데모(속도 5): 키 없이 시작·폴링·결과·질문', async () => {
  const { b } = mk({ sampleSpeed: 10 });
  const cfg = await b.config();
  const runs = (await b.listRuns()).runs;
  const sample = runs.find((r) => r.id === cfg.demo_sample) || runs.find((r) => r.sample);
  // onboarding.js startDemo()와 같은 본문
  const { id, status } = await b.createRun({
    prompt: sample.prompt || sample.topic, model: sample.model || undefined, depth: 'standard', language: 'auto',
    human_in_the_loop: false, formats: ['md'], demo: true, demo_speed: 5,
  });
  assert.equal(status.demo, true);
  assert.equal(status.demo_speed, 5);
  assert.equal(status.config.max_cost_usd, null);
  const c = cursor();
  const fin = await pollLikeRunView(b, id, c);
  assert.equal(fin.status, 'done', JSON.stringify(fin.error));
  assert.ok(c.events.some((e) => e.kind === 'stage'));
  const res = await b.result(id);
  assert.equal(res.meta.demo, true);
  // 데모 결과 화면: PowerPoint는 미리 만든 구성안(키 없이 '다시 구성'은 키 창으로 보낸다 → 백엔드도 거부)
  assert.equal(res.slides_source, 'sample');
  await assert.rejects(b.slides(id, {}), (e) => e.code === 'no_api_key');
  const ans = await b.ask(id, { question: '연구 품질에 미치는 영향은?' });
  assert.equal(typeof ans.answer_html, 'string');
  const summary = (await b.listRuns()).runs.find((r) => r.id === id);
  assert.equal(summary.demo, true);
  await b.dispose();
});

test('result.js: 다른 형식 메뉴 맨 아래 "발표 자료 다시 구성 (AI)…" → 대화상자(출처 · 비용 · 키) → api.slides → PowerPoint', async () => {
  // result.js는 DOM 화면 모듈이라 Node에서 불러오지 않고, 연결 지점을 소스에서 확인한다
  const src = (await readFile(new URL('../assets/js/views/result.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const menuAt = src.indexOf("label: '발표 자료 다시 구성 (AI)…'");
  assert.ok(menuAt > 0, '메뉴 항목이 없음');
  assert.ok(menuAt > src.indexOf("label: '전체 묶음 (ZIP)'"), '메뉴 맨 아래가 아님');
  assert.ok(menuAt < src.indexOf("menu(moreBtn, items"), '메뉴를 연 뒤에 항목을 넣음');
  const dlg = src.slice(src.indexOf('function openSlidesDialog('), src.indexOf('function buildHeader('));
  assert.ok(dlg.length > 500, 'openSlidesDialog가 없음');
  for (const s of ["title: '발표 자료 다시 구성'", "label: '취소'", "label: '구성하고 내려받기'", 'api.slides(runId, { api_key: key',
    "downloadFile(runId, 'pptx')", 'openKeyDialog()', 'estimateDeckCost(', 'SLIDES_SOURCE_LABEL[source]', "role: 'alert'",
    'htmlFor: modelId', "setBusy(btn, true"]) {
    assert.ok(dlg.includes(s), `대화상자에 ${s} 없음`);
  }
  // 키가 없으면 대화상자 대신 키 창을 연다(맨 앞에서 확인)
  assert.ok(dlg.indexOf('if (!getApiKey())') < dlg.indexOf('modal('));
  // 출처 이름 세 가지와 규칙 구성안 안내 문장
  for (const s of ["llm: 'AI가 구성'", "sample: '샘플에 들어 있는 구성'", "rules: '규칙으로 구성'",
    "\"규칙으로 구성한 발표 자료입니다. API 키가 있으면 '다른 형식 → 발표 자료 다시 구성'으로 다듬을 수 있습니다.\""]) {
    assert.ok(src.includes(s), `${s} 없음`);
  }
  assert.match(src, /fmt === 'pptx' && slidesSource\(\) === 'rules'/);
  assert.match(src, /str\(st\.raw\?\.slides_source\)/);
  // 요청이 끝나기 전에 창을 닫으면(취소 · Esc · 바깥 누르기) 결과를 알림으로 알리고, 파일을 불쑥 내려받지 않는다
  assert.ok(dlg.includes('onClose: () => { dismissed = true; unsub(); }'), '창을 닫은 것을 기억하지 않음');
  const afterCall = dlg.slice(dlg.indexOf('api.slides(runId'));
  assert.ok(afterCall.indexOf('if (dismissed)') < afterCall.indexOf("downloadFile(runId, 'pptx')"), '닫은 뒤에도 내려받음');
  const inCatch = dlg.slice(dlg.lastIndexOf('} catch (err) {'));
  assert.ok(/if \(dismissed\) \{[\s\S]*?toast\(message, 'error'/.test(inCatch), '닫힌 창의 실패를 알리지 않음');
});

test('새로고침 흉내 → 중단·이어서 가능 → 같은 화면에서 이어서 진행(seq 이어짐)', async () => {
  const storage = new MemoryStorage();
  const { b: first } = mk({ storage, llm: () => new FakeLLM({ delay: 10 }) });
  const { id } = await first.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', formats: ['md'], max_cost_usd: 20 });
  await waitFor(async () => (await storage.get('checkpoints', id))?.state?.done === 'act');
  await first.dispose();

  const { b } = mk({ storage });
  // 기록 목록과 진행 화면이 보는 상태
  const listed = (await b.listRuns()).runs.find((r) => r.id === id);
  assert.equal(listed.status, 'interrupted');
  assert.equal(listed.resumable, true);
  const snap = await b.run(id);
  assert.equal(snap.status, 'interrupted');
  assert.equal(snap.resumable, true);
  assert.equal(b.hasActiveRuns(), false);

  // 진행 화면은 이미 받은 이벤트를 가진 채로 이어서 폴링한다
  const c = cursor();
  await pollLikeRunView(b, id, c);
  const before = c.lastSeq;
  assert.ok(before > 0);
  await assert.rejects(b.resume(id, {}), (e) => e.code === 'no_api_key');
  const r = await b.resume(id, { api_key: KEY });
  assert.equal(r.ok, true);
  assert.equal(r.status.status, 'running');
  const fin = await pollLikeRunView(b, id, c);
  assert.equal(fin.status, 'done', JSON.stringify(fin.error));
  const after = c.events.filter((e) => e.seq > before);
  assert.ok(after.some((e) => e.kind === 'log' && e.data?.resume_from), '이어하기 로그 줄 없음');
  assert.equal(new Set(c.events.map((e) => e.seq)).size, c.events.length, 'seq 중복');
  assert.equal(fin.resumable, false);
  await b.dispose();
});

test('api.js(?mock=1): api.* 이름이 백엔드 메서드와 맞고 오류가 ApiError로 바뀐다', async () => {
  const saved = {};
  const shim = {
    Element: class {}, DocumentFragment: class {},
    location: { search: '?mock=1', hash: '', href: 'http://127.0.0.1/ai-research-agent/?mock=1' },
  };
  for (const k of Object.keys(shim)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = shim[k]; }
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return origFetch(url, opts);
    try {
      const text = await readFile(fileURLToPath(u), 'utf8');
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404, text: async () => '', json: async () => null };
    }
  };
  try {
    const mod = await import('../assets/js/api.js');
    assert.equal(mod.MOCK, true);
    const src = await readFile(new URL('../assets/js/api.js', import.meta.url), 'utf8');
    const names = [...new Set([...src.matchAll(/call\('([A-Za-z]+)'/g)].map((m) => m[1]))];
    assert.ok(names.length >= 18);
    const ref = createBackend({ storage: new MemoryStorage(), llmFactory: () => new FakeLLM(), tools: makeFakeTools({ fail: [] }), loadSample });
    for (const n of names) assert.equal(typeof ref[n], 'function', `백엔드에 ${n} 메서드가 없음`);
    await ref.dispose();
    // 화면 코드가 쓰는 api.* 이름
    for (const n of ['config', 'checkKey', 'listRuns', 'createRun', 'run', 'events', 'submitPlan', 'cancel', 'remove', 'result', 'qa', 'ask',
      'slides', 'exportFile', 'resume', 'rename', 'exportRunFile', 'importRunFile', 'rewriteReport', 'refinePrompt', 'hasActiveRuns',
      'download', 'save', 'saveFile', 'saveRunFile', 'openHtml', 'openExport']) {
      assert.equal(typeof mod.api[n], 'function', `api.${n} 없음`);
    }

    assert.deepEqual(await mod.startBackend(), { ok: true });
    const cfg = await mod.api.config();
    assert.equal(cfg.storage.persistent, false);
    const ck = await mod.api.checkKey('sk-ant-api03-anything-goes-here-0000');
    assert.equal(ck.ok, true);
    const runs = (await mod.api.listRuns()).runs;
    assert.ok(runs.length >= 2);
    await assert.rejects(mod.api.createRun({ prompt: '주제' }), (e) => e instanceof mod.ApiError && e.code === 'no_api_key' && e.status === 400);
    await assert.rejects(mod.api.run('nope'), (e) => e instanceof mod.ApiError && e.code === 'not_found' && e.status === 404);
    await assert.rejects(mod.api.rename(runs.find((r) => r.sample).id, 'x'), (e) => e instanceof mod.ApiError);
    const md = await mod.api.exportFile(runs[0].id, 'md');
    assert.equal(typeof md.data, 'string');
    assert.equal(mod.api.hasActiveRuns(), false);
    const e = mod.toApiError(new TypeError('boom'));
    assert.equal(e.code, 'internal');
    assert.ok(!e.message.includes('boom'));
  } finally {
    globalThis.fetch = origFetch;
    for (const k of Object.keys(shim)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
});

// ── 2차 수정 연결 점검: run.js가 부르는 순서 그대로 api.js(?mock=1)로 계획 검토 대기 시간(wait_s)과 '지금 마무리'를 몰아 본다 ──
async function withMockApi(fn) {
  const saved = {};
  const shim = {
    Element: class {}, DocumentFragment: class {},
    location: { search: '?mock=1', hash: '', href: 'http://127.0.0.1/ai-research-agent/?mock=1' },
  };
  for (const k of Object.keys(shim)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); globalThis[k] = shim[k]; }
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return origFetch(url, opts);
    try {
      const text = await readFile(fileURLToPath(u), 'utf8');
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404, text: async () => '', json: async () => null };
    }
  };
  try {
    const mod = await import('../assets/js/api.js');
    assert.equal(mod.MOCK, true);
    assert.deepEqual(await mod.startBackend(), { ok: true });
    return await fn(mod);
  } finally {
    globalThis.fetch = origFetch;
    for (const k of Object.keys(shim)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}

test('api.js(?mock=1): 화면이 쓰는 api.* 이름이 모두 있다(지금 마무리 포함)', async () => {
  await withMockApi(async (mod) => {
    const used = new Set();
    for (const f of ['main.js', 'onboarding.js', 'notify.js', 'views/compose.js', 'views/run.js', 'views/result.js', 'views/rewrite.js']) {
      const src = await readFile(new URL(`../assets/js/${f}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\bapi\.([A-Za-z]+)\s*\(/g)) used.add(m[1]);
    }
    assert.ok(used.has('finishEarly'));
    for (const n of used) assert.equal(typeof mod.api[n], 'function', `화면이 부르는 api.${n}가 없음`);
  });
});

test('api.js(?mock=1): 계획 검토 대기 시간(wait_s) → 고친 질문만 보내 승인 → 지금 마무리 → 결과', { timeout: 90000 }, async () => {
  await withMockApi(async (mod) => {
    const { api, ApiError } = mod;
    const cfg = await api.config();
    // compose.js: 웹 검색 요금을 예상 비용에 더할 값
    assert.equal(cfg.web_search_usd, 0.01);
    for (const d of cfg.depths) assert.equal(typeof d.estimate.web_searches, 'number', `${d.id} estimate.web_searches 없음`);

    const created = await api.createRun({
      prompt: PROMPT, model: cfg.models[0].id, depth: 'quick', options: {}, language: 'ko', year_from: null,
      human_in_the_loop: true, formats: ['md'], max_cost_usd: 5, api_key: KEY,
    });
    const id = created.id;
    const c = cursor();
    // run.js 폴링(api.events)과 같은 방식으로 상태를 받는다
    const poll = async (until) => {
      for (;;) {
        const res = await api.events(id, c.next, 0);
        for (const ev of res.events) { c.lastSeq = ev.seq; c.events.push(ev); }
        c.next = Math.max(c.next, res.next, c.lastSeq);
        if (until(res.status)) return res.status;
        if (!ACTIVE.includes(res.status.status)) return res.status;
        await sleep(20);
      }
    };

    const waiting = await poll((st) => st.status === 'awaiting_plan');
    assert.equal(waiting.status, 'awaiting_plan');
    assert.equal(waiting.finish_requested, false);
    // 계획 검토 중에는 마무리할 수 없다(409 not_now)
    await assert.rejects(api.finishEarly(id), (e) => e instanceof ApiError && e.code === 'not_now' && e.status === 409);
    const w1 = (await api.run(id)).wait_s;
    await sleep(400);
    const w2 = (await api.run(id)).wait_s;
    assert.equal(typeof w1, 'number');
    assert.ok(w2 >= w1 + 0.3, `대기 중 wait_s가 늘지 않음: ${w1} → ${w2}`);

    // run.js 승인: 그대로인 항목은 원래 값을 펼치고, 고친 항목은 {id, question}만 보낸다
    const subqs = waiting.plan.sub_questions;
    const body = subqs.map((sq, i) => (i === 0 ? { id: sq.id ?? `q${i}`, question: `${sq.question} (고침)` } : { ...sq, id: sq.id ?? `q${i}` }));
    assert.deepEqual(await api.submitPlan(id, { action: 'approve', sub_questions: body }), { ok: true });
    const afterApprove = (await api.run(id)).wait_s;
    assert.ok(afterApprove >= w2);

    // 자료 탐색이 시작되면 run.js의 '지금 마무리' 버튼 조건(running + act/evaluate/synthesize/reflect)
    const LOOP = ['act', 'evaluate', 'synthesize', 'reflect'];
    const live = await poll((st) => st.status === 'running' && LOOP.includes(st.stage));
    assert.equal(live.status, 'running', JSON.stringify(live.error));
    const fe = await api.finishEarly(id);
    assert.equal(fe.ok, true);
    assert.equal(fe.status.finish_requested, true);
    const again = await api.finishEarly(id);        // 두 번 눌러도 같은 답(멱등)
    assert.equal(again.ok, true);

    const fin = await poll(() => false);
    assert.equal(fin.status, 'done', JSON.stringify(fin.error));
    assert.equal(fin.finish_requested, true);
    // 시계는 실제 경과 시간, 남은 시간 계산은 elapsed_s - wait_s
    assert.ok(Math.abs(fin.wait_s - afterApprove) < 0.05, `승인 뒤 wait_s가 바뀜: ${afterApprove} → ${fin.wait_s}`);
    assert.ok(fin.elapsed_s >= fin.wait_s);
    const fev = c.events.filter((ev) => ev.kind === 'finish_early');
    assert.equal(fev.length, 1);
    assert.ok(LOOP.includes(fev[0].stage));
    assert.equal(fev[0].msg, '사용자 요청으로 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.');
    const res = await api.result(id);
    assert.equal(res.meta.finished_early, true);
    assert.ok(res.plan.sub_questions.some((q) => q.question.endsWith('(고침)')));
    assert.ok(String(res.report_md || res.report_html || '').length > 0, '보고서가 비어 있음');
    await assert.rejects(api.finishEarly(id), (e) => e instanceof ApiError && e.code === 'not_running' && e.status === 409);

    // 데모는 일찍 마무리할 수 없다
    const demo = await api.createRun({
      prompt: '데모', model: cfg.models[0].id, depth: 'standard', language: 'auto', human_in_the_loop: false, formats: ['md'], demo: true, demo_speed: 5,
    });
    await assert.rejects(api.finishEarly(demo.id), (e) => e instanceof ApiError && e.code === 'not_supported' && e.status === 409);
    await api.cancel(demo.id);
    await waitFor(async () => !api.hasActiveRuns());
  });
});

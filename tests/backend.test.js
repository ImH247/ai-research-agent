// 브라우저 백엔드 테스트: MemoryStorage + FakeLLM + 가짜 검색 도구 (네트워크·API 키 없음).
// 생성·폴링, 보고서 미리보기, 계획 검토, 취소, 페이지 새로고침 흉내 후 이어하기, 오류 후 이어하기,
// 조사 파일 저장·열기, 보고서 다시 쓰기, 데모 재생, 샘플(읽기 전용), 저장소에 API 키가 남지 않는지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createBackend, BackendError } from '../assets/js/engine/backend.js';
import { MemoryStorage, IndexedDBStorage, STORES } from '../assets/js/engine/storage.js';
import { Run, cpLength } from '../assets/js/engine/runs.js';
import { buildRunFile, parseRunFile } from '../assets/js/engine/runfile.js';
import { LLMError } from '../assets/js/engine/llm.js';
import { FakeLLM, makeFakeTools } from './fakes.js';

const KEY = 'sk-ant-api03-TESTSECRET_backend_key-000111222';
const SAMPLE = 'sample_genai_graduate_research';
const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadSample = (p) => readFile(new URL(`../data/samples/${p}`, import.meta.url), 'utf8');
const storages = [];

function mk({ storage = new MemoryStorage(), llm = () => new FakeLLM(), tools = null, sampleSpeed = 1, listModels = null } = {}) {
  storages.push(storage);
  const b = createBackend({ storage, llmFactory: llm, tools: tools || makeFakeTools({ fail: [] }), loadSample, sampleSpeed, listModels });
  return { b, storage };
}

async function waitFor(fn, ms = 15000, step = 5) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과');
    await sleep(step);
  }
}

async function rejectsCode(promise, code, status = null) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof BackendError, `BackendError가 아님: ${e}`);
    assert.equal(e.code, code);
    if (status !== null) assert.equal(e.status, status);
    return true;
  });
}

/** after를 이어 가며 끝까지 폴링 → 모든 이벤트 */
async function pollAll(b, id) {
  const events = [];
  let after = 0;
  for (;;) {
    const r = await b.events(id, after, 0);
    events.push(...r.events);
    after = r.next;
    if (!['queued', 'running', 'awaiting_plan'].includes(r.status.status) && !r.events.length) return [events, r.status];
    await sleep(5);
  }
}

function assertSeqs(events) {
  events.forEach((e, i) => assert.equal(e.seq, i + 1, `seq ${e.seq} at ${i}`));
}

/** 보고서 스트림을 천천히 흘려보내는 FakeLLM (미리보기 테스트용) */
class SlowStreamLLM extends FakeLLM {
  async text(system, prompt, opts = {}) {
    if (!opts.stream || !opts.onDelta) return super.text(system, prompt, opts);
    const full = await super.text(system, prompt, { ...opts, stream: false, onDelta: null });
    const parts = Array.from(full);
    for (let i = 0; i < parts.length; i += 150) {
      opts.onDelta(parts.slice(i, i + 150).join(''));
      await sleep(10);
    }
    this.streamed = (this.streamed || '') + full;
    return full;
  }
}

/** 첫 자기 비판 호출에서 연결 오류를 내는 FakeLLM */
class FlakyLLM extends FakeLLM {
  async json(system, prompt, schema, opts = {}) {
    if (FakeLLM.stageOf(schema) === 'reflection') {
      await this._track('reflection');
      throw new LLMError('connection', 'Anthropic API에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
    }
    return super.json(system, prompt, schema, opts);
  }
}

test('config: 웹 버전 기능과 서버 전용 값', async () => {
  const { b } = mk();
  const c = await b.config();
  assert.equal(c.demo, false);
  assert.equal(c.server_key, false);
  assert.deepEqual(c.features, { resume: true, cost_cap: true, run_files: true, rewrite: true, refine: true, notifications: true });
  assert.equal(c.stages.length, 8);
  assert.ok(c.formats.some((f) => f.id === 'pdf' && f.available));
  assert.ok(c.tools.some((t) => t.name === 'web_search'));
  assert.deepEqual(c.limits.max_cost_usd, [0, 100]);
  assert.equal(c.demo_sample, SAMPLE);
  assert.equal(c.storage.kind, 'memory');
});

test('IndexedDBStorage: Node에서 import해도 indexedDB에 접근하지 않고, 쓸 수 없으면 메모리 저장소로 바꾼다', async () => {
  const s = new IndexedDBStorage();
  await assert.rejects(s.get('runs', 'x'), /IndexedDB/);
  const b = createBackend({ storage: s, llmFactory: () => new FakeLLM(), tools: makeFakeTools(), loadSample });
  const c = await b.config();
  assert.equal(c.storage.persistent, false);
  assert.ok(c.storage.warning);
  storages.push(b.storage);
});

test('checkKey: 형식 검사와 listModels 결과', async () => {
  const { b } = mk({ listModels: async (k) => { assert.equal(k, KEY); return ['claude-opus-5-5']; } });
  assert.deepEqual(await b.checkKey(KEY), { ok: true, models: ['claude-opus-5-5'] });
  assert.equal((await b.checkKey('')).error.code, 'no_api_key');
  assert.equal((await b.checkKey('sk ant')).error.code, 'auth');
  const { b: b2 } = mk({ listModels: async () => { throw new LLMError('auth', 'API 키가 올바르지 않습니다.'); } });
  assert.deepEqual(await b2.checkKey(KEY), { ok: false, error: { code: 'auth', message: 'API 키가 올바르지 않습니다.' } });
});

test('createRun 입력 검사', async () => {
  const { b } = mk();
  await rejectsCode(b.createRun({ prompt: '  ', api_key: KEY }), 'empty_prompt', 400);
  await rejectsCode(b.createRun({ prompt: 'x'.repeat(4001), api_key: KEY }), 'prompt_too_long', 400);
  await rejectsCode(b.createRun({ prompt: PROMPT }), 'no_api_key', 400);
  await rejectsCode(b.createRun({ prompt: PROMPT, api_key: 'sk-ant bad key' }), 'auth', 400);
  await rejectsCode(b.createRun({ prompt: PROMPT, api_key: KEY, model: 'bad model!' }), 'invalid_model', 400);
  await rejectsCode(b.run('없는 id'), 'not_found', 404);
  await rejectsCode(b.events('r_missing', 0, 0), 'not_found', 404);
  assert.equal(b.hasActiveRuns(), false);
});

test('실행 생성 → 폴링으로 끝까지, 결과·결과물·Q&A', async () => {
  const llms = [];
  const { b } = mk({ llm: (o) => { const l = new FakeLLM({ model: o.model }); llms.push([o, l]); return l; } });
  const created = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', formats: ['md', 'pptx', 'md', 'bogus'],
    max_cost_usd: 50, options: { parallelism: 3, api_key: 'ignored' } });
  assert.match(created.id, /^r\d{8}_\d{6}_[0-9a-f]{4}$/);
  assert.equal(created.status.status, 'running');
  assert.deepEqual(created.status.formats, ['md', 'pptx']);
  assert.equal(created.status.config.max_cost_usd, 50);
  assert.equal(b.hasActiveRuns(), true);
  await rejectsCode(b.result(created.id), 'no_result', 404);

  const [events, status] = await pollAll(b, created.id);
  assert.equal(llms[0][0].apiKey, KEY);
  assert.ok(llms[0][0].signal, '취소 신호를 넘긴다');
  assertSeqs(events);
  assert.equal(status.status, 'done', JSON.stringify(status.error));
  assert.equal(status.stage, 'done');
  assert.equal(status.has_result, true);
  assert.deepEqual(status.exports, { md: 'ready', pptx: 'ready' });
  assert.equal(status.resumable, false);
  assert.ok(status.usage.calls > 0);
  assert.ok(status.counts.collected > 0 && status.counts.sub_questions > 0);
  assert.equal(b.hasActiveRuns(), false);
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['stage', 'understanding', 'plan', 'tool', 'evaluate', 'synthesis', 'report', 'verify', 'export']) assert.ok(kinds.has(k), k);
  assert.deepEqual(events.filter((e) => e.kind === 'export').map((e) => e.data.fmt), ['md', 'pptx']);
  const ev2 = await b.events(created.id, events.length - 2, 0);
  assert.equal(ev2.events.length, 2);
  assert.equal(ev2.next, events.length);
  assert.equal(ev2.preview, null);
  assert.equal((await b.events(created.id, 9999, 0)).next, 9999);

  const res = await b.result(created.id);
  assert.equal(res.schema_version, 1);
  assert.equal(res.id, created.id);
  assert.equal(res.meta.model, 'claude-opus-5-5');
  assert.equal(res.meta.budget_cap_usd, 50);
  assert.equal(res.meta.budget_hit, false);
  assert.ok(res.report_html.includes('<h2'));
  assert.ok(Array.isArray(res.toc) && res.toc.length > 0);
  assert.deepEqual(res.qa, []);
  assert.ok(res.trace.length > 0 && res.trace.every((t) => !('data' in t)));
  assert.ok(!('year_from' in res) && 'year_from' in res.meta);

  const md = await b.exportFile(created.id, 'md');
  assert.equal(typeof md.data, 'string');
  assert.match(md.filename, /_report\.md$/);
  const pdf = await b.exportFile(created.id, 'pdf');
  assert.equal(pdf.print, true);
  const zip = await b.exportFile(created.id, 'zip');
  assert.ok(zip.data instanceof Uint8Array && zip.data[0] === 0x50 && zip.data[1] === 0x4b);
  assert.equal(zip.mime, 'application/zip');
  await rejectsCode(b.exportFile(created.id, 'exe'), 'invalid_format', 400);

  await rejectsCode(b.ask(created.id, { question: ' ', api_key: KEY }), 'empty_question', 400);
  await rejectsCode(b.ask(created.id, { question: '효과는?' }), 'no_api_key', 400);
  const item = await b.ask(created.id, { question: '글쓰기 시간에 어떤 효과가 있나?', api_key: KEY });
  assert.ok(item.answer_markdown && item.answer_html.includes('<p'));
  assert.ok(Array.isArray(item.sources));
  assert.equal((await b.qa(created.id)).items.length, 1);
  assert.equal((await b.result(created.id)).qa.length, 1);
  const sl = await b.slides(created.id, { api_key: KEY });
  assert.equal(sl.ok, true);

  await rejectsCode(b.submitPlan(created.id, { action: 'approve' }), 'not_awaiting', 409);
  assert.deepEqual(await b.cancel(created.id), { ok: false });
  const renamed = await b.rename(created.id, '  내   실행\n제목 ');
  assert.equal(renamed.custom_title, '내 실행 제목');
  const listed = (await b.listRuns()).runs;
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].custom_title, '내 실행 제목');
  assert.deepEqual(listed.slice(-2).map((r) => r.id), [SAMPLE, 'sample_roll_sensor_fabrication']);
  assert.deepEqual(await b.remove(created.id), { ok: true });
  await rejectsCode(b.run(created.id), 'not_found', 404);
});

test('보고서 작성 중 미리보기(코드포인트 위치)', async () => {
  let llm;
  const { b } = mk({ llm: () => (llm = new SlowStreamLLM()) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick' });
  let pos = 0;
  let text = '';
  let hits = 0;
  for (;;) {
    const r = await b.events(id, 0, pos);
    if (r.preview) {
      assert.equal(r.status.stage, 'report');
      assert.equal(r.preview.from, pos);
      assert.ok(r.preview.total >= pos + cpLength(r.preview.text));
      if (r.preview.text) hits += 1;
      text += r.preview.text;
      pos += cpLength(r.preview.text);
    }
    if (!['running', 'queued'].includes(r.status.status)) break;
    await sleep(3);
  }
  assert.ok(hits >= 2, `미리보기를 ${hits}번만 받음`);
  assert.ok(text.length > 100);
  assert.ok(llm.streamed.startsWith(text), '받은 미리보기는 스트리밍한 본문의 앞부분');
  assert.equal((await b.run(id)).status, 'done');
});

test('Run.preview: 위치는 코드포인트 기준', () => {
  const run = new Run('r_x', 'p', {});
  run.status = 'running';
  run.stage = 'report';
  run.reportDelta('가😀');
  run.reportDelta('나');
  assert.deepEqual(run.preview(0), { from: 0, text: '가😀나', total: 3 });
  assert.deepEqual(run.preview(1), { from: 1, text: '😀나', total: 3 });
  assert.deepEqual(run.preview(2), { from: 2, text: '나', total: 3 });
  assert.deepEqual(run.preview(99), { from: 3, text: '', total: 3 });
  run.stage = 'verify';
  assert.equal(run.preview(0), null);
});

test('계획 검토: 대기 · 잘못된 결정 · 재계획 · 직접 수정', async () => {
  const { b } = mk();
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', human_in_the_loop: true });
  await waitFor(async () => (await b.run(id)).status === 'awaiting_plan');
  const snap = await b.run(id);
  assert.equal(snap.awaiting, 'plan');
  assert.ok(snap.plan.sub_questions.length >= 3);
  await rejectsCode(b.submitPlan(id, { action: 'skip' }), 'invalid_plan', 400);
  await rejectsCode(b.submitPlan(id, { action: 'revise', feedback: '   ' }), 'invalid_plan', 400);
  await rejectsCode(b.submitPlan(id, { action: 'approve', sub_questions: [] }), 'invalid_plan', 400);
  await rejectsCode(b.submitPlan(id, { action: 'approve', sub_questions: [{ question: '' }] }), 'invalid_plan', 400);
  assert.deepEqual(await b.submitPlan(id, { action: 'revise', feedback: '실증 연구 위주로' }), { ok: true });
  await rejectsCode(b.submitPlan(id, { action: 'approve' }), 'not_awaiting', 409);
  const waits = async () => (await b.events(id, 0, 0)).events.filter((e) => e.kind === 'plan_review' && e.data.action === 'waiting').length;
  await waitFor(async () => (await waits()) === 2 && (await b.run(id)).status === 'awaiting_plan');
  assert.deepEqual(await b.submitPlan(id, { action: 'approve', sub_questions: [
    { question: '생성형 AI가 글쓰기 시간에 미치는 영향은?', preferred_tools: ['search_openalex', 'nope'] },
    { question: '연구 품질 평가는 어떻게 달라졌나?', search_queries: ['  research quality AI  ', 7] },
  ] }), { ok: true });
  const [events, status] = await pollAll(b, id);
  assertSeqs(events);
  assert.equal(status.status, 'done');
  assert.deepEqual(events.filter((e) => e.kind === 'plan_review').map((e) => e.data.action), ['waiting', 'revise', 'waiting', 'edit']);
  const res = await b.result(id);
  assert.equal(res.plan.sub_questions[0].question, '생성형 AI가 글쓰기 시간에 미치는 영향은?');
  assert.equal(res.plan.sub_questions[1].question, '연구 품질 평가는 어떻게 달라졌나?');
});

test('동시 진행 최대 2건, 계획 대기 중 취소', async () => {
  const { b } = mk();
  const a = await b.createRun({ prompt: PROMPT, api_key: KEY, human_in_the_loop: true });
  const c = await b.createRun({ prompt: PROMPT, api_key: KEY, human_in_the_loop: true });
  await rejectsCode(b.createRun({ prompt: PROMPT, api_key: KEY }), 'too_many_runs', 409);
  await waitFor(async () => (await b.run(a.id)).status === 'awaiting_plan');
  assert.deepEqual(await b.cancel(a.id), { ok: true });
  assert.deepEqual(await b.cancel(c.id), { ok: true });
  assert.equal((await b.waitForRun(a.id)).status, 'cancelled');
  assert.equal((await b.waitForRun(c.id)).status, 'cancelled');
  assert.equal(b.hasActiveRuns(), false);
});

test('취소: 탐색 중에 멈추고 체크포인트는 지운다', async () => {
  const { b, storage } = mk({ llm: () => new FakeLLM({ delay: 15 }) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick' });
  await waitFor(async () => ['act', 'evaluate'].includes((await b.run(id)).stage));
  await rejectsCode(b.remove(id), 'running', 409);
  assert.deepEqual(await b.cancel(id), { ok: true });
  const snap = await b.waitForRun(id);
  assert.equal(snap.status, 'cancelled');
  assert.equal(snap.resumable, false);
  assert.equal(snap.error, null);
  const evs = (await b.events(id, 0, 0)).events;
  assert.equal(evs.at(-1).msg, '사용자가 실행을 취소했습니다');
  assert.equal(await storage.get('checkpoints', id), undefined);
  assert.equal((await storage.get('runs', id)).status, 'cancelled');
  await rejectsCode(b.resume(id, { api_key: KEY }), 'not_resumable', 409);
  assert.deepEqual(await b.remove(id), { ok: true });
  for (const s of ['runs', 'events', 'checkpoints']) assert.equal(await storage.get(s, id), undefined);
});

test('페이지 새로고침 흉내: 중단으로 표시되고 체크포인트에서 이어서 끝까지', async () => {
  const storage = new MemoryStorage();
  const { b: first } = mk({ storage, llm: () => new FakeLLM({ delay: 10 }) });
  const { id } = await first.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', formats: ['md'] });
  const ck = await waitFor(async () => {
    const c = await storage.get('checkpoints', id);
    return c && c.state.done === 'act' ? c : null;
  });
  assert.equal(ck.kind, 'agent');
  await first.dispose();                     // 탭을 닫은 것처럼: 더 저장하지 않고 멈춘다
  assert.equal((await storage.get('runs', id)).status, 'running');

  const llms = [];
  const { b } = mk({ storage, llm: () => { const l = new FakeLLM(); llms.push(l); return l; } });
  const snap = await b.run(id);
  assert.equal(snap.status, 'interrupted');
  assert.equal(snap.resumable, true);
  assert.equal(snap.error.code, 'interrupted');
  assert.equal(snap.awaiting, null);
  const listed = (await b.listRuns()).runs.find((r) => r.id === id);
  assert.equal(listed.resumable, true);
  assert.equal(b.hasActiveRuns(), false);
  const before = (await b.events(id, 0, 0)).events;
  assert.ok(before.length > 5);
  const usageBefore = snap.usage.calls;

  await rejectsCode(b.resume(id, {}), 'no_api_key', 400);
  const r = await b.resume(id, { api_key: KEY });
  assert.equal(r.ok, true);
  assert.equal(r.status.status, 'running');
  assert.equal(b.hasActiveRuns(), true);
  const [events, status] = await pollAll(b, id);
  assert.equal(status.status, 'done', JSON.stringify(status.error));
  assertSeqs(events);                        // seq는 이어서 매긴다
  assert.deepEqual(events.slice(0, before.length), before);
  const resumeLog = events.find((e) => e.kind === 'log' && e.data && e.data.resume_from);
  assert.equal(resumeLog.data.resume_from, 'act');
  assert.ok(!events.slice(before.length).some((e) => e.kind === 'understanding'), '끝난 단위는 다시 하지 않는다');
  assert.ok(status.usage.calls > usageBefore, '사용량은 이어서 센다');
  assert.equal(llms[0].calls.includes('understanding'), false);
  const res = await b.result(id);
  assert.ok(res.report_markdown.length > 100);
  assert.equal(res.meta.usage.calls, status.usage.calls);
  assert.equal(await storage.get('checkpoints', id), undefined);
});

test('오류(연결 끊김)로 끝난 실행을 이어서 진행', async () => {
  let n = 0;
  const { b } = mk({ llm: () => (n++ === 0 ? new FlakyLLM() : new FakeLLM()) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'standard' });
  const snap = await b.waitForRun(id);
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'connection');
  assert.equal(snap.resumable, true);
  const evs = (await b.events(id, 0, 0)).events;
  assert.equal(evs.at(-1).kind, 'error');
  assert.ok(!JSON.stringify(snap).includes(KEY));
  // 새로 열어도 이어하기 가능으로 보인다
  const { b: again } = mk({ storage: b.storage });
  assert.equal((await again.run(id)).resumable, true);
  await again.dispose();

  await b.resume(id, { api_key: KEY });
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.error, null);
  const all = (await b.events(id, 0, 0)).events;
  assertSeqs(all);
  assert.equal(all.find((e) => e.data?.resume_from).data.resume_from, 'synthesize');
});

test('조사 파일 저장·열기 왕복과 검사', async () => {
  const { b } = mk();
  const file = await b.exportRunFile(SAMPLE);
  assert.equal(file.mime, 'application/json');
  assert.match(file.filename, /_run\.json$/);
  const parsed = parseRunFile(file.data);
  assert.equal(parsed.events.length, 91);
  const sampleRes = (await b.result(SAMPLE));
  await b.ask(SAMPLE, { question: '연구 품질에는 어떤 영향이 있나?', api_key: KEY });
  const file2 = await b.exportRunFile(SAMPLE);
  assert.equal(parseRunFile(file2.data).qa.length, 1);

  const { id } = await b.importRunFile(file2.data);
  assert.match(id, /^imp_\d{8}_\d{6}_[0-9a-f]{4}$/);
  const snap = await b.run(id);
  assert.equal(snap.imported, true);
  assert.equal(snap.status, 'done');
  assert.equal(snap.has_result, true);
  assert.equal(snap.counts.collected, sampleRes.meta.counts.collected);
  const res = await b.result(id);
  assert.equal(res.id, id);
  assert.equal(res.meta.imported_from, SAMPLE);
  assert.equal(res.report_markdown, sampleRes.report_markdown);
  assert.equal(res.qa.length, 1);
  assert.equal((await b.events(id, 0, 0)).events.length, 91);
  const listed = (await b.listRuns()).runs.map((r) => r.id);
  assert.deepEqual(listed, [id, SAMPLE, 'sample_roll_sensor_fabrication']);
  assert.equal((await b.exportFile(id, 'md')).data.length > 1000, true);
  await rejectsCode(b.resume(id, { api_key: KEY }), 'not_resumable', 409);
  assert.equal((await b.rename(id, '가져온 조사')).custom_title, '가져온 조사');
  // 같은 저장소로 새로 열어도 남아 있다
  const { b: again } = mk({ storage: b.storage });
  assert.equal((await again.run(id)).custom_title, '가져온 조사');
  assert.equal((await again.result(id)).report_markdown, sampleRes.report_markdown);
  assert.deepEqual(await b.remove(id), { ok: true });

  // 결과물로 내보낸 result.json도 열린다
  const bare = await b.importRunFile(JSON.stringify({ report_markdown: '## 1. 요약\n본문 [S1]', sources: [{ sid: 'S1', title: 't' }], topic: '맨 결과' }));
  assert.equal((await b.result(bare.id)).topic, '맨 결과');

  await rejectsCode(b.importRunFile('이건 JSON이 아님'), 'invalid_file', 400);
  await rejectsCode(b.importRunFile(JSON.stringify({ format: 'other', version: 1, result: {} })), 'invalid_file');
  await rejectsCode(b.importRunFile(JSON.stringify({ format: 'ai-research-agent/run', version: 2, result: {} })), 'invalid_file');
  await rejectsCode(b.importRunFile(JSON.stringify({ format: 'ai-research-agent/run', version: 1,
    result: { report_markdown: 'x' } })), 'invalid_file');
  await rejectsCode(b.importRunFile(''), 'invalid_file');
  assert.throws(() => parseRunFile(buildRunFile({ report_markdown: 3, sources: [] })), (e) => e.code === 'invalid_file');
});

test('보고서 다시 쓰기: 새 실행(parent_id)으로 ⑦⑧만', async () => {
  const llms = [];
  const { b } = mk({ llm: (o) => { const l = new FakeLLM({ model: o.model }); llms.push([o, l]); return l; } });
  await rejectsCode(b.rewriteReport(SAMPLE, {}), 'no_api_key', 400);
  const { id, status } = await b.rewriteReport(SAMPLE, { api_key: KEY, model: 'claude-sonnet-5-5', language: 'en', length: 'short', extra: '정책 시사점을 더 자세히' });
  assert.equal(status.parent_id, SAMPLE);
  assert.deepEqual(status.rewrite, { language: 'en', length: 'short', extra: '정책 시사점을 더 자세히' });
  const [events, snap] = await pollAll(b, id);
  assert.equal(snap.status, 'done', JSON.stringify(snap.error));
  assertSeqs(events);
  const stages = new Set(events.filter((e) => e.kind === 'stage').map((e) => e.stage));
  assert.deepEqual([...stages].sort(), ['export', 'report', 'verify']);
  const [opts, llm] = llms[0];
  assert.equal(opts.model, 'claude-sonnet-5-5');
  assert.ok(!llm.calls.some((c) => ['understanding', 'plan', 'evaluation', 'synthesis', 'reflection'].includes(c)));
  const res = await b.result(id);
  assert.equal(res.parent_id, SAMPLE);
  assert.equal(res.meta.parent_id, SAMPLE);
  assert.equal(res.meta.model, 'claude-sonnet-5-5');
  assert.equal(res.lang, 'en');
  assert.ok(res.trace.some((t) => t.stage === 'act'), '원래 실행의 기록(부록 D)을 이어 받는다');
  assert.ok(res.trace.some((t) => t.stage === 'report'));
  assert.equal(res.sources.length, (await b.result(SAMPLE)).sources.length);
  assert.equal((await b.listRuns()).runs[0].parent_id, SAMPLE);
});

test('주제 다듬기: 기본 모델 claude-haiku-5-5', async () => {
  const seen = [];
  const { b } = mk({ llm: (o) => { seen.push(o); return new FakeLLM({ model: o.model }); } });
  await rejectsCode(b.refinePrompt({ prompt: '원격근무와 생산성' }), 'no_api_key');
  await rejectsCode(b.refinePrompt({ prompt: ' ', api_key: KEY }), 'empty_prompt');
  const out = await b.refinePrompt({ prompt: '원격근무와 생산성', api_key: KEY, language: 'ko' });
  assert.equal(out.suggestions.length, 3);
  assert.ok(Array.isArray(out.questions));
  assert.equal(seen[0].model, 'claude-haiku-5-5');
  assert.equal(seen[0].apiKey, KEY);
});

test('샘플: 목록에 나오고 읽기 전용, 결과·이벤트·결과물은 가능', async () => {
  const { b } = mk();
  const runs = (await b.listRuns()).runs;
  assert.deepEqual(runs.map((r) => r.id), [SAMPLE, 'sample_roll_sensor_fabrication']);
  assert.ok(runs.every((r) => r.sample && r.status === 'done' && r.resumable === false));
  await rejectsCode(b.remove(SAMPLE), 'read_only', 403);
  await rejectsCode(b.rename(SAMPLE, 'x'), 'read_only', 403);
  await rejectsCode(b.resume(SAMPLE, { api_key: KEY }), 'not_resumable', 409);
  const evs = await b.events(SAMPLE, 0, 0);
  assert.equal(evs.events.length, 91);
  assert.equal(evs.next, 91);
  assert.equal(evs.preview, null);
  const res = await b.result(SAMPLE);
  assert.ok(res.report_html.length > 10000);
  assert.ok(res.toc.length >= 5);
  const html = await b.exportFile('sample_roll_sensor_fabrication', 'html');
  assert.match(html.data, /^<!doctype html>/i);
  assert.equal((await b.result('sample_roll_sensor_fabrication')).exports.html, 'ready');
});

test('데모 재생(빠른 속도): 계획 검토 대기·재계획·승인, 결과 복사, 키 없는 Q&A', async () => {
  const { b, storage } = mk({ sampleSpeed: 200 });
  const { id, status } = await b.createRun({ demo: true, demo_speed: 5, prompt: '내 주제', human_in_the_loop: true,
    formats: ['md'], max_cost_usd: 3 });
  assert.equal(status.demo, true);
  assert.equal(status.demo_speed, 5);
  assert.equal(status.config.max_cost_usd, null);
  await waitFor(async () => (await b.run(id)).status === 'awaiting_plan');
  assert.equal((await b.run(id)).plan.sub_questions.length, 6);
  await b.submitPlan(id, { action: 'revise', feedback: '국내 연구도' });
  const waits = async () => (await b.events(id, 0, 0)).events.filter((e) => e.kind === 'plan_review' && e.data.action === 'waiting').length;
  await waitFor(async () => (await waits()) === 2 && (await b.run(id)).status === 'awaiting_plan');
  await b.submitPlan(id, { action: 'approve' });
  let sawPreview = false;
  for (;;) {
    const r = await b.events(id, 0, 0);
    if (r.preview && r.preview.text) sawPreview = true;
    if (!['running', 'awaiting_plan'].includes(r.status.status)) break;
    await sleep(2);
  }
  const [events, snap] = await pollAll(b, id);
  assert.equal(snap.status, 'done', JSON.stringify(snap.error));
  assert.ok(sawPreview, '보고서 단계에서 미리보기를 흘려보낸다');
  assertSeqs(events);
  assert.deepEqual(events.filter((e) => e.kind === 'plan_review').map((e) => e.data.action), ['waiting', 'revise', 'waiting', 'approve']);
  assert.ok(snap.round >= 2);
  assert.equal(snap.counts.collected, 229);
  assert.equal(snap.usage.calls, 79);
  const res = await b.result(id);
  assert.equal(res.id, id);
  assert.equal(res.prompt, '내 주제');
  assert.equal(res.meta.demo, true);
  assert.match(res.meta.note, /^데모 모드 결과입니다/);
  const ans = await b.ask(id, { question: '연구 품질에 미치는 영향은?' });
  assert.match(ans.answer_markdown, /^\*\*데모 모드: 관련 근거 상위 \d+건\*\*/);
  assert.equal(await storage.get('checkpoints', id), undefined);
  assert.equal((await b.slides(id, {})).llm, false);
});

test('데모 재생 중 새로고침 → 키 없이 이어서 재생', async () => {
  const storage = new MemoryStorage();
  const { b: first } = mk({ storage, sampleSpeed: 4 });
  const { id } = await first.createRun({ demo: true, demo_speed: 5, prompt: '데모 주제' });
  await waitFor(async () => ((await storage.get('checkpoints', id))?.pos || 0) > 10);
  await first.dispose();
  const { b } = mk({ storage, sampleSpeed: 200 });
  const snap = await b.run(id);
  assert.equal(snap.status, 'interrupted');
  assert.equal(snap.resumable, true);
  await b.resume(id, {});
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  const evs = (await b.events(id, 0, 0)).events;
  assertSeqs(evs);
  assert.ok(evs.some((e) => e.data?.resume_from > 10));
  assert.equal((await b.result(id)).meta.demo, true);
});

test('저장소 어디에도 API 키가 남지 않는다', async () => {
  assert.ok(storages.length >= 10);
  for (const s of storages) {
    for (const store of STORES) {
      const dump = JSON.stringify([await s.keys(store), await s.getAll(store)]);
      assert.ok(!dump.includes(KEY), `${store}에 API 키가 있음`);
      assert.ok(!dump.includes('TESTSECRET'), `${store}에 API 키 일부가 있음`);
    }
  }
});

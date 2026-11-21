// 2차 수정 테스트: 계획 검토 대기 시간(wait_s), 지금 마무리(finishEarly), 이어하기 가능한 오류 코드,
// 예상 비용의 웹 검색 요금, 웹 검색 요청 오류, 실패한 스트림의 부분 사용량, 체크포인트 저장 실패 알림,
// 모양이 어긋난 조사 파일 가져오기 → 결과물 만들기, 화면 비용 = 비용 한도 비교 값, 이어하기의 웹 검색 횟수,
// 검색어 없는 하위 질문의 보강 검색.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createBackend, BackendError } from '../assets/js/engine/backend.js';
import { MemoryStorage, IndexedDBStorage } from '../assets/js/engine/storage.js';
import { RESUMABLE_CODES, Run } from '../assets/js/engine/runs.js';
import { LLM, LLMError } from '../assets/js/engine/llm.js';
import { ResearchAgent, TOOL_FAIL_LIMIT } from '../assets/js/engine/pipeline.js';
import { DEPTH_PRESETS, RunConfig, WEB_SEARCH_USD } from '../assets/js/engine/models.js';
import { parseRunFile } from '../assets/js/engine/runfile.js';
import { FakeLLM, RecordingHooks, makeFakeTools } from './fakes.js';

const KEY = 'sk-ant-api03-TESTSECRET_fixes2_key-000111222';
const SAMPLE = 'sample_genai_graduate_research';
const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadSample = (p) => readFile(new URL(`../data/samples/${p}`, import.meta.url), 'utf8');

function mk({ storage = new MemoryStorage(), llm = () => new FakeLLM(), now = null } = {}) {
  return createBackend({ storage, llmFactory: llm, tools: makeFakeTools({ fail: [] }), loadSample, now });
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

const allEvents = async (b, id) => (await b.events(id, 0, 0)).events;

test('wait_s: 계획 검토 대기 시간(지금 대기 포함)을 세고 저장·복원한다', async () => {
  let t = Date.parse('2026-11-18T10:00:00');
  const now = () => new Date(t);
  const storage = new MemoryStorage();
  const b = mk({ storage, now });
  const { id, status } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', human_in_the_loop: true });
  assert.equal(status.wait_s, 0);
  await waitFor(async () => (await b.run(id)).status === 'awaiting_plan');
  t += 30_000;
  const waiting = await b.run(id);
  assert.equal(waiting.wait_s, 30);
  assert.ok(waiting.elapsed_s >= 30, '시계는 실제 경과 시간을 그대로 보여 준다');
  t += 12_500;
  assert.equal((await b.run(id)).wait_s, 42.5);
  await b.submitPlan(id, { action: 'approve' });
  t += 100_000;                                   // 대기가 끝난 뒤의 시간은 더하지 않는다
  assert.equal((await b.run(id)).wait_s, 42.5);
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done');
  assert.equal(done.wait_s, 42.5);
  assert.equal((await storage.get('runs', id)).wait_s, 42.5);
  const again = mk({ storage, now });
  assert.equal((await again.run(id)).wait_s, 42.5);
  await again.dispose();
  await b.dispose();
});

test('finishEarly: 탐색 중 요청 → 추가 조사 없이 보고서까지, meta.finished_early', async () => {
  const b = mk({ llm: () => new FakeLLM({ delay: 15, continueRounds: 2 }) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'standard', human_in_the_loop: true });
  await waitFor(async () => (await b.run(id)).status === 'awaiting_plan');
  await rejectsCode(b.finishEarly(id), 'not_now', 409);          // 계획 검토 중에는 아직
  await b.submitPlan(id, { action: 'approve' });
  await waitFor(async () => (await b.run(id)).stage === 'act');
  const r = await b.finishEarly(id);
  assert.equal(r.ok, true);
  assert.equal(r.status.finish_requested, true);
  const r2 = await b.finishEarly(id);                             // 멱등
  assert.equal(r2.ok, true);
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.finish_requested, true);
  const evs = await allEvents(b, id);
  const fin = evs.filter((e) => e.kind === 'finish_early');
  assert.equal(fin.length, 1);
  assert.equal(fin[0].stage, 'act');
  assert.equal(fin[0].msg, '사용자 요청으로 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.');
  const after = evs.slice(evs.indexOf(fin[0]));
  assert.ok(!after.some((e) => e.kind === 'replan' || e.kind === 'reflection'), '재조사·자기 비판 라운드를 시작하지 않는다');
  assert.ok(!after.some((e) => e.kind === 'stage' && e.stage === 'reflect'));
  assert.ok(after.some((e) => e.kind === 'stage' && e.stage === 'report'));
  const res = await b.result(id);
  assert.equal(res.meta.finished_early, true);
  assert.ok(res.report_markdown.length > 100);
  assert.ok(res.trace.some((t) => t.kind === 'finish_early'));
  await rejectsCode(b.finishEarly(id), 'not_running', 409);
  await b.dispose();
});

test('finishEarly: 데모·끝난 실행·샘플은 거절', async () => {
  const b = mk();
  const { id } = await b.createRun({ prompt: PROMPT, demo: true, demo_speed: 20 });
  await rejectsCode(b.finishEarly(id), 'not_supported', 409);
  await b.cancel(id);
  await b.waitForRun(id);
  await rejectsCode(b.finishEarly(SAMPLE), 'not_supported', 409);
  await rejectsCode(b.finishEarly('nope'), 'not_found', 404);
  await b.dispose();
});

test('ResearchAgent: 첫 검색 뒤 마무리 요청 → 도구 턴 추가 없음, 보강 검색·자기 비판 없음, finished_early', async () => {
  const llm = new FakeLLM({ continueRounds: 2 });
  const tools = makeFakeTools({ fail: [] });
  let agent = null;
  const hooks = new RecordingHooks();
  const emit = hooks.emit.bind(hooks);
  hooks.emit = (stage, kind, msg, data) => {
    emit(stage, kind, msg, data);
    if (kind === 'tool' && agent) agent.requestFinish();
  };
  const cfg = RunConfig.fromDict({ depth: 'standard', parallelism: 1 });
  agent = new ResearchAgent(PROMPT, llm, cfg, hooks, tools);
  const out = await agent.run();
  assert.equal(out.finished_early, true);
  assert.equal(llm.calls.filter((c) => c === 'tool').length, 1, '요청 뒤에는 새 도구 턴을 시작하지 않는다');
  assert.equal(llm.calls.includes('reflection'), false);
  assert.ok(out.report_markdown.length > 100);
  assert.equal(agent.snapshotState().finish_requested, true);
  const restored = ResearchAgent.fromState(PROMPT, new FakeLLM(), cfg, new RecordingHooks(), agent.snapshotState(), tools);
  assert.equal(restored.finishRequested, true);
});

/** 첫 자기 비판에서 크레딧 부족 오류를 내는 FakeLLM */
class BillingLLM extends FakeLLM {
  async json(system, prompt, schema, opts = {}) {
    if (FakeLLM.stageOf(schema) === 'reflection') {
      await this._track('reflection');
      throw new LLMError('billing', 'Anthropic 계정의 크레딧이 부족합니다.');
    }
    return super.json(system, prompt, schema, opts);
  }
}

test('이어하기: 크레딧 부족(billing)으로 끝난 실행도 새 키로 이어서 진행', async () => {
  for (const c of ['billing', 'auth', 'permission']) assert.ok(RESUMABLE_CODES.has(c));
  let n = 0;
  const b = mk({ llm: () => (n++ === 0 ? new BillingLLM() : new FakeLLM()) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'standard' });
  const snap = await b.waitForRun(id);
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'billing');
  assert.equal(snap.resumable, true);
  const again = mk({ storage: b.storage });
  assert.equal((await again.run(id)).resumable, true);
  await again.dispose();
  await b.resume(id, { api_key: KEY });
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal((await allEvents(b, id)).find((e) => e.data?.resume_from).data.resume_from, 'synthesize');
  await b.dispose();
});

test('config: 웹 검색 요금과 깊이별 예상 웹 검색 횟수', async () => {
  const b = mk();
  const c = await b.config();
  assert.equal(c.web_search_usd, WEB_SEARCH_USD);
  assert.equal(c.web_search_usd, 0.01);
  const byId = Object.fromEntries(c.depths.map((d) => [d.id, d.estimate.web_searches]));
  assert.deepEqual(byId, { quick: 8, standard: 25, deep: 45 });
  assert.equal(DEPTH_PRESETS.standard.estimate.web_searches, 25);
  await b.dispose();
});

test('웹 검색 요청 오류(max_uses_exceeded 등)는 연속 실패로 세지 않는다', () => {
  const hooks = new RecordingHooks();
  const agent = new ResearchAgent(PROMPT, new FakeLLM(), RunConfig.fromDict({}), hooks, makeFakeTools({ fail: [] }));
  const blocks = (code, k) => [
    { type: 'server_tool_use', id: `w${k}`, name: 'web_search', input: { query: `q${k}` } },
    { type: 'web_search_tool_result', tool_use_id: `w${k}`, content: { type: 'web_search_tool_result_error', error_code: code } },
  ];
  let k = 0;
  for (const code of ['max_uses_exceeded', 'query_too_long', 'invalid_input', 'max_uses_exceeded']) {
    agent._recordWebSearch(blocks(code, k++), 'Q1');
  }
  assert.equal(agent.toolFailures.web_search || 0, 0);
  assert.equal(hooks.ofKind('tool_error').length, 0);
  assert.equal(hooks.ofKind('log').filter((e) => e.data?.tool === 'web_search').length, 4);
  assert.equal(agent.webSearchOff, false);
  for (let i = 0; i < TOOL_FAIL_LIMIT; i++) agent._recordWebSearch(blocks('unavailable', k++), 'Q1');
  assert.equal(hooks.ofKind('tool_error').length, TOOL_FAIL_LIMIT);
  assert.equal(agent.webSearchOff, true);
  assert.equal(hooks.ofKind('tool_disabled').length, 1);
});

test('LLM: 도중에 실패한 스트림의 부분 사용량을 더한다(호출 수는 그대로)', async () => {
  const fakeStream = () => ({
    on() { return this; },
    abort() {},
    currentMessage: { usage: { input_tokens: 500, output_tokens: 77, server_tool_use: { web_search_requests: 2 } } },
    finalMessage: () => Promise.reject(new Error('stream dropped')),
  });
  const api = { stream: fakeStream, create: async () => { throw new Error('unused'); } };
  const llm = new LLM({ model: 'claude-opus-5-5', client: { messages: api, beta: { messages: api } } });
  await assert.rejects(llm.text('s', 'p', { stream: true, onDelta: () => {} }));
  assert.equal(llm.usage.calls, 0);
  assert.equal(llm.usage.input_tokens, 500);
  assert.equal(llm.usage.output_tokens, 77);
  assert.equal(llm.usage.web_searches, 2);
});

/** checkpoints 쓰기만 실패하는 저장소 */
class FailingCheckpoints extends MemoryStorage {
  async put(store, key, value) {
    if (store === 'checkpoints') throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    return super.put(store, key, value);
  }
}

test('체크포인트 저장 실패는 실행마다 한 번 warning 이벤트로 알린다', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const b = mk({ storage: new FailingCheckpoints() });
    const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick' });
    const done = await b.waitForRun(id);
    assert.equal(done.status, 'done');
    const warns = (await allEvents(b, id)).filter((e) => e.kind === 'warning' && e.msg.includes('이어하기'));
    assert.equal(warns.length, 1);
    assert.equal(warns[0].stage, 'system');
    await b.dispose();
  } finally {
    console.warn = warn;
  }
});

test('IndexedDBStorage: versionchange·close 뒤에는 다음 쓰기에서 DB를 새로 연다', async () => {
  const dbs = [];
  const factory = {
    open() {
      const r = {};
      const db = { objectStoreNames: { contains: () => true }, close() { this.closed = true; } };
      dbs.push(db);
      setTimeout(() => { r.result = db; r.onsuccess(); }, 0);
      return r;
    },
  };
  const s = new IndexedDBStorage({ indexedDB: factory });
  const first = await s._db();
  assert.equal(await s._db(), first);
  first.onversionchange();
  assert.equal(first.closed, true);
  const second = await s._db();
  assert.notEqual(second, first);
  first.onclose();                     // 예전 연결의 close가 새 연결 캐시를 지우지 않는다
  assert.equal(await s._db(), second);
  second.onclose();
  assert.notEqual(await s._db(), second);
  assert.equal(dbs.length, 3);
});

test('조사 파일 가져오기: 저자가 문자열·unknown_ids가 문자열이어도 결과물 4종을 만든다', async () => {
  const b = mk();
  const file = JSON.parse((await b.exportRunFile(SAMPLE)).data);
  const src = file.result.sources;
  src[0].authors = 'Kim J; Lee S';
  src[1].authors = 42;
  src[2].subqs = 'Q1';
  src.push('문자열 문헌', { title: 'sid 없음' });
  file.result.verification.unknown_ids = 'S9999';
  file.result.verification.checks = 'x';
  file.result.trace = 'broken';
  file.result.reflections = { a: 1 };
  assert.ok(parseRunFile(JSON.stringify(file)));
  const { id } = await b.importRunFile(JSON.stringify(file));
  const res = await b.result(id);
  assert.deepEqual(res.sources[0].authors, ['Kim J', 'Lee S']);
  assert.deepEqual(res.sources[1].authors, []);
  assert.equal('subqs' in res.sources[2], false);
  assert.ok(res.sources.every((s) => typeof s.sid === 'string'));
  assert.deepEqual(res.verification.unknown_ids, []);
  assert.deepEqual(res.trace, []);
  assert.deepEqual(res.reflections, []);
  // 가져온 샘플은 원래 샘플의 미리 만든 구성안을 쓴다(문헌이 어긋나도 normalizeDeck이 없는 id를 지운다)
  assert.equal(res.slides_source, 'sample');
  for (const fmt of ['md', 'html', 'docx', 'pptx']) {
    const out = await b.exportFile(id, fmt);
    assert.ok(out.data && (out.data.length || out.data.byteLength || out.data.size) > 100, fmt);
  }
  await b.dispose();
});

test('조사 파일에는 발표 구성안이 없다: 가져온 일반 실행 · 모르는 샘플 · result.json은 규칙 구성안으로 PowerPoint', async () => {
  const storage = new MemoryStorage();
  const b = mk({ storage });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'quick', formats: ['md', 'pptx'] });
  assert.equal((await b.waitForRun(id)).status, 'done');
  assert.equal((await b.result(id)).slides_source, 'llm');
  const rf = JSON.parse((await b.exportRunFile(id)).data);
  assert.deepEqual(Object.keys(rf).sort(), ['app_version', 'events', 'exported_at', 'format', 'qa', 'result', 'version']);
  assert.ok(!('slides_source' in rf.result) && !('deck' in rf.result), '조사 파일의 결과에 구성안 정보가 들어감');

  const b2 = mk();
  const { id: imp } = await b2.importRunFile(JSON.stringify(rf));
  assert.equal((await b2.result(imp)).slides_source, 'rules');
  // 샘플 표시가 있어도 이 사이트에 없는 샘플 id면 미리 만든 구성안을 쓰지 않는다
  const sf = JSON.parse((await b2.exportRunFile(SAMPLE)).data);
  sf.result.id = 'sample_unknown_topic';
  const { id: imp2 } = await b2.importRunFile(JSON.stringify(sf));
  assert.equal((await b2.result(imp2)).slides_source, 'rules');
  // 결과물로 내보낸 result.json(조사 파일 형식이 아님)도 열고 PowerPoint를 만든다
  const { id: imp3 } = await b2.importRunFile((await b.exportFile(id, 'json')).data);
  assert.equal((await b2.result(imp3)).slides_source, 'rules');
  for (const rid of [imp, imp2, imp3]) {
    const out = await b2.exportFile(rid, 'pptx');
    assert.equal(String.fromCharCode(out.data[0], out.data[1]), 'PK', rid);
  }
  await b.dispose();
  await b2.dispose();
});

test('Run.liveUsage: 화면 비용은 llm.costUsd()(비용 한도가 비교하는 값)와 같다', () => {
  const run = new Run('r1', PROMPT, RunConfig.fromDict({}));
  const llm = new FakeLLM({ costPerCall: 0.05 });
  llm.usage = { calls: 3, input_tokens: 300, output_tokens: 60 };
  run.llm = llm;
  assert.equal(run.liveUsage().cost_usd, llm.costUsd());
  run.llm = { usage: { calls: 1, input_tokens: 0, output_tokens: 0 } };      // costUsd가 없으면 추정 단가로
  assert.equal(typeof run.liveUsage().cost_usd, 'number');
});

/** 탐색 턴마다 웹 검색 1회를 쓰고, 첫 자기 비판에서 연결 오류를 내는 FakeLLM */
class WebCountingFlaky extends FakeLLM {
  async toolTurn(system, messages, tools, opts = {}) {
    const r = await super.toolTurn(system, messages, tools, opts);
    this.usage.web_searches = (this.usage.web_searches || 0) + 1;
    return r;
  }

  async json(system, prompt, schema, opts = {}) {
    if (FakeLLM.stageOf(schema) === 'reflection') {
      await this._track('reflection');
      throw new LLMError('connection', 'Anthropic API에 연결할 수 없습니다.');
    }
    return super.json(system, prompt, schema, opts);
  }
}

test('이어하기: 중단 전 웹 검색 횟수(요금)를 이어서 센다', async () => {
  let n = 0;
  const b = mk({ llm: () => (n++ === 0 ? new WebCountingFlaky() : new FakeLLM()) });
  const { id } = await b.createRun({ prompt: PROMPT, api_key: KEY, depth: 'standard' });
  const snap = await b.waitForRun(id);
  assert.equal(snap.status, 'error');
  const web = snap.usage.web_searches;
  assert.ok(web > 0);
  await b.resume(id, { api_key: KEY });
  const done = await b.waitForRun(id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.usage.web_searches, web);
  assert.equal((await b.result(id)).meta.usage.web_searches, web);
  await b.dispose();
});

test('보강 검색: 검색어가 없는 하위 질문은 질문 글로 검색한다', async () => {
  const tools = makeFakeTools({ fail: [], empty: true });
  const agent = new ResearchAgent(PROMPT, new FakeLLM(), RunConfig.fromDict({ depth: 'quick' }), new RecordingHooks(), tools);
  const sq = { id: 'Q1', question: '한국 대학원의 생성형 AI 사용 정책', search_queries: [] };
  await agent.investigate(sq);
  const fallback = tools.search_openalex.calls.filter((c) => c.tool === 'search_openalex' && c.query === sq.question);
  assert.equal(fallback.length, 1);
});

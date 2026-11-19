// 체크포인트 → 이어하기 결과가 중단 없는 실행과 같은지, 보고서 다시 쓰기, 후속 질문, 주제 다듬기
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RunCancelled, LLMError } from '../assets/js/engine/llm.js';
import { RunConfig } from '../assets/js/engine/models.js';
import { ResearchAgent, citedIds } from '../assets/js/engine/pipeline.js';
import { retrieve, answerQuestion } from '../assets/js/engine/qa.js';
import { refinePrompt, REFINE_SCHEMA } from '../assets/js/engine/refine.js';
import { FakeLLM, RecordingHooks, makeFakeTools } from './fakes.js';

const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향';
const cfgOf = (over = {}) => new RunConfig({ min_subq: 4, max_subq: 6, max_reflection_rounds: 2, max_tool_steps: 3,
  results_per_search: 6, verify_sample: 10, parallelism: 1, ...over });
const headings = (md) => md.split('\n').filter((l) => l.startsWith('#'));
const summaryOf = (r) => ({
  subqs: r.plan.sub_questions.map((q) => [q.id, q.question]),
  sources: r.sources.map((s) => [s.sid, s.title, s.kind]),
  included: r.sources.filter((s) => s.included).map((s) => s.sid),
  inReport: r.sources.filter((s) => s.in_report).map((s) => s.sid),
  counts: r.counts, syntheses: Object.keys(r.syntheses), reflections: r.reflections.map((x) => [x.round, x.final]),
  headings: headings(r.report_markdown), cited: citedIds(r.report_markdown), verification: r.verification,
  disabled: r.disabled_tools, yearFrom: r.year_from, topic: r.topic, lang: r.lang,
});

async function fullRun(cfg, llmOpts = {}) {
  const llm = new FakeLLM(llmOpts);
  const hooks = new RecordingHooks();
  const r = await new ResearchAgent(PROMPT, llm, cfg, hooks, makeFakeTools()).run();
  return { r, llm, hooks };
}

/** 단위 unit의 체크포인트 직후 취소 → 마지막 체크포인트로 새 에이전트를 만들어 끝까지 */
async function interruptedRun(cfg, unit, llmOpts = {}) {
  const llm1 = new FakeLLM(llmOpts);
  const hooks1 = new RecordingHooks({ cancelAtCheckpoint: unit });
  await assert.rejects(new ResearchAgent(PROMPT, llm1, cfg, hooks1, makeFakeTools()).run(), (e) => e instanceof RunCancelled);
  const state = hooks1.checkpoints.at(-1);
  assert.equal(state.done, unit);
  const text = JSON.stringify(state);
  assert.deepEqual(JSON.parse(text), state);                      // JSON으로 저장 가능
  assert.ok(!/sk-ant|api_key|apiKey/.test(text));
  const llm2 = new FakeLLM(llmOpts);
  llm2._reflections = state.reflections.length;                   // 가짜 비평가의 라운드 번호를 이어서
  const hooks2 = new RecordingHooks();
  const agent = ResearchAgent.fromState(PROMPT, llm2, cfg, hooks2, JSON.parse(text), makeFakeTools());
  const r = await agent.run();
  return { r, llm1, llm2, hooks1, hooks2, state };
}

test('이어하기: act·evaluate·round:1 체크포인트에서 중단 후 이어도 중단 없는 실행과 결과가 같다', async () => {
  for (const [cfgOver, llmOpts] of [[{}, {}], [{ parallelism: 3 }, { webSearch: true }]]) {
    const cfg = cfgOf(cfgOver);
    const full = await fullRun(cfg, llmOpts);
    assert.deepEqual(full.hooks.checkpoints.map((c) => c.done),
      ['understand', 'plan', 'act', 'evaluate', 'synthesize', 'round:1', 'round:2', 'report']);
    for (const unit of ['act', 'evaluate', 'round:1']) {
      const { r, llm2, state, hooks2 } = await interruptedRun(cfg, unit, llmOpts);
      assert.deepEqual(summaryOf(r), summaryOf(full.r), `${unit} ${JSON.stringify(cfgOver)}`);
      assert.equal(r.report_markdown, full.r.report_markdown);
      // 사용량은 체크포인트 값에서 이어서 누적된다
      assert.ok(llm2.usage.calls > state.usage.calls);
      assert.deepEqual(llm2.usage, full.llm.usage, unit);
      assert.equal(hooks2.events[0].msg, `체크포인트(${unit})에서 이어서 진행합니다.`);
      // 끝난 단위는 다시 실행하지 않는다
      const started = hooks2.ofKind('stage').filter((e) => e.data.status === 'start').map((e) => e.stage);
      assert.ok(!started.includes('understand') && !started.includes('plan'));
      if (unit !== 'act') assert.equal(started[0], unit === 'evaluate' ? 'synthesize' : 'reflect');
    }
  }
});

test('이어하기: 단위 도중 취소되면 그 단위를 처음부터 다시 한다', async () => {
  const cfg = cfgOf();
  const full = await fullRun(cfg);
  const firstTool = full.hooks.events.findIndex((e) => e.kind === 'tool');
  const llm1 = new FakeLLM();
  const hooks1 = new RecordingHooks({ cancelAfter: firstTool + 3 });   // ③ 자료 탐색 도중
  await assert.rejects(new ResearchAgent(PROMPT, llm1, cfg, hooks1, makeFakeTools()).run(), (e) => e instanceof RunCancelled);
  const state = hooks1.checkpoints.at(-1);
  assert.equal(state.done, 'plan');
  const llm2 = new FakeLLM();
  const r = await ResearchAgent.fromState(PROMPT, llm2, cfg, new RecordingHooks(), state, makeFakeTools()).run();
  assert.deepEqual(summaryOf(r), summaryOf(full.r));
  assert.deepEqual(llm2.usage, full.llm.usage);
});

test('이어하기: 보고서 체크포인트 뒤에는 검증만, 비용 한도 상태도 이어진다', async () => {
  const cfg = cfgOf({ max_cost_usd: 0.3 });
  const full = await fullRun(cfg);
  assert.equal(full.r.budget_hit, true);
  const { r, llm2, hooks2 } = await interruptedRun(cfg, 'report');
  assert.deepEqual(summaryOf(r), summaryOf(full.r));
  assert.equal(r.budget_hit, true);
  assert.deepEqual(llm2.calls, ['verification', 'repair', 'verification']);
  assert.equal(hooks2.ofKind('budget').length, 0);
  await assert.rejects(async () => ResearchAgent.fromState(PROMPT, new FakeLLM(), cfg, null, { version: 9 }), LLMError);
});

test('보고서 다시 쓰기: 언어·분량·추가 요청을 프롬프트에 넣고 ⑦⑧만 실행', async () => {
  const { r: prev } = await fullRun(cfgOf());
  const llm = new FakeLLM();
  const prompts = [];
  const orig = llm.text.bind(llm);
  llm.text = (s, p, o) => { prompts.push(p); return orig(s, p, o); };
  const hooks = new RecordingHooks();
  const r = await ResearchAgent.rewriteReport(prev, llm, cfgOf(), hooks, { language: 'en', length: 'short', extra: '표를 더 많이 넣어 주세요' });
  assert.deepEqual(llm.calls, ['report', 'verification', 'repair', 'verification']);
  assert.ok(prompts[0].includes('in language "en"'));
  assert.ok(prompts[0].includes('about 1,500-2,500 words'));
  assert.ok(prompts[0].includes('표를 더 많이 넣어 주세요'));
  assert.equal(r.lang, 'en');
  assert.equal(r.sources.length, prev.sources.length);
  assert.deepEqual(r.sources.map((s) => s.included), prev.sources.map((s) => s.included));
  assert.deepEqual(r.plan, prev.plan);
  assert.equal(r.counts.merged, prev.counts.merged);
  assert.ok(r.verification.checks.length);
  assert.deepEqual([...new Set(hooks.ofKind('stage').map((e) => e.stage))], ['report', 'verify']);
  // 표준 분량은 원본 프롬프트 그대로
  const llm2 = new FakeLLM();
  const p2 = [];
  const o2 = llm2.text.bind(llm2);
  llm2.text = (s, p, o) => { p2.push(p); return o2(s, p, o); };
  await ResearchAgent.rewriteReport(prev, llm2, cfgOf(), new RecordingHooks(), {});
  assert.ok(p2[0].trimEnd().endsWith('8. Limitations of this brief — evidence quality, coverage, abstract-only analysis.'));
});

test('보고서 다시 쓰기·후속 질문: 샘플 result.json(구버전 형식)으로도 동작', async () => {
  for (const id of ['sample_genai_graduate_research', 'sample_roll_sensor_fabrication']) {
    const prev = JSON.parse(await readFile(new URL(`../data/samples/${id}/result.json`, import.meta.url), 'utf8'));
    const r = await ResearchAgent.rewriteReport(prev, new FakeLLM(), cfgOf(), new RecordingHooks(), { length: 'detailed' });
    assert.equal(r.sources.length, prev.sources.length, id);
    assert.equal(r.counts.included, prev.sources.filter((s) => s.included).length, id);
    assert.ok(r.report_markdown.includes('## 8.'));
    assert.ok(citedIds(r.report_markdown).length);
    assert.equal(r.year_from, prev.meta?.year_from ?? null);
    const ev = retrieve(prev, prev.plan.sub_questions[0].question);
    assert.equal(ev.length, 8);
    assert.ok(ev.every((s) => s.included));
    const ans = await answerQuestion(new FakeLLM(), prev, '가장 강한 근거는 무엇인가요?', [{ question: '이전', answer_markdown: '답' }]);
    assert.ok(ans.answer_markdown.length);
    assert.equal(ans.sources.length, 1);
    assert.ok(prev.sources.some((s) => s.sid === ans.sources[0]));
  }
});

test('후속 질문: 프롬프트 구성과 없는 인용 제거', async () => {
  const result = { topic: 'T', lang: 'en', plan: { sub_questions: [{ id: 'Q1', question: 'q1?' }] },
    syntheses: { Q1: { answer: 'A1 [S1]', sources: ['S1'] } },
    sources: [{ sid: 'S1', included: true, title: 'writing productivity', abstract: 'llm', score: 0.5, authors: ['A', 'B'], year: 2024 },
      { sid: 'S2', included: false, title: 'x' }] };
  let seen = null;
  const llm = { async text(system, prompt, opts) { seen = { system, prompt, opts }; return 'Answer [S1] and [S7].'; } };
  const out = await answerQuestion(llm, result, 'writing productivity?');
  assert.deepEqual(out, { answer_markdown: 'Answer [S1] and [S7].', sources: ['S1'] });
  assert.ok(seen.prompt.includes('[S1] A et al. (2024)'));
  assert.ok(seen.prompt.includes('Q1. q1?\nA1 [S1]'));
  assert.ok(seen.prompt.includes('Write the answer in language "en"'));
  assert.deepEqual(seen.opts, { effort: 'medium', maxTokens: 8000 });
  assert.deepEqual(retrieve({ sources: [] }, 'x'), []);
});

test('주제 다듬기: 제안 정확히 3개, 질문 0~3개, 실패하면 LLMError', async () => {
  const out = await refinePrompt(new FakeLLM(), '생성형 AI와 대학원생', 'ko');
  assert.equal(out.suggestions.length, 3);
  assert.ok(out.suggestions.every((s) => s.prompt && s.focus && s.why));
  assert.ok(out.questions.length <= 3);
  let seen = null;
  const llm = { async json(system, prompt, schema, opts) { seen = { prompt, schema, opts }; return { suggestions: [{ prompt: 'a', focus: 'f', why: 'w' }], questions: [] }; } };
  await assert.rejects(refinePrompt(llm, 'draft', 'en'), (e) => e instanceof LLMError);
  assert.deepEqual(seen.opts, { effort: 'low', maxTokens: 4000 });
  assert.equal(seen.schema, REFINE_SCHEMA);
  assert.ok(seen.prompt.includes('exactly 3') && seen.prompt.includes('language "en"'));
  await assert.rejects(refinePrompt(llm, '   '), (e) => e instanceof LLMError && e.code === 'bad_request');
});

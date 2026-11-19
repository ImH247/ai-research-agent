// engine/pipeline.js: FakeLLM·가짜 도구로 8단계 전체 실행 (원본 tests/test_pipeline.py 이식 + 웹 버전 새 기능)
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMError, RunCancelled } from '../assets/js/engine/llm.js';
import { RunConfig } from '../assets/js/engine/models.js';
import { STAGE_NAMES, ResearchAgent, CITE, citedIds, mapLimit } from '../assets/js/engine/pipeline.js';
import { FakeLLM, RecordingHooks, makeFakeTools, WEB_REPORT_URL, WEB_CITED_TEXT } from './fakes.js';

const BASE = { min_subq: 4, max_subq: 6, max_reflection_rounds: 2, max_tool_steps: 3, results_per_search: 6,
  verify_sample: 10, parallelism: 1 };
const cfgOf = (over = {}) => new RunConfig({ ...BASE, ...over });
const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향';

async function runAgent({ cfg = cfgOf(), llm = null, hooks = null, tools = null, prompt = PROMPT } = {}) {
  hooks = hooks || new RecordingHooks();
  tools = tools || makeFakeTools();
  llm = llm || new FakeLLM();
  const agent = new ResearchAgent(prompt, llm, cfg, hooks, tools);
  const r = await agent.run();
  return { agent, r, hooks, tools, llm };
}

/** toolTurn에 넘어간 도구 이름·메시지를 기록한다 */
function spyToolTurns(llm) {
  const seen = [];
  const orig = llm.toolTurn.bind(llm);
  llm.toolTurn = async (system, messages, tools, opts) => {
    seen.push({ tools: tools.map((t) => t.name), messages: JSON.parse(JSON.stringify(messages)) });
    return orig(system, messages, tools, opts);
  };
  return seen;
}

function checkResult(r, hooks) {
  const types = { prompt: 'string', topic: 'string', lang: 'string', report_markdown: 'string', year_from_source: 'string', year_from_reason: 'string' };
  for (const [k, t] of Object.entries(types)) assert.equal(typeof r[k], t, k);
  for (const k of ['understanding', 'plan', 'syntheses', 'verification', 'stats', 'counts']) assert.equal(typeof r[k], 'object', k);
  for (const k of ['reflections', 'sources', 'disabled_tools']) assert.ok(Array.isArray(r[k]), k);
  assert.ok('year_from' in r);
  assert.equal(r.topic, '생성형 AI와 대학원생 연구 생산성');   // core_topic
  assert.deepEqual(Object.keys(r.counts).sort(), ['collected', 'included', 'merged', 'report_evidence', 'sub_questions']);
  for (const k of ['total_collected', 'included', 'duplicates_merged', 'by_kind', 'by_study_type', 'by_direction', 'by_year', 'year_range', 'per_subq']) {
    assert.ok(k in r.stats, k);
  }
  assert.ok('budget_cap_usd' in r && 'budget_hit' in r);
  JSON.stringify(r);
  // 수집 문헌 전부, S 번호순, 계산된 플래그 포함
  const sids = r.sources.map((s) => s.sid);
  assert.deepEqual(sids, sids.map((_, i) => `S${i + 1}`));
  assert.equal(sids.length, r.counts.collected);
  for (const s of r.sources) {
    for (const k of ['included', 'in_report', 'cited']) assert.equal(typeof s[k], 'boolean');
    assert.ok(Array.isArray(s.queries) && Array.isArray(s.subqs));
  }
  assert.equal(r.sources.filter((s) => s.included).length, r.counts.included);
  assert.equal(r.sources.filter((s) => s.in_report).length, r.counts.report_evidence);
  assert.ok(r.sources.some((s) => s.cited));
  // 본문에 인용된 ID는 모두 실재하고, 지어낸 ID는 제거됨
  const cited = new Set(citedIds(r.report_markdown));
  assert.ok(cited.size);
  for (const c of cited) assert.ok(sids.includes(c), c);
  assert.ok(!r.report_markdown.includes('S9999'));
  const v = r.verification;
  assert.deepEqual(v.unknown_ids, ['S9999']);
  assert.ok(v.checks.length);
  assert.ok(v.checks.some((c) => 'revised' in c && c.verdict_after === 'supported'));
  for (const c of v.checks) {
    assert.ok(!('span' in c));
    assert.ok(['supported', 'partially supported', 'not in source text', 'contradicted'].includes(c.verdict));
  }
  r.reflections.forEach((ref, i) => { assert.equal(ref.round, i + 1); assert.equal(typeof ref.final, 'boolean'); });
  // 8단계 전부 시작 이벤트
  const started = new Set(hooks.ofKind('stage').filter((e) => e.data.status === 'start').map((e) => e.stage));
  assert.deepEqual([...started].sort(), Object.keys(STAGE_NAMES).sort());
  assert.ok(hooks.deltas.length);
  assert.equal((hooks.deltas.join('').match(/\[S9999\]/g) || []).length, 1);   // 스트리밍된 원문에는 아직 있음
  assert.ok(hooks.progressCalls.some((p) => p[0] === 'act' && p[1] === p[2]));
}

test('순차 실행: 결과 형식·이벤트 문구', async () => {
  const { r, hooks } = await runAgent();
  checkResult(r, hooks);
  const msgs = hooks.events.map((e) => e.msg);
  assert.ok(msgs.some((m) => /^Q1 · search_openalex\('.+'\) → \d+건 \(누적 \d+\)$/.test(m)));
  assert.ok(msgs.some((m) => /^평가 \d+건 → 채택\(관련성≥2\) 누적 \d+건 \/ 전체 \d+건 \(중복 판본 병합 누적 \d+건\)$/.test(m)));
  assert.ok(msgs.some((m) => m.startsWith('라운드 1: 품질 ')));
  assert.equal(r.budget_hit, false);
  assert.equal(r.budget_cap_usd, null);
});

test('병렬 실행(3)도 같은 결과', async () => {
  const { r: r1 } = await runAgent();
  const { r: r3, hooks } = await runAgent({ cfg: cfgOf({ parallelism: 3 }) });
  checkResult(r3, hooks);
  for (const k of ['collected', 'merged', 'sub_questions']) assert.equal(r1.counts[k], r3.counts[k], k);
  assert.deepEqual(Object.keys(r1.syntheses), Object.keys(r3.syntheses));
  assert.deepEqual(r1.sources.map((s) => s.title).sort(), r3.sources.map((s) => s.title).sort());
});

test('웹 검색 서버 도구: 블록을 읽어 문헌·이벤트로, 인용 원문을 초록에, 학술 판본과 병합', async () => {
  const llm = new FakeLLM({ webSearch: true });
  const seen = spyToolTurns(llm);
  const { r, hooks } = await runAgent({ llm });
  checkResult(r, hooks);
  assert.ok(seen[0].tools.includes('web_search'));
  const webEvents = hooks.ofKind('tool').filter((e) => e.data.tool === 'web_search');
  assert.ok(webEvents.length >= 4);
  assert.match(webEvents[0].msg, /^Q1 · web_search\('generative AI writing productivity graduate students'\) → 4건 \(누적 \d+\)$/);
  assert.equal(webEvents[0].data.count, 4);
  const noy = r.sources.filter((s) => s.title.startsWith('Experimental evidence on the productivity'));
  assert.equal(noy.length, 1);                       // 웹 사본 3개가 학술 판본 하나로
  assert.equal(noy[0].kind, 'peer-reviewed');
  const report = r.sources.find((s) => s.url === WEB_REPORT_URL);
  assert.equal(report.kind, 'web');
  assert.equal(report.origin, 'WebSearch');
  assert.equal(report.year, 2025);                   // page_age에서 연도
  assert.equal(report.venue, 'example.kr');
  assert.equal(report.abstract, WEB_CITED_TEXT);     // 같은 인용이 여러 번 와도 한 번만
  assert.equal(r.sources.filter((s) => s.title === 'Large language models and doctoral writing quality').length, 1);
  assert.ok(r.counts.merged > 0);
  // 서버 도구 블록에는 tool_result를 보내지 않는다: 두 번째 턴의 tool_result는 tool_use 수와 같다
  const second = seen[1].messages;
  const assistant = second[1].content;
  assert.ok(assistant.some((b) => b.type === 'server_tool_use') && assistant.some((b) => b.type === 'web_search_tool_result'));
  const results = second[2].content;
  assert.equal(results.length, assistant.filter((b) => b.type === 'tool_use').length);
  assert.ok(results.every((x) => x.type === 'tool_result' && x.tool_use_id.startsWith('toolu_')));
});

test('pause_turn: content를 덧붙이고 같은 루프를 계속한다', async () => {
  const llm = new FakeLLM({ webSearch: true, pauseTurn: true });
  const seen = spyToolTurns(llm);
  const { r, hooks } = await runAgent({ llm });
  checkResult(r, hooks);
  // Q1의 두 번째 턴: [user, assistant(일시 정지된 server_tool_use…)] — "Continue" 같은 사용자 메시지를 넣지 않는다
  const t2 = seen[1].messages;
  assert.deepEqual(t2.map((m) => m.role), ['user', 'assistant']);
  assert.ok(t2[1].content.some((b) => b.type === 'server_tool_use'));
  assert.ok(r.sources.some((s) => s.url === WEB_REPORT_URL && s.abstract === WEB_CITED_TEXT));   // 다음 턴의 인용도 반영
  const q1Done = hooks.ofKind('subq_done').find((e) => e.data.subq === 'Q1');
  assert.match(q1Done.data.summary, /충분한 자료/);
});

test('웹 검색 오류 객체: tool_error, 연속 3회면 한 번만 끄고 다음 탐색부터 빼기', async () => {
  const llm = new FakeLLM({ webSearch: 'error' });
  const seen = spyToolTurns(llm);
  const { r, hooks } = await runAgent({ llm });
  const errs = hooks.ofKind('tool_error').filter((e) => e.data.tool === 'web_search');
  assert.equal(errs.length, 3);
  assert.equal(errs[0].data.error, 'too_many_requests');
  const disabled = hooks.ofKind('tool_disabled').filter((e) => e.data.tool === 'web_search');
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].msg, 'web_search 연속 3회 실패 → 이번 실행에서 제외');
  assert.ok(r.disabled_tools.includes('web_search'));
  assert.ok(!seen[seen.length - 1].tools.includes('web_search'));
});

test('API가 웹 검색 도구를 거부하면 그 턴을 웹 검색 없이 다시 보내고 경고 한 번', async () => {
  for (const p of [1, 3]) {
    const llm = new FakeLLM({ webSearch: true, rejectWebSearch: true });
    const seen = spyToolTurns(llm);
    const { r, hooks } = await runAgent({ llm, cfg: cfgOf({ parallelism: p }) });
    const warn = hooks.ofKind('warning').filter((e) => e.msg === '웹 검색 도구를 쓸 수 없어 학술 DB만으로 조사합니다.');
    assert.equal(warn.length, 1, `parallelism ${p}`);
    assert.ok(r.disabled_tools.includes('web_search'));
    assert.ok(r.counts.collected > 0);
    assert.ok(!seen[seen.length - 1].tools.includes('web_search'));
    assert.ok(!r.plan.sub_questions[r.plan.sub_questions.length - 1].preferred_tools.includes('web_search'));
  }
});

test('web_search 설정이 꺼져 있으면 도구 목록·계획 enum에 없다', async () => {
  const llm = new FakeLLM({ webSearch: true });
  const seen = spyToolTurns(llm);
  const schemas = [];
  const orig = llm.json.bind(llm);
  llm.json = (s, p, schema, o) => { schemas.push(schema); return orig(s, p, schema, o); };
  await runAgent({ llm, cfg: cfgOf({ web_search: false }) });
  assert.ok(seen.every((x) => !x.tools.includes('web_search')));
  const plan = schemas.find((x) => 'sub_questions' in x.properties);
  assert.deepEqual(plan.properties.sub_questions.items.properties.preferred_tools.items.enum,
    ['search_openalex', 'search_semantic_scholar', 'search_europe_pmc']);
});

test('비용 한도: 닿으면 경고 한 번, 새 검색·재조사 없이 보고서까지', async () => {
  const full = await runAgent({ llm: new FakeLLM({ costPerCall: 0.05 }) });
  const llm = new FakeLLM({ costPerCall: 0.05 });
  const { r, hooks } = await runAgent({ llm, cfg: cfgOf({ max_cost_usd: 0.2 }) });
  const b = hooks.ofKind('budget');
  assert.equal(b.length, 1);
  assert.equal(b[0].msg, '비용 한도($0.2)에 도달했습니다: 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.');
  assert.deepEqual(Object.keys(b[0].data), ['cap', 'cost']);
  assert.equal(r.budget_hit, true);
  assert.equal(r.budget_cap_usd, 0.2);
  assert.equal(hooks.ofKind('reflection').length, 0);
  assert.ok(llm.calls.filter((c) => c === 'tool').length < full.llm.calls.filter((c) => c === 'tool').length);
  assert.ok(r.report_markdown.includes('## 1.'));
  assert.ok(llm.calls.includes('evaluation') && llm.calls.includes('synthesis') && llm.calls.includes('verification'));
  assert.equal(hooks.ofKind('subq_done').length, 4);
});

test('재조사: 새 하위 질문 추가와 최종 점검', async () => {
  const { r, hooks } = await runAgent({ llm: new FakeLLM({ continueRounds: 2 }) });
  assert.equal(r.counts.sub_questions, 5);
  assert.equal(r.plan.sub_questions[4].id, 'Q5');
  assert.ok('Q5' in r.syntheses);
  assert.ok(hooks.ofKind('replan').some((e) => e.msg.startsWith('새 하위 질문 추가 Q5: ')));
  assert.deepEqual(r.reflections.map((x) => x.round), [1, 2, 3]);
  assert.deepEqual(r.reflections.map((x) => x.final), [false, false, true]);
  assert.equal(r.reflections[2].should_continue, false);
  assert.ok(hooks.ofKind('reflection').at(-1).msg.startsWith('최종 점검: 품질 '));
  assert.deepEqual([...new Set(hooks.ofKind('stage').map((e) => e.data.round))].sort(), [1, 2, 3]);
});

test('비평이 멈추면 최종 점검 없음', async () => {
  const { r } = await runAgent({ llm: new FakeLLM({ continueRounds: 0 }) });
  assert.equal(r.reflections.length, 1);
  assert.equal(r.reflections[0].final, false);
  assert.equal(r.counts.sub_questions, 4);
});

test('검색 기간: 에이전트 결정 / 0 = 제한 없음 / 사용자 값 우선', async () => {
  let { r, tools } = await runAgent();
  assert.deepEqual([r.year_from, r.year_from_source], [2022, 'agent']);
  assert.ok(tools.search_openalex.calls.every((c) => c.yearFrom === 2022));
  let hooks;
  ({ r, hooks, tools } = await runAgent({ cfg: cfgOf({ year_from: 0 }) }));
  assert.equal(r.year_from, null);
  assert.equal(r.year_from_source, 'user');
  assert.ok(tools.search_openalex.calls.every((c) => c.yearFrom === null));
  assert.ok(hooks.ofKind('window')[0].msg.includes('제한 없음'));
  ({ r, tools } = await runAgent({ cfg: cfgOf({ year_from: 2019, openalex_email: 'a@b.c', results_per_search: 5 }) }));
  assert.deepEqual([r.year_from, r.year_from_source], [2019, 'user']);
  const calls = tools.search_openalex.calls.filter((c) => c.tool === 'search_openalex');
  assert.ok(calls.length);
  assert.ok(calls.every((c) => c.limit === 5 && c.yearFrom === 2019 && c.email === 'a@b.c'));
});

const reviewCfg = () => cfgOf({ human_in_the_loop: true, max_reflection_rounds: 0 });
const actions = (hooks) => hooks.ofKind('plan_review').map((e) => e.data.action);

test('계획 검토: 승인', async () => {
  const { r, hooks } = await runAgent({ cfg: reviewCfg(), hooks: new RecordingHooks({ planDecisions: [{ action: 'approve' }] }) });
  assert.deepEqual(actions(hooks), ['waiting', 'approve']);
  assert.equal(hooks.reviewedPlans.length, 1);
  assert.equal(r.counts.sub_questions, 4);
});

test('계획 검토: 재계획 후 승인', async () => {
  const hooks = new RecordingHooks({ planDecisions: [{ action: 'revise', feedback: '한국 사례를 더 넣어 주세요' }, { action: 'approve' }] });
  const { r } = await runAgent({ cfg: reviewCfg(), hooks });
  assert.deepEqual(actions(hooks), ['waiting', 'revise', 'waiting', 'approve']);
  assert.deepEqual(hooks.ofKind('plan').map((p) => p.data.revised), [false, true]);
  assert.ok(r.plan.sub_questions[0].question.startsWith('(수정)'));
});

test('계획 검토: 하위 질문 직접 수정 / 잘못된 수정은 원래 계획 유지', async () => {
  const edited = [{ id: 'Q9', question: '생성형 AI 사용 빈도는?', search_queries: ['generative AI usage frequency'] }, '대학원생의 AI 윤리 인식은?'];
  let hooks = new RecordingHooks({ planDecisions: [{ action: 'approve', sub_questions: edited }] });
  let { r } = await runAgent({ cfg: reviewCfg(), hooks });
  const sqs = r.plan.sub_questions;
  assert.deepEqual(sqs.map((q) => q.id), ['Q1', 'Q2']);
  assert.equal(sqs[1].perspective, 'user-added');
  assert.deepEqual(sqs[1].search_queries, []);
  assert.deepEqual(sqs[1].preferred_tools, ['search_openalex', 'search_semantic_scholar', 'search_europe_pmc', 'web_search']);
  assert.ok(actions(hooks).includes('edit'));
  assert.deepEqual(Object.keys(r.syntheses).sort(), ['Q1', 'Q2']);
  hooks = new RecordingHooks({ planDecisions: [{ action: 'approve', sub_questions: Array(9).fill('q') }] });
  ({ r } = await runAgent({ cfg: reviewCfg(), hooks }));
  assert.equal(r.counts.sub_questions, 4);
});

test('취소 (순차·병렬)', async () => {
  for (const p of [1, 3]) {
    await assert.rejects(runAgent({ cfg: cfgOf({ parallelism: p }), hooks: new RecordingHooks({ cancelAfter: 15 }) }),
      (e) => e instanceof RunCancelled, `parallelism ${p}`);
  }
  // 보고서 스트리밍 도중의 취소
  const hooks = new RecordingHooks();
  const orig = hooks.reportDelta.bind(hooks);
  hooks.reportDelta = (t) => { orig(t); hooks.cancelAfter = 0; };
  await assert.rejects(runAgent({ cfg: cfgOf({ max_reflection_rounds: 0 }), hooks }), (e) => e instanceof RunCancelled);
  assert.ok(hooks.deltas.length < 5);
});

test('수집 0건이어도 끝까지 진행', async () => {
  const { r } = await runAgent({ tools: makeFakeTools({ fail: [], empty: true }) });
  assert.equal(r.counts.collected, 0);
  assert.deepEqual(r.sources, []);
  assert.ok(Object.values(r.syntheses).every((v) => v.evidence_strength === 'insufficient'));
  assert.ok(!r.report_markdown.includes('S9999'));
  assert.deepEqual(r.verification.checks, []);
});

test('보고서 거절은 refusal 오류', async () => {
  await assert.rejects(runAgent({ llm: new FakeLLM({ refuseReport: true }) }), (e) => e instanceof LLMError && e.code === 'refusal');
});

test('연속 실패한 도구는 한 번만 제외 (순차면 정확히 3번 시도)', async () => {
  for (const p of [1, 3]) {
    const { r, hooks, tools } = await runAgent({ cfg: cfgOf({ parallelism: p }) });
    const disabled = hooks.ofKind('tool_disabled');
    assert.equal(disabled.length, 1);
    assert.deepEqual(disabled[0].data, { tool: 'search_semantic_scholar' });
    assert.equal(disabled[0].msg, 'search_semantic_scholar 연속 3회 실패 → 이번 실행에서 제외');
    assert.deepEqual(r.disabled_tools, ['search_semantic_scholar']);
    if (p === 1) assert.equal(tools.search_openalex.calls.filter((c) => c.tool === 'search_semantic_scholar').length, 3);
  }
});

test('B2: 주제 이해의 변수 항목도 보고서 언어로 요청', async () => {
  const llm = new FakeLLM();
  const prompts = [];
  const orig = llm.json.bind(llm);
  llm.json = (s, p, schema, o) => { prompts.push(p); return orig(s, p, schema, o); };
  await runAgent({ llm });
  const sentence = prompts[0].split('Write discipline')[1].split('\n- ')[0];
  for (const k of ['independent_variables', 'dependent_variables', 'moderators_or_context']) {
    assert.ok(sentence.split(' in the language')[0].split(' in language')[0].includes(k), k);
  }
  assert.ok(prompts[0].includes('Keep topic_en and the English terms/synonyms of key_concepts in English'));
});

test('B3: 검색어 없는 사용자 하위 질문은 실제로 찾은 검색어로 근거 검색', async () => {
  const edited = [{ question: '생성형 AI 사용 빈도는?', search_queries: ['generative AI usage frequency'] }, '대학원생의 AI 윤리 인식은?'];
  const hooks = new RecordingHooks({ planDecisions: [{ action: 'approve', sub_questions: edited }] });
  const { agent } = await runAgent({ cfg: reviewCfg(), hooks });
  const [q1, q2] = agent.plan.sub_questions;
  const expected = [...new Set(agent.store.sources().filter((s) => s.subqs.has('Q2')).flatMap((s) => [...s.queries].sort()))].slice(0, 8);
  assert.ok(expected.length);
  agent.retrieve(q2);
  assert.ok(agent._lastRetrieveQuery.includes('generative AI research productivity'));
  assert.equal(agent._lastRetrieveQuery, q2.question + ' ' + expected.join(' '));
  agent.retrieve(q1);
  assert.equal(agent._lastRetrieveQuery, q1.question + ' generative AI usage frequency');
});

test('B4: 근거 없음 문구는 보고서 언어를 따른다', async () => {
  for (const [lang, answer] of [['en', 'No evidence found.'], ['ko', '근거 없음']]) {
    const { r } = await runAgent({ cfg: cfgOf({ language: lang }), tools: makeFakeTools({ fail: [], empty: true }) });
    assert.ok(Object.values(r.syntheses).every((v) => v.answer === answer), lang);
    if (lang === 'en') assert.ok(!JSON.stringify(r.syntheses).includes('관련 문헌을 찾지 못함'));
  }
});

test('B5: 빈 재계획 의견은 다시 묻고, 한도를 넘으면 현재 계획으로', async () => {
  let hooks = new RecordingHooks({ planDecisions: [{ action: 'revise', feedback: '  ' }, { action: 'approve' }] });
  await runAgent({ cfg: reviewCfg(), hooks });
  assert.deepEqual(actions(hooks), ['waiting', 'waiting', 'approve']);
  let warnings = hooks.ofKind('warning').filter((e) => e.stage === 'plan').map((e) => e.msg);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('한도'));
  assert.equal(hooks.reviewedPlans.length, 2);
  hooks = new RecordingHooks({ planDecisions: Array(10).fill({ action: 'revise', feedback: '' }) });
  await runAgent({ cfg: reviewCfg(), hooks });
  assert.equal(hooks.reviewedPlans.length, 6);
  warnings = hooks.ofKind('warning').filter((e) => e.stage === 'plan').map((e) => e.msg);
  assert.equal(warnings.filter((w) => w.includes('한도')).length, 1);
  assert.ok(warnings.at(-1).includes('한도'));
});

test('B6: 병렬 작업 하나가 실패하면 나머지는 다음 checkpoint에서 멈추고 원래 오류가 전파된다', async () => {
  const agent = new ResearchAgent('x', new FakeLLM(), cfgOf({ parallelism: 3 }), new RecordingHooks(), makeFakeTools());
  const steps = [];
  const fn = async (i) => {
    if (i === 2) {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('boom');
    }
    for (let k = 0; k < 100; k++) {
      await agent._checkpoint();
      steps.push(i);
      await new Promise((r) => setTimeout(r, 5));
    }
    return i;
  };
  await assert.rejects(agent._map(fn, [0, 1, 2], 'synthesize', 't'), /^Error: boom$/);
  assert.ok(steps.length < 60, String(steps.length));
  assert.equal(agent._abort, false);
  assert.deepEqual(await agent._map(async (x) => x * 2, [1, 2, 3], 'synthesize', 't'), [2, 4, 6]);
  // mapLimit: 입력 순서대로, 동시 실행 수 제한
  let running = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2], 2, async (x) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, x));
    running--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});

test('B7: 보고서 스트림이 연결 끊김으로 끊기면 처음부터 다시 쓴다(최대 2번)', async () => {
  class FlakyLLM extends FakeLLM {
    constructor(failures, exc) { super(); this.failures = failures; this.exc = exc; this.reportCalls = 0; }
    async text(system, prompt, opts = {}) {
      this.reportCalls += 1;
      if (this.reportCalls <= this.failures) {
        if (opts.onDelta) opts.onDelta('앞부분 ');
        throw this.exc;
      }
      return super.text(system, prompt, opts);
    }
  }
  let llm = new FlakyLLM(1, new TypeError('network error'));
  const { r, hooks } = await runAgent({ llm });
  assert.equal(llm.reportCalls, 2);
  assert.ok(r.report_markdown);
  const warn = hooks.ofKind('warning').filter((e) => e.stage === 'report');
  assert.equal(warn.length, 1);
  assert.ok(warn[0].msg.includes('다시 작성'));
  const starts = hooks.ofKind('stage').filter((e) => e.stage === 'report' && e.data.status === 'start');
  assert.equal(starts.length, 2);
  const pos = (ev) => hooks.events.indexOf(ev);
  assert.ok(pos(starts[0]) < pos(warn[0]) && pos(warn[0]) < pos(starts[1]));
  llm = new FlakyLLM(5, new TypeError('Failed to fetch'));
  await assert.rejects(runAgent({ llm }), /Failed to fetch/);
  assert.equal(llm.reportCalls, 3);
  for (const exc of [new LLMError('refusal', 'x'), new LLMError('auth', 'x'), new RangeError('bug'), new RunCancelled()]) {
    llm = new FlakyLLM(1, exc);
    await assert.rejects(runAgent({ llm }), (e) => e === exc);
    assert.equal(llm.reportCalls, 1);
  }
});

test('주장 단위 나누기 (_claimSpans)', () => {
  const spans = (text) => ResearchAgent._claimSpans(text).map(([a, b]) => text.slice(a, b));
  const row = '| 개념 | 정의 [S1]. 둘째 문장 [S2]. | 측정 [S3] |';
  assert.deepEqual(spans('머리말\n' + row), [row]);
  assert.deepEqual(spans('- 품질도 향상되었다. [S1]. 다음 문장이다 [S2].'), ['- 품질도 향상되었다. [S1].', '다음 문장이다 [S2].']);
  assert.deepEqual(spans('Noy et al. found large gains [S3]. Others found none [S4].'), ['Noy et al. found large gains [S3].', 'Others found none [S4].']);
  assert.deepEqual(spans('## 제목\n인용 없는 문장.'), []);
  assert.ok(CITE.test('[S1, S22]'));
  assert.deepEqual(citedIds('a [S2] b [S1, S2] [S3x]'), ['S2', 'S1']);
});

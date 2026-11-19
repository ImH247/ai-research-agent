// 통합 테스트: 엔진 + 브라우저 백엔드 + 결과물(텍스트·Office)을 한 줄로 이어서 확인한다 (네트워크·API 키 없음).
// 1) FakeLLM(웹 검색 켬, 병렬 3, 계획 검토)으로 createRun → 폴링 → 모든 형식 exportFile + zip
//    + 결과·스냅샷·이벤트가 PYTHON_SPEC 3.2·3.3·3.4 계약을 지키는지, 저장소·결과물에 API 키가 없는지
// 2) 비용 한도 실행: budget 이벤트와 결과의 budget 필드
// 3) 데모 재생 → 모든 형식
// 4) 조사 파일 저장 → 다른 저장소의 새 백엔드에서 열기 → 모든 형식 다시 내보내기
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import JSZip from '../vendor/jszip.js';
import { createBackend } from '../assets/js/engine/backend.js';
import { MemoryStorage, STORES } from '../assets/js/engine/storage.js';
import { FORMAT_IDS } from '../assets/js/export/index.js';
import { FakeLLM, makeFakeTools, WEB_REPORT_URL } from './fakes.js';

const KEY = 'sk-ant-api03-INTEGRATIONSECRET_key-998877';
const PROMPT = '생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향';
const SAMPLE = 'sample_genai_graduate_research';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadSample = (p) => readFile(new URL(`../data/samples/${p}`, import.meta.url), 'utf8');
const ACTIVE = ['queued', 'running', 'awaiting_plan'];

// ── 계약 (PYTHON_SPEC 3.2 · 3.3 · 3.4 + 웹 버전 추가 키) ──
const RESULT_KEYS = ['schema_version', 'id', 'prompt', 'topic', 'lang', 'meta', 'understanding', 'plan', 'syntheses', 'reflections',
  'report_markdown', 'verification', 'stats', 'sources', 'trace', 'budget_cap_usd', 'budget_hit'];
const META_KEYS = ['model', 'model_label', 'created_at', 'finished_at', 'elapsed_s', 'year_from', 'year_from_source', 'year_from_reason',
  'config', 'usage', 'counts', 'disabled_tools', 'app_version', 'sample', 'demo', 'note', 'budget_cap_usd', 'budget_hit'];
const USAGE_KEYS = ['calls', 'input_tokens', 'output_tokens', 'cost_usd'];
const COUNT_KEYS = ['collected', 'included', 'merged', 'report_evidence', 'sub_questions'];
const VERIFY_KEYS = ['cited_ids', 'unknown_ids', 'claims_total', 'checks'];
const STATS_KEYS = ['total_collected', 'included', 'duplicates_merged', 'by_kind', 'by_study_type', 'by_direction', 'by_year',
  'year_range', 'per_subq'];
const SOURCE_KEYS = ['sid', 'title', 'authors', 'year', 'venue', 'abstract', 'url', 'doi', 'citations', 'origin', 'kind', 'queries',
  'subqs', 'evaluated', 'relevance', 'credibility', 'score', 'study_type', 'method', 'sample', 'key_finding', 'direction',
  'limitation', 'included', 'in_report', 'cited'];
const SUBQ_KEYS = ['id', 'question', 'perspective', 'rationale', 'search_queries', 'preferred_tools'];
const SNAP_KEYS = ['id', 'status', 'prompt', 'topic', 'model', 'model_label', 'config', 'created_at', 'started_at', 'finished_at',
  'elapsed_s', 'stage', 'round', 'progress', 'counts', 'usage', 'plan', 'awaiting', 'error', 'formats', 'exports', 'has_result',
  'sample', 'demo', 'note', 'resumable', 'parent_id', 'imported', 'custom_title'];
const SUMMARY_KEYS = ['id', 'topic', 'prompt', 'model', 'model_label', 'status', 'stage', 'created_at', 'elapsed_s', 'counts', 'usage',
  'sample', 'demo', 'note'];
const STAGES = new Set(['understand', 'plan', 'act', 'evaluate', 'synthesize', 'reflect', 'report', 'verify', 'export', 'system']);
const EVENT_DATA = {
  stage: [['status', 'round']],
  understanding: [['topic', 'discipline', 'research_type', 'concepts', 'requirements']],
  window: [['year_from', 'source', 'reason']],
  plan: [['sub_questions', 'revised']],
  plan_review: [['action']],
  tool: [['subq', 'tool', 'query', 'count', 'total']],
  tool_error: [['subq', 'tool', 'query', 'error']],
  tool_disabled: [['tool']],
  subq_done: [['subq', 'found', 'summary']],
  evaluate: [['evaluated', 'included', 'total', 'merged']],
  synthesis: [['subq', 'n', 'strength']],
  reflection: [['round', 'final', 'quality_score', 'should_continue', 'reason', 'bias_risks']],
  replan: [['subq', 'question'], ['queries']],
  report: [['evidence', 'used'], ['chars']],
  verify: [['cited_ids', 'unknown', 'checked', 'supported']],
  repair: [['bad', 'fixed', 'supported_after', 'checked']],
  export: [['fmt', 'ok', 'error']],
  budget: [['cap', 'cost']],
};
const FREE_KINDS = new Set(['warning', 'error', 'log']);

function hasKeys(obj, keys, where) {
  assert.ok(obj && typeof obj === 'object', `${where}: 객체가 아님`);
  const missing = keys.filter((k) => !Object.hasOwn(obj, k));
  assert.deepEqual(missing, [], `${where}: 빠진 키 ${missing.join(', ')}`);
}

// budget = false: 샘플(노트북 변환본)에서 온 결과는 웹 버전의 budget 필드가 없다
function checkResult(res, where, { budget = true } = {}) {
  const drop = budget ? [] : ['budget_cap_usd', 'budget_hit'];
  hasKeys(res, RESULT_KEYS.filter((k) => !drop.includes(k)), where);
  assert.equal(res.schema_version, 1);
  hasKeys(res.meta, META_KEYS.filter((k) => !drop.includes(k)), `${where}.meta`);
  hasKeys(res.meta.usage, USAGE_KEYS, `${where}.meta.usage`);
  hasKeys(res.meta.counts, COUNT_KEYS, `${where}.meta.counts`);
  hasKeys(res.verification, VERIFY_KEYS, `${where}.verification`);
  hasKeys(res.stats, STATS_KEYS, `${where}.stats`);
  assert.ok(res.sources.length > 0, `${where}: sources 비어 있음`);
  res.sources.forEach((s, i) => {
    hasKeys(s, SOURCE_KEYS, `${where}.sources[${i}]`);
    assert.ok(['peer-reviewed', 'academic', 'preprint', 'web'].includes(s.kind), `kind ${s.kind}`);
  });
  // 수집 문헌 전부를 sid 번호순으로
  const nums = res.sources.map((s) => Number(s.sid.slice(1)));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  res.plan.sub_questions.forEach((q, i) => hasKeys(q, SUBQ_KEYS, `${where}.plan.sub_questions[${i}]`));
  for (const c of res.verification.checks) {
    assert.ok(['supported', 'partially supported', 'not in source text', 'contradicted'].includes(c.verdict), c.verdict);
  }
  for (const t of res.trace) hasKeys(t, ['ts', 'stage', 'kind', 'msg'], `${where}.trace`);
}

function checkEvents(events, where) {
  events.forEach((e, i) => {
    assert.equal(e.seq, i + 1, `${where}: seq ${e.seq} at ${i}`);
    hasKeys(e, ['seq', 'ts', 'stage', 'kind', 'msg', 'data'], `${where}: event ${e.seq}`);
    assert.ok(STAGES.has(e.stage), `${where}: 알 수 없는 stage ${e.stage}`);
    assert.equal(typeof e.msg, 'string');
    if (FREE_KINDS.has(e.kind)) return;
    const shapes = EVENT_DATA[e.kind];
    assert.ok(shapes, `${where}: 알 수 없는 kind ${e.kind}`);
    assert.ok(e.data && shapes.some((ks) => ks.every((k) => Object.hasOwn(e.data, k))),
      `${where}: ${e.kind} data 모양이 다름: ${JSON.stringify(e.data)}`);
  });
}

async function pollAll(b, id, onStatus = null) {
  const events = [];
  let after = 0;
  for (;;) {
    const r = await b.events(id, after, 0);
    events.push(...r.events);
    after = r.next;
    if (onStatus) await onStatus(r.status);
    if (!ACTIVE.includes(r.status.status) && !r.events.length) return [events, r.status];
    await sleep(5);
  }
}

/** 결과물 하나를 형식에 맞게 열어 본다. zip이면 안의 파일 이름 목록을 돌려준다. */
async function checkFile(file, fmt, where) {
  assert.ok(file.filename && file.mime, `${where} ${fmt}: filename/mime 없음`);
  const { data } = file;
  const text = typeof data === 'string' ? data : null;
  switch (fmt) {
    case 'md': assert.match(text, /^# /m); assert.match(text, /\[S\d+\]/); break;
    case 'html': assert.match(text, /^<!doctype html>/i); assert.doesNotMatch(text, /<script/i); break;
    case 'pdf': assert.equal(file.print, true); assert.equal(file.mime, 'text/html'); assert.match(text, /^<!doctype html>/i); break;
    case 'bib': assert.match(text, /^@\w+\{/m); break;
    case 'ris': assert.match(text, /^TY {2}- /m); assert.match(text, /^ER {2}-/m); break;
    case 'csv': assert.equal(text.charCodeAt(0), 0xfeff); assert.ok(text.split('\r\n').length > 2); break;
    case 'json': checkResult(JSON.parse(text), `${where} json`); break;
    case 'docx': case 'pptx': case 'zip': {
      assert.ok(data instanceof Uint8Array, `${where} ${fmt}: Uint8Array가 아님`);
      const zip = await JSZip.loadAsync(data);
      const names = Object.keys(zip.files);
      if (fmt === 'docx') {
        assert.ok(names.includes('word/document.xml'));
        assert.match(await zip.file('word/document.xml').async('string'), /ref_S\d+/);
      }
      if (fmt === 'pptx') {
        assert.ok(names.includes('ppt/presentation.xml'));
        assert.ok(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length >= 8);
        assert.ok(names.some((n) => n.startsWith('ppt/charts/')));
      }
      return [names, zip];
    }
    default: assert.fail(`형식 ${fmt}`);
  }
  return [null, null];
}

/** 모든 형식 + zip을 만들고 확인한다. 만든 결과물 전부(키 검사용)와 zip 안 이름을 돌려준다. */
async function exportAll(b, id, where) {
  const out = {};
  for (const fmt of FORMAT_IDS) {
    out[fmt] = await b.exportFile(id, fmt);
    await checkFile(out[fmt], fmt, where);
  }
  out.zip = await b.exportFile(id, 'zip');
  const [names, zip] = await checkFile(out.zip, 'zip', where);
  for (const ext of ['.md', '.html', '.docx', '.pptx', '.bib', '.ris', '.csv']) {
    assert.ok(names.some((n) => n.endsWith(ext)), `${where} zip에 ${ext} 없음: ${names}`);
  }
  assert.ok(names.includes('result.json') || names.some((n) => n.endsWith('.json')), `${where} zip에 json 없음`);
  return { out, names, zip };
}

/** 결과물(문자열, zip 안의 모든 텍스트 파일)에 needle이 들어 있는지 */
async function filesContain(out, needle) {
  for (const f of Object.values(out)) {
    if (typeof f.data === 'string') {
      if (f.data.includes(needle)) return f.filename;
    } else {
      const zip = await JSZip.loadAsync(f.data);
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if ((await entry.async('string')).includes(needle)) return `${f.filename}:${name}`;
      }
    }
  }
  return null;
}

async function storageContains(storage, needle) {
  for (const store of STORES) {
    for (const k of await storage.keys(store)) {
      if (String(k).includes(needle) || JSON.stringify(await storage.get(store, k)).includes(needle)) return `${store}/${k}`;
    }
  }
  return null;
}

const ctx = {};

test('전체 실행(웹 검색·병렬 3·계획 검토) → 모든 형식 내보내기, 계약 키, API 키 미노출', async () => {
  const storage = new MemoryStorage();
  const llms = [];
  const b = createBackend({ storage, loadSample, tools: makeFakeTools(),
    llmFactory: (o) => {
      assert.equal(o.apiKey, KEY);
      const l = new FakeLLM({ webSearch: true, model: o.model });
      llms.push(l);
      return l;
    } });
  const formats = [...FORMAT_IDS];
  const { id, status } = await b.createRun({ prompt: PROMPT, model: 'claude-opus-5-5', depth: 'standard', options: { parallelism: 3 },
    language: 'ko', year_from: null, human_in_the_loop: true, formats, api_key: KEY });
  hasKeys(status, SNAP_KEYS, 'createRun status');
  assert.equal(status.config.parallelism, 3);
  assert.equal(status.config.web_search, true);
  assert.deepEqual(status.formats, formats);
  const t0 = Date.now();
  let approved = false;
  const [events, final] = await pollAll(b, id, async (s) => {
    hasKeys(s, SNAP_KEYS, `snapshot(${s.status})`);
    if (s.status === 'awaiting_plan' && !approved) {
      approved = true;
      assert.equal(s.awaiting, 'plan');
      await b.submitPlan(id, { action: 'approve' });
    }
  });
  ctx.elapsedMs = Date.now() - t0;
  assert.equal(final.status, 'done', JSON.stringify(final.error));
  assert.ok(approved, '계획 검토 대기가 없었음');
  assert.equal(final.has_result, true);
  assert.equal(final.stage, 'done');
  for (const f of formats) assert.equal(final.exports[f], 'ready', `exports.${f} = ${final.exports[f]}`);
  hasKeys((await b.listRuns()).runs[0], SUMMARY_KEYS, 'listRuns summary');

  // 이벤트 계약 (3.3 + budget)
  checkEvents(events, 'full');
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['stage', 'understanding', 'window', 'plan', 'plan_review', 'tool', 'tool_error', 'subq_done', 'evaluate',
    'synthesis', 'reflection', 'report', 'verify', 'export']) assert.ok(kinds.has(k), `이벤트 kind ${k} 없음`);
  const web = events.filter((e) => e.kind === 'tool' && e.data.tool === 'web_search');
  assert.ok(web.length >= 1, '웹 검색 도구 이벤트 없음');
  assert.match(web[0].msg, /^Q\d+ · web_search\('.+'\) → \d+건 \(누적 \d+\)$/);
  assert.deepEqual(events.filter((e) => e.kind === 'export').map((e) => e.data.fmt), formats);
  assert.ok(events.filter((e) => e.kind === 'export').every((e) => e.data.ok));

  // 결과 계약 (3.2 + budget) 과 화면용 추가 키
  const res = await b.result(id);
  checkResult(res, 'result');
  for (const k of ['report_html', 'toc', 'exports', 'qa', 'parent_id', 'custom_title', 'imported']) assert.ok(Object.hasOwn(res, k), k);
  assert.equal(res.id, id);
  assert.equal(res.meta.config.parallelism, 3);
  assert.equal(res.meta.budget_cap_usd, null);
  assert.equal(res.meta.budget_hit, false);
  assert.deepEqual(res.meta.counts, final.counts);
  // meta.usage는 결과를 조립한 시점의 값(원본과 같이 pptx 슬라이드 개요 호출 1회는 빠짐), 스냅샷은 끝까지 센다
  const totalCalls = llms.reduce((n, l) => n + l.usage.calls, 0);
  assert.equal(final.usage.calls, totalCalls);
  assert.equal(res.meta.usage.calls, totalCalls - 1);
  const webSrc = res.sources.filter((s) => s.kind === 'web' && s.origin === 'WebSearch');
  assert.ok(webSrc.length >= 1, '웹 검색 문헌 없음');
  assert.ok(webSrc.some((s) => s.url === WEB_REPORT_URL && s.abstract), '인용문이 웹 문헌 초록에 붙지 않음');
  assert.ok(res.sources.some((s) => s.cited));
  assert.ok(res.trace.length > 0 && res.trace.every((t) => t.kind !== 'tool'));
  // 샘플 result.json에 있는 키는 새 실행 결과에도 있어야 한다
  const sample = JSON.parse(await loadSample(`${SAMPLE}/result.json`));
  assert.deepEqual(Object.keys(sample).filter((k) => !Object.hasOwn(res, k)), []);
  assert.deepEqual(Object.keys(sample.meta).filter((k) => !Object.hasOwn(res.meta, k)), []);
  assert.deepEqual(Object.keys(sample.sources[0]).filter((k) => !Object.hasOwn(res.sources[0], k)), []);

  // Q&A 한 번 (저장소 키 검사에 포함되도록)
  const ans = await b.ask(id, { question: '가장 강한 근거는?', api_key: KEY });
  assert.ok(ans.answer_markdown && ans.answer_html);

  // 모든 결과물
  const { out } = await exportAll(b, id, 'full');
  assert.equal(JSON.parse(out.json.data).id, id);

  // API 키: 저장소·스냅샷·이벤트·결과물 어디에도 없다
  assert.equal(await storageContains(storage, KEY), null);
  assert.equal(await storageContains(storage, 'INTEGRATIONSECRET'), null);
  assert.equal(await filesContain(out, 'INTEGRATIONSECRET'), null);
  assert.doesNotMatch(JSON.stringify(await b.run(id)), /INTEGRATIONSECRET/);
  assert.doesNotMatch(JSON.stringify(events), /INTEGRATIONSECRET/);
  assert.doesNotMatch(JSON.stringify(res), /INTEGRATIONSECRET/);

  ctx.full = { b, storage, id, md: out.md.data, events: events.length };
});

test('비용 한도: budget 이벤트 한 번, 결과·meta의 budget 필드, 보고서는 끝까지', async () => {
  const b = createBackend({ storage: new MemoryStorage(), loadSample, tools: makeFakeTools({ fail: [] }),
    llmFactory: (o) => new FakeLLM({ webSearch: true, model: o.model, costPerCall: 0.05 }) });
  const { id } = await b.createRun({ prompt: PROMPT, options: { parallelism: 3 }, max_cost_usd: 0.2, formats: ['md'], api_key: KEY });
  const [events, final] = await pollAll(b, id);
  assert.equal(final.status, 'done', JSON.stringify(final.error));
  checkEvents(events, 'budget');
  const budget = events.filter((e) => e.kind === 'budget');
  assert.equal(budget.length, 1);
  assert.equal(budget[0].data.cap, 0.2);
  const res = await b.result(id);
  checkResult(res, 'budget result');
  assert.equal(res.budget_hit, true);
  assert.equal(res.meta.budget_hit, true);
  assert.equal(res.meta.budget_cap_usd, 0.2);
  assert.ok(res.report_markdown.length > 0);
  assert.ok(res.trace.some((t) => t.kind === 'budget'));
});

test('데모 재생(키 없음) → 계약 키, 모든 형식 내보내기', async () => {
  const storage = new MemoryStorage();
  const b = createBackend({ storage, loadSample, sampleSpeed: 200, llmFactory: () => assert.fail('데모에서 LLM을 만들면 안 됨') });
  const { id } = await b.createRun({ demo: true, demo_speed: 20, prompt: '데모 주제', formats: ['md', 'pptx'] });
  const [events, final] = await pollAll(b, id);
  assert.equal(final.status, 'done', JSON.stringify(final.error));
  assert.equal(final.demo, true);
  hasKeys(final, SNAP_KEYS, 'demo snapshot');
  checkEvents(events, 'demo');
  const res = await b.result(id);
  checkResult(res, 'demo result');
  assert.equal(res.meta.demo, true);
  assert.equal(res.prompt, '데모 주제');
  assert.ok(res.meta.note);
  await exportAll(b, id, 'demo');
});

test('조사 파일 저장 → 다른 브라우저(새 저장소)에서 열기 → 다시 내보내기, 새로고침 뒤에도 유지', async () => {
  assert.ok(ctx.full, '첫 테스트가 먼저 돌아야 함');
  const { b, id, md, events } = ctx.full;
  const file = await b.exportRunFile(id);
  assert.equal(file.mime, 'application/json');
  assert.match(file.filename, /\.json$/);
  assert.doesNotMatch(file.data, /INTEGRATIONSECRET/);
  const parsed = JSON.parse(file.data);
  assert.equal(parsed.format, 'ai-research-agent/run');
  assert.equal(parsed.events.length, events);
  assert.equal(parsed.qa.length, 1);

  const storage = new MemoryStorage();
  const b2 = createBackend({ storage, loadSample });
  const { id: imp } = await b2.importRunFile(file.data);
  assert.match(imp, /^imp_/);
  const snap = await b2.run(imp);
  hasKeys(snap, SNAP_KEYS, 'imported snapshot');
  assert.equal(snap.imported, true);
  assert.equal(snap.status, 'done');
  const res = await b2.result(imp);
  checkResult(res, 'imported result');
  assert.equal(res.meta.imported_from, id);
  assert.equal(res.qa.length, 1);
  assert.equal((await b2.events(imp, 0, 0)).events.length, events);
  const { out } = await exportAll(b2, imp, 'imported');
  assert.equal(out.md.data, md, '가져온 실행의 Markdown이 원래 실행과 다름');

  // 같은 저장소로 새 백엔드(페이지 새로고침) → 여전히 열리고 내보낼 수 있다
  const b3 = createBackend({ storage, loadSample });
  const runs = (await b3.listRuns()).runs;
  assert.equal(runs[0].id, imp);
  assert.equal(runs[0].imported, true);
  assert.equal((await b3.exportFile(imp, 'docx')).data instanceof Uint8Array, true);
  await assert.rejects(b3.resume(imp, { api_key: KEY }), (e) => e.code === 'not_resumable');

  // 샘플 실행도 조사 파일로 저장 → 열기 → pptx
  const sf = await b3.exportRunFile(SAMPLE);
  const { id: imp2 } = await b3.importRunFile(sf.data);
  await checkFile(await b3.exportFile(imp2, 'pptx'), 'pptx', 'imported sample');
  checkResult(await b3.result(imp2), 'imported sample result', { budget: false });
});

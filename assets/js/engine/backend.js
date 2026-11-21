// 브라우저 백엔드 (SITE_SPEC 5). 원본 server/runs.py(RunManager)와 server/api.py(HTTP API)를 페이지 안의 객체 하나로 옮겼다.
//
// 화면(api.js)은 HTTP API를 부르던 자리에서 createBackend(...)가 돌려준 객체의 메서드를 부른다.
// 메서드 이름과 돌려주는 모양은 PYTHON_SPEC 6.3의 응답 본문과 같고, 오류는 BackendError(code, message, status)로 던진다.
// 실행은 페이지 안에서 async로 돈다(동시 진행 최대 2건). 저장은 Storage(storage.js): runs·events·results·checkpoints·qa·meta.
// 새 기능: 이어하기(resume), 기록 이름 바꾸기(rename), 조사 파일 저장·열기(exportRunFile/importRunFile),
// 보고서 다시 쓰기(rewriteReport), 주제 다듬기(refinePrompt), 진행 중 실행 확인(hasActiveRuns).
// API 키는 실행 객체 메모리(run.apiKey)에만 있고 실행이 끝나면 지운다. 저장소·이벤트·오류·파일 어디에도 넣지 않는다.

import { AnthropicError } from '../../../vendor/anthropic-sdk.js';
import { LLM, LLMError, RunCancelled, friendlyError, isAbortError, listModels as sdkListModels } from './llm.js';
import {
  APP_NAME, APP_VERSION, DEFAULT_DEPTH, DEFAULT_MODEL, DEPTH_PRESETS, LIMITS, MODELS, PRICING_AS_OF, RunConfig, WEB_SEARCH_USD,
  modelLabel,
} from './models.js';
import { REPORT_LENGTHS, ResearchAgent } from './pipeline.js';
import { answerQuestion } from './qa.js';
import { REFINE_MODEL, refinePrompt as refineDraft } from './refine.js';
import { TOOL_DESC, TOOL_FUNCS, TOOL_LABELS, WEB_SEARCH_DESC } from './tools.js';
import { MemoryStorage } from './storage.js';
import {
  ACTIVE, BackendError, BackendHooks, EMPTY_COUNTS, ID_RE, LLM_STATUS, MAX_ACTIVE, MAX_PROMPT, MAX_QUESTION, MAX_TITLE, MODEL_RE,
  RESUMABLE_CODES, Run, cleanText, cpHead, cpLength, isoLocal, keyFormatOk, randomHex, stamp, validateDecision,
} from './runs.js';
import { DEMO_NOTE, DEMO_SAMPLE, demoAnswer, parseJsonl, replay } from './demo.js';
import { buildRunFile, cleanQa, parseRunFile, runFileName } from './runfile.js';
import { FORMATS, FORMAT_IDS, bundleName, exportBundle, exportFile } from '../export/index.js';
import { renderFragment, renderMarkdown } from '../export/html.js';
import { fallbackDeck, isDeck, makeDeck, normalizeDeck } from '../export/slides.js';

export { BackendError } from './runs.js';

export const STAGES = [
  { id: 'understand', label: '주제 이해', description: '핵심 개념·변수·검색 기간 파악' },
  { id: 'plan', label: '조사 계획', description: '관점이 다른 하위 질문과 검색어 수립' },
  { id: 'act', label: '자료 탐색', description: '하위 질문마다 검색 도구를 골라 문헌 수집' },
  { id: 'evaluate', label: '자료 평가', description: '관련성·연구 설계·신뢰도 평가와 중복 병합' },
  { id: 'synthesize', label: '종합', description: '하위 질문별로 근거를 모아 결론과 근거 강도 정리' },
  { id: 'reflect', label: '자기 비판', description: '빈틈·편향을 점검하고 필요하면 추가 조사' },
  { id: 'report', label: '보고서 작성', description: '인용이 달린 최종 연구 브리프 작성' },
  { id: 'verify', label: '인용 검증', description: '인용 ID 확인과 표본 문장의 초록 대조·수정' },
];
export const EXAMPLES = [
  '생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향',
  '롤러를 활용한 센서 제작 공정',
  '2020년 이후 원격근무가 직원의 직무 만족과 생산성에 미친 영향을 실증 연구 중심으로 정리해 줘',
];
const FORMAT_LABEL = Object.fromEntries(FORMATS.map((f) => [f.id, f.label]));
const STORAGE_WARNING = '이 브라우저에서는 실행 기록을 저장할 수 없습니다(사생활 보호 창 등). 페이지를 새로 열면 기록이 사라지니 ' +
  '끝난 결과는 조사 파일로 저장해 두세요.';
const PUBLIC_METHODS = ['config', 'checkKey', 'listRuns', 'createRun', 'run', 'events', 'submitPlan', 'cancel', 'remove', 'result',
  'qa', 'ask', 'slides', 'exportFile', 'resume', 'rename', 'exportRunFile', 'importRunFile', 'rewriteReport', 'refinePrompt',
  'hasActiveRuns', 'waitForRun', 'dispose', 'finishEarly'];
// '지금 마무리'를 받을 수 있는 단계 (자료 탐색이 시작된 뒤 ~ 보고서 작성 전)
const FINISH_STAGES = ['act', 'evaluate', 'synthesize', 'reflect'];
const FINISH_MSG = '사용자 요청으로 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.';
const PERSIST_WARNING = '진행 상태를 브라우저 저장소에 저장하지 못했습니다(저장 공간 부족 등). 이 탭을 닫으면 이어하기가 안 될 수 있습니다.';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (typeof x === 'string' ? x : '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const notFound = () => new BackendError('not_found', '실행을 찾을 수 없습니다.', 404);
const noResult = () => new BackendError('no_result', '아직 결과가 없습니다.', 404);
const readOnly = (what) => new BackendError('read_only', `샘플 실행은 ${what}`, 403);

/** 가져온 결과의 모양을 바로잡는다: 결과물 만들기(배열 메서드)가 이상한 값에 걸려 멈추지 않게. */
function normalizeImported(res) {
  const arrOr = (x) => (Array.isArray(x) ? x : []);
  res.sources = arrOr(res.sources).filter((s) => isObj(s) && typeof s.sid === 'string' && s.sid);
  for (const s of res.sources) {
    if (Array.isArray(s.authors)) s.authors = s.authors.filter((a) => a !== null && a !== undefined).map(String);
    else if (typeof s.authors === 'string') s.authors = s.authors.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    else s.authors = [];
    for (const k of ['subqs', 'queries']) if (k in s && !Array.isArray(s[k])) delete s[k];
  }
  res.trace = arrOr(res.trace).filter(isObj);
  res.reflections = arrOr(res.reflections).filter(isObj);
  if (isObj(res.verification)) {
    res.verification.checks = arrOr(res.verification.checks).filter(isObj);
    res.verification.unknown_ids = arrOr(res.verification.unknown_ids).map(String);
  } else {
    res.verification = {};
  }
  return res;
}

/** 데모 빠르기: 1 = 원본 속도(약 45초), 5 = 약 10초. 0.25~20 사이로 자른다. */
function demoSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(0.25, Math.min(20, n)) : 1;
}

class Backend {
  constructor({ storage = null, llmFactory = null, tools = null, loadSample = null, now = null, sampleSpeed = 1,
    listModels = null } = {}) {
    this.storage = storage || new MemoryStorage();
    this._llmFactory = llmFactory || ((opts) => new LLM(opts));
    this.tools = tools || null;
    this._loadSample = loadSample;
    this._now = now || (() => new Date());
    this._sampleSpeed = Number(sampleSpeed) > 0 ? Number(sampleSpeed) : 1;
    this._listModels = listModels || sdkListModels;
    this._runs = new Map();
    this._samples = [];
    this._exports = new Map();          // id → Map(fmt → 결과물)  — 이번 페이지 세션 동안만
    this._inflight = new Map();         // `${id}:${fmt}` → 만드는 중인 Promise
    this._decks = new Map();            // id → 발표 구성안(deck plan v2)
    this._bundled = new Map();          // 샘플 id → 미리 만들어 둔 구성안(slides.json)을 읽는 Promise
    this._qaChains = new Map();
    this._demoCache = null;
    this._storageWarning = null;
    for (const k of PUBLIC_METHODS) this[k] = this[k].bind(this);
    this.ready = this._init();
  }

  _iso() {
    return isoLocal(this._now());
  }

  // ── 시작: 지난 실행 불러오기 · 중단된 실행 표시 · 샘플 ──
  async _init() {
    let snaps = [];
    let ck = new Set();
    try {
      snaps = await this.storage.getAll('runs');
      ck = new Set(await this.storage.keys('checkpoints'));
    } catch {
      this._storageWarning = STORAGE_WARNING;
      this.storage = new MemoryStorage();
      snaps = [];
    }
    for (const snap of snaps) {
      if (!isObj(snap) || typeof snap.id !== 'string' || !ID_RE.test(snap.id)) continue;
      let run;
      try {
        run = Run.fromSnapshot(snap, { now: this._now });
      } catch {
        continue;
      }
      const id = run.id;
      run.sample = false;
      run.attach(this.storage);
      run._loadEvents = async () => (await this.storage.get('events', id)) || [];
      const canResume = !run.imported && ck.has(id);
      if (run.active) {
        // 페이지가 닫히거나 새로고침되어 멈춘 실행
        run.status = 'interrupted';
        run.awaiting = null;
        run.progress = null;
        run.resumable = canResume;
        run.error = { code: 'interrupted', message: canResume
          ? '페이지를 닫거나 새로고침해서 실행이 중단되었습니다. 저장된 단계부터 이어서 진행할 수 있습니다.'
          : '페이지를 닫거나 새로고침해서 실행이 중단되었습니다. 다시 실행해 주세요.' };
        run.exports = Object.fromEntries(Object.entries(run.exports).filter(([, v]) => v !== 'pending'));
        run.save(true);
      } else if (run.status === 'error') {
        run.resumable = canResume && RESUMABLE_CODES.has(run.error?.code);
      } else if (run.status === 'interrupted') {
        run.resumable = canResume;
      } else {
        run.resumable = false;
      }
      this._runs.set(id, run);
    }
    await Promise.all([...this._runs.values()].map((r) => r.flush()));
    await this._loadSamples();
  }

  async _loadSamples() {
    if (!this._loadSample) return;
    let index;
    try {
      index = JSON.parse(await this._loadSample('index.json'));
    } catch {
      return;
    }
    const ids = (Array.isArray(index?.samples) ? index.samples : []).map((s) => s?.id)
      .filter((id) => typeof id === 'string' && ID_RE.test(id) && !this._runs.has(id));
    const snaps = await Promise.all(ids.map(async (id) => {
      try {
        return JSON.parse(await this._loadSample(`${id}/run.json`));
      } catch {
        return null;
      }
    }));
    ids.forEach((id, i) => {
      const snap = snaps[i];
      if (!isObj(snap)) return;
      const run = Run.fromSnapshot({ ...snap, id }, { sample: true, now: this._now });
      run.sample = true;
      run.resumable = false;
      if (!('exports' in snap)) run.exports = {};
      run._loadEvents = async () => parseJsonl(await this._loadSample(`${id}/events.jsonl`));
      this._runs.set(id, run);
      this._samples.push(id);
    });
  }

  // ── 조회 도우미 ──
  async _run(id) {
    await this.ready;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound();
    const run = this._runs.get(id);
    if (!run) throw notFound();
    return run;
  }

  async _loadResult(run) {
    if (run.resultCache) return run.resultCache;
    let res = null;
    try {
      if (run.sample) res = JSON.parse(await this._loadSample(`${run.id}/result.json`));
      else res = await this.storage.get('results', run.id);
    } catch {
      res = null;
    }
    run.resultCache = isObj(res) ? res : null;
    return run.resultCache;
  }

  async _requireResult(id) {
    const run = await this._run(id);
    const result = await this._loadResult(run);
    if (!result) throw noResult();
    return [run, result];
  }

  _key(apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) throw new BackendError('no_api_key', 'Anthropic API 키를 입력해 주세요.', 400);
    if (!keyFormatOk(key)) throw new BackendError('auth', 'API 키 형식이 올바르지 않습니다. 복사한 키를 다시 확인해 주세요.', 400);
    return key;
  }

  _checkModel(model) {
    if (model !== null && model !== undefined && !(typeof model === 'string' && MODEL_RE.test(model))) {
      throw new BackendError('invalid_model', '모델 이름이 올바르지 않습니다.', 400);
    }
  }

  _checkCapacity() {
    const n = [...this._runs.values()].filter((r) => r.active).length;
    if (n >= MAX_ACTIVE) {
      throw new BackendError('too_many_runs', `동시에 진행할 수 있는 실행은 최대 ${MAX_ACTIVE}건입니다. ` +
        '진행 중인 실행이 끝난 뒤 다시 시도해 주세요.', 409);
    }
  }

  _newId(prefix = 'r') {
    let id;
    do id = `${prefix}${stamp(this._now())}_${randomHex(4)}`; while (this._runs.has(id));
    return id;
  }

  _makeLlm(run, model) {
    return this._llmFactory({
      apiKey: run.apiKey, model,
      onWarning: (m) => run.emit('system', 'warning', String(m), null),
      signal: run.controller ? run.controller.signal : null,
    });
  }

  /** 실행 밖의 LLM 호출(Q&A·슬라이드·주제 다듬기) 오류를 BackendError로 바꾼다. */
  async _llmCall(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BackendError) throw e;
      const fe = friendlyError(e);
      if (fe instanceof RunCancelled) throw new BackendError('cancelled', '요청이 취소되었습니다.', 409);
      if (e instanceof LLMError || e instanceof AnthropicError || fe.code === 'connection') {
        throw new BackendError(fe.code, fe.message, LLM_STATUS[fe.code] ?? 400);
      }
      throw new BackendError('internal', `내부 오류가 발생했습니다 (${e?.name || 'Error'}: ${cleanText(String(e?.message || '').split('\n')[0]).slice(0, 200)})`, 500);
    }
  }

  // ── 설정 · 키 ──
  async config() {
    await this.ready;
    const kind = this.storage.kind || 'custom';
    return {
      app: { name: APP_NAME, version: APP_VERSION }, demo: false, server_key: false,
      models: MODELS.map((m) => ({ ...m, default: m.id === DEFAULT_MODEL })), pricing_as_of: PRICING_AS_OF,
      web_search_usd: WEB_SEARCH_USD,       // 웹 검색 1회 요금(USD). 예상 비용 = 토큰 비용 + estimate.web_searches × 이 값
      depths: Object.entries(DEPTH_PRESETS).map(([id, v]) => ({ id, label: v.label, description: v.description,
        config: { ...v.config }, estimate: { ...v.estimate } })),
      default_depth: DEFAULT_DEPTH,
      formats: FORMATS.map((f) => ({ ...f, available: true, note: '' })),
      defaults: new RunConfig().toDict(),
      limits: Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, [...v]])),
      tools: [...Object.keys(TOOL_FUNCS).map((n) => ({ name: n, label: TOOL_LABELS[n] || n, description: TOOL_DESC[n] || '' })),
        { name: 'web_search', label: TOOL_LABELS.web_search || '웹 검색', description: WEB_SEARCH_DESC }],
      stages: STAGES, examples: EXAMPLES,
      features: { resume: true, cost_cap: true, run_files: true, rewrite: true, refine: true, notifications: true },
      refine_model: REFINE_MODEL, report_lengths: Object.keys(REPORT_LENGTHS), max_active: MAX_ACTIVE, max_prompt: MAX_PROMPT,
      demo_sample: this._samples.includes(DEMO_SAMPLE) ? DEMO_SAMPLE : null,
      storage: { kind, persistent: kind !== 'memory', warning: this._storageWarning },
    };
  }

  /** 키 확인: {ok: true, models} | {ok: false, error: {code, message}} (던지지 않음) */
  async checkKey(apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) return { ok: false, error: { code: 'no_api_key', message: 'API 키가 없습니다. 키를 입력해 주세요.' } };
    if (!keyFormatOk(key)) {
      return { ok: false, error: { code: 'auth', message: 'API 키 형식이 올바르지 않습니다. 복사한 키를 다시 확인해 주세요.' } };
    }
    try {
      return { ok: true, models: await this._listModels(key) };
    } catch (e) {
      const fe = e instanceof LLMError ? e : friendlyError(e);
      const code = fe instanceof LLMError ? fe.code : 'unknown';
      const message = fe instanceof LLMError ? fe.message : '키를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
      return { ok: false, error: { code, message: cleanText(message, key) } };
    }
  }

  // ── 실행 ──
  async listRuns() {
    await this.ready;
    const all = [...this._runs.values()];
    const own = all.filter((r) => !r.sample && !r.imported).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const imported = all.filter((r) => !r.sample && r.imported)
      .sort((a, b) => String(b.imported_at || '').localeCompare(String(a.imported_at || '')));
    const samples = this._samples.map((id) => this._runs.get(id)).filter(Boolean);
    return { runs: [...own, ...imported, ...samples].map((r) => r.summary()) };
  }

  /** body: {prompt, model, depth, options, language, year_from, human_in_the_loop, formats, max_cost_usd, demo, demo_speed, api_key} */
  async createRun(body) {
    await this.ready;
    body = isObj(body) ? body : {};
    const d = { ...(isObj(body.options) ? body.options : {}) };
    delete d.api_key;
    for (const k of ['depth', 'model', 'language', 'human_in_the_loop', 'formats']) {
      if (body[k] !== null && body[k] !== undefined) d[k] = body[k];
    }
    if (Object.hasOwn(body, 'year_from')) d.year_from = body.year_from;
    if (Object.hasOwn(body, 'max_cost_usd')) d.max_cost_usd = body.max_cost_usd;
    this._checkModel(d.model);
    const demo = body.demo === true;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) throw new BackendError('empty_prompt', '연구 주제나 요청을 입력해 주세요.', 400);
    if (cpLength(prompt) > MAX_PROMPT) throw new BackendError('prompt_too_long', `요청은 ${MAX_PROMPT}자 이하로 입력해 주세요.`, 400);
    const key = demo ? null : this._key(body.api_key);
    const cfg = RunConfig.fromDict(d);
    cfg.formats = [...new Set(cfg.formats)].filter((f) => FORMAT_IDS.includes(f));
    if (!cfg.formats.length) cfg.formats = ['md'];
    if (demo) cfg.max_cost_usd = null;
    this._checkCapacity();
    const id = this._newId('r');
    const run = new Run(id, prompt, cfg, { demo, note: demo ? DEMO_NOTE : '', now: this._now }).attach(this.storage);
    if (demo) run.demo_speed = demoSpeed(body.demo_speed);
    run.apiKey = key;
    run._loadEvents = null;
    this._runs.set(id, run);
    await this._register(run);
    this._start(run);
    return { id, status: run.snapshot() };
  }

  /** 새 실행의 첫 스냅샷 저장. 실패하면 등록을 되돌린다(queued로 남아 동시 실행 한도를 막지 않게). */
  async _register(run) {
    run.persistError = null;
    await run.save(true);
    if (run.persistError) {
      this._runs.delete(run.id);
      run.apiKey = null;
      throw new BackendError('storage_error', '실행 기록을 브라우저 저장소에 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.', 500);
    }
  }

  _start(run, checkpoint = null) {
    run.controller = typeof AbortController === 'function' ? new AbortController() : null;
    run.task = this._worker(run, checkpoint);
    return run.task;
  }

  async _worker(run, checkpoint) {
    const key = run.apiKey;         // 오류 문구에서 가리기 위해서만 쓴다 (finish()가 run.apiKey를 지움)
    let status = 'error';
    let error = { code: 'internal', message: '내부 오류가 발생했습니다.' };
    try {
      await run.start(Boolean(checkpoint));
      let result;
      if (run.demo) result = await this._runDemo(run, checkpoint);
      else if (run.rewrite) result = await this._runRewrite(run);
      else result = await this._runAgent(run, checkpoint);
      await this._saveResult(run, result);
      await this._exportStage(run, result);
      status = 'done';
      error = null;
    } catch (e) {
      if (e instanceof RunCancelled || isAbortError(e) || run._cancel) {
        status = 'cancelled';
        error = null;
        try {
          run.emit('system', 'log', '사용자가 실행을 취소했습니다', null);
        } catch { /* 기록 실패가 종료 처리를 막지 않게 */ }
      } else {
        error = this._errorOf(e, key);
        try {
          run.emit('system', 'error', error.message, { code: error.code });
        } catch { /* 무시 */ }
      }
    } finally {
      try {
        if (status === 'error') {
          run.resumable = RESUMABLE_CODES.has(error.code) && run.persist && Boolean(await this.storage.get('checkpoints', run.id));
        } else {
          run.resumable = false;
          run._write('checkpoints', run.id, null, true);     // 끝난 실행의 체크포인트는 지운다(공간 절약)
        }
      } catch {
        run.resumable = false;
      }
      await run.finish(status, error);      // 어떤 경우에도 실행을 끝난 상태로 표시한다
    }
  }

  _errorOf(e, key) {
    if (e instanceof BackendError) return { code: e.code, message: cleanText(e.message, key) };
    const fe = friendlyError(e);
    if (e instanceof LLMError || e instanceof AnthropicError || (fe instanceof LLMError && fe.code === 'connection')) {
      return { code: fe.code, message: cleanText(fe.message, key) };
    }
    const summary = cleanText(String(e?.message ?? e ?? '').split('\n')[0], key).slice(0, 200);
    if (globalThis.console) console.error('[실행 오류]', cleanText(e?.stack || String(e), key));
    return { code: 'internal', message: `내부 오류가 발생했습니다 (${e?.name || 'Error'}: ${summary})` };
  }

  async _saveCheckpoint(run, rec) {
    if (!run.persist || run.deleted) return;
    // 지난 체크포인트 뒤에 실패한 스냅샷·이벤트 저장도 놓치지 않도록 지우기 전에 기억해 둔다
    const earlier = run.persistError;
    run.persistError = null;
    run._write('checkpoints', run.id, { version: 1, saved_at: this._iso(), ...rec });
    run.save(true);
    run.flushEvents();
    await run._chain;
    // 저장 실패는 실행마다 한 번만 알린다(실행은 계속한다)
    if ((earlier || run.persistError) && !run._persistWarned) {
      run._persistWarned = true;
      run.emit('system', 'warning', PERSIST_WARNING, null);
    }
  }

  async _runAgent(run, checkpoint) {
    const llm = this._makeLlm(run, run.config.model);
    run.llm = llm;
    const hooks = new BackendHooks(run, (state) => this._saveCheckpoint(run, { kind: 'agent', state }));
    if (checkpoint && checkpoint.kind === 'agent' && isObj(checkpoint.state)) {
      // 사용량은 마지막 스냅샷 값에서 이어서 센다(중단된 단위에서 쓴 사용량까지 포함)
      const u = run.usage || {};
      const usage = { calls: u.calls || 0, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
      // 중단 전에 쓴 웹 검색 요금도 이어서 센다 (fromState는 0보다 클 때만 더한다)
      if (Number(u.web_searches) > 0) usage.web_searches = Number(u.web_searches);
      const state = { ...checkpoint.state, usage };
      run.agent = ResearchAgent.fromState(run.prompt, llm, run.config, hooks, state, this.tools);
      // 체크포인트 뒤에 받은 '지금 마무리' 요청도 이어서 지킨다
      if (run.finish_requested) run.agent.requestFinish();
      else run.finish_requested = Boolean(run.agent.finishRequested);
    } else {
      run.agent = new ResearchAgent(run.prompt, llm, run.config, hooks, this.tools);
    }
    return this._assemble(run, await run.agent.run());
  }

  async _demoSample() {
    if (!this._demoCache) {
      if (!this._loadSample) throw new BackendError('demo_unavailable', '데모용 샘플을 불러오지 못했습니다.', 500);
      try {
        const [res, evs] = await Promise.all([this._loadSample(`${DEMO_SAMPLE}/result.json`), this._loadSample(`${DEMO_SAMPLE}/events.jsonl`)]);
        this._demoCache = [JSON.parse(res), parseJsonl(evs)];
      } catch {
        throw new BackendError('demo_unavailable', '데모용 샘플을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 500);
      }
    }
    return this._demoCache;
  }

  async _runDemo(run, checkpoint) {
    const [sample, events] = await this._demoSample();
    const startAt = checkpoint && checkpoint.kind === 'demo' ? Number(checkpoint.pos) || 0 : 0;
    return replay(run, sample, events, {
      speed: run.demo_speed || 1, startAt, timeScale: this._sampleSpeed,
      onCheckpoint: (pos) => this._saveCheckpoint(run, { kind: 'demo', pos }),
    });
  }

  async _runRewrite(run) {
    const parent = this._runs.get(run.parent_id);
    const prev = parent ? await this._loadResult(parent) : null;
    if (!prev) throw new BackendError('no_result', '원래 실행의 결과를 찾을 수 없습니다(삭제되었을 수 있습니다).', 404);
    const llm = this._makeLlm(run, run.config.model);
    run.llm = llm;
    const hooks = new BackendHooks(run, null);
    const opts = run.rewrite || {};
    const out = await ResearchAgent.rewriteReport(prev, llm, run.config, hooks,
      { language: opts.language || null, length: opts.length || 'standard', extra: opts.extra || '' });
    const result = this._assemble(run, out);
    const parentTrace = (Array.isArray(prev.trace) ? prev.trace : []).filter((t) => isObj(t) && !['report', 'verify'].includes(t.stage));
    result.trace = [...parentTrace, ...result.trace];
    result.meta.parent_id = run.parent_id;
    result.meta.rewrite = { ...opts };
    return result;
  }

  /** 에이전트 결과에 id·meta·trace·schema_version을 붙여 result.json(PYTHON_SPEC 3.2)을 만든다. */
  _assemble(run, out) {
    out = { ...out };
    const pop = (k, dflt = null) => {
      if (!Object.hasOwn(out, k)) return dflt;
      const v = out[k];
      delete out[k];
      return v;
    };
    const yearFrom = pop('year_from');
    const yearFromSource = pop('year_from_source');
    const yearFromReason = pop('year_from_reason');
    const disabled = pop('disabled_tools');
    const counts = pop('counts');
    const finishedEarly = pop('finished_early', false);
    const meta = {
      model: run.model, model_label: modelLabel(run.model), created_at: run.created_at,
      finished_at: this._iso(), elapsed_s: run.elapsed(), year_from: yearFrom ?? null,
      year_from_source: yearFromSource || 'agent', year_from_reason: yearFromReason || '',
      config: run.config.toDict(), usage: run.liveUsage(), counts: counts || { ...EMPTY_COUNTS },
      disabled_tools: [...(disabled || [])], app_version: APP_VERSION,
      sample: false, demo: false, note: '',
      budget_cap_usd: out.budget_cap_usd ?? null, budget_hit: Boolean(out.budget_hit),
      finished_early: Boolean(finishedEarly),
    };
    const result = { schema_version: 1, id: run.id, prompt: pop('prompt', run.prompt), topic: pop('topic', run.topic),
      lang: pop('lang', 'ko'), meta };
    Object.assign(result, out);
    result.trace = run.trace();
    return result;
  }

  async _saveResult(run, result) {
    run.resultCache = result;
    run.persistError = null;
    await run._write('results', run.id, result);
    if (run.persistError && run.persist) {
      run.emit('system', 'warning', '결과를 브라우저 저장소에 저장하지 못했습니다(저장 공간 부족 등). ' +
        '페이지를 닫기 전에 조사 파일로 저장해 두세요.', null);
    }
    const meta = result.meta || {};
    run.has_result = true;
    run.topic = result.topic || run.topic;
    run.counts = { ...EMPTY_COUNTS, ...(meta.counts || run.counts) };
    if (!run.llm && meta.usage) run.usage = { ...meta.usage };
    run.save(true);
    await run._chain;
  }

  /** config.formats를 차례로 만든다. 실패해도 실행은 성공으로 끝난다(exports[fmt]='failed'). */
  async _exportStage(run, result) {
    if (!run.formats.length) return;
    run.emit('export', 'stage', '결과물 내보내기 시작', { status: 'start', round: run.round });
    if (run.formats.includes('pptx')) {
      await run.checkpoint();
      // 발표 구성안: ① 이 실행의 LLM이 발표용으로 따로 짠다 ② 안 되면(데모 · 실패) 미리 만든 구성안 → 규칙 구성안
      let deck = null;
      if (run.llm) {
        let why = '응답 없음';      // makeDeck이 오류 없이 null을 돌려준 경우(LLM 호출이 끝내 실패)
        try {
          deck = await makeDeck(run.llm, result);
        } catch (e) {
          if (e instanceof RunCancelled || isAbortError(e) || run._cancel) throw e;
          why = e?.name || 'Error';
        }
        // AI가 구성안을 주지 못하면 규칙 구성안으로 넘어간다. 조용히 바뀌지 않도록 과정 기록에 남긴다
        if (!deck) run.emit('export', 'warning', `발표 구성안 생성 실패 → 규칙으로 구성 (${why})`, null);
        // 구성안 호출도 LLM 사용량이다: 결과에 적어 둔 사용량 · 비용을 고쳐 다시 저장한다
        // (그대로 두면 결과 화면의 비용이 실행 목록의 비용보다 적게 보인다)
        result.meta = { ...(result.meta || {}), usage: run.liveUsage() };
        run.resultCache = result;
        await run._write('results', run.id, result);
      }
      if (!deck) deck = (await this._bundledDeck(run, result)) || fallbackDeck(result);
      await this._storeDeck(run, deck);
    }
    for (const fmt of run.formats) {
      await run.checkpoint();
      const label = FORMAT_LABEL[fmt] || fmt;
      try {
        await this._export(run, result, fmt);
        run.emit('export', 'export', `${label} 생성 완료`, { fmt, ok: true, error: '' });
      } catch (e) {
        if (!(e instanceof BackendError)) throw e;
        run.emit('export', 'export', `${label} 생성 실패: ${e.message}`, { fmt, ok: false, error: e.message });
      }
    }
    run.emit('export', 'stage', '결과물 내보내기 완료', { status: 'end', round: run.round });
  }

  // ── 결과물 ──
  async _storeDeck(run, deck) {
    this._decks.set(run.id, deck);
    if (!run.sample) {
      await run._write('meta', `slides:${run.id}`, deck);
      return;
    }
    // 샘플은 저장소에 연결하지 않으므로(읽기 전용) 직접 쓴다: 키로 다시 구성한 결과를 새로고침 뒤에도 쓰게
    try {
      await this.storage.put('meta', `slides:${run.id}`, deck);
    } catch { /* 저장하지 못해도 이번 세션에서는 메모리 값을 쓴다 */ }
  }

  /** 이 실행에 딸린 샘플 id: 샘플은 자기 id, 데모는 DEMO_SAMPLE(같은 보고서를 재생한다),
   *  조사 파일로 가져온 샘플은 원래 샘플 id(같은 보고서·문헌). 아니면 null */
  _sampleIdOf(run, result) {
    if (run.sample) return run.id;
    if (run.demo) return DEMO_SAMPLE;
    const meta = isObj(result?.meta) ? result.meta : {};
    if (run.imported && meta.sample === true && this._samples.includes(meta.imported_from)) return meta.imported_from;
    return null;
  }

  /** data/samples/<id>/slides.json(미리 만든 구성안). 한 번만 읽고, 없거나 형식이 틀리면 null(규칙 구성안으로 조용히 넘어간다) */
  _bundledPlan(sampleId) {
    if (!this._loadSample) return Promise.resolve(null);
    if (!this._bundled.has(sampleId)) {
      const p = Promise.resolve()
        .then(() => this._loadSample(`${sampleId}/slides.json`))
        .then((text) => {
          const d = JSON.parse(text);
          return isDeck(d) ? d : null;
        })
        .catch(() => {
          this._bundled.delete(sampleId);     // 네트워크 오류일 수 있으니 실패는 기억하지 않는다
          return null;
        });
      this._bundled.set(sampleId, p);
    }
    return this._bundled.get(sampleId);
  }

  /** 샘플 · 데모 실행이면 미리 만든 구성안(정규화, source 'sample'), 아니면 null */
  async _bundledDeck(run, result) {
    const sampleId = this._sampleIdOf(run, result);
    if (!sampleId) return null;
    const raw = await this._bundledPlan(sampleId);
    if (!raw) return null;
    const deck = normalizeDeck(raw, result, 'sample');
    return deck.messages.length ? deck : null;
  }

  /** 이미 있는 구성안: 메모리 → 저장소(v2만. 옛 v1 개요는 버린다) → 샘플 · 데모의 미리 만든 구성안. 없으면 null */
  async _findDeck(run, result) {
    if (this._decks.has(run.id)) return this._decks.get(run.id);
    try {
      const d = await this.storage.get('meta', `slides:${run.id}`);
      if (isDeck(d)) {
        this._decks.set(run.id, d);
        return d;
      }
    } catch { /* 읽지 못하면 다음 후보 */ }
    const bundled = await this._bundledDeck(run, result);
    if (bundled) this._decks.set(run.id, bundled);
    return bundled;
  }

  /** PowerPoint를 만들 때 쓰는 구성안. 아무것도 없으면 규칙 구성안(가볍고 항상 성공) */
  async _deck(run, result) {
    return (await this._findDeck(run, result)) || fallbackDeck(result);
  }

  /** 지금 PowerPoint를 받으면 쓰일 구성안의 출처: 'llm' | 'sample' | 'rules' (규칙 구성안은 만들지 않고 이름만) */
  async _deckSource(run, result) {
    const d = await this._findDeck(run, result);
    return d && ['llm', 'sample', 'rules'].includes(d.source) ? d.source : 'rules';
  }

  _cache(id) {
    if (!this._exports.has(id)) this._exports.set(id, new Map());
    return this._exports.get(id);
  }

  /** 캐시에 있으면 그것, 없으면 새로 만든다(같은 형식을 동시에 두 번 만들지 않는다). */
  _export(run, result, fmt) {
    const cache = this._cache(run.id);
    if (cache.has(fmt)) return Promise.resolve(cache.get(fmt));
    const k = `${run.id}:${fmt}`;
    if (this._inflight.has(k)) return this._inflight.get(k);
    const p = (async () => {
      try {
        const deck = fmt === 'pptx' ? await this._deck(run, result) : null;
        const file = await exportFile(result, fmt, { deck });
        if (run.deleted) throw notFound();
        cache.set(fmt, file);
        run.setExport(fmt, 'ready');
        return file;
      } catch (e) {
        if (e instanceof BackendError) throw e;
        run.setExport(fmt, 'failed');
        if (globalThis.console) console.error(`[결과물 ${fmt}]`, e);
        throw new BackendError('export_failed', `${FORMAT_LABEL[fmt] || fmt} 파일을 만들지 못했습니다 (${e?.name || 'Error'}).`, 500);
      } finally {
        this._inflight.delete(k);
      }
    })();
    this._inflight.set(k, p);
    return p;
  }

  /** 스냅샷의 exports + 이번 세션에 이미 만든 결과물 */
  _exportsStatus(run) {
    const status = { ...run.exports };
    for (const fmt of this._cache(run.id).keys()) status[fmt] = 'ready';
    return status;
  }

  async _bundle(run, result) {
    const status = this._exportsStatus(run);
    const files = [];
    for (const fmt of FORMAT_IDS) {
      if (status[fmt] !== 'ready') continue;
      try {
        files.push(await this._export(run, result, fmt));
      } catch { /* 만들지 못한 형식은 빼고 묶는다 */ }
    }
    const events = await run.ensureEvents();
    if (events.length) files.push({ filename: 'events.jsonl', data: events.map((e) => JSON.stringify(e)).join('\n') + '\n' });
    try {
      const data = await exportBundle(result, files);
      return { filename: bundleName(result), mime: 'application/zip', data };
    } catch (e) {
      throw new BackendError('export_failed', `묶음(zip) 파일을 만들지 못했습니다 (${e?.name || 'Error'}).`, 500);
    }
  }

  /** 결과물 하나: export/index.js exportFile 결과({filename, mime, data, print?}). fmt 'zip' = 만든 결과물 + result.json 묶음. */
  async exportFile(id, fmt) {
    if (typeof fmt !== 'string' || (fmt !== 'zip' && !FORMAT_IDS.includes(fmt))) {
      throw new BackendError('invalid_format', '알 수 없는 형식입니다.', 400);
    }
    const [run, result] = await this._requireResult(id);
    if (fmt === 'zip') return this._bundle(run, result);
    return { ...(await this._export(run, result, fmt)) };
  }

  /** 발표 자료 다시 구성: body {api_key, model}로 LLM이 구성안을 새로 짜고 PowerPoint를 다시 만든다 → {ok, llm, source}.
   *  키가 없으면 데모 · 샘플도 no_api_key(미리 만든 구성안은 이미 쓰이고 있으므로 키 없이 '다시' 할 일이 없다). */
  async slides(id, body = {}) {
    const [run, result] = await this._requireResult(id);
    body = isObj(body) ? body : {};
    const key = this._key(body.api_key);
    this._checkModel(body.model);
    const model = body.model || result.meta?.model || run.config.model;
    const deck = await this._llmCall(() => makeDeck(this._llmFactory({ apiKey: key, model, onWarning: null, signal: null }), result));
    // 실패했으면 지금 구성안을 그대로 둔다(규칙 구성안으로 덮어쓰지 않는다)
    if (!deck) throw new BackendError('slides_failed', 'AI가 발표 구성안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', 502);
    // 이전 구성안으로 만드는 중인 PowerPoint가 있으면 끝난 뒤에 바꾼다(옛 파일이 캐시에 다시 들어가지 않게)
    const pending = this._inflight.get(`${run.id}:pptx`);
    if (pending) await pending.catch(() => {});
    await this._storeDeck(run, deck);
    this._cache(run.id).delete('pptx');
    await this._export(run, result, 'pptx');
    return { ok: true, llm: true, source: 'llm' };
  }

  async run(id) {
    return (await this._run(id)).snapshot();
  }

  /** {events, next, status, preview}: after보다 큰 seq만(최대 1000개), preview는 보고서 작성 중일 때 previewFrom(코드포인트)부터. */
  async events(id, after = 0, previewFrom = 0) {
    const run = await this._run(id);
    await run.ensureEvents();
    const a = Math.max(0, Math.trunc(Number(after) || 0));
    const evs = run.eventsAfter(a).slice(0, 1000);
    return { events: structuredClone(evs), next: evs.length ? evs[evs.length - 1].seq : a,
      status: run.snapshot(), preview: run.preview(Math.max(0, Math.trunc(Number(previewFrom) || 0))) };
  }

  async submitPlan(id, decision) {
    const run = await this._run(id);
    if (!run.submit(validateDecision(decision))) {
      throw new BackendError('not_awaiting', '지금은 계획 검토를 기다리는 중이 아닙니다.', 409);
    }
    return { ok: true };
  }

  async cancel(id) {
    const run = await this._run(id);
    return { ok: run.cancel() };
  }

  /** 지금 마무리: 추가 조사를 멈추고 지금까지 모은 근거로 평가·종합·보고서·검증을 마친다 → {ok: true, status} */
  async finishEarly(id) {
    const run = await this._run(id);
    if (run.sample || run.demo || run.rewrite) {
      throw new BackendError('not_supported', '이 실행은 일찍 마무리할 수 없습니다.', 409);
    }
    if (!run.active) throw new BackendError('not_running', '진행 중인 실행이 아닙니다.', 409);
    if (run.finish_requested) return { ok: true, status: run.snapshot() };     // 이미 요청됨(멱등)
    if (run.status !== 'running' || !run.agent || !FINISH_STAGES.includes(run.stage)) {
      throw new BackendError('not_now', '자료 탐색이 시작된 뒤에 마무리할 수 있습니다.', 409);
    }
    run.agent.requestFinish();
    run.finish_requested = true;
    run.emit(run.stage, 'finish_early', FINISH_MSG, null);
    run.save(true);
    return { ok: true, status: run.snapshot() };
  }

  async remove(id) {
    const run = await this._run(id);
    if (run.sample) throw readOnly('삭제할 수 없습니다.');
    if (run.active) throw new BackendError('running', '진행 중인 실행은 삭제할 수 없습니다. 먼저 취소해 주세요.', 409);
    if (run.task) await run.task.catch(() => {});
    run.stopTimers();
    run.deleted = true;           // 이후 저장은 아무것도 하지 않는다(기록이 되살아나지 않게)
    this._runs.delete(id);
    this._exports.delete(id);
    this._decks.delete(id);
    for (const store of ['runs', 'events', 'results', 'checkpoints', 'qa']) run._write(store, id, null, true);
    run._write('meta', `slides:${id}`, null, true);
    await run._chain;
    return { ok: true };
  }

  async result(id) {
    const [run, result] = await this._requireResult(id);
    const frag = renderFragment(result);
    const known = this._known(result);
    const qa = await this._qaItems(run);
    return {
      ...result, report_html: frag.html, toc: frag.toc, exports: this._exportsStatus(run),
      qa: qa.map((it) => this._qaView(it, known)),
      slides_source: await this._deckSource(run, result),     // 지금 PowerPoint를 받으면 쓰일 구성안: llm | sample | rules
      parent_id: run.parent_id ?? result.meta?.parent_id ?? null, custom_title: run.custom_title, imported: run.imported,
    };
  }

  // ── 후속 질문 ──
  _known(result) {
    return (Array.isArray(result.sources) ? result.sources : []).map((s) => s?.sid).filter(Boolean);
  }

  _qaView(item, known) {
    return { ...item, answer_html: renderMarkdown(item.answer_markdown || '', known) };
  }

  async _qaItems(run) {
    try {
      return cleanQa(await this.storage.get('qa', run.id));
    } catch {
      return [];
    }
  }

  /** Q&A 기록 덧붙이기 (실행마다 순서대로; 샘플도 저장소에 남긴다) */
  _appendQa(run, item) {
    const prev = this._qaChains.get(run.id) || Promise.resolve();
    const next = prev.then(async () => {
      if (run.deleted) return;
      const items = await this._qaItems(run);
      items.push(item);
      await this.storage.put('qa', run.id, items);
    }).catch((e) => {
      if (globalThis.console) console.warn('[저장소] Q&A 저장 실패', e?.name);
    });
    this._qaChains.set(run.id, next);
    return next;
  }

  async qa(id) {
    const [run, result] = await this._requireResult(id);
    const known = this._known(result);
    return { items: (await this._qaItems(run)).map((it) => this._qaView(it, known)) };
  }

  /** body: {question, api_key, model} → {question, answer_markdown, answer_html, sources, ts} */
  async ask(id, body = {}) {
    const [run, result] = await this._requireResult(id);
    body = isObj(body) ? body : {};
    const q = typeof body.question === 'string' ? body.question.trim() : '';
    if (!q) throw new BackendError('empty_question', '질문을 입력해 주세요.', 400);
    if (cpLength(q) > MAX_QUESTION) throw new BackendError('question_too_long', `질문은 ${MAX_QUESTION}자 이하로 입력해 주세요.`, 400);
    this._checkModel(body.model);
    const keyRaw = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    let ans;
    if (!keyRaw && run.demo) {
      ans = demoAnswer(result, q);          // 데모 실행: 키가 없으면 LLM 없이 관련 근거 목록
    } else {
      const key = this._key(body.api_key);
      const model = body.model || result.meta?.model || run.config.model;
      const history = (await this._qaItems(run)).slice(-3);
      ans = await this._llmCall(() => answerQuestion(this._llmFactory({ apiKey: key, model, onWarning: null, signal: null }),
        result, q, history));
    }
    const item = { question: q, answer_markdown: String(ans.answer_markdown || ''), sources: [...(ans.sources || [])], ts: this._iso() };
    await this._appendQa(run, item);
    return this._qaView(item, this._known(result));
  }

  // ── 새 기능 ──
  /** 체크포인트에서 이어서 실행한다(같은 id, 이벤트 seq는 이어서). 데모 실행은 키 없이. */
  async resume(id, body = {}) {
    const run = await this._run(id);
    body = isObj(body) ? body : {};
    const notResumable = (msg = '이 실행은 이어서 진행할 수 없습니다. 처음부터 다시 실행해 주세요.') =>
      new BackendError('not_resumable', msg, 409);
    if (run.sample || run.imported) throw notResumable('샘플이나 가져온 실행은 이어서 진행할 수 없습니다.');
    if (run.active) throw new BackendError('running', '이미 진행 중인 실행입니다.', 409);
    if (!run.resumable || !['interrupted', 'error'].includes(run.status)) throw notResumable();
    let checkpoint = null;
    try {
      checkpoint = await this.storage.get('checkpoints', id);
    } catch {
      checkpoint = null;
    }
    if (!isObj(checkpoint)) {
      run.resumable = false;
      run.save(true);
      throw notResumable('저장된 체크포인트가 없어 이어서 진행할 수 없습니다. 처음부터 다시 실행해 주세요.');
    }
    const key = run.demo ? null : this._key(body.api_key);
    await run.ensureEvents();
    if (run.active) throw new BackendError('running', '이미 진행 중인 실행입니다.', 409);
    this._checkCapacity();
    run.apiKey = key;
    run.persist = true;
    run.exports = Object.fromEntries(run.formats.map((f) => [f, 'pending']));
    this._start(run, checkpoint);
    return { ok: true, id, status: run.snapshot() };
  }

  /** 기록 목록의 제목 바꾸기(custom_title). 빈 제목이면 원래 주제로 되돌린다. */
  async rename(id, title) {
    const run = await this._run(id);
    if (run.sample) throw readOnly('이름을 바꿀 수 없습니다.');
    const t = cpHead(String(title ?? '').replace(/\s+/g, ' ').trim(), MAX_TITLE).trim();
    run.custom_title = t || null;
    await run.save(true);
    return { ok: true, custom_title: run.custom_title };
  }

  /** 조사 파일 저장: {filename, mime: 'application/json', data} */
  async exportRunFile(id) {
    const [run, result] = await this._requireResult(id);
    const events = await run.ensureEvents();
    const qa = await this._qaItems(run);
    return { filename: runFileName(result), mime: 'application/json', data: buildRunFile(result, events, qa, { now: this._now }) };
  }

  /** 조사 파일 열기: 검사한 뒤 가져온 실행(읽기 전용)으로 추가 → {id} */
  async importRunFile(text) {
    await this.ready;
    const parsed = parseRunFile(text);
    const res = normalizeImported(JSON.parse(JSON.stringify(parsed.result)));
    const meta = isObj(res.meta) ? res.meta : {};
    res.meta = meta;
    const id = this._newId('imp_');
    if (typeof res.id === 'string' && res.id) meta.imported_from = res.id;
    res.id = id;
    const cfg = RunConfig.fromDict(isObj(meta.config) ? meta.config : { model: str(meta.model) || undefined });
    const run = new Run(id, str(res.prompt) || str(res.topic), cfg,
      { demo: Boolean(meta.demo), note: str(meta.note), now: this._now }).attach(this.storage);
    Object.assign(run, {
      status: 'done', stage: 'done', topic: cpHead(str(res.topic), 200) || run.topic, model: str(meta.model) || cfg.model,
      created_at: str(meta.created_at) || run.created_at, started_at: str(meta.created_at) || null,
      finished_at: str(meta.finished_at) || null, elapsed_s: num(meta.elapsed_s) || 0, has_result: true,
      imported: true, imported_at: this._iso(), formats: [], exports: {}, plan: isObj(res.plan) ? res.plan : null,
    });
    const c = isObj(meta.counts) ? meta.counts : {};
    run.counts = Object.fromEntries(Object.keys(EMPTY_COUNTS).map((k) => [k, Number.isInteger(c[k]) ? c[k] : 0]));
    const u = isObj(meta.usage) ? meta.usage : {};
    run.usage = { calls: num(u.calls) || 0, input_tokens: num(u.input_tokens) || 0, output_tokens: num(u.output_tokens) || 0,
      cost_usd: num(u.cost_usd) };
    run._events = parsed.events;
    run.resultCache = res;
    run.persistError = null;
    run._write('results', id, res);
    run._write('events', id, parsed.events);
    if (parsed.qa.length) run._write('qa', id, parsed.qa);
    run.save(true);
    await run._chain;
    if (run.persistError) {
      throw new BackendError('storage_error', '가져온 조사 파일을 브라우저 저장소에 저장하지 못했습니다. 저장 공간을 확인해 주세요.', 500);
    }
    this._runs.set(id, run);
    return { id };
  }

  /** 보고서 다시 쓰기: 새 실행(parent_id = id)을 만들어 ⑦ 보고서 작성 + ⑧ 인용 검증만 실행 → {id, status} */
  async rewriteReport(id, body = {}) {
    const [parent, prev] = await this._requireResult(id);
    body = isObj(body) ? body : {};
    const key = this._key(body.api_key);
    this._checkModel(body.model);
    const pmeta = isObj(prev.meta) ? prev.meta : {};
    const model = body.model || pmeta.model || parent.config.model;
    const language = ['ko', 'en'].includes(body.language) ? body.language : (prev.lang === 'en' ? 'en' : 'ko');
    const length = Object.hasOwn(REPORT_LENGTHS, body.length) ? body.length : 'standard';
    const extra = cpHead(typeof body.extra === 'string' ? body.extra.trim() : '', 500);
    const base = isObj(pmeta.config) ? pmeta.config : parent.config.toDict();
    const cfg = RunConfig.fromDict({ ...base, model, language, human_in_the_loop: false });
    const formats = (parent.sample || parent.imported || parent.demo ? ['md'] : parent.formats).filter((f) => FORMAT_IDS.includes(f));
    cfg.formats = formats.length ? formats : ['md'];
    cfg.max_cost_usd = null;
    this._checkCapacity();
    const nid = this._newId('r');
    const run = new Run(nid, str(prev.prompt) || parent.prompt, cfg, { now: this._now }).attach(this.storage);
    run.parent_id = parent.id;
    run.rewrite = { language, length, extra };
    run.topic = str(prev.topic) || run.topic;
    if (isObj(prev.plan)) run.setPlan(prev.plan);
    run.counts = { ...EMPTY_COUNTS, ...(isObj(pmeta.counts) ? pmeta.counts : {}), report_evidence: 0 };
    run.apiKey = key;
    this._runs.set(nid, run);
    await this._register(run);
    // 페이지를 새로 열어도 다시 쓰기를 이어 갈 수 있게(⑦⑧을 처음부터 다시 실행)
    await this._saveCheckpoint(run, { kind: 'rewrite' });
    this._start(run);
    return { id: nid, status: run.snapshot() };
  }

  /** 주제 다듬기: {api_key, prompt, language, model} → {suggestions: [3개], questions} */
  async refinePrompt(body = {}) {
    await this.ready;
    body = isObj(body) ? body : {};
    const draft = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!draft) throw new BackendError('empty_prompt', '다듬을 주제나 요청문을 먼저 입력해 주세요.', 400);
    if (cpLength(draft) > MAX_PROMPT) throw new BackendError('prompt_too_long', `요청은 ${MAX_PROMPT}자 이하로 입력해 주세요.`, 400);
    const key = this._key(body.api_key);
    this._checkModel(body.model);
    const model = body.model || REFINE_MODEL;
    const lang = ['ko', 'en', 'auto'].includes(body.language) ? body.language : 'auto';
    return this._llmCall(() => refineDraft(this._llmFactory({ apiKey: key, model, onWarning: null, signal: null }), draft, lang));
  }

  /** 진행 중인 실행이 있는지 (페이지 떠나기 경고용, 동기) */
  hasActiveRuns() {
    for (const r of this._runs.values()) if (r.active) return true;
    return false;
  }

  /** 실행 작업이 끝날 때까지 기다린다 → 마지막 스냅샷 (테스트·통합용) */
  async waitForRun(id) {
    await this.ready;
    const run = this._runs.get(id);
    if (!run) return null;
    if (run.task) await run.task.catch(() => {});
    return run.snapshot();
  }

  /** 페이지 종료 흉내(테스트용): 진행 중인 실행을 저장소에 더 쓰지 않고 멈춘다. */
  async dispose() {
    await this.ready;
    const tasks = [];
    for (const run of this._runs.values()) {
      if (run.active) {
        run.persist = false;
        run.stopTimers();
        run.cancel();
        if (run.task) tasks.push(run.task);
      }
    }
    await Promise.allSettled(tasks);
    for (const run of this._runs.values()) run.stopTimers();
  }
}

/**
 * 브라우저 백엔드를 만든다.
 * @param {object} opts
 * @param {object} [opts.storage]      Storage(IndexedDBStorage | MemoryStorage). 기본 MemoryStorage
 * @param {(o: {apiKey, model, onWarning, signal}) => object} [opts.llmFactory]  기본 new LLM(o)
 * @param {object} [opts.tools]        {도구 이름: 함수}. 기본 TOOL_FUNCS
 * @param {(path: string) => Promise<string>} [opts.loadSample]  data/samples/ 아래 상대 경로('index.json', '<id>/run.json' …)의 내용
 * @param {() => Date} [opts.now]      현재 시각(테스트용)
 * @param {number} [opts.sampleSpeed]  데모 재생 추가 배속(테스트용, 기본 1)
 * @param {(apiKey: string) => Promise<string[]>} [opts.listModels]  키 확인용(기본 engine/llm.js listModels)
 */
export function createBackend(opts = {}) {
  return new Backend(opts || {});
}

export { ACTIVE, MAX_ACTIVE };

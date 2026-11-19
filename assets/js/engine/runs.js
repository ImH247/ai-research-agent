// 실행 1건의 메모리 상태(Run)와 파이프라인 훅(BackendHooks). (원본: server/runs.py의 Run, _Hooks)
//
// 에이전트가 훅으로 알려 주는 이벤트를 Run이 받아 상태 스냅샷(PYTHON_SPEC 3.4)을 갱신한다.
// 브라우저 버전 변경점:
// - 스레드 대신 async. 계획 검토 대기는 Promise로 기다리고, 취소는 그 Promise를 RunCancelled로 끝낸다.
// - 파일 대신 Storage(storage.js). 스냅샷은 단계가 바뀔 때·끝날 때 바로, 그 밖에는 2초에 한 번까지만 저장한다.
//   이벤트는 모아서(1초) 실행별 배열로 저장한다. 쓰기는 실행마다 한 줄로 세워(순서 보장) 처리하고, 실패는 persistError에 남긴다.
// - API 키는 Run 객체 속성(apiKey)으로만 들고 있고 스냅샷·저장소·이벤트에는 절대 넣지 않는다. 실행이 끝나면 지운다.

import { RunCancelled } from './llm.js';
import { RunConfig, estimateCost, modelLabel } from './models.js';
import { RunHooks } from './pipeline.js';
import { TOOL_FUNCS } from './tools.js';

export const TRACE_KINDS = new Set(['understanding', 'window', 'plan', 'plan_review', 'tool_disabled', 'subq_done', 'evaluate',
  'reflection', 'replan', 'report', 'verify', 'repair', 'budget', 'finish_early']);
export const ACTIVE = Object.freeze(['queued', 'running', 'awaiting_plan']);
export const MAX_ACTIVE = 2;               // 동시에 진행할 수 있는 실행 수
export const MAX_PROMPT = 4000;
export const MAX_QUESTION = 2000;
export const MAX_TITLE = 80;
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
export const EMPTY_COUNTS = Object.freeze({ collected: 0, included: 0, merged: 0, report_evidence: 0, sub_questions: 0 });
// LLM 오류 코드 → 상태 코드 (Q&A·슬라이드·주제 다듬기에서 사용)
export const LLM_STATUS = { auth: 401, permission: 403, rate_limit: 429, connection: 502, server: 502, unknown: 502 };
// 오류로 끝났어도 체크포인트에서 이어 갈 수 있는 오류 코드.
// 일시적인 문제(connection·server·rate_limit·unknown)와, 키를 바꾸거나 크레딧을 채우면 풀리는 문제(billing·auth·permission)
export const RESUMABLE_CODES = new Set(['connection', 'server', 'rate_limit', 'unknown', 'billing', 'auth', 'permission']);
const SAVE_EVERY_MS = 2000;
const EVENTS_EVERY_MS = 1000;
// 스냅샷에 들어가는 키 (from_snapshot에서 되살리는 순서)
const RESTORE_KEYS = ['status', 'topic', 'model', 'created_at', 'started_at', 'finished_at', 'elapsed_s', 'stage', 'round',
  'progress', 'counts', 'usage', 'plan', 'awaiting', 'error', 'formats', 'exports', 'has_result',
  'resumable', 'parent_id', 'imported', 'imported_at', 'custom_title', 'demo_speed', 'rewrite', 'wait_s', 'finish_requested'];

/** 화면이 그대로 보여 줄 수 있는 오류 (원본 RunError). code·message(한국어)·status(HTTP 상태 코드와 같은 의미). */
export class BackendError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 지역 시각 ISO 문자열(초 단위, 시간대 없음) — 원본 datetime.now().isoformat(timespec="seconds") */
export function isoLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'YYYYMMDD_HHMMSS' (실행 id용) */
export function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 16진수 n자리 난수 */
export function randomHex(n = 4) {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => pad(b.toString(16))).join('').slice(0, n);
}

/** 코드포인트 수 (파이썬 len(str)과 같음) */
export function cpLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** 코드포인트 위치 start부터의 문자열 (파이썬 s[start:]) */
export function cpSliceFrom(s, start) {
  if (start <= 0) return s;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (n === start) return s.slice(i);
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return '';
}

/** 앞 n개 코드포인트 */
export function cpHead(s, n) {
  return Array.from(String(s || '')).slice(0, n).join('');
}

/** API 키 모양 검사: 인쇄 가능한 ASCII(공백 없음)만. 어긋난 키를 HTTP 헤더에 넣으면 오류 메시지에 키가 실릴 수 있어 미리 거른다. */
export function keyFormatOk(key) {
  return !key || (key.length <= 400 && /^[\x21-\x7e]+$/.test(key));
}

const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;

/** 사용자·저장소에 남길 문구 정리: 혹시 들어 있는 API 키는 가린다. */
export function cleanText(text, apiKey = null) {
  let s = String(text ?? '');
  if (apiKey) s = s.split(apiKey).join('***');
  return s.replace(KEY_RE, 'sk-ant-***');
}

/** 계획 검토 결정을 검사하고 필요한 필드만 남긴다. 잘못되면 BackendError(invalid_plan). */
export function validateDecision(d) {
  const bad = (msg) => new BackendError('invalid_plan', msg, 400);
  if (!d || typeof d !== 'object' || !['approve', 'revise'].includes(d.action)) throw bad('action은 approve 또는 revise여야 합니다.');
  if (d.action === 'revise') {
    const fb = d.feedback ?? '';
    if (typeof fb !== 'string' || fb.length > 2000) throw bad('피드백은 2000자 이하의 글이어야 합니다.');
    if (!fb.trim()) throw bad('다시 계획하려면 의견(feedback)을 입력해 주세요.');
    return { action: 'revise', feedback: fb.trim() };
  }
  const sqs = d.sub_questions;
  if (sqs === null || sqs === undefined) return { action: 'approve' };
  if (!Array.isArray(sqs) || sqs.length < 1 || sqs.length > 8) throw bad('하위 질문은 1~8개여야 합니다.');
  const toolNames = new Set([...Object.keys(TOOL_FUNCS), 'web_search']);
  const out = [];
  for (const sq of sqs) {
    const q = sq && typeof sq === 'object' ? sq.question : null;
    if (typeof q !== 'string' || !q.trim() || q.length > 500) throw bad('하위 질문마다 500자 이하의 질문(question)이 있어야 합니다.');
    const item = { question: q.trim() };
    for (const k of ['perspective', 'rationale']) {
      if (typeof sq[k] === 'string' && sq[k].trim()) item[k] = sq[k].trim().slice(0, 500);
    }
    if (Array.isArray(sq.search_queries)) {
      item.search_queries = sq.search_queries.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 300)).slice(0, 8);
    }
    if (Array.isArray(sq.preferred_tools)) {
      const tools = sq.preferred_tools.filter((t) => toolNames.has(t));
      if (tools.length) item.preferred_tools = tools;
    }
    out.push(item);
  }
  return { action: 'approve', sub_questions: out };
}

/** 저장된 이벤트 배열 검사: 깨진 항목은 그 항목만 건너뛴다. */
export function cleanEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ev of list) {
    if (!ev || typeof ev !== 'object' || !Number.isInteger(ev.seq)) continue;
    if (!['ts', 'stage', 'kind', 'msg'].every((k) => typeof ev[k] === 'string')) continue;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : null;
    out.push({ seq: ev.seq, ts: ev.ts, stage: ev.stage, kind: ev.kind, msg: ev.msg, data });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.filter((e, i) => i === 0 || e.seq !== out[i - 1].seq);
}

function deepCopy(x) {
  return x === undefined || x === null ? x ?? null : JSON.parse(JSON.stringify(x));
}

/** 실행 1건의 메모리 상태. snapshot()이 PYTHON_SPEC 3.4의 run.json(+ 웹 버전 필드)이다. */
export class Run {
  /**
   * @param {string} id
   * @param {string} prompt
   * @param {RunConfig|object} config
   * @param {{sample?: boolean, demo?: boolean, note?: string, now?: () => Date}} [opts]
   */
  constructor(id, prompt, config, { sample = false, demo = false, note = '', now = () => new Date() } = {}) {
    this.id = id;
    this.prompt = String(prompt || '');
    this.config = config instanceof RunConfig ? config : RunConfig.fromDict(config || {});
    this._now = now;
    this.status = 'queued';
    this.topic = cpHead(this.prompt, 80);
    this.model = this.config.model;
    this.created_at = isoLocal(now());
    this.started_at = null;
    this.finished_at = null;
    this.elapsed_s = 0;
    this.stage = 'system';
    this.round = 1;
    this.progress = null;
    this.counts = { ...EMPTY_COUNTS };
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: estimateCost(this.model, 0, 0) };
    this.plan = null;
    this.awaiting = null;
    this.error = null;
    this.formats = [...(this.config.formats || [])];
    this.exports = Object.fromEntries(this.formats.map((f) => [f, 'pending']));
    this.has_result = false;
    this.sample = sample;
    this.demo = demo;
    this.note = note;
    // 웹 버전 추가 필드 (스냅샷에 들어감)
    this.resumable = false;
    this.parent_id = null;          // 보고서 다시 쓰기로 만든 실행이면 원래 실행 id
    this.imported = false;          // 조사 파일에서 가져온 실행
    this.imported_at = null;
    this.custom_title = null;       // 사용자가 바꾼 기록 제목
    this.demo_speed = null;         // 데모 실행의 재생 속도
    this.rewrite = null;            // 보고서 다시 쓰기 옵션 {language, length, extra}
    this.wait_s = 0;                // 계획 검토(awaiting_plan)로 기다린 시간의 합(초, 끝난 대기만). 스냅샷에는 지금 대기까지 더한다
    this.finish_requested = false;  // 사용자가 '지금 마무리'를 요청했는지
    // 메모리 전용 (스냅샷·저장소에 넣지 않음)
    this.apiKey = null;
    this.llm = null;
    this.agent = null;
    this.task = null;               // 실행 중인 작업(Promise)
    this.controller = null;         // 취소용 AbortController
    this.resultCache = null;
    this.deleted = false;           // 삭제된 실행은 저장소에 더 쓰지 않는다
    this.persist = true;            // false면 저장소에 더 쓰지 않는다(페이지 종료 흉내·샘플)
    this.persistError = null;       // 마지막 저장 실패(메모리에만)
    this._persistWarned = false;    // 진행 중 저장 실패를 이미 알렸는지(실행마다 한 번)
    this._storage = null;
    this._events = [];
    this._loadEvents = null;        // 이벤트를 처음 요청할 때 불러오는 함수(지난 실행·샘플)
    this._preview = '';
    this._previewCp = 0;
    this._cancel = false;
    this._waiter = null;
    this._t0 = null;
    this._waitT0 = null;            // 지금 계획 검토 대기를 시작한 시각(ms)
    this._chain = Promise.resolve();
    this._lastSave = 0;
    this._saveTimer = null;
    this._eventsTimer = null;
    this._eventsDirty = false;
  }

  /** 저장된 스냅샷으로 지난 실행을 되살린다(이벤트는 처음 요청될 때 읽음). */
  static fromSnapshot(snap, { sample = false, now = () => new Date() } = {}) {
    const run = new Run(snap.id, snap.prompt || '', RunConfig.fromDict(snap.config || {}),
      { sample: sample || Boolean(snap.sample), demo: Boolean(snap.demo), note: snap.note || '', now });
    for (const k of RESTORE_KEYS) {
      if (k in snap && snap[k] !== null && snap[k] !== undefined) run[k] = deepCopy(snap[k]);
    }
    run.exports = { ...(run.exports || {}) };
    run.counts = { ...EMPTY_COUNTS, ...(run.counts || {}) };
    run._events = null;
    return run;
  }

  /** 저장소 연결 (샘플은 연결하지 않는다 → 읽기 전용) */
  attach(storage) {
    this._storage = storage;
    return this;
  }

  get active() {
    return ACTIVE.includes(this.status);
  }

  // ── 스냅샷 ──
  _nowMs() {
    return this._now().getTime();
  }

  elapsed() {
    if (this._t0 !== null && this.active) return Math.round((this._nowMs() - this._t0) / 100) / 10;
    return this.elapsed_s;
  }

  /** 계획 검토로 기다린 시간의 합(초). 지금 기다리는 중이면 그 시간까지 더한다. */
  waitSeconds() {
    let ms = (Number(this.wait_s) || 0) * 1000;
    if (this._waitT0 !== null && this.status === 'awaiting_plan') ms += Math.max(0, this._nowMs() - this._waitT0);
    return Math.round(ms / 100) / 10;
  }

  liveUsage() {
    if (!this.llm) return { ...this.usage };
    const u = this.llm.usage || {};
    const inp = Number(u.input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const web = Number(u.web_searches) || 0;
    // 비용 한도가 비교하는 값(llm.costUsd())과 화면에 보이는 비용이 같도록 클라이언트의 계산을 먼저 쓴다
    let cost = typeof this.llm.costUsd === 'function' ? this.llm.costUsd() : undefined;
    if (cost === undefined || (cost !== null && !Number.isFinite(Number(cost)))) cost = estimateCost(this.model, inp, out, web);
    return { calls: Number(u.calls) || 0, input_tokens: inp, output_tokens: out, web_searches: web, cost_usd: cost };
  }

  snapshot() {
    return {
      id: this.id, status: this.status, prompt: this.prompt, topic: this.topic,
      model: this.model, model_label: modelLabel(this.model), config: this.config.toDict(),
      created_at: this.created_at, started_at: this.started_at, finished_at: this.finished_at,
      elapsed_s: this.elapsed(), wait_s: this.waitSeconds(), stage: this.stage, round: this.round,
      progress: deepCopy(this.progress), counts: { ...this.counts }, usage: this.liveUsage(),
      plan: deepCopy(this.plan), awaiting: this.awaiting, error: deepCopy(this.error),
      formats: [...this.formats], exports: { ...this.exports }, has_result: this.has_result,
      sample: this.sample, demo: this.demo, note: this.note,
      resumable: this.resumable, parent_id: this.parent_id, imported: this.imported, imported_at: this.imported_at,
      custom_title: this.custom_title, demo_speed: this.demo_speed, rewrite: deepCopy(this.rewrite),
      finish_requested: this.finish_requested,
    };
  }

  summary() {
    const s = this.snapshot();
    const keys = ['id', 'topic', 'prompt', 'model', 'model_label', 'status', 'stage', 'created_at', 'elapsed_s',
      'counts', 'usage', 'sample', 'demo', 'note', 'has_result', 'resumable', 'parent_id', 'imported', 'custom_title'];
    return Object.fromEntries(keys.map((k) => [k, s[k]]));
  }

  // ── 저장 ──
  /** 저장소 쓰기를 이 실행의 줄에 세운다(순서 보장). 실패는 던지지 않고 persistError에 남긴다. */
  _write(store, key, value, del = false) {
    this._chain = this._chain.then(async () => {
      if (!this._storage || !this.persist || (this.deleted && !del)) return;
      try {
        if (del) await this._storage.delete(store, key);
        else await this._storage.put(store, key, value);
      } catch (e) {
        this.persistError = `${store} 저장 실패 (${e?.name || 'Error'})`;
        if (globalThis.console) console.warn(`[저장소] ${this.persistError}`);
      }
    });
    return this._chain;
  }

  /** 스냅샷 저장. force가 아니면 2초에 한 번까지만(남은 변경은 잠시 뒤 한 번에). */
  save(force = false) {
    if (!this._storage || this.sample || this.deleted || !this.persist) return Promise.resolve();
    const t = Date.now();
    if (!force && t - this._lastSave < SAVE_EVERY_MS) {
      if (!this._saveTimer) {
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(true); }, SAVE_EVERY_MS - (t - this._lastSave));
        this._saveTimer?.unref?.();
      }
      return this._chain;
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._lastSave = t;
    return this._write('runs', this.id, this.snapshot());
  }

  /** 모아 둔 이벤트를 저장한다. */
  flushEvents() {
    if (this._eventsTimer) {
      clearTimeout(this._eventsTimer);
      this._eventsTimer = null;
    }
    if (!this._eventsDirty || !this._events) return this._chain;
    this._eventsDirty = false;
    return this._write('events', this.id, this._events.slice());
  }

  _queueEvents() {
    if (!this._storage || this.sample || !this.persist) return;
    this._eventsDirty = true;
    if (!this._eventsTimer) {
      this._eventsTimer = setTimeout(() => { this._eventsTimer = null; this.flushEvents(); }, EVENTS_EVERY_MS);
      this._eventsTimer?.unref?.();
    }
  }

  /** 미뤄 둔 쓰기를 모두 내보내고 끝날 때까지 기다린다. */
  async flush() {
    if (this._saveTimer) this.save(true);
    this.flushEvents();
    await this._chain;
  }

  /** 타이머만 멈춘다(저장하지 않음). */
  stopTimers() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (this._eventsTimer) clearTimeout(this._eventsTimer);
    this._saveTimer = this._eventsTimer = null;
  }

  // ── 이벤트 ──
  async ensureEvents() {
    if (this._events === null) {
      let list = [];
      try {
        list = this._loadEvents ? await this._loadEvents() : [];
      } catch {
        list = [];
      }
      if (this._events === null) this._events = cleanEvents(list);
    }
    return this._events;
  }

  /** after보다 큰 seq의 이벤트 (ensureEvents() 뒤에 부른다) */
  eventsAfter(after) {
    return (this._events || []).filter((e) => e.seq > after);
  }

  trace() {
    return (this._events || []).filter((e) => TRACE_KINDS.has(e.kind))
      .map((e) => ({ ts: e.ts, stage: e.stage, kind: e.kind, msg: e.msg }));
  }

  /** 이벤트를 기록하고(메모리 + 모아서 저장) 종류에 따라 상태를 갱신한다. */
  emit(stage, kind, msg, data = null) {
    const key = this.apiKey;
    let d = null;
    if (data !== null && data !== undefined) {
      let s = JSON.stringify(data) ?? 'null';
      if (key && s.includes(key)) s = s.split(key).join('***');
      d = JSON.parse(s);
    }
    if (this._events === null) this._events = [];
    const events = this._events;
    const seq = (events.length ? events[events.length - 1].seq : 0) + 1;   // 건너뛴 항목이 있어도 번호가 겹치지 않게
    const ev = { seq, ts: isoLocal(this._now()), stage: String(stage), kind: String(kind), msg: cleanText(String(msg ?? ''), key), data: d };
    events.push(ev);
    this._queueEvents();
    if (this._apply(ev)) {
      this.save(true);
      this.flushEvents();
    } else {
      this.save();
    }
    return ev;
  }

  /** 이벤트 → 상태(단계, 라운드, 집계, 계획). 단계가 바뀌었으면 true. */
  _apply(ev) {
    const kind = ev.kind;
    const d = ev.data || {};
    if (kind === 'stage') {
      if (d.status === 'start') {
        this.stage = ev.stage;
        this.round = Number.parseInt(d.round, 10) || this.round;
        this.progress = null;
        if (this.stage === 'report') {
          this._preview = '';
          this._previewCp = 0;
        }
        return true;
      }
      return false;
    }
    if (kind === 'understanding' && d.topic) {
      this.topic = String(d.topic);
    } else if (kind === 'plan' || kind === 'replan') {
      if (this.agent && this.agent.plan && Object.keys(this.agent.plan).length) this.plan = deepCopy(this.agent.plan);
      if (this.plan) this.counts.sub_questions = (this.plan.sub_questions || []).length;
    } else if (kind === 'tool' && Number.isInteger(d.total)) {
      this.counts.collected = d.total;
    } else if (kind === 'evaluate') {
      for (const [src, dst] of [['included', 'included'], ['merged', 'merged'], ['total', 'collected']]) {
        if (Number.isInteger(d[src])) this.counts[dst] = d[src];
      }
    } else if (kind === 'report' && Number.isInteger(d.evidence)) {
      this.counts.report_evidence = d.evidence;
    }
    return false;
  }

  // ── 에이전트·데모가 부르는 상태 변경 ──
  setProgress(stage, done, total, label = '') {
    this.progress = { done, total, label };
    this.save();
  }

  setPlan(plan) {
    this.plan = deepCopy(plan);
    this.counts.sub_questions = ((plan && plan.sub_questions) || []).length;
  }

  setUsage(usage) {
    this.usage = { ...usage };
  }

  setExport(fmt, state) {
    if (this.deleted) return;
    this.exports[fmt] = state;
    if (!this.active) this.save(true);
  }

  /** 취소 요청이 있으면 RunCancelled */
  async checkpoint() {
    if (this._cancel) throw new RunCancelled();
  }

  reportDelta(text) {
    const t = String(text ?? '');
    this._preview += t;
    this._previewCp += cpLength(t);
  }

  /** 보고서 작성 중일 때만 미리보기 텍스트를 start 위치(코드포인트)부터 돌려준다. */
  preview(start = 0) {
    if (this.stage !== 'report' || this.status !== 'running') return null;
    const total = this._previewCp;
    const s = Math.max(0, Math.min(Math.trunc(Number(start) || 0), total));
    const text = this._preview.length === total ? this._preview.slice(s) : cpSliceFrom(this._preview, s);
    return { from: s, text, total };
  }

  /** 계획 검토: 상태를 awaiting_plan으로 바꾸고 submit()이 결정을 넘길 때까지 기다린다. 취소되면 RunCancelled. */
  async waitPlan(plan) {
    if (plan) this.setPlan(plan);
    this.awaiting = 'plan';
    this.status = 'awaiting_plan';
    this._waitT0 = this._nowMs();
    this.save(true);
    let decision;
    try {
      decision = await new Promise((resolve, reject) => {
        this._waiter = { resolve, reject };
        if (this._cancel) reject(new RunCancelled());
      });
    } finally {
      this._waiter = null;
      // 이번 대기 시간을 합에 더한다(취소돼도). 스냅샷의 wait_s는 이 합을 저장한다
      this.wait_s = Math.round(((Number(this.wait_s) || 0) + Math.max(0, this._nowMs() - this._waitT0) / 1000) * 10) / 10;
      this._waitT0 = null;
    }
    this.awaiting = null;
    this.status = 'running';
    this.save(true);
    await this.checkpoint();
    return decision;
  }

  submit(decision) {
    if (this.awaiting !== 'plan' || !this._waiter) return false;
    const w = this._waiter;
    this._waiter = null;
    w.resolve(decision);
    return true;
  }

  cancel() {
    if (!this.active) return false;
    this._cancel = true;
    try {
      this.controller?.abort();
    } catch { /* 무시 */ }
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w.reject(new RunCancelled());
    }
    return true;
  }

  /** 실행 시작(이어하기면 경과 시간을 이어서 센다). */
  start(resume = false) {
    this.status = 'running';
    this.error = null;
    this.finished_at = null;
    this.resumable = false;
    this._cancel = false;
    if (!this.started_at || !resume) this.started_at = isoLocal(this._now());
    this._t0 = this._nowMs() - (resume ? (Number(this.elapsed_s) || 0) * 1000 : 0);
    return this.save(true);
  }

  /** 실행 종료: 상태를 정리하고 키(LLM 클라이언트 포함)를 지운 뒤 저장한다. */
  finish(status, error = null) {
    this.usage = this.liveUsage();
    this.elapsed_s = this.elapsed();
    this.status = status;
    this.finished_at = isoLocal(this._now());
    this.error = error;
    this.awaiting = null;
    this.progress = null;
    if (status === 'done') this.stage = 'done';
    else this.exports = Object.fromEntries(Object.entries(this.exports).filter(([, v]) => v !== 'pending'));
    this.apiKey = null;
    this.llm = null;
    this.agent = null;
    this.controller = null;
    this._t0 = null;
    this.save(true);
    return this.flush();
  }
}

/** 파이프라인 콜백 → Run 상태. saveCheckpoint는 백엔드가 넘긴 함수로 저장한다. */
export class BackendHooks extends RunHooks {
  constructor(run, saveCheckpoint = null) {
    super();
    this.run = run;
    this._saveCheckpoint = saveCheckpoint;
    this.signal = run.controller ? run.controller.signal : null;
  }

  emit(stage, kind, msg, data = null) {
    this.run.emit(stage, kind, msg, data);
  }

  progress(stage, done, total, label = '') {
    this.run.setProgress(stage, done, total, label);
  }

  async checkpoint() {
    await this.run.checkpoint();
  }

  async reviewPlan(plan) {
    return this.run.waitPlan(plan);
  }

  reportDelta(text) {
    this.run.reportDelta(text);
  }

  async saveCheckpoint(state) {
    if (this._saveCheckpoint) await this._saveCheckpoint(state);
  }
}

// Research Agent 8단계 파이프라인. 노트북 셀 ⑤의 ResearchAgent를 옮겼다. (원본: agent/pipeline.py)
//
// ① 주제 이해 → ② 조사 계획(+사람 검토) → ③ 자료 탐색(Tool Use 루프) → ④ 자료 평가 → ⑤ 종합(RAG)
// → ⑥ 자기 비판·재조사 → ⑦ 보고서 작성 → ⑧ 인용 검증·수정.
// 전체 순서는 코드가 고정하고, 검색 단계만 LLM이 자율로 도구를 고른다.
//
// 파이썬 원본과 메서드 이름·순서를 맞췄다(snake_case → camelCase, 내부용은 앞에 _). 웹 버전 변경점(SITE_SPEC 3.5):
// 1. 스레드 대신 async: _map()이 cfg.parallelism개씩 동시에 실행하고, 첫 오류에서 나머지를 멈춘 뒤 원래 오류를 던진다.
// 2. 웹 검색은 Anthropic 서버 도구(web_search): 응답의 server_tool_use / web_search_tool_result 블록과 인용(citations)을 읽는다.
//    stop_reason이 pause_turn이면 받은 content를 덧붙이고 같은 루프를 계속한다.
// 3. 비용 한도(cfg.max_cost_usd): 닿으면 새 검색을 멈추고 모은 근거로 평가·종합·보고서·검증만 한다.
// 4. 체크포인트·이어하기: 단계가 끝날 때마다 hooks.saveCheckpoint(snapshotState()), fromState()로 복원 후 run().
// 5. 보고서 다시 쓰기: rewriteReport()가 끝난 결과로 ⑦⑧만 다시 실행한다.

import { LLMError, RunCancelled, friendlyError } from './llm.js';
import { CURRENT_YEAR, RunConfig } from './models.js';
import { ABSTRACT_RULE, SYS_BASE } from './prompts.js';
import { A, B, E, I, O, S } from './schema.js';
import { EvidenceStore, Source } from './sources.js';
import { cosineScores } from './tfidf.js';
import { TOOL_DESC, TOOL_FUNCS, TOOLS, WEB_SEARCH_DESC, webSearchToolFor, withToolLock } from './tools.js';

export const STUDY_TYPES = ['meta-analysis/systematic review', 'RCT/experiment', 'quasi-experiment', 'longitudinal',
  'survey/correlational', 'qualitative', 'mixed methods', 'case study',
  'theoretical/conceptual', 'review/commentary', 'report/web article', 'other'];
export const DESIGN_WEIGHT = {
  'meta-analysis/systematic review': 1.0, 'RCT/experiment': 0.9, 'quasi-experiment': 0.75,
  longitudinal: 0.7, 'mixed methods': 0.6, 'survey/correlational': 0.55, qualitative: 0.5,
  'case study': 0.4, 'review/commentary': 0.4, 'theoretical/conceptual': 0.35,
  'report/web article': 0.25, other: 0.3,
};
export const KIND_WEIGHT = { 'peer-reviewed': 0.6, academic: 0.45, preprint: 0.35, web: 0.15 };
// 웹 검색 결과 오류 중 요청 때문에 생긴 것(연속 실패로 세지 않음). unavailable·too_many_requests 등은 그대로 센다.
export const WEB_REQUEST_ERRORS = new Set(['max_uses_exceeded', 'query_too_long', 'invalid_input']);
export const TOOL_FAIL_LIMIT = 3;          // 같은 도구가 연속 3회 실패하면 이번 실행에서 제외 (예: Semantic Scholar 429 반복)
export const MAX_REPORT_EVIDENCE = 100;    // 최종 보고서에 넘길 근거 상한 (종합에 쓴 근거는 상한과 무관하게 전부 포함)
export const MAX_PLAN_REVISIONS = 5;       // 사람 검토에서 재계획을 요청할 수 있는 최대 횟수
export const REPORT_RETRIES = 2;           // 보고서 스트림이 일시 오류로 끊기면 다시 작성하는 최대 횟수
export const RETRYABLE_CODES = { connection: '연결 끊김', server: 'Anthropic 서버 일시 오류', rate_limit: '속도 제한' };
export const VERDICTS = ['supported', 'partially supported', 'not in source text', 'contradicted'];
export const STAGE_NAMES = {
  understand: '① 주제 이해', plan: '② 조사 계획', act: '③ 자료 탐색', evaluate: '④ 자료 평가',
  synthesize: '⑤ 종합', reflect: '⑥ 자기 비판', report: '⑦ 보고서 작성', verify: '⑧ 인용 검증',
};
export const STATE_VERSION = 1;
// 보고서 다시 쓰기의 분량 지시 (섹션 구성은 그대로 둔다)
export const REPORT_LENGTHS = {
  short: 'Length: concise, about 1,500-2,500 words in total. Keep every required section, but keep each one brief.',
  standard: '',
  detailed: 'Length: detailed, about 6,000-8,000 words in total, with more comparisons between studies and more tables. Keep the required sections.',
};

export const CITE = /\[S\d+(?:\s*,\s*S\d+)*\]/;
const CITE_G = /\[S\d+(?:\s*,\s*S\d+)*\]/g;
const SENT_END = /(?<=[.!?。])(?<!\bal\.)(?<!e\.g\.)(?<!i\.e\.)(?<!vs\.)\s+/g;
const json = (x) => JSON.stringify(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** 병렬 작업 중 다른 작업이 실패해 이 작업을 멈출 때 쓰는 내부 예외(바깥으로는 원래 예외가 전파된다). */
class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; }
}

/** 본문에서 [S3], [S1, S2] 형식으로 인용된 ID를 처음 나온 순서대로. */
export function citedIds(text) {
  const ids = (String(text || '').match(CITE_G) || []).join(' ').match(/S\d+/g) || [];
  return [...new Set(ids)];
}

/**
 * items 각각에 fn을 최대 limit개씩 동시에 적용해 입력 순서대로 결과를 돌려준다.
 * 첫 오류가 나면 새 작업을 시작하지 않고 onError()를 부른 뒤(→ 실행 중인 작업은 다음 checkpoint에서 멈춘다),
 * 실행 중이던 작업이 모두 끝나기를 기다렸다가 그 첫 오류를 던진다.
 */
export async function mapLimit(items, limit, fn, onError = null) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError = null;
  async function worker() {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
          if (onError) onError(e);
        }
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failed) throw firstError;
  return results;
}

/** 에이전트가 바깥(브라우저 백엔드·화면)과 소통하는 통로. 기본 구현: emit은 console.log, 나머지는 아무것도 안 함.
 * 선택: hooks.signal(AbortSignal)이 있으면 학술 DB 요청에 취소 신호로 넘긴다. */
export class RunHooks {
  emit(stage, kind, msg, data = null) {
    console.log(`[${String(stage).padEnd(10)}] ${msg}`);
  }

  progress(stage, done, total, label = '') {}

  /** 취소 요청이 있으면 RunCancelled를 던진다. */
  async checkpoint() {}

  /** 사용자가 답할 때까지 기다린다. {action: 'approve'} | {action: 'approve', sub_questions: [...]}
   * | {action: 'revise', feedback: '…'} */
  async reviewPlan(plan) {
    return { action: 'approve' };
  }

  /** 보고서 스트리밍 조각. */
  reportDelta(text) {}

  /** 단위(understand, plan, act, …)가 끝날 때마다 상태(snapshotState())를 받는다. */
  async saveCheckpoint(state) {}
}

export class ResearchAgent {
  /**
   * @param {string} prompt   사용자 요청문
   * @param {object} llm      LLM 또는 같은 인터페이스(FakeLLM)
   * @param {RunConfig} config
   * @param {RunHooks} [hooks]
   * @param {Object<string, Function>} [tools]  {도구 이름: 함수}. 기본은 TOOL_FUNCS (테스트에서 가짜 도구 주입)
   */
  constructor(prompt, llm, config, hooks = null, tools = null) {
    this.prompt = String(prompt || '').trim();
    this.topic = this.prompt;               // ① 단계에서 core_topic으로 바뀐다
    this.llm = llm;
    this.cfg = config instanceof RunConfig ? config : new RunConfig(config || {});
    this.hooks = hooks || new RunHooks();
    this.tools = { ...(tools || TOOL_FUNCS) };
    this.signal = this.hooks.signal || llm?.signal || null;   // 학술 DB 요청 취소용
    this.store = new EvidenceStore();
    this.understanding = {};
    this.plan = {};
    this.syntheses = {};
    this.reflections = [];
    this.lang = 'ko';
    this.yearFrom = null;
    this.yearFromSource = 'agent';
    this.yearFromReason = '';
    this.toolFailures = Object.fromEntries(Object.keys(this.tools).map((n) => [n, 0]));
    this.disabledTools = new Set();
    this.webSearchOff = false;            // 웹 검색을 이번 실행에서 껐는지(연속 실패 또는 API 거부)
    this.reportEvidence = [];
    this.reportMarkdown = '';
    this.verification = {};
    this.round = 1;                       // 1 = 첫 조사, 2부터 재조사 라운드
    this.budgetHit = false;               // 비용 한도에 닿았는지
    this.finishRequested = false;         // 사용자가 '지금 마무리'를 요청했는지 (비용 한도와 같은 자리에서 추가 조사를 멈춘다)
    this.done = null;                     // 마지막으로 끝난 단위 (체크포인트)
    this.reportOptions = { length: 'standard', extra: '' };   // 보고서 다시 쓰기에서만 바뀐다
    this._abort = false;                  // 병렬 작업 하나가 실패하면 설정(내부용, _map 참조)
    this._stageNow = 'system';
    this._webQueries = new Map();         // server_tool_use id → 검색어
    this._webWarned = false;
  }

  // ── 공용 도우미 ──
  _stage(stage, status) {
    const name = STAGE_NAMES[stage];
    const rnd = this.round > 1 ? ` (라운드 ${this.round})` : '';
    if (status === 'start') this._stageNow = stage;
    this.hooks.emit(stage, 'stage', `${name} ${status === 'start' ? '시작' : '완료'}${rnd}`,
      { status, round: this.round });
  }

  async _json(system, prompt, schema, effort = 'medium') {
    await this._checkpoint();
    const out = await this.llm.json(system, prompt, schema, { effort });
    this._checkBudget();
    return out;
  }

  /** LLM 호출이 끝날 때마다: 비용 한도에 닿았는지 확인하고 처음 닿았을 때 한 번 알린다. */
  _checkBudget() {
    const cap = this.cfg.max_cost_usd;
    if (cap === null || cap === undefined || this.budgetHit) return;
    const cost = typeof this.llm.costUsd === 'function' ? this.llm.costUsd() : null;
    if (cost === null || cost === undefined || cost < cap) return;
    this.budgetHit = true;
    this.hooks.emit(this._stageNow, 'budget',
      `비용 한도($${cap})에 도달했습니다: 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.`, { cap, cost });
  }

  /** 사용자의 '지금 마무리' 요청: 새 도구 라운드·보강 검색·재조사 라운드를 더 시작하지 않는다. 처음 요청이면 true. */
  requestFinish() {
    if (this.finishRequested) return false;
    this.finishRequested = true;
    return true;
  }

  /** 추가 조사를 멈춰야 하는지 (비용 한도 도달 또는 '지금 마무리' 요청). 검색을 시작하는 자리는 모두 이것을 본다. */
  _stopSearching() {
    return this.budgetHit || this.finishRequested;
  }

  /** items 각각에 fn을 적용해 입력 순서대로 결과를 돌려준다. cfg.parallelism개씩 동시에 실행하고,
   * 1이면 노트북처럼 순차 실행. 작업의 예외(RunCancelled 포함)는 여기서 다시 던져진다. */
  async _map(fn, items, stage, label) {
    const total = items.length;
    let done = 0;
    if (total) this.hooks.progress(stage, 0, total, label);
    const work = async (x) => {
      const out = await fn(x);
      done += 1;
      this.hooks.progress(stage, done, total, label);
      return out;
    };
    const workers = Math.max(1, Math.trunc(Number(this.cfg.parallelism) || 1));
    if (workers === 1 || total <= 1) {
      const out = [];
      for (const x of items) out.push(await work(x));
      return out;
    }
    try {
      // 다른 작업은 다음 checkpoint에서 멈춰 유료 호출을 더 하지 않는다
      return await mapLimit(items, workers, work, () => { this._abort = true; });
    } finally {
      this._abort = false;
    }
  }

  /** 취소 확인. 병렬 작업 중 하나가 실패했으면 나머지 작업도 여기서 멈춘다. */
  async _checkpoint() {
    if (this._abort) throw new Aborted();
    await this.hooks.checkpoint();
  }

  /** 코드가 직접 실행하는 도구 이름 (TOOL_DESC 순서 먼저) */
  _toolNames() {
    return [...Object.keys(TOOL_DESC).filter((n) => n in this.tools),
      ...Object.keys(this.tools).filter((n) => !(n in TOOL_DESC))];
  }

  _webSearchOn() {
    return Boolean(this.cfg.web_search) && !this.webSearchOff;
  }

  /** 계획에서 고를 수 있는 도구 이름 = 직접 실행 도구 + 웹 검색(켜져 있을 때) */
  _planToolNames() {
    return [...this._toolNames(), ...(this._webSearchOn() ? ['web_search'] : [])];
  }

  _langHint() {
    // ① 단계에서는 보고서 언어가 아직 없으므로 요청 언어로 받는다(설정이 ko/en이면 그 언어).
    return this.cfg.language === 'auto' ? 'the language of the request' : `language "${this.cfg.language}"`;
  }

  _requirementsLine() {
    const req = this.understanding.user_requirements || [];
    return req.length ? `User requirements to honor: ${json(req)}\n` : '';
  }

  // ── ① 주제 이해 ──
  async understand() {
    this._stage('understand', 'start');
    const schema = O({
      language: S, topic_en: S, discipline: S, research_type: S,
      key_concepts: A(O({ term: S, english: S, synonyms: A(S) })),
      independent_variables: A(S), dependent_variables: A(S), moderators_or_context: A(S),
      population: S, ambiguities: A(S), scope_decision: S, search_start_year: I, search_window_reason: S,
      core_topic: S, user_requirements: A(S),
    });
    const u = await this._json(SYS_BASE, `Analyze this user request before any searching. It may be a plain research topic or a free-form request.
User request: """${this.prompt}"""

- language: ISO code of the request text (e.g. "ko", "en").
- core_topic: a concise title of the research topic only, extracted from the request (in the request's language).
- user_requirements: explicit requirements stated in the request about scope, period, region, methods or emphasis
  (empty list if there are none; do not invent any).
- topic_en: faithful English translation of the core topic.
- discipline / research_type (e.g. causal-effect, descriptive, comparative, methodological, design).
- key_concepts with English academic terms and synonyms useful as search keywords.
- variables (independent / dependent / moderators-context), target population.
- ambiguities: terms that can be interpreted several ways, and scope_decision: how you will scope them
  (e.g. operational definitions such as how 'quality' could be measured).
- search_start_year: earliest publication year worth searching for THIS topic (e.g. when the technology or
  phenomenon appeared, so that early foundational studies are kept). Use 0 if older foundational work matters
  and no year limit should be applied. If the request states a period explicitly, follow it.
  Current year: ${CURRENT_YEAR}. search_window_reason: one sentence.
Write discipline, research_type, independent_variables, dependent_variables, moderators_or_context, population,
ambiguities, scope_decision, search_window_reason and user_requirements in ${this._langHint()}. Keep topic_en and the English terms/synonyms of key_concepts in English.`, schema, 'medium');
    if (!u) throw new LLMError('unknown', '주제 이해 단계 실패: 모델이 구조화된 응답을 주지 못했습니다.');
    this.understanding = u;
    this._applyUnderstanding();
    const userSet = this.cfg.year_from !== null && this.cfg.year_from !== undefined;
    const src = userSet ? '사용자 설정' : `에이전트 판단: ${String(u.search_window_reason || '').slice(0, 120)}`;
    const concepts = (u.key_concepts || []).map((c) => c.english);
    this.hooks.emit('understand', 'understanding',
      `분야=${u.discipline} | 유형=${u.research_type} | 개념=${concepts.join(', ')}`,
      { topic: this.topic, discipline: u.discipline, research_type: u.research_type,
        concepts, requirements: u.user_requirements || [] });
    this.hooks.emit('understand', 'window',
      `검색 기간: ${this.yearFrom ? `${this.yearFrom}년 이후` : '제한 없음'} (${src})`,
      { year_from: this.yearFrom, source: this.yearFromSource, reason: this.yearFromReason });
    this._stage('understand', 'end');
  }

  /** understanding에서 주제·보고서 언어·검색 기간을 정한다(이어하기에서도 같은 규칙으로 다시 계산). */
  _applyUnderstanding() {
    const u = this.understanding || {};
    this.topic = String(u.core_topic || '').trim() || this.prompt;
    this.lang = this.cfg.language === 'auto' ? (u.language || 'ko') : this.cfg.language;
    // 검색 기간은 여기 한 곳에서 정하고 모든 학술 DB 검색·포함 기준에 같은 값을 씀
    const userSet = this.cfg.year_from !== null && this.cfg.year_from !== undefined;
    const y = userSet ? this.cfg.year_from : u.search_start_year;
    this.yearFrom = y && y > 1900 && y <= CURRENT_YEAR ? y : null;
    this.yearFromSource = userSet ? 'user' : 'agent';
    this.yearFromReason = userSet ? '사용자 설정' : (u.search_window_reason || '');
  }

  // ── ② 계획 수립 ──
  async makePlan(feedback = '') {
    const names = this._planToolNames();
    const schema = O({
      sub_questions: A(O({ id: S, question: S, perspective: S, rationale: S,
        search_queries: A(S), preferred_tools: A(E(...names)) })),
      inclusion_criteria: A(S), success_criteria: A(S),
    });
    const window = this.yearFrom ? `publications from ${this.yearFrom} onward` : 'no publication-year limit';
    const desc = Object.fromEntries(names.map((n) => [n, n === 'web_search' ? WEB_SEARCH_DESC : (TOOL_DESC[n] || n)]));
    const p = await this._json(SYS_BASE, `Create an investigation plan for the topic.
Topic analysis: ${json(this.understanding)}
Search window (already applied to all academic databases): ${window}
${this._requirementsLine()}${feedback ? `Human reviewer feedback to incorporate: ${feedback}` : ''}

Rules:
- ${this.cfg.min_subq} to ${this.cfg.max_subq} sub-questions with ids Q1, Q2, ... Each must cover a DIFFERENT perspective, chosen to fit THIS topic, e.g.:
  definitions/measurement, current state/adoption, empirical effects, mechanisms, moderators/context,
  risks/limitations, methodology used in prior studies.
- At least one sub-question MUST look for counter-evidence, null/negative results or risks (avoid confirmation bias).
- 2-3 search_queries per sub-question: concise English academic keyword queries (3-8 words) using synonyms.
  Add a query in the topic's language only if local/national context matters.
- preferred_tools: pick tools appropriate for the discipline. Tools: ${json(desc)}
- inclusion_criteria: what counts as relevant evidence; any time criterion must match the search window above.
  success_criteria: when the investigation is "good enough".
Write question, perspective, rationale, inclusion_criteria and success_criteria in language "${this.lang}"
(search_queries stay as described above).`, schema, 'medium');
    if (!p) throw new LLMError('unknown', '계획 수립 단계 실패: 모델이 구조화된 응답을 주지 못했습니다.');
    this.plan = p;
    this._emitPlan(`하위 질문 ${p.sub_questions.length}개 수립` + (feedback ? ' (검토 의견 반영)' : ''), Boolean(feedback));
  }

  _emitPlan(msg, revised) {
    this.hooks.emit('plan', 'plan', msg, {
      sub_questions: this.plan.sub_questions.map((q) => ({ id: q.id, question: q.question, perspective: q.perspective })),
      revised,
    });
  }

  /** 사용자가 편집한 하위 질문을 계획 형식으로 맞춘다(id는 Q1..Qn으로 다시 매김). */
  _userSubq(n, q) {
    q = typeof q === 'string' ? { question: q } : { ...(q || {}) };
    const allowed = this._planToolNames();
    const picked = (q.preferred_tools || []).filter((t) => allowed.includes(t));
    return {
      id: `Q${n}`, question: String(q.question || '').trim(),
      perspective: q.perspective || 'user-added', rationale: q.rationale || '',
      search_queries: (q.search_queries || []).map(String).filter((s) => s.trim()),
      preferred_tools: picked.length ? picked : allowed,
    };
  }

  /** 사람 검토(human-in-the-loop): 승인 / 의견을 주고 재계획 / 하위 질문 목록 직접 수정. */
  async reviewPlan() {
    if (!this.cfg.human_in_the_loop) return;
    let revisions = 0;
    for (;;) {
      this.hooks.emit('plan', 'plan_review', '조사 계획 검토를 기다리는 중', { action: 'waiting' });
      const d = (await this.hooks.reviewPlan(this.plan)) || {};
      await this._checkpoint();
      const action = d.action;
      const feedback = String(d.feedback || '').trim();
      if (action === 'revise' && revisions < MAX_PLAN_REVISIONS) {
        revisions += 1;           // 빈 의견도 횟수에 넣어 검토가 끝없이 반복되지 않게 한다
        if (!feedback) {
          this.hooks.emit('plan', 'warning', '재계획 의견이 비어 있습니다. 의견을 적거나 계획을 승인해 주세요.', null);
          continue;
        }
        this.hooks.emit('plan', 'plan_review', `사용자 피드백 반영하여 재계획: ${feedback}`, { action: 'revise' });
        await this.makePlan(feedback);
        continue;
      }
      if (action === 'revise') {
        this.hooks.emit('plan', 'warning', '재계획 요청 한도에 도달해 현재 계획으로 진행합니다.', null);
      }
      const sqs = action === 'approve' ? d.sub_questions : null;
      if (Array.isArray(sqs)) {
        const edited = sqs.map((q) => this._userSubq(0, q)).filter((q) => q.question);
        if (edited.length >= 1 && edited.length <= 8) {
          edited.forEach((q, i) => { q.id = `Q${i + 1}`; });
          this.plan.sub_questions = edited;
          this.hooks.emit('plan', 'plan_review', `사용자가 하위 질문 목록을 수정함 (${edited.length}개)`, { action: 'edit' });
          this._emitPlan(`하위 질문 ${edited.length}개 확정 (사용자 수정)`, true);
          return;
        }
        this.hooks.emit('plan', 'warning', '수정한 하위 질문이 1~8개가 아니어서 원래 계획을 유지합니다.', null);
      }
      this.hooks.emit('plan', 'plan_review', '조사 계획 승인', { action: 'approve' });
      return;
    }
  }

  // ── ③ 자료 탐색: Tool Use 루프 ──
  /** 도구 실행만 담당. 같은 DB는 체인으로 순차 호출해 속도 제한을 지킴. → [결과 | null, 오류 | null] */
  async _fetch(name, query) {
    await this._checkpoint();
    const fn = this.tools[name];
    const unavailable = `${name} is unavailable for the rest of this run after repeated failures`;
    if (!fn) return [null, `unknown tool ${name}`];
    if (this.disabledTools.has(name)) return [null, unavailable];
    return withToolLock(name, async () => {
      if (this.disabledTools.has(name)) return [null, unavailable];   // 차례를 기다리는 사이 제외됐을 수 있음
      try {
        const out = await fn(query, { limit: this.cfg.results_per_search, yearFrom: this.yearFrom,
          email: this.cfg.openalex_email, signal: this.signal });
        return [out || [], null];
      } catch (e) {
        if (e instanceof RunCancelled) throw e;
        return [null, String(e?.message ?? e)];
      }
    });
  }

  /** 검색 결과를 저장소에 넣고 이벤트를 낸다. → [모델에게 돌려줄 글, 오류 여부] */
  _storeResults(name, query, subq, results, err) {
    if (err !== null && err !== undefined) {
      this.hooks.emit('act', 'tool_error', `${name}('${query}') 오류: ${err}`, { subq, tool: name, query, error: err });
      this.toolFailures[name] = (this.toolFailures[name] || 0) + 1;
      if (this.toolFailures[name] >= TOOL_FAIL_LIMIT && !this.disabledTools.has(name)) {
        this.disabledTools.add(name);
        if (name === 'web_search') this.webSearchOff = true;
        this.hooks.emit('act', 'tool_disabled', `${name} 연속 ${TOOL_FAIL_LIMIT}회 실패 → 이번 실행에서 제외`, { tool: name });
      }
      return [`ERROR: ${err}. Try another tool or query.`, true];
    }
    this.toolFailures[name] = 0;
    const lines = [];
    for (const src of results) {
      let s;
      try {
        s = this.store.add(src, query, subq);
      } catch (e) {
        this.hooks.emit('act', 'warning', `결과 1건 건너뜀: ${e?.message ?? e}`, null);
        continue;
      }
      if (s) {
        lines.push(`[${s.sid}] ${s.shortCite()} ${s.title} | ${s.venue} | cites=${s.citations ?? 'None'} | ${s.kind}\n` +
          `     ${(s.abstract || 'no abstract').slice(0, 220)}`);
      }
    }
    this.hooks.emit('act', 'tool', `${subq} · ${name}('${query}') → ${results.length}건 (누적 ${this.store.size})`,
      { subq, tool: name, query, count: results.length, total: this.store.size });
    return [lines.join('\n') || 'No results. Try broader or different keywords.', false];
  }

  /** calls=[[도구, 검색어, 하위질문]]: 서로 다른 DB는 동시에 실행하고, 결과는 요청 순서대로 저장소에 넣음. */
  async _runTools(calls) {
    if (!calls.length) return [];
    const fetched = await Promise.all(calls.map(([name, query]) => this._fetch(name, query)));
    return calls.map(([name, query, subq], i) => this._storeResults(name, query, subq, ...fetched[i]));
  }

  /** 응답의 웹 검색 서버 도구 블록을 읽어 저장소에 넣는다 (server_tool_use → web_search_tool_result, 인용 cited_text). */
  _recordWebSearch(content, subq) {
    for (const b of content) {
      if (b?.type === 'server_tool_use' && b.name === 'web_search') this._webQueries.set(b.id, String(b.input?.query ?? ''));
    }
    for (const b of content) {
      if (b?.type !== 'web_search_tool_result') continue;
      const query = this._webQueries.get(b.tool_use_id) ?? '';
      if (Array.isArray(b.content)) {
        const results = b.content.filter((r) => r?.type === 'web_search_result' && r.url).map((r) => new Source({
          title: r.title || '', authors: [], year: yearOf(r.page_age), venue: hostOf(r.url),
          abstract: '', url: r.url, origin: 'WebSearch', kind: 'web',
        }));
        this._storeResults('web_search', query, subq, results, null);
      } else {
        const code = b.content?.error_code || 'unknown_error';
        if (WEB_REQUEST_ERRORS.has(code)) {
          // 요청 자체가 원인(한 번에 허용한 검색 수 초과·검색어 문제): 도구 고장이 아니므로 실패로 세지 않는다
          this.hooks.emit('act', 'log', `${subq} 웹 검색 한도/입력 문제(${code}) — 건너뜀`, { subq, tool: 'web_search', code });
          continue;
        }
        this._storeResults('web_search', query, subq, null, code);
      }
    }
    // 답변 글에 붙은 인용의 원문 조각을 같은 URL 웹 문헌의 초록에 덧붙인다(웹 문헌이 초록 없이 평가되는 것을 줄임)
    for (const b of content) {
      if (b?.type !== 'text' || !Array.isArray(b.citations)) continue;
      for (const c of b.citations) {
        if (c?.type === 'web_search_result_location') this._addCitedText(c.url, c.cited_text);
      }
    }
  }

  _addCitedText(url, text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!url || !t) return;
    const s = this.store.sources().find((x) => x.kind === 'web' && x.url === url);
    if (!s || (s.abstract || '').includes(t) || (s.abstract || '').length >= 1500) return;
    s.abstract = (s.abstract ? `${s.abstract} … ${t}` : t).slice(0, 1500);
  }

  /** 웹 검색 도구 자체를 API가 거부한 오류인지 (예: 조직에서 웹 검색이 꺼져 있음) */
  _isWebSearchRejection(e, tools) {
    const status = Number(e?.status) || 0;
    return tools.some((t) => t.name === 'web_search') && status >= 400 && status < 500 &&
      ![401, 429].includes(status) && /web.?search/i.test(String(e?.message ?? ''));
  }

  _disableWebSearch() {
    this.webSearchOff = true;
    this.disabledTools.add('web_search');
    if (!this._webWarned) {
      this._webWarned = true;
      this.hooks.emit('act', 'warning', '웹 검색 도구를 쓸 수 없어 학술 DB만으로 조사합니다.', { tool: 'web_search' });
    }
  }

  _subqSids(qid) {
    return new Set(this.store.sources().filter((s) => s.subqs.has(qid)).map((s) => s.sid));
  }

  async investigate(sq) {
    const before = this._subqSids(sq.id);
    let tools = TOOLS.filter((t) => t.name in this.tools && !this.disabledTools.has(t.name));
    if (this._webSearchOn()) tools = [...tools, webSearchToolFor(this.cfg.model)];
    const system = SYS_BASE + ' You are the SEARCH EXECUTOR. Use the search tools to collect evidence for ONE sub-question. ' +
      'Look at each result list, then decide: refine keywords, switch database, or stop. ' +
      'Aim for 6-12 clearly relevant, diverse sources (empirical studies, reviews, and counter-evidence). ' +
      'When enough evidence is collected, stop calling tools and reply with a 2-3 sentence summary of what you found and what is missing. ' +
      `Write that summary in language "${this.lang}".`;
    const msgs = [{ role: 'user', content:
      `Main topic: ${this.understanding.topic_en}\nSub-question ${sq.id}: ${sq.question}\n` +
      `Perspective: ${sq.perspective || ''}\nSuggested queries: ${json(sq.search_queries || [])}\n` +
      `Suggested tools: ${json(sq.preferred_tools || [])}\nYou may run several searches at once (they run in parallel).` }];
    let summary = '';
    const steps = tools.length ? this.cfg.max_tool_steps : 0;
    for (let step = 0; step < steps; step++) {
      await this._checkpoint();
      if (this._stopSearching()) {   // 비용 한도·지금 마무리: 새 도구 라운드를 시작하지 않는다
        const why = this.budgetHit ? '비용 한도에 도달해' : '사용자 요청으로';
        this.hooks.emit('act', 'log', `${sq.id} ${why} 탐색을 멈춥니다.`, null);
        break;
      }
      let resp;
      try {
        resp = await this.llm.toolTurn(system, msgs, tools);
      } catch (e) {
        if (!this._isWebSearchRejection(e, tools)) throw e;
        this._disableWebSearch();        // 그 턴을 웹 검색 없이 다시 보낸다
        tools = tools.filter((t) => t.name !== 'web_search');
        if (!tools.length) break;
        resp = await this.llm.toolTurn(system, msgs, tools);
      }
      this._checkBudget();
      const content = this.llm.echoContent(resp);
      msgs.push({ role: 'assistant', content });   // 대화 기록은 덧붙이기만 한다
      this._recordWebSearch(content, sq.id);
      if (resp.stop_reason === 'pause_turn') continue;   // 서버 도구가 아직 진행 중 → 그대로 다시 보낸다
      const uses = content.filter((b) => b?.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !uses.length) {
        summary = this.llm.textOf(resp);
        break;
      }
      const outs = await this._runTools(uses.map((u) => [u.name, String((u.input || {}).query ?? ''), sq.id]));
      msgs.push({ role: 'user', content: uses.map((u, k) => ({
        type: 'tool_result', tool_use_id: u.id, content: outs[k][0], is_error: outs[k][1] })) });
    }
    const got = () => [...this._subqSids(sq.id)].filter((s) => !before.has(s));
    // 안전장치: 도구 루프가 자료를 거의 못 찾으면 결정적 검색으로 보강 (비용 한도·지금 마무리면 하지 않음).
    // 검색어가 없으면(사용자가 추가하거나 고친 질문) 질문 글 자체로 검색한다.
    if (got().length < 3 && 'search_openalex' in this.tools && !this._stopSearching()) {
      this.hooks.emit('act', 'log', `${sq.id} 수집 부족(${got().length}건) → 기본 검색으로 보강`, null);
      let queries = (Array.isArray(sq.search_queries) ? sq.search_queries : []).map((q) => String(q ?? '').trim()).filter(Boolean);
      if (!queries.length && String(sq.question || '').trim()) queries = [String(sq.question).trim().slice(0, 300)];
      await this._runTools(queries.slice(0, 2).map((q) => ['search_openalex', q, sq.id]));
    }
    const n = got().length;
    this.hooks.emit('act', 'subq_done', `${sq.id} 탐색 완료: 관련 후보 ${n}건. ${summary.slice(0, 150)}`,
      { subq: sq.id, found: n, summary: summary.slice(0, 150) });
  }

  async investigateAll(sqs) {
    await this._map((sq) => this.investigate(sq), [...sqs], 'act', '하위 질문 탐색');
  }

  // ── ④ 자료 평가 ──
  static _credibility(s) {
    let c = KIND_WEIGHT[s.kind] ?? 0.3;
    c += Math.min(Math.log10((s.citations || 0) + 1) / 3, 1) * 0.3;   // 피인용 1000회 ≈ +0.3
    if (s.year) c += s.year >= CURRENT_YEAR - 5 ? 0.1 : s.year >= CURRENT_YEAR - 10 ? 0.05 : 0;
    return round(Math.min(c, 1.0), 2);
  }

  async evaluate(batchSize = 8) {
    this._stage('evaluate', 'start');
    const todo = this.store.sources().filter((s) => !s.evaluated);
    if (todo.length) await this._evaluate(todo, batchSize);
    this._stage('evaluate', 'end');
  }

  async _evaluate(todo, batchSize) {
    const subqs = this.plan.sub_questions.map((q) => `${q.id}: ${q.question}`).join('\n');
    const schema = O({ items: A(O({
      sid: S, relevance: I, relevant_subqs: A(S), study_type: E(...STUDY_TYPES),
      method: S, sample: S, key_finding: S,
      direction: E('positive', 'negative', 'mixed', 'null', 'not applicable'),
      limitation: S,
    })) });

    const runBatch = (batch) => {
      const docs = batch.map((s) => `<${s.sid}> ${s.title} (${s.year ?? 'None'}, ${s.venue}, ${s.kind})\n` +
        `${(s.abstract || 'NO ABSTRACT').slice(0, 1200)}`).join('\n\n');
      return this._json(SYS_BASE, `Evaluate each source for the research topic using ONLY its title/abstract.
${ABSTRACT_RULE}
Topic: ${this.understanding.topic_en}
Sub-questions:
${subqs}
Inclusion criteria: ${json(this.plan.inclusion_criteria)}

For every source return:
- relevance: 0=unrelated, 1=tangential, 2=relevant, 3=directly answers a sub-question
- relevant_subqs: ids it informs
- study_type, method (design/analysis, short), sample (who/how many; if absent write that it is not stated in the abstract)
- key_finding: one sentence with the main result as stated (include numbers/effect sizes only if present in the text;
  if the abstract gives no result, say so)
- direction: of the effect relative to the topic's main hypothesis
- limitation: main weakness visible from the abstract
Write method/sample/key_finding/limitation in ${this.lang}.

Sources:
${docs}`, schema, 'low');
    };

    const batches = [];
    for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
    const results = await this._map(runBatch, batches, 'evaluate', '자료 평가');
    batches.forEach((batch, bi) => {     // 결과는 배치 순서대로 반영(순차 실행과 같은 결과)
      const byId = new Map(((results[bi] || {}).items || []).map((r) => [String(r.sid).replace(/^[<>]+|[<>]+$/g, ''), r]));
      for (const s of batch) {
        const r = byId.get(s.sid);
        s.evaluated = true;
        s.credibility = ResearchAgent._credibility(s);
        if (!r) continue;
        s.relevance = Math.max(0, Math.min(3, r.relevance));
        for (const q of r.relevant_subqs || []) if (q) s.subqs.add(q);
        Object.assign(s, { study_type: r.study_type, method: r.method, sample: r.sample,
          key_finding: r.key_finding, direction: r.direction, limitation: r.limitation });
        s.score = round(0.55 * s.relevance / 3 + 0.30 * s.credibility + 0.15 * (DESIGN_WEIGHT[s.study_type] ?? 0.3), 3);
      }
    });
    const inc = this.store.included();
    this.hooks.emit('evaluate', 'evaluate',
      `평가 ${todo.length}건 → 채택(관련성≥2) 누적 ${inc.length}건 / 전체 ${this.store.size}건 ` +
      `(중복 판본 병합 누적 ${this.store.merged}건)`,
      { evaluated: todo.length, included: inc.length, total: this.store.size, merged: this.store.merged });
  }

  // ── ⑤ 종합 (RAG) ──
  /** 하위 질문별 근거 검색: TF-IDF 유사도 + 평가 점수 + 하위질문 태그 가중. */
  retrieve(sq, k = 10) {
    const pool = this.store.included();
    if (!pool.length) return [];
    const docs = pool.map((s) => `${s.title} ${s.abstract} ${s.key_finding}`);
    let queries = [...(sq.search_queries || [])];
    if (!queries.length) {
      // 사용자가 추가한 하위 질문은 검색어가 없고 질문은 보고서 언어라 영어 어휘가 없을 수 있다
      // → 이 하위 질문으로 태그된 자료를 실제로 찾아낸 검색어를 쓴다(중복 제거, 최대 8개).
      const found = new Set();
      for (const s of this.store.sources()) {
        if (!s.subqs.has(sq.id)) continue;
        for (const q of [...s.queries].sort()) if (String(q).trim()) found.add(q);
      }
      queries = [...found].slice(0, 8);
    }
    const query = sq.question + ' ' + queries.join(' ');
    this._lastRetrieveQuery = query;   // 테스트용
    const sims = cosineScores(query, docs);
    const top = Math.max(...sims) || 1;
    const scoreOf = (s, sim) => 0.45 * sim / top + 0.35 * s.score + (s.subqs.has(sq.id) ? 0.2 : 0);
    return pool.map((s, i) => [s, sims[i]]).sort((a, b) => scoreOf(...b) - scoreOf(...a)).slice(0, k).map(([s]) => s);
  }

  /** 하위 질문 1개 종합 → 종합 객체 또는 null(실패). 결과 반영은 호출부가 입력 순서대로 한다. */
  async _synthesizeOne(sq) {
    const ev = this.retrieve(sq);
    if (!ev.length) {
      this.hooks.emit('synthesize', 'synthesis', `${sq.id} 종합: 관련 근거 없음`, { subq: sq.id, n: 0, strength: 'insufficient' });
      const ko = this.lang === 'ko';     // 보고서 언어에 맞춘다(한국어가 아니면 영어)
      return { answer: ko ? '근거 없음' : 'No evidence found.', key_findings: [], consensus: [], disagreements: [],
        evidence_strength: 'insufficient', gaps: [ko ? '관련 문헌을 찾지 못함' : 'No relevant literature was found.'], sources: [] };
    }
    const ctx = ev.map((s) => `[${s.sid}] ${s.shortCite()} | ${s.kind} | ${s.study_type} | ${s.method} | sample: ${s.sample} | ` +
      `direction: ${s.direction} | credibility ${s.credibility}\nTitle: ${s.title}\n` +
      `Finding: ${s.key_finding}\nAbstract: ${(s.abstract || '').slice(0, 700)}`).join('\n\n');
    const schema = O({ answer: S, key_findings: A(O({ finding: S, sources: A(S) })), consensus: A(S), disagreements: A(S),
      evidence_strength: E('strong', 'moderate', 'weak', 'insufficient'), gaps: A(S) });
    const out = await this._json(SYS_BASE, `Answer the sub-question using ONLY the evidence below. Cite every claim with source ids like [S3].
${ABSTRACT_RULE}
Sub-question ${sq.id}: ${sq.question}

Evidence:
${ctx}

- answer: 1 concise paragraph.
- key_findings: 3-6 items, each with the supporting source ids.
- consensus / disagreements: where studies agree or conflict, and WHY they might differ (design, sample, context, measurement).
- evidence_strength: judge by quantity, design quality and consistency. Several copies/versions of one study count as ONE study.
- gaps: what this evidence cannot answer.
Write in language "${this.lang}".`, schema, 'medium');
    if (out) {
      out.sources = ev.map((s) => s.sid);
      this.hooks.emit('synthesize', 'synthesis', `${sq.id} 종합 완료 (근거 ${ev.length}건, 강도=${out.evidence_strength})`,
        { subq: sq.id, n: ev.length, strength: out.evidence_strength });
    }
    return out;
  }

  async synthesizeAll(sqs) {
    this._stage('synthesize', 'start');
    sqs = [...sqs];
    const outs = await this._map((sq) => this._synthesizeOne(sq), sqs, 'synthesize', '하위 질문 종합');
    sqs.forEach((sq, i) => { if (outs[i]) this.syntheses[sq.id] = outs[i]; });
    this._stage('synthesize', 'end');
  }

  // ── ⑥ 자기 비판 & 재계획 ──
  /** Counter(...).most_common()과 같은 순서(많은 순, 같으면 처음 나온 순)의 집계 */
  _counts(inc, key) {
    const m = new Map();
    for (const s of inc) m.set(s[key], (m.get(s[key]) || 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  }

  /** 비평·보고서 프롬프트에 넣는 근거 통계 (노트북 형식). */
  _evidenceStats() {
    const inc = this.store.included();
    const years = inc.map((s) => s.year).filter(Boolean);
    return {
      total_collected: this.store.size, included: inc.length, duplicates_merged: this.store.merged,
      search_window_from: this.yearFrom, unavailable_tools: [...this.disabledTools].sort(),
      by_kind: this._counts(inc, 'kind'), by_study_type: this._counts(inc, 'study_type'),
      by_direction: this._counts(inc, 'direction'),
      year_range: years.length ? [Math.min(...years), Math.max(...years)] : null,
      per_subq: Object.fromEntries((this.plan.sub_questions || []).map((q) => [q.id, inc.filter((s) => s.subqs.has(q.id)).length])),
    };
  }

  /** result의 stats: 채택 문헌 기준 통계 + 연도별 분포. */
  stats() {
    const st = this._evidenceStats();
    const byYear = {};
    for (const s of this.store.included()) if (s.year) byYear[String(s.year)] = (byYear[String(s.year)] || 0) + 1;
    const sortedYears = Object.fromEntries(Object.keys(byYear).sort((a, b) => Number(a) - Number(b)).map((y) => [y, byYear[y]]));
    return {
      total_collected: st.total_collected, included: st.included, duplicates_merged: st.duplicates_merged,
      by_kind: st.by_kind, by_study_type: st.by_study_type, by_direction: st.by_direction,
      by_year: sortedYears, year_range: st.year_range, per_subq: st.per_subq,
    };
  }

  async reflect(roundNo, final = false) {
    this._stage('reflect', 'start');
    const summary = Object.fromEntries(Object.entries(this.syntheses).map(([qid, v]) =>
      [qid, { answer: String(v.answer || '').slice(0, 600), strength: v.evidence_strength, gaps: v.gaps }]));
    const history = this.reflections.map((r, i) => ({
      round: i + 1, quality: r.quality_score, searched: (r.followup_queries || []).map((f) => f.query),
      added_questions: (r.new_sub_questions || []).map((q) => q.question) }));
    let budget;
    if (final) {
      budget = 'This is the FINAL check after the last search round: no more searching is possible. ' +
        'Set should_continue=false, leave followup lists empty, and list the issues the final report must disclose.';
    } else {
      const left = this.cfg.max_reflection_rounds - roundNo + 1;
      budget = `Search rounds still available: ${left} (including the one that runs right after this review if you continue). ` +
        'Do not stop merely because of the round number; decide only on whether more searching would materially improve the result.';
    }
    const schema = O({
      quality_score: I, subq_assessment: A(O({ id: S, coverage: E('good', 'partial', 'poor'), issue: S })),
      bias_risks: A(S), should_continue: B, reason: S,
      followup_queries: A(O({ subq_id: S, query: S, tool: E(...this._toolNames()) })),
      new_sub_questions: A(O({ question: S, perspective: S, rationale: S, search_queries: A(S) })),
    });
    let r = await this._json(SYS_BASE + ' You are now the CRITIC reviewing the research so far.', `Critically review the investigation.
Topic: ${this.understanding.topic_en}
Plan: ${json(this.plan.sub_questions)}
Success criteria: ${json(this.plan.success_criteria)}
Current syntheses: ${json(summary)}
Evidence statistics: ${json(this._evidenceStats())}
Previous critic rounds (do not repeat the same searches): ${json(history)}
${budget}

Check: coverage of each sub-question, one-sided evidence (e.g. only positive results), over-reliance on weak/old/web sources,
missing perspectives, missing study designs, duplicated versions of one study counted as several. quality_score 1-10.
should_continue=true ONLY if additional searching is likely to materially improve the result.
If continuing: up to 4 followup_queries (concise English keywords, choose the best tool; avoid unavailable_tools) and up to 2
new_sub_questions for important uncovered angles (leave lists empty otherwise).
Write reason, bias_risks, the subq_assessment issues and the question/perspective/rationale of new_sub_questions
in language "${this.lang}". Keep followup queries and search_queries in English.`, schema, 'medium');
    if (!r) {
      this._stage('reflect', 'end');
      return false;
    }
    if (final) Object.assign(r, { should_continue: false, followup_queries: [], new_sub_questions: [] });
    r = { round: roundNo, final, ...r };
    this.reflections.push(r);
    const label = final ? '최종 점검' : `라운드 ${roundNo}`;
    this.hooks.emit('reflect', 'reflection',
      `${label}: 품질 ${r.quality_score}/10, 계속=${r.should_continue ? 'True' : 'False'} — ${String(r.reason || '').slice(0, 150)}`,
      { round: roundNo, final, quality_score: r.quality_score, should_continue: r.should_continue,
        reason: r.reason, bias_risks: r.bias_risks });
    this._stage('reflect', 'end');
    return r.should_continue;
  }

  async replanAndAct(r) {
    this.round += 1;
    this._stage('act', 'start');
    const known = new Set(this.plan.sub_questions.map((q) => q.id));
    const calls = (r.followup_queries || []).slice(0, 4)
      .filter((fq) => known.has(fq.subq_id) && fq.tool in this.tools)
      .map((fq) => [fq.tool, fq.query, fq.subq_id]);
    if (calls.length) {
      this.hooks.emit('reflect', 'replan', `추가 검색 ${calls.length}건: ` + calls.map(([, q]) => q).join('; '),
        { queries: calls.map(([, q]) => q) });
    }
    await this._runTools(calls);
    const affected = new Set(calls.map(([, , sq]) => sq));
    const newSqs = [];
    for (const nq of (r.new_sub_questions || []).slice(0, 2)) {
      const sq = { id: `Q${this.plan.sub_questions.length + 1}`, preferred_tools: this._planToolNames(), ...nq };
      this.plan.sub_questions.push(sq);
      this.hooks.emit('reflect', 'replan', `새 하위 질문 추가 ${sq.id}: ${sq.question}`, { subq: sq.id, question: sq.question });
      newSqs.push(sq);
      affected.add(sq.id);
    }
    await this.investigateAll(newSqs);
    this._stage('act', 'end');
    await this.evaluate();
    await this.synthesizeAll(this.plan.sub_questions.filter((sq) => affected.has(sq.id)));
  }

  // ── ⑦ 최종 보고서 ──
  /** 보고서에 넘길 근거: 하위 질문 종합이 다룬 문헌은 전부 + 남는 자리는 점수순.
   * (점수 상위만 넘기면 종합에서 쓴 문헌이 빠져 '근거 없음'으로 잘못 결론 낼 수 있음) → [근거 목록, 종합에서 다룬 수] */
  _reportEvidence() {
    const inc = this.store.included();
    const used = new Set();
    for (const v of Object.values(this.syntheses)) for (const id of json(v).match(/S\d+/g) || []) used.add(id);
    const must = inc.filter((s) => used.has(s.sid));
    const rest = inc.filter((s) => !used.has(s.sid)).slice(0, Math.max(0, MAX_REPORT_EVIDENCE - must.length));
    return [[...must, ...rest].sort((a, b) => b.score - a.score), must.length];
  }

  /** 보고서 다시 쓰기의 분량·추가 요청 줄 (기본 실행에서는 빈 문자열) */
  _reportOptionLines() {
    const lines = [];
    const len = REPORT_LENGTHS[this.reportOptions.length] || '';
    if (len) lines.push(len);
    const extra = String(this.reportOptions.extra || '').trim();
    if (extra) lines.push(`Additional request from the user (follow it as long as it does not break the rules above): ${extra}`);
    return lines.length ? '\n\n' + lines.join('\n') : '';
  }

  async writeReport() {
    this._stage('report', 'start');
    const [evidenceList, nUsed] = this._reportEvidence();
    this.reportEvidence = evidenceList;
    const evidence = evidenceList.map((s) =>
      `[${s.sid}] ${s.shortCite()} | ${s.kind} | ${s.study_type} | sample: ${s.sample} | ${s.direction} | ${s.key_finding}`).join('\n');
    this.hooks.emit('report', 'report',
      `보고서 근거 ${evidenceList.length}건 전달 (종합에서 다룬 ${nUsed}건 전부 포함, 채택 ${this.store.included().length}건 중)`,
      { evidence: evidenceList.length, used: nUsed });
    const critic = this.reflections.length ? this.reflections[this.reflections.length - 1] : {};

    const system = SYS_BASE + ' You are now the LEAD RESEARCHER writing the final research brief.';
    const prompt = `Write the final research brief in Markdown, in language "${this.lang}" (headings too).
Cite with source ids like [S3] ONLY from the evidence list. Do not add a reference list (it is appended automatically).
Rules:
- Put each citation inside the sentence it supports, before the final period: "... increased [S3]." (not "... increased. [S3]").
- Before claiming that evidence is absent or that only N studies exist, check the FULL evidence list, and phrase it as
  "in the evidence collected for this brief".
- ${ABSTRACT_RULE}
- Several versions/copies of the same study (preprint, publisher page, repository) count as ONE study.

Topic: ${this.topic}
${this._requirementsLine()}Topic analysis: ${json(this.understanding)}
Sub-question syntheses: ${json(this.syntheses)}
Critic's last review: ${json(critic)}
Evidence statistics: ${json(this._evidenceStats())}
Evidence list (${evidenceList.length} sources):
${evidence}

Required sections (use ## headings, numbered):
1. Executive summary — 5 bullet points a busy researcher must know.
2. Topic understanding — key concepts, operational definitions, variables, scope (including the search window).
3. Key findings by sub-question — with evidence strength labels.
4. Comparison & synthesis — where studies agree/conflict and why (design, sample, context, measurement differences).
5. Research gaps — concrete and specific (population, method, measurement, context, time horizon), each tied to evidence.
6. Future research directions — 3 proposed studies, each with research question, hypotheses, design, sample,
   variables & measurement instruments, analysis method, expected contribution.
7. Must-read papers — top 5 sources to read first and why.
8. Limitations of this brief — evidence quality, coverage, abstract-only analysis.${this._reportOptionLines()}`;

    let body = '';
    for (let attempt = 0; attempt <= REPORT_RETRIES; attempt++) {
      await this._checkpoint();
      // 스트림 조각마다 취소를 확인한다. hooks.checkpoint()는 async라서 그 결과(취소 예외)는 다음 조각에서 던진다.
      let cancelErr = null;
      const onDelta = (t) => {
        if (cancelErr) throw cancelErr;
        if (this._abort) throw new Aborted();
        this.hooks.reportDelta(t);
        Promise.resolve(this.hooks.checkpoint()).catch((e) => { cancelErr = e; });
      };
      try {
        body = await this.llm.text(system, prompt, { effort: 'high', maxTokens: 64000, stream: true, onDelta });
        if (cancelErr) throw cancelErr;
        break;
      } catch (e) {
        if (e instanceof RunCancelled || e instanceof Aborted) throw e;
        // 몇 분짜리 스트림이 일시 오류(연결 끊김·서버 과부하·속도 제한)로 끊기면 처음부터 다시 쓴다
        const code = friendlyError(e).code;
        if (attempt >= REPORT_RETRIES || !(code in RETRYABLE_CODES)) throw e;
        this.hooks.emit('report', 'warning',
          `보고서 작성 중 ${RETRYABLE_CODES[code]} 오류가 발생해 보고서를 처음부터 다시 작성합니다 ` +
          `(재시도 ${attempt + 1}/${REPORT_RETRIES}).`, { code, attempt: attempt + 1 });
        this._stage('report', 'start');     // 백엔드가 미리보기 버퍼를 비운다
      }
    }
    this._checkBudget();
    this.hooks.emit('report', 'report', `최종 보고서 작성 완료 (${body.length}자)`, { chars: body.length });
    this._stage('report', 'end');
    return body;
  }

  // ── ⑧ 인용 검증 → 수정 → 재검증 ──
  /** 보고서를 '주장 + 인용' 단위의 [시작, 끝] 위치로 나눔. 표는 행 전체, 본문은 문장 단위이고,
   * 인용 번호만 남은 조각(예: '... 증가했다. [S3].')은 앞 문장에 붙여 주장 없이 번호만 검사하는 일을 막음. */
  static _claimSpans(report) {
    const spans = [];
    let pos = 0;
    for (const line of report.split('\n')) {
      const start = pos;
      const end = pos + line.length;
      pos = end + 1;
      if (!CITE.test(line)) continue;
      if (line.trimStart().startsWith('|')) {
        spans.push([start, end]);
        continue;
      }
      const segs = [];
      let a = start;
      for (const m of line.matchAll(SENT_END)) {
        segs.push([a, start + m.index]);
        a = start + m.index + m[0].length;
      }
      segs.push([a, end]);
      const merged = [];
      for (const [x, y] of segs) {
        const core = report.slice(x, y).replace(CITE_G, '').replace(/[^\p{L}\p{N}]/gu, '');
        if (merged.length && [...core].length < 2) merged[merged.length - 1] = [merged[merged.length - 1][0], y];
        else merged.push([x, y]);
      }
      for (const [x, y] of merged) if (CITE.test(report.slice(x, y))) spans.push([x, y]);
    }
    return spans;
  }

  _sourcesText(claim) {
    const out = [];
    for (const i of citedIds(claim)) {
      const s = this.store.items.get(i);
      if (s && out.length < 5) {
        out.push(`  [${s.sid}] ${s.title} (${s.year || 'n.d.'}, ${s.kind})\n  ABSTRACT: ${(s.abstract || 'NO ABSTRACT').slice(0, 3000)}`);
      }
    }
    return out.join('\n');
  }

  /** claims=[주장 문장] → [[판정, 메모] | null]. 인용된 문헌의 초록 전문과 대조. */
  async _check(claims) {
    const blocks = claims.map((c, n) => `CLAIM ${n}: ${c}\nSOURCES:\n${this._sourcesText(c)}`);
    const schema = O({ items: A(O({ idx: I, verdict: E(...VERDICTS), note: S })) });
    const res = await this._json(SYS_BASE + ' You are a strict FACT-CHECKER.', `For each claim, judge whether the cited sources' text supports it.
- supported / partially supported / not in source text (the abstract does not say it) / contradicted (the abstract says otherwise).
- Judge only what the claim attributes to the cited sources. Statements about how many studies exist in this brief's
  evidence base (e.g. "the only RCT") and the author's own definitions or table labels are not judged against the source.
- In a table row, judge only the cells that carry citations.
Write note in ${this.lang} (one short sentence).

` + blocks.join('\n\n'), schema, 'low');
    const got = new Map();
    for (const it of (res || {}).items || []) if (it.idx >= 0 && it.idx < claims.length) got.set(it.idx, [it.verdict, it.note]);
    return claims.map((_, n) => got.get(n) || null);
  }

  /** 근거가 부족한 문장을 인용 문헌이 실제로 말하는 범위로 고쳐 씀 → Map(번호 → 수정문). */
  async _repair(items) {
    const blocks = items.map((c, n) =>
      `CLAIM ${n}: ${c.claim}\nVERDICT: ${c.verdict} — ${c.note}\nSOURCES:\n${this._sourcesText(c.claim)}`);
    const res = await this._json(SYS_BASE + ' You are the EDITOR fixing unsupported statements.', `Rewrite each claim so that it states only what its cited sources' text supports.
- Keep the citation ids and the Markdown form: a table row stays one table row with the same number of cells,
  a list item stays a list item, and nothing spans multiple lines.
- ${ABSTRACT_RULE}
- If a point cannot be supported, soften it (e.g. "suggests", "in one study") or drop that part; do not add new facts.
Write in language "${this.lang}".

` + blocks.join('\n\n'), O({ items: A(O({ idx: I, revised: S })) }), 'medium');
    const out = new Map();
    for (const it of (res || {}).items || []) if (it.idx >= 0 && it.idx < items.length) out.set(it.idx, String(it.revised).trim());
    return out;
  }

  _validRevision(old, neu) {
    if (!neu || neu.includes('\n') || !CITE.test(neu)) return false;
    if (citedIds(neu).some((i) => !this.store.items.has(i))) return false;
    if (old.trimStart().startsWith('|')) return neu.startsWith('|') && count(neu, '|') === count(old.trim(), '|');
    return true;
  }

  async verify(report) {
    this._stage('verify', 'start');
    const sample = this.cfg.verify_sample;
    const ids = new Set((report.match(CITE_G) || []).join(' ').match(/S\d+/g) || []);
    const unknown = [...ids].filter((i) => !this.store.items.has(i)).sort();
    for (const u of unknown) report = report.replace(new RegExp(`\\b${u}\\b`, 'g'), '?');   // 존재하지 않는 인용 제거
    const spans = ResearchAgent._claimSpans(report);
    let picked = [];
    if (sample > 0) {
      const stepN = Math.max(1, Math.floor(spans.length / sample));
      picked = spans.filter((_, i) => i % stepN === 0).slice(0, sample);
    }
    const result = { cited_ids: ids.size, unknown_ids: unknown, claims_total: spans.length, checks: [] };
    if (!picked.length) {
      this.hooks.emit('verify', 'verify', `인용 ID ${ids.size}개, 미존재 ${unknown.length}개, 검증할 인용 문장 없음`,
        { cited_ids: ids.size, unknown: unknown.length, checked: 0, supported: 0 });
      this._stage('verify', 'end');
      return [report, result];
    }
    const claims = picked.map(([a, b]) => report.slice(a, b).trim());
    const verdicts = await this._check(claims);
    picked.forEach((span, i) => {
      const v = verdicts[i];
      if (v) result.checks.push({ span, claim: claims[i], verdict: v[0], note: v[1] });
    });
    const ok = result.checks.filter((c) => c.verdict === 'supported').length;
    this.hooks.emit('verify', 'verify',
      `인용 ID ${ids.size}개, 미존재 ${unknown.length}개, 표본 ${result.checks.length}문장 중 완전 지지 ${ok}`,
      { cited_ids: ids.size, unknown: unknown.length, checked: result.checks.length, supported: ok });

    // 수정(Self-correction): 완전 지지가 아닌 문장만 근거 범위로 고쳐 쓰고 다시 검증
    const bad = result.checks.filter((c) => c.verdict !== 'supported');
    if (bad.length) {
      const revised = await this._repair(bad);
      const fixes = bad.map((c, n) => [c, revised.get(n)]).filter(([c, neu]) => this._validRevision(c.claim, neu));
      const after = fixes.length ? await this._check(fixes.map(([, neu]) => neu)) : [];
      fixes.forEach(([c, neu], i) => {
        c.revised = neu;
        [c.verdict_after, c.note_after] = after[i] || ['not checked', ''];
      });
      for (const [c, neu] of [...fixes].sort((x, y) => y[0].span[0] - x[0].span[0])) {   // 뒤에서부터 바꿔야 앞의 위치가 유지됨
        const [a, b] = c.span;
        const seg = report.slice(a, b);
        const lead = seg.slice(0, seg.length - seg.trimStart().length);
        report = report.slice(0, a) + lead + neu + report.slice(b);
      }
      const ok2 = result.checks.filter((c) => (c.verdict_after || c.verdict) === 'supported').length;
      this.hooks.emit('verify', 'repair',
        `미지지·부분지지 ${bad.length}문장 중 ${fixes.length}문장 수정 → 재검증 후 완전 지지 ${ok2}/${result.checks.length}`,
        { bad: bad.length, fixed: fixes.length, supported_after: ok2, checked: result.checks.length });
    }
    for (const c of result.checks) delete c.span;
    this._stage('verify', 'end');
    return [report, result];
  }

  // ── 실행 ──
  /** 체크포인트 단위의 순서: understand → plan → act → evaluate → synthesize → round:1 … → final_reflect → report */
  static _unitRank(unit) {
    if (!unit) return 0;
    const fixed = { understand: 1, plan: 2, act: 3, evaluate: 4, synthesize: 5, final_reflect: 1000, report: 1001 };
    if (unit in fixed) return fixed[unit];
    const m = /^round:(\d+)$/.exec(unit);
    return m ? 5 + Number(m[1]) : 0;
  }

  _isDone(unit) {
    return ResearchAgent._unitRank(this.done) >= ResearchAgent._unitRank(unit);
  }

  async _save(unit) {
    this.done = unit;
    await this.hooks.saveCheckpoint(this.snapshotState());
  }

  /** 이미 끝난 재조사 라운드에서 루프가 멈췄는지 (이어하기에서 같은 결정을 다시 내리기 위해) */
  _roundStopped(rnd) {
    const r = this.reflections.find((x) => x.round === rnd && !x.final);
    return !r || !r.should_continue || this._stopSearching();
  }

  async run() {
    if (this.done) this.hooks.emit('system', 'log', `체크포인트(${this.done})에서 이어서 진행합니다.`, { resume_from: this.done });
    else this.hooks.emit('system', 'log', `연구 주제: ${this.prompt}`, null);
    if (!this._isDone('understand')) {
      await this.understand();
      await this._save('understand');
    }
    if (!this._isDone('plan')) {
      this._stage('plan', 'start');
      await this.makePlan();
      await this.reviewPlan();
      this._stage('plan', 'end');
      await this._save('plan');
    }
    if (!this._isDone('act')) {
      this._stage('act', 'start');
      await this.investigateAll(this.plan.sub_questions);
      this._stage('act', 'end');
      await this._save('act');
    }
    if (!this._isDone('evaluate')) {
      await this.evaluate();
      await this._save('evaluate');
    }
    if (!this._isDone('synthesize')) {
      await this.synthesizeAll(this.plan.sub_questions);
      await this._save('synthesize');
    }
    const rounds = this.cfg.max_reflection_rounds;
    let completed = true;          // 파이썬 for … else: 끝까지 돌았으면 최종 점검
    for (let rnd = 1; rnd <= rounds; rnd++) {
      const unit = `round:${rnd}`;
      if (this._isDone(unit)) {
        if (this._roundStopped(rnd)) { completed = false; break; }
        continue;
      }
      if (this._stopSearching()) { completed = false; break; }   // 비용 한도·지금 마무리: 재조사 라운드를 시작하지 않는다
      const cont = await this.reflect(rnd);
      if (!cont || this._stopSearching()) {
        await this._save(unit);
        completed = false;
        break;
      }
      await this.replanAndAct(this.reflections[this.reflections.length - 1]);
      await this._save(unit);
    }
    if (completed && !this._stopSearching() && !this._isDone('final_reflect')) {
      await this.reflect(rounds + 1, true);   // 마지막 추가 조사 이후 상태를 한 번 더 평가
      await this._save('final_reflect');
    }
    let report;
    if (!this._isDone('report')) {
      report = await this.writeReport();
      this.reportMarkdown = report;
      await this._save('report');
    } else {
      report = this.reportMarkdown;
    }
    [this.reportMarkdown, this.verification] = await this.verify(report);
    return this.toResult();
  }

  /** result.json(PYTHON_SPEC 3.2)에서 id·meta·trace·schema_version을 뺀 부분 + 기간·도구·집계·비용 한도 정보. */
  toResult() {
    const included = new Set(this.store.included().map((s) => s.sid));
    const inReport = new Set(this.reportEvidence.map((s) => s.sid));
    const cited = new Set(citedIds(this.reportMarkdown));
    const sources = this.store.sources().map((s) => ({
      ...s.toDict(), included: included.has(s.sid), in_report: inReport.has(s.sid), cited: cited.has(s.sid) }));
    return {
      prompt: this.prompt, topic: this.topic, lang: this.lang,
      understanding: this.understanding, plan: this.plan, syntheses: this.syntheses,
      reflections: this.reflections, report_markdown: this.reportMarkdown,
      verification: this.verification, stats: this.stats(), sources,
      year_from: this.yearFrom, year_from_source: this.yearFromSource,
      year_from_reason: this.yearFromReason, disabled_tools: [...this.disabledTools].sort(),
      counts: { collected: this.store.size, included: included.size, merged: this.store.merged,
        report_evidence: this.reportEvidence.length, sub_questions: (this.plan.sub_questions || []).length },
      budget_cap_usd: this.cfg.max_cost_usd ?? null, budget_hit: this.budgetHit, finished_early: this.finishRequested,
    };
  }

  // ── 체크포인트 · 이어하기 ──
  /** JSON으로 저장할 수 있는 상태 (API 키 없음). store_keys는 중복 병합 색인(이어하기 결과가 같도록). */
  snapshotState() {
    const st = this.store.toState();
    return clone({
      version: STATE_VERSION, done: this.done,
      understanding: this.understanding, plan: this.plan,
      year_from: this.yearFrom, year_from_source: this.yearFromSource, year_from_reason: this.yearFromReason,
      sources: st.sources, merged: st.merged, store_keys: st.keys,
      syntheses: this.syntheses, reflections: this.reflections,
      tool_failures: this.toolFailures, disabled_tools: [...this.disabledTools].sort(),
      web_search_off: this.webSearchOff, round: this.round,
      usage: { ...(this.llm?.usage || {}) }, budget_hit: this.budgetHit, finish_requested: this.finishRequested,
      report_markdown: this.reportMarkdown,
    });
  }

  /**
   * 체크포인트에서 복원한다. 이후 run()은 state.done 다음 단위부터 이어서 실행한다(중단된 단위는 처음부터 다시).
   * state.usage는 llm.usage에 더한다(사용량을 이어서 누적). 중단된 단위에서 쓴 사용량까지 넣으려면
   * 호출부가 state.usage를 최신 값으로 바꿔 넘긴다.
   */
  static fromState(prompt, llm, config, hooks, state, tools = null) {
    if (!state || state.version !== STATE_VERSION) throw new LLMError('unknown', '지원하지 않는 체크포인트 형식입니다.');
    const a = new ResearchAgent(prompt, llm, config, hooks, tools);
    const s = clone(state);
    a.understanding = s.understanding || {};
    a.plan = s.plan || {};
    if (Object.keys(a.understanding).length) a._applyUnderstanding();
    a.yearFrom = s.year_from ?? null;
    a.yearFromSource = s.year_from_source || a.yearFromSource;
    a.yearFromReason = s.year_from_reason ?? a.yearFromReason;
    a.store = EvidenceStore.fromState(s.sources || [], s.merged || 0, s.store_keys || null);
    a.syntheses = s.syntheses || {};
    a.reflections = s.reflections || [];
    Object.assign(a.toolFailures, s.tool_failures || {});
    a.disabledTools = new Set(s.disabled_tools || []);
    a.webSearchOff = Boolean(s.web_search_off);
    a._webWarned = a.webSearchOff;
    a.round = Number(s.round) || 1;
    a.budgetHit = Boolean(s.budget_hit);
    a.finishRequested = Boolean(s.finish_requested);
    a.reportMarkdown = s.report_markdown || '';
    a.done = s.done || null;
    if (llm && llm.usage && s.usage) {
      for (const k of ['calls', 'input_tokens', 'output_tokens', 'web_searches']) {
        if (k === 'web_searches' && !s.usage[k]) continue;   // 웹 검색 횟수는 있을 때만 이어 붙인다
        llm.usage[k] = (llm.usage[k] || 0) + (Number(s.usage[k]) || 0);
      }
    }
    if (a._isDone('report')) a.reportEvidence = a._reportEvidence()[0];
    return a;
  }

  /**
   * 끝난 결과로 ⑦ 보고서 작성 + ⑧ 인용 검증만 다시 실행해 새 결과(toResult 형식)를 돌려준다.
   * @param {object} prevResult  result.json 또는 toResult() 결과
   * @param {{language?: 'ko'|'en', length?: 'short'|'standard'|'detailed', extra?: string}} [opts]
   */
  static async rewriteReport(prevResult, llm, config, hooks, { language = null, length = 'standard', extra = '' } = {}) {
    const prev = prevResult || {};
    const cfg = new RunConfig(config instanceof RunConfig ? config.toDict() : (config || {}));
    if (language === 'ko' || language === 'en') cfg.language = language;
    const a = new ResearchAgent(prev.prompt || prev.topic || '', llm, cfg, hooks, {});
    a.understanding = clone(prev.understanding || {});
    a.plan = clone(prev.plan || { sub_questions: [] });
    if (!Array.isArray(a.plan.sub_questions)) a.plan.sub_questions = [];
    a.syntheses = clone(prev.syntheses || {});
    a.reflections = clone(prev.reflections || []);
    const merged = prev.counts?.merged ?? prev.meta?.counts?.merged ?? prev.stats?.duplicates_merged ?? 0;
    a.store = EvidenceStore.fromState(prev.sources || [], merged, null);
    a.topic = prev.topic || a.prompt;
    a.lang = cfg.language === 'auto' ? (prev.lang || 'ko') : cfg.language;
    a.yearFrom = prev.year_from !== undefined ? prev.year_from : (prev.meta?.year_from ?? null);
    a.yearFromSource = prev.year_from_source || prev.meta?.year_from_source || 'agent';
    a.yearFromReason = prev.year_from_reason ?? prev.meta?.year_from_reason ?? '';
    a.disabledTools = new Set(prev.disabled_tools || prev.meta?.disabled_tools || []);
    a.round = Math.max(1, ...a.reflections.map((r) => Number(r.round) || 1));
    a.reportOptions = { length: length in REPORT_LENGTHS ? length : 'standard', extra: String(extra || '').slice(0, 500) };
    a.done = 'final_reflect';
    a.hooks.emit('system', 'log', `보고서 다시 쓰기: 언어=${a.lang}, 분량=${a.reportOptions.length}`, null);
    const body = await a.writeReport();
    a.reportMarkdown = body;
    [a.reportMarkdown, a.verification] = await a.verify(body);
    return a.toResult();
  }
}

// ── 작은 도우미 ──
function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function count(s, ch) {
  return s.split(ch).length - 1;
}

/** 웹 검색 결과의 page_age(예: "March 2, 2024", "2 days ago")에서 연도 */
function yearOf(pageAge) {
  const m = /\b(19|20)\d{2}\b/.exec(String(pageAge || ''));
  return m ? Number(m[0]) : null;
}

function hostOf(url) {
  return String(url || '').replace(/^https?:\/\/([^/]+).*/, '$1');
}

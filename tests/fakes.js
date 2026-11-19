// 테스트용 가짜 LLM · 가짜 검색 도구 · 기록용 훅. 네트워크와 API 키 없이 파이프라인 전체를 돌린다. (원본: tests/fakes.py)
//
// 다른 담당자(백엔드·결과물·화면의 ?mock=1)도 import해서 쓴다. 이름과 동작을 바꾸지 말 것.
//
// - new FakeLLM({ continueRounds = 1, refuseReport = false, delay = 0, webSearch = false, costPerCall = 0.05,
//                 pauseTurn = false, rejectWebSearch = false, model = 'claude-opus-5-5' })
//     engine/llm.js의 LLM과 같은 인터페이스(model, usage, json, text, toolTurn, costUsd, textOf, echoContent).
//     json()은 스키마의 키로 단계를 알아내 결정적으로 답한다:
//     understanding / plan / evaluation / synthesis / reflection / verification / repair / refine (그 밖은 null).
//     - continueRounds: 자기 비판에서 should_continue=true로 답할 라운드 수(1라운드에는 새 하위 질문 1개 추가).
//     - refuseReport: true면 보고서 text()가 LLMError('refusal', …)를 던진다.
//     - delay: 호출마다 쉬는 시간(ms). 백엔드 테스트에서 실행을 천천히 진행시킬 때 쓴다.
//     - webSearch: true면 도구 목록에 web_search가 있을 때 첫 탐색 턴에 server_tool_use + web_search_tool_result
//       (web_search_result 4건) + citations(web_search_result_location)가 붙은 text 블록을 만든다(실제 API와 같은 모양).
//       'error'면 web_search_tool_result의 content가 오류 객체({type: 'web_search_tool_result_error', error_code}).
//     - pauseTurn: true면(webSearch와 함께) 첫 턴을 웹 검색 블록만 담은 stop_reason 'pause_turn' 응답으로 끝낸다.
//     - rejectWebSearch: true면 도구 목록에 web_search가 있는 요청을 SDK의 BadRequestError(400, web_search 문구)로 거부한다.
//     - costPerCall: costUsd() = 호출 수 × costPerCall (비용 한도 테스트용).
//     text()는 프롬프트의 근거 목록에 있는 실제 ID를 인용한 Markdown 보고서를 만든다(인용이 든 표 행,
//     "... 향상되었다. [S1]." 같은 인용만 남은 조각, 존재하지 않는 [S9999], "et al." 문장 포함).
//     stream이고 onDelta가 있으면 조각을 onDelta로 흘려보낸다(조각 사이에 이벤트 루프를 한 번 돈다).
//     Q&A 프롬프트("Follow-up question:")에는 근거 ID를 인용한 짧은 답을 준다. 호출된 단계 이름은 .calls에 쌓인다.
//
// - makeFakeTools({ fail = ['search_semantic_scholar'], empty = false }) → { search_openalex, search_semantic_scholar, search_europe_pmc }
//     실제와 같은 시그니처의 async 함수(query, { limit = 6, yearFrom = null, email = '', signal = null }).
//     fail에 든 도구는 항상 Error('요청 실패: 429 rate limited'), empty면 모두 [] 반환.
//     모든 함수는 같은 기록 배열을 .calls 속성으로 공유한다: { tool, query, limit, yearFrom, email }.
//
// - new RecordingHooks({ planDecisions = [], cancelAfter = null, cancelAtCheckpoint = null })
//     .events(객체 목록: stage, kind, msg, data), .progressCalls([stage, done, total, label]),
//     .deltas(보고서 조각), .reviewedPlans(reviewPlan에 넘어온 계획 복사본), .checkpoints(saveCheckpoint로 받은 상태 복사본).
//     planDecisions: reviewPlan이 차례로 돌려줄 결정 목록(다 쓰면 {action: 'approve'}).
//     cancelAfter=N: 이벤트가 N개 이상 쌓이면 checkpoint()가 RunCancelled를 던진다.
//     cancelAtCheckpoint='act' 등: 그 단위의 체크포인트가 저장된 뒤 다음 checkpoint()에서 RunCancelled를 던진다.
//     .ofKind(kind): kind가 같은 이벤트 목록.

import { BadRequestError } from '../vendor/anthropic-sdk.js';
import { LLMError, RunCancelled } from '../assets/js/engine/llm.js';
import { RunHooks } from '../assets/js/engine/pipeline.js';
import { Source } from '../assets/js/engine/sources.js';

export const NOY_TITLE = 'Experimental evidence on the productivity effects of generative artificial intelligence';
export const NOY_DOI = 'https://doi.org/10.1126/science.adh2586';
export const SHARED_DOI = 'https://doi.org/10.5555/llm.writing.2024';
export const REVISION_MARK = '(초록 기준)';
export const WEB_REPORT_URL = 'https://example.kr/report';
export const WEB_CITED_TEXT = '대학원생의 62%가 논문 작성에 생성형 AI를 쓴다고 답했다.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let msgSeq = 0;

function resp(content, stopReason = 'end_turn', model = 'claude-opus-5-5') {
  msgSeq += 1;
  return { id: `msg_fake_${msgSeq}`, type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
}

function textBlock(text, citations = null) {
  return citations ? { type: 'text', text, citations } : { type: 'text', text };
}

/** 실제 API와 같은 모양의 웹 검색 서버 도구 블록 [server_tool_use, web_search_tool_result] */
function webSearchBlocks(id, query, mode) {
  const use = { type: 'server_tool_use', id, name: 'web_search', input: { query }, caller: { type: 'direct' } };
  const result = (title, url, pageAge) => ({ type: 'web_search_result', title, url, page_age: pageAge,
    encrypted_content: 'EqoBCkYIBxgCIkBmYWtlIGVuY3J5cHRlZCBjb250ZW50' });
  const content = mode === 'error'
    ? { type: 'web_search_tool_result_error', error_code: 'too_many_requests' }
    : [result('Experimental evidence on the productivity effects of ... - AAAS', 'https://www.science.org/a', 'July 13, 2023'),
      result('ExperimentalEvidenceontheProductivityEffectsof ...', 'https://example.org/b', null),
      result('Experimental evidence on the productivity eﬀects of generative artificial intelligence', 'https://example.org/c', '2 years ago'),
      result('대학원생 생성형 AI 활용 실태 보고서', WEB_REPORT_URL, 'March 2, 2025')];
  return [use, { type: 'web_search_tool_result', tool_use_id: id, content, caller: { type: 'direct' } }];
}

function citedTextBlock() {
  return textBlock('웹 자료에 따르면 대학원생 다수가 생성형 AI를 쓴다.', [{
    type: 'web_search_result_location', url: WEB_REPORT_URL, title: '대학원생 생성형 AI 활용 실태 보고서',
    cited_text: WEB_CITED_TEXT, encrypted_index: 'Eo8BCioIAhgBIiQ0NGFlNjc2Ny1mYWtl' }]);
}

/** engine/llm.js의 LLM 대신 쓰는 결정적인 가짜 LLM (파일 머리말 참조). */
export class FakeLLM {
  constructor({ continueRounds = 1, refuseReport = false, delay = 0, webSearch = false, costPerCall = 0.05,
    pauseTurn = false, rejectWebSearch = false, model = 'claude-opus-5-5' } = {}) {
    this.model = model;
    this.continueRounds = continueRounds;
    this.refuseReport = refuseReport;
    this.delay = delay;
    this.webSearch = webSearch;
    this.costPerCall = costPerCall;
    this.pauseTurn = pauseTurn;
    this.rejectWebSearch = rejectWebSearch;
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    this.calls = [];
    this._reflections = 0;
    this._webSeq = 0;
  }

  async _track(stage) {
    if (this.delay) await sleep(this.delay);
    this.calls.push(stage);
    this.usage.calls += 1;
    this.usage.input_tokens += 100;
    this.usage.output_tokens += 20;
  }

  costUsd() {
    return Math.round(this.usage.calls * this.costPerCall * 1e4) / 1e4;
  }

  // ── LLM과 같은 정적·인스턴스 메서드 ──
  static textOf(r) {
    return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  }

  static echoContent(r) {
    return r.content;
  }

  textOf(r) { return FakeLLM.textOf(r); }
  echoContent(r) { return FakeLLM.echoContent(r); }

  // ── 구조화 출력 ──
  static stageOf(schema) {
    const props = schema?.properties || {};
    if ('topic_en' in props) return 'understanding';
    if ('sub_questions' in props) return 'plan';
    if ('evidence_strength' in props) return 'synthesis';
    if ('quality_score' in props) return 'reflection';
    if ('suggestions' in props) return 'refine';
    if ('items' in props) {
      const inner = props.items.items.properties;
      if ('relevance' in inner) return 'evaluation';
      if ('verdict' in inner) return 'verification';
      if ('revised' in inner) return 'repair';
    }
    return 'unknown';
  }

  async json(system, prompt, schema, opts = {}) {
    const stage = FakeLLM.stageOf(schema);
    await this._track(stage);
    const fn = this[`_${stage}`];
    return fn ? fn.call(this, prompt) : null;
  }

  _understanding() {
    return {
      language: 'ko', topic_en: "Effects of generative AI on graduate students' research productivity",
      discipline: '고등교육 연구', research_type: '인과 효과',
      key_concepts: [{ term: '생성형 AI', english: 'generative AI', synonyms: ['large language models', 'ChatGPT'] },
        { term: '연구 생산성', english: 'research productivity', synonyms: ['writing productivity'] }],
      independent_variables: ['생성형 AI 사용'], dependent_variables: ['연구 생산성', '연구 품질'],
      moderators_or_context: ['학문 분야'], population: '대학원생', ambiguities: ["'품질'의 측정 방식"],
      scope_decision: 'LLM 기반 도구로 한정', search_start_year: 2022,
      search_window_reason: 'ChatGPT 공개 이후 연구가 본격화되었다.',
      core_topic: '생성형 AI와 대학원생 연구 생산성', user_requirements: [],
    };
  }

  _plan(prompt) {
    const m = /(\d+) to (\d+) sub-questions/.exec(prompt);
    const n = m ? Number(m[1]) : 4;
    const revised = prompt.includes('Human reviewer feedback');
    const topics = ['writing productivity', 'research quality', 'adoption survey', 'integrity risks',
      'learning outcomes', 'measurement validity', 'discipline differences', 'policy guidance'];
    const sqs = Array.from({ length: n }, (_, i) => ({
      id: `Q${i + 1}`, question: `${revised ? '(수정) ' : ''}생성형 AI와 ${topics[i % 8]}의 관계는?`,
      perspective: topics[i % 8], rationale: '핵심 관점',
      search_queries: [`generative AI ${topics[i % 8]} graduate students`, `large language models ${topics[i % 8]}`],
      preferred_tools: ['search_openalex', 'web_search'],
    }));
    return { sub_questions: sqs, inclusion_criteria: ['2022년 이후 실증 연구'], success_criteria: ['하위 질문마다 근거 3건 이상'] };
  }

  _evaluation(prompt) {
    const types = ['RCT/experiment', 'survey/correlational', 'qualitative', 'meta-analysis/systematic review'];
    const dirs = ['positive', 'mixed', 'negative', 'null', 'not applicable'];
    return { items: [...prompt.matchAll(/^<(S\d+)>/gm)].map(([, sid]) => {
      const n = Number(sid.slice(1));
      return { sid, relevance: n % 7 === 0 ? 1 : 3, relevant_subqs: ['Q1'], study_type: types[n % 4],
        method: '온라인 실험', sample: `대학원생 ${50 + n}명`, key_finding: '생성형 AI 사용으로 글쓰기 시간이 줄었다.',
        direction: dirs[n % 5], limitation: '단기 과제' };
    }) };
  }

  _synthesis(prompt) {
    let ids = [...prompt.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]).slice(0, 3);
    if (!ids.length) ids = ['S1'];
    const cites = ids.map((i) => `[${i}]`).join('');
    return {
      answer: `수집한 근거에 따르면 생성형 AI는 글쓰기 시간을 줄였다 ${cites}.`,
      key_findings: [{ finding: `작성 시간이 감소했다 [${ids[0]}].`, sources: ids.slice(0, 1) }],
      consensus: ['시간 절감 효과에는 대체로 동의한다.'], disagreements: ['품질 효과는 엇갈린다.'],
      evidence_strength: 'moderate', gaps: ['장기 효과 연구 부족'],
    };
  }

  _reflection() {
    this._reflections += 1;
    const n = this._reflections;
    const cont = n <= this.continueRounds;
    return {
      quality_score: 4 + n, subq_assessment: [{ id: 'Q1', coverage: 'partial', issue: '실험 연구가 적다.' }],
      bias_risks: ['긍정적 결과에 치우칠 위험', '웹 자료 의존'], should_continue: cont,
      reason: `${n}번째 검토: ` + (cont ? '추가 검색이 필요하다.' : '충분하다.'),
      followup_queries: cont ? [{ subq_id: 'Q1', query: `generative AI writing experiment round ${n}`, tool: 'search_openalex' }] : [],
      new_sub_questions: cont && n === 1 ? [{ question: '생성형 AI 효과는 언어 배경에 따라 다른가?', perspective: '이질성',
        rationale: '비원어민 맥락', search_queries: ['LLM non-native English authors productivity'] }] : [],
    };
  }

  _verification(prompt) {
    return { items: [...prompt.matchAll(/^CLAIM (\d+): (.*)\nSOURCES:/gm)].map(([, idx, claim]) => {
      const ok = claim.includes(REVISION_MARK) || Number(idx) % 3 !== 0;
      return { idx: Number(idx), verdict: ok ? 'supported' : 'partially supported',
        note: ok ? '초록과 일치한다.' : '초록에 일부만 나온다.' };
    }) };
  }

  _repair(prompt) {
    return { items: [...prompt.matchAll(/^CLAIM (\d+): (.*)\nVERDICT:/gm)].map(([, idx, claim]) => ({
      idx: Number(idx),
      revised: claim.startsWith('| ') ? '| ' + REVISION_MARK + ' ' + claim.slice(2) : REVISION_MARK + ' ' + claim,   // 표 행은 칸 수 유지
    })) };
  }

  _refine(prompt) {
    const draft = (/"""([\s\S]*?)"""/.exec(prompt) || [, ''])[1].trim().slice(0, 60);
    return {
      suggestions: [
        { prompt: `${draft} — 석사·박사과정생의 논문 작성 시간과 질을 중심으로`, focus: '대상 구체화', why: '조사 대상을 좁혀 근거를 찾기 쉽다.' },
        { prompt: `${draft} — 2022년 이후 실험·준실험 연구로 한정`, focus: '기간·방법 구체화', why: '인과 근거에 집중할 수 있다.' },
        { prompt: `${draft} — 연구 윤리와 표절 위험까지 포함해 비교`, focus: '범위 구체화', why: '반대 근거를 함께 살필 수 있다.' },
      ],
      questions: ['어느 전공 분야를 염두에 두고 있나요?'],
    };
  }

  // ── 글 (보고서, Q&A) ──
  async text(system, prompt, { effort = 'medium', maxTokens = 16000, stream = false, onDelta = null } = {}) {
    if (prompt.includes('Follow-up question:')) {
      await this._track('qa');
      const ids = [...prompt.split('Evidence:')[1]?.matchAll(/^\[(S\d+)\]/gm) || []].map((m) => m[1]);
      return ids.length ? `수집한 근거에 따르면 생성형 AI는 글쓰기 시간을 줄였다 [${ids[0]}].`
        : '이 브리프를 위해 수집한 근거로는 답하기 어렵습니다.';
    }
    await this._track('report');
    if (this.refuseReport) throw new LLMError('refusal', '모델이 이 요청을 거절했습니다(refusal).');
    const part = prompt.split('Evidence list').slice(1).join('Evidence list');
    const ids = [...part.matchAll(/^\[(S\d+)\]/gm)].map((m) => m[1]);
    const body = FakeLLM.report(ids);
    if (stream && onDelta) {
      for (let i = 0; i < body.length; i += 200) {
        onDelta(body.slice(i, i + 200));
        await sleep(0);
      }
    }
    return body;
  }

  static report(ids) {
    const c = (k) => (ids.length ? ids[k % ids.length] : 'S9999');
    const lines = ['# 생성형 AI와 대학원생 연구 생산성: 연구 브리프', '', '## 1. 핵심 요약', '',
      `- 생성형 AI는 글쓰기 시간을 줄였다 [${c(0)}]. 품질도 향상되었다. [${c(1)}].`,
      `- Noy et al. found large productivity gains in writing tasks [${c(2)}]. 효과가 없다는 연구도 있다 [S9999].`,
      '', '## 2. 주제 이해', '', '| 개념 | 정의 | 측정 |', '|---|---|---|',
      `| 생성형 AI | LLM 기반 도구 | 실험 조건 배정 [${c(0)}][${c(1)}] |`, '', '## 3. 하위 질문별 주요 결과', ''];
    for (let k = 0; k < Math.min(ids.length, 12); k++) lines.push(`- 연구 ${k + 1}은 작성 시간이 감소했다고 보고했다 [${ids[k]}].`);
    if (!ids.length) lines.push('- 이 브리프를 위해 수집한 근거에서는 관련 연구를 찾지 못했다.');
    lines.push('', '## 4. 비교와 종합', '', `연구들은 대체로 일치한다 [${c(3)}, ${c(4)}].`,
      '', '## 5. 연구 공백', '', '- 장기 효과 연구가 없다.', '', '## 6. 후속 연구 방향', '', '- 종단 연구.',
      '', '## 7. 필독 문헌', '', `- [${c(0)}] 핵심 실험.`, '', '## 8. 이 브리프의 한계', '', '- 초록만 분석했다.');
    return lines.join('\n');
  }

  // ── 도구 루프 ──
  /** 첫 턴에는 OpenAlex·Semantic Scholar(있으면)를 동시에 부르고(webSearch면 웹 검색 블록도), 다음 턴에 요약으로 끝낸다. */
  async toolTurn(system, messages, tools, opts = {}) {
    const names = tools.map((t) => t.name);
    const hasWeb = names.includes('web_search');
    if (hasWeb && this.rejectWebSearch) {
      throw new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error',
        message: 'tools.3: web_search is not enabled for this organization' } },
      'web_search is not enabled for this organization', new Headers());
    }
    await this._track('tool');
    const assists = messages.filter((m) => m.role === 'assistant');
    const first = typeof messages[0].content === 'string' ? messages[0].content : '';
    const m = /Suggested queries: (\[.*\])/.exec(first);
    const queries = m ? JSON.parse(m[1]) : [];
    const q = queries[0] || 'generative AI research productivity';
    const web = hasWeb && this.webSearch;
    const newWebId = () => `srvtoolu_fake_${++this._webSeq}`;
    if (web && this.pauseTurn && assists.length === 0) {
      return resp(webSearchBlocks(newWebId(), q, this.webSearch), 'pause_turn', this.model);
    }
    const searched = assists.some((a) => (a.content || []).some((b) => b.type === 'tool_use'));
    if (!searched) {
      const uses = names.filter((n) => ['search_openalex', 'search_semantic_scholar'].includes(n))
        .map((n, k) => ({ type: 'tool_use', id: `toolu_${n}_${k}`, name: n, input: { query: q }, caller: { type: 'direct' } }));
      const content = [textBlock('검색을 시작한다.')];
      if (web && !this.pauseTurn) content.push(...webSearchBlocks(newWebId(), q, this.webSearch));
      if (web && this.webSearch !== 'error') content.push(citedTextBlock());
      content.push(...uses);
      if (uses.length) return resp(content, 'tool_use', this.model);
    }
    return resp([textBlock('충분한 자료를 찾았다. 장기 연구는 부족하다.')], 'end_turn', this.model);
  }
}

// zlib.crc32와 같은 값 (가짜 도구의 결정적 번호)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(str) {
  let c = 0xFFFFFFFF;
  for (const b of new TextEncoder().encode(str)) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 검색 도구 3종의 가짜 버전 (파일 머리말 참조). */
export function makeFakeTools({ fail = ['search_semantic_scholar'], empty = false } = {}) {
  const calls = [];
  const paper = (n, kind = 'peer-reviewed', origin = 'OpenAlex') => new Source({
    title: `Generative AI and graduate research productivity: evidence from study ${n}`,
    authors: ['Jane Doe', 'John Smith'], year: 2022 + (n % 4), venue: 'Journal of Higher Education',
    abstract: `We study how large language models change writing productivity and research quality among ${100 + n} graduate students. Writing time decreased and quality improved.`,
    url: `https://doi.org/10.1000/study.${n}`, doi: `https://doi.org/10.1000/study.${n}`,
    citations: n * 3, origin, kind,
  });
  const noy = () => new Source({
    title: NOY_TITLE, authors: ['Shakked Noy', 'Whitney Zhang'], year: 2023, venue: 'Science',
    abstract: 'We examined the productivity effects of a generative artificial intelligence technology, ' +
      'the assistive chatbot ChatGPT, in midlevel professional writing tasks. Time decreased by 40% ' +
      'and output quality rose by 18%.',
    url: NOY_DOI, doi: NOY_DOI, citations: 2150, origin: 'OpenAlex', kind: 'peer-reviewed',
  });
  const shared = (origin) => new Source({
    title: 'Large language models and doctoral writing quality',
    authors: origin === 'EuropePMC' ? ['Kim J', 'Lee S'] : ['Jiwon Kim', 'Sora Lee'], year: 2024,
    venue: 'Medical Education', abstract: 'Doctoral students using LLMs wrote higher quality drafts.',
    url: SHARED_DOI, doi: SHARED_DOI, citations: 12, origin, kind: 'peer-reviewed',
  });
  const base = (query) => crc32(query) % 900;
  const funcs = {
    search_openalex: (query, limit) => [noy(), shared('OpenAlex'), ...Array.from({ length: Math.max(0, limit - 2) }, (_, i) => paper(base(query) + i))],
    search_semantic_scholar: (query) => [paper(base(query) + 300, 'peer-reviewed', 'SemanticScholar')],
    search_europe_pmc: (query) => [shared('EuropePMC'), paper(base(query) + 500, 'peer-reviewed', 'EuropePMC')],
  };
  const out = {};
  for (const [name, fn] of Object.entries(funcs)) {
    const tool = async (query, { limit = 6, yearFrom = null, email = '', signal = null } = {}) => {
      calls.push({ tool: name, query, limit, yearFrom, email });
      await sleep(0);
      if (fail.includes(name)) throw new Error('요청 실패: 429 rate limited');
      return empty ? [] : fn(query, limit);
    };
    tool.calls = calls;
    out[name] = tool;
  }
  return out;
}

/** 이벤트·진행률·보고서 조각·체크포인트를 기록하는 훅 (파일 머리말 참조). */
export class RecordingHooks extends RunHooks {
  constructor({ planDecisions = [], cancelAfter = null, cancelAtCheckpoint = null } = {}) {
    super();
    this.events = [];
    this.progressCalls = [];
    this.deltas = [];
    this.reviewedPlans = [];
    this.checkpoints = [];
    this.planDecisions = [...(planDecisions || [])];
    this.cancelAfter = cancelAfter;
    this.cancelAtCheckpoint = cancelAtCheckpoint;
    this._cancelNext = false;
  }

  emit(stage, kind, msg, data = null) {
    this.events.push({ stage, kind, msg, data });
  }

  progress(stage, done, total, label = '') {
    this.progressCalls.push([stage, done, total, label]);
  }

  async checkpoint() {
    if (this._cancelNext) throw new RunCancelled();
    if (this.cancelAfter !== null && this.events.length >= this.cancelAfter) throw new RunCancelled();
  }

  async reviewPlan(plan) {
    this.reviewedPlans.push(JSON.parse(JSON.stringify(plan)));
    return this.planDecisions.length ? this.planDecisions.shift() : { action: 'approve' };
  }

  reportDelta(text) {
    this.deltas.push(text);
  }

  async saveCheckpoint(state) {
    this.checkpoints.push(JSON.parse(JSON.stringify(state)));
    if (this.cancelAtCheckpoint && state.done === this.cancelAtCheckpoint) this._cancelNext = true;
  }

  ofKind(kind) {
    return this.events.filter((e) => e.kind === kind);
  }
}

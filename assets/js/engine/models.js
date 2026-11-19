// 모델 목록 · 가격 · 조사 깊이 프리셋 · 실행 설정(RunConfig). (원본: agent/models.py)
//
// 모델 ID와 가격은 Anthropic 공개 문서(2026-11-03 기준)에서 옮긴 값이다. 가격이 바뀌면 이 파일만 고치면 된다.
// 웹 버전 추가: RunConfig.max_cost_usd(비용 한도), RunConfig.web_search(Anthropic 웹 검색 서버 도구 사용 여부).

export const APP_NAME = 'AI Research Agent';
export const APP_VERSION = '2.0.0-web';
export const PRICING_AS_OF = '2026-11-03';
export const CURRENT_YEAR = new Date().getFullYear();

/**
 * @typedef {object} ModelInfo
 * @property {string} id
 * @property {string} label
 * @property {string} tagline          한 줄 설명 (모델 선택 카드)
 * @property {string} description      조금 더 긴 설명 (툴팁)
 * @property {number} input_per_mtok   USD / 100만 입력 토큰
 * @property {number} output_per_mtok  USD / 100만 출력 토큰 (사고 토큰 포함)
 * @property {boolean} supports_fallback  거절(refusal) 시 서버측 fallback 지원 여부
 * @property {string} badge            "추천" 등
 */
function modelInfo(id, label, tagline, description, input, output, fallback, badge = '') {
  return Object.freeze({
    id, label, tagline, description, input_per_mtok: input, output_per_mtok: output,
    supports_fallback: fallback, badge,
  });
}

/** @type {ReadonlyArray<ModelInfo>} */
export const MODELS = Object.freeze([
  modelInfo('claude-opus-5-5', 'Claude Opus 5.5', '깊은 분석과 비용의 균형',
    '장시간 에이전트 작업과 지식 작업용 최신 Opus. 이 에이전트의 기본 모델이며 중간고사 실행에 사용한 모델입니다.',
    4.0, 20.0, true, '추천'),
  modelInfo('claude-sonnet-5-5', 'Claude Sonnet 5.5', '빠르고 경제적',
    '속도와 성능의 균형이 좋은 최신 Sonnet. Opus 5.5의 절반 가격으로 일상적인 조사에 적합합니다.',
    2.0, 10.0, true),
  modelInfo('claude-haiku-5-5', 'Claude Haiku 5.5', '가장 빠르고 저렴',
    '가장 빠르고 저렴한 모델. 가벼운 탐색이나 시험 실행에 적합합니다. (가격은 프롬프트 10만 토큰 이하 기준)',
    0.10, 0.50, false),
  modelInfo('claude-fable-5-2', 'Claude Fable 5.2', '최고 성능 · 높은 비용',
    '가장 성능이 높은 모델. 가장 어려운 주제에 사용하세요. Opus 5.5의 2배 가격이며, ' +
    '조직의 데이터 보존 설정이 30일 미만이면 사용할 수 없습니다.',
    8.0, 40.0, true),
]);
export const DEFAULT_MODEL = 'claude-opus-5-5';
const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/** @returns {ModelInfo|null} */
export function getModel(modelId) {
  return BY_ID.get(modelId) || null;
}

export function modelLabel(modelId) {
  const m = BY_ID.get(modelId);
  return m ? m.label : modelId;
}

// Anthropic 웹 검색 도구 요금: 검색 1,000회에 10달러 (토큰 요금과 별도)
export const WEB_SEARCH_USD = 10 / 1000;

/** 토큰 수(와 웹 검색 횟수)로 계산한 대략의 비용(USD). 목록에 없는 모델은 null. */
export function estimateCost(modelId, inputTokens, outputTokens, webSearches = 0) {
  const m = BY_ID.get(modelId);
  if (!m) return null;
  const cost = (inputTokens || 0) * m.input_per_mtok / 1e6 + (outputTokens || 0) * m.output_per_mtok / 1e6
    + (webSearches || 0) * WEB_SEARCH_USD;
  return Math.round(cost * 1e4) / 1e4;
}

// ── 조사 깊이 프리셋 ──
// "standard"는 중간고사 노트북의 기본값과 같다. 토큰 추정치는 2026-11-02 실제 실행 2회
// (Claude Opus 5.5, 순차 실행: 79회/419k in/135k out/23.8분, 75회/432k in/113k out/20.8분)의 평균에서 가져왔고,
// quick/deep은 그 값에 비례해 잡은 대략치다(실측 아님).
// web_searches는 웹 검색(서버 도구) 예상 횟수의 대략치다(실측 아님). 화면은 web_searches × WEB_SEARCH_USD를 예상 비용에 더한다.
export const DEPTH_PRESETS = {
  quick: {
    label: '빠르게', description: '하위 질문 3~4개, 재조사 없음. 주제를 가볍게 훑어볼 때',
    config: { min_subq: 3, max_subq: 4, max_reflection_rounds: 0, max_tool_steps: 2, results_per_search: 5, verify_sample: 6 },
    estimate: { llm_calls: 30, input_tokens: 150_000, output_tokens: 45_000, minutes: [5, 9], measured: false, web_searches: 8 },
  },
  standard: {
    label: '표준', description: '하위 질문 4~6개, 자기 비판 후 최대 2회 재조사. 중간고사 실행과 같은 설정',
    config: { min_subq: 4, max_subq: 6, max_reflection_rounds: 2, max_tool_steps: 4, results_per_search: 6, verify_sample: 10 },
    estimate: { llm_calls: 77, input_tokens: 425_000, output_tokens: 125_000, minutes: [12, 24], measured: true, web_searches: 25 },
  },
  deep: {
    label: '깊게', description: '하위 질문 5~7개, 최대 3회 재조사, 검색·검증 범위 확대. 시간과 비용이 가장 큼',
    config: { min_subq: 5, max_subq: 7, max_reflection_rounds: 3, max_tool_steps: 5, results_per_search: 8, verify_sample: 15 },
    estimate: { llm_calls: 125, input_tokens: 720_000, output_tokens: 210_000, minutes: [20, 40], measured: false, web_searches: 45 },
  },
};
export const DEFAULT_DEPTH = 'standard';

// 사용자가 바꿀 수 있는 값의 허용 범위 (이 범위로 잘라 낸다). max_cost_usd만 실수를 허용한다.
export const LIMITS = {
  min_subq: [2, 8], max_subq: [2, 8], max_reflection_rounds: [0, 4], max_tool_steps: [1, 6],
  results_per_search: [3, 10], verify_sample: [0, 30], parallelism: [1, 6], year_from: [1900, CURRENT_YEAR],
  max_cost_usd: [0, 100],
};
export const LANGUAGES = ['auto', 'ko', 'en'];

// 필드 순서 = toDict()의 키 순서 (원본 dataclass 순서 + 웹 버전 추가 필드)
const FIELDS = ['model', 'depth', 'min_subq', 'max_subq', 'max_reflection_rounds', 'max_tool_steps',
  'results_per_search', 'verify_sample', 'year_from', 'language', 'human_in_the_loop', 'parallelism',
  'formats', 'openalex_email', 'max_cost_usd', 'web_search'];

/** Python int(x)처럼 정수로 읽는다(정수 문자열·숫자만). 읽지 못하면 NaN. */
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : NaN;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

/** 실행 1회의 설정. 노트북 맨 위 셀의 '선택 설정'에 해당한다. */
export class RunConfig {
  /**
   * 값을 검증하지 않고 그대로 넣는다(원본 dataclass 생성자와 같음). 요청 값 검증은 RunConfig.fromDict.
   * @param {Partial<RunConfig>} [values]
   */
  constructor(values = {}) {
    this.model = DEFAULT_MODEL;
    this.depth = DEFAULT_DEPTH;
    this.min_subq = 4;
    this.max_subq = 6;
    this.max_reflection_rounds = 2;   // 자기 비판 → 재계획 → 추가 조사 반복 최대 횟수
    this.max_tool_steps = 4;          // 하위 질문 하나당 검색 도구 호출 라운드 최대 횟수
    this.results_per_search = 6;      // 검색 1회당 가져올 문헌 수
    this.verify_sample = 10;          // 인용 검증할 문장 수
    this.year_from = null;            // null: 에이전트가 결정 / 0: 제한 없음 / 2020: 2020년 이후만
    this.language = 'auto';           // 보고서 언어: auto | ko | en
    this.human_in_the_loop = false;   // true면 조사 계획을 사람이 검토·수정한 뒤 진행
    this.parallelism = 3;             // 동시에 실행할 LLM 호출 수 (1이면 노트북처럼 순차 실행)
    this.formats = ['md'];            // 실행이 끝나면 자동으로 만들 결과물
    this.openalex_email = '';
    this.max_cost_usd = null;         // 비용 한도(USD). null이면 한도 없음
    this.web_search = true;           // Anthropic 웹 검색 서버 도구 사용 여부
    for (const k of FIELDS) {
      if (values && values[k] !== undefined) this[k] = Array.isArray(values[k]) ? [...values[k]] : values[k];
    }
  }

  /**
   * 요청 값을 검증해 RunConfig로 만든다. depth 프리셋을 먼저 적용하고, 개별 값이 있으면 덮어쓴다.
   * 알 수 없는 키는 무시하고, 범위를 벗어난 숫자는 LIMITS 안으로 자른다.
   */
  static fromDict(d) {
    d = { ...(d || {}) };
    const cfg = new RunConfig();
    const depth = Object.prototype.hasOwnProperty.call(DEPTH_PRESETS, d.depth) ? d.depth : DEFAULT_DEPTH;
    cfg.depth = depth;
    Object.assign(cfg, DEPTH_PRESETS[depth].config);
    if (typeof d.model === 'string' && d.model.trim()) cfg.model = d.model.trim();
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      if (k === 'year_from' || k === 'max_cost_usd' || d[k] === null || d[k] === undefined) continue;
      const n = toInt(d[k]);
      if (!Number.isNaN(n)) cfg[k] = Math.max(lo, Math.min(hi, n));
    }
    cfg.max_subq = Math.max(cfg.max_subq, cfg.min_subq);
    const y = d.year_from;
    if (y === null || y === undefined || y === '') {
      cfg.year_from = null;
    } else {
      const n = toInt(y);
      if (Number.isNaN(n)) cfg.year_from = null;
      else cfg.year_from = n <= 0 ? 0 : Math.max(LIMITS.year_from[0], Math.min(LIMITS.year_from[1], n));
    }
    if (LANGUAGES.includes(d.language)) cfg.language = d.language;
    cfg.human_in_the_loop = Boolean(d.human_in_the_loop ?? false);
    if (Array.isArray(d.formats)) {
      const f = d.formats.filter((x) => typeof x === 'string').slice(0, 12);
      cfg.formats = f.length ? f : ['md'];
    }
    if (typeof d.openalex_email === 'string') cfg.openalex_email = d.openalex_email.trim().slice(0, 120);
    // 비용 한도: null/빈 값 = 한도 없음, 그 밖에는 0~100 사이 실수(센트 단위로 반올림)
    const c = d.max_cost_usd;
    if (c !== null && c !== undefined && c !== '') {
      const n = typeof c === 'number' ? c : (typeof c === 'string' ? Number(c.trim()) : NaN);
      if (Number.isFinite(n)) {
        const [lo, hi] = LIMITS.max_cost_usd;
        cfg.max_cost_usd = Math.round(Math.max(lo, Math.min(hi, n)) * 100) / 100;
      }
    }
    if (d.web_search !== undefined && d.web_search !== null) cfg.web_search = Boolean(d.web_search);
    return cfg;
  }

  /** 원본 RunConfig.to_dict()와 같은 키(+ max_cost_usd, web_search). */
  toDict() {
    const out = {};
    for (const k of FIELDS) out[k] = Array.isArray(this[k]) ? [...this[k]] : this[k];
    return out;
  }
}

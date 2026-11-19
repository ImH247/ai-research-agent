// Claude 호출 래퍼: 구조화 출력, 스트리밍, 사용량 집계, 거절(refusal) 시 서버측 fallback, 오류 변환. (원본: agent/llm.py)
//
// - 브라우저에서 사용자의 API 키로 api.anthropic.com을 직접 부른다(공식 SDK, dangerouslyAllowBrowser).
// - 모든 요청에 output_config의 effort를 명시한다. thinking·temperature·tool_choice는 보내지 않는다.
// - fallback은 getModel(model).supports_fallback이 참인 모델만 beta 경로로 호출한다.
// - 요청마다 취소 신호(signal)를 요청 옵션으로 넘긴다. 취소로 끝난 요청은 RunCancelled로 바꾼다.
// - 그 밖의 SDK 오류는 그대로 던진다(호출부가 friendlyError로 바꾼다. 원본과 같음).

import Anthropic, {
  APIError, APIConnectionError, APIUserAbortError, AuthenticationError, PermissionDeniedError,
  NotFoundError, RateLimitError, BadRequestError,
} from '../../../vendor/anthropic-sdk.js';
import { getModel, estimateCost } from './models.js';

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 사용자가 실행을 취소했을 때 던지는 예외. */
export class RunCancelled extends Error {
  constructor(message = '실행이 취소되었습니다.') {
    super(message);
    this.name = 'RunCancelled';
  }
}

/** 사용자에게 그대로 보여 줄 수 있는 오류.
 * code: auth|permission|model|rate_limit|billing|bad_request|connection|server|refusal|unknown */
export class LLMError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
  }
}

const MSG_SERVER = 'Anthropic 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
const MSG_BILLING = '크레딧이 부족합니다. Anthropic 콘솔에서 결제 상태를 확인해 주세요.';
const MSG_AUTH = 'API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.';
const MSG_PERMISSION = '이 API 키로는 이 요청을 할 권한이 없습니다.';
const MSG_MODEL = '모델을 찾을 수 없거나 이 키로 사용할 수 없습니다.';
const MSG_RATE = '요청이 너무 많아 속도 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.';
const MSG_CONNECTION = 'Anthropic API에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.';

// API 오류 유형(error.type) → [code, 메시지]
const ERROR_TYPES = {
  overloaded_error: ['server', MSG_SERVER],
  api_error: ['server', MSG_SERVER],
  rate_limit_error: ['rate_limit', MSG_RATE],
  billing_error: ['billing', MSG_BILLING],
  authentication_error: ['auth', MSG_AUTH],
  permission_error: ['permission', MSG_PERMISSION],
  not_found_error: ['model', MSG_MODEL],
};

/** 예외의 type 속성, 없으면 본문의 error.type. */
function apiErrorType(err) {
  if (typeof err?.type === 'string' && err.type) return err.type;
  const body = err?.error;
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error.type === 'string') return body.error.type;
    if (typeof body.type === 'string' && body.type !== 'error') return body.type;
  }
  return null;
}

const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TRANSPORT_TEXT = /failed to fetch|fetch failed|networkerror|network error|load failed|terminated|socket|connection (reset|closed|refused)|err_network|err_connection|timed? ?out/i;

/** 브라우저 fetch 실패(TypeError: Failed to fetch 등), 스트림 도중 끊김, 시간 초과처럼 SDK 오류로 감싸지지 않은 전송 오류. */
function isTransportError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'TimeoutError' || err.name === 'NetworkError') return true;
  if (TRANSPORT_CODES.has(err.code) || TRANSPORT_CODES.has(err.cause?.code)) return true;
  if (err instanceof TypeError && TRANSPORT_TEXT.test(String(err.message))) return true;
  return err.name === 'Error' && /^(terminated|socket hang up|other side closed)/i.test(String(err.message));
}

/** 취소(AbortSignal)로 끝난 요청인지. */
export function isAbortError(err) {
  return err instanceof RunCancelled || err instanceof APIUserAbortError || err?.name === 'AbortError';
}

/**
 * SDK·브라우저 예외를 한국어 메시지의 LLMError로 바꾼다. 하위 클래스가 먼저 걸리도록 가장 구체적인 것부터 검사한다.
 * 취소로 끝난 요청(AbortError, APIUserAbortError)은 RunCancelled를 돌려준다.
 * 메시지에 API 키나 요청 본문은 넣지 않는다.
 * @returns {LLMError|RunCancelled}
 */
export function friendlyError(err) {
  if (err instanceof LLMError || err instanceof RunCancelled) return err;
  if (isAbortError(err)) return new RunCancelled();
  const text = String(err?.message ?? err ?? '').toLowerCase();
  const isStatusError = err instanceof APIError && !(err instanceof APIConnectionError);
  if (isStatusError) {
    // 스트림 도중의 error 이벤트는 상태 코드가 없을 수 있으므로 API 오류 유형을 먼저 본다.
    const mapped = ERROR_TYPES[apiErrorType(err)];
    if (mapped) return new LLMError(...mapped);
  }
  if (err instanceof AuthenticationError) return new LLMError('auth', MSG_AUTH);
  if (err instanceof PermissionDeniedError) return new LLMError('permission', MSG_PERMISSION);
  if (err instanceof NotFoundError) return new LLMError('model', MSG_MODEL);
  if (err instanceof RateLimitError) return new LLMError('rate_limit', MSG_RATE);
  if (err instanceof BadRequestError) {
    if (text.includes('credit')) return new LLMError('billing', MSG_BILLING);
    if (text.includes('data retention')) {
      return new LLMError('bad_request', '이 모델은 조직의 데이터 보존 설정이 필요합니다. ' +
        '데이터 보존 기간이 30일 미만이면 사용할 수 없으니 다른 모델을 선택해 주세요.');
    }
    return new LLMError('bad_request', '요청 형식이 올바르지 않습니다(400). 설정을 바꿔 다시 시도해 주세요.');
  }
  if (isStatusError) {
    const status = Number(err.status) || 0;
    if (status === 402) return new LLMError('billing', MSG_BILLING);
    if (status >= 500) return new LLMError('server', MSG_SERVER);
    return new LLMError('unknown', `API 오류가 발생했습니다(상태 코드 ${status}).`);
  }
  if (err instanceof APIConnectionError || isTransportError(err)) return new LLMError('connection', MSG_CONNECTION);
  const name = err?.name || err?.constructor?.name || typeof err;
  return new LLMError('unknown', `알 수 없는 오류가 발생했습니다(${name}).`);
}

function makeClient(apiKey, maxRetries) {
  if (!apiKey) throw new LLMError('auth', 'API 키가 설정되지 않았습니다.');
  try {
    return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries });
  } catch {
    throw new LLMError('auth', 'API 키가 설정되지 않았습니다.');
  }
}

/**
 * 키 확인용: 이 키로 쓸 수 있는 모델 id 목록. 실패하면 LLMError.
 * @param {string} apiKey
 * @param {{client?: object, signal?: AbortSignal}} [opts]  client: 테스트용 가짜 SDK
 */
export async function listModels(apiKey, { client = null, signal = null } = {}) {
  try {
    const c = client || makeClient(apiKey, 1);
    const ids = [];
    for await (const m of c.models.list({}, signal ? { signal } : undefined)) ids.push(m.id);
    return ids;
  } catch (e) {
    throw friendlyError(e);
  }
}

function btype(block) {
  return block?.type ?? '';
}

/** Claude 호출 래퍼: 구조화 출력, 사용량 집계, 거절(refusal) 시 서버측 fallback. */
export class LLM {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]
   * @param {string} opts.model
   * @param {(msg: string) => void} [opts.onWarning]
   * @param {AbortSignal} [opts.signal]  취소 신호. 모든 요청에 요청 옵션으로 넘긴다
   * @param {object} [opts.client]       테스트용 가짜 SDK(new Anthropic(...)과 같은 모양)
   */
  constructor({ apiKey = null, model, onWarning = null, signal = null, client = null } = {}) {
    this.client = client || makeClient(apiKey, 4);
    this.model = model;
    const info = getModel(model);
    this.useFallback = Boolean(info && info.supports_fallback);   // 목록에 없는 모델은 fallback 없이 호출
    this.onWarning = onWarning;
    this.signal = signal;
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
  }

  _warn(msg) {
    if (this.onWarning) this.onWarning(msg);
  }

  _requestOptions() {
    return this.signal ? { signal: this.signal } : undefined;
  }

  /** api = client.messages 또는 client.beta.messages. 스트리밍이면 조각을 onDelta로 넘기고 최종 메시지를 반환. */
  async _send(api, stream, onDelta, params) {
    const options = this._requestOptions();
    if (!stream) return api.create(params, options);
    const s = api.stream(params, options);
    let deltaError = null;
    if (onDelta) {
      s.on('text', (delta) => {
        if (deltaError) return;
        try {
          onDelta(delta);
        } catch (e) {
          deltaError = e;      // onDelta가 RunCancelled 등을 던지면 스트림을 멈추고 그 예외를 전파
          s.abort();
        }
      });
    }
    let msg;
    try {
      msg = await s.finalMessage();
    } catch (e) {
      // 도중에 끊기거나 취소된 스트림도 이미 받은 토큰은 과금된다 → 부분 사용량을 더한다(호출 수는 늘리지 않음)
      this._trackPartial(LLM._partialUsage(s));
      if (deltaError) throw deltaError;
      throw e;
    }
    if (deltaError) {
      this._trackPartial(msg?.usage || LLM._partialUsage(s));
      throw deltaError;
    }
    return msg;
  }

  /** SDK 스트림이 지금까지 모은 메시지의 usage (없으면 null) */
  static _partialUsage(s) {
    try {
      const u = s?.currentMessage?.usage;
      return u && typeof u === 'object' ? u : null;
    } catch {
      return null;
    }
  }

  /** 실패한 요청의 부분 사용량: 토큰·웹 검색 횟수만 더하고 calls는 그대로 둔다. */
  _trackPartial(u) {
    if (!u) return;
    const [inp, out] = LLM._tokens(u);
    this.usage.input_tokens += Number(inp) || 0;
    this.usage.output_tokens += Number(out) || 0;
    const searches = Number(u?.server_tool_use?.web_search_requests) || 0;
    if (searches) this.usage.web_searches = (this.usage.web_searches || 0) + searches;
  }

  async _create(params, { stream = false, onDelta = null } = {}) {
    const kw = { model: this.model, ...params };
    try {
      if (this.useFallback) {
        try {
          const extra = { betas: [FALLBACK_BETA], fallbacks: 'default' };
          return this._track(await this._send(this.client.beta.messages, stream, onDelta, { ...kw, ...extra }));
        } catch (e) {
          if (!(e instanceof BadRequestError || e instanceof TypeError) || !String(e.message).toLowerCase().includes('fallback')) {
            throw e;
          }
          this.useFallback = false;   // 이 계정/환경에서 미지원 → 일반 호출로 전환
          this._warn('서버측 fallback을 쓸 수 없어 일반 호출로 전환합니다.');
        }
      }
      return this._track(await this._send(this.client.messages, stream, onDelta, kw));
    } catch (e) {
      if (isAbortError(e) || (this.signal && this.signal.aborted && !(e instanceof LLMError))) {
        throw e instanceof RunCancelled ? e : new RunCancelled();
      }
      throw e;
    }
  }

  /** [input, output]. 서버측 fallback에서는 최상위 usage가 최종 시도만 담으므로,
   * usage.iterations가 토큰 필드를 가진 비어 있지 않은 목록이면 그 합을 쓴다. */
  static _tokens(u) {
    const its = u ? u.iterations : null;
    if (Array.isArray(its) && its.length &&
        its.every((i) => Number.isInteger(i?.input_tokens) && Number.isInteger(i?.output_tokens))) {
      return [its.reduce((a, i) => a + i.input_tokens, 0), its.reduce((a, i) => a + i.output_tokens, 0)];
    }
    return [u?.input_tokens || 0, u?.output_tokens || 0];
  }

  _track(resp) {
    const [inp, out] = LLM._tokens(resp?.usage);
    this.usage.calls += 1;
    this.usage.input_tokens += inp;
    this.usage.output_tokens += out;
    // 웹 검색 서버 도구는 검색 횟수만큼 따로 과금된다
    const searches = Number(resp?.usage?.server_tool_use?.web_search_requests) || 0;
    if (searches) this.usage.web_searches = (this.usage.web_searches || 0) + searches;
    return resp;
  }

  /** 지금까지의 대략 비용(USD, 웹 검색 요금 포함). 목록에 없는 모델은 null. */
  costUsd() {
    return estimateCost(this.model, this.usage.input_tokens, this.usage.output_tokens, this.usage.web_searches || 0);
  }

  /** 응답의 text 블록을 이어 붙인 글 (원본 LLM._text) */
  static textOf(resp) {
    return (resp?.content || []).filter((b) => btype(b) === 'text').map((b) => b.text).join('').trim();
  }

  /** 다음 요청의 assistant 턴으로 되돌려 보낼 content.
   * fallback 블록이 있으면 마지막 fallback 블록보다 앞의 thinking·redacted_thinking·tool_use 블록을 뺀다. */
  static echoContent(resp) {
    const content = [...(resp?.content || [])];
    let last = -1;
    content.forEach((b, i) => { if (btype(b) === 'fallback') last = i; });
    if (last < 0) return resp.content;
    const drop = ['thinking', 'redacted_thinking', 'tool_use'];
    return content.filter((b, i) => !(i < last && drop.includes(btype(b))));
  }

  // 원본은 self.llm.text_of(...)처럼 인스턴스에서도 부르므로 같은 이름의 인스턴스 메서드도 둔다.
  textOf(resp) { return LLM.textOf(resp); }
  echoContent(resp) { return LLM.echoContent(resp); }

  /** 글 1편. stream이면 onDelta(조각)를 부른다. 거절이면 LLMError('refusal'). */
  async text(system, prompt, { effort = 'medium', maxTokens = 16000, stream = false, onDelta = null } = {}) {
    const resp = await this._create({
      system, max_tokens: maxTokens, output_config: { effort },
      messages: [{ role: 'user', content: prompt }],
    }, { stream, onDelta });
    if (resp.stop_reason === 'refusal') {
      throw new LLMError('refusal', '모델이 이 요청을 거절했습니다(refusal). 주제나 표현을 바꿔 다시 시도해 주세요.');
    }
    if (resp.stop_reason === 'max_tokens') this._warn('출력 길이 한도(max_tokens)에 도달해 글이 중간에 잘렸을 수 있습니다.');
    return LLM.textOf(resp);
  }

  /** 구조화 출력(JSON 스키마). 거절·길이 초과·해석 실패면 경고 후 null. */
  async json(system, prompt, schema, { effort = 'medium', maxTokens = 16000 } = {}) {
    const resp = await this._create({
      system, max_tokens: maxTokens,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
    if (resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') {
      this._warn(`구조화 출력 실패(stop_reason=${resp.stop_reason})`);
      return null;
    }
    try {
      return JSON.parse(LLM.textOf(resp));
    } catch {
      this._warn('구조화 출력을 JSON으로 읽지 못했습니다.');
      return null;
    }
  }

  /** 도구 호출 1턴. 응답 객체를 그대로 반환한다(거절이면 도구 호출이 없는 응답으로 처리됨). */
  async toolTurn(system, messages, tools, { effort = 'low', maxTokens = 8000 } = {}) {
    const resp = await this._create({ system, messages, tools, max_tokens: maxTokens, output_config: { effort } });
    if (resp.stop_reason === 'refusal') this._warn('모델이 이 요청을 거절했습니다(refusal).');
    return resp;
  }
}

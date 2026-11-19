// engine/llm.js: 진짜 SDK(vendor/anthropic-sdk.js)에 가짜 fetch를 꽂아 요청 모양·응답 처리·오류 변환을 확인한다(네트워크 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic, { APIConnectionError, AuthenticationError } from '../vendor/anthropic-sdk.js';
import { LLM, LLMError, RunCancelled, friendlyError, listModels, FALLBACK_BETA } from '../assets/js/engine/llm.js';

function message(content, stop = 'end_turn', usage = { input_tokens: 10, output_tokens: 5 }) {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content,
    stop_reason: stop, stop_sequence: null, usage };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
}

function errorResponse(status, type, msg) {
  return jsonResponse({ type: 'error', error: { type, message: msg } }, status);
}

function sseResponse(text, stop = 'end_turn') {
  const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const parts = [ev('message_start', { type: 'message_start', message: message([], null, { input_tokens: 7, output_tokens: 0 }) }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })];
  for (let i = 0; i < text.length; i += 5) {
    parts.push(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 5) } }));
  }
  parts.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } }),
    ev('message_stop', { type: 'message_stop' }));
  return new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 응답 목록을 차례로 돌려주는 가짜 fetch + 받은 요청 기록 */
function fakeClient(responses) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ url: String(url), method: init.method, headers, body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (typeof r === 'function') return r(init);
    if (r instanceof Error) throw r;
    return r;
  };
  const client = new Anthropic({ apiKey: 'sk-ant-test-key', fetch, maxRetries: 0, dangerouslyAllowBrowser: true });
  return { client, requests };
}

test('json(): fallback 모델은 beta 경로, effort·format 명시, 금지 파라미터 없음, iterations 합산', async () => {
  const usage = { input_tokens: 3, output_tokens: 2, iterations: [{ input_tokens: 10, output_tokens: 4 }, { input_tokens: 20, output_tokens: 6 }] };
  const { client, requests } = fakeClient([jsonResponse(message([{ type: 'text', text: '{"a": 1}' }], 'end_turn', usage))]);
  const llm = new LLM({ model: 'claude-opus-5-5', client });
  const out = await llm.json('sys', 'prompt', { type: 'object' }, { effort: 'low' });
  assert.deepEqual(out, { a: 1 });
  const req = requests[0];
  assert.match(req.url, /\/v1\/messages/);
  assert.match(req.headers['anthropic-beta'], new RegExp(FALLBACK_BETA));
  assert.equal(req.body.fallbacks, 'default');
  assert.deepEqual(req.body.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
  for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'betas']) assert.ok(!(k in req.body), k);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.deepEqual(llm.usage, { calls: 1, input_tokens: 30, output_tokens: 10 });
  assert.equal(llm.costUsd(), Math.round((30 * 4 + 10 * 20) / 1e6 * 1e4) / 1e4);
  assert.ok(!JSON.stringify(req.body).includes('sk-ant-test-key'));
});

test('fallback이 든 400이면 경고 후 일반 호출로 전환', async () => {
  const { client, requests } = fakeClient([errorResponse(400, 'invalid_request_error', 'fallbacks: unsupported for this account'),
    jsonResponse(message([{ type: 'text', text: 'ok' }])), jsonResponse(message([{ type: 'text', text: 'ok2' }]))]);
  const warnings = [];
  const llm = new LLM({ model: 'claude-sonnet-5-5', client, onWarning: (m) => warnings.push(m) });
  assert.equal(await llm.text('s', 'p'), 'ok');
  assert.equal(await llm.text('s', 'p'), 'ok2');
  assert.equal(requests.length, 3);
  assert.doesNotMatch(requests[1].headers['anthropic-beta'] || '', /fallback/);
  assert.match(requests[0].headers['anthropic-beta'], /fallback/);
  assert.ok(!('fallbacks' in requests[1].body));
  assert.equal(llm.useFallback, false);
  assert.equal(warnings.length, 1);
  assert.equal(llm.usage.calls, 2);
});

test('Haiku는 일반 경로, 거절이면 json()은 null+경고, text()는 refusal 오류', async () => {
  const { client, requests } = fakeClient([jsonResponse(message([], 'refusal')), jsonResponse(message([], 'refusal')),
    jsonResponse(message([{ type: 'text', text: '잘린 글' }], 'max_tokens'))]);
  const warnings = [];
  const llm = new LLM({ model: 'claude-haiku-5-5', client, onWarning: (m) => warnings.push(m) });
  assert.equal(await llm.json('s', 'p', { type: 'object' }), null);
  await assert.rejects(llm.text('s', 'p'), (e) => e instanceof LLMError && e.code === 'refusal');
  assert.equal(await llm.text('s', 'p'), '잘린 글');
  assert.doesNotMatch(requests[0].headers['anthropic-beta'] || '', /fallback/);
  assert.ok(!('fallbacks' in requests[0].body));
  assert.equal(warnings.length, 2);
});

test('스트리밍: on("text") 조각 전달, finalMessage, onDelta의 RunCancelled는 그대로 전파', async () => {
  const { client, requests } = fakeClient([sseResponse('안녕하세요 보고서입니다 [S1].'), sseResponse('abcdefghijklmnopqrstuvwxyz')]);
  const llm = new LLM({ model: 'claude-opus-5-5', client });
  const deltas = [];
  const out = await llm.text('s', 'p', { stream: true, onDelta: (t) => deltas.push(t), maxTokens: 64000, effort: 'high' });
  assert.equal(out, '안녕하세요 보고서입니다 [S1].');
  assert.equal(deltas.join(''), out);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.max_tokens, 64000);
  assert.deepEqual(llm.usage, { calls: 1, input_tokens: 7, output_tokens: 9 });
  let n = 0;
  await assert.rejects(llm.text('s', 'p', { stream: true, onDelta: () => { if (++n === 2) throw new RunCancelled(); } }),
    (e) => e instanceof RunCancelled);
});

test('취소 신호: 요청 옵션으로 넘어가고, 취소된 요청은 RunCancelled', async () => {
  const ctl = new AbortController();
  let seenSignal = null;
  const { client } = fakeClient([(init) => { seenSignal = init.signal; ctl.abort(); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }]);
  const llm = new LLM({ model: 'claude-opus-5-5', client, signal: ctl.signal });
  await assert.rejects(llm.toolTurn('s', [{ role: 'user', content: 'x' }], []), (e) => e instanceof RunCancelled);
  assert.ok(seenSignal);
});

test('friendlyError: SDK 오류·브라우저 fetch 실패를 한국어 LLMError로', async () => {
  const cases = [
    [errorResponse(401, 'authentication_error', 'invalid x-api-key'), 'auth'],
    [errorResponse(403, 'permission_error', 'no'), 'permission'],
    [errorResponse(404, 'not_found_error', 'model: x'), 'model'],
    [errorResponse(429, 'rate_limit_error', 'slow down'), 'rate_limit'],
    [errorResponse(400, 'invalid_request_error', 'Your credit balance is too low'), 'billing'],
    [errorResponse(400, 'invalid_request_error', 'requires data retention'), 'bad_request'],
    [errorResponse(529, 'overloaded_error', 'Overloaded'), 'server'],
    [errorResponse(500, 'api_error', 'x'), 'server'],
    [new TypeError('Failed to fetch'), 'connection'],
  ];
  for (const [r, code] of cases) {
    const { client } = fakeClient([r]);
    const llm = new LLM({ model: 'claude-haiku-5-5', client });
    const err = await llm.text('s', 'p').catch((e) => e);
    const fe = friendlyError(err);
    assert.ok(fe instanceof LLMError, code);
    assert.equal(fe.code, code, `${code}: ${err?.constructor?.name} ${err?.message}`);
    assert.ok(!fe.message.includes('sk-ant'));
  }
  assert.equal(friendlyError(new TypeError('NetworkError when attempting to fetch resource.')).code, 'connection');
  assert.equal(friendlyError(new APIConnectionError({ message: 'Connection error.' })).code, 'connection');
  assert.equal(friendlyError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).code, 'connection');
  assert.equal(friendlyError(new ValueErrorLike()).code, 'unknown');
  const own = new LLMError('auth', 'x');
  assert.equal(friendlyError(own), own);
  assert.ok(friendlyError(Object.assign(new Error('a'), { name: 'AbortError' })) instanceof RunCancelled);
  assert.ok(new AuthenticationError(401, {}, 'x', new Headers()) instanceof Error);
});

class ValueErrorLike extends Error {}

test('listModels: models.list() 순회, 실패하면 LLMError', async () => {
  const { client } = fakeClient([jsonResponse({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-haiku-5-5', type: 'model' }],
    has_more: false, first_id: 'a', last_id: 'b' })]);
  assert.deepEqual(await listModels('k', { client }), ['claude-opus-5-5', 'claude-haiku-5-5']);
  const bad = fakeClient([errorResponse(401, 'authentication_error', 'invalid x-api-key')]);
  await assert.rejects(listModels('k', { client: bad.client }), (e) => e instanceof LLMError && e.code === 'auth');
  await assert.rejects(listModels(''), (e) => e instanceof LLMError && e.code === 'auth');
});

test('echoContent: 마지막 fallback 블록 앞의 thinking·tool_use만 뺀다, textOf', () => {
  const content = [{ type: 'thinking', thinking: 'a' }, { type: 'tool_use', id: 't' }, { type: 'text', text: 'x' },
    { type: 'fallback' }, { type: 'text', text: ' y ' }, { type: 'tool_use', id: 'u' }];
  assert.deepEqual(LLM.echoContent({ content }).map((b) => b.type), ['text', 'fallback', 'text', 'tool_use']);
  const plain = [{ type: 'text', text: 'a' }];
  assert.equal(LLM.echoContent({ content: plain }), plain);
  assert.equal(LLM.textOf({ content }), 'x y');
  assert.throws(() => new LLM({ model: 'claude-opus-5-5' }), (e) => e instanceof LLMError && e.code === 'auth');
});

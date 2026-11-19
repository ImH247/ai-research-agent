// 조사 파일(실행 파일) 저장·열기 (SITE_SPEC 3.8). 끝난 실행 1건을 JSON 파일 하나로 내보내고 다시 가져온다.
//
// {"format": "ai-research-agent/run", "version": 1, "exported_at": "…", "app_version": "2.0.0-web",
//  "result": { …PYTHON_SPEC 3.2… }, "events": [ … ], "qa": [ … ]}
// 문자열 필드는 그대로 두고(화면은 항상 이스케이프한다), 모양만 검사한다. API 키는 result·이벤트·Q&A 어디에도 없다.

import { APP_VERSION } from './models.js';
import { BackendError, cleanEvents, isoLocal } from './runs.js';

export const RUN_FILE_FORMAT = 'ai-research-agent/run';
export const RUN_FILE_VERSION = 1;
export const MAX_RUN_FILE_BYTES = 20 * 1024 * 1024;

/** Q&A 기록 검사: 질문·답이 문자열인 항목만, 필요한 키만 남긴다. */
export function cleanQa(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === 'object' && typeof x.question === 'string' && typeof x.answer_markdown === 'string')
    .map((x) => ({ question: x.question, answer_markdown: x.answer_markdown,
      sources: Array.isArray(x.sources) ? x.sources.filter((s) => typeof s === 'string') : [],
      ts: typeof x.ts === 'string' ? x.ts : '' }));
}

/** 파일 이름: 주제 + _run.json (한글 유지, 파일 이름에 못 쓰는 문자는 _) */
export function runFileName(result) {
  const topic = String(result?.topic || result?.prompt || '');
  const slug = topic.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '') || 'research';
  return `${slug}_run.json`;
}

/**
 * 조사 파일 내용(JSON 문자열)을 만든다.
 * @param {object} result  result.json
 * @param {object[]} [events]
 * @param {object[]} [qa]
 * @param {{now?: () => Date}} [opts]
 * @returns {string}
 */
export function buildRunFile(result, events = [], qa = [], { now = () => new Date() } = {}) {
  return JSON.stringify({
    format: RUN_FILE_FORMAT, version: RUN_FILE_VERSION, exported_at: isoLocal(now()), app_version: APP_VERSION,
    result: result || {}, events: cleanEvents(events), qa: cleanQa(qa),
  }, null, 1);
}

function invalid(message) {
  return new BackendError('invalid_file', message, 400);
}

/**
 * 조사 파일을 읽어 검사한다. → { result, events, qa }. 형식이 다르면 BackendError('invalid_file').
 * 결과물로 내보낸 result.json(전체 데이터 JSON)도 그대로 열 수 있다(이벤트·Q&A 없음).
 * @param {string|ArrayBuffer|Uint8Array} text
 */
export function parseRunFile(text) {
  if (text instanceof ArrayBuffer || ArrayBuffer.isView(text)) {
    const bytes = text instanceof ArrayBuffer ? new Uint8Array(text) : new Uint8Array(text.buffer, text.byteOffset, text.byteLength);
    if (bytes.byteLength > MAX_RUN_FILE_BYTES) throw invalid('파일이 너무 큽니다(20MB 이하만 열 수 있습니다).');
    text = new TextDecoder('utf-8').decode(bytes);
  }
  if (typeof text !== 'string' || !text.trim()) throw invalid('빈 파일입니다. 이 사이트에서 저장한 조사 파일(.json)을 골라 주세요.');
  if (text.length > MAX_RUN_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_RUN_FILE_BYTES) {
    throw invalid('파일이 너무 큽니다(20MB 이하만 열 수 있습니다).');
  }
  let obj;
  try {
    obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw invalid('JSON 파일이 아니거나 내용이 깨져 있습니다. 이 사이트에서 저장한 조사 파일(.json)을 골라 주세요.');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw invalid('조사 파일 형식이 아닙니다.');
  let result;
  let events = [];
  let qa = [];
  if (obj.format === undefined && typeof obj.report_markdown === 'string' && Array.isArray(obj.sources)) {
    result = obj;                                   // 결과물로 내보낸 result.json
  } else {
    if (obj.format !== RUN_FILE_FORMAT) throw invalid('조사 파일 형식이 아닙니다(이 사이트에서 저장한 파일이 아닙니다).');
    if (obj.version !== RUN_FILE_VERSION) throw invalid(`지원하지 않는 조사 파일 버전입니다(${String(obj.version).slice(0, 20)}).`);
    result = obj.result;
    events = cleanEvents(obj.events);
    qa = cleanQa(obj.qa);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid('조사 파일에 결과(result)가 없습니다.');
  if (typeof result.report_markdown !== 'string') throw invalid('조사 파일의 보고서 본문(report_markdown)이 올바르지 않습니다.');
  if (!Array.isArray(result.sources)) throw invalid('조사 파일의 문헌 목록(sources)이 올바르지 않습니다.');
  return { result, events, qa };
}

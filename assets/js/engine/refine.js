// 주제 다듬기(웹 버전 새 기능): 사용자가 적은 초안을 조사하기 좋은 연구 요청문 3가지로 다듬어 제안한다.
// 모델은 호출부가 정한다(기본 REFINE_MODEL, effort low, max_tokens 4000).

import { LLMError } from './llm.js';
import { SYS_BASE } from './prompts.js';
import { A, O, S } from './schema.js';

export const REFINE_MODEL = 'claude-haiku-5-5';
export const REFINE_SCHEMA = O({ suggestions: A(O({ prompt: S, focus: S, why: S })), questions: A(S) });

/**
 * @param {object} llm   LLM 또는 FakeLLM
 * @param {string} draft 사용자 초안
 * @param {'auto'|'ko'|'en'} [lang]  제안을 쓸 언어 (auto면 초안의 언어)
 * @returns {Promise<{suggestions: Array<{prompt: string, focus: string, why: string}>, questions: string[]}>}
 *   suggestions는 정확히 3개, questions는 0~3개
 */
export async function refinePrompt(llm, draft, lang = 'auto') {
  const text = String(draft || '').trim();
  if (!text) throw new LLMError('bad_request', '다듬을 주제나 요청문을 먼저 입력해 주세요.');
  const langLine = lang === 'ko' || lang === 'en' ? `language "${lang}"` : 'the same language as the draft';
  const system = SYS_BASE + ' You help the student turn a rough idea into a research request that a literature-review agent can investigate well.';
  const prompt = `Draft research request from the user:
"""${text.slice(0, 4000)}"""

Rewrite it into exactly 3 improved research requests.
- Each suggestion keeps the user's core topic but makes ONE aspect more specific, and the three must differ in focus:
  scope (which aspect or outcome), population/target (who or what is studied), period (time window),
  or method (what kind of evidence or study design to look for). Use a different one for each suggestion.
- prompt: the rewritten request, about 140 characters, written as the user would type it.
- focus: a short label of what was made specific (2-5 words).
- why: one sentence on why this version is easier to investigate.
- questions: 0 to 3 short clarifying questions about real ambiguities in the draft (empty list if there are none).
- Do not invent facts, statistics, study names or numbers. Do not answer the research question.
Write prompt, focus, why and questions in ${langLine}.`;
  const out = await llm.json(system, prompt, REFINE_SCHEMA, { effort: 'low', maxTokens: 4000 });
  const suggestions = (out?.suggestions || [])
    .map((s) => ({ prompt: String(s?.prompt || '').trim(), focus: String(s?.focus || '').trim(), why: String(s?.why || '').trim() }))
    .filter((s) => s.prompt)
    .slice(0, 3);
  if (suggestions.length < 3) throw new LLMError('unknown', '주제 다듬기 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const questions = (out?.questions || []).map((q) => String(q || '').trim()).filter(Boolean).slice(0, 3);
  return { suggestions, questions };
}

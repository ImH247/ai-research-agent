// 검색 도구(Tools): 학술 DB 3종 — 모두 API 키 불필요. 노트북 셀 ④를 옮겼다. (원본: agent/tools.py)
//
// 웹 버전 변경점:
// - 브라우저 fetch 사용(User-Agent 헤더는 브라우저가 정하므로 바꾸지 않는다), 25초 시간 제한, 429는 2·4·8초(+지터) 재시도.
// - arXiv는 뺀다: arXiv API가 CORS를 허용하지 않아 브라우저에서 읽을 수 없다(OpenAlex·Semantic Scholar가 arXiv 프리프린트도 색인한다).
// - 웹 검색(DuckDuckGo)은 Anthropic 웹 검색 서버 도구(WEB_SEARCH_TOOL)로 바꾼다. Anthropic 쪽에서 실행되므로 TOOL_FUNCS에는 없다.
// - 같은 DB는 순차 호출(속도 제한 준수), 다른 DB끼리는 병렬: 도구 이름별 프로미스 체인(withToolLock).

import { CURRENT_YEAR } from './models.js';
import { O } from './schema.js';
import { Source } from './sources.js';
import { RunCancelled } from './llm.js';

const sleep = (ms, signal = null) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new RunCancelled()); return; }
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(t); reject(new RunCancelled()); }
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/** 바깥 취소 신호와 시간 제한을 합친 신호 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return ctl.signal;
}

/**
 * GET 요청 → JSON(또는 글). 429면 지수 백오프, 그 밖의 실패는 1·2초 쉬고 다시 시도. 끝내 실패하면 Error("요청 실패: …").
 * 취소 신호가 켜지면 RunCancelled.
 */
export async function httpGet(url, params, { asJson = true, retries = 3, timeout = 25000, signal = null } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) qs.append(k, String(v));
  const full = `${url}?${qs}`;
  let last = null;
  for (let i = 0; i < retries; i++) {
    if (signal?.aborted) throw new RunCancelled();
    try {
      const r = await fetch(full, { signal: withTimeout(signal, timeout) });
      if (r.status === 429) {   // 속도 제한 → 지수 백오프
        last = new Error('429 rate limited');
        if (i < retries - 1) await sleep((2 ** (i + 1) + Math.random()) * 1000, signal);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return asJson ? await r.json() : await r.text();
    } catch (e) {
      if (e instanceof RunCancelled || signal?.aborted) throw new RunCancelled();
      last = e?.name === 'TimeoutError' ? new Error('시간 초과') : e;
      if (i < retries - 1) await sleep((1 + i) * 1000, signal);
    }
  }
  throw new Error(`요청 실패: ${last?.message ?? last}`);
}

function openalexAbstract(inv) {
  if (!inv) return '';
  const pos = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) pos.push([p, w]);
  pos.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pos.map(([, w]) => w).join(' ');
}

export async function searchOpenalex(query, { limit = 6, yearFrom = null, email = '', signal = null } = {}) {
  const params = {
    search: query, 'per-page': limit,
    select: 'doi,title,publication_year,primary_location,authorships,cited_by_count,abstract_inverted_index,type,id',
  };
  if (yearFrom) params.filter = `from_publication_date:${yearFrom}-01-01`;
  if (email) params.mailto = email;
  const data = await httpGet('https://api.openalex.org/works', params, { signal });
  return (data?.results || []).map((w) => {
    const src = (w.primary_location || {}).source || {};
    const stype = src.type || '';
    const kind = (w.type === 'preprint' || stype === 'repository') ? 'preprint'
      : ['journal', 'conference'].includes(stype) ? 'peer-reviewed' : 'academic';
    return new Source({
      title: w.title || '', year: w.publication_year ?? null, venue: src.display_name || '',
      authors: (w.authorships || []).slice(0, 6).filter((a) => a.author).map((a) => a.author.display_name),
      abstract: openalexAbstract(w.abstract_inverted_index), doi: w.doi || '',
      url: w.doi || w.id || '', citations: w.cited_by_count ?? null, origin: 'OpenAlex', kind,
    });
  });
}

export async function searchSemanticScholar(query, { limit = 6, yearFrom = null, email = '', signal = null } = {}) {
  const params = {
    query, limit, fields: 'title,abstract,year,venue,authors,citationCount,externalIds,url,publicationTypes',
  };
  if (yearFrom) params.year = `${yearFrom}-`;
  const data = await httpGet('https://api.semanticscholar.org/graph/v1/paper/search', params, { signal });
  return (data?.data || []).map((p) => {
    const types = p.publicationTypes || [];
    const venue = p.venue || '';
    const kind = venue.toLowerCase().includes('arxiv') ? 'preprint'
      : (types.includes('JournalArticle') || types.includes('Conference')) ? 'peer-reviewed' : 'academic';
    const doi = (p.externalIds || {}).DOI || '';
    return new Source({
      title: p.title || '', year: p.year ?? null, venue,
      authors: (p.authors || []).slice(0, 6).map((a) => a.name || ''),
      abstract: p.abstract || '', doi: doi ? `https://doi.org/${doi}` : '',
      url: p.url || '', citations: p.citationCount ?? null, origin: 'SemanticScholar', kind,
    });
  });
}

export async function searchEuropePmc(query, { limit = 6, yearFrom = null, email = '', signal = null } = {}) {
  const q = `(${query})` + (yearFrom ? ` AND PUB_YEAR:[${yearFrom} TO ${CURRENT_YEAR}]` : '');
  const data = await httpGet('https://www.ebi.ac.uk/europepmc/webservices/rest/search',
    { query: q, format: 'json', resultType: 'core', pageSize: limit }, { signal });
  return ((data?.resultList || {}).result || []).map((r) => {
    const doi = r.doi || '';
    return new Source({
      title: r.title || '', year: r.pubYear ? parseInt(r.pubYear, 10) : null,
      venue: (((r.journalInfo || {}).journal || {}).title || '') || r.source || '',
      authors: String(r.authorString || '').split(',').map((a) => a.trim()).slice(0, 6),
      abstract: String(r.abstractText || '').replace(/<[^>]+>/g, ''),
      doi: doi ? `https://doi.org/${doi}` : '',
      url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${r.source}/${r.id}`,
      citations: r.citedByCount ?? null, origin: 'EuropePMC',
      kind: r.source === 'PPR' ? 'preprint' : 'peer-reviewed',
    });
  });
}

/** 코드가 직접 실행하는 검색 도구 (이름 → 함수) */
export const TOOL_FUNCS = {
  search_openalex: searchOpenalex,
  search_semantic_scholar: searchSemanticScholar,
  search_europe_pmc: searchEuropePmc,
};
export const TOOL_DESC = {
  search_openalex: 'OpenAlex: 2억+ 학술문헌, 전 분야(사회과학·교육·경영·공학 등). 기본 검색 도구로 가장 먼저 사용. 영어 키워드 권장.',
  search_semantic_scholar: 'Semantic Scholar: 전 분야 학술문헌, 특히 CS/AI에 강함, 피인용 수 제공. 영어 키워드.',
  search_europe_pmc: 'Europe PMC: 의학·생명과학·보건·심리 문헌(PubMed 포함). 건강·의료·임상 관련 질문에 사용.',
};
// 웹 검색 설명(계획 단계에서 도구 목록을 보여 줄 때 씀). 원본 search_web 설명에서 검색 엔진 이름만 바꿨다.
export const WEB_SEARCH_DESC = '웹 검색(Anthropic 웹 검색): 정책보고서, 기관 통계, 뉴스, 회색문헌, 한국어 자료. 학술 DB에 없는 맥락·최신 사례 확인용.';
export const TOOL_LABELS = {
  search_openalex: 'OpenAlex', search_semantic_scholar: 'Semantic Scholar', search_europe_pmc: 'Europe PMC',
  web_search: '웹 검색',
};
export const TOOLS = Object.entries(TOOL_DESC).map(([name, description]) => ({
  name, description, strict: true,
  input_schema: O({ query: { type: 'string', description: '검색어 (학술 DB는 영어 키워드 3~8단어 권장)' } }),
}));
// Anthropic 웹 검색 서버 도구 (요청 1회에 검색 최대 3번)
// 20260209 버전은 검색 결과를 코드로 걸러 내는 '동적 필터링'을 지원하지만 일부 모델(Claude Haiku 5.5 등)은 이 버전을 쓸 수 없다.
// 그런 모델에는 기본 버전(20250305)을 보낸다. 목록에 없는 모델도 안전하게 기본 버전을 쓴다.
export const WEB_SEARCH_TOOL = Object.freeze({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
export const WEB_SEARCH_TOOL_BASIC = Object.freeze({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
export const DYNAMIC_FILTER_MODELS = Object.freeze(new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']));

/** 모델에 맞는 웹 검색 도구 정의 */
export function webSearchToolFor(modelId) {
  return DYNAMIC_FILTER_MODELS.has(modelId) ? WEB_SEARCH_TOOL : WEB_SEARCH_TOOL_BASIC;
}

// 같은 DB는 순차 호출. 실행 여러 건이 함께 쓰는 페이지 전역 체인(원본의 TOOL_LOCKS)
const toolChains = new Map();

/** 이름이 같은 도구 호출을 차례로 실행한다. fn의 결과(또는 오류)를 그대로 돌려준다. */
export function withToolLock(name, fn) {
  const prev = toolChains.get(name) || Promise.resolve();
  const run = prev.then(() => fn());
  toolChains.set(name, run.catch(() => {}));
  return run;
}

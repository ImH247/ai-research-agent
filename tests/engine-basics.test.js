// engine/models.js, sources.js, tfidf.js, tools.js 기본 동작
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunConfig, MODELS, estimateCost, getModel, modelLabel, LIMITS, APP_VERSION, CURRENT_YEAR, DEPTH_PRESETS } from '../assets/js/engine/models.js';
import { Source, EvidenceStore, normTitle, shortCite } from '../assets/js/engine/sources.js';
import { cosineScores, analyze, ENGLISH_STOP_WORDS } from '../assets/js/engine/tfidf.js';
import { searchOpenalex, searchSemanticScholar, searchEuropePmc, httpGet, withToolLock, TOOLS, TOOL_FUNCS, TOOL_LABELS, WEB_SEARCH_TOOL, webSearchToolFor } from '../assets/js/engine/tools.js';
import { RunCancelled } from '../assets/js/engine/llm.js';

test('RunConfig.fromDict: 프리셋 → 개별 값, 범위 자르기, 새 필드', () => {
  const c = RunConfig.fromDict({ depth: 'quick', min_subq: 99, max_subq: 1, verify_sample: '7', parallelism: 'x',
    year_from: -5, language: 'en', formats: ['md', 3, 'pdf'], openalex_email: '  a@b.c  ', max_cost_usd: '250', unknown: 1 });
  assert.equal(c.depth, 'quick');
  assert.equal(c.max_reflection_rounds, 0);
  assert.equal(c.min_subq, 8);
  assert.equal(c.max_subq, 8);          // max_subq >= min_subq
  assert.equal(c.verify_sample, 7);
  assert.equal(c.parallelism, 3);
  assert.equal(c.year_from, 0);
  assert.equal(c.language, 'en');
  assert.deepEqual(c.formats, ['md', 'pdf']);
  assert.equal(c.openalex_email, 'a@b.c');
  assert.equal(c.max_cost_usd, 100);
  assert.equal(c.web_search, true);
  assert.equal(RunConfig.fromDict({ year_from: 1500 }).year_from, 1900);
  assert.equal(RunConfig.fromDict({ year_from: '' }).year_from, null);
  assert.equal(RunConfig.fromDict({ max_cost_usd: 1.234 }).max_cost_usd, 1.23);
  assert.equal(RunConfig.fromDict({ max_cost_usd: null }).max_cost_usd, null);
  assert.equal(RunConfig.fromDict({ web_search: false }).web_search, false);
  assert.equal(RunConfig.fromDict({ depth: 'nope' }).depth, 'standard');
  const keys = Object.keys(new RunConfig().toDict());
  assert.deepEqual(keys, ['model', 'depth', 'min_subq', 'max_subq', 'max_reflection_rounds', 'max_tool_steps',
    'results_per_search', 'verify_sample', 'year_from', 'language', 'human_in_the_loop', 'parallelism', 'formats',
    'openalex_email', 'max_cost_usd', 'web_search']);
  assert.deepEqual(LIMITS.max_cost_usd, [0, 100]);
  assert.equal(APP_VERSION, '2.0.0-web');
  assert.equal(MODELS.length, 4);
  assert.equal(getModel('claude-haiku-5-5').supports_fallback, false);
  assert.equal(modelLabel('x-model'), 'x-model');
  assert.equal(estimateCost('claude-opus-5-5', 1e6, 1e6), 24);
  assert.equal(estimateCost('x', 1, 1), null);
  assert.equal(DEPTH_PRESETS.standard.config.max_tool_steps, 4);
  assert.equal(new RunConfig({ parallelism: 1 }).parallelism, 1);
});

test('Source: shortCite · toDict · fromDict', () => {
  const s = new Source({ title: 'T', authors: ['John Smith', 'A B'], year: 2024, queries: ['b', 'a'], subqs: ['Q10', 'Q2'] });
  assert.equal(s.shortCite(), 'Smith et al. (2024)');
  assert.equal(new Source({ title: 'T', authors: ['Kim J'] }).shortCite(), 'Kim (n.d.)');
  assert.equal(new Source({ title: 'T', venue: 'Nature' }).shortCite(), 'Nature (n.d.)');
  assert.equal(shortCite({ authors: ['Jane Doe'], year: 2020 }), 'Doe (2020)');
  const d = s.toDict();
  assert.equal(Object.keys(d)[0], 'sid');
  assert.deepEqual(d.queries, ['a', 'b']);
  assert.deepEqual(d.subqs, ['Q2', 'Q10']);
  const back = Source.fromDict({ ...d, included: true, cited: false });
  assert.ok(back.queries instanceof Set);
  assert.ok(!('included' in back));
  assert.deepEqual(back.toDict(), d);
});

test('EvidenceStore: DOI·제목·잘린 웹 제목 병합, 학술 판본 우선, 상태 저장·복원', () => {
  const st = new EvidenceStore();
  const web = st.add(new Source({ title: 'Experimental evidence on the productivity effects of ... - AAAS', kind: 'web', url: 'w' }), 'q1', 'Q1');
  const acad = st.add(new Source({ title: 'Experimental evidence on the productivity eﬀects of generative artificial intelligence',
    kind: 'peer-reviewed', doi: 'https://doi.org/10.1/x', authors: [' A ', ''], year: 2023, abstract: 'long abstract' }), 'q2', 'Q2');
  assert.equal(web.sid, 'S1');
  assert.equal(acad.sid, 'S1');
  assert.equal(st.size, 1);
  assert.equal(st.merged, 1);
  assert.equal(acad.kind, 'peer-reviewed');
  assert.deepEqual([...acad.subqs].sort(), ['Q1', 'Q2']);
  st.add(new Source({ title: 'Other', doi: 'HTTPS://DOI.ORG/10.1/X'.toLowerCase() }));
  assert.equal(st.merged, 2);
  st.add(new Source({ title: 'Second paper' }));
  assert.deepEqual(st.sources().map((s) => s.sid), ['S1', 'S2']);
  assert.equal(st.add(new Source({ title: '' })), null);
  assert.deepEqual(normTitle('Hello ... ', false), ['hello', true]);
  const state = JSON.parse(JSON.stringify(st.toState()));
  const back = EvidenceStore.fromState(state.sources, state.merged, state.keys);
  assert.equal(back.merged, 2);
  back.add(new Source({ title: 'Other title', doi: '10.1/x' }));   // 복원된 DOI 색인으로 병합
  assert.equal(back.size, 2);
  const s1 = back.items.get('S1');
  s1.evaluated = true; s1.relevance = 3; s1.score = 0.5;
  assert.deepEqual(back.included().map((s) => s.sid), ['S1']);
});

test('TF-IDF: 손으로 계산한 예와 같다 (sublinear tf, smooth idf, 1·2-gram, 불용어)', () => {
  assert.equal(ENGLISH_STOP_WORDS.size, 318);
  assert.deepEqual(analyze('The apple, of Banana!'), ['apple', 'banana', 'apple banana']);
  assert.deepEqual(analyze('생성형 AI x'), ['생성형', 'ai', '생성형 ai']);   // 한 글자 토큰은 버림
  // docs = ["apple banana", "apple cherry"], 질의 "banana" (n = 3)
  const a = Math.log(4 / 3) + 1;          // df=2
  const b = Math.log(4 / 2) + 1;          // df=1
  const [s1, s2] = cosineScores('the banana', ['apple banana', 'apple cherry']);
  assert.ok(Math.abs(s1 - a / Math.sqrt(2 * a * a + b * b)) < 1e-12, String(s1));
  assert.equal(s2, 0);
  // tf=2 → 1 + ln 2
  const [t1] = cosineScores('banana', ['banana banana cherry', 'apple']);
  const w = (1 + Math.log(2)) * a;
  assert.ok(Math.abs(t1 - w / Math.sqrt(w * w + 3 * b * b)) < 1e-12, String(t1));
  assert.deepEqual(cosineScores('the of', ['and the']), [0]);   // 어휘가 비면 0
});

test('검색 도구: 원본과 같은 요청·파싱 (fetch 가짜)', async (t) => {
  const seen = [];
  const replies = {
    'api.openalex.org': { results: [{ title: 'OA paper', publication_year: 2024, doi: 'https://doi.org/10.1/a', id: 'https://openalex.org/W1',
      cited_by_count: 5, type: 'article', primary_location: { source: { type: 'journal', display_name: 'J' } },
      authorships: [{ author: { display_name: 'Ann Lee' } }], abstract_inverted_index: { world: [1], hello: [0] } }] },
    'api.semanticscholar.org': { data: [{ title: 'S2 paper', venue: 'arXiv.org', year: 2023, authors: [{ name: 'Bo' }],
      externalIds: { DOI: '10.2/b' }, citationCount: 1, url: 'https://s2/x', publicationTypes: ['JournalArticle'] }] },
    'www.ebi.ac.uk': { resultList: { result: [{ title: 'PMC paper', pubYear: '2022', authorString: 'Kim J, Lee S', source: 'PPR', id: '9',
      abstractText: '<p>Hi</p>', citedByCount: 2 }] } },
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    seen.push(u);
    return new Response(JSON.stringify(replies[u.host]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const [oa] = await searchOpenalex('ai writing', { limit: 4, yearFrom: 2020, email: 'me@x.y' });
  assert.equal(seen[0].searchParams.get('per-page'), '4');
  assert.equal(seen[0].searchParams.get('filter'), 'from_publication_date:2020-01-01');
  assert.equal(seen[0].searchParams.get('mailto'), 'me@x.y');
  assert.deepEqual([oa.title, oa.kind, oa.abstract, oa.authors[0], oa.origin], ['OA paper', 'peer-reviewed', 'hello world', 'Ann Lee', 'OpenAlex']);
  const [s2] = await searchSemanticScholar('q', { yearFrom: 2021 });
  assert.equal(seen[1].searchParams.get('year'), '2021-');
  assert.deepEqual([s2.kind, s2.doi], ['preprint', 'https://doi.org/10.2/b']);
  const [pmc] = await searchEuropePmc('q', { yearFrom: 2019 });
  assert.equal(seen[2].searchParams.get('query'), `(q) AND PUB_YEAR:[2019 TO ${CURRENT_YEAR}]`);
  assert.deepEqual([pmc.kind, pmc.abstract, pmc.url, pmc.authors], ['preprint', 'Hi', 'https://europepmc.org/article/PPR/9', ['Kim J', 'Lee S']]);
  assert.deepEqual(Object.keys(TOOL_FUNCS), ['search_openalex', 'search_semantic_scholar', 'search_europe_pmc']);
  assert.ok(TOOLS.every((x) => x.strict === true && x.input_schema.required[0] === 'query'));
  assert.equal(TOOL_LABELS.web_search, '웹 검색');
  assert.deepEqual(WEB_SEARCH_TOOL, { type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
  // 동적 필터링 버전은 지원 모델에만, Haiku 5.5·목록에 없는 모델은 기본 버전
  assert.equal(webSearchToolFor('claude-opus-5-5').type, 'web_search_20260209');
  assert.equal(webSearchToolFor('claude-sonnet-5-5').type, 'web_search_20260209');
  assert.equal(webSearchToolFor('claude-fable-5-2').type, 'web_search_20260209');
  assert.equal(webSearchToolFor('claude-haiku-5-5').type, 'web_search_20250305');
  assert.equal(webSearchToolFor('claude-unknown-model').type, 'web_search_20250305');
});

test('httpGet: 429 재시도 후 성공, 끝내 실패하면 "요청 실패: …", 취소면 RunCancelled', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => (++n === 1 ? new Response('', { status: 429 })
    : new Response('{"ok":1}', { status: 200 })));
  assert.deepEqual(await httpGet('https://api.openalex.org/works', { a: 1 }), { ok: 1 });
  assert.equal(n, 2);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  await assert.rejects(httpGet('https://x/y', {}, { retries: 1 }), /^Error: 요청 실패: HTTP 500$/);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(httpGet('https://x/y', {}, { signal: ctl.signal }), (e) => e instanceof RunCancelled);
});

test('withToolLock: 같은 이름은 차례로, 다른 이름은 동시에', async () => {
  const log = [];
  const job = (name, tag, ms) => withToolLock(name, async () => {
    log.push(`${tag}+`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${tag}-`);
    if (tag === 'a1') throw new Error('x');
    return tag;
  });
  const out = await Promise.allSettled([job('A', 'a1', 20), job('A', 'a2', 1), job('B', 'b1', 5)]);
  assert.equal(out[0].status, 'rejected');
  assert.equal(out[1].value, 'a2');
  assert.ok(log.indexOf('a1-') < log.indexOf('a2+'));
  assert.ok(log.indexOf('b1+') < log.indexOf('a1-'));
});

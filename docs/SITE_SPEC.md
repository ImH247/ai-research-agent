# AI Research Agent — 웹사이트(브라우저) 버전 명세 (SITE_SPEC)

이 문서는 여러 작업자가 동시에 구현할 때 지켜야 하는 **계약**이다. 모듈 경계, 함수 이름, 데이터 형식을 정한다.
바꿔야 할 이유가 생기면 자기 모듈 안에서 우회하지 말고 최종 보고에 적는다.

## 0. 무엇을 만드는가

- GitHub Pages(정적 호스팅)에 올려 **주소만 열면 동작하는** 연구 조사 에이전트. 서버가 없다.
  조사 엔진(8단계 에이전트), 결과물 생성(Markdown·HTML·Word·PowerPoint·BibTeX·RIS·CSV·JSON, PDF는 인쇄 창), 실행 기록 저장을 **모두 브라우저에서** 한다.
- Claude API는 사용자가 입력한 **자기 API 키**로 브라우저에서 `api.anthropic.com`에 직접 호출한다
  (공식 SDK `@anthropic-ai/sdk`의 `dangerouslyAllowBrowser: true`). 키는 이 브라우저에만 있고 Anthropic 외 어디로도 가지 않는다.
  이것을 페이지의 Content-Security-Policy(`connect-src`)로 강제한다.
- **원본**: `docs/reference/python/` — 실제 API로 검증된 파이썬 구현(에이전트 `agent/`, 서버 `server/`, 내보내기 `exporters/`, `app.py`).
  로직·프롬프트·가중치·임계값·이벤트 문구는 **그대로** 옮기고, 이 문서가 바꾸라고 한 곳만 바꾼다.
  데이터 형식은 `docs/PYTHON_SPEC.md` 3장(result.json, run.json 스냅샷, 이벤트)과 **같다**(키는 snake_case 유지). 샘플(`data/samples/`)이 그대로 열려야 한다.
- 실데이터 생김새: `docs/SAMPLE_EXCERPT.md` (전체 샘플 파일을 읽기 도구로 열지 말 것: 각 700KB 이상).

## 1. 폴더와 담당

```
index.html                      [front]
assets/tokens.css               [완성·변경 금지] 디자인 토큰
assets/app.css, result.css      [front]
assets/js/main.js store.js ui.js charts.js views/*.js   [front]
assets/js/api.js                [front] 서버 fetch → 브라우저 백엔드 호출로 교체
assets/js/engine/models.js schema.js prompts.js llm.js sources.js tfidf.js tools.js pipeline.js qa.js refine.js   [engine]
assets/js/engine/storage.js runs.js demo.js backend.js runfile.js                                               [backend]
assets/js/export/theme.js common.js markdown.js html.js refs.js slides.js index.js                              [export-text]
assets/js/export/docx.js pptx.js                                                                               [export-office]
vendor/                         [완성] anthropic-sdk.js, markdown-it.js, docx.js, pptxgenjs.js, jszip.js (단일 파일 ES 모듈 묶음)
data/samples/                   [완성] index.json, <id>/run.json, result.json, events.jsonl
tests/                          node --test 테스트(*.test.js). tests/fakes.js [engine]
tools/                          vendor 묶음을 다시 만드는 방법 (vendor-entries/)
docs/                           SITE_SPEC.md(이 문서), PYTHON_SPEC.md, FRONTEND.md, SAMPLE_EXCERPT.md, reference/
```

다른 담당의 파일은 고치지 않는다. 필요한 변경은 최종 보고에 적는다.

## 2. 공통 규칙

- 빌드 단계 없는 ES 모듈(`.js`, `package.json`에 `"type": "module"`). import는 확장자까지 쓴 상대 경로.
- `engine/`과 `export/`의 모듈은 **Node 22에서도 import 되어야 한다**(테스트용). 모듈 최상위에서 `window`, `document`, `indexedDB`,
  `Notification`, `localStorage`에 접근하지 않는다. 브라우저 전용 기능은 함수 안에서 쓰거나 주입받는다.
- 라이브러리는 `vendor/`의 묶음만 쓴다(외부 CDN 금지). 경로 예: `assets/js/engine/llm.js`에서 `../../../vendor/anthropic-sdk.js`.
  - `vendor/anthropic-sdk.js`: `export default Anthropic`, 그리고 `AuthenticationError`, `APIError` 등 SDK의 이름 있는 export.
  - `vendor/markdown-it.js`: `export default MarkdownIt`. `vendor/docx.js`: docx의 모든 이름 있는 export(`Document`, `Packer` 등).
  - `vendor/pptxgenjs.js`: `export default PptxGenJS`. `vendor/jszip.js`: `export default JSZip`.
  - 이 묶음들은 Node 22에서도 동작함을 확인했다(SDK에 가짜 키로 요청하면 `AuthenticationError`가 난다).
- 주석·사용자에게 보이는 문구는 **한국어**(파이썬 원본과 같은 말투). 함수·변수 이름은 영어 camelCase, **데이터 키는 snake_case 그대로**.
- LLM 프롬프트는 원본처럼 영어로 쓰고 출력 언어만 지시한다.
- API 키를 로그·이벤트·저장소·오류 메시지·내보낸 파일 어디에도 넣지 않는다.
- 네트워크 목적지는 4곳뿐이다: `api.anthropic.com`, `api.openalex.org`, `api.semanticscholar.org`, `www.ebi.ac.uk`.
- 시간·난수는 함수 안에서 쓴다(테스트에서 주입 가능하면 좋다).

## 3. 엔진 [engine] — `agent/*.py` → `engine/*.js`

### 3.1 models.js, schema.js, prompts.js
- `agent/models.py`를 그대로 옮긴다: `APP_NAME`, `APP_VERSION`(= "2.0.0-web"), `PRICING_AS_OF`, `CURRENT_YEAR`, `MODELS`(같은 4개 모델·설명·가격·`supports_fallback`·badge),
  `getModel`, `modelLabel`, `estimateCost`, `DEPTH_PRESETS`, `DEFAULT_DEPTH`, `LIMITS`, `LANGUAGES`, `RunConfig.fromDict(d)`, `toDict()`.
- RunConfig 추가 필드: `max_cost_usd`(null = 한도 없음, 0~100), `web_search`(기본 true). `parallelism` 기본 3.
  LIMITS에 `max_cost_usd: [0, 100]` 추가(실수 허용).
- `schema.js`: `S, I, B, O(props), A(item), E(...values)`. `prompts.js`: `SYS_BASE`, `ABSTRACT_RULE` (원본 그대로).

### 3.2 llm.js
```js
export class RunCancelled extends Error {}
export class LLMError extends Error { constructor(code, message) }   // code: auth|permission|model|rate_limit|billing|bad_request|connection|server|refusal|unknown
export function friendlyError(err)          // → LLMError (원본 friendly_error의 규칙 + 아래)
export async function listModels(apiKey)    // client.models.list() 순회 → id 배열. 실패 시 LLMError
export class LLM {
  constructor({ apiKey, model, onWarning = null, signal = null, client = null })   // client: 테스트용 가짜 SDK 주입
  model; usage = { calls, input_tokens, output_tokens }
  async json(system, prompt, schema, { effort = 'medium', maxTokens = 16000 } = {})   // → object | null
  async text(system, prompt, { effort = 'medium', maxTokens = 16000, stream = false, onDelta = null } = {})   // → string
  async toolTurn(system, messages, tools, { effort = 'low', maxTokens = 8000 } = {})   // → 응답 객체 그대로
  costUsd()                 // estimateCost(model, usage...) | null
  static textOf(resp)       // 원본 LLM._text
  static echoContent(resp)  // 원본 echo_content
}
```
- 클라이언트: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 4 })`. 요청마다 `{ signal }` 요청 옵션으로 취소 신호를 넘긴다.
- 요청 규칙은 `docs/PYTHON_SPEC.md` 4.2와 원본 `llm.py` 그대로: `output_config.effort` 항상 명시, `thinking`·`temperature`·`top_p`·`top_k`·`tool_choice`(any/tool) 금지,
  구조화 출력은 `output_config.format`(json_schema), 도구는 `strict: true`, 거절 대비 fallback은 `supports_fallback` 모델만
  `client.beta.messages.create/stream({ ..., betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })`, 'fallback'이 든 400이면 일반 호출로 전환.
  `stop_reason` 확인(refusal, max_tokens), 사용량은 `usage.iterations`가 있으면 합산.
- 스트리밍: `const s = client.messages.stream(params, { signal })` → `s.on('text', onDelta)` → `await s.finalMessage()`. `onDelta`가 `RunCancelled`를 던지면 스트림을 abort하고 전파.
- `friendlyError` 추가 규칙: 브라우저 fetch 실패(`TypeError: Failed to fetch` 등)와 `APIConnectionError`는 connection, 타임아웃은 connection,
  `AbortError`/abort로 끝난 요청은 `RunCancelled`(호출부가 취소를 요청한 경우). 메시지는 한국어, 키나 요청 본문을 넣지 않는다.

### 3.3 sources.js, tfidf.js
- `Source`(원본 필드 그대로, `toDict()`/`Source.fromDict()`), `normTitle`, `KIND_RANK`, `EvidenceStore`(DOI·제목·잘린 웹 제목 병합, `merged`, `included()`, `shortCite`).
- `tfidf.js`: sklearn `TfidfVectorizer(stop_words="english", ngram_range=(1,2), sublinear_tf=True)`에 가깝게 — 소문자화, 토큰 정규식 `\b\w\w+\b`(유니코드),
  sklearn의 영어 불용어 목록(318개)을 파일에 포함, 1·2-gram, `1+ln(tf)`, idf = `ln((1+n)/(1+df))+1`, L2 정규화. `cosineScores(queryText, docs) → number[]`.

### 3.4 tools.js — 검색 도구
- `searchOpenalex`, `searchSemanticScholar`, `searchEuropePmc`: 원본과 같은 요청·파싱, 시그니처 `(query, { limit = 6, yearFrom = null, email = '', signal = null } = {})`.
  `fetch` 사용(브라우저에서 User-Agent 헤더는 못 바꾼다), 25초 타임아웃, 429는 2·4·8초(+지터) 재시도 3회.
- **arXiv는 뺀다**: arXiv API가 CORS를 허용하지 않아 브라우저에서 읽을 수 없다(OpenAlex·Semantic Scholar가 arXiv 프리프린트도 색인한다).
- **웹 검색(DuckDuckGo)은 Anthropic 서버 도구로 바꾼다**: `WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }`.
  Anthropic 쪽에서 실행되므로 `TOOL_FUNCS`에는 없다(3.5 참고).
- `TOOL_FUNCS = { search_openalex, search_semantic_scholar, search_europe_pmc }`, `TOOL_DESC`(원본 설명, arXiv 줄 제외), `TOOLS`(strict 도구 정의),
  `TOOL_LABELS = { search_openalex: 'OpenAlex', search_semantic_scholar: 'Semantic Scholar', search_europe_pmc: 'Europe PMC', web_search: '웹 검색' }`.
- DB별 순차 실행(원본의 `TOOL_LOCKS`)은 도구 이름별 프로미스 체인으로 구현한다.

### 3.5 pipeline.js — ResearchAgent (`pipeline.py` 이식, 검토 수정 B1~B8 포함)
```js
export class RunHooks {                      // 기본 구현: emit은 console.log, 나머지는 아무것도 안 함
  emit(stage, kind, msg, data = null) {}
  progress(stage, done, total, label = '') {}
  async checkpoint() {}                      // 취소 요청 시 RunCancelled를 던진다
  async reviewPlan(plan) { return { action: 'approve' } }
  reportDelta(text) {}
  async saveCheckpoint(state) {}             // 단계가 끝날 때마다 호출 (3.5.3)
}
export class ResearchAgent {
  constructor(prompt, llm, config, hooks = null, tools = null)   // tools: { 이름: 함수 } 주입(테스트용), 기본 TOOL_FUNCS
  async run()                       // 8단계 실행 → toResult()
  toResult()                        // PYTHON_SPEC 3.2에서 id·meta·trace·schema_version을 뺀 부분 + year_from, year_from_source, year_from_reason, disabled_tools, counts, budget_cap_usd, budget_hit
  stats()
  snapshotState()                   // 체크포인트용 상태 (3.5.3)
  static fromState(prompt, llm, config, hooks, state, tools = null)   // 체크포인트에서 복원
  static async rewriteReport(prevResult, llm, config, hooks, opts)    // 3.5.4
}
```
원본 대비 변경점:
1. **동시 실행**: 스레드 대신 async. `mapLimit(items, cfg.parallelism, fn)` — 입력 순서대로 결과, 첫 오류에서 나머지 작업이 다음 checkpoint에서 멈추고(원본 B6) 원래 오류를 던진다.
   `parallelism == 1`이면 원본과 같은 순서.
2. **웹 검색 서버 도구**: investigate()의 도구 목록 = `TOOLS`(제외된 도구 빼고) + `WEB_SEARCH_TOOL`(`cfg.web_search`이고 사용 중지되지 않았을 때).
   - 응답의 `server_tool_use`(name `web_search`, `input.query`)와 `web_search_tool_result` 블록을 읽어 결과(`content`가 배열이면 `web_search_result` 항목: `url`, `title`, `page_age`)를
     `Source({ kind: 'web', origin: 'WebSearch', title, url, year: page_age에서 연도, abstract: '' })`로 저장소에 넣고, 원본과 같은 도구 이벤트
     `"Qn · web_search('검색어') → N건 (누적 M)"`(kind `tool`, data.tool `web_search`)를 낸다.
   - `content`가 오류 객체(`web_search_tool_result_error`, `error_code`)면 `tool_error` 이벤트. 연속 3회면 웹 검색을 이번 실행에서 끈다(`tool_disabled`, 한 번만).
   - 같은 응답의 `text` 블록에 붙은 `citations` 중 `web_search_result_location`(`url`, `title`, `cited_text`)의 `cited_text`를 같은 URL 웹 문헌의 abstract에 덧붙인다(중복 제거, 1500자까지). 웹 문헌이 초록 없이 평가되는 것을 줄이기 위해서다.
   - 서버 도구 블록에는 우리가 tool_result를 보내지 않는다. 응답 content는 `LLM.echoContent(resp)` 그대로 assistant 턴으로 덧붙인다(대화 기록은 덧붙이기만).
   - `stop_reason === 'pause_turn'`이면 content를 덧붙이고 같은 루프를 계속한다(도구 라운드 수에는 포함).
   - API가 웹 검색 도구 자체를 거부하면(400 등, 메시지에 web_search) 그 턴을 웹 검색 없이 다시 보내고, 이번 실행에서 웹 검색을 끈 뒤 경고 이벤트를 낸다: "웹 검색 도구를 쓸 수 없어 학술 DB만으로 조사합니다."
   - 계획의 `preferred_tools` enum = `TOOL_FUNCS`의 키 + `web_search`. 자기 비판의 `followup_queries[].tool` enum = `TOOL_FUNCS`의 키만(코드가 직접 실행하므로).
3. **비용 한도**(새 기능): `cfg.max_cost_usd`가 있으면 LLM 호출이 끝날 때마다 `llm.costUsd()`를 비교한다. 한도에 닿으면 `budgetHit = true`, 경고 이벤트 한 번
   (kind `budget`, msg "비용 한도($X)에 도달했습니다: 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.", data `{ cap, cost }`).
   그 뒤: 새 도구 라운드·남은 하위 질문 탐색·재조사 라운드를 시작하지 않는다. 이미 모은 문헌의 평가 → 종합 → 보고서 → 검증은 한다. 결과에 `budget_cap_usd`, `budget_hit`.
4. **체크포인트·이어하기**(새 기능): 다음 단위가 끝날 때마다 `await hooks.saveCheckpoint(this.snapshotState())`:
   `understand` → `plan`(검토 포함) → `act` → `evaluate` → `synthesize` → 재조사 라운드마다 `round:<n>`(비평+추가 조사+평가+종합까지) → `final_reflect` → `report`.
   상태 = `{ version: 1, done: '<단위>', understanding, plan, year_from, year_from_source, year_from_reason, sources: [toDict…], merged, syntheses, reflections,
   tool_failures, disabled_tools, web_search_off, round, usage, budget_hit, report_markdown }` — JSON으로 저장 가능해야 하고 API 키는 넣지 않는다.
   `fromState(...)` 후 `run()`은 `done` 다음 단위부터 이어서 실행한다(중단된 단위는 처음부터 다시). 사용량(usage)은 이어서 누적한다.
5. **보고서 다시 쓰기**(새 기능): `rewriteReport(prevResult, llm, config, hooks, { language, length, extra })` — 끝난 결과(understanding, plan, syntheses,
   reflections, sources)로 상태를 복원해 ⑦ 보고서 작성 + ⑧ 인용 검증만 다시 실행하고 새 결과(toResult 형식)를 돌려준다.
   `language`: 'ko' | 'en'. `length`: 'short' | 'standard' | 'detailed' → 보고서 프롬프트에 분량 지시 한 줄 추가(섹션 구성은 유지):
   short ≈ 1,500–2,500 words, standard = 원본 그대로, detailed ≈ 6,000–8,000 words with more comparisons and tables. `extra`: 사용자가 적은 추가 요청(500자 이하) — 프롬프트에 그대로 넣는다.
6. 출력 언어 규칙(원본 item 13), 사용자 요구(`core_topic`, `user_requirements`), 계획 검토(revise/edit/approve), 취소, 진행률, 보고서 스트리밍, 검증→수정→재검증은 원본 그대로.
7. 이벤트: `docs/PYTHON_SPEC.md` 3.3과 같은 kind·data. 추가 kind: `budget`.

### 3.6 qa.js, refine.js
- `qa.js`: `retrieve(result, question, k = 8)`, `answerQuestion(llm, result, question, history = [])` → `{ answer_markdown, sources }` (원본 그대로, tfidf.js 사용).
- `refine.js`(새 기능 '주제 다듬기'): `refinePrompt(llm, draft, lang)` → `{ suggestions: [{ prompt, focus, why }] (정확히 3개), questions: [...] (0~3개) }`.
  프롬프트(영어): 사용자 초안을 더 조사하기 좋은 연구 요청문 3가지로 다듬는다 — 서로 다른 초점(범위·대상·기간·방법 중 하나씩 구체화), 각 140자 안팎, 사용자의 언어로;
  모호한 점은 questions로. 지어낸 사실·수치 금지. 모델은 호출부가 정한다(기본 `claude-haiku-5-5`, effort low, max_tokens 2000).

### 3.7 tests/fakes.js (engine 담당, backend·export 테스트도 쓴다)
- `FakeLLM`(LLM과 같은 인터페이스: model, usage, json, text, toolTurn, costUsd, textOf, echoContent) — 원본 `tests/fakes.py`처럼 스키마 키로 단계를 구분해 결정적으로 답한다.
  옵션: `continueRounds`(기본 1), `refuseReport`, `delay`(ms), `webSearch`(true면 첫 탐색 턴에 server_tool_use + web_search_tool_result 블록과 citations가 든 text 블록을 만든다),
  `costPerCall`(costUsd 계산용, 기본 0.05).
- `makeFakeTools({ fail = ['search_semantic_scholar'], empty = false })`, `RecordingHooks`(events, progressCalls, deltas, planDecisions, cancelAfter, checkpoints 배열).

## 4. 결과물 [export-text, export-office] — `exporters/*.py`, `agent/slides.py` → `export/*.js`
입력은 항상 result 객체(PYTHON_SPEC 3.2) 하나. 키가 없거나 빈 값이어도 죽지 않는다(.get 대신 `?.`·기본값).
- `theme.js`, `common.js`: 원본 `theme.py`, `common.py` 그대로(STUDY_TYPE_LABEL, DIRECTION_COLOR 포함).
- `index.js`: `FORMATS`(원본 순서·라벨, pdf 설명은 "인쇄 창에서 'PDF로 저장'"), `slugify`, `filenameFor(result, fmt)`(원본 규칙),
  `async exportFile(result, fmt, { outline = null } = {})` → `{ filename, mime, data }` (`data`: string 또는 Uint8Array/ArrayBuffer).
  `pdf`는 `{ filename, mime: 'text/html', data: buildHtml(result, { autoPrint: false }), print: true }` — 호출부(화면)가 새 창에서 인쇄한다.
  `async exportBundle(result, files)` → zip(Uint8Array). docx·pptx 모듈은 함수 안에서 `await import()`로 늦게 불러온다.
- `markdown.js`: `buildMarkdown(result)`. `refs.js`: `buildBibtex`, `buildRis`, `buildCsv`(UTF-8 BOM 포함 문자열).
- `html.js`: `renderMarkdown(text, knownIds = [])`, `renderFragment(result)` → `{ html, toc }`, `buildHtml(result, { autoPrint = false })` — `html_export.py` 그대로
  (markdown-it `html: false`, 인용 링크 규칙, `<br>` 복원만, `sec-N` id, 외부 링크 target/rel, B15: http(s)·`#` 외 href 제거, 목록에 없는 인용은 `<span class="cite-unknown">`).
  `buildHtml`은 외부 리소스·스크립트 없이 단독으로 열리는 문서(웹폰트 링크 없음). `autoPrint`는 쓰지 않는다(CSP 때문에 화면이 `print()`를 부른다).
- `slides.js`: `OUTLINE_SCHEMA`, `makeOutline(llm, result)`, `fallbackOutline(result)`, `normalizeOutline(outline, result)` — `slides.py` 그대로.
- `docx.js`: `async buildDocx(result) → Uint8Array` — `docx_export.py`의 구성을 `vendor/docx.js`로 최대한 같게(표지, 목차 필드, 본문(markdown-it 토큰),
  인용 → 참고문헌 북마크 내부 링크, 부록 A 가로 구역·B·C·D, 머리글·쪽 번호, 한글 글꼴 '맑은 고딕'(eastAsia 포함)).
- `pptx.js`: `async buildPptx(result, outline = null) → Uint8Array` — `pptx_export.py`의 슬라이드 구성·격자·글꼴·차트(네이티브)·글자 맞춤 규칙을 `vendor/pptxgenjs.js`로.
  outline이 없으면 `fallbackOutline`.

## 5. 브라우저 백엔드 [backend] — `server/*.py` → `engine/storage.js, runs.js, demo.js, backend.js, runfile.js`
화면(`api.js`)이 부르는 객체를 만든다. 메서드 이름과 **돌려주는 모양은 `docs/PYTHON_SPEC.md` 6.3의 응답 본문과 같다**.
```js
export class BackendError extends Error { constructor(code, message, status = 400) }
export function createBackend({ storage, llmFactory, tools, loadSample, now, sampleSpeed }) → backend
// storage: 아래 Storage 인터페이스. llmFactory({ apiKey, model, onWarning, signal }) → LLM. tools: TOOL_FUNCS 또는 가짜.
// loadSample(path) → Promise<string> (브라우저: fetch('./data/samples/…'), 테스트: 파일 읽기).
backend.config()                    // 6.3의 config + features {resume, cost_cap, run_files, rewrite, refine, notifications: true}, demo: false, server_key: false
backend.checkKey(apiKey)            // {ok, models} | {ok:false, error}  (listModels)
backend.listRuns()                  // {runs: [...]}: 내 실행(최신순) → 가져온 실행 → 샘플
backend.createRun(body)             // body: {prompt, model, depth, options, language, year_from, human_in_the_loop, formats, max_cost_usd, demo, demo_speed, api_key}
backend.run(id)                     // 스냅샷(3.4) + resumable, parent_id, imported, custom_title
backend.events(id, after, previewFrom)   // {events, next, status, preview}: 6.3과 같은 의미(next = 마지막으로 돌려준 seq, preview 위치는 코드포인트 기준)
backend.submitPlan(id, decision) / cancel(id) / remove(id) / result(id) / qa(id) / ask(id, {question, api_key, model})
backend.slides(id, {api_key, model})     // LLM으로 슬라이드 개요 재생성
backend.exportFile(id, fmt)              // export/index.js exportFile 결과 + 생성 상태 반영. fmt 'zip' = 만든 결과물 + result.json 묶음
// 새 기능
backend.resume(id, {api_key})            // 체크포인트에서 이어서 실행 (데모 실행은 키 없이)
backend.rename(id, title)                // 기록 목록 제목 바꾸기 (custom_title)
backend.exportRunFile(id)                // {filename, mime:'application/json', data}  — 3.8 형식
backend.importRunFile(text)              // {id}  — 검증 후 가져온 실행으로 추가
backend.rewriteReport(id, {api_key, model, language, length, extra})   // {id}  — 새 실행(parent_id = id)을 만들어 ⑦⑧만 실행
backend.refinePrompt({api_key, prompt, language, model})               // refine.js 결과
backend.hasActiveRuns()                  // 진행 중 실행이 있는지 (페이지 떠나기 경고용)
```
- 실행은 페이지 안에서 async로 돈다. 동시 진행 최대 2건(`too_many_runs`). 실행 상태·이벤트·미리보기·사용량·계획 검토 대기·취소는 원본 `runs.py`의 Run/Hooks 규칙 그대로.
- **저장(Storage 인터페이스)**: `get(store, key)`, `put(store, key, value)`, `delete(store, key)`, `keys(store)`, `getAll(store)`.
  store: `runs`(스냅샷, 키 없이), `events`(실행별 배열), `results`, `checkpoints`, `qa`, `meta`. 구현 2개: `IndexedDBStorage`(DB 이름 `ai-research-agent`, 버전 1), `MemoryStorage`(테스트).
  스냅샷은 단계가 바뀔 때·끝날 때, 그 밖에는 2초에 한 번까지만 저장. 이벤트는 모아서 저장.
- **페이지를 새로 열었을 때**: `queued`/`running`/`awaiting_plan`로 남은 실행은 `interrupted`로 바꾸고 체크포인트가 있으면 `resumable: true`.
  오류로 끝난 실행도 체크포인트가 있고 오류 코드가 connection·server·rate_limit·unknown·billing·auth·permission이면 `resumable: true`
  (billing·auth·permission은 크레딧을 채우거나 키를 바꾼 뒤 `resume({api_key})`로 이어 간다).
- `resume`: 같은 id로 상태를 `running`으로 바꾸고 `ResearchAgent.fromState`로 이어서 실행. 이벤트 seq는 이어서 매긴다. 키는 실행 객체 메모리에만 두고 끝나면 지운다.
- **샘플**: `data/samples/index.json`의 목록을 읽어 읽기 전용 실행으로 보여 준다(삭제·이름 변경 불가, 결과물·Q&A는 가능 — Q&A 기록은 저장소에).
- **데모 실행**(`body.demo === true`): 키 없이 `demo.py`처럼 샘플 이벤트를 재생하고 샘플 결과를 새 id로 복사한다. `demo_speed`(1 = 원본 속도 약 45초, 5 = 약 10초).
  계획 검토 대기, 보고서 미리보기, 취소, 결과물 생성 모두 동작. 데모 결과의 `meta.demo = true`, `meta.note` 한국어 안내.
- 결과물은 요청 시 만든다(이번 페이지 세션 동안 메모리에 캐시). 실행 시작 때 고른 형식은 끝나면 미리 만들어 둔다(`exports` 상태 표시용). pptx는 실행이 끝날 때 `makeOutline`으로 개요를 만들어 저장(실패 시 fallback).
- 오류는 `BackendError(code, message, status)`로 던진다. 코드: `empty_prompt`, `prompt_too_long`, `no_api_key`, `too_many_runs`, `not_found`, `no_result`,
  `not_awaiting`, `invalid_plan`, `read_only`, `running`, `invalid_format`, `invalid_file`, `not_resumable`, `export_failed`와 LLM 오류 코드.

### 3.8 실행 파일 형식 (runfile.js)
```json
{"format": "ai-research-agent/run", "version": 1, "exported_at": "…", "app_version": "2.0.0-web",
 "result": { …PYTHON_SPEC 3.2… }, "events": [ … ], "qa": [ … ]}
```
- `buildRunFile(result, events, qa)`, `parseRunFile(text)` → `{ result, events, qa }` 또는 `BackendError('invalid_file', …)`.
  검증: format·version, `result.report_markdown`이 문자열, `result.sources`가 배열, 크기 20MB 이하. 문자열 필드는 그대로 두되 화면은 항상 이스케이프한다.
- 가져온 실행: 새 id(`imp_` + 시각 + 난수 4자리), `imported: true`, 읽기 전용(샘플과 같은 규칙).

## 6. 화면 [front] — 바꿀 점은 `docs/FRONTEND.md` + 아래
- `index.html`: 모든 경로를 상대 경로로(`./assets/…`; GitHub Pages는 `https://<user>.github.io/<repo>/` 아래에서 열린다), 웹폰트 CDN 링크 제거, CSP meta 추가:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' https://api.anthropic.com https://api.openalex.org https://api.semanticscholar.org https://www.ebi.ac.uk;
  object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'` (인라인 스크립트가 있으면 별도 파일로 옮긴다).
- `api.js`: 기존과 같은 이름(`api`, `ApiError`, `download` 등)을 유지하되 `createBackend(...)`(IndexedDB 저장소, 진짜 LLM·도구)를 호출한다.
  URL에 `?mock=1`이 있으면 `tests/fakes.js`의 FakeLLM·가짜 도구를 쓰고 화면 위에 "테스트 모드" 띠를 보인다(실제 API 호출 없음).
- 편의 기능 (구체 동작은 각 front 작업 지시 참고): 처음 사용 안내 · 데모 바로 보기, 주제 다듬기, 실행 보호(떠나기 경고)·이어서 진행, 끝나면 알림,
  비용 한도와 남은 시간, 조사 파일 저장·열기(끌어다 놓기), 기록 검색·이름 바꾸기, 보고서 다시 쓰기.

## 7. 테스트
- `node --test tests/` 가 네트워크·API 키 없이 전부 통과해야 한다.
- 엔진: FakeLLM·가짜 도구로 전체 실행(병렬 1/3), 웹 검색 서버 도구 블록 처리(가짜 응답), pause_turn, 비용 한도, 체크포인트 → 이어하기 결과가 중단 없는 실행과 같은지,
  보고서 다시 쓰기, 주제 다듬기, 취소, 수집 0건, 거절.
- 결과물: 두 샘플로 모든 형식을 만들고 구조를 확인(docx·pptx는 zip 구조와 XML 파싱, 가능하면 `python -X utf8`로 python-docx·python-pptx가 다시 여는지).
- 백엔드: MemoryStorage + FakeLLM으로 생성·폴링·계획 검토·취소·중단 후 이어하기·가져오기/내보내기·다시 쓰기·데모 재생(빠른 속도).

## 2차 수정 (계약 추가)

- 스냅샷 `wait_s`: 계획 검토(`awaiting_plan`)로 기다린 시간의 합(초, 0.1초 단위). 지금 기다리는 중이면 그 시간까지 포함하고,
  실행과 함께 저장되어 새로고침·이어하기 뒤에도 남는다. 화면은 예상 남은 시간을 셀 때만 `elapsed_s - wait_s`를 쓴다(시계는 실제 경과).
- `backend.finishEarly(id)` → `{ok: true, status}`. 진행 중(`running`)이고 데모·다시 쓰기가 아닌 실행에서, 단계가 act·evaluate·synthesize·reflect일 때만.
  오류: 데모·다시 쓰기·샘플 `not_supported`(409), 진행 중이 아님 `not_running`(409), 그 밖의 단계(계획 검토 대기 포함) `not_now`(409). 이미 요청했으면 그대로 `{ok: true}`.
  효과: 비용 한도와 같은 자리에서 새 도구 라운드·보강 검색·재조사 라운드(최종 점검 포함)를 멈추고 평가·종합·보고서·검증은 마친다.
  이벤트 `finish_early` 1건(stage = 그때 단계, 수행 기록에도 남음). 스냅샷 `finish_requested: true`, 결과 `meta.finished_early: true`.
- `config()`: `web_search_usd`(0.01). 깊이별 `estimate.web_searches`(대략치: quick 8, standard 25, deep 45). 예상 비용 = 토큰 비용 + web_searches × web_search_usd(웹 검색을 켰을 때).
- 실행 중 체크포인트·스냅샷·이벤트 저장이 실패하면 실행마다 한 번 `warning` 이벤트(stage `system`)를 낸다. 실행은 계속한다.
- 스냅샷 `usage.cost_usd`는 `llm.costUsd()` 값(비용 한도가 비교하는 값)과 같다.

# 빌드 기록: 엔진·결과물·백엔드 담당자 보고 (화면 작업자 참고용)

각 담당자가 실제로 구현한 공개 API와 명세에서 달라진 점이다. 화면 코드는 **여기 적힌 실제 이름과 반환 모양**을 따른다.

## 백엔드 (engine/backend.js 등)

### 공개 API

**backend.js**
- `class BackendError` (re-exported from runs.js), `STAGES`, `EXAMPLES`, `ACTIVE`, `MAX_ACTIVE`.
- `createBackend({ storage = MemoryStorage, llmFactory = (o) => new LLM(o), tools = TOOL_FUNCS, loadSample = null, now = () => new Date(), sampleSpeed = 1, listModels = engine listModels } = {}) -> backend`.
  - `loadSample(path)` takes a path relative to `data/samples/`: `'index.json'`, `'<id>/run.json'`, `'<id>/result.json'`, `'<id>/events.jsonl'`. It returns `Promise<string>`.

Backend members. All methods are bound to the object and are async unless noted. `backend.ready` is the init Promise; every method also awaits it internally.
- `config()` -> config payload as in PYTHON_SPEC 6.3, plus:
  - fixed values: `demo: false`, `server_key: false`, `features {resume, cost_cap, run_files, rewrite, refine, notifications: true}`
  - extra keys: `refine_model`, `report_lengths`, `max_active`, `max_prompt`, `demo_sample`, `storage {kind, persistent, warning}`
  - `tools` also lists `web_search`.
- `checkKey(apiKey)` -> `{ok: true, models}` or `{ok: false, error: {code, message}}`. Never throws.
- `listRuns()` -> `{runs: [summary]}`. Order: own runs (newest first), then imported runs (newest import first), then samples in index order. Each summary has the Python keys plus `has_result, resumable, parent_id, imported, custom_title`.
- `createRun(body)` -> `{id, status: snapshot}`. Body fields: `prompt, model, depth, options, language, year_from, human_in_the_loop, formats, max_cost_usd, demo, demo_speed, api_key`.
- `run(id)` -> snapshot: PYTHON_SPEC 3.4 plus `resumable, parent_id, imported, imported_at, custom_title, demo_speed, rewrite`.
- `events(id, after = 0, previewFrom = 0)` -> `{events, next, status, preview: {from, text, total} | null}`.
- Plan, cancel, remove:
  - `submitPlan(id, decision)` -> `{ok: true}`
  - `cancel(id)` -> `{ok: bool}`
  - `remove(id)` -> `{ok: true}`
- Results and Q&A:
  - `result(id)` -> result plus `report_html, toc, exports, qa[] (with answer_html), parent_id, custom_title, imported`
  - `qa(id)` -> `{items}`
  - `ask(id, {question, api_key, model})` -> `{question, answer_markdown, answer_html, sources, ts}`
- Slides and exports:
  - `slides(id, {api_key, model})` -> `{ok: true, llm: bool}`
  - `exportFile(id, fmt)` -> `{filename, mime, data, print?}`; `fmt 'zip'` -> `{filename, mime: 'application/zip', data: Uint8Array}`
- Resume and rename:
  - `resume(id, {api_key})` -> `{ok: true, id, status}`
  - `rename(id, title)` -> `{ok: true, custom_title}`
- Run files:
  - `exportRunFile(id)` -> `{filename, mime: 'application/json', data: string}`
  - `importRunFile(textOrBytes)` -> `{id}`
- Rewrite and refine:
  - `rewriteReport(id, {api_key, model, language, length, extra})` -> `{id, status}`
  - `refinePrompt({api_key, prompt, language, model})` -> `{suggestions[3], questions}`
- Helpers:
  - `hasActiveRuns()` -> boolean, synchronous
  - `waitForRun(id)` -> final snapshot or null
  - `dispose()` stops active runs without writing anything more; used in tests to simulate closing the tab.

**storage.js**
- `STORES` = `['runs', 'events', 'results', 'checkpoints', 'qa', 'meta']`, `DB_NAME = 'ai-research-agent'`, `DB_VERSION = 1`.
- `class MemoryStorage`: `get`, `put`, `delete`, `keys`, `getAll` (structuredClone on put and get); `.kind = 'memory'`.
- `class IndexedDBStorage({ name, version, indexedDB = globalThis.indexedDB } = {})`: same methods; opens the database lazily on first use; out-of-line keys; `.kind = 'indexeddb'`.

**runs.js**
- Constants: `TRACE_KINDS` (Set), `ACTIVE`, `MAX_ACTIVE = 2`, `MAX_PROMPT = 4000`, `MAX_QUESTION = 2000`, `MAX_TITLE = 80`, `ID_RE`, `MODEL_RE`, `EMPTY_COUNTS`, `LLM_STATUS`, `RESUMABLE_CODES`.
- `class BackendError(code, message, status = 400)`.
- Helpers: `isoLocal(d)`, `stamp(d)`, `randomHex(n = 4)`, `cpLength(s)`, `cpSliceFrom(s, start)`, `cpHead(s, n)`, `keyFormatOk(key)`, `cleanText(text, apiKey = null)`, `validateDecision(d)`, `cleanEvents(list)`.
- `class Run(id, prompt, config, { sample, demo, note, now })`:
  - creation and storage: `static fromSnapshot(snap, { sample, now })`, `attach(storage)`, `snapshot()`, `summary()`, `save(force)`, `flush()`
  - events: `emit(stage, kind, msg, data)`, `ensureEvents()`, `eventsAfter(after)`, `trace()`
  - state updates: `setProgress`, `setPlan`, `setUsage`, `setExport`
  - control: `checkpoint()` (async), `reportDelta`, `preview(start)`, `waitPlan(plan)`, `submit(d)`, `cancel()`, `start(resume)`, `finish(status, error)`
  - usage and time: `liveUsage()`, `elapsed()`
- `class BackendHooks extends RunHooks (run, saveCheckpoint)`, with `.signal`.

**demo.js**
- Constants: `DEMO_SAMPLE`, `DEMO_NOTE`, `DELAYS`, `REPORT_CHUNKS`, `MAX_REVISIONS`, `PROGRESS_LABEL`.
- `parseJsonl(text)`, `annotate(events)`.
- `async replay(run, sample, events, { speed = 1, startAt = 0, onCheckpoint = null, timeScale = 1 } = {})` -> result.
- `demoResult(run, sample)`, `demoAnswer(result, question, k = 5)`.

**runfile.js**
- Constants: `RUN_FILE_FORMAT = 'ai-research-agent/run'`, `RUN_FILE_VERSION = 1`, `MAX_RUN_FILE_BYTES = 20 MB`.
- `cleanQa(list)`, `runFileName(result)`.
- `buildRunFile(result, events = [], qa = [], { now } = {})` -> JSON string.
- `parseRunFile(textOrBytes)` -> `{result, events, qa}`, or throws `BackendError('invalid_file')`.

### 명세와 달라진 점

- `BackendError` is defined in runs.js and re-exported from backend.js. runs.js, runfile.js and backend.js all need it, and this avoids a circular import.
- `createBackend` takes one extra option, `listModels`, so `checkKey` can be tested and so mock mode (`?mock=1`) can avoid a real call. The backend also has three extra members: `ready` (the init Promise), `waitForRun(id)` (wait for a run to end, used in tests and integration) and `dispose()` (simulates closing the tab in tests). `hasActiveRuns()` is synchronous because `beforeunload` needs an immediate answer.
- Imported runs can be renamed and deleted, but they cannot be resumed and their result does not change. SITE_SPEC 3.8 says 'read-only (same rules as samples)', but WEB_FEATURES F6/F7 say only samples block delete and rename. Without delete, an imported run could never be removed.
- `parseRunFile` also accepts a plain result.json, the 'full data JSON' export, which has `report_markdown` and `sources` but no `format`. It is imported with no events and no Q&A. Users may drop the result.json from an export or a zip bundle.
- `TRACE_KINDS` includes the new 'budget' kind, so hitting the cost cap appears in result.trace (Appendix D).
- Extra keys:
- **Snapshot:** `resumable`, `parent_id`, `imported`, `imported_at`, `custom_title`, `demo_speed`, `rewrite`.
- **Summary:** `has_result`, `resumable`, `parent_id`, `imported`, `custom_title`.
- **result() payload:** `parent_id`, `custom_title`, `imported`.
- **result.meta:** `budget_cap_usd` and `budget_hit` (also kept at the top level, as `toResult()` returns them).
- **Rewrite runs:** `meta.parent_id` and `meta.rewrite`.
- **Imported runs:** `meta.imported_from`.
- `demo_speed` is a speed, not a delay multiplier: delays are divided by `demo_speed × sampleSpeed`. It is clamped to 0.25–20 and defaults to 1. At 5 the demo takes about 10 s; at 1, about 45 s. `sampleSpeed` (default 1) is an extra speed-up for tests.
- Checkpoint record in the `checkpoints` store: `{version: 1, saved_at, kind: 'agent' | 'demo' | 'rewrite', state | pos}`, and only the latest record per run is kept.
- **Demo runs:** save their replay position at each stage boundary, so they resume without a key.
- **Rewrite runs:** save a `kind: 'rewrite'` record when created; resuming re-runs ⑦⑧.
- **Done or cancelled runs:** the checkpoint is deleted.
- **Interrupted runs that were never checkpointed** (before ① finished) are not resumable.
- If IndexedDB cannot be opened (private window, blocked site data), the backend switches to MemoryStorage. `config().storage` then reports `persistent: false` and a Korean warning, instead of failing.
- Slide outlines are stored in the `meta` store under the key `slides:<id>` (sample outlines stay in memory only). Q&A history for samples is stored in the `qa` store, as the spec says.
- Demo runs without a key: `ask` returns `demoAnswer` (retrieval only) and `slides` uses `fallbackOutline`. With a key, both use the real LLM. Samples and other runs still need a key and return `no_api_key` without one.
- Invalid ids return `not_found` (404) rather than Python's `invalid_id` (400), because `invalid_id` is not in the SITE_SPEC code list. New error codes not in the list: `storage_error` (500), `demo_unavailable` (500) and `cancelled` (409, for an aborted Q&A/slides/refine call). `invalid_model`, `empty_question`, `question_too_long` and `internal` come from the Python original.
- `resume` returns `{ok: true, id, status}`, `rewriteReport` returns `{id, status}` and `rename` returns `{ok: true, custom_title}`; the spec does not define these. `rename` collapses whitespace and cuts the title to 80 code points; an empty title clears `custom_title`.
- `rewriteReport` details:
- **Defaults:** language is the parent's `lang`, model is the parent's model, length is 'standard'.
- **Config:** `extra` is cut to 500 code points; `human_in_the_loop` is off and `max_cost_usd` is null.
- **Formats:** the parent's formats, or `['md']` when the parent is a sample, demo or imported run.
- **Trace:** the parent's trace without its report/verify entries, followed by the new run's trace.
- The zip bundle also contains `events.jsonl`, as the Python version did. After a reload it rebuilds every format whose status is 'ready', because the export cache lives only in memory.

### 주의할 점

- package.json still runs `node --test tests/`, which fails on Node 22.14 with MODULE_NOT_FOUND (the engine engineer saw the same). Change the script to `node --test` (104 of 104 pass) or `node --test "tests/*.test.js"`.
- Multiple tabs: when a second tab opens the site on the same IndexedDB, it marks the first tab's running runs as interrupted, and both tabs then write to the same records. Nothing coordinates tabs. Add a Web Locks or BroadcastChannel guard, or at least warn about using one tab.
- Wiring for api.js:
- Build the backend as `createBackend({ storage: new IndexedDBStorage(), llmFactory: (o) => new LLM(o), tools: TOOL_FUNCS, loadSample: (p) => fetch('./data/samples/' + p).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }) })`. `loadSample` paths are relative to `data/samples/`.
- In `?mock=1`, pass `listModels: async () => MODELS.map(m => m.id)`, or `checkKey` will call the real API.
- `exportFile` data is a string or Uint8Array; for pdf it carries `print: true`.
- Catch `BackendError` and turn its `.code`, `.message` and `.status` into an `ApiError`.
- The front end must call `hasActiveRuns()` synchronously inside `beforeunload`. Snapshots are saved at most every 2 s and events every 1 s, so a reload can lose up to about 2 s of progress and usage. The resumed run then re-runs the interrupted unit, and the usage it carries over may be slightly low.
- IndexedDBStorage has not run in a real browser; Node 22 has no indexedDB and no fake was available. Check in the browser: the first open creates the 6 stores, records survive a reload, an interrupted run shows 'resumable', and storing a full checkpoint (about 700 KB) plus the result works within quota.
- Exports are cached in memory for the page session, including docx and pptx binaries. Many large runs in one session use memory; reloading the page clears it.
- Rewrite cost: `rewriteReport` resends the parent's full `sources` to ⑦⑧. Web-search fees are not counted in cost or in the cost cap, as the engine engineer noted.
- Interrupted runs show error code 'interrupted' with a Korean message. When `resumable` is true the message says the run can be continued; the front end should show the 'continue' (이어서 진행) button based on `status.resumable`. Runs that ended with `internal` errors are not resumable, following the spec's code list.

## 결과물 — 텍스트 (export/index.js 등)

### 공개 API

theme.js: ACCENT, ACCENT_DARK, ACCENT_SOFT, INK, INK_2, MUTED, RULE, SURFACE, SURFACE_ALT, GOOD, WARNING, SERIOUS, CRITICAL, NEUTRAL, SERIES, SEQUENTIAL, FONT_KO, FONT_MONO, FONT_STACK_CSS, VERDICT_LABEL, VERDICT_COLOR, KIND_LABEL, DIRECTION_LABEL, STRENGTH_LABEL, STUDY_TYPE_LABEL, NEUTRAL_FILL, DIRECTION_COLOR (the same values as theme.py, as hex strings without '#').
common.js: VERDICTS; CITE_RE (non-global RegExp); citeReGlobal() -> RegExp(g); LABELS; labels(result); sidNum(sid) -> int (0 if malformed); headCut(s, n) (slices without splitting a surrogate pair); lastName(s); shortCite(s); authorsText(s, n=3); safeUrl(s); sourcesById(result) -> object with null prototype {sid: source}; includedSources(result); referenceSources(result); citedIds(text) -> string[]; windowLabel(result); metaInfo(result) -> {date, model, window, collected, included, merged, report_evidence, minutes, calls, input_tokens, output_tokens, cost_usd, note}; verdictTally(checks, after=false); fmtInt(n).
markdown.js: VERDICT_MARK; cell(x, n=160); directionText(result, d); buildMarkdown(result) -> string.
html.js: escapeHtml(value); linkCites(text, known: Set|array); renderMarkdown(text, knownIds=[]) -> string; renderFragment(result) -> {html, toc:[{id, level, title}]}; documentToc(result, toc) -> toc plus the appendix A-D entries (appx-a..d); reportCss() -> string; buildHtml(result, {autoPrint=false}={}) -> string (complete document; autoPrint accepted but ignored).
refs.js: CSV_COLUMNS; buildBibtex(result); buildRis(result); buildCsv(result) -> string starting with '﻿', CRLF rows; parseCsv(text) -> string[][].
slides.js: STRENGTHS, FUTURE_KEYS, LIMITS, OUTLINE_SCHEMA; clean(text); clip(text, n); firstSentences(text, n); normalizeOutline(outline, result) -> outline; async makeOutline(llm, result) -> outline|null (calls llm.json(system, prompt, OUTLINE_SCHEMA, {effort:'medium', maxTokens:16000})); fallbackOutline(result) -> outline.
index.js: FORMATS (original order and labels; pdf description "인쇄 창에서 'PDF로 저장'"); FORMAT_IDS; class ExportError extends Error; slugify(topic, maxLen=40); filenameFor(result, fmt) (throws ExportError '알 수 없는 형식입니다: x'); bundleName(result) -> '<slug>_bundle.zip'; async exportFile(result, fmt, {outline=null}={}) -> {filename, mime, data} (pdf -> {filename: '<slug>_report.pdf', mime:'text/html', data: buildHtml(result,{autoPrint:false}), print:true}; docx -> await import('./docx.js') then buildDocx(result); pptx -> await import('./pptx.js') then buildPptx(result, outline || fallbackOutline(result))); async exportBundle(result, files) -> Uint8Array zip, where files is [{filename, data, print?}] (the exportFile outputs) or {name: data}.

### 명세와 달라진 점

- slides.js defines the schema helpers (S/O/A/E) and the SYS_BASE and ABSTRACT_RULE strings itself (copied word for word from the Python schema.py and prompts.py) instead of importing them from engine/schema.js and engine/prompts.js. Those engine files did not exist yet, and this way export/ imports without the engine. If you want one source of truth, swap these for imports once engine/prompts.js exists.
- In the markdown-it renderer, images (![alt](src)) are rendered as escaped alt text instead of <img>. The Python original rendered <img>. That would load an external resource, which conflicts with the 'no external resources' rule for buildHtml and with the CSP img-src. No image appears in either sample, so sample output is unchanged.
- buildHtml's CSS adds one rule, .cite-unknown (muted, dotted strike-through), so unknown citation ids are visible in the printed document. Python had no such rule (Python had no cite-unknown span either). This is the only byte difference from the Python build_html output on both samples.
- buildHtml never emits a script, and autoPrint is accepted but ignored, as SITE_SPEC requires. The Python webfont link is removed.
- For metaInfo, the markdown verification line and the HTML verification block, keys that are present but null fall back to the default via '??' (for example cited_ids shows '-' and counts.collected falls back to len(sources)). Python's dict.get only used the default when a key was missing, so a null would print 'None'.
- CSV: a float that is a whole number prints as '1' instead of Python's '1.0', because JSON.parse loses the distinction. This affects four credibility cells in the genai sample; everything else in the CSV is byte-identical.
- String lengths and slicing use UTF-16 code units (Python counts code points). Cuts never split a surrogate pair (headCut). This only matters for emoji or other astral-plane characters.
- exportBundle: an entry with print:true (the pdf output) is stored with a .html extension, and skipped if an HTML report with that name is already in the bundle. result.json is added when the files do not already include one. events.jsonl is not added automatically; the backend must pass it in files if it wants it in the zip, as the Python original did.
- Extra exports beyond the spec (helpers others may use): FORMAT_IDS, bundleName, ExportError, documentToc, reportCss, escapeHtml, linkCites, parseCsv, CSV_COLUMNS, VERDICT_MARK, clean, clip, firstSentences, LIMITS, STRENGTHS, FUTURE_KEYS, sidNum, headCut, lastName, fmtInt, citeReGlobal.

### 주의할 점

- pptx.js does not exist yet, so exportFile(result,'pptx') currently throws ERR_MODULE_NOT_FOUND. Once it lands, check that it exports buildPptx(result, outline) returning a Uint8Array. exportFile(result,'docx') already works with the present docx.js (it returned a Uint8Array).
- The pdf export returns filename '<slug>_report.pdf' with mime 'text/html', data containing the HTML, and print:true. The screen must open the HTML in a new window and call print() itself, and must not save the data as a .pdf. FORMATS still lists pdf with ext '.pdf' and mime 'application/pdf', as in the original.
- exportBundle(result, files) expects the exportFile outputs (an array) or a {name: data} map. The backend's 'zip' format must pass the already-generated files, plus {filename:'events.jsonl', data} if it wants events included. Name the zip with bundleName(result).
- makeOutline is async and returns null only when llm.json returns null; errors thrown by llm.json propagate, as in Python. The backend should catch them and fall back to fallbackOutline.
- renderFragment links every source in result.sources, while buildHtml links only included sources (appendix B), matching the Python original. A cite link in the screen fragment can therefore point to a source that is not in the reference list; the front end must handle #ref-Sx for non-included sources.
- sourcesById returns an object with no prototype. Callers should use `in` or Object.keys, not hasOwnProperty on the object itself.
- The front end's result.css should style span.cite-unknown and span.cites, since renderFragment emits them.

## 엔진 (engine/*.js)

### 공개 API

models.js: APP_NAME, APP_VERSION ('2.0.0-web'), PRICING_AS_OF, CURRENT_YEAR, MODELS (frozen objects with id, label, tagline, description, input_per_mtok, output_per_mtok, supports_fallback, badge), DEFAULT_MODEL, getModel(id) -> ModelInfo|null, modelLabel(id), estimateCost(id, inTok, outTok) -> number|null, DEPTH_PRESETS, DEFAULT_DEPTH, LIMITS (adds max_cost_usd: [0, 100]), LANGUAGES, class RunConfig { constructor(values = {}) (no validation, like a dataclass); static fromDict(d); toDict() } with snake_case fields plus max_cost_usd (default null) and web_search (default true); parallelism defaults to 3.

schema.js: S, I, B, O(props), A(item), E(...values).
prompts.js: SYS_BASE, ABSTRACT_RULE.

llm.js: FALLBACK_BETA; class RunCancelled extends Error; class LLMError(code, message) with .code; isAbortError(err); friendlyError(err) -> LLMError, or RunCancelled for abort errors; async listModels(apiKey, { client = null, signal = null } = {}) -> string[]; class LLM { constructor({ apiKey = null, model, onWarning = null, signal = null, client = null }); model; usage = { calls, input_tokens, output_tokens }; signal; useFallback; async json(system, prompt, schema, { effort = 'medium', maxTokens = 16000 } = {}) -> object|null; async text(system, prompt, { effort = 'medium', maxTokens = 16000, stream = false, onDelta = null } = {}) -> string; async toolTurn(system, messages, tools, { effort = 'low', maxTokens = 8000 } = {}) -> raw response; costUsd(); static textOf(resp); static echoContent(resp); also instance textOf(resp) and echoContent(resp) }.

sources.js: class Source(fields) with shortCite(), toDict() and static fromDict(d); queries and subqs are Sets. shortCite(srcLike); KIND_RANK; normTitle(t, web = false) -> [key, truncated]; class EvidenceStore { items: Map; merged; add(src, query = '', subq = ''); get size; sources(); included(); toState() -> { sources, merged, keys }; static fromState(sources, merged, keys = null) }.

tfidf.js: ENGLISH_STOP_WORDS (Set, 318 words), tokenize(text), analyze(text), tfidfVectors(texts), cosineScores(queryText, docs) -> number[].

tools.js: httpGet(url, params, { asJson, retries = 3, timeout = 25000, signal }); searchOpenalex / searchSemanticScholar / searchEuropePmc(query, { limit = 6, yearFrom = null, email = '', signal = null } = {}) -> Source[]; TOOL_FUNCS = { search_openalex, search_semantic_scholar, search_europe_pmc }; TOOL_DESC; WEB_SEARCH_DESC; TOOL_LABELS; TOOLS (strict definitions); WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }; withToolLock(name, fn).

pipeline.js: STUDY_TYPES, DESIGN_WEIGHT, KIND_WEIGHT, TOOL_FAIL_LIMIT, MAX_REPORT_EVIDENCE, MAX_PLAN_REVISIONS, REPORT_RETRIES, RETRYABLE_CODES, VERDICTS, STAGE_NAMES, STATE_VERSION, REPORT_LENGTHS, CITE, citedIds(text), async mapLimit(items, limit, fn, onError = null).
- class RunHooks { emit(stage, kind, msg, data = null); progress(stage, done, total, label = ''); async checkpoint(); async reviewPlan(plan); reportDelta(text); async saveCheckpoint(state) }. An optional hooks.signal is used to cancel the academic DB requests.
- class ResearchAgent { constructor(prompt, llm, config, hooks = null, tools = null); async run() -> toResult(); toResult() (includes year_from, year_from_source, year_from_reason, disabled_tools, counts, budget_cap_usd, budget_hit); stats(); snapshotState(); static fromState(prompt, llm, config, hooks, state, tools = null); static async rewriteReport(prevResult, llm, config, hooks, { language = null, length = 'standard', extra = '' } = {}) }.
- Public stage methods, same names as Python: understand, makePlan, reviewPlan, investigate, investigateAll, evaluate, retrieve, synthesizeAll, reflect, replanAndAct, writeReport, verify.
- Public state fields: budgetHit, done, disabledTools, webSearchOff, reportOptions.

qa.js: retrieve(result, question, k = 8) -> source dicts; async answerQuestion(llm, result, question, history = []) -> { answer_markdown, sources }.

refine.js: REFINE_MODEL = 'claude-haiku-5-5', REFINE_SCHEMA, async refinePrompt(llm, draft, lang = 'auto') -> { suggestions: [exactly 3 of { prompt, focus, why }], questions: [0 to 3] }. Throws LLMError: bad_request for an empty draft, unknown if fewer than 3 suggestions come back.

tests/fakes.js:
- new FakeLLM({ continueRounds = 1, refuseReport = false, delay = 0 (ms), webSearch = false | true | 'error', costPerCall = 0.05, pauseTurn = false, rejectWebSearch = false, model = 'claude-opus-5-5' }). Fields: .usage, .calls. Methods: json, text, toolTurn, costUsd, textOf, echoContent; static stageOf(schema), static report(ids). It also answers Q&A prompts (containing 'Follow-up question:') and the refine schema.
- makeFakeTools({ fail = ['search_semantic_scholar'], empty = false } = {}) -> the 3 tools, sharing a .calls array of { tool, query, limit, yearFrom, email }.
- new RecordingHooks({ planDecisions = [], cancelAfter = null, cancelAtCheckpoint = null }) with .events, .progressCalls ([stage, done, total, label]), .deltas, .reviewedPlans, .checkpoints, .planDecisions, .cancelAfter, .ofKind(kind).
- Constants: NOY_TITLE, NOY_DOI, SHARED_DOI, REVISION_MARK, WEB_REPORT_URL, WEB_CITED_TEXT, crc32(str).

### 명세와 달라진 점

- The checkpoint state has one key the spec does not list: `store_keys` ({dois, titles}), the duplicate-merge index of EvidenceStore. Without it, aliases from merged copies (for example a web title that was merged into an academic record) are lost on resume, and later search results would merge differently from an uninterrupted run. All listed keys are present. topic and lang are not stored; fromState recomputes them from understanding and config with the same rule understand() uses.
- friendlyError(err) returns a RunCancelled (not an LLMError) when the request ended by abort (AbortError or APIUserAbortError), as SITE_SPEC 3.2 asks. Callers should check `instanceof RunCancelled` first.
- LLM methods throw raw SDK errors (only abort becomes RunCancelled), the same as Python, so the pipeline can still detect 'fallback' and 'web_search' in raw error messages. The backend must call friendlyError on what run() throws.
- TOOL_DESC holds only the 3 function tools, because TOOLS is built from it. The web search description is a separate export, WEB_SEARCH_DESC, used only for the planner's tool list.
- When web search is turned off for the run (3 consecutive error results, or the API rejects the tool), 'web_search' is also added to disabled_tools and web_search_off becomes true. So result.disabled_tools can contain 'web_search' (TOOL_LABELS has a label for it).
- preferred_tools defaults (user-edited sub-questions, new sub-questions from the critic) and the plan enum are the TOOL_FUNCS keys plus 'web_search', but 'web_search' is only included while web search is on (cfg.web_search true and not disabled).
- Cost cap details that SITE_SPEC leaves open: once the cap is hit, the deterministic OpenAlex top-up search is also skipped, and so is the final critic check (final_reflect). The loop also stops after a reflect() call that itself crossed the cap. The budget event's stage is the stage that was running when the cap was hit.
- Cancelling during report streaming: hooks.checkpoint() is async, so onDelta starts it on each chunk and throws its RunCancelled on the next chunk (and once more after the stream ends). A checkpoint that throws synchronously, or this.llm.signal being aborted, stops the stream at once.
- LLM and FakeLLM have textOf and echoContent as both static and instance methods. The pipeline calls this.llm.textOf(...) and this.llm.echoContent(...), like Python's self.llm.text_of.
- listModels and LLM take extra optional arguments (client, signal) so tests can inject the SDK; the spec signatures still work.
- FakeLLM's delay is in milliseconds (Python used seconds). makeFakeTools has only the 3 TOOL_FUNCS tools; web results come from FakeLLM's server-tool blocks when webSearch is on. Fake tool .calls entries are objects {tool, query, limit, yearFrom, email} instead of tuples.
- ResearchAgent sets a `_lastRetrieveQuery` field in retrieve(), used only by the B3 test.
- In fromDict, max_cost_usd is read as a number (numeric strings allowed), clamped to [0, 100] and rounded to cents; null or '' means no cap. A value of 0 is kept as a cap of $0, which stops searching after the first LLM call.

### 주의할 점

- package.json runs "node --test tests/", which fails on Node 22.14.0 (the folder is treated as a module path). The integrator should change the script to "node --test" (finds every *.test.js) or "node --test \"tests/*.test.js\"" (needs Node 21+), or say so in the README.
- Backend resume: fromState adds state.usage to the new llm.usage. That checkpoint usage does not include what the interrupted unit spent. To count it, the backend must replace state.usage with the run's latest usage before calling fromState. The backend should also pass the same config it used for the original run. hooks.signal (or the LLM's signal) is how in-flight OpenAlex, Semantic Scholar and Europe PMC requests get cancelled.
- Backend checkpoint storage: one snapshot holds every collected source (about 700 KB on a full run like the samples), and a save happens after each unit. Keep only the latest checkpoint per run in IndexedDB.
- The cost cap and costUsd() count tokens only. Web search requests (billed per search by Anthropic) are not counted, so real cost can be somewhat higher than shown.
- The web search shapes (server_tool_use, web_search_tool_result list or error object, web_search_result_location citations, pause_turn) follow the SDK 1.10 type definitions and the Claude API docs, but have only been tested with fakes. With web_search_20260209 the model may also emit code_execution blocks for dynamic filtering. The engine ignores them and echoes them back unchanged, which still needs one check against the real API. If the API rejects the tool, the turn is retried without it only when the error status is 4xx (not 401 or 429) and the message mentions web search.
- refinePrompt uses max_tokens 2000 as the spec says. On Haiku 5.5 with adaptive thinking this could run out (stop_reason max_tokens), so json() returns null and refinePrompt throws LLMError('unknown'). If that happens in practice, raise it to about 4000.
- When the browser front end imports tests/fakes.js for ?mock=1, it also loads vendor/anthropic-sdk.js (FakeLLM builds a real BadRequestError for rejectWebSearch). This is a relative import with no network access, so it is fine under the CSP.
- result.disabled_tools can now contain 'web_search'. The front end and exporters should label it with TOOL_LABELS rather than assume only search_* names. result.budget_cap_usd and result.budget_hit are new top-level keys from toResult(). The backend decides whether to also copy them into meta.
- Event kind 'budget' (data {cap, cost}) is new. The backend should decide whether it belongs in TRACE_KINDS; I did not add it. Resumed runs start with a 'log' event whose data is {resume_from: unit}.

## 통합 점검

### 공개 API

No new public API.
- `tests/index.js`: no exports. It is the entry point for `node --test tests/` and imports every `tests/*.test.js` in sorted order.
- `tests/integration.test.js`: test file only.
- `engine/demo.js`: `demoResult(run, sample)` keeps its signature. Its result now also has top-level `budget_cap_usd: null` and `budget_hit: false`, and the same two keys in `meta`.
- `export/slides.js`: exports are unchanged (STRENGTHS, FUTURE_KEYS, LIMITS, OUTLINE_SCHEMA, clean, clip, firstSentences, normalizeOutline, makeOutline, fallbackOutline). It now imports `A, E, O, S` from `../engine/schema.js` and `ABSTRACT_RULE, SYS_BASE` from `../engine/prompts.js` instead of keeping its own copies.

### 명세와 달라진 점

- The test command: SITE_SPEC section 7 requires `node --test tests/` to pass, but on Node 22.14 that command fails before any test runs. I could not change package.json (not mine to edit), so I added `tests/index.js`. Node runs it for `node --test tests/`, and it imports all *.test.js files into one process. The tests are the same; only the per-file process isolation is lost for this one command. `node --test` and `node --test "tests/*.test.js"` still run one process per file and do not pick up index.js.
- export/slides.js now imports SYS_BASE, ABSTRACT_RULE and S/O/A/E from engine/prompts.js and engine/schema.js, so export/ depends on two small engine modules. This is the single source of truth the export-text engineer suggested once those files existed. I checked the strings and the generated schema are identical.
- Demo results now carry `budget_cap_usd: null` and `budget_hit: false`, at the top level and in meta, so they have the same shape as real-run results. SITE_SPEC does not cover this case. Results from samples and from imported sample files still lack these keys, because the sample JSON is finished data. The front end must treat a missing value as no cap.

### 주의할 점

- `result.meta.usage` is fixed when the result is assembled, before the export stage. The pptx outline call from `makeOutline` therefore shows up in the run snapshot's usage but not in meta.usage or the exported files. The Python original behaves the same; the test asserts that the two differ by exactly 1 call.
- ?mock=1 and GitHub Pages: the front end imports tests/fakes.js, which imports vendor/anthropic-sdk.js and engine modules. The tests/ folder must be deployed to Pages; check this if the repo or the zip leaves tests out. tests/index.js and the *.test.js files import node:fs, but fakes.js does not, so it can load in the browser.
- Still unverified, because there is no real API key or browser here:
- the real Claude API with the web_search_20260209 server tool: code_execution blocks, pause_turn, citations, whether strict tools are accepted next to the server tool;
- IndexedDBStorage in a real browser: store creation, an about 700 KB checkpoint per save, quota;
- the front-end wiring in api.js.
Check all of these by hand in a browser before submission.
- Web search fees are not counted in costUsd() or in the cost cap, so the displayed cost can be lower than the real bill.
- Multiple tabs: a second tab on the same IndexedDB marks the first tab's live runs as interrupted, and nothing coordinates the two tabs. The backend engineer raised this and it is not addressed.
- refinePrompt uses max_tokens 2000 on Haiku with adaptive thinking. If real calls end with stop_reason max_tokens, raise it to about 4000 in engine/refine.js.
- Startup load is about 772 KB unminified for the site's own code, mostly anthropic-sdk at 392 KB raw / 88 KB gzipped. docx, pptxgenjs and jszip load only on export, as intended. The front end must keep importing export/index.js and not docx.js or pptx.js directly, or that lazy loading is lost.
- renderFragment links every source in result.sources, while the printable buildHtml lists only the included ones. The screen's citation links can point to #ref-S# entries that are not in the reference list, so the front end has to handle that and style span.cite-unknown and span.cites.

## 리드가 덧붙인 변경 (통합 뒤)

- 비용 계산에 웹 검색 요금을 넣었다: `models.js`의 `estimateCost(model, in, out, webSearches = 0)`(검색 1회 0.01달러, `WEB_SEARCH_USD`).
  `LLM.usage.web_searches`는 검색이 있었을 때만 생긴다. 실행 스냅샷의 usage에도 `web_searches`가 들어갈 수 있다.
- 주제 다듬기 max_tokens 4000.

## 2차 수정 (엔진)

- **새 메서드** `finishEarly(id)` → `{ok: true, status}` (`PUBLIC_METHODS`에 추가). 오류 `not_supported`(데모·다시 쓰기·샘플, 409),
  `not_running`(409), `not_now`(stage가 act·evaluate·synthesize·reflect가 아니거나 status가 running이 아님, 409). 멱등.
  이벤트 kind `finish_early`(stage = run.stage, msg '사용자 요청으로 추가 조사를 멈추고 지금까지 모은 근거로 보고서를 씁니다.', `TRACE_KINDS`에 추가).
- **ResearchAgent**: `finishRequested`, `requestFinish()`, `_stopSearching()`(= budgetHit || finishRequested) — 도구 라운드, 수집 3건 미만 보강 검색,
  재조사 라운드·`_roundStopped`·최종 점검이 모두 이것을 본다. `snapshotState().finish_requested`, `fromState`가 복원. `toResult().finished_early` → `_assemble`이 `meta.finished_early`로 옮긴다.
  보강 검색은 `search_queries`가 비면 `sq.question`(최대 300자)으로 검색한다.
  웹 검색 결과 오류 중 `WEB_REQUEST_ERRORS`(max_uses_exceeded·query_too_long·invalid_input)는 `log` 이벤트만 내고 연속 실패로 세지 않는다.
- **Run 스냅샷**: `wait_s`(계획 검토 대기 합, 지금 대기 포함), `finish_requested`. 둘 다 `RESTORE_KEYS`에 있어 저장·복원된다. `waitSeconds()`.
  `liveUsage().cost_usd`는 `llm.costUsd()`가 함수면 그 값, 아니면 `estimateCost`.
- **RESUMABLE_CODES**: connection, server, rate_limit, unknown, billing, auth, permission.
- **config()**: `web_search_usd`; `depths[].estimate.web_searches`(대략치 8/25/45).
- **이어하기**: `_runAgent`가 `run.usage.web_searches`(> 0일 때)를 복원 상태 usage에 넣는다. `run.finish_requested`가 있으면 복원한 에이전트에도 다시 건다.
- **LLM**: 스트림이 실패·취소되면 `s.currentMessage.usage`(SDK getter)의 토큰·웹 검색 횟수를 `_trackPartial`로 더한다(calls는 그대로).
- **저장**: `_saveCheckpoint`가 `persistError`를 확인해 실행마다 한 번 `warning` 이벤트를 낸다. `IndexedDBStorage`는 versionchange·close 때 캐시한 연결을 버리고 다음 쓰기에서 다시 연다.
- **조사 파일 가져오기**: `normalizeImported` — sources는 문자열 sid가 있는 객체만, authors는 문자열 배열(문자열이면 ;/,로 나눔),
  배열이 아닌 subqs·queries는 지움, trace·reflections·verification.checks·verification.unknown_ids는 배열로. 내보내기(`common.arr`, `authorList`)도 같은 값에 안전하다.
- 하지 않음: Haiku의 긴 프롬프트(10만 토큰 초과) 단가는 공개 단가를 확인하지 못해 넣지 않았다(문서화된 한계, 요청 단위 단가 없이 합계에 한 단가).


## 2차 수정 (연결 점검)
- `tests/ui-wiring.test.js`에 두 테스트를 더했다: (1) 화면 파일이 부르는 `api.*` 이름이 모두 api.js에 있다. (2) `?mock=1` api.js로 계획 검토 대기(`wait_s`가 대기 중에 늘고 승인 뒤 고정) → 고친 질문은 `{id, question}`만 보내 승인 → act 단계에서 `api.finishEarly`(계획 검토 중 `not_now`, 두 번째 호출도 ok) → `done`, `finish_early` 이벤트 1개, `meta.finished_early` → 끝난 뒤 `not_running`, 데모는 `not_supported`.
- main.js부터 모든 정적·동적 import를 링크만 해 보아(평가 없이) 이름 있는 import가 모두 실제 export임을 확인했다(45개 모듈). 정적 서버로 index.html·모듈·CSS·data 파일이 모두 200.
- 브라우저에서만 확인할 수 있는 것: 두 탭 넘겨받기, 겹친 모달의 Esc, 서랍 닫을 때 포커스, 기록 메뉴 배치(U9), '지금 마무리' 버튼·칩 표시, 결제/키 오류 카드.

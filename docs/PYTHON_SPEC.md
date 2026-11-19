# AI Research Agent Web — 구현 명세 (SPEC)

이 문서는 여러 작업자가 동시에 구현할 때 지켜야 하는 **계약**이다. 모듈 경계, 데이터 형식, HTTP API를 정한다.
여기 적힌 이름·형식은 바꾸지 않는다. 바꿔야 할 이유가 생기면 자기 모듈 안에서 우회하지 말고 최종 보고에 적는다.

## 0. 무엇을 만드는가

중간고사에서 만든 Colab 노트북 에이전트(`docs/reference/Research_Agent_midterm.ipynb`)를 **웹 앱**으로 발전시킨다.
사용자는 브라우저에서 연구 주제(프롬프트)를 입력하고, 모델과 결과물 형식을 고르고, 진행 상황을 실시간으로 보고,
보고서를 화면에서 읽거나 PDF·Word·Markdown·PPT 등으로 내려받는다.

- 실행: `python app.py` → `http://127.0.0.1:8000`. 로컬 PC에서 혼자 쓰는 도구다(다중 사용자 서비스가 아님).
- 백엔드: Python 3.10+, FastAPI + uvicorn. 에이전트는 동기 코드이며 실행 1건당 스레드 1개에서 돈다.
- 프런트엔드: 빌드 단계 없는 정적 파일(`web/`), 바닐라 JS(ES modules). 진행 상황은 **폴링**으로 받는다(SSE·WebSocket 금지: 프록시 환경에서도 동작해야 함).
- LLM: Anthropic Python SDK(`anthropic`). 검색 도구 5종은 API 키가 필요 없는 공개 API.
- 설계 원칙(노트북에서 계승): **규칙으로 할 수 있는 일은 코드, 의미 판단은 LLM. 전체 순서는 코드가 고정하고 검색 단계만 LLM 자율.**

### 의존성 (이 목록 밖의 패키지를 추가하지 않는다)
`anthropic`, `requests`, `ddgs`, `scikit-learn`, `markdown-it-py`, `fastapi`, `uvicorn`, `python-docx`, `python-pptx` + 표준 라이브러리.
pandas는 쓰지 않는다(CSV는 `csv` 모듈). 테스트는 표준 `unittest`(pytest 금지), HTTP 테스트는 `requests`로 실제 서버에 요청한다.

## 1. 폴더 구조와 소유권

```
research_agent_web/
  app.py                     # 진입점 (서버 담당)
  requirements.txt, start.bat, start.sh, README.md
  agent/
    models.py                # [완성됨·수정 금지] 모델 목록, 가격, 깊이 프리셋, RunConfig
    schema.py                # [완성됨] JSON Schema 축약 헬퍼 S, I, B, O, A, E
    prompts.py               # [완성됨] SYS_BASE, ABSTRACT_RULE (pipeline · qa · slides 공용)
    llm.py                   # Claude 호출 래퍼, 오류 변환                    (코어 담당)
    sources.py               # Source, EvidenceStore                         (코어 담당)
    tools.py                 # 검색 도구 5종                                 (코어 담당)
    pipeline.py              # ResearchAgent (8단계), RunHooks               (코어 담당)
    qa.py                    # 근거 기반 후속 질문                           (서버 담당)
    slides.py                # 슬라이드 개요(LLM + 규칙 기반 대체)           (PPT 담당)
  exporters/
    theme.py                 # [완성됨] 색·글꼴 상수
    __init__.py              # 형식 레지스트리 FORMATS, export()             (HTML 담당)
    md_export.py, html_export.py, pdf_export.py, refs_export.py             (HTML 담당)
    docx_export.py                                                          (Word 담당)
    pptx_export.py                                                          (PPT 담당)
  server/
    runs.py                  # RunManager, Run, 저장/복원                    (서버 담당)
    demo.py                  # 데모 모드: 기록된 실행 재생                   (서버 담당)
    api.py                   # FastAPI 라우트                                (서버 담당)
  web/                       # 프런트엔드 (나중 단계)
  data/
    samples/<id>/            # [완성됨] 실제 실행 2건을 변환한 샘플 (run.json, result.json, events.jsonl)
    runs/<id>/               # 실행 결과가 쌓이는 곳
  tests/                     # test_*.py (각 담당자가 자기 모듈 테스트 작성). _samples.py [완성됨]: PROJECT_ROOT, load_sample()
  docs/SPEC.md, docs/reference/Research_Agent_midterm.ipynb
```

모든 Python 모듈은 `research_agent_web/`를 작업 디렉터리로 두고 `from agent.models import RunConfig`,
`from exporters import export`처럼 **절대 import** 한다(`sys.path`에 프로젝트 루트가 들어간다고 가정. `tests/`는
`sys.path.insert(0, 프로젝트 루트)`를 맨 위에서 한다).
다른 담당자의 파일은 수정하지 않는다. 필요한 변경은 최종 보고에 적는다.

## 2. 코드 규칙

- 주석·docstring·사용자에게 보이는 문자열은 **한국어**(노트북과 같은 말투). 식별자는 영어.
- LLM에게 보내는 프롬프트는 노트북처럼 **영어**로 쓰고, 출력 언어만 `lang`으로 지시한다.
- 노트북 코드의 로직·프롬프트·가중치·임계값은 이 문서가 바꾸라고 한 곳 외에는 **그대로** 옮긴다(실제 API로 검증된 코드다).
- 전역 가변 상태 금지(실행 여러 건이 동시에 돌 수 있다). 예외: 검색 DB별 잠금(`TOOL_LOCKS`)은 프로세스 전역.
- Windows에서 실행된다: 경로는 `pathlib`, 파일은 항상 `encoding="utf-8"`, 콘솔 출력에 이모지를 쓰지 않는다.
- API 키는 메모리에만 둔다. 파일·로그·이벤트·예외 메시지 어디에도 쓰지 않는다.

## 3. 데이터 계약

### 3.1 RunConfig — `agent/models.py` (완성됨)
필드: `model, depth, min_subq, max_subq, max_reflection_rounds, max_tool_steps, results_per_search, verify_sample,
year_from(None=에이전트 결정, 0=제한 없음), language(auto|ko|en), human_in_the_loop, parallelism, formats, openalex_email`.
`RunConfig.from_dict(d)`가 검증·보정한다. 같은 파일에 `MODELS`, `get_model()`, `model_label()`, `estimate_cost()`,
`DEPTH_PRESETS`, `LIMITS`, `APP_NAME`, `APP_VERSION`, `PRICING_AS_OF`, `CURRENT_YEAR`가 있다.

### 3.2 result.json — 실행 1건의 완성된 결과 (모든 내보내기와 화면의 단일 원본)

실물 예시: `data/samples/sample_genai_graduate_research/result.json` (반드시 열어 보고 구현할 것).

```jsonc
{
  "schema_version": 1,
  "id": "r20261116_153012_a1b2",
  "prompt": "사용자가 입력한 원문",
  "topic": "핵심 연구 주제(제목으로 씀)",
  "lang": "ko",                              // 보고서 언어
  "meta": {
    "model": "claude-opus-5-5", "model_label": "Claude Opus 5.5",
    "created_at": "2026-11-16T15:30:12", "finished_at": "…", "elapsed_s": 1428.0,
    "year_from": 2022,                       // null = 제한 없음
    "year_from_source": "agent",             // "agent" | "user"
    "year_from_reason": "…",
    "config": { /* RunConfig.to_dict() */ },
    "usage": {"calls": 79, "input_tokens": 419170, "output_tokens": 135059, "cost_usd": 4.38},  // cost_usd는 null 가능
    "counts": {"collected": 229, "included": 86, "merged": 52, "report_evidence": 86, "sub_questions": 7},
    "disabled_tools": ["search_semantic_scholar"],
    "app_version": "1.0.0", "sample": false, "demo": false, "note": ""
  },
  "understanding": { /* ① 단계 출력: language, topic_en, discipline, research_type, key_concepts[{term,english,synonyms[]}],
                        independent_variables[], dependent_variables[], moderators_or_context[], population, ambiguities[],
                        scope_decision, search_start_year, search_window_reason, (새 실행만) core_topic, user_requirements[] */ },
  "plan": {"sub_questions": [{"id": "Q1", "question": "…", "perspective": "…", "rationale": "…",
                              "search_queries": ["…"], "preferred_tools": ["search_openalex"]}],
           "inclusion_criteria": ["…"], "success_criteria": ["…"]},
  "syntheses": {"Q1": {"answer": "…[S3]…", "key_findings": [{"finding": "…", "sources": ["S3"]}], "consensus": ["…"],
                       "disagreements": ["…"], "evidence_strength": "strong|moderate|weak|insufficient", "gaps": ["…"],
                       "sources": ["S3", "S9"]}},
  "reflections": [{"round": 1, "final": false, "quality_score": 5, "subq_assessment": [{"id","coverage","issue"}],
                   "bias_risks": ["…"], "should_continue": true, "reason": "…",
                   "followup_queries": [{"subq_id","query","tool"}], "new_sub_questions": [{"question","perspective","rationale","search_queries"}]}],
  "report_markdown": "## 1. 핵심 요약 …",    // 검증·수정이 끝난 본문. 표, 중첩 목록, 표 칸 안의 <br>, [S12] 인용 포함
  "verification": {"cited_ids": 68, "unknown_ids": [], "claims_total": 193,
                   "checks": [{"claim": "…", "verdict": "supported", "note": "…",
                               "revised": "…", "verdict_after": "supported", "note_after": "…"}]},   // revised 이하 3개는 수정된 문장만
  "stats": {"total_collected": 229, "included": 86, "duplicates_merged": 52,
            "by_kind": {"peer-reviewed": 60}, "by_study_type": {"RCT/experiment": 12}, "by_direction": {"mixed": 25},
            "by_year": {"2023": 14}, "year_range": [2023, 2026], "per_subq": {"Q1": 30}},    // 모두 채택 문헌 기준
  "sources": [{"sid": "S1", "title": "…", "authors": ["…"], "year": 2025, "venue": "…", "abstract": "…", "url": "https://…",
               "doi": "https://doi.org/…", "citations": 12, "origin": "OpenAlex", "kind": "peer-reviewed|academic|preprint|web",
               "queries": ["…"], "subqs": ["Q1"], "evaluated": true, "relevance": 3, "credibility": 0.72, "score": 0.88,
               "study_type": "…", "method": "…", "sample": "…", "key_finding": "…",
               "direction": "positive|negative|mixed|null|not applicable|", "limitation": "…",
               "included": true,        // 채택(관련성 ≥ 2)
               "in_report": true,       // 최종 보고서 작성에 전달됨
               "cited": true}],         // 보고서 본문에서 인용됨.  수집 문헌 전부를 sid 번호순으로 담는다
  "trace": [{"ts": "2026-11-16T15:30:31", "stage": "understand", "kind": "understanding", "msg": "…"}]  // 부록 D용 요약 기록
}
```

값의 어휘(고정):
- `verdict`: `supported` | `partially supported` | `not in source text` | `contradicted` (`verdict_after`는 `not checked`도 가능)
- `kind`: `peer-reviewed` | `academic` | `preprint` | `web`
- `year`, `citations`, `cost_usd`, `year_from`은 null일 수 있다. `direction`·`study_type` 등 문자열은 빈 문자열일 수 있다.
- 한국어 표시 이름은 `exporters/theme.py`의 `VERDICT_LABEL`, `KIND_LABEL`, `DIRECTION_LABEL`, `STRENGTH_LABEL`을 쓴다.

**구버전 호환**: 샘플은 노트북 실행 결과를 변환한 것이라 `understanding.core_topic`/`user_requirements`가 없고
`verification.checks[].claim`이 150자에서 잘려 있다. 모든 소비자(내보내기, 화면)는 키가 없거나 빈 값이어도 죽지 않아야 한다(`.get()` 사용).

### 3.3 이벤트 — `events.jsonl` 한 줄 = 한 이벤트

```json
{"seq": 12, "ts": "2026-11-16T15:31:02", "stage": "act", "kind": "tool", "msg": "Q1 · search_openalex('…') → 6건 (누적 42)", "data": {"subq": "Q1", "tool": "search_openalex", "query": "…", "count": 6, "total": 42}}
```
- `stage`: `understand | plan | act | evaluate | synthesize | reflect | report | verify | export | system`
- `msg`는 그 자체로 읽히는 한국어 한 줄(노트북의 로그 문구를 그대로 쓴다). `data`는 null일 수 있다.
- 샘플의 `events.jsonl`도 같은 형식이다(노트북 로그에서 변환했으므로 `tool_error`의 `subq`처럼 일부 값은 빈 문자열).

| kind | stage | data |
|---|---|---|
| `stage` | 전부 | `{"status": "start" \| "end", "round": 1}` |
| `understanding` | understand | `{"topic", "discipline", "research_type", "concepts": [..], "requirements": [..]}` |
| `window` | understand | `{"year_from": 2022 \| null, "source": "agent" \| "user", "reason"}` |
| `plan` | plan | `{"sub_questions": [{"id","question","perspective"}], "revised": false}` |
| `plan_review` | plan | `{"action": "waiting" \| "approve" \| "revise" \| "edit"}` |
| `tool` | act | `{"subq", "tool", "query", "count", "total"}` |
| `tool_error` | act | `{"subq", "tool", "query", "error"}` |
| `tool_disabled` | act | `{"tool"}` |
| `subq_done` | act | `{"subq", "found", "summary"}` |
| `evaluate` | evaluate | `{"evaluated", "included", "total", "merged"}` |
| `synthesis` | synthesize | `{"subq", "n", "strength"}` |
| `reflection` | reflect | `{"round", "final", "quality_score", "should_continue", "reason", "bias_risks": [..]}` |
| `replan` | reflect | `{"subq", "question"}` 또는 `{"queries": [..]}` |
| `report` | report | `{"evidence", "used"}` 또는 `{"chars"}` |
| `verify` | verify | `{"cited_ids", "unknown", "checked", "supported"}` |
| `repair` | verify | `{"bad", "fixed", "supported_after", "checked"}` |
| `export` | export | `{"fmt", "ok", "error"}` |
| `warning`, `error`, `log` | 전부 | 자유 |

`result.trace`에는 다음 kind만 넣는다(`server/runs.py`의 `TRACE_KINDS`):
`understanding, window, plan, plan_review, tool_disabled, subq_done, evaluate, reflection, replan, report, verify, repair`.

### 3.4 run.json — 상태 스냅샷 (실행 중 주기적으로 덮어씀, API `status`로 그대로 반환)

```jsonc
{
  "id": "r20261116_153012_a1b2",
  "status": "queued | running | awaiting_plan | done | error | cancelled | interrupted",
  "prompt": "…", "topic": "…",              // topic은 ① 단계 전에는 prompt 앞부분
  "model": "claude-opus-5-5", "model_label": "Claude Opus 5.5",
  "config": { /* RunConfig.to_dict() */ },
  "created_at": "…", "started_at": "…", "finished_at": null, "elapsed_s": 73.2,
  "stage": "act",                           // 3.3의 stage 값 또는 "done"
  "round": 1,                               // 1 = 첫 조사, 2부터 재조사 라운드
  "progress": {"done": 2, "total": 6, "label": "하위 질문 탐색"},   // null 가능
  "counts": {"collected": 87, "included": 0, "merged": 5, "report_evidence": 0, "sub_questions": 6},
  "usage": {"calls": 12, "input_tokens": 50123, "output_tokens": 9876, "cost_usd": 0.4},
  "plan": { /* 3.2의 plan. 계획 수립 뒤부터 */ },
  "awaiting": "plan",                       // 사용자 입력을 기다리는 중이면 "plan", 아니면 null
  "error": {"code": "auth", "message": "API 키가 올바르지 않습니다."},   // 없으면 null
  "formats": ["md", "pdf"],
  "exports": {"md": "ready", "pdf": "pending"},   // "pending" | "ready" | "failed" | "unavailable"
  "has_result": false, "sample": false, "demo": false, "note": ""
}
```

## 4. agent/ 모듈

노트북의 셀 ③④⑤를 모듈로 옮긴다. 아래에 적힌 **변경점만** 반영하고 나머지는 그대로 둔다.

### 4.1 `agent/schema.py`, `agent/prompts.py` (완성됨)
`S, I, B, O(**props), A(item), E(*values)` — 노트북과 동일. `prompts.py`의 `SYS_BASE`, `ABSTRACT_RULE`을 pipeline · qa · slides가 함께 쓴다.

### 4.2 `agent/llm.py`

```python
class RunCancelled(Exception): ...
class LLMError(Exception):            # 사용자에게 보여 줄 수 있는 오류
    def __init__(self, code: str, message: str): ...     # code: auth|permission|model|rate_limit|billing|bad_request|connection|server|refusal|unknown

def friendly_error(exc: Exception) -> LLMError   # anthropic 예외 → 한국어 메시지 (가장 구체적인 클래스부터 차례로 검사)
def list_models(api_key: str | None) -> list[str]  # client.models.list()를 직접 순회해 id 목록 반환 (키 확인용). 실패 시 LLMError

class LLM:
    def __init__(self, api_key: str | None, model: str, on_warning=None): ...
    model: str
    usage: dict            # {"calls", "input_tokens", "output_tokens"} — 스레드 안전하게 누적
    def json(self, system, prompt, schema, effort="medium", max_tokens=16000) -> dict | None
    def text(self, system, prompt, effort="medium", max_tokens=16000, stream=False, on_delta=None) -> str
    def tool_turn(self, system, messages, tools, effort="low", max_tokens=8000)      # 응답 객체 그대로 반환
    @staticmethod
    def text_of(resp) -> str            # 노트북의 LLM._text
    @staticmethod
    def echo_content(resp) -> list      # 다음 요청의 assistant 턴으로 되돌려 보낼 content
```

Claude API 규칙 (공식 문서로 확인한 내용. 기억에 의존해 바꾸지 말 것):
- `anthropic.Anthropic(api_key=api_key or None, max_retries=4)`. `api_key`가 None이면 SDK가 환경변수에서 찾는다.
- 모든 요청에 `output_config={"effort": effort}`를 **명시**한다(모델마다 기본값이 다름). `thinking` 파라미터는 **보내지 않는다**
  (현재 세대 모델은 생략 시 적응형 사고로 동작). `temperature`/`top_p`/`top_k`, `tool_choice`의 `any`/`tool`, assistant prefill은 **금지**(400 오류).
- 구조화 출력: `output_config={"effort": e, "format": {"type": "json_schema", "schema": schema}}`. 도구 정의에는 `strict: True`.
- 거절 대비 서버측 fallback: `get_model(model).supports_fallback`이 참인 모델만
  `client.beta.messages.create/stream(..., betas=["server-side-fallback-2026-07-01"], fallbacks="default")`로 호출한다.
  그 외 모델(Haiku 5.5, 목록에 없는 모델)은 일반 `client.messages.create/stream`. 노트북처럼 `BadRequestError`/`TypeError`
  메시지에 "fallback"이 들어 있으면 `use_fallback=False`로 바꾸고 일반 호출로 한 번 더 시도한다.
- 항상 `stop_reason`을 먼저 본다. `"refusal"`: `json()`은 None 반환 + `on_warning(msg)`, `text()`는 `LLMError("refusal", …)`,
  `tool_turn()`은 응답을 그대로 반환(호출부가 도구 호출 없음으로 처리). `"max_tokens"`: `json()`은 None + 경고, `text()`는 받은 만큼 반환 + 경고.
- 스트리밍(`stream=True`): `with client.messages.stream(**kw) as s:` 안에서 `on_delta`가 있으면 `for t in s.text_stream: on_delta(t)`,
  그 뒤 `s.get_final_message()`. `on_delta`가 `RunCancelled`를 던지면 그대로 전파한다. beta 경로도 같은 방식(`client.beta.messages.stream`).
- `echo_content(resp)`: `resp.content`에 `type == "fallback"` 블록이 있으면, **마지막 fallback 블록보다 앞에 있는**
  `thinking`·`redacted_thinking`·`tool_use` 블록을 빼고 나머지는 순서 그대로 둔다(fallback 블록 자체는 제자리에 유지).
  없으면 `resp.content` 그대로. 도구 루프는 이 결과에서 `tool_use` 블록을 찾고, 이 결과를 assistant 턴으로 덧붙인다.
  대화 기록은 덧붙이기만 한다(이전 턴을 고치면 사고 블록 서명이 깨져 400 오류).
- 오류 변환(`friendly_error`): `AuthenticationError`→auth, `PermissionDeniedError`→permission, `NotFoundError`→model
  ("모델을 찾을 수 없거나 이 키로 사용할 수 없습니다"), `RateLimitError`→rate_limit, `BadRequestError`→ 메시지에 "credit"이 있으면 billing,
  "data retention"이 있으면 bad_request("이 모델은 조직의 데이터 보존 설정이 필요합니다…"), 그 외 bad_request,
  `APIStatusError`(status 402→billing, ≥500→server), `APIConnectionError`→connection. 메시지에 키나 요청 본문을 넣지 않는다.
- 사용량: 응답마다 `usage.input_tokens`, `usage.output_tokens`를 잠금 아래에서 누적.

### 4.3 `agent/sources.py`
노트북의 `Source`, `_norm_title`, `KIND_RANK`, `EvidenceStore`를 옮긴다. 변경점:
- `Source.to_dict()` (set은 정렬된 list로), `Source.from_dict(d)`.
- `EvidenceStore.add()`는 `threading.Lock`으로 감싼다(하위 질문을 병렬로 탐색한다). `merged` 카운터 유지.

### 4.4 `agent/tools.py`
노트북의 `http_get`과 검색 함수 5개, `TOOL_FUNCS`, `_TOOL_DESC`(→ `TOOL_DESC`), `TOOLS`, `TOOL_LOCKS`. 변경점:
- 시그니처: `search_xxx(query, limit=6, year_from=None, email="")`. `email`은 OpenAlex만 사용.
- 모듈 전역 `requests.Session` 대신 호출마다 `requests.get(..., headers={"User-Agent": ...})`.
- `TOOL_LABELS = {"search_openalex": "OpenAlex", "search_semantic_scholar": "Semantic Scholar", "search_arxiv": "arXiv",
  "search_europe_pmc": "Europe PMC", "search_web": "웹 검색"}`.

### 4.5 `agent/pipeline.py`

```python
class RunHooks:                       # 기본 구현: emit은 print, 나머지는 아무것도 안 함
    def emit(self, stage: str, kind: str, msg: str, data: dict | None = None) -> None
    def progress(self, stage: str, done: int, total: int, label: str = "") -> None
    def checkpoint(self) -> None                  # 취소 요청이 있으면 RunCancelled를 던진다
    def review_plan(self, plan: dict) -> dict     # 사용자가 답할 때까지 블록. {"action": "approve"} |
                                                  # {"action": "approve", "sub_questions": [...]} | {"action": "revise", "feedback": "…"}
    def report_delta(self, text: str) -> None     # 보고서 스트리밍 조각

class ResearchAgent:
    def __init__(self, prompt: str, llm, config: RunConfig, hooks: RunHooks | None = None, tools: dict | None = None)
        # tools: {도구 이름: 함수}. 기본은 agent.tools.TOOL_FUNCS (테스트에서 가짜 도구 주입)
    def run(self) -> dict            # 8단계 실행 후 to_result() 반환
    def to_result(self) -> dict      # 3.2에서 id·meta·trace·schema_version을 뺀 부분 +
                                     # "year_from", "year_from_source", "year_from_reason", "disabled_tools", "counts"
    def stats(self) -> dict          # 3.2의 stats (노트북 _evidence_stats에서 채택 문헌 통계 부분 + by_year)
```

노트북 `ResearchAgent` 대비 변경점:
1. **설정**: 전역 상수 대신 `self.cfg`(RunConfig). `OUTPUT_LANGUAGE`→`cfg.language`, `YEAR_FROM`→`cfg.year_from`,
   `VERIFY_SAMPLE`→`cfg.verify_sample`, `MAX_TOOL_STEPS`→`cfg.max_tool_steps`, `RESULTS_PER_SEARCH`→`cfg.results_per_search`(도구의 `limit`),
   `MAX_REFLECTION_ROUNDS`→`cfg.max_reflection_rounds`.
2. **로그**: `log(stage, msg, data)` → `self.hooks.emit(stage, kind, msg, data)`. 문구는 노트북 그대로, kind와 data는 3.3 표대로.
   각 단계의 시작·끝에 `stage` 이벤트(`"① 주제 이해"` 등 한국어 이름)를 낸다. 노트북의 `print()`(하위 질문 목록, ⚠ 편향 위험)는
   이벤트의 `data`로 옮긴다.
3. **프롬프트 입력(①)**: 입력은 "연구 주제"가 아니라 자유로운 요청문일 수 있다. understand 스키마에 `core_topic=S`,
   `user_requirements=A(S)`를 추가하고 프롬프트를 다음 취지로 바꾼다 — `User request: """{prompt}"""`,
   `core_topic`: 요청에서 연구 주제만 뽑은 간결한 제목(요청 언어 그대로), `user_requirements`: 범위·기간·지역·방법·강조점에 대한
   명시적 요구(없으면 빈 배열, 지어내지 말 것). 요청에 기간이 명시돼 있으면 `search_start_year`는 그 값을 따른다.
   `self.topic = core_topic or prompt`. 이후 프롬프트의 `Topic:`에는 `self.topic`을 쓰고, 계획·보고서 프롬프트에
   `User requirements to honor: [...]` 줄을 넣는다(비어 있으면 생략).
4. **계획(②)**: `4 to 6 sub-questions` → `{cfg.min_subq} to {cfg.max_subq} sub-questions`.
   `cfg.human_in_the_loop`이면 `plan_review` 이벤트(waiting)를 내고 `hooks.review_plan(self.plan)`을 부른다.
   `revise`면 `make_plan(feedback=…)` 후 다시 검토(최대 5회), `approve`에 `sub_questions`가 있으면 그 목록으로 교체
   (id를 Q1..Qn으로 다시 매기고, 빠진 필드는 `perspective="user-added"`, `rationale=""`, `search_queries=[]`,
   `preferred_tools=list(TOOL_FUNCS)`로 채움; 1~8개가 아니면 원래 계획 유지).
5. **병렬 실행**: `cfg.parallelism`개의 스레드로 (a) 하위 질문별 `investigate`, (b) 평가 배치, (c) 하위 질문별 `synthesize`를
   동시에 실행한다(`ThreadPoolExecutor`). `parallelism == 1`이면 노트북과 같은 순서로 순차 실행. 결과는 입력 순서대로 반영하고,
   작업 스레드에서 난 예외(`RunCancelled` 포함)는 호출한 쪽으로 다시 던진다. 공유 상태(`store`, `tool_failures`,
   `disabled_tools`, `syntheses`, `llm.usage`)는 잠금으로 보호한다. `search_queries`가 빈 하위 질문도 동작해야 한다.
6. **도구 호출**: `_fetch`는 잠금을 얻은 **뒤에도** `disabled_tools`를 다시 확인한다(대기 중이던 호출이 제외된 도구를 또 부르지 않게).
   `TOOL_FUNCS[name](query, limit=cfg.results_per_search, year_from=self.year_from, email=cfg.openalex_email)`.
   도구 루프는 `LLM.echo_content(resp)`를 쓴다(4.2).
7. **취소**: LLM 호출·도구 호출·배치 사이마다 `self.hooks.checkpoint()`.
8. **보고서(⑦)**: `max_tokens=64000`, `stream=True`, `on_delta=self.hooks.report_delta`. 프롬프트의 섹션 구성·규칙은 그대로.
9. **검증(⑧)**: 로직 그대로(`_claim_spans`, `_check`, `_repair`, `_valid_revision`). 이벤트만 3.3대로.
10. **진행률**: `hooks.progress("act", 끝난 하위 질문 수, 전체, "하위 질문 탐색")`, evaluate는 배치 수, synthesize는 하위 질문 수.
11. **재조사 라운드**: `reflections` 항목에 `round`(1부터)와 `final`을 넣는다. 라운드가 바뀔 때 `stage` 이벤트의 `round`를 올린다.
12. `to_result()`의 `sources`는 수집 문헌 전부(sid 번호순)이고 `included`/`in_report`/`cited`를 계산해 넣는다.
    `counts`: collected, included, merged, report_evidence, sub_questions.
13. **화면에 보이는 글은 보고서 언어로**: 노트북은 계획·비평 등의 중간 출력이 영어로 나왔다. 웹 화면에 그대로 보여 주므로
    다음 필드는 프롬프트에 `Write ... in language "{lang}"`를 덧붙여 보고서 언어로 받는다 — understand의 `discipline`,
    `research_type`, `population`, `ambiguities`, `scope_decision`, `search_window_reason`, `user_requirements`;
    plan의 `question`, `perspective`, `rationale`, `inclusion_criteria`, `success_criteria`; 탐색 루프의 마지막 요약문;
    reflect의 `reason`, `bias_risks`, `subq_assessment[].issue`, `new_sub_questions[].question/perspective/rationale`.
    `topic_en`, `key_concepts[].english/synonyms`, 모든 `search_queries`/`followup_queries[].query`는 **영어 유지**(학술 DB 검색용).
    understand 단계에서는 `lang`이 아직 없으므로 "in the language of the request"로 지시한다(`cfg.language`가 ko/en이면 그 언어).

### 4.6 `agent/qa.py` (서버 담당)
```python
def retrieve(result: dict, question: str, k: int = 8) -> list[dict]      # 채택 문헌에서 TF-IDF 유사도(0.7) + score(0.3) 상위 k
def answer_question(llm, result: dict, question: str, history: list[dict] | None = None) -> dict
    # → {"answer_markdown": "…[S3]…", "sources": ["S3", ...]}  근거와 보고서 발췌만으로 답하고, 근거가 부족하면 그렇게 말한다.
```
프롬프트: 시스템은 `SYS_BASE` + 근거 밖 지식 사용 금지 + `ABSTRACT_RULE`, 사용자 턴에는 질문, 최근 Q&A 3개, 검색된 근거
(sid, 저자·연도, 유형, 표본, 핵심 결과, 초록 900자), 관련 하위 질문 종합의 `answer`. `effort="medium"`, `max_tokens=8000`, `lang`은 result의 것.

### 4.7 `agent/slides.py` (PPT 담당)
```python
OUTLINE_SCHEMA: dict
def make_outline(llm, result: dict) -> dict | None     # LLM이 보고서를 발표용 개요로 압축. 실패하면 None
def fallback_outline(result: dict) -> dict             # LLM 없이 syntheses·reflections·report_markdown에서 규칙으로 구성 (항상 성공)
```
개요 형식(둘 다 같은 모양):
```jsonc
{"title": "…", "subtitle": "…",
 "summary": ["핵심 요약 문장 (최대 5개, 각 110자 이내, [S#] 인용 유지)"],
 "findings": [{"subq_id": "Q1", "headline": "한 줄 결론", "bullets": ["…(최대 4개)"], "strength": "moderate"}],
 "agreements": ["연구들이 일치하는 점 (최대 4)"], "conflicts": ["상충하는 점과 이유 (최대 4)"],
 "gaps": ["연구 공백 (최대 6)"],
 "future_studies": [{"title": "…", "question": "…", "design": "…", "sample": "…", "contribution": "…"}],   // 최대 3
 "must_read": [{"sid": "S12", "why": "…"}],      // 최대 5
 "limitations": ["… (최대 5)"]}
```

## 5. exporters/

모든 내보내기는 **result dict(3.2)만** 입력으로 받는다(실행 중 객체에 의존하지 않음 → 과거 실행도 똑같이 내보낼 수 있다).
색·글꼴·한국어 라벨은 `exporters/theme.py`에서 가져온다.

```python
# exporters/__init__.py
FORMATS: list[dict]    # [{"id","label","ext","mime","description","group"}], 순서 = 화면 표시 순서
#   md   Markdown 보고서      .md    group "report"
#   html HTML 보고서(인쇄용)  .html  "report"
#   pdf  PDF 보고서           .pdf   "report"
#   docx Word 문서            .docx  "report"
#   pptx 발표 슬라이드        .pptx  "slides"
#   bib  참고문헌 BibTeX      .bib   "refs"
#   ris  참고문헌 RIS         .ris   "refs"
#   csv  근거표 CSV           .csv   "data"
#   json 전체 데이터 JSON     .json  "data"
class ExportError(Exception): ...
class PdfUnavailable(ExportError): ...          # PDF를 만들 브라우저를 찾지 못함
def slugify(topic: str, max_len: int = 40) -> str             # 파일 이름용: 한글·영숫자 유지, 공백→_, 비면 "research"
def filename_for(result: dict, fmt: str) -> str               # 예: "생성형_AI_활용이…_report.docx", pptx는 "_slides.pptx", bib/ris는 "_references"
def export(result: dict, fmt: str, out_dir: Path, outline: dict | None = None) -> Path
    # out_dir에 filename_for() 이름으로 파일을 쓰고 경로 반환. 알 수 없는 fmt → ExportError. docx/pptx 모듈은 함수 안에서 늦게 import.
```

- `md_export.build_markdown(result) -> str` — 노트북 `build_markdown`과 같은 구성: 제목, 메타 줄, 본문, 부록 A(5열 표), B(참고문헌),
  C(인용 검증: 집계 + 수정 전/후), D(수행 기록: `result["trace"]`).
- `html_export.render_fragment(result) -> {"html": str, "toc": [{"id","level","title"}]}` — 웹 화면의 보고서 탭용 **본문만**.
  markdown-it-py(`commonmark` + table, `html` 옵션 **끔**)로 렌더링하고, 이스케이프된 `&lt;br&gt;`만 `<br>`로 되돌린다
  (LLM이 표 칸에 `<br>`을 쓴다). h2·h3에 `id="sec-N"`. 인용은 `sources`에 실제로 있는 ID만
  `<a class="cite" data-sid="S12" href="#ref-S12">S12</a>`로 감싼다(대괄호·쉼표는 유지: `[S1, S2]` → `[<a…>S1</a>, <a…>S2</a>]`).
  외부 링크에는 `target="_blank" rel="noopener noreferrer"`. **결과 HTML에 스크립트나 이벤트 속성이 들어갈 수 없어야 한다.**
- `html_export.build_html(result, auto_print=False) -> str` — 단독으로 열리는 완성 문서(CSS 내장, 외부 리소스는 선택적 웹폰트뿐):
  표지 머리(제목·주제·메타), 본문, 부록 A~D(코드가 직접 HTML로 생성, 참고문헌 항목은 `id="ref-S12"`), 인쇄 규칙
  (A4, 표 머리 반복, 부록 A 표는 가로 페이지 — CSS named page), `auto_print=True`면 로드 후 `window.print()` 호출 스크립트 1줄.
- `pdf_export.find_browser() -> str | None`, `pdf_export.html_to_pdf(html_path, pdf_path, timeout=120)` — 설치된 Edge/Chrome/Chromium을
  헤드리스로 실행해 인쇄(`--print-to-pdf`). 임시 프로필(`--user-data-dir`)을 쓰고 끝나면 지운다. 브라우저가 없으면 `PdfUnavailable`.
  환경변수 `RESEARCH_AGENT_BROWSER`로 실행 파일을 지정할 수 있다.
- `refs_export.build_bibtex(result) / build_ris(result) / build_csv(result) -> str` — BibTeX·RIS는 **채택 문헌**, CSV는 수집 문헌 전부(utf-8-sig).
- `docx_export.build_docx(result, path) -> Path`, `pptx_export.build_pptx(result, outline, path) -> Path` — 각 담당자 지시문 참조.

## 6. server/

### 6.1 `server/runs.py`

```python
TRACE_KINDS = {...}
class Run:  # 실행 1건의 메모리 상태. snapshot() -> 3.4의 dict
class RunManager:
    def __init__(self, data_dir: Path, samples_dir: Path, demo: bool = False, demo_speed: float = 1.0)
    def create(self, prompt: str, config: RunConfig, api_key: str | None) -> Run      # 스레드 시작
    def get(self, run_id) -> Run | None             # 메모리에 없으면 디스크(run.json)에서 복원
    def list(self) -> list[dict]                    # 요약 목록, 최신순, 샘플은 맨 뒤
    def events(self, run_id, after: int) -> list[dict]
    def cancel(self, run_id) -> bool
    def submit_plan(self, run_id, decision: dict) -> bool
    def delete(self, run_id) -> None                # 샘플·실행 중인 것은 거부
    def result(self, run_id) -> dict | None         # result.json
    def export(self, run_id, fmt) -> Path           # 캐시(exports/)에 없으면 생성
    def ask(self, run_id, question, api_key, model=None) -> dict
```
- 실행 스레드: LLM 생성 → `ResearchAgent(prompt, llm, config, hooks).run()` → result 조립(id, meta, trace, schema_version 추가) →
  `result.json` 저장 → `stage="export"`로 `config.formats`를 차례로 생성(실패해도 실행은 성공; `exports[fmt]="failed"`) → `status="done"`.
  `pptx`가 포함돼 있으면 `agent.slides.make_outline(llm, result)`로 개요를 만들어 `slides.json`에 저장(실패 시 `fallback_outline`).
  나중에 요청된 pptx는 `slides.json`이 있으면 그것을, 없으면 `fallback_outline`을 쓴다.
- 예외 처리: `RunCancelled` → `cancelled`; `LLMError` → `error`(code, message 그대로); anthropic 예외 → `friendly_error`; 그 외 →
  `error`(code "internal", message는 예외 종류와 한 줄 요약) + 전체 traceback은 run 폴더의 `error.log`.
- 동시에 진행 중인 실행은 최대 2건(초과 시 `too_many_runs`).
- 저장: `data/runs/<id>/run.json`(단계가 바뀔 때·끝날 때), `events.jsonl`(추가 기록), `result.json`, `slides.json`, `qa.jsonl`, `exports/`.
  서버 시작 시 `queued/running/awaiting_plan` 상태로 남아 있는 실행은 `interrupted`로 바꾼다.
- 샘플(`data/samples/*`)은 읽기 전용 실행으로 목록에 나온다. 샘플의 내보내기 캐시는 `data/runs/_sample_exports/<id>/`에 둔다.
- `run_id`: `r%Y%m%d_%H%M%S_` + 4자리 16진수. 외부 입력 id는 `^[A-Za-z0-9_-]{1,80}$`로 검증.
- API 키는 `Run` 객체 속성으로만 보관하고 `snapshot()`·파일에 넣지 않는다. 실행이 끝나면 지운다.

### 6.2 데모 모드 — `server/demo.py`
`python app.py --demo`이면 API를 호출하지 않는다. 새 실행은 샘플(`sample_genai_graduate_research`)의 `events.jsonl`을
빠르게 **재생**하고(이벤트 사이 0.05~0.6초 × `demo_speed`, 전체 약 40~60초), 끝나면 샘플 result를 새 id·사용자 prompt로 복사해
결과로 저장한다. 재생 중에도 상태 스냅샷(stage, round, progress, counts, usage)이 자연스럽게 변해야 하고,
`human_in_the_loop`이면 계획 뒤에 실제로 멈춰 사용자 결정을 기다린다(`revise`는 한 번 재계획한 척한 뒤 다시 대기).
`report` 단계에서는 샘플 보고서 본문을 조각내어 미리보기로 흘려보낸다. 취소도 동작한다.
`ask()`는 데모에서 LLM 없이 `qa.retrieve` 결과로 "데모 모드: 관련 근거 상위 n건" 형태의 답을 만든다. 결과의 `meta.demo = true`.

### 6.3 HTTP API — `server/api.py`

공통: JSON. 오류는 `{"error": {"code": "…", "message": "한국어"}}` + 알맞은 상태 코드. 본문이 있는 요청은 `Content-Type: application/json`만 허용.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/config` | | 아래 참조 |
| `POST /api/key/check` | `{"api_key": "…"}` (없으면 서버 환경변수 키 확인) | `{"ok": true, "models": ["claude-opus-5-5", …]}` 또는 `{"ok": false, "error": {code, message}}` (항상 200) |
| `POST /api/runs` | `{"prompt", "model", "api_key"?, "depth", "options": {…RunConfig 필드 덮어쓰기}, "language", "year_from", "human_in_the_loop", "formats": [..]}` | 201 `{"id", "status": {스냅샷}}`. 오류 코드: `empty_prompt`(400), `prompt_too_long`(400, 4000자 초과), `no_api_key`(400), `too_many_runs`(409) |
| `GET /api/runs` | | `{"runs": [{id, topic, prompt, model, model_label, status, stage, created_at, elapsed_s, counts, usage, sample, demo, note}]}` |
| `GET /api/runs/{id}` | | 스냅샷(3.4). 없으면 404 `not_found` |
| `GET /api/runs/{id}/events?after=0&preview_from=0` | | `{"events": [...], "next": 57, "status": {스냅샷}, "preview": {"from": 0, "text": "…", "total": 1234} \| null}` — `after`보다 큰 seq만. `preview`는 보고서 작성 중일 때 `preview_from` 글자 위치부터의 텍스트 |
| `POST /api/runs/{id}/plan` | `{"action": "approve", "sub_questions"?: [...]}` \| `{"action": "revise", "feedback": "…"}` | `{"ok": true}`; 대기 중이 아니면 409 `not_awaiting` |
| `POST /api/runs/{id}/cancel` | | `{"ok": true}` |
| `DELETE /api/runs/{id}` | | `{"ok": true}`; 샘플 403 `read_only`; 진행 중 409 `running` |
| `GET /api/runs/{id}/result` | | result(3.2) + `"report_html"`, `"toc"`(5절 `render_fragment`), `"exports"`(스냅샷의 것), `"qa": [{question, answer_markdown, answer_html, sources, ts}]`. 결과 없으면 404 `no_result` |
| `GET /api/runs/{id}/export/{fmt}` | `?inline=1`이면 내려받기 대신 브라우저에서 열기(html 전용), `?print=1`이면 `auto_print` HTML | 파일(`Content-Disposition`에 한글 파일명). PDF 브라우저 없음 → 409 `pdf_unavailable`; 그 외 실패 → 500 `export_failed`; fmt `zip` = 지금까지 만든 결과물 + result.json 묶음 |
| `POST /api/runs/{id}/slides` | `{"api_key"?, "model"?}` | LLM으로 슬라이드 개요를 다시 만들고 pptx 재생성 → `{"ok": true}` |
| `GET /api/runs/{id}/qa` | | `{"items": [...]}` |
| `POST /api/runs/{id}/qa` | `{"question", "api_key"?, "model"?}` | `{"question", "answer_markdown", "answer_html", "sources": ["S3"], "ts"}`; 오류 `empty_question`, `no_api_key`, LLM 오류 코드 |
| `GET /` , `GET /assets/*` | | `web/index.html`, `web/assets/*` (캐시 금지 헤더). `web/index.html`이 아직 없으면 안내 문구만 있는 임시 페이지 |

`GET /api/config` 응답:
```jsonc
{"app": {"name": "AI Research Agent", "version": "1.0.0"}, "demo": false,
 "server_key": false,                       // 서버 환경변수 ANTHROPIC_API_KEY 존재 여부(값은 절대 내보내지 않음)
 "models": [{…ModelInfo.to_dict(), "default": true}], "pricing_as_of": "2026-11-03",
 "depths": [{"id": "quick", "label", "description", "config": {…}, "estimate": {…}}], "default_depth": "standard",
 "formats": [{…FORMATS 항목, "available": true, "note": ""}],     // pdf는 브라우저가 없으면 available=false + note
 "defaults": {RunConfig().to_dict()}, "limits": {"max_tool_steps": [1, 6], …},
 "tools": [{"name": "search_openalex", "label": "OpenAlex", "description": "…"}],
 "stages": [{"id": "understand", "label": "주제 이해", "description": "핵심 개념·변수·검색 기간 파악"}, …8개],
 "examples": ["생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향", "롤러를 활용한 센서 제작 공정", "…"]}
```

### 6.4 보안 규칙 (로컬 서버라도 지킨다)
- 기본 바인딩 `127.0.0.1`. `TrustedHostMiddleware`로 Host 헤더를 `127.0.0.1`, `localhost`, `[::1]`(+ `--host`로 준 값)로 제한(DNS rebinding 방지). CORS 헤더는 내보내지 않는다.
- `{id}`·`{fmt}`는 화이트리스트/정규식으로 검증하고, 파일 경로는 항상 `data/` 아래인지 확인한다.
- API 키: 응답·로그·이벤트·파일에 절대 넣지 않는다. 접근 로그는 끈다(`access_log=False`).
- 출처 URL은 `http://`/`https://`만 `href`로 쓴다. 화면에 넣는 문자열은 전부 이스케이프한다.

### 6.5 `app.py`
`python app.py [--host 127.0.0.1] [--port 8000] [--demo] [--demo-speed 1.0] [--no-browser] [--data-dir data]`.
시작 시 표준 출력을 UTF-8로 재설정, 포트가 사용 중이면 +1씩 최대 10번 시도, 주소를 출력하고 `--no-browser`가 아니면 기본 브라우저를 연다.
`server.api.create_app(manager) -> FastAPI`.

## 7. 테스트
- `python -m unittest discover -s tests -v` 로 전부 통과해야 한다(프로젝트 루트에서 실행, 네트워크·API 키 불필요).
- 파이프라인: 가짜 LLM(스키마의 키로 단계를 구분)과 가짜 도구로 전체 흐름(병렬 1/3, 재계획, 계획 검토, 취소, 수집 0건, 거절)을 검증한다.
- 내보내기: 두 샘플 result로 파일을 만들고 다시 열어 구조를 검증한다.
- 서버: `--demo` 서버를 임의 포트에 띄워 6.3의 경로를 `requests`로 검증한다.

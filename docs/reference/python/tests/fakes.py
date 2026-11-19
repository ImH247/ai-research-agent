"""테스트용 가짜 LLM · 가짜 검색 도구 · 기록용 훅. 네트워크와 API 키 없이 파이프라인 전체를 돌린다.

다른 담당자(서버)도 import해서 쓴다. 이름과 동작을 바꾸지 말 것.

- FakeLLM(continue_rounds=1, refuse_report=False, delay=0.0)
    agent.llm.LLM과 같은 인터페이스(model, usage, json, text, tool_turn, text_of, echo_content).
    json()은 스키마의 키로 단계를 알아내 결정적으로 답한다:
    understanding / plan / evaluation / synthesis / reflection / verification / repair.
    - continue_rounds: 자기 비판에서 should_continue=True로 답할 라운드 수(1라운드에는 새 하위 질문 1개 추가).
    - refuse_report: True면 text()가 LLMError("refusal", ...)를 던진다.
    - delay: 호출마다 쉬는 시간(초). 서버 테스트에서 실행을 천천히 진행시킬 때 쓴다.
    text()는 프롬프트의 근거 목록에 있는 실제 ID를 인용한 Markdown 보고서를 만든다(인용이 든 표 행,
    "... 향상되었다. [S1]." 같은 인용만 남은 조각, 존재하지 않는 [S9999], "et al." 문장 포함).
    stream=True이고 on_delta가 있으면 조각을 on_delta로 흘려보낸다. 호출된 단계 이름은 .calls에 쌓인다.

- make_fake_tools(fail=("search_semantic_scholar",), empty=False) -> dict
    검색 도구 5종 이름 → 실제와 같은 시그니처의 함수(query, limit=6, year_from=None, email="").
    fail에 든 도구는 항상 RuntimeError("요청 실패: 429 rate limited"), empty=True면 모두 [] 반환.
    모든 함수는 같은 기록 리스트를 .calls 속성으로 공유한다: (도구, query, limit, year_from, email).

- RecordingHooks(plan_decisions=None, cancel_after=None)
    .events(dict 목록: stage, kind, msg, data), .progress_calls((stage, done, total, label)),
    .deltas(보고서 조각), .reviewed_plans(review_plan에 넘어온 계획 복사본).
    plan_decisions: review_plan이 차례로 돌려줄 결정 목록(다 쓰면 {"action": "approve"}).
    cancel_after=N: 이벤트가 N개 이상 쌓이면 checkpoint()가 RunCancelled를 던진다.
"""
import ast
import copy
import re
import threading
import time
import zlib
from types import SimpleNamespace

from _samples import PROJECT_ROOT  # noqa: F401  (프로젝트 루트를 sys.path에 넣는다)

from agent.llm import LLMError, RunCancelled
from agent.pipeline import RunHooks
from agent.sources import Source

NOY_TITLE = "Experimental evidence on the productivity effects of generative artificial intelligence"
NOY_DOI = "https://doi.org/10.1126/science.adh2586"
SHARED_DOI = "https://doi.org/10.5555/llm.writing.2024"
REVISION_MARK = "(초록 기준)"


def _usage():
    return SimpleNamespace(input_tokens=100, output_tokens=20)


def _resp(content, stop_reason="end_turn"):
    return SimpleNamespace(content=content, stop_reason=stop_reason, usage=_usage())


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


class FakeLLM:
    """agent.llm.LLM 대신 쓰는 결정적인 가짜 LLM (모듈 docstring 참조)."""

    def __init__(self, continue_rounds=1, refuse_report=False, delay=0.0, model="claude-opus-5-5"):
        self.model = model
        self.continue_rounds = continue_rounds
        self.refuse_report = refuse_report
        self.delay = delay
        self.usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0}
        self.calls = []
        self._reflections = 0
        self._lock = threading.Lock()

    def _track(self, stage):
        if self.delay:
            time.sleep(self.delay)
        with self._lock:
            self.calls.append(stage)
            self.usage["calls"] += 1
            self.usage["input_tokens"] += 100
            self.usage["output_tokens"] += 20

    # ── LLM과 같은 정적 메서드 ──
    @staticmethod
    def text_of(resp):
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()

    @staticmethod
    def echo_content(resp):
        return resp.content

    # ── 구조화 출력 ──
    @staticmethod
    def _stage_of(schema):
        props = schema.get("properties", {})
        if "topic_en" in props:
            return "understanding"
        if "sub_questions" in props:
            return "plan"
        if "evidence_strength" in props:
            return "synthesis"
        if "quality_score" in props:
            return "reflection"
        if "items" in props:
            inner = props["items"]["items"]["properties"]
            if "relevance" in inner:
                return "evaluation"
            if "verdict" in inner:
                return "verification"
            if "revised" in inner:
                return "repair"
        return "unknown"

    def json(self, system, prompt, schema, effort="medium", max_tokens=16000):
        stage = self._stage_of(schema)
        self._track(stage)
        return getattr(self, f"_{stage}")(prompt)

    def _understanding(self, prompt):
        return {"language": "ko", "topic_en": "Effects of generative AI on graduate students' research productivity",
                "discipline": "고등교육 연구", "research_type": "인과 효과",
                "key_concepts": [{"term": "생성형 AI", "english": "generative AI", "synonyms": ["large language models", "ChatGPT"]},
                                 {"term": "연구 생산성", "english": "research productivity", "synonyms": ["writing productivity"]}],
                "independent_variables": ["생성형 AI 사용"], "dependent_variables": ["연구 생산성", "연구 품질"],
                "moderators_or_context": ["학문 분야"], "population": "대학원생", "ambiguities": ["'품질'의 측정 방식"],
                "scope_decision": "LLM 기반 도구로 한정", "search_start_year": 2022,
                "search_window_reason": "ChatGPT 공개 이후 연구가 본격화되었다.",
                "core_topic": "생성형 AI와 대학원생 연구 생산성", "user_requirements": []}

    def _plan(self, prompt):
        m = re.search(r"(\d+) to (\d+) sub-questions", prompt)
        n = int(m.group(1)) if m else 4
        revised = "Human reviewer feedback" in prompt
        topics = ["writing productivity", "research quality", "adoption survey", "integrity risks",
                  "learning outcomes", "measurement validity", "discipline differences", "policy guidance"]
        sqs = [{"id": f"Q{i + 1}", "question": f"{'(수정) ' if revised else ''}생성형 AI와 {topics[i % 8]}의 관계는?",
                "perspective": topics[i % 8], "rationale": "핵심 관점", "search_queries":
                [f"generative AI {topics[i % 8]} graduate students", f"large language models {topics[i % 8]}"],
                "preferred_tools": ["search_openalex", "search_web"]} for i in range(n)]
        return {"sub_questions": sqs, "inclusion_criteria": ["2022년 이후 실증 연구"], "success_criteria": ["하위 질문마다 근거 3건 이상"]}

    def _evaluation(self, prompt):
        types = ["RCT/experiment", "survey/correlational", "qualitative", "meta-analysis/systematic review"]
        dirs = ["positive", "mixed", "negative", "null", "not applicable"]
        items = []
        for k, sid in enumerate(re.findall(r"^<(S\d+)>", prompt, re.M)):
            n = int(sid[1:])
            items.append({"sid": sid, "relevance": 1 if n % 7 == 0 else 3, "relevant_subqs": ["Q1"],
                          "study_type": types[n % 4], "method": "온라인 실험", "sample": f"대학원생 {50 + n}명",
                          "key_finding": "생성형 AI 사용으로 글쓰기 시간이 줄었다.", "direction": dirs[n % 5],
                          "limitation": "단기 과제"})
        return {"items": items}

    def _synthesis(self, prompt):
        ids = re.findall(r"^\[(S\d+)\]", prompt, re.M)[:3] or ["S1"]
        cites = "".join(f"[{i}]" for i in ids)
        return {"answer": f"수집한 근거에 따르면 생성형 AI는 글쓰기 시간을 줄였다 {cites}.",
                "key_findings": [{"finding": f"작성 시간이 감소했다 [{ids[0]}].", "sources": ids[:1]}],
                "consensus": ["시간 절감 효과에는 대체로 동의한다."], "disagreements": ["품질 효과는 엇갈린다."],
                "evidence_strength": "moderate", "gaps": ["장기 효과 연구 부족"]}

    def _reflection(self, prompt):
        with self._lock:
            self._reflections += 1
            n = self._reflections
        cont = n <= self.continue_rounds
        return {"quality_score": 4 + n, "subq_assessment": [{"id": "Q1", "coverage": "partial", "issue": "실험 연구가 적다."}],
                "bias_risks": ["긍정적 결과에 치우칠 위험", "웹 자료 의존"], "should_continue": cont,
                "reason": f"{n}번째 검토: " + ("추가 검색이 필요하다." if cont else "충분하다."),
                "followup_queries": [{"subq_id": "Q1", "query": f"generative AI writing experiment round {n}",
                                      "tool": "search_openalex"}] if cont else [],
                "new_sub_questions": [{"question": "생성형 AI 효과는 언어 배경에 따라 다른가?", "perspective": "이질성",
                                       "rationale": "비원어민 맥락", "search_queries": ["LLM non-native English authors productivity"]}]
                if cont and n == 1 else []}

    def _verification(self, prompt):
        items = []
        for idx, claim in re.findall(r"^CLAIM (\d+): (.*)\nSOURCES:", prompt, re.M):
            ok = REVISION_MARK in claim or int(idx) % 3 != 0
            items.append({"idx": int(idx), "verdict": "supported" if ok else "partially supported",
                          "note": "초록과 일치한다." if ok else "초록에 일부만 나온다."})
        return {"items": items}

    def _repair(self, prompt):
        items = []
        for idx, claim in re.findall(r"^CLAIM (\d+): (.*)\nVERDICT:", prompt, re.M):
            if claim.startswith("| "):
                new = "| " + REVISION_MARK + " " + claim[2:]      # 표 행은 칸 수를 그대로 둔다
            else:
                new = REVISION_MARK + " " + claim
            items.append({"idx": int(idx), "revised": new})
        return {"items": items}

    def _unknown(self, prompt):
        return None

    # ── 보고서 ──
    def text(self, system, prompt, effort="medium", max_tokens=16000, stream=False, on_delta=None):
        self._track("report")
        if self.refuse_report:
            raise LLMError("refusal", "모델이 이 요청을 거절했습니다(refusal).")
        part = prompt.split("Evidence list", 1)[-1]
        ids = re.findall(r"^\[(S\d+)\]", part, re.M)
        body = self._report(ids)
        if stream and on_delta:
            for i in range(0, len(body), 200):
                on_delta(body[i:i + 200])
        return body

    @staticmethod
    def _report(ids):
        c = lambda k: ids[k % len(ids)] if ids else "S9999"
        lines = ["# 생성형 AI와 대학원생 연구 생산성: 연구 브리프", "", "## 1. 핵심 요약", "",
                 f"- 생성형 AI는 글쓰기 시간을 줄였다 [{c(0)}]. 품질도 향상되었다. [{c(1)}].",
                 f"- Noy et al. found large productivity gains in writing tasks [{c(2)}]. 효과가 없다는 연구도 있다 [S9999].",
                 "", "## 2. 주제 이해", "", "| 개념 | 정의 | 측정 |", "|---|---|---|",
                 f"| 생성형 AI | LLM 기반 도구 | 실험 조건 배정 [{c(0)}][{c(1)}] |", "", "## 3. 하위 질문별 주요 결과", ""]
        for k in range(min(len(ids), 12)):
            lines.append(f"- 연구 {k + 1}은 작성 시간이 감소했다고 보고했다 [{ids[k]}].")
        if not ids:
            lines.append("- 이 브리프를 위해 수집한 근거에서는 관련 연구를 찾지 못했다.")
        lines += ["", "## 4. 비교와 종합", "", f"연구들은 대체로 일치한다 [{c(3)}, {c(4)}].",
                  "", "## 5. 연구 공백", "", "- 장기 효과 연구가 없다.", "", "## 6. 후속 연구 방향", "", "- 종단 연구.",
                  "", "## 7. 필독 문헌", "", f"- [{c(0)}] 핵심 실험.", "", "## 8. 이 브리프의 한계", "", "- 초록만 분석했다."]
        return "\n".join(lines)

    # ── 도구 루프 ──
    def tool_turn(self, system, messages, tools, effort="low", max_tokens=8000):
        """첫 턴에는 사용 가능한 도구(OpenAlex, Semantic Scholar, 웹) 중 최대 3개를 동시에 부르고, 다음 턴에 요약으로 끝낸다."""
        self._track("tool")
        names = [t["name"] for t in tools]
        if sum(1 for m in messages if m["role"] == "assistant") == 0:
            first = messages[0]["content"]
            m = re.search(r"Suggested queries: (\[.*\])", first)
            queries = ast.literal_eval(m.group(1)) if m else []
            q = queries[0] if queries else "generative AI research productivity"
            uses = [SimpleNamespace(type="tool_use", id=f"tu_{n}_{k}", name=n, input={"query": q})
                    for k, n in enumerate(names) if n in ("search_openalex", "search_semantic_scholar", "search_web")]
            if uses:
                return _resp([_text_block("검색을 시작한다.")] + uses, "tool_use")
        return _resp([_text_block("충분한 자료를 찾았다. 장기 연구는 부족하다.")])


def make_fake_tools(fail=("search_semantic_scholar",), empty=False) -> dict:
    """검색 도구 5종의 가짜 버전 (모듈 docstring 참조)."""
    calls = []
    lock = threading.Lock()

    def paper(n, kind="peer-reviewed", origin="OpenAlex"):
        return Source(title=f"Generative AI and graduate research productivity: evidence from study {n}",
                      authors=["Jane Doe", "John Smith"], year=2022 + n % 4, venue="Journal of Higher Education",
                      abstract=(f"We study how large language models change writing productivity and research quality "
                                f"among {100 + n} graduate students. Writing time decreased and quality improved."),
                      url=f"https://doi.org/10.1000/study.{n}", doi=f"https://doi.org/10.1000/study.{n}",
                      citations=n * 3, origin=origin, kind=kind)

    def noy():
        return Source(title=NOY_TITLE, authors=["Shakked Noy", "Whitney Zhang"], year=2023, venue="Science",
                      abstract=("We examined the productivity effects of a generative artificial intelligence technology, "
                                "the assistive chatbot ChatGPT, in midlevel professional writing tasks. Time decreased by 40% "
                                "and output quality rose by 18%."),
                      url=NOY_DOI, doi=NOY_DOI, citations=2150, origin="OpenAlex", kind="peer-reviewed")

    def shared(origin):
        authors = ["Kim J", "Lee S"] if origin == "EuropePMC" else ["Jiwon Kim", "Sora Lee"]
        return Source(title="Large language models and doctoral writing quality", authors=authors, year=2024,
                      venue="Medical Education", abstract="Doctoral students using LLMs wrote higher quality drafts.",
                      url=SHARED_DOI, doi=SHARED_DOI, citations=12, origin=origin, kind="peer-reviewed")

    def base(query):
        return zlib.crc32(query.encode("utf-8")) % 900

    def openalex(query, limit=6, year_from=None, email=""):
        b = base(query)
        return [noy(), shared("OpenAlex")] + [paper(b + i) for i in range(max(0, limit - 2))]

    def europe_pmc(query, limit=6, year_from=None, email=""):
        return [shared("EuropePMC"), paper(base(query) + 500, origin="EuropePMC")]

    def arxiv(query, limit=6, year_from=None, email=""):
        return [paper(base(query) + 700, kind="preprint", origin="arXiv")]

    def semantic(query, limit=6, year_from=None, email=""):
        return [paper(base(query) + 300, origin="SemanticScholar")]

    def web(query, limit=6, year_from=None, email=""):
        def w(title, url):
            return Source(title=title, authors=[], year=None, venue="www.science.org", abstract="ChatGPT writing experiment.",
                          url=url, origin="Web", kind="web")
        return [w("Experimental evidence on the productivity effects of ... - AAAS", "https://www.science.org/a"),
                w("ExperimentalEvidenceontheProductivityEffectsof ...", "https://example.org/b"),
                w("Experimental evidence on the productivity eﬀects of generative artificial intelligence",
                  "https://example.org/c"),
                w("대학원생 생성형 AI 활용 실태 보고서", "https://example.kr/report")]

    funcs = {"search_openalex": openalex, "search_semantic_scholar": semantic, "search_arxiv": arxiv,
             "search_europe_pmc": europe_pmc, "search_web": web}

    def wrap(name, fn):
        def tool(query, limit=6, year_from=None, email=""):
            with lock:
                calls.append((name, query, limit, year_from, email))
            if name in fail:
                raise RuntimeError("요청 실패: 429 rate limited")
            return [] if empty else fn(query, limit=limit, year_from=year_from, email=email)
        tool.calls = calls
        return tool

    return {name: wrap(name, fn) for name, fn in funcs.items()}


class RecordingHooks(RunHooks):
    """이벤트·진행률·보고서 조각을 기록하는 훅 (모듈 docstring 참조)."""

    def __init__(self, plan_decisions=None, cancel_after=None):
        self.events, self.progress_calls, self.deltas, self.reviewed_plans = [], [], [], []
        self.plan_decisions = list(plan_decisions or [])
        self.cancel_after = cancel_after
        self._lock = threading.Lock()

    def emit(self, stage, kind, msg, data=None):
        with self._lock:
            self.events.append({"stage": stage, "kind": kind, "msg": msg, "data": data})

    def progress(self, stage, done, total, label=""):
        with self._lock:
            self.progress_calls.append((stage, done, total, label))

    def checkpoint(self):
        if self.cancel_after is not None and len(self.events) >= self.cancel_after:
            raise RunCancelled()

    def review_plan(self, plan):
        self.reviewed_plans.append(copy.deepcopy(plan))
        return self.plan_decisions.pop(0) if self.plan_decisions else {"action": "approve"}

    def report_delta(self, text):
        with self._lock:
            self.deltas.append(text)

    def of_kind(self, kind):
        """kind가 같은 이벤트 목록."""
        return [e for e in self.events if e["kind"] == kind]

"""Research Agent 8단계 파이프라인. 노트북 셀 ⑤의 ResearchAgent를 옮겼다.

① 주제 이해 → ② 조사 계획(+사람 검토) → ③ 자료 탐색(Tool Use 루프) → ④ 자료 평가 → ⑤ 종합(RAG)
→ ⑥ 자기 비판·재조사 → ⑦ 보고서 작성 → ⑧ 인용 검증·수정.
전체 순서는 코드가 고정하고, 검색 단계만 LLM이 자율로 도구를 고른다.
노트북 대비 변경점은 SPEC 4.5 참조(설정 객체, 이벤트 훅, 병렬 실행, 취소, 출력 언어 등).
"""
from __future__ import annotations

import json
import math
import re
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from agent.llm import LLMError, RunCancelled, friendly_error
from agent.models import CURRENT_YEAR, RunConfig
from agent.prompts import ABSTRACT_RULE, SYS_BASE
from agent.schema import A, B, E, I, O, S
from agent.sources import EvidenceStore, Source
from agent.tools import TOOL_DESC, TOOL_FUNCS, TOOL_LOCKS, TOOLS

STUDY_TYPES = ["meta-analysis/systematic review", "RCT/experiment", "quasi-experiment", "longitudinal",
               "survey/correlational", "qualitative", "mixed methods", "case study",
               "theoretical/conceptual", "review/commentary", "report/web article", "other"]
DESIGN_WEIGHT = {"meta-analysis/systematic review": 1.0, "RCT/experiment": 0.9, "quasi-experiment": 0.75,
                 "longitudinal": 0.7, "mixed methods": 0.6, "survey/correlational": 0.55, "qualitative": 0.5,
                 "case study": 0.4, "review/commentary": 0.4, "theoretical/conceptual": 0.35,
                 "report/web article": 0.25, "other": 0.3}
KIND_WEIGHT = {"peer-reviewed": 0.6, "academic": 0.45, "preprint": 0.35, "web": 0.15}
TOOL_FAIL_LIMIT = 3          # 같은 도구가 연속 3회 실패하면 이번 실행에서 제외 (예: Semantic Scholar 429 반복)
MAX_REPORT_EVIDENCE = 100    # 최종 보고서에 넘길 근거 상한 (종합에 쓴 근거는 상한과 무관하게 전부 포함)
MAX_PLAN_REVISIONS = 5       # 사람 검토에서 재계획을 요청할 수 있는 최대 횟수
REPORT_RETRIES = 2           # 보고서 스트림이 일시 오류로 끊기면 다시 작성하는 최대 횟수
RETRYABLE_CODES = {"connection": "연결 끊김", "server": "Anthropic 서버 일시 오류", "rate_limit": "속도 제한"}
VERDICTS = ["supported", "partially supported", "not in source text", "contradicted"]
STAGE_NAMES = {"understand": "① 주제 이해", "plan": "② 조사 계획", "act": "③ 자료 탐색", "evaluate": "④ 자료 평가",
               "synthesize": "⑤ 종합", "reflect": "⑥ 자기 비판", "report": "⑦ 보고서 작성", "verify": "⑧ 인용 검증"}

_CITE = re.compile(r"\[S\d+(?:\s*,\s*S\d+)*\]")
_SENT_END = re.compile(r"(?<=[.!?。])(?<!\bal\.)(?<!e\.g\.)(?<!i\.e\.)(?<!vs\.)\s+")


class _Aborted(Exception):
    """병렬 작업 중 다른 작업이 실패해 이 작업을 멈출 때 쓰는 내부 예외(바깥으로는 원래 예외가 전파된다)."""


def cited_ids(text: str) -> list[str]:
    """본문에서 [S3], [S1, S2] 형식으로 인용된 ID를 처음 나온 순서대로."""
    return list(dict.fromkeys(re.findall(r"S\d+", " ".join(_CITE.findall(text or "")))))


class RunHooks:
    """에이전트가 바깥(서버·화면)과 소통하는 통로. 기본 구현: emit은 print, 나머지는 아무것도 안 함."""

    def emit(self, stage: str, kind: str, msg: str, data: dict | None = None) -> None:
        print(f"[{stage:<10}] {msg}")

    def progress(self, stage: str, done: int, total: int, label: str = "") -> None:
        pass

    def checkpoint(self) -> None:
        """취소 요청이 있으면 RunCancelled를 던진다."""

    def review_plan(self, plan: dict) -> dict:
        """사용자가 답할 때까지 블록. {"action": "approve"} | {"action": "approve", "sub_questions": [...]}
        | {"action": "revise", "feedback": "…"}"""
        return {"action": "approve"}

    def report_delta(self, text: str) -> None:
        """보고서 스트리밍 조각."""


class ResearchAgent:
    def __init__(self, prompt: str, llm, config: RunConfig, hooks: RunHooks | None = None, tools: dict | None = None):
        self.prompt = (prompt or "").strip()
        self.topic = self.prompt              # ① 단계에서 core_topic으로 바뀐다
        self.llm = llm
        self.cfg = config
        self.hooks = hooks or RunHooks()
        self.tools = dict(tools or TOOL_FUNCS)   # {도구 이름: 함수} (테스트에서 가짜 도구 주입)
        self.store = EvidenceStore()
        self.understanding = {}
        self.plan = {}
        self.syntheses = {}
        self.reflections = []
        self.lang = "ko"
        self.year_from = None
        self.year_from_source = "agent"
        self.year_from_reason = ""
        self.tool_failures = {n: 0 for n in self.tools}
        self.disabled_tools = set()
        self.report_evidence = []
        self.report_markdown = ""
        self.verification = {}
        self.round = 1                        # 1 = 첫 조사, 2부터 재조사 라운드
        self._lock = threading.RLock()        # tool_failures · disabled_tools · syntheses · 진행률 보호
        self._abort = threading.Event()       # 병렬 작업 하나가 실패하면 설정(내부용, _map 참조)

    # ── 공용 도우미 ──
    def _stage(self, stage, status):
        name = STAGE_NAMES[stage]
        rnd = f" (라운드 {self.round})" if self.round > 1 else ""
        self.hooks.emit(stage, "stage", f"{name} {'시작' if status == 'start' else '완료'}{rnd}",
                        {"status": status, "round": self.round})

    def _json(self, system, prompt, schema, effort="medium"):
        self._checkpoint()
        return self.llm.json(system, prompt, schema, effort=effort)

    def _map(self, fn, items, stage, label):
        """items 각각에 fn을 적용해 입력 순서대로 결과를 돌려준다. cfg.parallelism개 스레드로 동시에 실행하고,
        1이면 노트북처럼 순차 실행. 작업 스레드의 예외(RunCancelled 포함)는 여기서 다시 던져진다."""
        total, done = len(items), [0]
        if total:
            self.hooks.progress(stage, 0, total, label)

        def work(x):
            out = fn(x)
            with self._lock:
                done[0] += 1
                n = done[0]
            self.hooks.progress(stage, n, total, label)
            return out

        workers = max(1, int(self.cfg.parallelism or 1))
        if workers == 1 or total <= 1:
            return [work(x) for x in items]
        first = []          # 처음 실패한 작업의 예외(이것을 다시 던진다)

        def guarded(x):
            try:
                return work(x)
            except BaseException as e:
                with self._lock:
                    if not first:
                        first.append(e)
                self._abort.set()   # 다른 작업은 다음 checkpoint에서 멈춰 유료 호출을 더 하지 않는다
                raise

        with ThreadPoolExecutor(max_workers=min(workers, total)) as ex:
            futures = [ex.submit(guarded, x) for x in items]
            try:
                return [f.result() for f in futures]
            except BaseException as e:
                err = e
                self._abort.set()
                for f in futures:
                    f.cancel()       # 아직 시작하지 않은 작업은 취소
        # with를 나오면서 실행 중이던 작업이 멈출 때까지 기다렸다
        self._abort.clear()
        raise first[0] if first else err

    def _checkpoint(self):
        """취소 확인. 병렬 작업 중 하나가 실패했으면 나머지 작업도 여기서 멈춘다."""
        if self._abort.is_set():
            raise _Aborted()
        self.hooks.checkpoint()

    def _tool_names(self):
        return [n for n in TOOL_DESC if n in self.tools] + [n for n in self.tools if n not in TOOL_DESC]

    def _lang_hint(self):
        """① 단계에서는 보고서 언어가 아직 없으므로 요청 언어로 받는다(설정이 ko/en이면 그 언어)."""
        return "the language of the request" if self.cfg.language == "auto" else f'language "{self.cfg.language}"'

    def _requirements_line(self):
        req = self.understanding.get("user_requirements") or []
        return f"User requirements to honor: {json.dumps(req, ensure_ascii=False)}\n" if req else ""

    # ── ① 주제 이해 ──
    def understand(self):
        self._stage("understand", "start")
        schema = O(language=S, topic_en=S, discipline=S, research_type=S,
                   key_concepts=A(O(term=S, english=S, synonyms=A(S))),
                   independent_variables=A(S), dependent_variables=A(S), moderators_or_context=A(S),
                   population=S, ambiguities=A(S), scope_decision=S, search_start_year=I, search_window_reason=S,
                   core_topic=S, user_requirements=A(S))
        u = self._json(SYS_BASE, f"""Analyze this user request before any searching. It may be a plain research topic or a free-form request.
User request: \"\"\"{self.prompt}\"\"\"

- language: ISO code of the request text (e.g. "ko", "en").
- core_topic: a concise title of the research topic only, extracted from the request (in the request's language).
- user_requirements: explicit requirements stated in the request about scope, period, region, methods or emphasis
  (empty list if there are none; do not invent any).
- topic_en: faithful English translation of the core topic.
- discipline / research_type (e.g. causal-effect, descriptive, comparative, methodological, design).
- key_concepts with English academic terms and synonyms useful as search keywords.
- variables (independent / dependent / moderators-context), target population.
- ambiguities: terms that can be interpreted several ways, and scope_decision: how you will scope them
  (e.g. operational definitions such as how 'quality' could be measured).
- search_start_year: earliest publication year worth searching for THIS topic (e.g. when the technology or
  phenomenon appeared, so that early foundational studies are kept). Use 0 if older foundational work matters
  and no year limit should be applied. If the request states a period explicitly, follow it.
  Current year: {CURRENT_YEAR}. search_window_reason: one sentence.
Write discipline, research_type, independent_variables, dependent_variables, moderators_or_context, population,
ambiguities, scope_decision, search_window_reason and user_requirements in {self._lang_hint()}. Keep topic_en and the English terms/synonyms of key_concepts in English.""", schema, effort="medium")
        if not u:
            raise LLMError("unknown", "주제 이해 단계 실패: 모델이 구조화된 응답을 주지 못했습니다.")
        self.understanding = u
        self.topic = (u.get("core_topic") or "").strip() or self.prompt
        self.lang = u["language"] if self.cfg.language == "auto" else self.cfg.language
        # 검색 기간은 여기 한 곳에서 정하고 모든 학술 DB 검색·포함 기준에 같은 값을 씀
        user_set = self.cfg.year_from is not None
        y = self.cfg.year_from if user_set else u["search_start_year"]
        self.year_from = y if y and 1900 < y <= CURRENT_YEAR else None
        self.year_from_source = "user" if user_set else "agent"
        self.year_from_reason = "사용자 설정" if user_set else u["search_window_reason"]
        src = "사용자 설정" if user_set else f"에이전트 판단: {u['search_window_reason'][:120]}"
        concepts = [c["english"] for c in u["key_concepts"]]
        self.hooks.emit("understand", "understanding",
                        f"분야={u['discipline']} | 유형={u['research_type']} | 개념={', '.join(concepts)}",
                        {"topic": self.topic, "discipline": u["discipline"], "research_type": u["research_type"],
                         "concepts": concepts, "requirements": u.get("user_requirements") or []})
        self.hooks.emit("understand", "window",
                        f"검색 기간: {f'{self.year_from}년 이후' if self.year_from else '제한 없음'} ({src})",
                        {"year_from": self.year_from, "source": self.year_from_source, "reason": self.year_from_reason})
        self._stage("understand", "end")

    # ── ② 계획 수립 ──
    def make_plan(self, feedback=""):
        schema = O(sub_questions=A(O(id=S, question=S, perspective=S, rationale=S,
                                     search_queries=A(S), preferred_tools=A(E(*self._tool_names())))),
                   inclusion_criteria=A(S), success_criteria=A(S))
        window = f"publications from {self.year_from} onward" if self.year_from else "no publication-year limit"
        desc = {n: TOOL_DESC.get(n, n) for n in self._tool_names()}
        p = self._json(SYS_BASE, f"""Create an investigation plan for the topic.
Topic analysis: {json.dumps(self.understanding, ensure_ascii=False)}
Search window (already applied to all academic databases): {window}
{self._requirements_line()}{f'Human reviewer feedback to incorporate: {feedback}' if feedback else ''}

Rules:
- {self.cfg.min_subq} to {self.cfg.max_subq} sub-questions with ids Q1, Q2, ... Each must cover a DIFFERENT perspective, chosen to fit THIS topic, e.g.:
  definitions/measurement, current state/adoption, empirical effects, mechanisms, moderators/context,
  risks/limitations, methodology used in prior studies.
- At least one sub-question MUST look for counter-evidence, null/negative results or risks (avoid confirmation bias).
- 2-3 search_queries per sub-question: concise English academic keyword queries (3-8 words) using synonyms.
  Add a query in the topic's language only if local/national context matters.
- preferred_tools: pick tools appropriate for the discipline. Tools: {json.dumps(desc, ensure_ascii=False)}
- inclusion_criteria: what counts as relevant evidence; any time criterion must match the search window above.
  success_criteria: when the investigation is "good enough".
Write question, perspective, rationale, inclusion_criteria and success_criteria in language "{self.lang}"
(search_queries stay as described above).""", schema, effort="medium")
        if not p:
            raise LLMError("unknown", "계획 수립 단계 실패: 모델이 구조화된 응답을 주지 못했습니다.")
        self.plan = p
        self._emit_plan(f"하위 질문 {len(p['sub_questions'])}개 수립" + (" (검토 의견 반영)" if feedback else ""),
                        revised=bool(feedback))

    def _emit_plan(self, msg, revised):
        self.hooks.emit("plan", "plan", msg, {
            "sub_questions": [{"id": q["id"], "question": q["question"], "perspective": q["perspective"]}
                              for q in self.plan["sub_questions"]], "revised": revised})

    def _user_subq(self, n, q):
        """사용자가 편집한 하위 질문을 계획 형식으로 맞춘다(id는 Q1..Qn으로 다시 매김)."""
        q = {"question": q} if isinstance(q, str) else dict(q or {})
        tools = [t for t in (q.get("preferred_tools") or []) if t in self.tools] or list(self.tools)
        return {"id": f"Q{n}", "question": str(q.get("question") or "").strip(),
                "perspective": q.get("perspective") or "user-added", "rationale": q.get("rationale") or "",
                "search_queries": [str(s) for s in (q.get("search_queries") or []) if str(s).strip()],
                "preferred_tools": tools}

    def review_plan(self):
        """사람 검토(human-in-the-loop): 승인 / 의견을 주고 재계획 / 하위 질문 목록 직접 수정."""
        if not self.cfg.human_in_the_loop:
            return
        revisions = 0
        while True:
            self.hooks.emit("plan", "plan_review", "조사 계획 검토를 기다리는 중", {"action": "waiting"})
            d = self.hooks.review_plan(self.plan) or {}
            self._checkpoint()
            action = d.get("action")
            feedback = str(d.get("feedback") or "").strip()
            if action == "revise" and revisions < MAX_PLAN_REVISIONS:
                revisions += 1           # 빈 의견도 횟수에 넣어 검토가 끝없이 반복되지 않게 한다
                if not feedback:
                    self.hooks.emit("plan", "warning", "재계획 의견이 비어 있습니다. 의견을 적거나 계획을 승인해 주세요.", None)
                    continue
                self.hooks.emit("plan", "plan_review", f"사용자 피드백 반영하여 재계획: {feedback}", {"action": "revise"})
                self.make_plan(feedback=feedback)
                continue
            if action == "revise":
                self.hooks.emit("plan", "warning", "재계획 요청 한도에 도달해 현재 계획으로 진행합니다.", None)
            sqs = d.get("sub_questions") if action == "approve" else None
            if isinstance(sqs, list):
                edited = [self._user_subq(0, q) for q in sqs]
                edited = [q for q in edited if q["question"]]
                if 1 <= len(edited) <= 8:
                    for n, q in enumerate(edited, 1):
                        q["id"] = f"Q{n}"
                    self.plan["sub_questions"] = edited
                    self.hooks.emit("plan", "plan_review", f"사용자가 하위 질문 목록을 수정함 ({len(edited)}개)",
                                    {"action": "edit"})
                    self._emit_plan(f"하위 질문 {len(edited)}개 확정 (사용자 수정)", revised=True)
                    return
                self.hooks.emit("plan", "warning", "수정한 하위 질문이 1~8개가 아니어서 원래 계획을 유지합니다.", None)
            self.hooks.emit("plan", "plan_review", "조사 계획 승인", {"action": "approve"})
            return

    # ── ③ 자료 탐색: Tool Use 루프 ──
    def _fetch(self, name, query):
        """도구 실행만 담당(스레드에서 병렬 실행). 같은 DB는 잠금으로 순차 호출해 속도 제한을 지킴."""
        self._checkpoint()
        fn = self.tools.get(name)
        unavailable = f"{name} is unavailable for the rest of this run after repeated failures"
        if fn is None:
            return None, f"unknown tool {name}"
        if name in self.disabled_tools:
            return None, unavailable
        with TOOL_LOCKS.setdefault(name, threading.Lock()):
            if name in self.disabled_tools:   # 잠금을 기다리는 사이 제외됐을 수 있음
                return None, unavailable
            try:
                return fn(query, limit=self.cfg.results_per_search, year_from=self.year_from,
                          email=self.cfg.openalex_email), None
            except Exception as e:
                return None, str(e)

    def _store_results(self, name, query, subq, results, err):
        with self._lock:
            if err is not None:
                self.hooks.emit("act", "tool_error", f"{name}('{query}') 오류: {err}",
                                {"subq": subq, "tool": name, "query": query, "error": err})
                self.tool_failures[name] = self.tool_failures.get(name, 0) + 1
                if self.tool_failures[name] >= TOOL_FAIL_LIMIT and name not in self.disabled_tools:
                    self.disabled_tools.add(name)
                    self.hooks.emit("act", "tool_disabled", f"{name} 연속 {TOOL_FAIL_LIMIT}회 실패 → 이번 실행에서 제외",
                                    {"tool": name})
                return f"ERROR: {err}. Try another tool or query.", True
            self.tool_failures[name] = 0
            lines = []
            for src in results:
                try:
                    s = self.store.add(src, query=query, subq=subq)
                except Exception as e:
                    self.hooks.emit("act", "warning", f"결과 1건 건너뜀: {e}", None)
                    continue
                if s:
                    lines.append(f"[{s.sid}] {s.short_cite()} {s.title} | {s.venue} | cites={s.citations} | {s.kind}\n"
                                 f"     {(s.abstract or 'no abstract')[:220]}")
            self.hooks.emit("act", "tool", f"{subq} · {name}('{query}') → {len(results)}건 (누적 {len(self.store)})",
                            {"subq": subq, "tool": name, "query": query, "count": len(results), "total": len(self.store)})
            return ("\n".join(lines) or "No results. Try broader or different keywords."), False

    def _run_tools(self, calls):
        """calls=[(도구, 검색어, 하위질문)]: 서로 다른 DB는 동시에 실행하고, 결과는 요청 순서대로 저장소에 넣음."""
        if not calls:
            return []
        with ThreadPoolExecutor(max_workers=max(1, len(self.tools))) as ex:
            fetched = list(ex.map(lambda c: self._fetch(c[0], c[1]), calls))
        return [self._store_results(n, q, sq, *f) for (n, q, sq), f in zip(calls, fetched)]

    def _subq_sids(self, qid):
        return {s.sid for s in self.store.sources() if qid in s.subqs}

    def investigate(self, sq):
        before = self._subq_sids(sq["id"])
        tools = [t for t in TOOLS if t["name"] in self.tools and t["name"] not in self.disabled_tools]
        system = (SYS_BASE + " You are the SEARCH EXECUTOR. Use the search tools to collect evidence for ONE sub-question. "
                  "Look at each result list, then decide: refine keywords, switch database, or stop. "
                  "Aim for 6-12 clearly relevant, diverse sources (empirical studies, reviews, and counter-evidence). "
                  "When enough evidence is collected, stop calling tools and reply with a 2-3 sentence summary of what you found and what is missing. "
                  f'Write that summary in language "{self.lang}".')
        msgs = [{"role": "user", "content":
                 f"Main topic: {self.understanding['topic_en']}\nSub-question {sq['id']}: {sq['question']}\n"
                 f"Perspective: {sq.get('perspective', '')}\nSuggested queries: {sq.get('search_queries') or []}\n"
                 f"Suggested tools: {sq.get('preferred_tools') or []}\nYou may run several searches at once (they run in parallel)."}]
        summary = ""
        for _ in range(self.cfg.max_tool_steps if tools else 0):
            self._checkpoint()
            resp = self.llm.tool_turn(system, msgs, tools)
            content = self.llm.echo_content(resp)
            msgs.append({"role": "assistant", "content": content})   # 대화 기록은 덧붙이기만 한다
            uses = [b for b in content if getattr(b, "type", "") == "tool_use"]
            if resp.stop_reason != "tool_use" or not uses:
                summary = self.llm.text_of(resp)
                break
            outs = self._run_tools([(u.name, (u.input or {}).get("query", ""), sq["id"]) for u in uses])
            msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": u.id, "content": out, "is_error": err}
                                                     for u, (out, err) in zip(uses, outs)]})
        got = lambda: self._subq_sids(sq["id"]) - before
        if len(got()) < 3 and "search_openalex" in self.tools:  # 안전장치: 도구 루프가 자료를 거의 못 찾으면 결정적 검색으로 보강
            self.hooks.emit("act", "log", f"{sq['id']} 수집 부족({len(got())}건) → 기본 검색으로 보강", None)
            self._run_tools([("search_openalex", q, sq["id"]) for q in (sq.get("search_queries") or [])[:2]])
        n = len(got())
        self.hooks.emit("act", "subq_done", f"{sq['id']} 탐색 완료: 관련 후보 {n}건. {summary[:150]}",
                        {"subq": sq["id"], "found": n, "summary": summary[:150]})

    def investigate_all(self, sqs):
        self._map(self.investigate, list(sqs), "act", "하위 질문 탐색")

    # ── ④ 자료 평가 ──
    @staticmethod
    def _credibility(s: Source):
        c = KIND_WEIGHT.get(s.kind, 0.3)
        c += min(math.log10((s.citations or 0) + 1) / 3, 1) * 0.3   # 피인용 1000회 ≈ +0.3
        if s.year:
            c += 0.1 if s.year >= CURRENT_YEAR - 5 else 0.05 if s.year >= CURRENT_YEAR - 10 else 0
        return round(min(c, 1.0), 2)

    def evaluate(self, batch_size=8):
        self._stage("evaluate", "start")
        todo = [s for s in self.store.sources() if not s.evaluated]
        if todo:
            self._evaluate(todo, batch_size)
        self._stage("evaluate", "end")

    def _evaluate(self, todo, batch_size):
        subqs = "\n".join(f"{q['id']}: {q['question']}" for q in self.plan["sub_questions"])
        schema = O(items=A(O(sid=S, relevance=I, relevant_subqs=A(S), study_type=E(*STUDY_TYPES),
                             method=S, sample=S, key_finding=S,
                             direction=E("positive", "negative", "mixed", "null", "not applicable"),
                             limitation=S)))

        def run_batch(batch):
            docs = "\n\n".join(f"<{s.sid}> {s.title} ({s.year}, {s.venue}, {s.kind})\n{(s.abstract or 'NO ABSTRACT')[:1200]}"
                               for s in batch)
            return self._json(SYS_BASE, f"""Evaluate each source for the research topic using ONLY its title/abstract.
{ABSTRACT_RULE}
Topic: {self.understanding['topic_en']}
Sub-questions:
{subqs}
Inclusion criteria: {self.plan['inclusion_criteria']}

For every source return:
- relevance: 0=unrelated, 1=tangential, 2=relevant, 3=directly answers a sub-question
- relevant_subqs: ids it informs
- study_type, method (design/analysis, short), sample (who/how many; if absent write that it is not stated in the abstract)
- key_finding: one sentence with the main result as stated (include numbers/effect sizes only if present in the text;
  if the abstract gives no result, say so)
- direction: of the effect relative to the topic's main hypothesis
- limitation: main weakness visible from the abstract
Write method/sample/key_finding/limitation in {self.lang}.

Sources:
{docs}""", schema, effort="low")

        batches = [todo[i:i + batch_size] for i in range(0, len(todo), batch_size)]
        results = self._map(run_batch, batches, "evaluate", "자료 평가")
        for batch, res in zip(batches, results):     # 결과는 배치 순서대로 반영(순차 실행과 같은 결과)
            by_id = {r["sid"].strip("<>"): r for r in (res or {}).get("items", [])}
            for s in batch:
                r = by_id.get(s.sid)
                s.evaluated = True
                s.credibility = self._credibility(s)
                if not r:
                    continue
                s.relevance = max(0, min(3, r["relevance"]))
                s.subqs.update(q for q in r["relevant_subqs"] if q)
                s.study_type, s.method, s.sample = r["study_type"], r["method"], r["sample"]
                s.key_finding, s.direction, s.limitation = r["key_finding"], r["direction"], r["limitation"]
                s.score = round(0.55 * s.relevance / 3 + 0.30 * s.credibility
                                + 0.15 * DESIGN_WEIGHT.get(s.study_type, 0.3), 3)
        inc = self.store.included()
        self.hooks.emit("evaluate", "evaluate",
                        f"평가 {len(todo)}건 → 채택(관련성≥2) 누적 {len(inc)}건 / 전체 {len(self.store)}건 "
                        f"(중복 판본 병합 누적 {self.store.merged}건)",
                        {"evaluated": len(todo), "included": len(inc), "total": len(self.store), "merged": self.store.merged})

    # ── ⑤ 종합 (RAG) ──
    def retrieve(self, sq, k=10):
        """하위 질문별 근거 검색: TF-IDF 유사도 + 평가 점수 + 하위질문 태그 가중."""
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
        pool = self.store.included()
        if not pool:
            return []
        docs = [f"{s.title} {s.abstract} {s.key_finding}" for s in pool]
        queries = list(sq.get("search_queries") or [])
        if not queries:
            # 사용자가 추가한 하위 질문은 검색어가 없고 질문은 보고서 언어라 영어 어휘가 없을 수 있다
            # → 이 하위 질문으로 태그된 자료를 실제로 찾아낸 검색어를 쓴다(중복 제거, 최대 8개).
            found = dict.fromkeys(q for s in self.store.sources() if sq["id"] in s.subqs
                                  for q in sorted(s.queries) if str(q).strip())
            queries = list(found)[:8]
        query = sq["question"] + " " + " ".join(queries)
        try:
            vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True).fit(docs + [query])
            sims = cosine_similarity(vec.transform([query]), vec.transform(docs))[0]
        except ValueError:   # 어휘가 비어 있는 극단적인 경우 → 점수만으로 순위
            sims = [0.0] * len(pool)
        top = max(sims) or 1
        ranked = sorted(zip(pool, sims), key=lambda x: -(0.45 * x[1] / top + 0.35 * x[0].score
                                                          + (0.2 if sq["id"] in x[0].subqs else 0)))
        return [s for s, _ in ranked[:k]]

    def _synthesize_one(self, sq):
        """하위 질문 1개 종합 → 종합 dict 또는 None(실패). 결과 반영은 호출부가 입력 순서대로 한다."""
        ev = self.retrieve(sq)
        if not ev:
            self.hooks.emit("synthesize", "synthesis", f"{sq['id']} 종합: 관련 근거 없음",
                            {"subq": sq["id"], "n": 0, "strength": "insufficient"})
            ko = self.lang == "ko"     # 보고서 언어에 맞춘다(한국어가 아니면 영어)
            return {"answer": "근거 없음" if ko else "No evidence found.", "key_findings": [], "consensus": [],
                    "disagreements": [], "evidence_strength": "insufficient",
                    "gaps": ["관련 문헌을 찾지 못함" if ko else "No relevant literature was found."], "sources": []}
        ctx = "\n\n".join(f"[{s.sid}] {s.short_cite()} | {s.kind} | {s.study_type} | {s.method} | sample: {s.sample} | "
                          f"direction: {s.direction} | credibility {s.credibility}\nTitle: {s.title}\n"
                          f"Finding: {s.key_finding}\nAbstract: {(s.abstract or '')[:700]}" for s in ev)
        schema = O(answer=S, key_findings=A(O(finding=S, sources=A(S))), consensus=A(S), disagreements=A(S),
                   evidence_strength=E("strong", "moderate", "weak", "insufficient"), gaps=A(S))
        out = self._json(SYS_BASE, f"""Answer the sub-question using ONLY the evidence below. Cite every claim with source ids like [S3].
{ABSTRACT_RULE}
Sub-question {sq['id']}: {sq['question']}

Evidence:
{ctx}

- answer: 1 concise paragraph.
- key_findings: 3-6 items, each with the supporting source ids.
- consensus / disagreements: where studies agree or conflict, and WHY they might differ (design, sample, context, measurement).
- evidence_strength: judge by quantity, design quality and consistency. Several copies/versions of one study count as ONE study.
- gaps: what this evidence cannot answer.
Write in language "{self.lang}".""", schema, effort="medium")
        if out:
            out["sources"] = [s.sid for s in ev]
            self.hooks.emit("synthesize", "synthesis", f"{sq['id']} 종합 완료 (근거 {len(ev)}건, 강도={out['evidence_strength']})",
                            {"subq": sq["id"], "n": len(ev), "strength": out["evidence_strength"]})
        return out

    def synthesize_all(self, sqs):
        self._stage("synthesize", "start")
        sqs = list(sqs)
        for sq, out in zip(sqs, self._map(self._synthesize_one, sqs, "synthesize", "하위 질문 종합")):
            if out:
                with self._lock:
                    self.syntheses[sq["id"]] = out
        self._stage("synthesize", "end")

    # ── ⑥ 자기 비판 & 재계획 ──
    def _counts(self, inc, key):
        return dict(Counter(getattr(s, key) for s in inc).most_common())

    def _evidence_stats(self):
        """비평·보고서 프롬프트에 넣는 근거 통계 (노트북 형식)."""
        inc = self.store.included()
        years = [s.year for s in inc if s.year]
        return {"total_collected": len(self.store), "included": len(inc), "duplicates_merged": self.store.merged,
                "search_window_from": self.year_from, "unavailable_tools": sorted(self.disabled_tools),
                "by_kind": self._counts(inc, "kind"), "by_study_type": self._counts(inc, "study_type"),
                "by_direction": self._counts(inc, "direction"),
                "year_range": [min(years), max(years)] if years else None,
                "per_subq": {q["id"]: sum(1 for s in inc if q["id"] in s.subqs) for q in self.plan.get("sub_questions", [])}}

    def stats(self) -> dict:
        """result.json의 stats: 채택 문헌 기준 통계 + 연도별 분포."""
        st = self._evidence_stats()
        inc = self.store.included()
        by_year = Counter(s.year for s in inc if s.year)
        return {"total_collected": st["total_collected"], "included": st["included"],
                "duplicates_merged": st["duplicates_merged"], "by_kind": st["by_kind"],
                "by_study_type": st["by_study_type"], "by_direction": st["by_direction"],
                "by_year": {str(y): by_year[y] for y in sorted(by_year)}, "year_range": st["year_range"],
                "per_subq": st["per_subq"]}

    def reflect(self, round_no, final=False):
        self._stage("reflect", "start")
        summary = {qid: {"answer": v["answer"][:600], "strength": v["evidence_strength"], "gaps": v["gaps"]}
                   for qid, v in self.syntheses.items()}
        history = [{"round": i + 1, "quality": r["quality_score"], "searched": [f["query"] for f in r["followup_queries"]],
                    "added_questions": [q["question"] for q in r["new_sub_questions"]]} for i, r in enumerate(self.reflections)]
        if final:
            budget = ("This is the FINAL check after the last search round: no more searching is possible. "
                      "Set should_continue=false, leave followup lists empty, and list the issues the final report must disclose.")
        else:
            left = self.cfg.max_reflection_rounds - round_no + 1
            budget = (f"Search rounds still available: {left} (including the one that runs right after this review if you continue). "
                      "Do not stop merely because of the round number; decide only on whether more searching would materially improve the result.")
        schema = O(quality_score=I, subq_assessment=A(O(id=S, coverage=E("good", "partial", "poor"), issue=S)),
                   bias_risks=A(S), should_continue=B, reason=S,
                   followup_queries=A(O(subq_id=S, query=S, tool=E(*self._tool_names()))),
                   new_sub_questions=A(O(question=S, perspective=S, rationale=S, search_queries=A(S))))
        r = self._json(SYS_BASE + " You are now the CRITIC reviewing the research so far.", f"""Critically review the investigation.
Topic: {self.understanding['topic_en']}
Plan: {json.dumps(self.plan['sub_questions'], ensure_ascii=False)}
Success criteria: {self.plan['success_criteria']}
Current syntheses: {json.dumps(summary, ensure_ascii=False)}
Evidence statistics: {json.dumps(self._evidence_stats(), ensure_ascii=False)}
Previous critic rounds (do not repeat the same searches): {json.dumps(history, ensure_ascii=False)}
{budget}

Check: coverage of each sub-question, one-sided evidence (e.g. only positive results), over-reliance on weak/old/web sources,
missing perspectives, missing study designs, duplicated versions of one study counted as several. quality_score 1-10.
should_continue=true ONLY if additional searching is likely to materially improve the result.
If continuing: up to 4 followup_queries (concise English keywords, choose the best tool; avoid unavailable_tools) and up to 2
new_sub_questions for important uncovered angles (leave lists empty otherwise).
Write reason, bias_risks, the subq_assessment issues and the question/perspective/rationale of new_sub_questions
in language "{self.lang}". Keep followup queries and search_queries in English.""", schema, effort="medium")
        if not r:
            self._stage("reflect", "end")
            return False
        if final:
            r.update(should_continue=False, followup_queries=[], new_sub_questions=[])
        r = {"round": round_no, "final": final, **r}
        self.reflections.append(r)
        label = "최종 점검" if final else f"라운드 {round_no}"
        self.hooks.emit("reflect", "reflection",
                        f"{label}: 품질 {r['quality_score']}/10, 계속={r['should_continue']} — {r['reason'][:150]}",
                        {"round": round_no, "final": final, "quality_score": r["quality_score"],
                         "should_continue": r["should_continue"], "reason": r["reason"], "bias_risks": r["bias_risks"]})
        self._stage("reflect", "end")
        return r["should_continue"]

    def replan_and_act(self, r):
        self.round += 1
        self._stage("act", "start")
        known = {q["id"] for q in self.plan["sub_questions"]}
        calls = [(fq["tool"], fq["query"], fq["subq_id"]) for fq in r["followup_queries"][:4]
                 if fq["subq_id"] in known and fq["tool"] in self.tools]
        if calls:
            self.hooks.emit("reflect", "replan", f"추가 검색 {len(calls)}건: " + "; ".join(q for _, q, _ in calls),
                            {"queries": [q for _, q, _ in calls]})
        self._run_tools(calls)
        affected = {sq for _, _, sq in calls}
        new_sqs = []
        for nq in r["new_sub_questions"][:2]:
            sq = {"id": f"Q{len(self.plan['sub_questions']) + 1}", "preferred_tools": list(self.tools), **nq}
            self.plan["sub_questions"].append(sq)
            self.hooks.emit("reflect", "replan", f"새 하위 질문 추가 {sq['id']}: {sq['question']}",
                            {"subq": sq["id"], "question": sq["question"]})
            new_sqs.append(sq)
            affected.add(sq["id"])
        self.investigate_all(new_sqs)
        self._stage("act", "end")
        self.evaluate()
        self.synthesize_all([sq for sq in self.plan["sub_questions"] if sq["id"] in affected])

    # ── ⑦ 최종 보고서 ──
    def _report_evidence(self):
        """보고서에 넘길 근거: 하위 질문 종합이 다룬 문헌은 전부 + 남는 자리는 점수순.
        (점수 상위만 넘기면 종합에서 쓴 문헌이 빠져 '근거 없음'으로 잘못 결론 낼 수 있음)"""
        inc = self.store.included()
        used = {i for v in self.syntheses.values() for i in re.findall(r"S\d+", json.dumps(v))}
        must = [s for s in inc if s.sid in used]
        rest = [s for s in inc if s.sid not in used][:max(0, MAX_REPORT_EVIDENCE - len(must))]
        return sorted(must + rest, key=lambda s: -s.score), len(must)

    def write_report(self):
        self._stage("report", "start")
        self.report_evidence, n_used = self._report_evidence()
        evidence = "\n".join(f"[{s.sid}] {s.short_cite()} | {s.kind} | {s.study_type} | sample: {s.sample} | {s.direction} | {s.key_finding}"
                             for s in self.report_evidence)
        self.hooks.emit("report", "report",
                        f"보고서 근거 {len(self.report_evidence)}건 전달 (종합에서 다룬 {n_used}건 전부 포함, 채택 {len(self.store.included())}건 중)",
                        {"evidence": len(self.report_evidence), "used": n_used})
        critic = self.reflections[-1] if self.reflections else {}

        def on_delta(t):
            self.hooks.report_delta(t)
            self._checkpoint()

        system = SYS_BASE + " You are now the LEAD RESEARCHER writing the final research brief."
        prompt = f"""Write the final research brief in Markdown, in language "{self.lang}" (headings too).
Cite with source ids like [S3] ONLY from the evidence list. Do not add a reference list (it is appended automatically).
Rules:
- Put each citation inside the sentence it supports, before the final period: "... increased [S3]." (not "... increased. [S3]").
- Before claiming that evidence is absent or that only N studies exist, check the FULL evidence list, and phrase it as
  "in the evidence collected for this brief".
- {ABSTRACT_RULE}
- Several versions/copies of the same study (preprint, publisher page, repository) count as ONE study.

Topic: {self.topic}
{self._requirements_line()}Topic analysis: {json.dumps(self.understanding, ensure_ascii=False)}
Sub-question syntheses: {json.dumps(self.syntheses, ensure_ascii=False)}
Critic's last review: {json.dumps(critic, ensure_ascii=False)}
Evidence statistics: {json.dumps(self._evidence_stats(), ensure_ascii=False)}
Evidence list ({len(self.report_evidence)} sources):
{evidence}

Required sections (use ## headings, numbered):
1. Executive summary — 5 bullet points a busy researcher must know.
2. Topic understanding — key concepts, operational definitions, variables, scope (including the search window).
3. Key findings by sub-question — with evidence strength labels.
4. Comparison & synthesis — where studies agree/conflict and why (design, sample, context, measurement differences).
5. Research gaps — concrete and specific (population, method, measurement, context, time horizon), each tied to evidence.
6. Future research directions — 3 proposed studies, each with research question, hypotheses, design, sample,
   variables & measurement instruments, analysis method, expected contribution.
7. Must-read papers — top 5 sources to read first and why.
8. Limitations of this brief — evidence quality, coverage, abstract-only analysis."""
        for attempt in range(REPORT_RETRIES + 1):
            self._checkpoint()
            try:
                body = self.llm.text(system, prompt, effort="high", max_tokens=64000, stream=True, on_delta=on_delta)
                break
            except (RunCancelled, _Aborted):
                raise
            except Exception as e:
                # 몇 분짜리 스트림이 일시 오류(연결 끊김·서버 과부하·속도 제한)로 끊기면 처음부터 다시 쓴다
                code = friendly_error(e).code
                if attempt >= REPORT_RETRIES or code not in RETRYABLE_CODES:
                    raise
                self.hooks.emit("report", "warning",
                                f"보고서 작성 중 {RETRYABLE_CODES[code]} 오류가 발생해 보고서를 처음부터 다시 작성합니다 "
                                f"(재시도 {attempt + 1}/{REPORT_RETRIES}).", {"code": code, "attempt": attempt + 1})
                self._stage("report", "start")     # 서버가 미리보기 버퍼를 비운다
        self.hooks.emit("report", "report", f"최종 보고서 작성 완료 ({len(body)}자)", {"chars": len(body)})
        self._stage("report", "end")
        return body

    # ── ⑧ 인용 검증 → 수정 → 재검증 ──
    @staticmethod
    def _claim_spans(report):
        """보고서를 '주장 + 인용' 단위의 (시작, 끝) 위치로 나눔. 표는 행 전체, 본문은 문장 단위이고,
        인용 번호만 남은 조각(예: '... 증가했다. [S3].')은 앞 문장에 붙여 주장 없이 번호만 검사하는 일을 막음."""
        spans, pos = [], 0
        for line in report.split("\n"):
            start, end = pos, pos + len(line)
            pos = end + 1
            if not _CITE.search(line):
                continue
            if line.lstrip().startswith("|"):
                spans.append((start, end))
                continue
            segs, a = [], start
            for m in _SENT_END.finditer(line):
                segs.append((a, start + m.start()))
                a = start + m.end()
            segs.append((a, end))
            merged = []
            for a, b in segs:
                core = re.sub(r"[\W_]", "", _CITE.sub("", report[a:b]))
                if merged and len(core) < 2:
                    merged[-1] = (merged[-1][0], b)
                else:
                    merged.append((a, b))
            spans += [(a, b) for a, b in merged if _CITE.search(report[a:b])]
        return spans

    def _sources_text(self, claim):
        out = []
        for i in dict.fromkeys(re.findall(r"S\d+", " ".join(_CITE.findall(claim)))):
            s = self.store.items.get(i)
            if s and len(out) < 5:
                out.append(f"  [{s.sid}] {s.title} ({s.year or 'n.d.'}, {s.kind})\n  ABSTRACT: {(s.abstract or 'NO ABSTRACT')[:3000]}")
        return "\n".join(out)

    def _check(self, claims):
        """claims=[주장 문장] → [(판정, 메모)]. 인용된 문헌의 초록 전문과 대조."""
        blocks = [f"CLAIM {n}: {c}\nSOURCES:\n{self._sources_text(c)}" for n, c in enumerate(claims)]
        schema = O(items=A(O(idx=I, verdict=E(*VERDICTS), note=S)))
        res = self._json(SYS_BASE + " You are a strict FACT-CHECKER.", f"""For each claim, judge whether the cited sources' text supports it.
- supported / partially supported / not in source text (the abstract does not say it) / contradicted (the abstract says otherwise).
- Judge only what the claim attributes to the cited sources. Statements about how many studies exist in this brief's
  evidence base (e.g. "the only RCT") and the author's own definitions or table labels are not judged against the source.
- In a table row, judge only the cells that carry citations.
Write note in {self.lang} (one short sentence).

""" + "\n\n".join(blocks), schema, effort="low")
        got = {it["idx"]: (it["verdict"], it["note"]) for it in (res or {}).get("items", []) if 0 <= it["idx"] < len(claims)}
        return [got.get(n) for n in range(len(claims))]

    def _repair(self, items):
        """근거가 부족한 문장을 인용 문헌이 실제로 말하는 범위로 고쳐 씀 → {번호: 수정문}."""
        blocks = [f"CLAIM {n}: {c['claim']}\nVERDICT: {c['verdict']} — {c['note']}\nSOURCES:\n{self._sources_text(c['claim'])}"
                  for n, c in enumerate(items)]
        res = self._json(SYS_BASE + " You are the EDITOR fixing unsupported statements.", f"""Rewrite each claim so that it states only what its cited sources' text supports.
- Keep the citation ids and the Markdown form: a table row stays one table row with the same number of cells,
  a list item stays a list item, and nothing spans multiple lines.
- {ABSTRACT_RULE}
- If a point cannot be supported, soften it (e.g. "suggests", "in one study") or drop that part; do not add new facts.
Write in language "{self.lang}".

""" + "\n\n".join(blocks), O(items=A(O(idx=I, revised=S))), effort="medium")
        return {it["idx"]: it["revised"].strip() for it in (res or {}).get("items", []) if 0 <= it["idx"] < len(items)}

    def _valid_revision(self, old, new):
        if not new or "\n" in new or not _CITE.search(new):
            return False
        if any(i not in self.store.items for i in re.findall(r"S\d+", " ".join(_CITE.findall(new)))):
            return False
        if old.lstrip().startswith("|"):
            return new.startswith("|") and new.count("|") == old.strip().count("|")
        return True

    def verify(self, report):
        self._stage("verify", "start")
        sample = self.cfg.verify_sample
        ids = set(re.findall(r"S\d+", " ".join(_CITE.findall(report))))
        unknown = sorted(i for i in ids if i not in self.store.items)
        for u in unknown:  # 존재하지 않는 인용 제거
            report = re.sub(rf"\b{u}\b", "?", report)
        spans = self._claim_spans(report)
        picked = spans[:: max(1, len(spans) // sample)][:sample] if sample > 0 else []
        result = {"cited_ids": len(ids), "unknown_ids": unknown, "claims_total": len(spans), "checks": []}
        if not picked:
            self.hooks.emit("verify", "verify", f"인용 ID {len(ids)}개, 미존재 {len(unknown)}개, 검증할 인용 문장 없음",
                            {"cited_ids": len(ids), "unknown": len(unknown), "checked": 0, "supported": 0})
            self._stage("verify", "end")
            return report, result
        claims = [report[a:b].strip() for a, b in picked]
        for (a, b), c, v in zip(picked, claims, self._check(claims)):
            if v:
                result["checks"].append({"span": (a, b), "claim": c, "verdict": v[0], "note": v[1]})
        ok = sum(c["verdict"] == "supported" for c in result["checks"])
        self.hooks.emit("verify", "verify",
                        f"인용 ID {len(ids)}개, 미존재 {len(unknown)}개, 표본 {len(result['checks'])}문장 중 완전 지지 {ok}",
                        {"cited_ids": len(ids), "unknown": len(unknown), "checked": len(result["checks"]), "supported": ok})

        # 수정(Self-correction): 완전 지지가 아닌 문장만 근거 범위로 고쳐 쓰고 다시 검증
        bad = [c for c in result["checks"] if c["verdict"] != "supported"]
        if bad:
            revised = self._repair(bad)
            fixes = [(c, revised[n]) for n, c in enumerate(bad) if self._valid_revision(c["claim"], revised.get(n))]
            for (c, new), v in zip(fixes, self._check([new for _, new in fixes]) if fixes else []):
                c["revised"] = new
                c["verdict_after"], c["note_after"] = v if v else ("not checked", "")
            for c, new in sorted(fixes, key=lambda x: -x[0]["span"][0]):  # 뒤에서부터 바꿔야 앞의 위치가 유지됨
                a, b = c["span"]
                lead = report[a:b][:len(report[a:b]) - len(report[a:b].lstrip())]
                report = report[:a] + lead + new + report[b:]
            ok2 = sum((c.get("verdict_after") or c["verdict"]) == "supported" for c in result["checks"])
            self.hooks.emit("verify", "repair",
                            f"미지지·부분지지 {len(bad)}문장 중 {len(fixes)}문장 수정 → 재검증 후 완전 지지 {ok2}/{len(result['checks'])}",
                            {"bad": len(bad), "fixed": len(fixes), "supported_after": ok2, "checked": len(result["checks"])})
        for c in result["checks"]:
            c.pop("span", None)
        self._stage("verify", "end")
        return report, result

    # ── 실행 ──
    def run(self) -> dict:
        self.hooks.emit("system", "log", f"연구 주제: {self.prompt}", None)
        self.understand()
        self._stage("plan", "start")
        self.make_plan()
        self.review_plan()
        self._stage("plan", "end")
        self._stage("act", "start")
        self.investigate_all(self.plan["sub_questions"])
        self._stage("act", "end")
        self.evaluate()
        self.synthesize_all(self.plan["sub_questions"])
        rounds = self.cfg.max_reflection_rounds
        for rnd in range(1, rounds + 1):
            if not self.reflect(rnd):
                break
            self.replan_and_act(self.reflections[-1])
        else:
            self.reflect(rounds + 1, final=True)  # 마지막 추가 조사 이후 상태를 한 번 더 평가
        self.report_markdown, self.verification = self.verify(self.write_report())
        return self.to_result()

    def to_result(self) -> dict:
        """result.json(SPEC 3.2)에서 id·meta·trace·schema_version을 뺀 부분 + 기간·도구·집계 정보."""
        included = {s.sid for s in self.store.included()}
        in_report = {s.sid for s in self.report_evidence}
        cited = set(cited_ids(self.report_markdown))
        sources = []
        for s in self.store.sources():
            d = s.to_dict()
            d.update(included=s.sid in included, in_report=s.sid in in_report, cited=s.sid in cited)
            sources.append(d)
        return {
            "prompt": self.prompt, "topic": self.topic, "lang": self.lang,
            "understanding": self.understanding, "plan": self.plan, "syntheses": self.syntheses,
            "reflections": self.reflections, "report_markdown": self.report_markdown,
            "verification": self.verification, "stats": self.stats(), "sources": sources,
            "year_from": self.year_from, "year_from_source": self.year_from_source,
            "year_from_reason": self.year_from_reason, "disabled_tools": sorted(self.disabled_tools),
            "counts": {"collected": len(self.store), "included": len(included), "merged": self.store.merged,
                       "report_evidence": len(self.report_evidence),
                       "sub_questions": len(self.plan.get("sub_questions", []))},
        }

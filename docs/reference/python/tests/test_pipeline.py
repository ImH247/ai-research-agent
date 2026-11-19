from _samples import PROJECT_ROOT, load_sample, SAMPLE_IDS  # noqa: F401

import re
import threading
import time
import unittest
from dataclasses import replace
from unittest import mock

from agent.llm import LLMError, RunCancelled
from agent.models import RunConfig
from agent.pipeline import STAGE_NAMES, ResearchAgent, _CITE
from fakes import FakeLLM, RecordingHooks, make_fake_tools

BASE = RunConfig(min_subq=4, max_subq=6, max_reflection_rounds=2, max_tool_steps=3, results_per_search=6,
                 verify_sample=10, parallelism=1)


def run_agent(cfg=BASE, llm=None, hooks=None, tools=None, prompt="생성형 AI 활용이 대학원생의 연구 생산성에 미치는 영향"):
    hooks = hooks or RecordingHooks()
    tools = tools or make_fake_tools()
    agent = ResearchAgent(prompt, llm or FakeLLM(), cfg, hooks, tools)
    return agent, agent.run(), hooks, tools


class FullRunTest(unittest.TestCase):
    def check_result(self, r, hooks):
        types = {"prompt": str, "topic": str, "lang": str, "understanding": dict, "plan": dict, "syntheses": dict,
                 "reflections": list, "report_markdown": str, "verification": dict, "stats": dict, "sources": list,
                 "year_from_source": str, "year_from_reason": str, "disabled_tools": list, "counts": dict}
        for k, t in types.items():
            self.assertIsInstance(r[k], t, k)
        self.assertIn("year_from", r)
        self.assertEqual(r["topic"], "생성형 AI와 대학원생 연구 생산성")       # core_topic
        self.assertEqual(set(r["counts"]), {"collected", "included", "merged", "report_evidence", "sub_questions"})
        for k in ("total_collected", "included", "duplicates_merged", "by_kind", "by_study_type", "by_direction",
                  "by_year", "year_range", "per_subq"):
            self.assertIn(k, r["stats"])
        # 수집 문헌 전부, S 번호순, 계산된 플래그 포함
        sids = [s["sid"] for s in r["sources"]]
        self.assertEqual(sids, [f"S{i}" for i in range(1, len(sids) + 1)])
        self.assertEqual(len(sids), r["counts"]["collected"])
        for s in r["sources"]:
            for k in ("included", "in_report", "cited"):
                self.assertIsInstance(s[k], bool)
            self.assertIsInstance(s["queries"], list)
            self.assertIsInstance(s["subqs"], list)
        self.assertEqual(sum(s["included"] for s in r["sources"]), r["counts"]["included"])
        self.assertEqual(sum(s["in_report"] for s in r["sources"]), r["counts"]["report_evidence"])
        self.assertTrue(any(s["cited"] for s in r["sources"]))
        # 본문에 인용된 ID는 모두 실재하고, 지어낸 ID는 제거됨
        cited = set(re.findall(r"S\d+", " ".join(_CITE.findall(r["report_markdown"]))))
        self.assertTrue(cited)
        self.assertTrue(cited <= set(sids))
        self.assertNotIn("S9999", r["report_markdown"])
        v = r["verification"]
        self.assertEqual(v["unknown_ids"], ["S9999"])
        self.assertTrue(v["checks"])
        self.assertTrue(any("revised" in c and c["verdict_after"] == "supported" for c in v["checks"]))
        for c in v["checks"]:
            self.assertNotIn("span", c)
            self.assertIn(c["verdict"], ("supported", "partially supported", "not in source text", "contradicted"))
        for i, ref in enumerate(r["reflections"], 1):
            self.assertEqual(ref["round"], i)
            self.assertIsInstance(ref["final"], bool)
        # 8단계 전부 시작 이벤트
        started = {e["stage"] for e in hooks.of_kind("stage") if e["data"]["status"] == "start"}
        self.assertEqual(started, set(STAGE_NAMES))
        self.assertTrue(hooks.deltas)
        self.assertEqual("".join(hooks.deltas).count("[S9999]"), 1)   # 스트리밍된 원문에는 아직 있음
        self.assertTrue(any(p[0] == "act" and p[1] == p[2] for p in hooks.progress_calls))

    def test_sequential(self):
        _, r, hooks, _ = run_agent()
        self.check_result(r, hooks)
        msgs = [e["msg"] for e in hooks.events]
        self.assertTrue(any(re.match(r"Q1 · search_openalex\('.+'\) → \d+건 \(누적 \d+\)", m) for m in msgs))
        self.assertTrue(any(re.match(r"평가 \d+건 → 채택\(관련성≥2\) 누적 \d+건 / 전체 \d+건 \(중복 판본 병합 누적 \d+건\)", m)
                            for m in msgs))
        self.assertTrue(any(m.startswith("라운드 1: 품질 ") for m in msgs))
        self.assertTrue(any(re.match(r"최종 보고서 작성 완료 \(\d+자\)", m) for m in msgs))

    def test_parallel_same_result_as_sequential(self):
        _, r1, _, _ = run_agent()
        _, r3, hooks, _ = run_agent(cfg=replace(BASE, parallelism=3))
        self.check_result(r3, hooks)
        # 병렬이면 S 번호 부여 순서는 달라질 수 있지만, 모은 문헌과 계획·종합의 순서는 같아야 한다
        for k in ("collected", "merged", "sub_questions"):
            self.assertEqual(r1["counts"][k], r3["counts"][k], k)
        self.assertEqual(list(r1["syntheses"]), list(r3["syntheses"]))
        self.assertEqual(sorted(s["title"] for s in r1["sources"]), sorted(s["title"] for s in r3["sources"]))

    def test_web_copies_merged_into_academic_record(self):
        _, r, _, _ = run_agent()
        noy = [s for s in r["sources"] if s["title"].startswith("Experimental evidence on the productivity")]
        self.assertEqual(len(noy), 1)
        self.assertEqual(noy[0]["kind"], "peer-reviewed")
        shared = [s for s in r["sources"] if s["title"] == "Large language models and doctoral writing quality"]
        self.assertEqual(len(shared), 1)
        self.assertGreater(r["counts"]["merged"], 0)

    def test_replanning_adds_subquestion_and_final_reflection(self):
        _, r, hooks, _ = run_agent(llm=FakeLLM(continue_rounds=2))
        self.assertEqual(r["counts"]["sub_questions"], 5)
        self.assertEqual(r["plan"]["sub_questions"][-1]["id"], "Q5")
        self.assertIn("Q5", r["syntheses"])
        self.assertTrue(any(e["msg"].startswith("새 하위 질문 추가 Q5: ") for e in hooks.of_kind("replan")))
        self.assertEqual([x["round"] for x in r["reflections"]], [1, 2, 3])
        self.assertEqual([x["final"] for x in r["reflections"]], [False, False, True])
        self.assertFalse(r["reflections"][-1]["should_continue"])
        self.assertTrue(hooks.of_kind("reflection")[-1]["msg"].startswith("최종 점검: 품질 "))
        rounds = {e["data"]["round"] for e in hooks.of_kind("stage")}
        self.assertEqual(rounds, {1, 2, 3})

    def test_stop_without_final_check(self):
        _, r, _, _ = run_agent(llm=FakeLLM(continue_rounds=0))
        self.assertEqual(len(r["reflections"]), 1)
        self.assertFalse(r["reflections"][0]["final"])
        self.assertEqual(r["counts"]["sub_questions"], 4)


class YearFromTest(unittest.TestCase):
    def test_agent_decides(self):
        _, r, _, tools = run_agent()
        self.assertEqual((r["year_from"], r["year_from_source"]), (2022, "agent"))
        self.assertTrue(all(c[3] == 2022 for c in tools["search_openalex"].calls))

    def test_zero_means_no_limit(self):
        _, r, hooks, tools = run_agent(cfg=replace(BASE, year_from=0))
        self.assertIsNone(r["year_from"])
        self.assertEqual(r["year_from_source"], "user")
        self.assertTrue(all(c[3] is None for c in tools["search_openalex"].calls))
        self.assertIn("제한 없음", hooks.of_kind("window")[0]["msg"])

    def test_explicit_year_wins(self):
        _, r, _, tools = run_agent(cfg=replace(BASE, year_from=2019, openalex_email="a@b.c", results_per_search=5))
        self.assertEqual((r["year_from"], r["year_from_source"]), (2019, "user"))
        calls = tools["search_openalex"].calls
        self.assertTrue(calls)
        self.assertTrue(all(c[2:] == (5, 2019, "a@b.c") for c in calls))


class PlanReviewTest(unittest.TestCase):
    def cfg(self):
        return replace(BASE, human_in_the_loop=True, max_reflection_rounds=0)

    def actions(self, hooks):
        return [e["data"]["action"] for e in hooks.of_kind("plan_review")]

    def test_approve(self):
        hooks = RecordingHooks(plan_decisions=[{"action": "approve"}])
        _, r, hooks, _ = run_agent(cfg=self.cfg(), hooks=hooks)
        self.assertEqual(self.actions(hooks), ["waiting", "approve"])
        self.assertEqual(len(hooks.reviewed_plans), 1)
        self.assertEqual(r["counts"]["sub_questions"], 4)

    def test_revise_then_approve(self):
        hooks = RecordingHooks(plan_decisions=[{"action": "revise", "feedback": "한국 사례를 더 넣어 주세요"},
                                               {"action": "approve"}])
        _, r, hooks, _ = run_agent(cfg=self.cfg(), hooks=hooks)
        self.assertEqual(self.actions(hooks), ["waiting", "revise", "waiting", "approve"])
        plans = hooks.of_kind("plan")
        self.assertEqual([p["data"]["revised"] for p in plans], [False, True])
        self.assertTrue(r["plan"]["sub_questions"][0]["question"].startswith("(수정)"))

    def test_edited_subquestions(self):
        edited = [{"id": "Q9", "question": "생성형 AI 사용 빈도는?", "search_queries": ["generative AI usage frequency"]},
                  "대학원생의 AI 윤리 인식은?"]
        hooks = RecordingHooks(plan_decisions=[{"action": "approve", "sub_questions": edited}])
        _, r, hooks, _ = run_agent(cfg=self.cfg(), hooks=hooks)
        sqs = r["plan"]["sub_questions"]
        self.assertEqual([q["id"] for q in sqs], ["Q1", "Q2"])
        self.assertEqual(sqs[1]["perspective"], "user-added")
        self.assertEqual(sqs[1]["search_queries"], [])
        self.assertEqual(len(sqs[1]["preferred_tools"]), 5)
        self.assertIn("edit", self.actions(hooks))
        self.assertEqual(set(r["syntheses"]), {"Q1", "Q2"})

    def test_invalid_edit_keeps_plan(self):
        hooks = RecordingHooks(plan_decisions=[{"action": "approve", "sub_questions": ["q"] * 9}])
        _, r, _, _ = run_agent(cfg=self.cfg(), hooks=hooks)
        self.assertEqual(r["counts"]["sub_questions"], 4)


class EdgeCaseTest(unittest.TestCase):
    def test_cancel(self):
        for p in (1, 3):
            with self.subTest(parallelism=p):
                with self.assertRaises(RunCancelled):
                    run_agent(cfg=replace(BASE, parallelism=p), hooks=RecordingHooks(cancel_after=15))

    def test_no_results_still_completes(self):
        _, r, hooks, _ = run_agent(tools=make_fake_tools(fail=(), empty=True))
        self.assertEqual(r["counts"]["collected"], 0)
        self.assertEqual(r["sources"], [])
        self.assertTrue(all(v["evidence_strength"] == "insufficient" for v in r["syntheses"].values()))
        self.assertNotIn("S9999", r["report_markdown"])
        self.assertEqual(r["verification"]["checks"], [])

    def test_refused_report(self):
        with self.assertRaises(LLMError) as cm:
            run_agent(llm=FakeLLM(refuse_report=True))
        self.assertEqual(cm.exception.code, "refusal")

    def test_tool_disabled_once(self):
        for p in (1, 3):
            with self.subTest(parallelism=p):
                _, r, hooks, tools = run_agent(cfg=replace(BASE, parallelism=p))
                disabled = hooks.of_kind("tool_disabled")
                self.assertEqual(len(disabled), 1)
                self.assertEqual(disabled[0]["data"], {"tool": "search_semantic_scholar"})
                self.assertEqual(disabled[0]["msg"], "search_semantic_scholar 연속 3회 실패 → 이번 실행에서 제외")
                self.assertEqual(r["disabled_tools"], ["search_semantic_scholar"])
                if p == 1:   # 순차 실행이면 정확히 3번 시도한 뒤 다시 부르지 않는다
                    self.assertEqual(sum(c[0] == "search_semantic_scholar" for c in tools["search_openalex"].calls), 3)


class ReviewFixesTest(unittest.TestCase):
    def test_understand_asks_variables_in_report_language(self):   # B2
        llm = FakeLLM()
        prompts = []
        orig = llm.json

        def json_(system, prompt, schema, **kw):
            prompts.append(prompt)
            return orig(system, prompt, schema, **kw)

        llm.json = json_
        run_agent(llm=llm)
        sentence = prompts[0].split("Write discipline", 1)[1].split("\n- ", 1)[0]
        for k in ("independent_variables", "dependent_variables", "moderators_or_context"):
            self.assertIn(k, sentence.split(" in the language")[0].split(" in language")[0])
        self.assertIn("Keep topic_en and the English terms/synonyms of key_concepts in English", prompts[0])

    def test_retrieve_uses_found_queries_for_user_subq(self):    # B3
        import sklearn.feature_extraction.text as sk
        edited = [{"question": "생성형 AI 사용 빈도는?", "search_queries": ["generative AI usage frequency"]},
                  "대학원생의 AI 윤리 인식은?"]
        hooks = RecordingHooks(plan_decisions=[{"action": "approve", "sub_questions": edited}])
        agent, _, _, _ = run_agent(cfg=replace(BASE, human_in_the_loop=True, max_reflection_rounds=0), hooks=hooks)
        seen = []
        real = sk.TfidfVectorizer

        class Spy(real):
            def fit(self, raw_documents, y=None):
                seen.append(raw_documents[-1])
                return super().fit(raw_documents, y)

        q1, q2 = agent.plan["sub_questions"]
        expected = list(dict.fromkeys(q for s in agent.store.sources() if "Q2" in s.subqs
                                      for q in sorted(s.queries)))[:8]
        self.assertTrue(expected)
        with mock.patch.object(sk, "TfidfVectorizer", Spy):
            agent.retrieve(q2)
            agent.retrieve(q1)
        self.assertIn("generative AI research productivity", seen[0])
        self.assertEqual(seen[0], q2["question"] + " " + " ".join(expected))
        self.assertEqual(seen[1], q1["question"] + " generative AI usage frequency")   # 검색어가 있으면 그대로

    def test_no_evidence_strings_follow_report_language(self):    # B4
        for lang, answer in (("en", "No evidence found."), ("ko", "근거 없음")):
            with self.subTest(lang=lang):
                _, r, _, _ = run_agent(cfg=replace(BASE, language=lang), tools=make_fake_tools(fail=(), empty=True))
                self.assertTrue(all(v["answer"] == answer for v in r["syntheses"].values()))
        _, r, _, _ = run_agent(cfg=replace(BASE, language="en"), tools=make_fake_tools(fail=(), empty=True))
        self.assertNotIn("관련 문헌을 찾지 못함", str(r["syntheses"]))

    def test_empty_revise_feedback_asks_again(self):    # B5
        cfg = replace(BASE, human_in_the_loop=True, max_reflection_rounds=0)
        hooks = RecordingHooks(plan_decisions=[{"action": "revise", "feedback": "  "}, {"action": "approve"}])
        _, _, hooks, _ = run_agent(cfg=cfg, hooks=hooks)
        self.assertEqual([e["data"]["action"] for e in hooks.of_kind("plan_review")], ["waiting", "waiting", "approve"])
        warnings = [e["msg"] for e in hooks.of_kind("warning") if e["stage"] == "plan"]
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("한도", warnings[0])
        self.assertEqual(len(hooks.reviewed_plans), 2)
        # 빈 의견도 횟수에 포함되어 한도(5회)를 넘으면 현재 계획으로 진행
        hooks = RecordingHooks(plan_decisions=[{"action": "revise", "feedback": ""}] * 10)
        _, _, hooks, _ = run_agent(cfg=cfg, hooks=hooks)
        self.assertEqual(len(hooks.reviewed_plans), 6)
        warnings = [e["msg"] for e in hooks.of_kind("warning") if e["stage"] == "plan"]
        self.assertEqual(sum("한도" in w for w in warnings), 1)
        self.assertIn("한도", warnings[-1])

    def test_parallel_failure_stops_other_workers(self):    # B6
        agent = ResearchAgent("x", FakeLLM(), replace(BASE, parallelism=3), RecordingHooks(), make_fake_tools())
        started = threading.Barrier(3)
        steps = []

        def fn(i):
            started.wait(timeout=5)
            if i == 2:
                time.sleep(0.05)
                raise ValueError("boom")
            for _ in range(100):
                agent._checkpoint()
                steps.append(i)
                time.sleep(0.01)
            return i

        with self.assertRaises(ValueError) as cm:
            agent._map(fn, [0, 1, 2], "synthesize", "t")
        self.assertEqual(str(cm.exception), "boom")     # 원래 예외가 전파된다(내부 중단 예외가 아님)
        self.assertLess(len(steps), 60)
        self.assertFalse(agent._abort.is_set())
        self.assertEqual(agent._map(lambda x: x * 2, [1, 2, 3], "synthesize", "t"), [2, 4, 6])

    def test_report_retried_after_connection_drop(self):    # B7
        class FlakyLLM(FakeLLM):
            def __init__(self, failures, exc):
                super().__init__()
                self.failures, self.exc, self.report_calls = failures, exc, 0

            def text(self, system, prompt, stream=False, on_delta=None, **kw):
                self.report_calls += 1
                if self.report_calls <= self.failures:
                    if on_delta:
                        on_delta("앞부분 ")
                    raise self.exc
                return super().text(system, prompt, stream=stream, on_delta=on_delta, **kw)

        drop = type("RemoteProtocolError", (Exception,), {"__module__": "httpx"})("peer closed connection")
        llm = FlakyLLM(1, drop)
        _, r, hooks, _ = run_agent(llm=llm)
        self.assertEqual(llm.report_calls, 2)
        self.assertTrue(r["report_markdown"])
        warn = [e for e in hooks.of_kind("warning") if e["stage"] == "report"]
        self.assertEqual(len(warn), 1)
        self.assertIn("다시 작성", warn[0]["msg"])
        starts = [e for e in hooks.of_kind("stage") if e["stage"] == "report" and e["data"]["status"] == "start"]
        self.assertEqual(len(starts), 2)
        pos = lambda ev: next(i for i, e in enumerate(hooks.events) if e is ev)
        self.assertLess(pos(starts[0]), pos(warn[0]))
        self.assertLess(pos(warn[0]), pos(starts[1]))
        # 재시도는 최대 2번: 세 번 연속 실패하면 원래 오류
        llm = FlakyLLM(5, ConnectionResetError("reset"))
        with self.assertRaises(ConnectionResetError):
            run_agent(llm=llm)
        self.assertEqual(llm.report_calls, 3)
        # 재시도 대상이 아닌 오류는 바로 실패
        for exc in (LLMError("refusal", "x"), LLMError("auth", "x"), ValueError("bug"), RunCancelled()):
            with self.subTest(exc=repr(exc)):
                llm = FlakyLLM(1, exc)
                with self.assertRaises(type(exc)):
                    run_agent(llm=llm)
                self.assertEqual(llm.report_calls, 1)


class ClaimSpansTest(unittest.TestCase):
    def spans(self, text):
        return [text[a:b] for a, b in ResearchAgent._claim_spans(text)]

    def test_table_row_is_one_claim(self):
        row = "| 개념 | 정의 [S1]. 둘째 문장 [S2]. | 측정 [S3] |"
        self.assertEqual(self.spans("머리말\n" + row), [row])

    def test_citation_only_fragment_joins_previous(self):
        text = "- 품질도 향상되었다. [S1]. 다음 문장이다 [S2]."
        self.assertEqual(self.spans(text), ["- 품질도 향상되었다. [S1].", "다음 문장이다 [S2]."])

    def test_no_split_after_et_al(self):
        text = "Noy et al. found large gains [S3]. Others found none [S4]."
        self.assertEqual(self.spans(text), ["Noy et al. found large gains [S3].", "Others found none [S4]."])

    def test_lines_without_citations_skipped(self):
        self.assertEqual(self.spans("## 제목\n인용 없는 문장."), [])


if __name__ == "__main__":
    unittest.main()

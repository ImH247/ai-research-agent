from _samples import PROJECT_ROOT, load_sample, SAMPLE_IDS  # noqa: E402,F401

import io  # noqa: E402
import os  # noqa: E402
import json  # noqa: E402
import socket  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
import zipfile  # noqa: E402
from importlib.util import find_spec  # noqa: E402
from urllib.parse import unquote  # noqa: E402

import requests  # noqa: E402
import uvicorn  # noqa: E402

from agent.models import RunConfig  # noqa: E402
from fakes import FakeLLM, make_fake_tools  # noqa: E402
from server.api import create_app  # noqa: E402
from server.runs import RunManager  # noqa: E402

SAMPLES = PROJECT_ROOT / "data" / "samples"
SECRET = "sk-ant-test-SECRET-do-not-echo-1234"
TERMINAL = ("done", "error", "cancelled", "interrupted")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestDemoServer(unittest.TestCase):
    """데모 모드 서버를 임의 포트에 띄우고 SPEC 6.3의 경로를 requests로 검증한다."""

    @classmethod
    def setUpClass(cls):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.manager = RunManager(cls.tmp.name, SAMPLES, demo=True, demo_speed=0.02)
        port = free_port()
        cls.base = f"http://127.0.0.1:{port}"
        config = uvicorn.Config(create_app(cls.manager), host="127.0.0.1", port=port, access_log=False,
                                log_level="warning")
        cls.server = uvicorn.Server(config)
        cls.thread = threading.Thread(target=cls.server.run, daemon=True)
        cls.thread.start()
        for _ in range(200):
            if cls.server.started:
                break
            time.sleep(0.05)
        cls.http = requests.Session()
        cls.http.trust_env = False          # 프록시 설정 무시 (로컬 서버)
        cls.bodies = []

    @classmethod
    def tearDownClass(cls):
        cls.manager.shutdown()
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        cls.http.close()
        cls.tmp.cleanup()

    # ── 도우미 ──
    def call(self, method, path, **kw):
        r = self.http.request(method, self.base + path, timeout=60, **kw)
        self.bodies.append(r.content)
        self.assertNotIn(SECRET.encode(), r.content)          # 어떤 응답에도 API 키가 들어가면 안 된다
        self.assertNotIn(SECRET, json.dumps(dict(r.headers)))
        return r

    def create(self, **body):
        body = {"prompt": "데모 테스트 요청", "api_key": SECRET, "formats": ["md"], **body}
        r = self.call("POST", "/api/runs", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def wait(self, run_id, until=TERMINAL, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            snap = self.call("GET", f"/api/runs/{run_id}").json()
            if snap["status"] in until:
                return snap
            time.sleep(0.03)
        self.fail(f"{run_id}: {until} 상태가 되지 않음")

    # ── 테스트 ──
    def test_config(self):
        c = self.call("GET", "/api/config").json()
        self.assertTrue(c["demo"])
        self.assertFalse(c["server_key"])
        self.assertEqual(c["app"]["name"], "AI Research Agent")
        self.assertEqual(sum(m["default"] for m in c["models"]), 1)
        self.assertEqual([d["id"] for d in c["depths"]], ["quick", "standard", "deep"])
        self.assertEqual(c["default_depth"], "standard")
        self.assertEqual([f["id"] for f in c["formats"]], ["md", "html", "pdf", "docx", "pptx", "bib", "ris", "csv", "json"])
        self.assertTrue(all("available" in f and "note" in f for f in c["formats"]))
        self.assertEqual(len(c["stages"]), 8)
        self.assertEqual(len(c["tools"]), 5)
        self.assertEqual(c["limits"]["max_tool_steps"], [1, 6])
        self.assertIn("parallelism", c["defaults"])
        self.assertGreaterEqual(len(c["examples"]), 3)

    def test_key_check_without_key(self):
        r = self.call("POST", "/api/key/check", json={})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["ok"], False)
        self.assertEqual(r.json()["error"]["code"], "no_api_key")
        r = self.call("POST", "/api/key/check", json={"api_key": SECRET})   # 데모 모드: API 호출 없이 ok
        self.assertTrue(r.json()["ok"])

    def test_create_validation(self):
        cases = [({"prompt": "   "}, 400, "empty_prompt"), ({"prompt": "가" * 4001}, 400, "prompt_too_long"),
                 ({"prompt": "x", "formats": "md"}, 400, "invalid_request"),
                 ({"prompt": "x", "model": "bad model!"}, 400, "invalid_model")]
        for body, status, code in cases:
            r = self.call("POST", "/api/runs", json=body)
            self.assertEqual((r.status_code, r.json()["error"]["code"]), (status, code))
        r = self.call("POST", "/api/runs", data="prompt=x", headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(r.status_code, 415)
        r = self.call("POST", "/api/runs", data="{not json", headers={"Content-Type": "application/json"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "invalid_json"))
        r = self.call("POST", "/api/runs", json={"prompt": "x"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(r.status_code, 403)

    def test_origin_must_match_host_and_port(self):    # B14
        port = self.base.rsplit(":", 1)[1]
        cases = [({"Origin": f"http://127.0.0.1:{port}"}, 200), ({"Origin": f"HTTP://127.0.0.1:{port}"}, 200),
                 ({"Origin": f"http://127.0.0.1:{int(port) + 1}"}, 403), ({"Origin": "http://localhost:3000"}, 403),
                 ({"Origin": "http://127.0.0.1"}, 403), ({"Origin": "null"}, 403), ({}, 200)]
        for headers, status in cases:
            with self.subTest(headers=headers):
                r = self.call("POST", "/api/key/check", json={}, headers=headers)
                self.assertEqual(r.status_code, status, r.text)
                if status == 403:
                    self.assertEqual(r.json()["error"]["code"], "forbidden_origin")
        # 본문 없는 쓰기 요청도 같은 규칙
        r = self.call("POST", "/api/runs/nope/cancel", headers={"Origin": f"http://localhost:{int(port) + 1}"})
        self.assertEqual(r.status_code, 403)

    def test_unhandled_error_is_json(self):    # B16
        from unittest import mock
        with mock.patch.object(self.manager, "list", side_effect=RuntimeError(f"boom {SECRET}")), \
                self.assertLogs("research_agent.api", "ERROR") as logs:
            r = self.call("GET", "/api/runs")
        self.assertIn("boom", "\n".join(logs.output))            # 자세한 내용은 서버 로그에만
        self.assertNotIn(SECRET, "\n".join(logs.output))
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["error"]["code"], "internal")
        self.assertNotIn("boom", r.text)
        self.assertIn("nosniff", r.headers.get("X-Content-Type-Options", ""))

    def test_full_demo_run(self):
        formats = ["md", "html", "bib", "ris", "csv", "json"]
        rid = self.create(prompt="생성형 AI와 대학원 연구", formats=formats, depth="quick", year_from=2020)
        after, events, preview_seen, stages = 0, [], False, set()
        end = time.time() + 60
        while time.time() < end:
            body = self.call("GET", f"/api/runs/{rid}/events", params={"after": after}).json()
            events += body["events"]
            self.assertTrue(all(e["seq"] > after for e in body["events"]))
            after = body["next"]
            stages.add(body["status"]["stage"])
            if body["preview"] is not None:
                self.assertEqual(body["status"]["stage"], "report")
                preview_seen = preview_seen or bool(body["preview"]["text"])
            if body["status"]["status"] in TERMINAL:
                break
            time.sleep(0.02)
        snap = self.call("GET", f"/api/runs/{rid}").json()
        self.assertEqual(snap["status"], "done", snap["error"])
        self.assertTrue(preview_seen)
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        kinds = {e["kind"] for e in events}
        self.assertTrue({"stage", "tool", "plan", "evaluate", "synthesis", "reflection", "report", "verify", "export"} <= kinds)
        self.assertTrue({"act", "report"} <= stages)
        self.assertGreaterEqual(max(e["data"]["round"] for e in events if e["kind"] == "stage"), 2)
        # 스냅샷
        for k in ("id", "status", "prompt", "topic", "model", "model_label", "config", "created_at", "started_at",
                  "finished_at", "elapsed_s", "stage", "round", "progress", "counts", "usage", "plan", "awaiting",
                  "error", "formats", "exports", "has_result", "sample", "demo", "note"):
            self.assertIn(k, snap)
        self.assertTrue(snap["demo"] and snap["has_result"] and snap["note"])
        self.assertEqual(snap["stage"], "done")
        self.assertEqual(snap["counts"]["collected"], 229)
        self.assertEqual(snap["usage"]["calls"], 79)
        self.assertEqual(snap["config"]["year_from"], 2020)
        self.assertEqual(set(snap["exports"]), set(formats))
        self.assertTrue(all(v == "ready" for v in snap["exports"].values()), snap["exports"])
        self.assertEqual(len(snap["plan"]["sub_questions"]), 7)
        # 결과
        res = self.call("GET", f"/api/runs/{rid}/result").json()
        self.assertEqual((res["id"], res["prompt"]), (rid, "생성형 AI와 대학원 연구"))
        self.assertTrue(res["meta"]["demo"])
        self.assertIn("재생", res["meta"]["note"])
        self.assertIn('class="cite"', res["report_html"])
        self.assertNotIn("<script", res["report_html"].lower())
        self.assertTrue(res["toc"] and {"id", "level", "title"} <= set(res["toc"][0]))
        self.assertEqual(len(res["sources"]), 229)
        self.assertEqual(res["exports"]["md"], "ready")
        self.assertEqual(res["qa"], [])
        self._check_exports(rid)
        self._check_qa(rid)
        r = self.call("POST", f"/api/runs/{rid}/plan", json={"action": "approve"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (409, "not_awaiting"))
        r = self.call("POST", f"/api/runs/{rid}/slides", json={})
        self.assertTrue(r.json()["ok"])
        # 목록
        runs = self.call("GET", "/api/runs").json()["runs"]
        self.assertIn(rid, [x["id"] for x in runs])

    def _check_exports(self, rid):
        for fmt, magic in (("md", b"#"), ("html", b"<!doctype"), ("bib", b"@"), ("ris", b"TY  -"),
                           ("csv", b"\xef\xbb\xbf"), ("json", b"{")):
            r = self.call("GET", f"/api/runs/{rid}/export/{fmt}")
            self.assertEqual(r.status_code, 200, (fmt, r.text[:200]))
            self.assertTrue(r.content.lower().startswith(magic.lower()), fmt)
            cd = r.headers["Content-Disposition"]
            self.assertTrue(cd.startswith("attachment"), cd)
            self.assertIn("생성형", unquote(cd.split("filename*=")[-1]), cd)
        for fmt, magic in (("docx", b"PK"), ("pptx", b"PK")):
            if find_spec(f"exporters.{fmt}_export"):
                r = self.call("GET", f"/api/runs/{rid}/export/{fmt}")
                self.assertEqual(r.status_code, 200, (fmt, r.text[:300]))
                self.assertTrue(r.content.startswith(magic), fmt)
        r = self.call("GET", f"/api/runs/{rid}/export/pdf")
        if r.status_code == 200:
            self.assertTrue(r.content.startswith(b"%PDF"))
        else:
            self.assertEqual((r.status_code, r.json()["error"]["code"]), (409, "pdf_unavailable"))
        r = self.call("GET", f"/api/runs/{rid}/export/html", params={"inline": 1})
        self.assertTrue(r.headers["Content-Disposition"].startswith("inline"))
        self.assertIn("text/html", r.headers["Content-Type"])
        r = self.call("GET", f"/api/runs/{rid}/export/html", params={"print": 1})
        self.assertIn("window.print", r.text)
        r = self.call("GET", f"/api/runs/{rid}/export/zip")
        self.assertEqual(r.status_code, 200)
        names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
        self.assertTrue({"result.json", "events.jsonl"} <= set(names))
        self.assertTrue(any(n.endswith("_report.md") for n in names))
        self.assertTrue(any(n.endswith(".csv") for n in names))
        r = self.call("GET", f"/api/runs/{rid}/export/exe")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "invalid_format"))

    def _check_qa(self, rid):
        r = self.call("POST", f"/api/runs/{rid}/qa", json={"question": " "})
        self.assertEqual(r.json()["error"]["code"], "empty_question")
        r = self.call("POST", f"/api/runs/{rid}/qa", json={"question": "ChatGPT writing productivity experiment",
                                                          "api_key": SECRET})
        self.assertEqual(r.status_code, 200, r.text)
        item = r.json()
        self.assertIn("데모 모드", item["answer_markdown"])
        self.assertTrue(item["sources"] and 'class="cite"' in item["answer_html"])
        self.assertEqual(len(self.call("GET", f"/api/runs/{rid}/qa").json()["items"]), 1)
        self.assertEqual(len(self.call("GET", f"/api/runs/{rid}/result").json()["qa"]), 1)

    def test_plan_review(self):
        rid = self.create(human_in_the_loop=True)
        snap = self.wait(rid, until=("awaiting_plan",))
        self.assertEqual(snap["awaiting"], "plan")
        self.assertEqual(len(snap["plan"]["sub_questions"]), 6)
        bad = [{"action": "maybe"}, {"action": "approve", "sub_questions": []},
               {"action": "approve", "sub_questions": [{"question": ""}]},
               {"action": "approve", "sub_questions": [{"question": "q"}] * 9},
               {"action": "approve", "sub_questions": [{"question": "가" * 501}]},
               {"action": "revise", "feedback": "x" * 2001}, {"action": "revise", "feedback": "  "},
               {"action": "revise"}]
        for body in bad:
            r = self.call("POST", f"/api/runs/{rid}/plan", json=body)
            self.assertEqual(r.status_code, 400, body)
        self.assertEqual(self.call("GET", f"/api/runs/{rid}").json()["status"], "awaiting_plan")
        r = self.call("POST", f"/api/runs/{rid}/plan", json={"action": "revise", "feedback": "한국 사례를 더 보고 싶어요"})
        self.assertEqual(r.json(), {"ok": True})
        time.sleep(0.05)
        self.wait(rid, until=("awaiting_plan",))
        r = self.call("POST", f"/api/runs/{rid}/plan",
                      json={"action": "approve", "sub_questions": [{"question": "사용자가 고친 질문"}]})
        self.assertEqual(r.json(), {"ok": True})
        snap = self.wait(rid)
        self.assertEqual(snap["status"], "done")
        actions = [e["data"]["action"] for e in self.call("GET", f"/api/runs/{rid}/events").json()["events"]
                   if e["kind"] == "plan_review"]
        self.assertEqual(actions, ["waiting", "revise", "waiting", "edit"])

    def test_cancel_and_delete(self):
        rid = self.create(human_in_the_loop=True)
        self.wait(rid, until=("awaiting_plan",))
        r = self.call("DELETE", f"/api/runs/{rid}")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (409, "running"))
        self.assertEqual(self.call("POST", f"/api/runs/{rid}/cancel").json(), {"ok": True})
        snap = self.wait(rid)
        self.assertEqual(snap["status"], "cancelled")
        self.assertFalse(snap["has_result"])
        r = self.call("GET", f"/api/runs/{rid}/result")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (404, "no_result"))
        self.assertEqual(self.call("DELETE", f"/api/runs/{rid}").json(), {"ok": True})
        self.assertEqual(self.call("GET", f"/api/runs/{rid}").status_code, 404)
        self.assertFalse((self.manager.runs_dir / rid).exists())

    def test_too_many_runs(self):
        a = self.create(human_in_the_loop=True)
        b = self.create(human_in_the_loop=True)
        r = self.call("POST", "/api/runs", json={"prompt": "세 번째"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (409, "too_many_runs"))
        for rid in (a, b):
            self.call("POST", f"/api/runs/{rid}/cancel", json={})
            self.wait(rid)

    def test_samples_read_only(self):
        runs = self.call("GET", "/api/runs").json()["runs"]
        tail = [x["id"] for x in runs[-2:]]
        self.assertEqual(sorted(tail), sorted(SAMPLE_IDS))
        self.assertTrue(all(x["sample"] for x in runs[-2:]))
        sid = SAMPLE_IDS[1]
        snap = self.call("GET", f"/api/runs/{sid}").json()
        self.assertEqual((snap["status"], snap["sample"]), ("done", True))
        self.assertGreater(len(self.call("GET", f"/api/runs/{sid}/events").json()["events"]), 10)
        self.assertEqual(self.call("GET", f"/api/runs/{sid}/result").json()["id"], sid)
        r = self.call("GET", f"/api/runs/{sid}/export/md")
        self.assertEqual(r.status_code, 200)
        self.assertTrue((self.manager.runs_dir / "_sample_exports" / sid / "exports").is_dir())
        r = self.call("DELETE", f"/api/runs/{sid}")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (403, "read_only"))
        r = self.call("POST", f"/api/runs/{sid}/plan", json={"action": "approve"})
        self.assertEqual(r.status_code, 409)

    def test_unknown_ids_and_hosts(self):
        self.assertEqual(self.call("GET", "/api/runs/r20990101_000000_ffff").json()["error"]["code"], "not_found")
        self.assertEqual(self.call("GET", "/api/runs/bad$id").json()["error"]["code"], "invalid_id")
        self.assertEqual(self.call("GET", "/api/runs/" + "a" * 81).status_code, 400)
        self.assertIn(self.call("GET", "/api/runs/..%2F..%2Fsecret/result").status_code, (400, 404))
        self.assertEqual(self.call("GET", "/api/runs/r20990101_000000_ffff/export/md").status_code, 404)
        self.assertEqual(self.call("GET", "/api/nope").json()["error"]["code"], "not_found")
        self.assertEqual(self.call("GET", "/api/config", headers={"Host": "evil.example"}).status_code, 400)
        self.assertEqual(self.call("GET", "/api/config", headers={"Host": f"localhost:{self.base.rsplit(':', 1)[1]}"}).status_code, 200)
        self.assertEqual(self.call("GET", "/assets/../../app.py").status_code, 404)

    def test_static(self):
        r = self.call("GET", "/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("no-store", r.headers["Cache-Control"])
        self.assertIn("text/html", r.headers["Content-Type"])
        r = self.call("GET", "/assets/tokens.css")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/css", r.headers["Content-Type"])
        self.assertIn("no-store", r.headers["Cache-Control"])


class TestRealPipeline(unittest.TestCase):
    """데모가 아닌 경로: RunManager가 실제 파이프라인을 FakeLLM·가짜 도구로 돌린다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.managers = []

    def tearDown(self):
        for m in self.managers:
            m.shutdown()
        self.tmp.cleanup()

    def manager(self, **llm_kw):
        m = RunManager(self.tmp.name, SAMPLES, llm_factory=lambda key, model: FakeLLM(**llm_kw),
                       tools=make_fake_tools())
        self.managers.append(m)
        return m

    def config(self, **kw):
        return RunConfig.from_dict({"depth": "quick", "parallelism": 1, "formats": ["md", "json"], **kw})

    def wait(self, run, until=TERMINAL, timeout=60):
        seen, end = [], time.time() + timeout
        while time.time() < end:
            s = run.snapshot()["status"]
            if not seen or seen[-1] != s:
                seen.append(s)
            if s in until:
                return seen
            time.sleep(0.01)
        self.fail(f"{until} 상태가 되지 않음: {seen}")

    def test_run_done(self):
        m = self.manager()
        with self.assertRaises(Exception):
            m.create("주제", self.config(), None)          # 키 없음 → no_api_key
        run = m.create("생성형 AI가 대학원생 연구에 미치는 영향", self.config(), "dummy-key")
        seen = self.wait(run)
        self.assertEqual(seen[-1], "done", run.snapshot()["error"])
        self.assertIn("running", seen)
        snap = run.snapshot()
        self.assertEqual(snap["stage"], "done")
        self.assertGreater(snap["counts"]["collected"], 0)
        self.assertGreater(snap["counts"]["sub_questions"], 0)
        self.assertGreater(snap["usage"]["calls"], 0)
        self.assertIsNotNone(snap["usage"]["cost_usd"])
        self.assertEqual(snap["exports"], {"md": "ready", "json": "ready"})
        self.assertIsNone(run.api_key)
        run_dir = m.runs_dir / run.id
        disk = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(disk["status"], "done")
        lines = (run_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), len(m.events(run.id, 0)))
        self.assertNotIn("dummy-key", (run_dir / "events.jsonl").read_text(encoding="utf-8"))
        result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
        self.assertEqual((result["schema_version"], result["id"]), (1, run.id))
        for k in ("year_from", "disabled_tools", "counts"):
            self.assertNotIn(k, result)
            self.assertIn(k, result["meta"])
        self.assertIn("search_semantic_scholar", result["meta"]["disabled_tools"])
        self.assertEqual(result["meta"]["counts"], snap["counts"])
        self.assertTrue(result["trace"])
        self.assertTrue(all(t["kind"] in m_trace_kinds() for t in result["trace"]))
        self.assertTrue((run_dir / "exports" / "report.md").is_file())          # 캐시는 짧은 ASCII 이름
        # 새 매니저로 읽어도 같은 결과
        m2 = RunManager(self.tmp.name, SAMPLES)
        self.assertEqual(m2.get(run.id).snapshot()["status"], "done")
        self.assertEqual(len(m2.events(run.id, 0)), len(lines))
        self.assertEqual(m2.list()[0]["id"], run.id)

    def test_refusal_error(self):
        m = self.manager(refuse_report=True)
        run = m.create("주제", self.config(), "dummy-key")
        self.assertEqual(self.wait(run)[-1], "error")
        snap = run.snapshot()
        self.assertEqual(snap["error"]["code"], "refusal")
        self.assertFalse(snap["has_result"])
        self.assertEqual(m.events(run.id, 0)[-1]["kind"], "error")

    def test_plan_review_and_interrupted(self):
        m = self.manager()
        run = m.create("주제", self.config(human_in_the_loop=True), "dummy-key")
        self.wait(run, until=("awaiting_plan",))
        self.assertTrue(run.snapshot()["plan"]["sub_questions"])
        # 서버가 꺼졌다가 다시 켜진 상황: 같은 데이터 폴더로 새 매니저를 만든다
        m2 = RunManager(self.tmp.name, SAMPLES)
        snap = m2.get(run.id).snapshot()
        self.assertEqual(snap["status"], "interrupted")
        self.assertIsNone(snap["awaiting"])
        self.assertFalse(m2.cancel(run.id))
        # 원래 매니저의 실행은 승인하면 끝까지 간다
        self.assertTrue(m.submit_plan(run.id, {"action": "approve"}))
        self.assertEqual(self.wait(run)[-1], "done")


class TestRunStorageFixes(unittest.TestCase):
    """디스크 오류·삭제·깨진 기록 처리 (B9, B11, B12, B13, B16)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.managers = []

    def tearDown(self):
        for m in self.managers:
            m.shutdown()
        self.tmp.cleanup()

    def manager(self, **kw):
        m = RunManager(self.tmp.name, SAMPLES, **kw)
        self.managers.append(m)
        return m

    def wait(self, run, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            if run.snapshot()["status"] in TERMINAL:
                return run.snapshot()
            time.sleep(0.01)
        self.fail(f"끝나지 않음: {run.snapshot()['status']}")

    def done_run(self, m):
        run = m.create("데모 테스트 요청", RunConfig.from_dict({"formats": ["md"]}), None)
        self.assertEqual(self.wait(run)["status"], "done")
        return run

    def test_disk_error_in_worker_still_finishes(self):    # B9
        from unittest import mock
        import server.runs as runs_mod
        m = self.manager(llm_factory=lambda key, model: FakeLLM(refuse_report=True), tools=make_fake_tools())
        real_open = open

        def flaky_open(file, mode="r", *a, **kw):
            if "a" in mode and str(file).endswith("events.jsonl") and refused.is_set():
                raise OSError(28, "No space left on device")
            return real_open(file, mode, *a, **kw)

        refused = threading.Event()
        real_write_json = runs_mod.write_json

        def flaky_write_json(path, obj):
            if refused.is_set():
                raise OSError(28, "No space left on device")
            return real_write_json(path, obj)

        orig_text = FakeLLM.text

        def text(self_, *a, **kw):
            refused.set()                    # 보고서 단계부터 디스크가 가득 찬 상황
            return orig_text(self_, *a, **kw)

        with mock.patch("builtins.open", flaky_open), mock.patch.object(runs_mod, "write_json", flaky_write_json), \
                mock.patch.object(FakeLLM, "text", text):
            run = m.create("주제", RunConfig.from_dict({"depth": "quick", "parallelism": 1, "formats": ["md"]}), "k")
            snap = self.wait(run)
        self.assertEqual(snap["status"], "error")
        self.assertEqual(snap["error"]["code"], "refusal")
        self.assertIsNotNone(run.persist_error)
        self.assertEqual(run.events_after(0)[-1]["kind"], "error")       # 메모리에는 남아 있다

    def test_delete_during_export_does_not_recreate_folder(self):    # B11
        m = self.manager(demo=True, demo_speed=0.02)
        run = self.done_run(m)
        run_dir = m.runs_dir / run.id
        import server.runs as runs_mod
        started, release = threading.Event(), threading.Event()
        real = runs_mod.export_file

        def slow_export(*a, **kw):
            started.set()
            release.wait(10)
            return real(*a, **kw)

        errors = []

        def bg():
            try:
                m.export(run.id, "csv")
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        from unittest import mock
        with mock.patch.object(runs_mod, "export_file", slow_export):
            t = threading.Thread(target=bg)
            t.start()
            self.assertTrue(started.wait(10))
            m.delete(run.id)
            self.assertTrue(run.deleted)
            release.set()
            t.join(20)
        run.save()
        run.set_export("csv", "ready")
        run.emit("system", "log", "삭제 뒤 이벤트", None)
        self.assertFalse(run_dir.exists())
        self.assertIsNone(m.get(run.id))
        self.assertTrue(errors and getattr(errors[0], "code", "") == "not_found")

    def test_create_failure_is_unregistered(self):    # B12
        from unittest import mock
        from server.runs import RunError, Run
        m = self.manager(demo=True, demo_speed=0.02)
        for patch in (mock.patch.object(Run, "save", return_value=False),
                      mock.patch("pathlib.Path.mkdir", side_effect=PermissionError("denied"))):
            with self.subTest(patch=str(patch)):
                with patch:
                    with self.assertRaises(RunError) as cm:
                        m.create("요청", RunConfig.from_dict({"formats": ["md"]}), None)
                self.assertEqual(cm.exception.code, "storage_error")
                self.assertEqual(cm.exception.status, 500)
                self.assertFalse(m._runs)
                self.assertEqual(list(m.runs_dir.glob("r*")), [])
        for _ in range(2):          # 한도(2건)를 막지 않는다
            self.done_run(m)

    def test_bad_jsonl_lines_are_skipped(self):    # B13
        m = self.manager(demo=True, demo_speed=0.02)
        run = self.done_run(m)
        n = len(run.events_after(0))
        ev_path = m.runs_dir / run.id / "events.jsonl"
        lines = ev_path.read_text(encoding="utf-8").splitlines()
        lines.insert(3, "{broken")
        lines.insert(5, "[1, 2]")
        ev_path.write_text("\n".join(lines) + '\n{"seq": 99999, "ts": "x', encoding="utf-8")     # 잘린 마지막 줄
        qa_path = m.runs_dir / run.id / "qa.jsonl"
        good = {"question": "q", "answer_markdown": "a", "sources": [], "ts": "t"}
        qa_path.write_text(json.dumps(good) + "\nnot json\n" + json.dumps(good) + '\n{"question": "cut', encoding="utf-8")
        m2 = self.manager()
        r2 = m2.get(run.id)
        self.assertEqual(len(r2.events_after(0)), n)
        self.assertEqual(len(m2.qa_items(run.id)), 2)
        r2.emit("system", "log", "새 이벤트", None)
        self.assertEqual(r2.events_after(0)[-1]["seq"], n + 1)
        m3 = self.manager()
        self.assertEqual(len(m3.get(run.id).events_after(0)), n + 1)     # 새 줄이 잘린 줄에 붙지 않았다
        item = m.ask(run.id, "질문", None)
        self.assertEqual(m3.qa_items(run.id)[-1]["question"], item["question"])

    def test_busy_cache_file_maps_to_409(self):    # B16
        from unittest import mock
        import server.runs as runs_mod
        from server.runs import RunError
        m = self.manager(demo=True, demo_speed=0.02)
        run = self.done_run(m)
        cache = m.runs_dir / run.id / "exports"
        self.assertTrue(m.export(run.id, "zip").is_file())

        def locked(src, dst):
            raise PermissionError(13, "file in use")

        with mock.patch.object(runs_mod, "replace_file", locked):
            for call in (lambda: m.export(run.id, "zip"), lambda: m.regen_slides(run.id)):
                with self.assertRaises(RunError) as cm:
                    call()
                self.assertEqual((cm.exception.code, cm.exception.status), ("busy", 409))
        self.assertEqual([p.name for p in cache.iterdir() if p.name.startswith("tmp_")], [])
        self.assertTrue(m.regen_slides(run.id) in (True, False))
        self.assertTrue((cache / "slides.pptx").is_file() or not find_spec("pptx"))
        self.assertEqual([p.name for p in cache.iterdir() if p.name.startswith("tmp_")], [])


def m_trace_kinds():
    from server.runs import TRACE_KINDS
    return TRACE_KINDS


if __name__ == "__main__":
    unittest.main()

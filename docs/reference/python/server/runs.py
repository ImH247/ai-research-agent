"""실행 관리 (SPEC 6.1): 실행 1건의 메모리 상태(Run)와 실행 생성·저장·복원·내보내기(RunManager).

실행 1건 = 스레드 1개. 에이전트가 훅(_Hooks)으로 알려 주는 이벤트를 Run이 받아 상태 스냅샷(run.json)을 갱신한다.
API 키는 Run 객체 속성으로만 들고 있고, 스냅샷·파일·이벤트에는 절대 넣지 않는다.
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import shutil
import threading
import time
import traceback
import zipfile
from datetime import datetime
from pathlib import Path

import anthropic

from agent.llm import LLMError, RunCancelled, friendly_error
from agent.models import APP_VERSION, RunConfig, estimate_cost, model_label
from agent.pipeline import STAGE_NAMES, RunHooks
from exporters import CACHE_NAMES, FORMATS, PdfUnavailable, filename_for, slugify
from exporters import export as export_file

TRACE_KINDS = {"understanding", "window", "plan", "plan_review", "tool_disabled", "subq_done", "evaluate",
               "reflection", "replan", "report", "verify", "repair"}
ACTIVE = ("queued", "running", "awaiting_plan")
MAX_ACTIVE = 2                     # 동시에 진행할 수 있는 실행 수
MAX_PROMPT = 4000
MAX_QUESTION = 2000
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
FORMAT_IDS = [f["id"] for f in FORMATS]
FORMAT_LABEL = {f["id"]: f["label"] for f in FORMATS}
EMPTY_COUNTS = {"collected": 0, "included": 0, "merged": 0, "report_evidence": 0, "sub_questions": 0}
# LLM 오류 코드 → HTTP 상태 코드 (Q&A·슬라이드 다시 만들기에서 사용)
LLM_STATUS = {"auth": 401, "permission": 403, "rate_limit": 429, "connection": 502, "server": 502, "unknown": 502}
BUNDLE_NAME = "bundle.zip"
LONG_PREFIX = "\\\\?\\"              # Windows 확장 길이 경로 접두사 \\?\
LONG_PATH_AT = 150                   # 데이터 폴더 절대 경로가 이보다 길면 확장 길이 형식으로 바꾼다


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class RunError(Exception):
    """API가 그대로 {"error": {code, message}}로 돌려줄 수 있는 오류."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def write_json(path: Path, obj) -> None:
    """임시 파일에 쓴 뒤 바꿔치기한다(쓰는 도중에 읽어도 깨진 JSON이 보이지 않게)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    replace_file(tmp, path)


def replace_file(src: Path, dst: Path) -> None:
    """os.replace. Windows: 다른 스레드(내려받기 등)가 잠깐 열고 있으면 실패할 수 있어 몇 번 다시 시도한다."""
    for i in range(5):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            time.sleep(0.05 * (i + 1))
    os.replace(src, dst)


def _parse_line(line: str):
    """JSON Lines 한 줄 → dict. 비었거나 깨진 줄은 None."""
    if not line.strip():
        return None
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ── 긴 경로 (Windows) ──
def long_path(path) -> Path:
    """절대 경로로 바꾸고, Windows에서 LONG_PATH_AT자보다 길면 확장 길이 형식(\\\\?\\C:\\…)으로 바꾼다.
    그러면 그 아래의 mkdir·open·rename·rmtree가 260자 제한 없이 동작한다(깊은 폴더·한글 폴더 이름 대비)."""
    s = str(path)
    if os.name == "nt" and not s.startswith(LONG_PREFIX):
        s = os.path.abspath(s)
        if len(s) > LONG_PATH_AT:
            s = LONG_PREFIX + ("UNC\\" + s[2:] if s.startswith("\\\\") else s)
    return Path(s).resolve()


def plain_path(path) -> str:
    """화면·로그·응답에 보여 줄 경로: 확장 길이 접두사를 뗀다."""
    s = str(path)
    if s.startswith(LONG_PREFIX + "UNC\\"):
        return "\\\\" + s[len(LONG_PREFIX) + 4:]
    return s[len(LONG_PREFIX):] if s.startswith(LONG_PREFIX) else s


def is_inside(path, root) -> bool:
    """path가 root 아래(또는 root 자체)인지. 확장 길이 접두사가 한쪽에만 있어도 같은 경로로 본다."""
    try:
        path = Path(path).resolve()
    except OSError:
        return False
    return Path(plain_path(path)).is_relative_to(Path(plain_path(root)))


def clean_text(text: str, api_key: str | None = None) -> str:
    """사용자·파일에 남길 오류 문구 정리: 확장 길이 접두사를 떼고, 혹시 들어 있는 API 키는 가린다."""
    text = str(text).replace(LONG_PREFIX + "UNC\\", "\\\\").replace(LONG_PREFIX, "")
    return text.replace(api_key, "***") if api_key else text


def key_format_ok(key: str | None) -> bool:
    """API 키 모양 검사: 인쇄 가능한 ASCII(공백 없음)만. 어긋난 키를 HTTP 헤더에 넣으면
    라이브러리 오류 메시지에 키 값이 그대로 실릴 수 있어 미리 거른다."""
    return not key or (len(key) <= 400 and key.isascii() and key.isprintable() and " " not in key)


def validate_decision(d) -> dict:
    """계획 검토 결정을 검사하고 필요한 필드만 남긴다. 잘못되면 RunError(invalid_plan)."""
    def bad(msg):
        return RunError("invalid_plan", msg, 400)

    if not isinstance(d, dict) or d.get("action") not in ("approve", "revise"):
        raise bad("action은 approve 또는 revise여야 합니다.")
    if d["action"] == "revise":
        fb = d.get("feedback") or ""
        if not isinstance(fb, str) or len(fb) > 2000:
            raise bad("피드백은 2000자 이하의 글이어야 합니다.")
        if not fb.strip():      # 빈 피드백은 실제 실행에서 재계획되지 않으므로(데모와 동작이 달라짐) 미리 거절한다
            raise bad("다시 계획하려면 의견(feedback)을 입력해 주세요.")
        return {"action": "revise", "feedback": fb.strip()}
    sqs = d.get("sub_questions")
    if sqs is None:
        return {"action": "approve"}
    if not isinstance(sqs, list) or not 1 <= len(sqs) <= 8:
        raise bad("하위 질문은 1~8개여야 합니다.")
    from agent.tools import TOOL_FUNCS
    out = []
    for sq in sqs:
        q = sq.get("question") if isinstance(sq, dict) else None
        if not isinstance(q, str) or not q.strip() or len(q) > 500:
            raise bad("하위 질문마다 500자 이하의 질문(question)이 있어야 합니다.")
        item = {"question": q.strip()}
        for k in ("perspective", "rationale"):
            if isinstance(sq.get(k), str) and sq[k].strip():
                item[k] = sq[k].strip()[:500]
        if isinstance(sq.get("search_queries"), list):
            item["search_queries"] = [s.strip()[:300] for s in sq["search_queries"] if isinstance(s, str) and s.strip()][:8]
        if isinstance(sq.get("preferred_tools"), list):
            tools = [t for t in sq["preferred_tools"] if t in TOOL_FUNCS]
            if tools:
                item["preferred_tools"] = tools
        out.append(item)
    return {"action": "approve", "sub_questions": out}


class Run:
    """실행 1건의 메모리 상태. snapshot()이 SPEC 3.4의 run.json이다."""

    def __init__(self, run_id: str, prompt: str, config: RunConfig, run_dir: Path, store_dir: Path | None = None,
                 sample: bool = False, demo: bool = False, note: str = ""):
        self.id, self.prompt, self.config = run_id, prompt, config
        self.dir = run_dir                      # run.json · events.jsonl · result.json 이 있는 폴더
        self.store_dir = store_dir or run_dir   # exports/ · slides.json · qa.jsonl (샘플은 data/runs/_sample_exports/<id>)
        self.status = "queued"
        self.topic = prompt[:80]
        self.model = config.model
        self.created_at, self.started_at, self.finished_at = now_iso(), None, None
        self.elapsed_s = 0.0
        self.stage, self.round, self.progress = "system", 1, None
        self.counts = dict(EMPTY_COUNTS)
        self.usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": estimate_cost(self.model, 0, 0)}
        self.plan = None
        self.awaiting = None
        self.error = None
        self.formats = list(config.formats)
        self.exports = {f: "pending" for f in self.formats}
        self.has_result, self.sample, self.demo, self.note = False, sample, demo, note
        # 메모리 전용 (스냅샷·파일에 넣지 않음)
        self.api_key = None
        self.llm = None
        self.agent = None
        self.thread = None
        self.result_cache = None
        self._events = []
        self._preview = []
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._decision = None
        self._decision_ready = threading.Event()
        self._t0 = None
        self.deleted = False          # 삭제된 실행은 디스크에 더 쓰지 않는다(폴더가 되살아나지 않게)
        self.persist_error = None     # 마지막 디스크 쓰기 실패(메모리에만 기록)
        self._events_need_nl = False  # events.jsonl이 줄바꿈 없이 끝남(잘린 마지막 줄) → 다음 줄 앞에 줄바꿈

    @classmethod
    def from_snapshot(cls, snap: dict, run_dir: Path, store_dir: Path | None = None) -> "Run":
        """디스크의 run.json으로 지난 실행을 되살린다(이벤트는 처음 요청될 때 읽음)."""
        run = cls(snap.get("id") or run_dir.name, snap.get("prompt") or "", RunConfig.from_dict(snap.get("config")),
                  run_dir, store_dir, bool(snap.get("sample")), bool(snap.get("demo")), snap.get("note") or "")
        for k in ("status", "topic", "model", "created_at", "started_at", "finished_at", "elapsed_s", "stage", "round",
                  "progress", "counts", "usage", "plan", "awaiting", "error", "formats", "exports", "has_result"):
            if k in snap and snap[k] is not None:
                setattr(run, k, snap[k])
        run.exports = dict(run.exports or {})
        run._events = None
        return run

    # ── 스냅샷 ──
    def elapsed(self) -> float:
        if self._t0 is not None and self.status in ACTIVE:
            return round(time.monotonic() - self._t0, 1)
        return self.elapsed_s

    def live_usage(self) -> dict:
        if self.llm is None:
            return dict(self.usage)
        u = dict(getattr(self.llm, "usage", None) or {})
        inp, out = int(u.get("input_tokens", 0)), int(u.get("output_tokens", 0))
        return {"calls": int(u.get("calls", 0)), "input_tokens": inp, "output_tokens": out,
                "cost_usd": estimate_cost(self.model, inp, out)}

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id, "status": self.status, "prompt": self.prompt, "topic": self.topic,
                "model": self.model, "model_label": model_label(self.model), "config": self.config.to_dict(),
                "created_at": self.created_at, "started_at": self.started_at, "finished_at": self.finished_at,
                "elapsed_s": self.elapsed(), "stage": self.stage, "round": self.round,
                "progress": copy.deepcopy(self.progress), "counts": dict(self.counts), "usage": self.live_usage(),
                "plan": copy.deepcopy(self.plan), "awaiting": self.awaiting, "error": copy.deepcopy(self.error),
                "formats": list(self.formats), "exports": dict(self.exports), "has_result": self.has_result,
                "sample": self.sample, "demo": self.demo, "note": self.note,
            }

    def summary(self) -> dict:
        s = self.snapshot()
        keys = ("id", "topic", "prompt", "model", "model_label", "status", "stage", "created_at", "elapsed_s",
                "counts", "usage", "sample", "demo", "note")
        return {k: s[k] for k in keys}

    def save(self) -> bool:
        """run.json 저장(최선 노력). 디스크 오류는 던지지 않고 persist_error에 남긴 뒤 False."""
        if self.sample:          # 샘플은 읽기 전용
            return True
        with self._lock:
            if self.deleted:
                return True
            try:
                write_json(self.dir / "run.json", self.snapshot())
                return True
            except OSError as e:
                self.persist_error = f"run.json 저장 실패 ({type(e).__name__})"
                return False

    # ── 이벤트 ──
    def _load_events(self) -> list:
        if self._events is None:
            evs = []
            try:
                with open(self.dir / "events.jsonl", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except (OSError, ValueError):
                text = ""
            for line in text.splitlines():     # 깨지거나 잘린 줄은 그 줄만 건너뛴다
                ev = _parse_line(line)
                if ev is not None and isinstance(ev.get("seq"), int) and all(k in ev for k in ("ts", "stage", "kind", "msg")):
                    evs.append(ev)
            self._events_need_nl = bool(text) and not text.endswith("\n")
            self._events = evs
        return self._events

    def events_after(self, after: int) -> list:
        with self._lock:
            return [e for e in self._load_events() if e["seq"] > after]

    def trace(self) -> list:
        with self._lock:
            return [{"ts": e["ts"], "stage": e["stage"], "kind": e["kind"], "msg": e["msg"]}
                    for e in self._load_events() if e["kind"] in TRACE_KINDS]

    def emit(self, stage: str, kind: str, msg: str, data: dict | None = None) -> None:
        """이벤트를 기록하고(메모리 + events.jsonl) 종류에 따라 상태를 갱신한다."""
        data = json.loads(json.dumps(data, ensure_ascii=False, default=str)) if data is not None else None
        with self._lock:
            events = self._load_events()
            seq = (events[-1]["seq"] if events else 0) + 1      # 건너뛴 줄이 있어도 번호가 겹치지 않게
            ev = {"seq": seq, "ts": now_iso(), "stage": stage, "kind": kind, "msg": str(msg), "data": data}
            events.append(ev)                                   # 상태(메모리)를 먼저 갱신하고
            if not self.sample and not self.deleted:            # 파일 기록은 최선 노력
                try:
                    with open(self.dir / "events.jsonl", "a", encoding="utf-8") as f:
                        f.write(("\n" if self._events_need_nl else "") + json.dumps(ev, ensure_ascii=False) + "\n")
                    self._events_need_nl = False
                except OSError as e:
                    self.persist_error = f"events.jsonl 기록 실패 ({type(e).__name__})"
            if self._apply(ev):
                self.save()

    def _apply(self, ev: dict) -> bool:
        """이벤트 → 상태(단계, 라운드, 집계, 계획). 단계가 바뀌었으면 True."""
        kind, d = ev["kind"], ev["data"] or {}
        if kind == "stage":
            if d.get("status") == "start":
                self.stage, self.round, self.progress = ev["stage"], int(d.get("round") or self.round), None
                if self.stage == "report":
                    self._preview = []
                return True
            return False
        if kind == "understanding" and d.get("topic"):
            self.topic = d["topic"]
        elif kind in ("plan", "replan"):
            if self.agent is not None and getattr(self.agent, "plan", None):
                self.plan = copy.deepcopy(self.agent.plan)
            if self.plan:
                self.counts["sub_questions"] = len(self.plan.get("sub_questions") or [])
        elif kind == "tool" and isinstance(d.get("total"), int):
            self.counts["collected"] = d["total"]
        elif kind == "evaluate":
            for src, dst in (("included", "included"), ("merged", "merged"), ("total", "collected")):
                if isinstance(d.get(src), int):
                    self.counts[dst] = d[src]
        elif kind == "report" and isinstance(d.get("evidence"), int):
            self.counts["report_evidence"] = d["evidence"]
        return False

    # ── 에이전트·데모가 부르는 상태 변경 ──
    def set_progress(self, stage: str, done: int, total: int, label: str = "") -> None:
        with self._lock:
            self.progress = {"done": done, "total": total, "label": label}

    def set_plan(self, plan: dict) -> None:
        with self._lock:
            self.plan = copy.deepcopy(plan)
            self.counts["sub_questions"] = len(plan.get("sub_questions") or [])

    def set_usage(self, usage: dict) -> None:
        with self._lock:
            self.usage = dict(usage)

    def set_export(self, fmt: str, state: str) -> None:
        with self._lock:
            if self.deleted:
                return
            self.exports[fmt] = state
        if self.status not in ACTIVE:
            self.save()

    def checkpoint(self) -> None:
        if self._cancel.is_set():
            raise RunCancelled()

    def report_delta(self, text: str) -> None:
        with self._lock:
            self._preview.append(text)

    def preview(self, start: int = 0) -> dict | None:
        """보고서 작성 중일 때만 미리보기 텍스트를 start 글자 위치부터 돌려준다."""
        with self._lock:
            if self.stage != "report" or self.status != "running":
                return None
            text = "".join(self._preview)
        start = max(0, min(int(start or 0), len(text)))
        return {"from": start, "text": text[start:], "total": len(text)}

    def wait_plan(self, plan: dict | None) -> dict:
        """계획 검토: 상태를 awaiting_plan으로 바꾸고 submit()이 결정을 넘길 때까지 기다린다(0.5초마다 취소 확인)."""
        with self._lock:
            if plan:
                self.set_plan(plan)
            self._decision, self.awaiting, self.status = None, "plan", "awaiting_plan"
            self._decision_ready.clear()
            self.save()
        while not self._decision_ready.wait(0.5):
            self.checkpoint()
        with self._lock:
            decision, self.awaiting, self.status = self._decision, None, "running"
            self._decision_ready.clear()
            self.save()
        self.checkpoint()
        return decision

    def submit(self, decision: dict) -> bool:
        with self._lock:
            if self.awaiting != "plan" or self._decision_ready.is_set():
                return False
            self._decision = decision
            self._decision_ready.set()
            return True

    def start(self) -> None:
        with self._lock:
            self.status, self.started_at, self._t0 = "running", now_iso(), time.monotonic()
            self.save()

    def finish(self, status: str, error: dict | None = None) -> None:
        with self._lock:
            self.usage = self.live_usage()
            self.elapsed_s = self.elapsed()
            self.status, self.finished_at, self.error = status, now_iso(), error
            self.awaiting, self.progress = None, None
            if status == "done":
                self.stage = "done"
            else:   # 결과가 없으니 만들지 못한 결과물은 목록에서 뺀다
                self.exports = {k: v for k, v in self.exports.items() if v != "pending"}
            self.api_key = self.llm = self.agent = None     # 키(LLM 클라이언트 포함)는 실행이 끝나면 지운다
            self.save()


class _Hooks(RunHooks):
    """파이프라인 콜백 → Run 상태."""

    def __init__(self, run: Run):
        self.run = run

    def emit(self, stage, kind, msg, data=None):
        self.run.emit(stage, kind, msg, data)

    def progress(self, stage, done, total, label=""):
        self.run.set_progress(stage, done, total, label)

    def checkpoint(self):
        self.run.checkpoint()

    def review_plan(self, plan):
        return self.run.wait_plan(plan)

    def report_delta(self, text):
        self.run.report_delta(text)


class RunManager:
    def __init__(self, data_dir: Path, samples_dir: Path, demo: bool = False, demo_speed: float = 1.0,
                 llm_factory=None, tools: dict | None = None):
        """llm_factory(api_key, model)와 tools는 테스트용(가짜 LLM·가짜 검색 도구 주입). 기본은 실제 LLM과 TOOL_FUNCS.
        경로가 길면(Windows) 데이터·샘플 폴더를 확장 길이 형식으로 바꿔 둔다(long_path). 보여 줄 때는 plain_path()."""
        self.data_dir = long_path(data_dir)
        self.runs_dir = self.data_dir / "runs"           # 샘플 내보내기 캐시(runs/_sample_exports)도 이 아래
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.samples_dir = long_path(samples_dir)
        self.demo, self.demo_speed = demo, float(demo_speed)
        self.llm_factory, self.tools = llm_factory, tools
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        self._export_locks: dict = {}
        self._mark_interrupted()

    # ── 조회 ──
    def _mark_interrupted(self) -> None:
        """서버가 꺼질 때 진행 중이던 실행은 다시 이어 갈 수 없으므로 interrupted로 표시한다."""
        for p in self.runs_dir.glob("*/run.json"):
            snap = read_json(p)
            if isinstance(snap, dict) and snap.get("status") in ACTIVE:
                snap.update(status="interrupted", awaiting=None, progress=None,
                            error={"code": "interrupted", "message": "서버가 종료되어 실행이 중단되었습니다. 다시 실행해 주세요."})
                write_json(p, snap)

    def get(self, run_id) -> Run | None:
        if not isinstance(run_id, str) or not ID_RE.match(run_id):
            return None
        with self._lock:
            if run_id in self._runs:
                return self._runs[run_id]
            run = None
            snap = read_json(self.runs_dir / run_id / "run.json")
            if isinstance(snap, dict):
                run = Run.from_snapshot(snap, self.runs_dir / run_id)
            else:
                snap = read_json(self.samples_dir / run_id / "run.json")
                if isinstance(snap, dict):
                    run = Run.from_snapshot(snap, self.samples_dir / run_id, self.runs_dir / "_sample_exports" / run_id)
                    run.sample = True
            if run:
                run.id = run_id
                self._runs[run_id] = run
            return run

    def _require(self, run_id) -> Run:
        run = self.get(run_id)
        if run is None:
            raise RunError("not_found", "실행을 찾을 수 없습니다.", 404)
        return run

    def list(self) -> list[dict]:
        """요약 목록: 최신순, 샘플은 맨 뒤."""
        ids = {p.parent.name for p in self.runs_dir.glob("*/run.json")}
        with self._lock:
            ids |= {i for i, r in self._runs.items() if not r.sample}
        runs = [r for r in (self.get(i) for i in ids) if r and not r.sample]
        runs.sort(key=lambda r: r.created_at or "", reverse=True)
        samples = [r for r in (self.get(p.parent.name) for p in sorted(self.samples_dir.glob("*/run.json"))) if r]
        return [r.summary() for r in runs + samples]

    def events(self, run_id, after: int) -> list[dict]:
        return self._require(run_id).events_after(int(after or 0))

    def result(self, run_id) -> dict | None:
        run = self.get(run_id)
        if run is None:
            return None
        if run.result_cache is None:
            res = read_json(run.dir / "result.json")
            run.result_cache = res if isinstance(res, dict) else None
        return run.result_cache

    def _require_result(self, run_id) -> tuple[Run, dict]:
        run = self._require(run_id)
        result = self.result(run_id)
        if result is None:
            raise RunError("no_result", "아직 결과가 없습니다.", 404)
        return run, result

    # ── 생성 · 제어 ──
    def _key(self, api_key) -> str | None:
        key = (api_key or "").strip() or None
        if not key and not os.environ.get("ANTHROPIC_API_KEY"):
            raise RunError("no_api_key", "Anthropic API 키를 입력해 주세요.", 400)
        if not key_format_ok(key):
            raise RunError("auth", "API 키 형식이 올바르지 않습니다. 복사한 키를 다시 확인해 주세요.", 400)
        return key

    def create(self, prompt: str, config: RunConfig, api_key: str | None) -> Run:
        prompt = (prompt or "").strip()
        if not prompt:
            raise RunError("empty_prompt", "연구 주제나 요청을 입력해 주세요.", 400)
        if len(prompt) > MAX_PROMPT:
            raise RunError("prompt_too_long", f"요청은 {MAX_PROMPT}자 이하로 입력해 주세요.", 400)
        key = None if self.demo else self._key(api_key)
        config.formats = [f for f in dict.fromkeys(config.formats) if f in FORMAT_IDS] or ["md"]
        from server.demo import DEMO_NOTE
        with self._lock:
            if sum(1 for r in self._runs.values() if r.status in ACTIVE) >= MAX_ACTIVE:
                raise RunError("too_many_runs", f"동시에 진행할 수 있는 실행은 최대 {MAX_ACTIVE}건입니다. "
                                                "진행 중인 실행이 끝난 뒤 다시 시도해 주세요.", 409)
            run_id = f"r{datetime.now():%Y%m%d_%H%M%S}_{secrets.token_hex(2)}"
            while run_id in self._runs or (self.runs_dir / run_id).exists():
                run_id = f"r{datetime.now():%Y%m%d_%H%M%S}_{secrets.token_hex(2)}"
            run = Run(run_id, prompt, config, self.runs_dir / run_id, demo=self.demo,
                      note=DEMO_NOTE if self.demo else "")
            run.api_key = key
            self._runs[run_id] = run
            try:
                (self.runs_dir / run_id).mkdir(parents=True)
                saved = run.save()
            except OSError:
                saved = False
            if not saved:   # 등록을 되돌린다(queued로 남아 동시 실행 한도를 막지 않게)
                self._runs.pop(run_id, None)
                shutil.rmtree(self.runs_dir / run_id, ignore_errors=True)
                raise RunError("storage_error", "실행 폴더를 만들거나 저장하지 못했습니다. 데이터 폴더의 디스크 공간과 "
                                                "쓰기 권한을 확인한 뒤 다시 시도해 주세요.", 500)
        run.thread = threading.Thread(target=self._worker, args=(run,), name=f"run-{run_id}", daemon=True)
        run.thread.start()
        return run

    def cancel(self, run_id) -> bool:
        run = self._require(run_id)
        if run.status in ACTIVE:
            run._cancel.set()
            return True
        return False

    def submit_plan(self, run_id, decision: dict) -> bool:
        run = self._require(run_id)
        return run.submit(validate_decision(decision))

    def delete(self, run_id) -> None:
        run = self._require(run_id)
        if run.sample:
            raise RunError("read_only", "샘플 실행은 삭제할 수 없습니다.", 403)
        if run.status in ACTIVE:
            raise RunError("running", "진행 중인 실행은 삭제할 수 없습니다. 먼저 취소해 주세요.", 409)
        if run.thread is not None:
            run.thread.join(timeout=10)
        path = (self.runs_dir / run_id).resolve()
        if path.parent != self.runs_dir:           # data/runs/ 바로 아래 폴더만 지운다
            raise RunError("not_found", "실행을 찾을 수 없습니다.", 404)
        with run._lock:
            run.deleted = True          # 이후 save·set_export·이벤트 기록은 아무것도 하지 않는다(폴더가 되살아나지 않게)
        with self._lock:
            self._runs.pop(run_id, None)
        shutil.rmtree(path, ignore_errors=True)

    def shutdown(self, timeout: float = 10) -> None:
        """진행 중인 실행을 모두 취소하고 스레드가 끝나기를 기다린다(테스트·종료용)."""
        with self._lock:
            runs = list(self._runs.values())
        for r in runs:
            if r.status in ACTIVE:
                r._cancel.set()
        for r in runs:
            if r.thread is not None:
                r.thread.join(timeout=timeout)

    # ── 실행 스레드 ──
    def _make_llm(self, api_key, model, on_warning=None):
        if self.llm_factory is not None:
            return self.llm_factory(api_key, model)
        from agent.llm import LLM
        return LLM(api_key, model, on_warning=on_warning)

    def _worker(self, run: Run) -> None:
        key = run.api_key            # 오류 문구에서 가리기 위해서만 쓴다 (finish()가 run.api_key를 지움)
        status, error = "error", {"code": "internal", "message": "내부 오류가 발생했습니다."}
        try:
            run.start()
            if self.demo:
                from server import demo
                result = demo.replay(run, self.samples_dir / demo.DEMO_SAMPLE, self.demo_speed)
            else:
                result = self._run_agent(run)
            self._save_result(run, result)
            self._export_stage(run, result)
            status, error = "done", None
        except RunCancelled:
            status, error = "cancelled", None
            try:
                run.emit("system", "log", "사용자가 실행을 취소했습니다", None)
            except Exception:  # noqa: BLE001 — 기록 실패가 실행 종료 처리를 막지 않게
                pass
        except Exception as e:  # noqa: BLE001 — 어떤 오류든 실행 상태로 남긴다
            try:
                if isinstance(e, LLMError) or isinstance(e, anthropic.AnthropicError):
                    err = friendly_error(e)
                    error = {"code": err.code, "message": err.message}
                else:
                    try:
                        (run.dir / "error.log").write_text(clean_text(traceback.format_exc(), key), encoding="utf-8")
                    except OSError:
                        pass
                    summary = clean_text((str(e).splitlines() or [""])[0], key)[:200]
                    error = {"code": "internal", "message": f"내부 오류가 발생했습니다 ({type(e).__name__}: {summary})"}
                run.emit("system", "error", error["message"], {"code": error["code"]})
            except Exception:  # noqa: BLE001
                pass
        finally:
            run.finish(status, error)       # 어떤 경우에도 실행을 끝난 상태로 표시한다

    def _run_agent(self, run: Run) -> dict:
        from agent.pipeline import ResearchAgent
        llm = self._make_llm(run.api_key, run.config.model,
                             on_warning=lambda m: run.emit("system", "warning", str(m), None))
        run.llm = llm
        run.agent = ResearchAgent(run.prompt, llm, run.config, _Hooks(run), tools=self.tools)
        return self._assemble(run, run.agent.run())

    def _assemble(self, run: Run, out: dict) -> dict:
        """에이전트 결과에 id·meta·trace·schema_version을 붙여 result.json(SPEC 3.2)을 만든다."""
        out = dict(out)
        extra = {k: out.pop(k, None) for k in ("year_from", "year_from_source", "year_from_reason",
                                               "disabled_tools", "counts")}
        meta = {
            "model": run.model, "model_label": model_label(run.model), "created_at": run.created_at,
            "finished_at": now_iso(), "elapsed_s": run.elapsed(), "year_from": extra["year_from"],
            "year_from_source": extra["year_from_source"] or "agent", "year_from_reason": extra["year_from_reason"] or "",
            "config": run.config.to_dict(), "usage": run.live_usage(), "counts": extra["counts"] or dict(EMPTY_COUNTS),
            "disabled_tools": list(extra["disabled_tools"] or []), "app_version": APP_VERSION,
            "sample": False, "demo": False, "note": "",
        }
        result = {"schema_version": 1, "id": run.id, "prompt": out.pop("prompt", run.prompt),
                  "topic": out.pop("topic", run.topic), "lang": out.pop("lang", "ko"), "meta": meta}
        result.update(out)
        result["trace"] = run.trace()
        return result

    def _save_result(self, run: Run, result: dict) -> None:
        write_json(run.dir / "result.json", result)
        meta = result.get("meta") or {}
        with run._lock:
            run.result_cache = result
            run.has_result = True
            run.topic = result.get("topic") or run.topic
            run.counts = dict(meta.get("counts") or run.counts)
            if run.llm is None and meta.get("usage"):
                run.usage = dict(meta["usage"])
            run.save()

    def _export_stage(self, run: Run, result: dict) -> None:
        """config.formats를 차례로 만든다. 실패해도 실행은 성공으로 끝난다(exports[fmt]='failed')."""
        if not run.formats:
            return
        run.emit("export", "stage", "결과물 내보내기 시작", {"status": "start", "round": run.round})
        if "pptx" in run.formats:
            run.checkpoint()
            outline = None
            if run.llm is not None:
                from agent.slides import make_outline
                try:
                    outline = make_outline(run.llm, result)
                except RunCancelled:
                    raise
                except Exception as e:  # noqa: BLE001
                    run.emit("export", "warning", f"슬라이드 개요 생성 실패 → 규칙 기반 개요 사용 ({type(e).__name__})", None)
            if not outline:
                from agent.slides import fallback_outline
                outline = fallback_outline(result)
            write_json(run.store_dir / "slides.json", outline)
        for fmt in run.formats:
            run.checkpoint()
            label = FORMAT_LABEL.get(fmt, fmt)
            try:
                self.export(run.id, fmt)
                run.emit("export", "export", f"{label} 생성 완료", {"fmt": fmt, "ok": True, "error": ""})
            except RunError as e:
                run.emit("export", "export", f"{label} 생성 실패: {e.message}", {"fmt": fmt, "ok": False, "error": e.message})
        run.emit("export", "stage", "결과물 내보내기 완료", {"status": "end", "round": run.round})

    # ── 내보내기 ──
    def _cache_dir(self, run: Run) -> Path:
        return run.store_dir / "exports"

    def _outline(self, run: Run, result: dict) -> dict:
        outline = read_json(run.store_dir / "slides.json")
        if isinstance(outline, dict):
            return outline
        from agent.slides import fallback_outline
        return fallback_outline(result)

    def exports_status(self, run: Run) -> dict:
        """스냅샷의 exports + 캐시에 이미 있는 파일."""
        status = dict(run.exports)
        result = self.result(run.id)
        if result:
            cache = self._cache_dir(run)
            for fmt in FORMAT_IDS:
                if (cache / CACHE_NAMES[fmt]).is_file():
                    status[fmt] = "ready"
        return status

    def download_name(self, run_id, fmt: str) -> str:
        """내려받기 이름(Content-Disposition): 한글 주제 + 형식 꼬리. 캐시 파일 이름(CACHE_NAMES)과는 다르다."""
        _, result = self._require_result(run_id)
        if fmt == "zip":
            return f"{slugify(result.get('topic') or result.get('prompt') or '')}_bundle.zip"
        return filename_for(result, fmt)

    def export(self, run_id, fmt: str) -> Path:
        """캐시(exports/)에 있으면 그 파일, 없으면 새로 만든다. fmt 'zip'은 지금까지 만든 결과물 묶음.
        캐시 파일은 짧은 ASCII 이름(report.md, slides.pptx, bundle.zip …)이다."""
        if fmt != "zip" and fmt not in FORMAT_IDS:
            raise RunError("invalid_format", "알 수 없는 형식입니다.", 400)
        run, result = self._require_result(run_id)
        if fmt == "zip":
            return self._bundle(run, result)
        cache = self._cache_dir(run)
        with self._lock:
            lock = self._export_locks.setdefault((run.id, fmt), threading.Lock())
        with lock:
            path = cache / CACHE_NAMES[fmt]
            if path.is_file():
                return path
            tmp = cache / f"tmp_{CACHE_NAMES[fmt]}"          # 다 쓴 뒤에 바꿔치기(쓰다 만 파일을 내려주지 않게)
            try:
                export_file(result, fmt, cache, outline=self._outline(run, result) if fmt == "pptx" else None,
                            name=tmp.name)
                replace_file(tmp, path)
            except PdfUnavailable as e:
                run.set_export(fmt, "unavailable")
                raise RunError("pdf_unavailable", str(e) or "PDF를 만들 브라우저(Edge/Chrome)를 찾지 못했습니다. "
                                                         "HTML 보고서를 열어 인쇄 기능으로 PDF로 저장해 주세요.", 409)
            except Exception as e:  # noqa: BLE001
                try:
                    tmp.unlink(missing_ok=True)    # 쓰다 만 파일이 캐시로 남지 않게
                except OSError:
                    pass
                run.set_export(fmt, "failed")
                self._log_error(run, f"export {fmt}")
                raise RunError("export_failed", f"{FORMAT_LABEL[fmt]} 파일을 만들지 못했습니다 ({type(e).__name__}).", 500)
            self._drop_if_deleted(run)
            run.set_export(fmt, "ready")
            return path

    @staticmethod
    def _drop_if_deleted(run: Run) -> None:
        """만드는 사이에 실행이 삭제됐으면 다시 생긴 폴더를 지우고 not_found."""
        if run.deleted and not run.sample:
            shutil.rmtree(run.dir, ignore_errors=True)
            raise RunError("not_found", "실행을 찾을 수 없습니다.", 404)

    @staticmethod
    def _busy() -> RunError:
        """Windows: 내려받는 중인 파일은 바꾸거나 지울 수 없다(PermissionError)."""
        return RunError("busy", "파일을 내려받는 중이라 지금은 바꿀 수 없습니다. 잠시 후 다시 시도해 주세요.", 409)

    def _bundle(self, run: Run, result: dict) -> Path:
        """캐시에 있는 결과물(zip 안에서는 한글 내려받기 이름) + result.json · events.jsonl 묶음."""
        cache = self._cache_dir(run)
        out = cache / BUNDLE_NAME
        with self._lock:
            lock = self._export_locks.setdefault((run.id, "zip"), threading.Lock())
        with lock:
            tmp = cache / f"tmp_{secrets.token_hex(4)}_{BUNDLE_NAME}"     # 고유 임시 이름에 만든 뒤 바꿔치기
            try:
                cache.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                    for fmt in FORMAT_IDS:
                        p = cache / CACHE_NAMES[fmt]
                        if p.is_file():
                            z.write(p, filename_for(result, fmt))
                    for name in ("result.json", "events.jsonl"):
                        if (run.dir / name).is_file():
                            z.write(run.dir / name, name)
                replace_file(tmp, out)
            except BaseException as e:
                try:
                    tmp.unlink(missing_ok=True)       # 실패하면 임시 파일을 남기지 않는다
                except OSError:
                    pass
                if isinstance(e, OSError):
                    raise self._busy() from None
                raise
        self._drop_if_deleted(run)
        return out

    def _log_error(self, run: Run, what: str) -> None:
        try:
            run.store_dir.mkdir(parents=True, exist_ok=True)
            with open(run.store_dir / "error.log", "a", encoding="utf-8") as f:
                f.write(f"[{now_iso()}] {what}\n{traceback.format_exc()}\n")
        except OSError:
            pass

    # ── 후속 질문 · 슬라이드 ──
    def qa_items(self, run_id) -> list[dict]:
        run = self._require(run_id)
        try:
            with open(run.store_dir / "qa.jsonl", encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError:
            return []
        return [x for x in map(_parse_line, lines) if x is not None]     # 깨진 줄은 그 줄만 건너뛴다

    def _llm_call(self, fn):
        """LLM 오류를 RunError로 바꿔 API가 그대로 돌려줄 수 있게 한다."""
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            if isinstance(e, LLMError) or isinstance(e, anthropic.AnthropicError):
                err = friendly_error(e)
                raise RunError(err.code, err.message, LLM_STATUS.get(err.code, 400)) from None
            raise

    def ask(self, run_id, question, api_key, model=None) -> dict:
        run, result = self._require_result(run_id)
        q = (question or "").strip() if isinstance(question, str) else ""
        if not q:
            raise RunError("empty_question", "질문을 입력해 주세요.", 400)
        if len(q) > MAX_QUESTION:
            raise RunError("question_too_long", f"질문은 {MAX_QUESTION}자 이하로 입력해 주세요.", 400)
        if self.demo:
            from server.demo import demo_answer
            ans = demo_answer(result, q)
        else:
            from agent.qa import answer_question
            key = self._key(api_key)
            model = model or (result.get("meta") or {}).get("model") or run.config.model
            history = self.qa_items(run_id)[-3:]
            ans = self._llm_call(lambda: answer_question(self._make_llm(key, model), result, q, history))
        item = {"question": q, "answer_markdown": ans["answer_markdown"], "sources": ans["sources"], "ts": now_iso()}
        with run._lock:
            run.store_dir.mkdir(parents=True, exist_ok=True)
            path, lead = run.store_dir / "qa.jsonl", ""
            try:        # 마지막 줄이 잘려 있으면 새 줄이 그 줄에 붙지 않게 줄을 바꾼다
                with open(path, "rb") as f:
                    f.seek(-1, os.SEEK_END)
                    lead = "" if f.read(1) == b"\n" else "\n"
            except OSError:
                pass
            with open(path, "a", encoding="utf-8") as f:
                f.write(lead + json.dumps(item, ensure_ascii=False) + "\n")
        return item

    def regen_slides(self, run_id, api_key=None, model=None) -> bool:
        """슬라이드 개요를 LLM으로 다시 만들고 pptx를 다시 생성한다. LLM이 개요를 못 만들면 규칙 기반 개요를 쓰고 False."""
        from agent.slides import fallback_outline, make_outline
        run, result = self._require_result(run_id)
        outline = None
        if not self.demo:
            key = self._key(api_key)
            model = model or (result.get("meta") or {}).get("model") or run.config.model
            outline = self._llm_call(lambda: make_outline(self._make_llm(key, model), result))
        used_llm = bool(outline)
        outline = outline or fallback_outline(result)
        try:
            write_json(run.store_dir / "slides.json", outline)
        except OSError:
            raise self._busy() from None
        with self._lock:
            lock = self._export_locks.setdefault((run.id, "pptx"), threading.Lock())
        cache = self._cache_dir(run)
        path = cache / CACHE_NAMES["pptx"]
        with lock:
            # 내려받는 중인 파일을 지우지 않고, 고유 임시 이름에 만든 뒤 바꿔치기한다
            tmp = cache / f"tmp_{secrets.token_hex(4)}_{CACHE_NAMES['pptx']}"
            try:
                export_file(result, "pptx", cache, outline=outline, name=tmp.name)
                replace_file(tmp, path)
            except BaseException as e:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                if isinstance(e, OSError):
                    raise self._busy() from None
                if not isinstance(e, Exception):
                    raise
                run.set_export("pptx", "failed")
                self._log_error(run, "export pptx")
                raise RunError("export_failed", f"{FORMAT_LABEL['pptx']} 파일을 만들지 못했습니다 ({type(e).__name__}).",
                               500) from None
        self._drop_if_deleted(run)
        run.set_export("pptx", "ready")
        return used_llm


__all__ = ["TRACE_KINDS", "Run", "RunManager", "RunError", "ID_RE", "FORMAT_IDS", "STAGE_NAMES", "validate_decision",
           "long_path", "plain_path", "is_inside", "key_format_ok"]

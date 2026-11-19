"""데모 모드 (SPEC 6.2): API를 호출하지 않고, 기록된 실제 실행(샘플)의 events.jsonl을 빠르게 재생한다.

재생하면서 이벤트의 kind·data로 상태 스냅샷(단계, 라운드, 진행률, 집계, 사용량)을 실제 실행처럼 바꾼다.
human_in_the_loop이면 계획 뒤에 실제로 멈춰 사용자 결정을 기다리고, 보고서 단계에서는 샘플 보고서를 조각내어
미리보기로 흘려보낸다. 끝나면 샘플 result를 새 id·사용자 prompt로 복사해 결과로 돌려준다.
"""
from __future__ import annotations

import copy
import json
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from agent.models import APP_VERSION
from agent.pipeline import STAGE_NAMES

DEMO_SAMPLE = "sample_genai_graduate_research"
DEMO_NOTE = ("데모 모드 결과입니다. API를 호출하지 않고, 실제로 기록된 실행(중간고사 노트북, Claude Opus 5.5)의 "
             "과정과 결과를 재생했습니다. 보고서 내용은 입력한 요청이 아니라 기록된 실행의 주제에 대한 것입니다.")
# 이벤트 종류별 재생 간격(초). demo_speed를 곱한다. 샘플 91개 이벤트 + 보고서 미리보기로 전체 약 45초.
DELAYS = {"tool": 0.3, "tool_error": 0.3, "tool_disabled": 0.3, "subq_done": 0.5, "evaluate": 0.6, "synthesis": 0.5,
          "reflection": 0.6, "replan": 0.4, "understanding": 0.6, "window": 0.3, "plan": 0.6, "report": 0.4,
          "verify": 0.6, "repair": 0.6}
REPORT_CHUNKS = 120          # 보고서 미리보기를 몇 조각으로 나눌지
MAX_REVISIONS = 5
PROGRESS_LABEL = {"act": "하위 질문 탐색", "synthesize": "하위 질문 종합"}


def _sleep(run, seconds: float) -> None:
    """취소를 확인하면서 쉰다."""
    end = time.monotonic() + seconds
    while True:
        run.checkpoint()
        left = end - time.monotonic()
        if left <= 0:
            return
        time.sleep(min(left, 0.1))


def _annotate(events: list[dict]) -> list[tuple[dict, str, int]]:
    """이벤트마다 (이벤트, 실제로 속한 단계, 라운드)를 붙인다.
    계속하자는 자기 비판 뒤의 탐색부터 라운드가 오르고, replan 이벤트는 다음 라운드의 탐색(act) 단계에서 일어난다."""
    out, rnd, pending = [], 1, None
    for ev in events:
        stage = "act" if ev["kind"] == "replan" else ev["stage"]
        if pending and stage == "act":
            rnd, pending = pending, None
        out.append((ev, stage, rnd))
        d = ev.get("data") or {}
        if ev["kind"] == "reflection" and d.get("should_continue") and not d.get("final"):
            pending = rnd + 1
    return out


def _stage(run, stage: str, rnd: int, status: str) -> None:
    suffix = f" (라운드 {rnd})" if rnd > 1 else ""
    run.emit(stage, "stage", f"{STAGE_NAMES.get(stage, stage)} {'시작' if status == 'start' else '완료'}{suffix}",
             {"status": status, "round": rnd})


def _usage(target: dict, frac: float) -> dict:
    """사용량을 샘플의 최종값 쪽으로 비례해서 늘린다."""
    cost = target.get("cost_usd")
    return {"calls": round(target.get("calls", 0) * frac), "input_tokens": round(target.get("input_tokens", 0) * frac),
            "output_tokens": round(target.get("output_tokens", 0) * frac),
            "cost_usd": None if cost is None else round(cost * frac, 2)}


def _stream_report(run, text: str, speed: float) -> None:
    size = max(1, len(text) // REPORT_CHUNKS + 1)
    for i in range(0, len(text), size):
        run.report_delta(text[i:i + size])
        _sleep(run, max(0.005, 0.07 * speed))


def _review(run, speed: float) -> None:
    """계획 검토: 실제로 멈춰서 결정을 기다린다. revise면 재계획한 척하고 다시 기다린다."""
    for _ in range(MAX_REVISIONS + 1):
        run.emit("plan", "plan_review", "조사 계획 검토를 기다리는 중", {"action": "waiting"})
        d = run.wait_plan(run.plan)
        if d.get("action") == "revise":
            run.emit("plan", "plan_review", f"사용자 피드백 반영하여 재계획: {d.get('feedback', '')}", {"action": "revise"})
            _sleep(run, 1.0 * speed)
            sqs = (run.plan or {}).get("sub_questions") or []
            brief = [{"id": q.get("id"), "question": q.get("question"), "perspective": q.get("perspective")} for q in sqs]
            run.emit("plan", "plan", f"하위 질문 {len(sqs)}개 수립 (검토 의견 반영 · 데모: 기록된 계획을 그대로 씀)",
                     {"sub_questions": brief, "revised": True})
            continue
        if d.get("sub_questions"):
            run.emit("plan", "plan_review", f"사용자가 하위 질문 목록을 수정함 ({len(d['sub_questions'])}개) · "
                                            "데모에서는 기록된 계획대로 이어서 재생합니다", {"action": "edit"})
        else:
            run.emit("plan", "plan_review", "조사 계획 승인", {"action": "approve"})
        return
    run.emit("plan", "warning", "재계획 요청 횟수를 넘어 현재 계획으로 진행합니다", None)


def replay(run, sample_dir: Path, speed: float = 1.0) -> dict:
    """샘플 실행을 재생하고, 새 id·사용자 prompt를 넣은 result dict를 돌려준다."""
    sample = json.loads((sample_dir / "result.json").read_text(encoding="utf-8"))
    with open(sample_dir / "events.jsonl", encoding="utf-8") as f:
        events = [json.loads(line) for line in f if line.strip()]
    plan_full = sample.get("plan") or {}
    by_id = {sq.get("id"): sq for sq in plan_full.get("sub_questions") or []}
    target = (sample.get("meta") or {}).get("usage") or {}
    items = _annotate(events)
    totals = Counter((rnd, stage) for ev, stage, rnd in items if ev["kind"] in ("subq_done", "synthesis"))
    done = Counter()

    run.emit("system", "log", "데모 모드: 기록된 실제 실행을 재생합니다 (API를 호출하지 않음)", None)
    current = None
    for i, (ev, stage, rnd) in enumerate(items):
        kind, data = ev["kind"], copy.deepcopy(ev.get("data"))
        if stage != "system" and (stage, rnd) != current:
            if current:
                _stage(run, current[0], current[1], "end")
            current = (stage, rnd)
            _stage(run, stage, rnd, "start")
        _sleep(run, DELAYS.get(kind, 0.2) * speed)

        if kind == "plan":
            ids = [q.get("id") for q in (data or {}).get("sub_questions") or [] if isinstance(q, dict)]
            run.set_plan({**plan_full, "sub_questions": [by_id[q] for q in ids if q in by_id]})
        elif kind == "replan" and (data or {}).get("subq") in by_id:
            plan = copy.deepcopy(run.plan or {"sub_questions": []})
            plan["sub_questions"].append(by_id[data["subq"]])
            run.set_plan(plan)
        elif kind == "report" and "chars" in (data or {}):
            _stream_report(run, sample.get("report_markdown") or "", speed)

        run.emit(ev["stage"], kind, ev["msg"], data)
        if kind == "plan" and run.config.human_in_the_loop:
            _review(run, speed)
        if kind in ("subq_done", "synthesis"):
            done[(rnd, stage)] += 1
            run.set_progress(stage, done[(rnd, stage)], totals[(rnd, stage)], PROGRESS_LABEL.get(stage, ""))
        run.set_usage(_usage(target, (i + 1) / len(items)))
    if current:
        _stage(run, current[0], current[1], "end")
    run.checkpoint()
    return _result(run, sample)


def _result(run, sample: dict) -> dict:
    result = copy.deepcopy(sample)
    result["id"] = run.id
    result["prompt"] = run.prompt
    meta = result.setdefault("meta", {})
    meta.update(created_at=run.created_at, finished_at=datetime.now().isoformat(timespec="seconds"),
                elapsed_s=run.elapsed(), config=run.config.to_dict(), app_version=APP_VERSION,
                sample=False, demo=True, note=DEMO_NOTE)
    return result


def demo_answer(result: dict, question: str, k: int = 5) -> dict:
    """데모용 후속 질문 답: LLM 없이 qa.retrieve로 찾은 관련 근거 목록."""
    from agent.qa import retrieve
    top = retrieve(result, question, k=k)
    lines = [f"**데모 모드: 관련 근거 상위 {len(top)}건** (API 키로 실행하면 이 근거로 답변을 만듭니다.)", ""]
    for s in top:
        finding = s.get("key_finding") or (s.get("abstract") or "")[:160]
        year = s.get("year") or "n.d."
        lines.append(f"- [{s['sid']}] {s.get('title', '')} ({year}) — {finding}")
    if not top:
        lines.append("관련 근거를 찾지 못했습니다.")
    return {"answer_markdown": "\n".join(lines), "sources": [s["sid"] for s in top]}

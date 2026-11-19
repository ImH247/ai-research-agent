"""HTTP API (SPEC 6.3)와 정적 파일. 보안 규칙은 SPEC 6.4.

- Host 헤더는 127.0.0.1 / localhost / [::1] (+ --host 값)만 받는다(DNS rebinding 방지). CORS 헤더는 내보내지 않는다.
- 본문이 있는 요청은 application/json만 받고, 다른 사이트(Origin)에서 온 쓰기 요청은 거부한다.
- API 키는 요청에서 받아 RunManager로 넘기기만 하고, 응답·로그 어디에도 넣지 않는다.
"""
from __future__ import annotations

import importlib.util
import logging
import mimetypes
import os
import re
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from agent.models import (APP_NAME, APP_VERSION, DEFAULT_DEPTH, DEFAULT_MODEL, DEPTH_PRESETS, LIMITS, MODELS,
                          PRICING_AS_OF, RunConfig)
from agent.tools import TOOL_DESC, TOOL_FUNCS, TOOL_LABELS
from exporters import FORMATS
from exporters.html_export import build_html, render_fragment, render_markdown
from server.runs import FORMAT_IDS, ID_RE, RunError, RunManager, clean_text, is_inside, key_format_ok

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DEFAULT_HOSTS = ["127.0.0.1", "localhost", "[::1]"]
NO_CACHE = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache"}
MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,80}$")
MIME = {f["id"]: f["mime"] for f in FORMATS} | {"zip": "application/zip"}
# Windows는 레지스트리 설정에 따라 .js를 text/plain으로 알려 줄 때가 있어 정적 파일 형식을 직접 정한다
STATIC_TYPES = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
                ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
                ".woff": "font/woff", ".txt": "text/plain; charset=utf-8"}
# 단독 HTML 보고서를 브라우저에서 열 때: 스크립트 금지(인쇄용만 인라인 window.print 허용), 웹폰트만 외부 허용
_CSP = ("default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; "
        "img-src data: https: http:; base-uri 'none'; form-action 'none'; script-src ")
CSP_VIEW, CSP_PRINT = _CSP + "'none'", _CSP + "'unsafe-inline'"

STAGES = [
    {"id": "understand", "label": "주제 이해", "description": "핵심 개념·변수·검색 기간 파악"},
    {"id": "plan", "label": "조사 계획", "description": "관점이 다른 하위 질문과 검색어 수립"},
    {"id": "act", "label": "자료 탐색", "description": "하위 질문마다 검색 도구를 골라 문헌 수집"},
    {"id": "evaluate", "label": "자료 평가", "description": "관련성·연구 설계·신뢰도 평가와 중복 병합"},
    {"id": "synthesize", "label": "종합", "description": "하위 질문별로 근거를 모아 결론과 근거 강도 정리"},
    {"id": "reflect", "label": "자기 비판", "description": "빈틈·편향을 점검하고 필요하면 추가 조사"},
    {"id": "report", "label": "보고서 작성", "description": "인용이 달린 최종 연구 브리프 작성"},
    {"id": "verify", "label": "인용 검증", "description": "인용 ID 확인과 표본 문장의 초록 대조·수정"},
]
EXAMPLES = [
    "생성형 AI 활용이 대학원생의 연구 생산성과 연구 품질에 미치는 영향",
    "롤러를 활용한 센서 제작 공정",
    "2020년 이후 원격근무가 직원의 직무 만족과 생산성에 미친 영향을 실증 연구 중심으로 정리해 줘",
]
PLACEHOLDER = """<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>AI Research Agent</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.6">
<h1>AI Research Agent</h1><p>서버는 실행 중입니다. 화면(web/index.html)은 아직 준비되지 않았습니다.</p>
<p>API 확인: <a href="/api/config">/api/config</a></p></body></html>"""


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


class KeyBody(_Body):
    api_key: str | None = None


class CreateBody(_Body):
    prompt: str = ""
    model: str | None = None
    api_key: str | None = None
    depth: str | None = None
    options: dict[str, Any] | None = None
    language: str | None = None
    year_from: int | None = None
    human_in_the_loop: bool | None = None
    formats: list[str] | None = None


class PlanBody(_Body):
    action: str
    sub_questions: list[dict[str, Any]] | None = None
    feedback: str | None = None


class AskBody(_Body):
    question: str = ""
    api_key: str | None = None
    model: str | None = None


class SlidesBody(_Body):
    api_key: str | None = None
    model: str | None = None


def error_response(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=NO_CACHE)


_KEY_RE = re.compile(r"sk-ant-[A-Za-z0-9_\-]+")
log = logging.getLogger("research_agent.api")


def _internal_error(request) -> JSONResponse:
    """처리되지 않은 예외 → 500 internal. 자세한 내용(트레이스백)은 서버 로그에만, API 키처럼 보이는 값은 가린다."""
    detail = _KEY_RE.sub("sk-ant-***", clean_text(traceback.format_exc()))
    log.error("처리되지 않은 오류: %s %s\n%s", request.method, request.url.path, detail)
    return error_response("internal", "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.", 500)


def _config_payload(manager: RunManager) -> dict:
    """GET /api/config 중 서버가 켜져 있는 동안 변하지 않는 부분."""
    from exporters.pdf_export import find_browser
    has_browser = find_browser() is not None
    formats = []
    for f in FORMATS:
        item = {**f, "available": True, "note": ""}
        if f["id"] == "pdf" and not has_browser:
            item.update(available=False, note="Edge/Chrome/Chromium을 찾지 못해 PDF를 만들 수 없습니다. "
                                              "HTML 보고서를 열어 브라우저의 인쇄 기능으로 PDF로 저장할 수 있습니다.")
        elif f["id"] in ("docx", "pptx") and importlib.util.find_spec(f"exporters.{f['id']}_export") is None:
            item.update(available=False, note="이 형식의 내보내기 모듈이 아직 없습니다.")
        formats.append(item)
    return {
        "app": {"name": APP_NAME, "version": APP_VERSION}, "demo": manager.demo,
        "models": [{**m.to_dict(), "default": m.id == DEFAULT_MODEL} for m in MODELS], "pricing_as_of": PRICING_AS_OF,
        "depths": [{"id": k, "label": v["label"], "description": v["description"], "config": v["config"],
                    "estimate": v["estimate"]} for k, v in DEPTH_PRESETS.items()],
        "default_depth": DEFAULT_DEPTH, "formats": formats, "defaults": RunConfig().to_dict(),
        "limits": {k: list(v) for k, v in LIMITS.items()},
        "tools": [{"name": n, "label": TOOL_LABELS.get(n, n), "description": TOOL_DESC.get(n, "")} for n in TOOL_FUNCS],
        "stages": STAGES, "examples": EXAMPLES,
    }


def create_app(manager: RunManager, extra_hosts: list[str] | tuple = ()) -> FastAPI:
    app = FastAPI(title=APP_NAME, version=APP_VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    hosts = DEFAULT_HOSTS + [h for h in extra_hosts if h and h not in DEFAULT_HOSTS]
    origin_hosts = {h.strip("[]").lower() for h in hosts}
    static_config = _config_payload(manager)
    roots = [manager.data_dir, manager.samples_dir]

    # ── 오류 형식 ──
    @app.exception_handler(RunError)
    async def _run_error(request, exc: RunError):
        return error_response(exc.code, exc.message, exc.status)

    @app.exception_handler(RequestValidationError)
    async def _invalid(request, exc: RequestValidationError):
        # 입력값(API 키일 수도 있음)은 메시지에 넣지 않고 위치만 알려 준다
        errors = exc.errors()
        if any(e.get("type") == "json_invalid" for e in errors):
            return error_response("invalid_json", "요청 본문이 올바른 JSON이 아닙니다.", 400)
        where = ", ".join(".".join(str(x) for x in e.get("loc", ())[1:]) or "본문" for e in errors)
        return error_response("invalid_request", f"요청 형식이 올바르지 않습니다: {where}", 400)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return error_response("not_found", "요청한 주소를 찾을 수 없습니다.", 404)
        if exc.status_code == 405:
            return error_response("method_not_allowed", "허용되지 않는 요청 방식입니다.", 405)
        return error_response("http_error", "요청을 처리할 수 없습니다.", exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request, exc: Exception):
        return _internal_error(request)

    # ── 보안 미들웨어 ──
    @app.middleware("http")
    async def _guard(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin is not None:
                o = urlsplit(origin)
                # 같은 localhost라도 다른 포트의 페이지는 다른 사이트다 → Origin의 host:port가 Host 헤더와 같아야 한다
                same = (o.netloc or "").lower() == request.headers.get("host", "").lower()
                if not same or (o.hostname or "").lower() not in origin_hosts:
                    return error_response("forbidden_origin", "다른 사이트에서 보낸 요청은 받지 않습니다.", 403)
            ctype = request.headers.get("content-type", "")
            has_body = request.headers.get("content-length", "0") not in ("", "0") or "transfer-encoding" in request.headers
            if (has_body or ctype) and not ctype.lower().startswith("application/json"):
                return error_response("unsupported_media_type", "요청 본문은 application/json 형식이어야 합니다.", 415)
        try:
            response = await call_next(request)
        except Exception:  # noqa: BLE001 — 처리되지 않은 오류도 표준 JSON 오류 형식으로
            response = _internal_error(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", NO_CACHE["Cache-Control"])
        return response

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)   # 마지막에 추가 = 가장 바깥에서 먼저 검사

    def _run(run_id: str):
        if not ID_RE.match(run_id):
            raise RunError("invalid_id", "잘못된 실행 ID입니다.", 400)
        run = manager.get(run_id)
        if run is None:
            raise RunError("not_found", "실행을 찾을 수 없습니다.", 404)
        return run

    def _result(run_id: str) -> dict:
        _run(run_id)
        result = manager.result(run_id)
        if result is None:
            raise RunError("no_result", "아직 결과가 없습니다.", 404)
        return result

    def _qa_view(item: dict, known: set) -> dict:
        return {**item, "answer_html": render_markdown(item.get("answer_markdown") or "", known)}

    def _known(result: dict) -> set:
        return {s.get("sid") for s in result.get("sources") or []}

    def _inside_data(path: Path) -> Path:
        # 확장 길이 경로(\\?\…)여도 같은 폴더로 비교한다 (server.runs.is_inside)
        if not any(is_inside(path, r) for r in roots):
            raise RunError("export_failed", "결과물 경로가 올바르지 않습니다.", 500)
        return path

    # ── 설정 · 키 ──
    @app.get("/api/config")
    def get_config():
        return {**static_config, "server_key": bool(os.environ.get("ANTHROPIC_API_KEY"))}

    @app.post("/api/key/check")
    def key_check(body: KeyBody | None = None):
        key = ((body.api_key if body else None) or "").strip() or None
        if not key and not os.environ.get("ANTHROPIC_API_KEY"):
            return {"ok": False, "error": {"code": "no_api_key", "message": "API 키가 없습니다. 키를 입력해 주세요."}}
        if not key_format_ok(key):
            return {"ok": False, "error": {"code": "auth", "message": "API 키 형식이 올바르지 않습니다. 복사한 키를 다시 확인해 주세요."}}
        if manager.demo:           # 데모 모드는 API를 호출하지 않는다
            return {"ok": True, "models": [m.id for m in MODELS], "demo": True}
        from agent.llm import LLMError, list_models
        try:
            return {"ok": True, "models": list_models(key)}
        except LLMError as e:
            return {"ok": False, "error": {"code": e.code, "message": e.message}}

    # ── 실행 ──
    @app.post("/api/runs", status_code=201)
    def create_run(body: CreateBody):
        d = dict(body.options or {})
        d.pop("api_key", None)
        for k in ("depth", "model", "language", "human_in_the_loop", "formats"):
            if getattr(body, k) is not None:
                d[k] = getattr(body, k)
        if "year_from" in body.model_fields_set:
            d["year_from"] = body.year_from
        if d.get("model") is not None and not (isinstance(d["model"], str) and MODEL_RE.match(d["model"])):
            raise RunError("invalid_model", "모델 이름이 올바르지 않습니다.", 400)
        run = manager.create(body.prompt, RunConfig.from_dict(d), body.api_key)
        return JSONResponse({"id": run.id, "status": run.snapshot()}, status_code=201)

    @app.get("/api/runs")
    def list_runs():
        return {"runs": manager.list()}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str):
        return _run(run_id).snapshot()

    @app.get("/api/runs/{run_id}/events")
    def get_events(run_id: str, after: int = Query(0, ge=0), preview_from: int = Query(0, ge=0)):
        run = _run(run_id)
        events = manager.events(run_id, after)[:1000]
        return {"events": events, "next": events[-1]["seq"] if events else after,
                "status": run.snapshot(), "preview": run.preview(preview_from)}

    @app.post("/api/runs/{run_id}/plan")
    def submit_plan(run_id: str, body: PlanBody):
        _run(run_id)
        if not manager.submit_plan(run_id, body.model_dump(exclude_none=True)):
            raise RunError("not_awaiting", "지금은 계획 검토를 기다리는 중이 아닙니다.", 409)
        return {"ok": True}

    @app.post("/api/runs/{run_id}/cancel")
    def cancel_run(run_id: str):
        _run(run_id)
        return {"ok": manager.cancel(run_id)}

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str):
        _run(run_id)
        manager.delete(run_id)
        return {"ok": True}

    @app.get("/api/runs/{run_id}/result")
    def get_result(run_id: str):
        result = _result(run_id)
        frag = render_fragment(result)
        known = _known(result)
        return {**result, "report_html": frag["html"], "toc": frag["toc"],
                "exports": manager.exports_status(_run(run_id)),
                "qa": [_qa_view(it, known) for it in manager.qa_items(run_id)]}

    @app.get("/api/runs/{run_id}/export/{fmt}")
    def get_export(run_id: str, fmt: str, inline: int = 0, print_: int = Query(0, alias="print")):
        if fmt not in FORMAT_IDS and fmt != "zip":
            raise RunError("invalid_format", "알 수 없는 형식입니다.", 400)
        if fmt == "html" and print_:
            html = build_html(_result(run_id), auto_print=True)
            return HTMLResponse(html, headers={**NO_CACHE, "Content-Security-Policy": CSP_PRINT})
        _run(run_id)
        path = _inside_data(manager.export(run_id, fmt))
        name = manager.download_name(run_id, fmt)          # 캐시 파일은 짧은 이름, 내려받기 이름은 한글 주제
        if fmt == "html" and inline:
            return FileResponse(path, media_type=MIME[fmt], filename=name, content_disposition_type="inline",
                                headers={**NO_CACHE, "Content-Security-Policy": CSP_VIEW})
        return FileResponse(path, media_type=MIME[fmt], filename=name, headers=NO_CACHE)

    @app.post("/api/runs/{run_id}/slides")
    def regen_slides(run_id: str, body: SlidesBody | None = None):
        _result(run_id)
        llm_used = manager.regen_slides(run_id, body.api_key if body else None, body.model if body else None)
        return {"ok": True, "llm": llm_used}

    @app.get("/api/runs/{run_id}/qa")
    def get_qa(run_id: str):
        result = _result(run_id)
        known = _known(result)
        return {"items": [_qa_view(it, known) for it in manager.qa_items(run_id)]}

    @app.post("/api/runs/{run_id}/qa")
    def ask(run_id: str, body: AskBody):
        result = _result(run_id)
        if body.model is not None and not MODEL_RE.match(body.model):
            raise RunError("invalid_model", "모델 이름이 올바르지 않습니다.", 400)
        item = manager.ask(run_id, body.question, body.api_key, body.model)
        return _qa_view(item, _known(result))

    # ── 정적 파일 ──
    @app.get("/")
    def index():
        page = WEB_DIR / "index.html"
        if page.is_file():
            return FileResponse(page, media_type=STATIC_TYPES[".html"], headers=NO_CACHE)
        return HTMLResponse(PLACEHOLDER, headers=NO_CACHE)

    @app.get("/assets/{path:path}")
    def assets(path: str):
        base = (WEB_DIR / "assets").resolve()
        target = (base / path).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise RunError("not_found", "파일을 찾을 수 없습니다.", 404)
        mime = STATIC_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return FileResponse(target, media_type=mime, headers=NO_CACHE)

    return app

"""Claude 호출 래퍼: 구조화 출력, 스트리밍, 사용량 집계, 거절(refusal) 시 서버측 fallback, 오류 변환.

노트북 셀 ③의 LLM 클래스를 옮기고 SPEC 4.2의 규칙을 반영했다.
- 모든 요청에 output_config의 effort를 명시한다. thinking·temperature·tool_choice는 보내지 않는다.
- fallback은 get_model(model).supports_fallback이 참인 모델만 beta 경로로 호출한다.
"""
from __future__ import annotations

import json
import threading

import anthropic

from agent.models import get_model

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class RunCancelled(Exception):
    """사용자가 실행을 취소했을 때 던지는 예외."""


class LLMError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 오류. code: auth|permission|model|rate_limit|billing|bad_request|
    connection|server|refusal|unknown"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


_MSG_SERVER = "Anthropic 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요."
_MSG_BILLING = "크레딧이 부족합니다. Anthropic 콘솔에서 결제 상태를 확인해 주세요."

# API 오류 유형(error.type) → (code, 메시지)
_ERROR_TYPES = {
    "overloaded_error": ("server", _MSG_SERVER),
    "api_error": ("server", _MSG_SERVER),
    "rate_limit_error": ("rate_limit", "요청이 너무 많아 속도 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요."),
    "billing_error": ("billing", _MSG_BILLING),
    "authentication_error": ("auth", "API 키가 올바르지 않습니다. 키를 다시 확인해 주세요."),
    "permission_error": ("permission", "이 API 키로는 이 요청을 할 권한이 없습니다."),
    "not_found_error": ("model", "모델을 찾을 수 없거나 이 키로 사용할 수 없습니다."),
}

_TRANSPORT_MODULES = ("httpx", "httpx2", "httpcore")


def _api_error_type(exc) -> str | None:
    """예외의 type 속성, 없으면 body["error"]["type"]."""
    t = getattr(exc, "type", None)
    if isinstance(t, str) and t:
        return t
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and isinstance(err.get("type"), str):
            return err["type"]
    return None


def _is_transport_error(exc) -> bool:
    """스트림 도중 HTTP 라이브러리가 직접 던진 예외(anthropic 예외로 감싸지지 않음)나 내장 연결/시간 초과 오류."""
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return True
    for cls in type(exc).__mro__:
        root = (getattr(cls, "__module__", "") or "").split(".")[0]
        if root in _TRANSPORT_MODULES:
            return True
    return False


def friendly_error(exc: Exception) -> LLMError:
    """anthropic 예외를 한국어 메시지로 바꾼다. 하위 클래스가 먼저 걸리도록 가장 구체적인 클래스부터 검사한다.
    메시지에 API 키나 요청 본문은 넣지 않는다."""
    if isinstance(exc, LLMError):
        return exc
    text = str(exc).lower()
    if isinstance(exc, anthropic.APIStatusError):
        # 스트림 도중의 error 이벤트는 상태 코드가 200일 수 있으므로 API 오류 유형을 먼저 본다.
        mapped = _ERROR_TYPES.get(_api_error_type(exc))
        if mapped:
            return LLMError(*mapped)
    if isinstance(exc, anthropic.AuthenticationError):
        return LLMError("auth", "API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return LLMError("permission", "이 API 키로는 이 요청을 할 권한이 없습니다.")
    if isinstance(exc, anthropic.NotFoundError):
        return LLMError("model", "모델을 찾을 수 없거나 이 키로 사용할 수 없습니다.")
    if isinstance(exc, anthropic.RateLimitError):
        return LLMError("rate_limit", "요청이 너무 많아 속도 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.")
    if isinstance(exc, anthropic.BadRequestError):
        if "credit" in text:
            return LLMError("billing", "크레딧이 부족합니다. Anthropic 콘솔에서 결제 상태를 확인해 주세요.")
        if "data retention" in text:
            return LLMError("bad_request", "이 모델은 조직의 데이터 보존 설정이 필요합니다. "
                                           "데이터 보존 기간이 30일 미만이면 사용할 수 없으니 다른 모델을 선택해 주세요.")
        return LLMError("bad_request", "요청 형식이 올바르지 않습니다(400). 설정을 바꿔 다시 시도해 주세요.")
    if isinstance(exc, anthropic.APIStatusError):
        status = getattr(exc, "status_code", 0) or 0
        if status == 402:
            return LLMError("billing", "크레딧이 부족합니다. Anthropic 콘솔에서 결제 상태를 확인해 주세요.")
        if status >= 500:
            return LLMError("server", "Anthropic 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.")
        return LLMError("unknown", f"API 오류가 발생했습니다(상태 코드 {status}).")
    if isinstance(exc, anthropic.APIConnectionError) or _is_transport_error(exc):
        return LLMError("connection", "Anthropic API에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.")
    return LLMError("unknown", f"알 수 없는 오류가 발생했습니다({type(exc).__name__}).")


def list_models(api_key: str | None) -> list[str]:
    """키 확인용: 이 키로 쓸 수 있는 모델 id 목록. 실패하면 LLMError."""
    try:
        client = anthropic.Anthropic(api_key=api_key or None, max_retries=1)
        return [m.id for m in client.models.list()]
    except Exception as e:
        raise friendly_error(e) from None


def _btype(block):
    return block.get("type") if isinstance(block, dict) else getattr(block, "type", "")


class LLM:
    """Claude 호출 래퍼: 구조화 출력, 사용량 집계, 거절(refusal) 시 서버측 fallback."""

    def __init__(self, api_key: str | None, model: str, on_warning=None):
        try:
            self.client = anthropic.Anthropic(api_key=api_key or None, max_retries=4)
        except anthropic.AnthropicError:
            raise LLMError("auth", "API 키가 설정되지 않았습니다.") from None
        self.model = model
        info = get_model(model)
        self.use_fallback = bool(info and info.supports_fallback)   # 목록에 없는 모델은 fallback 없이 호출
        self.on_warning = on_warning
        self.usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0}
        self._lock = threading.Lock()

    def _warn(self, msg):
        if self.on_warning:
            self.on_warning(msg)

    @staticmethod
    def _send(api, stream, on_delta, kw):
        """api = client.messages 또는 client.beta.messages. 스트리밍이면 조각을 on_delta로 넘기고 최종 메시지를 반환."""
        if not stream:
            return api.create(**kw)
        with api.stream(**kw) as s:
            if on_delta:
                for t in s.text_stream:
                    on_delta(t)     # on_delta가 RunCancelled를 던지면 그대로 전파
            return s.get_final_message()

    def _create(self, stream=False, on_delta=None, **kw):
        kw.setdefault("model", self.model)
        if self.use_fallback:
            try:
                extra = dict(betas=[FALLBACK_BETA], fallbacks="default")
                return self._track(self._send(self.client.beta.messages, stream, on_delta, {**kw, **extra}))
            except (anthropic.BadRequestError, TypeError) as e:
                if "fallback" not in str(e).lower():
                    raise
                self.use_fallback = False  # 이 계정/환경에서 미지원 → 일반 호출로 전환
                self._warn("서버측 fallback을 쓸 수 없어 일반 호출로 전환합니다.")
        return self._track(self._send(self.client.messages, stream, on_delta, kw))

    @staticmethod
    def _tokens(u):
        """(input, output). 서버측 fallback에서는 최상위 usage가 최종 시도만 담으므로,
        usage.iterations가 토큰 필드를 가진 비어 있지 않은 목록이면 그 합을 쓴다."""
        def get(o, k):
            return (o.get(k) if isinstance(o, dict) else getattr(o, k, None))

        its = get(u, "iterations") if u is not None else None
        if isinstance(its, (list, tuple)) and its and all(
                isinstance(get(i, "input_tokens"), int) and isinstance(get(i, "output_tokens"), int) for i in its):
            return sum(get(i, "input_tokens") for i in its), sum(get(i, "output_tokens") for i in its)
        return (getattr(u, "input_tokens", 0) or 0), (getattr(u, "output_tokens", 0) or 0)

    def _track(self, resp):
        inp, out = self._tokens(getattr(resp, "usage", None))
        with self._lock:
            self.usage["calls"] += 1
            self.usage["input_tokens"] += inp
            self.usage["output_tokens"] += out
        return resp

    @staticmethod
    def text_of(resp) -> str:
        return "".join(b.text for b in resp.content if _btype(b) == "text").strip()

    @staticmethod
    def echo_content(resp) -> list:
        """다음 요청의 assistant 턴으로 되돌려 보낼 content.
        fallback 블록이 있으면 마지막 fallback 블록보다 앞의 thinking·redacted_thinking·tool_use 블록을 뺀다."""
        content = list(resp.content)
        last = max((i for i, b in enumerate(content) if _btype(b) == "fallback"), default=None)
        if last is None:
            return resp.content
        drop = ("thinking", "redacted_thinking", "tool_use")
        return [b for i, b in enumerate(content) if not (i < last and _btype(b) in drop)]

    def text(self, system, prompt, effort="medium", max_tokens=16000, stream=False, on_delta=None) -> str:
        resp = self._create(stream=stream, on_delta=on_delta, system=system, max_tokens=max_tokens,
                            output_config={"effort": effort},
                            messages=[{"role": "user", "content": prompt}])
        if resp.stop_reason == "refusal":
            raise LLMError("refusal", "모델이 이 요청을 거절했습니다(refusal). 주제나 표현을 바꿔 다시 시도해 주세요.")
        if resp.stop_reason == "max_tokens":
            self._warn("출력 길이 한도(max_tokens)에 도달해 글이 중간에 잘렸을 수 있습니다.")
        return self.text_of(resp)

    def json(self, system, prompt, schema, effort="medium", max_tokens=16000) -> dict | None:
        resp = self._create(system=system, max_tokens=max_tokens,
                            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
                            messages=[{"role": "user", "content": prompt}])
        if resp.stop_reason in ("refusal", "max_tokens"):
            self._warn(f"구조화 출력 실패(stop_reason={resp.stop_reason})")
            return None
        try:
            return json.loads(self.text_of(resp))
        except json.JSONDecodeError:
            self._warn("구조화 출력을 JSON으로 읽지 못했습니다.")
            return None

    def tool_turn(self, system, messages, tools, effort="low", max_tokens=8000):
        """도구 호출 1턴. 응답 객체를 그대로 반환한다(거절이면 도구 호출이 없는 응답으로 처리됨)."""
        resp = self._create(system=system, messages=messages, tools=tools, max_tokens=max_tokens,
                            output_config={"effort": effort})
        if resp.stop_reason == "refusal":
            self._warn("모델이 이 요청을 거절했습니다(refusal).")
        return resp

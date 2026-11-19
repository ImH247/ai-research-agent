"""모델 목록 · 가격 · 조사 깊이 프리셋 · 실행 설정(RunConfig).

모델 ID와 가격은 Anthropic 공개 문서(2026-11-03 기준)에서 옮긴 값이다. 가격이 바뀌면 이 파일만 고치면 된다.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime

APP_NAME = "AI Research Agent"
APP_VERSION = "1.0.0"
PRICING_AS_OF = "2026-11-03"
CURRENT_YEAR = datetime.now().year


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    tagline: str                 # 한 줄 설명 (모델 선택 카드)
    description: str             # 조금 더 긴 설명 (툴팁)
    input_per_mtok: float        # USD / 100만 입력 토큰
    output_per_mtok: float       # USD / 100만 출력 토큰 (사고 토큰 포함)
    supports_fallback: bool      # 거절(refusal) 시 서버측 fallback 지원 여부
    badge: str = ""              # "추천" 등

    def to_dict(self):
        return asdict(self)


MODELS: list[ModelInfo] = [
    ModelInfo("claude-opus-5-5", "Claude Opus 5.5", "깊은 분석과 비용의 균형",
              "장시간 에이전트 작업과 지식 작업용 최신 Opus. 이 에이전트의 기본 모델이며 중간고사 실행에 사용한 모델입니다.",
              4.0, 20.0, True, "추천"),
    ModelInfo("claude-sonnet-5-5", "Claude Sonnet 5.5", "빠르고 경제적",
              "속도와 성능의 균형이 좋은 최신 Sonnet. Opus 5.5의 절반 가격으로 일상적인 조사에 적합합니다.",
              2.0, 10.0, True),
    ModelInfo("claude-haiku-5-5", "Claude Haiku 5.5", "가장 빠르고 저렴",
              "가장 빠르고 저렴한 모델. 가벼운 탐색이나 시험 실행에 적합합니다. (가격은 프롬프트 10만 토큰 이하 기준)",
              0.10, 0.50, False),
    ModelInfo("claude-fable-5-2", "Claude Fable 5.2", "최고 성능 · 높은 비용",
              "가장 성능이 높은 모델. 가장 어려운 주제에 사용하세요. Opus 5.5의 2배 가격이며, "
              "조직의 데이터 보존 설정이 30일 미만이면 사용할 수 없습니다.",
              8.0, 40.0, True),
]
DEFAULT_MODEL = "claude-opus-5-5"
_BY_ID = {m.id: m for m in MODELS}


def get_model(model_id: str) -> ModelInfo | None:
    return _BY_ID.get(model_id)


def model_label(model_id: str) -> str:
    m = _BY_ID.get(model_id)
    return m.label if m else model_id


def estimate_cost(model_id: str, input_tokens: int, output_tokens: int) -> float | None:
    """토큰 수로 계산한 대략의 비용(USD). 목록에 없는 모델은 None."""
    m = _BY_ID.get(model_id)
    if not m:
        return None
    return round(input_tokens * m.input_per_mtok / 1e6 + output_tokens * m.output_per_mtok / 1e6, 4)


# ── 조사 깊이 프리셋 ──
# "standard"는 중간고사 노트북의 기본값과 같다. 토큰 추정치는 2026-11-02 실제 실행 2회
# (Claude Opus 5.5, 순차 실행: 79회/419k in/135k out/23.8분, 75회/432k in/113k out/20.8분)의 평균에서 가져왔고,
# quick/deep은 그 값에 비례해 잡은 대략치다(실측 아님).
DEPTH_PRESETS: dict[str, dict] = {
    "quick": {
        "label": "빠르게", "description": "하위 질문 3~4개, 재조사 없음. 주제를 가볍게 훑어볼 때",
        "config": {"min_subq": 3, "max_subq": 4, "max_reflection_rounds": 0, "max_tool_steps": 2,
                   "results_per_search": 5, "verify_sample": 6},
        "estimate": {"llm_calls": 30, "input_tokens": 150_000, "output_tokens": 45_000, "minutes": [5, 9], "measured": False},
    },
    "standard": {
        "label": "표준", "description": "하위 질문 4~6개, 자기 비판 후 최대 2회 재조사. 중간고사 실행과 같은 설정",
        "config": {"min_subq": 4, "max_subq": 6, "max_reflection_rounds": 2, "max_tool_steps": 4,
                   "results_per_search": 6, "verify_sample": 10},
        "estimate": {"llm_calls": 77, "input_tokens": 425_000, "output_tokens": 125_000, "minutes": [12, 24], "measured": True},
    },
    "deep": {
        "label": "깊게", "description": "하위 질문 5~7개, 최대 3회 재조사, 검색·검증 범위 확대. 시간과 비용이 가장 큼",
        "config": {"min_subq": 5, "max_subq": 7, "max_reflection_rounds": 3, "max_tool_steps": 5,
                   "results_per_search": 8, "verify_sample": 15},
        "estimate": {"llm_calls": 125, "input_tokens": 720_000, "output_tokens": 210_000, "minutes": [20, 40], "measured": False},
    },
}
DEFAULT_DEPTH = "standard"

# 사용자가 바꿀 수 있는 값의 허용 범위 (서버가 이 범위로 잘라 낸다)
LIMITS: dict[str, tuple[int, int]] = {
    "min_subq": (2, 8), "max_subq": (2, 8), "max_reflection_rounds": (0, 4), "max_tool_steps": (1, 6),
    "results_per_search": (3, 10), "verify_sample": (0, 30), "parallelism": (1, 6), "year_from": (1900, CURRENT_YEAR),
}
LANGUAGES = ("auto", "ko", "en")


@dataclass
class RunConfig:
    """실행 1회의 설정. 노트북 맨 위 셀의 '선택 설정'에 해당한다."""
    model: str = DEFAULT_MODEL
    depth: str = DEFAULT_DEPTH
    min_subq: int = 4
    max_subq: int = 6
    max_reflection_rounds: int = 2        # 자기 비판 → 재계획 → 추가 조사 반복 최대 횟수
    max_tool_steps: int = 4               # 하위 질문 하나당 검색 도구 호출 라운드 최대 횟수
    results_per_search: int = 6           # 검색 1회당 가져올 문헌 수
    verify_sample: int = 10               # 인용 검증할 문장 수
    year_from: int | None = None          # None: 에이전트가 결정 / 0: 제한 없음 / 2020: 2020년 이후만
    language: str = "auto"                # 보고서 언어: auto | ko | en
    human_in_the_loop: bool = False       # True면 조사 계획을 사람이 검토·수정한 뒤 진행
    parallelism: int = 3                  # 동시에 실행할 LLM 호출 수 (1이면 노트북처럼 순차 실행)
    formats: list[str] = field(default_factory=lambda: ["md"])   # 실행이 끝나면 자동으로 만들 결과물
    openalex_email: str = ""

    @classmethod
    def from_dict(cls, d: dict | None) -> "RunConfig":
        """요청 값을 검증해 RunConfig로 만든다. depth 프리셋을 먼저 적용하고, 개별 값이 있으면 덮어쓴다.
        알 수 없는 키는 무시하고, 범위를 벗어난 숫자는 LIMITS 안으로 자른다."""
        d = dict(d or {})
        cfg = cls()
        depth = d.get("depth") if d.get("depth") in DEPTH_PRESETS else DEFAULT_DEPTH
        cfg.depth = depth
        for k, v in DEPTH_PRESETS[depth]["config"].items():
            setattr(cfg, k, v)
        if isinstance(d.get("model"), str) and d["model"].strip():
            cfg.model = d["model"].strip()
        for k, (lo, hi) in LIMITS.items():
            if k == "year_from" or d.get(k) is None:
                continue
            try:
                setattr(cfg, k, max(lo, min(hi, int(d[k]))))
            except (TypeError, ValueError):
                pass
        cfg.max_subq = max(cfg.max_subq, cfg.min_subq)
        y = d.get("year_from")
        if y in (None, ""):
            cfg.year_from = None
        else:
            try:
                y = int(y)
                cfg.year_from = 0 if y <= 0 else max(LIMITS["year_from"][0], min(LIMITS["year_from"][1], y))
            except (TypeError, ValueError):
                cfg.year_from = None
        if d.get("language") in LANGUAGES:
            cfg.language = d["language"]
        cfg.human_in_the_loop = bool(d.get("human_in_the_loop", False))
        if isinstance(d.get("formats"), list):
            cfg.formats = [str(f) for f in d["formats"] if isinstance(f, str)][:12] or ["md"]
        if isinstance(d.get("openalex_email"), str):
            cfg.openalex_email = d["openalex_email"].strip()[:120]
        return cfg

    def to_dict(self) -> dict:
        return asdict(self)

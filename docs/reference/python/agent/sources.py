"""수집 문헌(Source)과 저장소(EvidenceStore). 노트북 셀 ④의 같은 이름 코드를 옮겼다.

변경점: Source.to_dict()/from_dict() 추가, EvidenceStore.add()를 잠금으로 보호(하위 질문을 병렬로 탐색함).
"""
from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass, field, fields


@dataclass
class Source:
    title: str
    authors: list
    year: int | None
    venue: str
    abstract: str
    url: str
    doi: str = ""
    citations: int | None = None
    origin: str = ""          # 어느 도구에서 왔는지
    kind: str = "academic"    # peer-reviewed | academic | preprint | web
    sid: str = ""
    queries: set = field(default_factory=set)
    subqs: set = field(default_factory=set)
    evaluated: bool = False
    relevance: int = 0        # 0~3 (LLM)
    credibility: float = 0.0  # 0~1 (규칙)
    score: float = 0.0        # 종합 점수
    study_type: str = ""
    method: str = ""
    sample: str = ""
    key_finding: str = ""
    direction: str = ""
    limitation: str = ""

    def short_cite(self):
        names = [n for n in self.authors if n and n.split()]
        parts = names[0].replace(",", " ").split() if names else []
        # "John Smith" → Smith, "Kim J"(Europe PMC 형식) → Kim
        a = (parts[-1] if len(parts[-1].strip(".")) > 2 or len(parts) == 1 else parts[0]) if parts else (self.venue or "n.a.")
        etal = " et al." if len(names) > 1 else ""
        return f"{a}{etal} ({self.year or 'n.d.'})"

    def to_dict(self) -> dict:
        """JSON으로 저장할 dict. sid를 맨 앞에 두고, set은 정렬된 list로 바꾼다."""
        d = {"sid": self.sid}
        for f in fields(self):
            if f.name != "sid":
                d[f.name] = getattr(self, f.name)
        d["authors"] = list(self.authors or [])
        d["queries"] = sorted(self.queries)
        d["subqs"] = sorted(self.subqs, key=lambda q: (len(q), q))   # Q2가 Q10보다 앞
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Source":
        """to_dict()의 역변환. 모르는 키(included, cited 등)는 무시한다."""
        names = {f.name for f in fields(cls)}
        kw = {k: v for k, v in d.items() if k in names}
        for k in ("title", "venue", "abstract", "url"):
            kw.setdefault(k, "")
        kw.setdefault("authors", [])
        kw.setdefault("year", None)
        kw["queries"] = set(kw.get("queries") or [])
        kw["subqs"] = set(kw.get("subqs") or [])
        return cls(**kw)


KIND_RANK = {"web": 0, "preprint": 1, "academic": 2, "peer-reviewed": 3}
_SITE_SUFFIX = re.compile(r"\s+[-|–—]\s+[^-|–—]{2,40}$")   # 웹 제목 끝의 "- SSRN", "| ScienceDirect" 등
_ELLIPSIS = re.compile(r"\s*(\.\.\.|…)\s*$")


def _norm_title(t, web=False):
    """제목 정규화 → (키, 잘림 여부). 합자(ﬀ)·사이트명 꼬리·말줄임표 차이로 같은 문헌이 따로 저장되는 것을 막음."""
    t = unicodedata.normalize("NFKC", t or "").strip()
    if web:
        t = _SITE_SUFFIX.sub("", t)
    truncated = bool(_ELLIPSIS.search(t))
    return re.sub(r"[^a-z0-9가-힣]", "", _ELLIPSIS.sub("", t).lower())[:120], truncated


def _sid_num(sid):
    return int(sid[1:]) if sid[1:].isdigit() else 0


class EvidenceStore:
    """수집 문헌 저장소: DOI/제목 기준 중복(같은 문헌의 여러 판본) 병합, S1, S2 ... ID 부여.
    add()와 목록 조회는 잠금 아래에서 하므로 여러 스레드가 동시에 써도 된다."""

    def __init__(self):
        self.items: dict[str, Source] = {}
        self._dois = {}
        self._titles = {}   # 제목 키 → (sid, 잘린 제목 여부)
        self.merged = 0     # 기존 문헌과 같은 것으로 판정되어 병합된 검색 결과 수
        self._lock = threading.RLock()

    def _match(self, doi, tkey, truncated):
        if doi and doi in self._dois:
            return self._dois[doi]
        if tkey in self._titles:
            return self._titles[tkey][0]
        if len(tkey) >= 35:  # "제목 앞부분 ..." 처럼 잘린 웹 제목은 앞부분이 같으면 같은 문헌
            for k, (sid, trunc) in self._titles.items():
                if (truncated and k.startswith(tkey)) or (trunc and tkey.startswith(k)):
                    return sid
        return None

    def add(self, src: Source, query="", subq=""):
        if not src.title:
            return None
        with self._lock:
            src.authors = [a.strip() for a in (src.authors or []) if a and a.strip()]
            doi = (src.doi or "").lower().replace("https://doi.org/", "")
            tkey, truncated = _norm_title(src.title, web=src.kind == "web")
            existing = self._match(doi, tkey, truncated)
            if existing:
                s = self.items[existing]
                self.merged += 1
                if not s.evaluated and KIND_RANK.get(src.kind, 0) > KIND_RANK.get(s.kind, 0):
                    # 웹 사본보다 학술 판본의 서지 정보를 우선 사용
                    s.title, s.venue, s.url, s.kind, s.origin = src.title, src.venue, src.url, src.kind, src.origin
                    s.authors, s.year = src.authors or s.authors, src.year or s.year
                if len(src.abstract or "") > len(s.abstract or ""):
                    s.abstract = src.abstract
                s.citations = max(s.citations or 0, src.citations or 0) or s.citations
                s.doi = s.doi or src.doi
            else:
                src.sid = f"S{len(self.items) + 1}"
                self.items[src.sid] = s = src
            if doi:
                self._dois.setdefault(doi, s.sid)
            if tkey:
                self._titles.setdefault(tkey, (s.sid, truncated))
            if query:
                s.queries.add(query)
            if subq:
                s.subqs.add(subq)
            return s

    def __len__(self):
        return len(self.items)

    def sources(self) -> list[Source]:
        """수집 문헌 전부를 S 번호순으로 (다른 스레드가 추가하는 중에도 안전한 복사본)."""
        with self._lock:
            return sorted(self.items.values(), key=lambda s: _sid_num(s.sid))

    def included(self):
        return sorted([s for s in self.sources() if s.evaluated and s.relevance >= 2],
                      key=lambda s: -s.score)

"""검색 도구(Tools): 학술 DB·웹 검색 — 모두 API 키 불필요. 노트북 셀 ④를 옮겼다.

변경점: 시그니처 search_xxx(query, limit=6, year_from=None, email=""), 호출마다 requests.get(User-Agent 헤더).
"""
from __future__ import annotations

import random
import re
import threading
import time

import requests

from agent.models import CURRENT_YEAR
from agent.schema import O
from agent.sources import Source

HEADERS = {"User-Agent": "EduResearchAgent/1.0 (AI agent class project)"}


def http_get(url, params, as_json=True, retries=3, timeout=25):
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
            if r.status_code == 429:  # 속도 제한 → 지수 백오프
                time.sleep(2 ** (i + 1) + random.random())
                last = RuntimeError("429 rate limited")
                continue
            r.raise_for_status()
            return r.json() if as_json else r.text
        except Exception as e:
            last = e
            time.sleep(1 + i)
    raise RuntimeError(f"요청 실패: {last}")


def _openalex_abstract(inv):
    if not inv:
        return ""
    pos = sorted((p, w) for w, ps in inv.items() for p in ps)
    return " ".join(w for _, w in pos)


def search_openalex(query, limit=6, year_from=None, email=""):
    params = {"search": query, "per-page": limit,
              "select": "doi,title,publication_year,primary_location,authorships,cited_by_count,abstract_inverted_index,type,id"}
    if year_from:
        params["filter"] = f"from_publication_date:{year_from}-01-01"
    if email:
        params["mailto"] = email
    out = []
    for w in http_get("https://api.openalex.org/works", params).get("results", []):
        src = (w.get("primary_location") or {}).get("source") or {}
        stype = src.get("type") or ""
        kind = "preprint" if (w.get("type") == "preprint" or stype == "repository") else \
               "peer-reviewed" if stype in ("journal", "conference") else "academic"
        out.append(Source(
            title=w.get("title") or "", year=w.get("publication_year"), venue=src.get("display_name") or "",
            authors=[a["author"]["display_name"] for a in (w.get("authorships") or [])[:6] if a.get("author")],
            abstract=_openalex_abstract(w.get("abstract_inverted_index")), doi=w.get("doi") or "",
            url=w.get("doi") or w.get("id") or "", citations=w.get("cited_by_count"), origin="OpenAlex", kind=kind))
    return out


def search_semantic_scholar(query, limit=6, year_from=None, email=""):
    params = {"query": query, "limit": limit,
              "fields": "title,abstract,year,venue,authors,citationCount,externalIds,url,publicationTypes"}
    if year_from:
        params["year"] = f"{year_from}-"
    out = []
    for p in http_get("https://api.semanticscholar.org/graph/v1/paper/search", params).get("data", []) or []:
        types = p.get("publicationTypes") or []
        venue = p.get("venue") or ""
        kind = "preprint" if "arxiv" in venue.lower() else \
               "peer-reviewed" if ("JournalArticle" in types or "Conference" in types) else "academic"
        doi = (p.get("externalIds") or {}).get("DOI") or ""
        out.append(Source(
            title=p.get("title") or "", year=p.get("year"), venue=venue,
            authors=[a.get("name", "") for a in (p.get("authors") or [])[:6]],
            abstract=p.get("abstract") or "", doi=f"https://doi.org/{doi}" if doi else "",
            url=p.get("url") or "", citations=p.get("citationCount"), origin="SemanticScholar", kind=kind))
    return out


def search_arxiv(query, limit=6, year_from=None, email=""):
    import xml.etree.ElementTree as ET
    ns = {"a": "http://www.w3.org/2005/Atom"}
    time.sleep(3)  # arXiv API 권장: 요청 간 3초 간격 (안 지키면 429)
    xml = http_get("https://export.arxiv.org/api/query",
                   {"search_query": f"all:{query}", "max_results": limit, "sortBy": "relevance"},
                   as_json=False, retries=2, timeout=60)
    out = []
    for e in ET.fromstring(xml).findall("a:entry", ns):
        year = int((e.findtext("a:published", "", ns) or "0")[:4] or 0) or None
        if year_from and year and year < year_from:
            continue
        out.append(Source(
            title=" ".join((e.findtext("a:title", "", ns) or "").split()), year=year, venue="arXiv",
            authors=[a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)][:6],
            abstract=" ".join((e.findtext("a:summary", "", ns) or "").split()),
            url=e.findtext("a:id", "", ns), origin="arXiv", kind="preprint"))
    return out


def search_europe_pmc(query, limit=6, year_from=None, email=""):
    q = f"({query})" + (f" AND PUB_YEAR:[{year_from} TO {CURRENT_YEAR}]" if year_from else "")
    data = http_get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                    {"query": q, "format": "json", "resultType": "core", "pageSize": limit})
    out = []
    for r in data.get("resultList", {}).get("result", []):
        doi = r.get("doi") or ""
        out.append(Source(
            title=r.get("title") or "", year=int(r["pubYear"]) if r.get("pubYear") else None,
            venue=((r.get("journalInfo") or {}).get("journal") or {}).get("title", "") or r.get("source", ""),
            authors=[a.strip() for a in (r.get("authorString") or "").split(",")][:6],
            abstract=re.sub(r"<[^>]+>", "", r.get("abstractText") or ""),
            doi=f"https://doi.org/{doi}" if doi else "",
            url=f"https://doi.org/{doi}" if doi else f"https://europepmc.org/article/{r.get('source')}/{r.get('id')}",
            citations=r.get("citedByCount"), origin="EuropePMC",
            kind="preprint" if r.get("source") == "PPR" else "peer-reviewed"))
    return out


def search_web(query, limit=6, year_from=None, email=""):
    # 웹 결과는 출판 연도를 알 수 없어 기간 필터 대신 평가 단계의 포함 기준(검색 기간 포함)으로 거름
    try:
        from ddgs import DDGS
    except ImportError:
        from duckduckgo_search import DDGS
    try:
        hits = DDGS().text(query, max_results=limit) or []
    except Exception as e:
        if "no results" in str(e).lower():  # 결과 0건은 오류가 아니라 빈 결과
            return []
        raise
    out = []
    for r in hits:
        out.append(Source(title=r.get("title", ""), authors=[], year=None, venue=re.sub(r"^https?://([^/]+).*", r"\1", r.get("href", "")),
                          abstract=r.get("body", ""), url=r.get("href", ""), origin="Web", kind="web"))
    return out


TOOL_FUNCS = {
    "search_openalex": search_openalex,
    "search_semantic_scholar": search_semantic_scholar,
    "search_arxiv": search_arxiv,
    "search_europe_pmc": search_europe_pmc,
    "search_web": search_web,
}
TOOL_DESC = {
    "search_openalex": "OpenAlex: 2억+ 학술문헌, 전 분야(사회과학·교육·경영·공학 등). 기본 검색 도구로 가장 먼저 사용. 영어 키워드 권장.",
    "search_semantic_scholar": "Semantic Scholar: 전 분야 학술문헌, 특히 CS/AI에 강함, 피인용 수 제공. 영어 키워드.",
    "search_arxiv": "arXiv: 최신 프리프린트(CS, AI, 물리, 수학, 통계, 경제). 동료심사 전 최신 동향 확인용.",
    "search_europe_pmc": "Europe PMC: 의학·생명과학·보건·심리 문헌(PubMed 포함). 건강·의료·임상 관련 질문에 사용.",
    "search_web": "웹 검색(DuckDuckGo): 정책보고서, 기관 통계, 뉴스, 회색문헌, 한국어 자료. 학술 DB에 없는 맥락·최신 사례 확인용.",
}
TOOL_LABELS = {"search_openalex": "OpenAlex", "search_semantic_scholar": "Semantic Scholar", "search_arxiv": "arXiv",
               "search_europe_pmc": "Europe PMC", "search_web": "웹 검색"}
# 같은 DB는 순차 호출(속도 제한 준수), 다른 DB끼리는 병렬. 실행 여러 건이 함께 쓰는 프로세스 전역 잠금
TOOL_LOCKS = {n: threading.Lock() for n in TOOL_FUNCS}
TOOLS = [{"name": n, "description": d, "strict": True,
          "input_schema": O(query={"type": "string", "description": "검색어 (학술 DB는 영어 키워드 3~8단어 권장)"})}
         for n, d in TOOL_DESC.items()]

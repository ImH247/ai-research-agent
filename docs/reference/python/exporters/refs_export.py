"""참고문헌(BibTeX · RIS)과 근거표(CSV). BibTeX·RIS는 채택 문헌만 S 번호순, CSV는 수집 문헌 전부."""
from __future__ import annotations

import csv
import io
import re
import unicodedata

from exporters.common import reference_sources

_STOP = {"a", "an", "the", "of", "on", "in", "for", "and", "to", "with", "from", "by", "at", "as", "is", "are",
         "its", "via", "into", "toward", "towards", "do", "does", "how", "what", "why", "can"}
_BIB_SPECIAL = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
                "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}
_ARXIV_RE = re.compile(r"(?:arxiv\.org/abs/|10\.48550/arxiv\.)([^\s?#]+?)(?:v\d+)?$", re.I)   # abs 링크 또는 arXiv DOI
CSV_COLUMNS = ["sid", "included", "cited", "score", "relevance", "credibility", "kind", "study_type", "direction", "year",
               "authors", "title", "venue", "citations", "doi", "url", "origin", "subqs", "sample", "method",
               "key_finding", "limitation", "abstract"]


def _ascii(text: str) -> str:
    """악센트를 떼고 영문자·숫자만 남긴다 (한글 등은 사라짐)."""
    norm = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]", "", norm)


def _last_name(s: dict) -> str:
    """첫 저자의 성 (common.short_cite와 같은 규칙: 'John Smith'→Smith, 'Kim J'→Kim)."""
    names = [n for n in (s.get("authors") or []) if n and n.split()]
    if not names:
        return ""
    parts = names[0].replace(",", " ").split()
    return parts[-1] if len(parts[-1].strip(".")) > 2 or len(parts) == 1 else parts[0]


def _title_word(title: str) -> str:
    for w in re.findall(r"[^\W_]+", unicodedata.normalize("NFKD", title or "")):
        a = _ascii(w).lower()
        if len(a) > 2 and a not in _STOP:
            return a
    return ""


def _bib(value) -> str:
    """BibTeX 특수 문자 이스케이프 + 줄바꿈 정리."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return "".join(_BIB_SPECIAL.get(ch, ch) for ch in text)


def _plain_doi(doi: str) -> str:
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", (doi or "").strip(), flags=re.I)


def _url_value(url: str) -> str:
    return re.sub(r"[\s{}\\]", "", url or "")


def build_bibtex(result: dict) -> str:
    entries, used = [], set()
    for s in reference_sources(result):
        sid, kind = s["sid"], s.get("kind") or ""
        key = (_ascii(_last_name(s)).lower() or "anon") + str(s.get("year") or "nd") + _title_word(s.get("title"))
        if key in used:
            key += sid
        used.add(key)
        url, doi = _url_value(s.get("url") or ""), _url_value(_plain_doi(s.get("doi") or ""))
        fields = [("title", "{" + _bib(s.get("title")) + "}"),
                  ("author", " and ".join(_bib(a) for a in s.get("authors") or [] if a)),
                  ("year", str(s.get("year") or ""))]
        note = [sid] + ([_bib(s["study_type"])] if s.get("study_type") else [])
        if kind == "peer-reviewed":
            etype = "article"
            fields.append(("journal", _bib(s.get("venue"))))
        else:
            etype = "misc"
            if kind == "preprint":
                note.insert(0, "Preprint")
                m = _ARXIV_RE.search(url) or _ARXIV_RE.search(doi)
                if m:
                    fields += [("eprint", m.group(1)), ("archivePrefix", "arXiv")]
            elif s.get("venue") or kind == "web":
                site = s.get("venue") or re.sub(r"^https?://(www\.)?([^/]+).*$", r"\2", url)
                fields.append(("howpublished", _bib(site)))
        fields += [("doi", doi), ("url", url), ("note", "; ".join(note))]
        body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v and v != "{}")
        entries.append(f"@{etype}{{{key},\n{body}\n}}")
    return "\n\n".join(entries) + ("\n" if entries else "")


def _ris_value(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def build_ris(result: dict) -> str:
    types = {"peer-reviewed": "JOUR", "academic": "JOUR", "preprint": "UNPB", "web": "ELEC"}
    lines = []
    for s in reference_sources(result):
        lines.append(f"TY  - {types.get(s.get('kind'), 'GEN')}")
        lines += [f"AU  - {_ris_value(a)}" for a in s.get("authors") or [] if a]
        abstract = _ris_value(s.get("abstract"))
        if len(abstract) > 1500:
            abstract = abstract[:1500].rstrip() + "…"
        for tag, val in (("TI", s.get("title")), ("PY", s.get("year")), ("JO", s.get("venue")),
                         ("DO", _plain_doi(s.get("doi") or "")), ("UR", s.get("url")), ("AB", abstract),
                         ("N1", "; ".join(x for x in (s["sid"], s.get("study_type")) if x))):
            if _ris_value(val):
                lines.append(f"{tag}  - {_ris_value(val)}")
        lines += ["ER  - ", ""]
    return "\n".join(lines)


def build_csv(result: dict) -> str:
    """수집 문헌 전부를 S 번호순으로. 호출하는 쪽이 utf-8-sig로 저장한다(Excel 한글)."""
    def num(sid):
        return int(sid[1:]) if (sid or "")[1:].isdigit() else 0

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for s in sorted(result.get("sources") or [], key=lambda s: num(s.get("sid"))):
        row = []
        for col in CSV_COLUMNS:
            v = s.get(col)
            if col in ("included", "cited"):
                v = "TRUE" if v else "FALSE"
            elif col in ("authors", "subqs"):
                v = "; ".join(str(x) for x in v or [])
            row.append("" if v is None else v)
        w.writerow(row)
    return buf.getvalue()

"""결과물 내보내기: 형식 목록(FORMATS)과 export() 진입점.
모든 형식은 result dict(SPEC 3.2)만 입력으로 받는다. 형식별 모듈은 export() 안에서 필요할 때 import 한다
(Word·PPT 모듈은 다른 담당자가 만들고, 서버가 이 패키지를 import 할 때 무거운 모듈을 미리 불러오지 않기 위해)."""
from __future__ import annotations

import json
import re
import shutil
import tempfile
from pathlib import Path

FORMATS: list[dict] = [
    {"id": "md", "label": "Markdown 보고서", "ext": ".md", "mime": "text/markdown; charset=utf-8",
     "description": "노트북과 같은 구성의 Markdown 보고서(부록 A~D 포함)", "group": "report"},
    {"id": "html", "label": "HTML 보고서(인쇄용)", "ext": ".html", "mime": "text/html; charset=utf-8",
     "description": "브라우저에서 바로 열고 인쇄할 수 있는 단독 HTML 문서", "group": "report"},
    {"id": "pdf", "label": "PDF 보고서", "ext": ".pdf", "mime": "application/pdf",
     "description": "설치된 Edge/Chrome으로 HTML 보고서를 인쇄한 PDF", "group": "report"},
    {"id": "docx", "label": "Word 문서", "ext": ".docx",
     "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
     "description": "편집할 수 있는 Word 보고서", "group": "report"},
    {"id": "pptx", "label": "발표 슬라이드", "ext": ".pptx",
     "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
     "description": "보고서를 요약한 발표용 PowerPoint", "group": "slides"},
    {"id": "bib", "label": "참고문헌 BibTeX", "ext": ".bib", "mime": "application/x-bibtex; charset=utf-8",
     "description": "채택 문헌의 BibTeX 항목", "group": "refs"},
    {"id": "ris", "label": "참고문헌 RIS", "ext": ".ris", "mime": "application/x-research-info-systems; charset=utf-8",
     "description": "EndNote·Zotero·Mendeley용 RIS", "group": "refs"},
    {"id": "csv", "label": "근거표 CSV", "ext": ".csv", "mime": "text/csv; charset=utf-8",
     "description": "수집 문헌 전부의 평가 결과 표(Excel에서 열림)", "group": "data"},
    {"id": "json", "label": "전체 데이터 JSON", "ext": ".json", "mime": "application/json; charset=utf-8",
     "description": "실행 결과 전체(result.json)", "group": "data"},
]
_BY_ID = {f["id"]: f for f in FORMATS}
# 파일 이름 꼬리: 보고서류는 _report, 나머지는 내용에 맞게
_SUFFIX = {"pptx": "slides", "bib": "references", "ris": "references", "csv": "evidence", "json": "result"}
# 서버 캐시(exports/)에 쓰는 짧은 ASCII 파일 이름. 한글 이름(filename_for)은 내려받기 이름과 zip 안의 이름으로만 쓴다
# (프로젝트가 깊은 폴더·한글 폴더에 있어도 Windows 경로 길이 제한에 걸리지 않게)
CACHE_NAMES = {f["id"]: f"{_SUFFIX.get(f['id'], 'report')}{f['ext']}" for f in FORMATS}


class ExportError(Exception):
    """내보내기 실패 (사용자에게 보여 줄 수 있는 한국어 메시지)."""


class PdfUnavailable(ExportError):
    """PDF를 만들 브라우저(Edge/Chrome/Chromium)를 찾지 못함."""


def slugify(topic: str, max_len: int = 40) -> str:
    """파일 이름용: 한글·영숫자는 남기고 나머지(공백, Windows 금지 문자 등)는 _로. 비면 'research'."""
    slug = re.sub(r"[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]+", "_", topic or "").strip("_")
    return slug[:max_len].rstrip("_") or "research"


def filename_for(result: dict, fmt: str) -> str:
    """예: '생성형_AI_활용이_대학원생의_연구_생산성과_report.docx', pptx는 '_slides', bib/ris는 '_references'."""
    if fmt not in _BY_ID:
        raise ExportError(f"알 수 없는 형식입니다: {fmt}")
    slug = slugify(result.get("topic") or result.get("prompt") or "")
    return f"{slug}_{_SUFFIX.get(fmt, 'report')}{_BY_ID[fmt]['ext']}"


def _write(path: Path, text: str, encoding: str = "utf-8") -> None:
    # newline="" : 줄바꿈을 그대로 쓴다(CSV의 \r\n이 Windows에서 \r\r\n이 되지 않게)
    with open(path, "w", encoding=encoding, newline="") as f:
        f.write(text)


def export(result: dict, fmt: str, out_dir: Path, outline: dict | None = None, name: str | None = None) -> Path:
    """out_dir에 name(기본: filename_for() 이름)으로 파일을 쓰고 경로를 돌려준다. 알 수 없는 형식이면 ExportError."""
    default = filename_for(result, fmt)      # 알 수 없는 형식 검사도 겸한다
    name = name or default
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name

    if fmt == "md":
        from exporters.md_export import build_markdown
        _write(path, build_markdown(result))
    elif fmt == "html":
        from exporters.html_export import build_html
        _write(path, build_html(result))
    elif fmt == "pdf":
        from exporters.html_export import build_html
        from exporters.pdf_export import html_to_pdf
        from exporters.pdf_export import _remove_dir
        # 브라우저에는 짧은 임시 폴더의 경로만 넘긴다(긴 경로·확장 길이 경로는 브라우저가 처리하지 못함)
        tmp = tempfile.mkdtemp(prefix="ra_pdf_")
        try:
            html_path = Path(tmp) / "report.html"
            _write(html_path, build_html(result, webfont=False))   # PDF는 설치 글꼴로 (네트워크 대기 없음)
            pdf_tmp = html_to_pdf(html_path, Path(tmp) / "report.pdf")
            shutil.copyfile(pdf_tmp, path)
        finally:
            _remove_dir(tmp)
    elif fmt == "docx":
        from exporters.docx_export import build_docx
        build_docx(result, path)
    elif fmt == "pptx":
        from exporters.pptx_export import build_pptx
        if outline is None:
            from agent.slides import fallback_outline
            outline = fallback_outline(result)
        build_pptx(result, outline, path)
    elif fmt in ("bib", "ris", "csv"):
        from exporters import refs_export
        if fmt == "bib":
            _write(path, refs_export.build_bibtex(result))
        elif fmt == "ris":
            _write(path, refs_export.build_ris(result))
        else:
            _write(path, refs_export.build_csv(result), encoding="utf-8-sig")   # Excel에서 한글이 깨지지 않게
    elif fmt == "json":
        _write(path, json.dumps(result, ensure_ascii=False, indent=2))
    return path

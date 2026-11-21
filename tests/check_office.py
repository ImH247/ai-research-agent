"""Word · PowerPoint 결과물 구조 검사 (python-docx · python-pptx로 다시 연다).

사용법: python -X utf8 tests/check_office.py <파일.docx|파일.pptx> [...]
문제가 있으면 'FAIL: …' 줄을 찍고 종료 코드 1, 모두 통과하면 'OK …' 한 줄을 찍는다.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

FONT = "맑은 고딕"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _q(ns, tag):
    return f"{{{ns}}}{tag}"


def check_docx(path: Path) -> list[str]:
    from docx import Document
    from docx.enum.section import WD_ORIENT

    errs = []
    doc = Document(str(path))
    body = doc.element.body
    w = lambda t: _q(W_NS, t)  # noqa: E731

    heads = [p for p in doc.paragraphs if (p.style.name or "").startswith("Heading")]
    h1 = [p.text for p in heads if p.style.name == "Heading 1"]
    if len(heads) < 5:
        errs.append(f"제목 단락이 너무 적음: {len(heads)}")
    if len([t for t in h1 if t.startswith(("부록", "Appendix"))]) != 4:
        errs.append(f"부록 A~D 제목이 4개가 아님: {h1[-6:]}")

    if len(doc.tables) < 4:
        errs.append(f"표가 너무 적음: {len(doc.tables)}")
    repeat = sum(1 for t in doc.tables if t._tbl.find(f"{w('tr')}/{w('trPr')}/{w('tblHeader')}") is not None)
    if repeat < 3:
        errs.append(f"머리글 반복 표가 적음: {repeat}")

    names = {b.get(w("name")) for b in body.iter(w("bookmarkStart"))}
    anchors = [h.get(w("anchor")) for h in body.iter(w("hyperlink")) if h.get(w("anchor"))]
    missing = sorted({a for a in anchors if a not in names})
    if not anchors:
        errs.append("내부 인용 링크가 없음")
    if missing:
        errs.append(f"책갈피 없는 내부 링크: {missing[:5]}")
    ext = [r for r in doc.part.rels.values() if r.reltype.endswith("/hyperlink")]
    if not ext:
        errs.append("외부 링크가 없음")

    secs = doc.sections
    land = [s for s in secs if s.orientation == WD_ORIENT.LANDSCAPE and s.page_width > s.page_height]
    if len(secs) < 3 or len(land) != 1:
        errs.append(f"구역 구성 이상: {len(secs)}개, 가로 {len(land)}개")

    instr = " ".join(t.text or "" for t in body.iter(w("instrText")))
    if "TOC" not in instr:
        errs.append("목차(TOC) 필드가 없음")
    if doc.settings.element.find(w("updateFields")) is None:
        errs.append("updateFields 설정이 없음")

    hdr = secs[0].header.paragraphs[0].text if secs[0].header.paragraphs else ""
    if not hdr.strip():
        errs.append("머리말이 비어 있음")
    ftr_xml = secs[0].footer._element.xml
    if "PAGE" not in ftr_xml:
        errs.append("꼬리말 쪽 번호 필드가 없음")

    rf = doc.styles.element.find(f"{w('docDefaults')}/{w('rPrDefault')}/{w('rPr')}/{w('rFonts')}")
    if rf is None or rf.get(w("eastAsia")) != FONT or rf.get(w("ascii")) != FONT:
        errs.append("기본 글꼴이 맑은 고딕(eastAsia 포함)이 아님")
    bad_font = 0
    for r in body.iter(w("rFonts")):
        if r.get(w("eastAsia")) not in (None, FONT):
            bad_font += 1
    if bad_font:
        errs.append(f"다른 동아시아 글꼴 run {bad_font}개")

    lists = sum(1 for p in body.iter(w("numPr")))
    print(f"  docx: 제목 {len(heads)} · 표 {len(doc.tables)} · 책갈피 {len(names)} · 내부 링크 {len(anchors)}"
          f" · 외부 링크 {len(ext)} · 구역 {len(secs)} · 목록 단락 {lists}")
    return errs


def _em(ch):
    """pptx.js의 글자 폭 어림과 같은 값 (맑은 고딕을 PowerPoint로 그려 잰 값)."""
    cp = ord(ch)
    if cp >= 0x1100 or 0x2190 <= cp <= 0x27BF or cp == 0x2026:
        return 1.0
    if "A" <= ch <= "Z":
        return 0.66
    if "0" <= ch <= "9":
        return 0.58
    if "a" <= ch <= "z":
        return 0.52
    if ch == " ":
        return 0.35
    return 0.3 if ch in ".,·:;!?'\"()[]/|-" else 0.6


def check_pptx(path: Path) -> list[str]:
    """발표 자료 v2(docs/SLIDES_V2.md 3절) 구조 검사."""
    from pptx import Presentation
    from pptx.util import Emu

    errs, warns = [], []
    prs = Presentation(str(path))
    sw, sh = prs.slide_width, prs.slide_height
    if abs(sw / sh - 16 / 9) > 0.01:
        errs.append(f"16:9가 아님: {sw}x{sh}")
    slides = list(prs.slides)
    # 표지 · 질문 · 결론 · 방법 · 근거 지형 · 메시지 3~5 · 마무리 · 부록(참고문헌은 여러 장일 수 있다)
    if not 12 <= len(slides) <= 40:
        errs.append(f"슬라이드 수가 범위(12~40) 밖: {len(slides)}")
    tol = Emu(9144)   # 0.01인치
    charts = tables = notes = 0
    chart_types = []
    for i, s in enumerate(slides, 1):
        sizes = []
        for shp in s.shapes:
            x, y, cx, cy = shp.left or 0, shp.top or 0, shp.width or 0, shp.height or 0
            # 장식 원(어두운 슬라이드의 반투명 원)은 일부러 밖으로 걸쳐 둔다
            out = x < -tol or y < -tol or x + cx > sw + tol or y + cy > sh + tol
            if out and not shp.name.startswith("Decoration"):
                errs.append(f"슬라이드 {i}: '{shp.name}'이(가) 화면 밖으로 나감")
            if shp.has_text_frame:
                sizes += [r.font.size.pt for p in shp.text_frame.paragraphs for r in p.runs if r.font.size]
                # 글상자(txBox)는 늘 글이 있어야 한다(빈 글상자는 그리기 실수)
                if shp._element.xpath("./p:nvSpPr/p:cNvSpPr[@txBox='1']") and not shp.text_frame.text.strip():
                    errs.append(f"슬라이드 {i}: 빈 글상자 '{shp.name}'")
        # 모든 슬라이드에 제목 크기(20pt 이상)의 글이 하나는 있다
        if not any(sz >= 20 for sz in sizes):
            errs.append(f"슬라이드 {i}: 제목 크기의 글이 없음")
        for shp in s.shapes:
            x, y, cx, cy = shp.left or 0, shp.top or 0, shp.width or 0, shp.height or 0
            if shp.has_chart:
                charts += 1
                chart_types.append(str(shp.chart.chart_type).split(".")[-1].split(" ")[0])
            if shp.has_table:
                tables += 1
                tbl = shp.table
                total = sum(r.height for r in tbl.rows)
                if y + total > Emu(int(6.80 * 914400)):
                    errs.append(f"슬라이드 {i}: 표가 본문 영역 아래로 넘침")
            if shp.has_text_frame and not shp.has_chart:
                tf = shp.text_frame
                lines = 0.0
                for p in tf.paragraphs:
                    txt = "".join(r.text for r in p.runs)
                    sizes = [r.font.size.pt for r in p.runs if r.font.size]
                    if not sizes:
                        continue
                    size = max(sizes)
                    per = max((cx / 914400 - 0.1 - (0.24 if p._p.pPr is not None and p._p.pPr.get("marL") else 0)) * 72 / size, 1)
                    n = sum(max(1, math.ceil(sum(map(_em, part)) * 1.1 / per)) for part in txt.split("\n"))
                    lines += n * size * 1.2 / 72
                if lines > cy / 914400 + 0.35:
                    warns.append(f"슬라이드 {i}: 글상자 넘침 가능 ({lines:.2f}in > {cy / 914400:.2f}in)")
        if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip():
            notes += 1
    # 글꼴: 글자가 있는 모든 run은 latin · ea가 맑은 고딕
    bad = 0
    for s in slides:
        for r in s.shapes._spTree.iter(_q(A_NS, "r")):
            t = r.find(_q(A_NS, "t"))
            if t is None or not (t.text or "").strip():
                continue
            rpr = r.find(_q(A_NS, "rPr"))
            lat = rpr.find(_q(A_NS, "latin")) if rpr is not None else None
            ea = rpr.find(_q(A_NS, "ea")) if rpr is not None else None
            if lat is None or ea is None or lat.get("typeface") != FONT or ea.get("typeface") != FONT:
                bad += 1
    if bad:
        errs.append(f"맑은 고딕이 아닌 run {bad}개")
    for s in slides:
        for shp in s.shapes:
            if shp.has_chart:
                xml = shp.chart._chartSpace.xml
                if f'<a:ea typeface="{FONT}"' not in xml:
                    errs.append("차트 글꼴에 동아시아 글꼴이 없음")
                    break
    # 글자 속성의 글꼴 요소는 latin → ea → cs 순서로 한 번씩만 (PowerPoint는 어긋나면 파일을 열지 않는다)
    from lxml import etree
    order = {_q(A_NS, "latin"): 0, _q(A_NS, "ea"): 1, _q(A_NS, "cs"): 2}
    parts = [s.part.blob for s in slides]
    parts += [shp.chart.part.blob for s in slides for shp in s.shapes if shp.has_chart]
    bad_order = 0
    for blob in parts:
        root = etree.fromstring(blob)
        for tag in ("rPr", "defRPr", "endParaRPr"):
            for el in root.iter(_q(A_NS, tag)):
                seq = [order[c.tag] for c in el if c.tag in order]
                if seq != sorted(set(seq)):
                    bad_order += 1
    if bad_order:
        errs.append(f"글꼴 요소 순서 · 중복 오류 {bad_order}곳")
    # 샘플은 통계가 있으므로 근거 지형 슬라이드에 진짜 차트 3개(연구 유형 · 출판 연도 · 결과 방향)
    if charts < 3:
        errs.append(f"차트가 3개 미만: {charts}")
    if notes != len(slides):
        errs.append(f"발표자 노트가 없는 슬라이드가 있음: 노트 {notes} / 슬라이드 {len(slides)}")
    print(f"  pptx: 슬라이드 {len(slides)} · 차트 {charts} ({', '.join(chart_types)}) · 표 {tables} · 노트 {notes}"
          f" · 넘침 경고 {len(warns)}")
    for wmsg in warns[:8]:
        print("  WARN:", wmsg)
    return errs


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for a in argv:
        p = Path(a)
        errs = check_docx(p) if p.suffix.lower() == ".docx" else check_pptx(p)
        for e in errs:
            print(f"FAIL: {p.name}: {e}")
        failed = failed or bool(errs)
        if not errs:
            print(f"OK {p.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

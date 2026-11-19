"""PDF: 설치된 Edge/Chrome/Chromium을 헤드리스로 실행해 HTML 보고서를 인쇄한다(--print-to-pdf).
별도 패키지 없이 브라우저의 인쇄 엔진을 쓰므로 한글 글꼴·CSS 인쇄 규칙(A4, 가로 페이지)이 그대로 반영된다."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from exporters import ExportError, PdfUnavailable

MIN_PDF_BYTES = 4096        # 이보다 작으면 빈 문서로 본다
# 헤드리스 플래그 표기는 브라우저 버전마다 다르다: 최신(새 헤드리스)부터 차례로 시도
HEADLESS_FLAGS = ["--headless=new", "--headless"]
PATH_NAMES = ["msedge", "google-chrome", "chrome", "chromium", "chromium-browser", "microsoft-edge"]


def _candidates() -> list[str]:
    """설치 위치 후보: Edge → Chrome → Chromium 순 (Windows · macOS · Linux)."""
    out = []
    if sys.platform.startswith("win"):
        roots = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        roots = [r for r in roots if r] or ["C:/Program Files (x86)", "C:/Program Files"]
        for rel in ("Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe",
                    "Chromium/Application/chrome.exe"):
            out += [str(Path(r) / rel) for r in roots]
    elif sys.platform == "darwin":
        out += ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    else:
        out += ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge",
                "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome",
                "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]
    return out


def find_browser() -> str | None:
    """PDF 인쇄에 쓸 브라우저 실행 파일 경로. 환경변수 RESEARCH_AGENT_BROWSER가 있으면 그것을 먼저 쓴다. 없으면 None."""
    env = os.environ.get("RESEARCH_AGENT_BROWSER", "").strip().strip('"')
    if env:
        found = env if Path(env).is_file() else shutil.which(env)
        if found:
            return str(found)
    for path in _candidates():
        if Path(path).is_file():
            return path
    for name in PATH_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def _run(cmd: list[str], timeout: float) -> None:
    """브라우저를 실행하고 끝날 때까지 기다린다. 시간을 넘기면 이 함수가 띄운 프로세스만 종료한다."""
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        raise ExportError(f"PDF 변환이 {int(timeout)}초 안에 끝나지 않았습니다.")


def html_to_pdf(html_path, pdf_path, timeout: float = 120) -> Path:
    """HTML 파일을 PDF로 인쇄한다. 브라우저가 없으면 PdfUnavailable, 실패하면 ExportError."""
    browser = find_browser()
    if not browser:
        raise PdfUnavailable("PDF를 만들 브라우저(Edge·Chrome·Chromium)를 찾지 못했습니다. HTML 보고서를 열어 인쇄해 주세요.")
    html_path, pdf_path = Path(html_path).resolve(), Path(pdf_path).resolve()
    if not html_path.is_file():
        raise ExportError("PDF로 바꿀 HTML 파일이 없습니다.")
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    for flag in HEADLESS_FLAGS:
        profile = tempfile.mkdtemp(prefix="ra_browser_")     # 사용자의 브라우저 프로필과 섞이지 않게 매번 새 프로필
        try:
            pdf_path.unlink(missing_ok=True)
            _run([browser, flag, f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
                  "--disable-extensions", "--disable-gpu", "--no-pdf-header-footer", "--print-to-pdf-no-header",
                  f"--print-to-pdf={pdf_path}", html_path.as_uri()],
                 max(5.0, deadline - time.monotonic()))
        finally:
            _remove_dir(profile)
        if pdf_path.is_file() and pdf_path.stat().st_size > MIN_PDF_BYTES:
            return pdf_path
    raise ExportError("브라우저가 PDF를 만들지 못했습니다. HTML 보고서를 열어 인쇄해 주세요.")


def _remove_dir(path: str) -> None:
    """임시 프로필 삭제. 브라우저가 파일을 늦게 놓는 경우가 있어 몇 번 다시 시도한다."""
    for _ in range(5):
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            return
        time.sleep(0.5)

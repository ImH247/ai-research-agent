"""AI Research Agent 웹 앱 진입점.

    python app.py [--host 127.0.0.1] [--port 8000] [--demo] [--demo-speed 1.0] [--no-browser] [--data-dir data]

어느 폴더에서 실행해도 동작하도록 경로는 이 파일 위치를 기준으로 잡는다. import만 해서는 서버가 뜨지 않는다.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI Research Agent 웹 앱")
    p.add_argument("--host", default="127.0.0.1", help="접속을 받을 주소 (기본 127.0.0.1: 이 PC에서만 접속)")
    p.add_argument("--port", type=int, default=8000, help="포트 (사용 중이면 +1씩 최대 10번 시도)")
    p.add_argument("--demo", action="store_true", help="데모 모드: API를 호출하지 않고 기록된 실행을 재생")
    p.add_argument("--demo-speed", type=float, default=1.0, help="데모 재생 간격 배율 (작을수록 빠름)")
    p.add_argument("--no-browser", action="store_true", help="시작할 때 브라우저를 열지 않음")
    p.add_argument("--data-dir", default="data", help="실행 결과를 저장할 폴더 (상대 경로는 이 프로그램 폴더 기준)")
    return p.parse_args(argv)


def find_port(host: str, port: int, tries: int = 10) -> int | None:
    """host:port부터 비어 있는 포트를 찾는다. 없으면 None."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for p in range(port, port + tries):
        with socket.socket(family, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    return None


_DATA_LOCK = None    # 데이터 폴더 잠금 파일. 프로세스가 끝날 때까지 열어 둔다(닫히면 잠금이 풀림)


def lock_data_dir(data_dir: Path):
    """data_dir/.lock에 배타·비차단 잠금을 건다. 성공하면 열린 파일, 다른 프로세스가 이미 잡고 있으면 None.
    (RunManager 안에 두지 않는다: 테스트는 한 폴더로 매니저를 여러 개 만든다)"""
    data_dir.mkdir(parents=True, exist_ok=True)
    f = open(data_dir / ".lock", "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def main(argv=None) -> int:
    global _DATA_LOCK
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    args = parse_args(argv)

    import uvicorn
    from agent.models import APP_NAME, APP_VERSION
    from server.api import DEFAULT_HOSTS, create_app
    from server.runs import RunManager, long_path, plain_path

    data_dir = Path(args.data_dir)
    if not data_dir.is_absolute():
        data_dir = ROOT / data_dir
    # 같은 데이터 폴더로 두 번째 서버가 뜨면 첫 서버의 진행 중인 실행을 interrupted로 바꾸고 지울 수도 있다 → 막는다
    _DATA_LOCK = lock_data_dir(long_path(data_dir))
    if _DATA_LOCK is None:
        print(f"[오류] 다른 AI Research Agent 서버가 이미 이 데이터 폴더를 사용 중입니다: {plain_path(long_path(data_dir))}")
        print("  이미 실행 중인 서버의 주소(예: http://127.0.0.1:8000)를 브라우저에서 열거나, "
              "--data-dir로 다른 폴더를 지정해 다시 실행해 주세요.")
        return 1
    manager = RunManager(data_dir, ROOT / "data" / "samples", demo=args.demo, demo_speed=args.demo_speed)
    host = args.host.strip("[]")
    app = create_app(manager, extra_hosts=[] if args.host in DEFAULT_HOSTS else [args.host, host])

    port = find_port(host, args.port)
    if port is None:
        print(f"[오류] {args.port}~{args.port + 9}번 포트가 모두 사용 중입니다. --port로 다른 포트를 지정해 주세요.")
        return 1
    url = f"http://{'[' + host + ']' if ':' in host else host}:{port}"
    print(f"{APP_NAME} {APP_VERSION}")
    print(f"  주소: {url}")
    if port != args.port:
        print(f"  ({args.port}번 포트가 사용 중이라 {port}번으로 열었습니다)")
    if args.demo:
        print("  데모 모드: API를 호출하지 않고 기록된 실제 실행을 재생합니다. API 키가 필요 없습니다.")
    print(f"  결과 저장 폴더: {plain_path(manager.runs_dir)}")
    print("  종료하려면 이 창에서 Ctrl+C를 누르세요.")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    uvicorn.run(app, host=host, port=port, access_log=False, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())

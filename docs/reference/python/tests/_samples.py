"""테스트 공용: 프로젝트 루트를 import 경로에 넣고 샘플 결과를 읽는다."""
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

SAMPLES_DIR = PROJECT_ROOT / "data" / "samples"
SAMPLE_IDS = ["sample_genai_graduate_research", "sample_roll_sensor_fabrication"]


def load_sample(sample_id: str = SAMPLE_IDS[0]) -> dict:
    """샘플 실행의 result.json을 dict로 읽는다."""
    return json.loads((SAMPLES_DIR / sample_id / "result.json").read_text(encoding="utf-8"))

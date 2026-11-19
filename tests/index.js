// `node --test tests/` 진입점.
// Node 22.14는 `node --test tests/`의 폴더 인자를 파일 경로로 다뤄 tests/index.js를 실행한다(없으면 MODULE_NOT_FOUND).
// 그래서 여기서 tests/ 안의 *.test.js를 모두 불러와 한 프로세스에서 실행한다.
// `node --test`(인자 없음)나 `node --test "tests/*.test.js"`는 이 파일을 고르지 않으므로 테스트가 두 번 돌지 않는다.
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) await import(new URL(f, dir).href);

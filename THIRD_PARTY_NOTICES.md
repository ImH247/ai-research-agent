# 외부 라이브러리 고지 (Third-party notices)

이 사이트는 아래 오픈소스 라이브러리를 `vendor/` 폴더에 한 파일씩 묶어(esbuild, ESM, minify) 함께 배포합니다.
실행 중에 CDN에서 내려받는 코드는 없습니다. 각 라이브러리의 라이선스 원문은 `vendor/licenses/`에 있습니다.

| 묶음 파일 | 라이브러리 | 버전 | 라이선스 |
|---|---|---|---|
| `vendor/anthropic-sdk.js` | [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | 1.10.0 | Apache-2.0 |
| `vendor/markdown-it.js` | [markdown-it](https://github.com/markdown-it/markdown-it) | 15.0.3 | MIT |
| `vendor/docx.js` | [docx](https://github.com/dolanmiu/docx) | 9.15.4 | MIT |
| `vendor/pptxgenjs.js` | [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 4.0.1 | MIT |
| `vendor/jszip.js` | [JSZip](https://github.com/Stuk/jszip) | 3.10.2 | MIT 또는 GPL-3.0-or-later (이 사이트는 MIT로 사용) |

함께 묶였을 수 있는 하위 의존성:

| 라이브러리 | 버전 | 라이선스 | 사용하는 곳 |
|---|---|---|---|
| @opentelemetry/api | 1.10.0 | Apache-2.0 | @anthropic-ai/sdk |
| standardwebhooks | 1.3.0 | MIT | @anthropic-ai/sdk |
| @stablelib/base64 | 1.0.1 | MIT | @anthropic-ai/sdk |
| fast-sha256 | 1.3.0 | Unlicense | @anthropic-ai/sdk |
| json-schema-to-ts | 3.1.1 | MIT | @anthropic-ai/sdk |
| @babel/runtime | 7.29.14 | MIT | @anthropic-ai/sdk |
| ts-algebra | 2.0.0 | MIT | @anthropic-ai/sdk |
| fflate | 0.8.3 | MIT | docx |
| nanoid | 6.0.2 | MIT | docx |
| lie, immediate, setimmediate | 3.3.0 · 3.0.6 · 1.0.5 | MIT | jszip |
| pako | 1.0.11 | MIT AND Zlib | jszip |
| readable-stream, core-util-is, isarray, process-nextick-args, safe-buffer, string_decoder, util-deprecate | 2.3.8 · 1.0.3 · 1.0.0 · 2.0.1 · 5.1.2 · 1.1.1 · 1.0.2 | MIT | jszip |
| inherits | 2.0.4 | ISC | jszip |
| entities | 8.1.0 | BSD-2-Clause | markdown-it |
| linkify-it, uc.micro, mdurl, punycode.js | 6.1.0 · 3.0.0 · 2.1.0 · 2.3.1 | MIT | markdown-it |
| argparse | 3.0.4 | PSF-2.0 | markdown-it (명령줄 도구용, 브라우저 묶음에는 들어가지 않을 수 있음) |
| image-size, queue | 1.2.1 · 6.0.2 | MIT | pptxgenjs |
| https | 1.0.0 | ISC | pptxgenjs |

묶음을 다시 만드는 방법은 `tools/vendor-entries/`의 진입 파일을 esbuild로 묶으면 됩니다.

```
npx esbuild tools/vendor-entries/markdown-it.mjs --bundle --format=esm --platform=browser --minify --outfile=vendor/markdown-it.js
```

문헌 검색에 쓰는 공개 API: [OpenAlex](https://openalex.org) (CC0 데이터), [Semantic Scholar](https://www.semanticscholar.org/product/api), [Europe PMC](https://europepmc.org/RestfulWebService).

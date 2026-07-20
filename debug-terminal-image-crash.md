# Debug Session: terminal-image-crash

Status: [OPEN]
Session ID: terminal-image-crash

## Symptom
Terminal startup prints `line cannot be recognized !!` and `image too small to scale !!`, then service crashes/freezes.

## Initial hypotheses
1. A startup/import-time image/PDF/OCR processing path is executed unexpectedly and throws or hangs on malformed/small images.
2. An upload/API route initializes a document parsing library at import time, causing native dependency warnings and process crash.
3. A worker/queue started with the server processes existing bad KB files on boot and crashes when image scaling fails.
4. The terminal command is running the wrong service/script that triggers image conversion tooling instead of the intended API server.
5. Native image tooling dependency (ImageMagick/Sharp/PDF parser/OCR) emits these messages and crashes due to unhandled errors.

## Evidence log
- Static search found OCR/Tesseract path in `packages/knowledge/src/extraction/content-extractor.ts` and `ocr-providers.ts`.
- Server port 17321 was already occupied by a running node service, so the dashboard server was active.
- `kbIndexWorkerService.ts` previously forked the KB index worker with stdout/stderr ignored, making native OCR output invisible to operation logs.
- Runtime verification with a generated 1x1 PNG now returns metadata-only extraction and warning: `图片尺寸过小（1x1），已跳过 OCR 并仅索引元数据`, with no Tesseract `image too small to scale` output.

## Changes
- Added child-process stdout/stderr forwarding in `apps/server/src/services/kbIndexWorkerService.ts` for future evidence visibility.
- Added OCR size guards in `packages/knowledge/src/extraction/content-extractor.ts` for raster images and rendered PDF page images.
- Added a final OCR size guard in `packages/knowledge/src/extraction/ocr-providers.ts`.
- Verified with `pnpm --filter @customize-agent/knowledge typecheck`, `pnpm --filter @customize-agent/server lint`, `pnpm --filter @customize-agent/knowledge build`, and a runtime 1x1 PNG extraction smoke test.

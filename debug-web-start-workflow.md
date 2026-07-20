# Debug Session: web-start-workflow

Status: OPEN

## Symptoms

1. Running `pnpm start:cli` starts terminal/CLI but Web page crashes or fails, terminal prints `Image too small to scale!! (2x48 vs min width of 3)` repeatedly.
2. In workflow template library, clicking Run opens the right drawer and generation is blocked with `生成准备度不足：使用模板绑定文件作为资料范围`.

## Hypotheses

H1. Terminal image rendering in CLI/TUI is attempting to render an image into a terminal area whose width is below the renderer minimum, causing repeated errors and possibly interfering with Web startup output.

H2. Web crash is not caused by the image-size terminal warning, but by a Next runtime/server error after startup; the terminal warning is a separate CLI UI rendering issue.

H3. Generation blocking is caused by actual template file bindings resolving to multiple `topLevelGroup` values at runtime, not necessarily by user binding different projects.

H4. Generation blocking is caused by stale or broadened file path matching, where a bound path matches extra files outside the intended project folder.

H5. Generation blocking is caused by template binding data not being saved/loaded as expected after the folder-tree UI change.

## Evidence Plan

- Run `pnpm start:cli` and collect full terminal output.
- Inspect active Web endpoint behavior after start.
- Instrument generation readiness path only after collecting baseline logs.
- Reproduce template run with real local data/API if possible.

## Timeline

- Session initialized.
- Reproduced `pnpm start:cli`: CLI printed dashboard started, but `/api/health` returned 200 while `/overview` and `/documents` returned 500.
- Started Next production server directly and captured real stack: `TypeError: __webpack_require__.nmd is not a function` in `@ant-design/cssinjs/lib/hooks/useHMR.js` loaded from `.next/server/chunks/vendor-chunks/...`.
- Confirmed page runtime lacks `__webpack_require__.nmd`; the copied `server/chunks/vendor-chunks` files expected that helper. Removed the vendor chunk copy repair from `verify-next-static.js`.
- Rebuilt and verified `/overview` and `/documents` return 200.
- API routes then exposed the opposite path issue: `webpack-api-runtime.js` referenced `./chunks/vendor-chunks/...` while the real emitted directory is `.next/server/vendor-chunks`. Patched verify script to rewrite API runtime vendor chunk paths to `./vendor-chunks/` after build.
- Real template validation for local template `tpl-1784449614607` no longer blocks with `生成准备度不足：使用模板绑定文件作为资料范围`; only OCR/indexing warnings remain.
- Root cause for generation blocking: explicit bound files spanning multiple first-level folders were being treated as automatic material group ambiguity. Fixed `selectMaterialFiles` to use exact explicit bindings and mark explicit bound scope as non-ambiguous.
- Rebuilt CLI and server, started `CUSTOMIZE_AGENT_E2E_DASHBOARD=1 CUSTOMIZE_DASHBOARD_PORT=17327 pnpm start:cli`, verified `/api/health`, `/overview`, `/documents`, and `/api/documents/templates` all return 200.

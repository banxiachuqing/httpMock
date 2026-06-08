# Mock Server WebUI — Design Spec

**Date**: 2026-06-08
**Status**: Draft — pending user review
**Related PRD**: `.claude/prds/mock-server-webui.prd.md`

## Overview

A local HTTP mock server with a WebUI. Users configure mock endpoints (HTTP method, path, port, JSON response) through a browser-based form, start the mock engine, and see incoming requests in a live log panel. Configuration persists to the user's Documents directory and the tool ships as a zero-build Node project runnable with `pnpm install && pnpm start`.

## Goals

Carry over from PRD MVP scope:

1. Configure multiple mock endpoints in a single UI session.
2. One port can host multiple endpoints, matched exactly by `method + path`.
3. Start/stop the mock engine with one button.
4. JSON editor with live validation and one-click format.
5. Live request log in a bottom panel (in-memory only, max 500 entries).
6. Configuration persists under the user's Documents directory; the path is editable from the UI.
7. Cross-platform: macOS and Windows.
8. Port conflicts surface a clear error to the user, not a crash.

## Non-Goals

- Authentication, accounts, cloud sync, team sharing.
- Request recording, proxying, replay, or performance testing.
- HTTPS / TLS / certificate management.
- Dynamic scripted responses (templates, functions, JS).
- Log persistence across sessions.

## Architecture

### Process Model

A single Node process. Inside it:

- **WebUI server** binds to `settings.uiPort` (default `5050`). Serves the static UI from `public/` and exposes a JSON API plus a Server-Sent Events stream.
- **Mock engine** listens on each unique port referenced by the endpoint list. For each unique port, a dedicated `http.Server` is created. The set of active mock servers is rebuilt on every start and torn down on stop.

### Module Layout

```
mock-server/
├── package.json
├── pnpm-lock.yaml
├── server.js              # process entry: wires modules, starts WebUI
├── src/
│   ├── config-store.js    # load/save data.json, atomic write
│   ├── mock-engine.js     # start/stop per-port http.Servers, route dispatch
│   ├── log-buffer.js      # ring buffer + SSE fan-out
│   ├── paths.js           # cross-platform Documents path detection
│   ├── api.js             # Express routes for /api/* and /events
│   └── errors.js          # error normalization helpers
├── public/                # static UI
│   ├── index.html
│   ├── app.js
│   ├── editor.js          # CodeMirror bootstrap
│   └── styles.css
└── test/
    ├── unit/
    └── e2e/
```

### Request Lifecycle (Mock Hit)

1. Client → mock port `:8080`.
2. `mock-engine` looks up `(method, path)` in the loaded endpoint set.
3. Hit → respond with `endpoint.statusCode` (default 200) and `endpoint.response` as `Content-Type: application/json`.
4. Miss → respond 404 with a fixed JSON body `{ "error": "no mock for <method> <path>" }`.
5. Either way, push a `LogEntry` into `LogBuffer`.

### Data Flow

```
User action in UI
   │ (fetch)
   ▼
Express /api/* → config-store (write) → data.json (atomic)
                                  → mock-engine (rebuild) → mock http.Servers

Incoming mock request
   │ (http.Server)
   ▼
mock-engine → log-buffer.push(entry)
   │ (SSE)
   ▼
WebUI EventSource → DOM update
```

## Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js ≥ 18 | `crypto.randomUUID`, `fs.promises`, native `fetch` for tests |
| Backend framework | Express 4 | Zero-build friendly, well-known, sufficient for our needs |
| Frontend | Native ES modules + small CSS | No build step |
| JSON editor | CodeMirror 6 (`@codemirror/lang-json`, `@codemirror/lint`) via local `node_modules` ESM | No CDN dependency, no build |
| ID generation | `crypto.randomUUID()` | No new dependency |
| Persistence | `fs.writeFile` to `data.json.tmp` + `fs.rename` | Atomic write |
| Open browser on start | `open` npm package | Cross-platform |
| Default WebUI port | `5050` | If taken, increment until free, report to user |
| Test runner | Vitest (unit + integration) | Fast, ESM-native |
| E2E | Playwright (headed per global rule) | Per `.claude/CLAUDE.md` |

## Data Model

Stored in `<storagePath>/data.json`:

```json
{
  "version": 1,
  "settings": {
    "storagePath": "/Users/x/Documents/MockServer",
    "uiPort": 5050
  },
  "endpoints": [
    {
      "id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "port": 8080,
      "method": "GET",
      "path": "/api/users",
      "statusCode": 200,
      "response": { "users": [] },
      "enabled": true
    }
  ]
}
```

### Field Constraints

- `id`: UUID v4, server-generated, immutable.
- `port`: integer in `[1, 65535]`.
- `method`: one of `GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`.
- `path`: must start with `/`, no query string, no trailing slash ambiguity (e.g., `/api/users` and `/api/users/` are treated as distinct).
- `statusCode`: integer in `[200, 599]`. Default `200`.
- `response`: any JSON value (object, array, number, string, boolean, null).
- `enabled`: boolean. When `false`, the endpoint is not registered with the mock engine.

### Uniqueness

A combination of `(port, method, path)` must be unique among endpoints with `enabled = true`. The API rejects conflicting saves with HTTP 400.

## API Surface

All endpoints are JSON. Errors follow:

```json
{ "error": "human-readable message", "code": "STABLE_CODE" }
```

### Config

- `GET /api/config` → returns the full `data.json` content.
- `PATCH /api/config` → body `{ settings: { uiPort?, storagePath? } }`. Changes to `uiPort` take effect on the next server restart. Changes to `storagePath` **move** the existing `data.json` to the new location (copy + delete original) and update the in-memory config.

### Endpoints

- `GET /api/endpoints` → returns the `endpoints` array.
- `POST /api/endpoints` → body is the endpoint fields (no `id`). Returns the created endpoint with `id`.
- `PUT /api/endpoints/:id` → body is the endpoint fields. Returns the updated endpoint.
- `DELETE /api/endpoints/:id` → returns 204.

### Runtime

- `POST /api/runtime/start` → starts mock servers for every unique port referenced by an enabled endpoint. Returns the resulting status:
  ```json
  {
    "running": [{ "port": 8080 }],
    "failed":  [{ "port": 9090, "reason": "EADDRINUSE" }]
  }
  ```
- `POST /api/runtime/stop` → tears down all mock servers. Returns `{ "stopped": [8080, 9090] }`.
- `GET /api/runtime/status` → current state per port: `running | failed | stopped` plus reason if failed.

### Logs

- `GET /api/logs?limit=N` → up to N most recent `LogEntry` objects (max 500). Newest last.
- `GET /events` → Server-Sent Events. Each event has `event: log` and `data: <JSON LogEntry>`. The connection is kept open until the client disconnects. **SSE does not replay missed events** on reconnect — a reconnected client must call `GET /api/logs` to backfill.

### LogEntry

```ts
{
  id: string;            // uuid
  timestamp: number;     // ms since epoch
  method: string;        // e.g. "GET"
  path: string;          // request path
  port: number;          // mock port that received the request
  query: string;         // raw query string, may be empty
  status: number;        // response status
  durationMs: number;    // request handling time
  matched: boolean;      // true if hit, false if 404
  endpointId: string | null;  // id of the matched endpoint, or null
  requestHeaders: Record<string, string>;
  requestBodyPreview: string;  // truncated to 2 KB
}
```

## User Interface

Layout follows the approved **two-column + bottom log** option.

```
┌────────────────────────────────────────────┐
│  Mock Server      [▶ Start] [⏹ Stop]      │
├──────────────┬─────────────────────────────┤
│  + New       │  Editing: GET /api/users    │
│              │                             │
│  ● GET /api/users                          │
│    :8080  ✓                                │
│  ○ POST /api/orders                        │
│    :8080  ✗ (EADDRINUSE)                   │
│  ○ GET /health                             │
│    :9090  ● running                        │
│              │  Method [GET ▼]             │
│              │  Port   [8080]              │
│              │  Path   [/api/users     ]   │
│              │  Status [200]               │
│              │  ┌─ Response JSON ───────┐  │
│              │  │  (CodeMirror editor)  │  │
│              │  │                        │  │
│              │  └─────────────────────┬─┘  │
│              │  [Format] [Validate]   │    │
│              │  [Save]  [Delete]      │    │
├──────────────┴─────────────────────────────┤
│  Request Logs  (auto-scroll ◉) [Clear]     │
│  12:34:56  GET  /api/users   200  5ms      │
│  12:34:58  POST /api/orders  200  3ms      │
│  12:35:00  GET  /unknown     404  1ms      │
└────────────────────────────────────────────┘
```

### Interactions

- Clicking a row in the left list selects that endpoint for editing.
- The right pane is the editor; the form fields are bound to the selected endpoint. `id` is not editable and is not shown in the form (server-generated). `enabled` is not exposed in MVP and defaults to `true` for new endpoints.
- `Save` sends `PUT /api/endpoints/:id` (or `POST` for new). Validation errors render inline.
- `Format` runs `JSON.stringify(JSON.parse(text), null, 2)` client-side.
- `Validate` parses and reports the first error position; the same logic runs on every keystroke (debounced 200 ms) for inline error display.
- `Start` posts to `/api/runtime/start`. Per-port status indicators reflect the response.
- `Stop` posts to `/api/runtime/stop`.
- The log panel subscribes to `/events` for live entries. A `Clear` button empties the in-DOM list (does not affect server-side buffer).
- `Settings` (gear icon, top-right) opens a small dialog to view/edit `storagePath` and `uiPort`.

## Cross-Platform Persistence

- On startup, `paths.js` resolves the default `storagePath`:
  - `path.join(os.homedir(), 'Documents', 'MockServer')` on macOS and Windows.
  - If `Documents` does not exist (rare), fall back to `path.join(os.homedir(), 'MockServer')` and log a warning.
- The user can change `storagePath` from the settings dialog. On change, the server copies the existing `data.json` to the new location atomically, then updates the in-memory config.
- All writes use the `data.json.tmp` + `fs.rename` pattern. A corrupted file is detected on load by absence of `version` and triggers a backup to `data.json.broken-<timestamp>` and initialization of a fresh file.

## Real-Time Log Delivery

Server-Sent Events over `/events`. Reasons:

- One-way server→client matches the data flow.
- Browser-native `EventSource`, no client library, auto-reconnect.
- No new backend dependency.

Wire format:

```
event: log
data: {"id":"...","timestamp":1706000000000,"method":"GET",...}

```

Server-side: `LogBuffer` is a fixed-size ring (500). Pushes fan out to all SSE clients. On overflow, the oldest entry is dropped.

Client-side: on initial load, the UI calls `GET /api/logs?limit=500` to populate history, then opens `new EventSource('/events')` for the live tail.

## Error Handling

| Situation | Behavior |
|---|---|
| Mock port already in use (EADDRINUSE) | That port reports `failed` with reason. Other ports continue. Process does not crash. UI marks the row with an error indicator. |
| `data.json` is missing on first run | Initialized with `version: 1`, empty endpoints, default settings. |
| `data.json` is corrupt (no `version` key) | Backed up to `data.json.broken-<timestamp>`, fresh file initialized. User is informed on next start. |
| `storagePath` is not writable | Startup aborts with a clear stderr message and exit code 1. UI never opens. |
| `POST/PUT` with invalid JSON in `response` | HTTP 400 `{ error, code: "INVALID_JSON" }`. Storage is not modified. |
| `POST/PUT` with duplicate `(port, method, path)` | HTTP 400 `{ error, code: "DUPLICATE_ENDPOINT" }`. |
| Method outside allowed enum | HTTP 400 `{ error, code: "INVALID_METHOD" }`. |
| SSE client disconnects | Server cleans up the listener. No impact on buffer or other clients. |
| Backend uncaught exception | Logged to stderr with stack; the WebUI server stays up and reports the error via `GET /api/runtime/status` if relevant. |

## Security Considerations

- WebUI binds to `127.0.0.1` only. No external network access.
- No authentication, by design (local single-user tool). Trust boundary is the local user.
- All file paths are validated to be absolute and to reside under the resolved `storagePath` before any file operation.
- CORS is not configured (same-origin only).
- Request body previews are truncated to 2 KB before being stored in `LogEntry` to bound memory.

## Testing Strategy

### Unit Tests (Vitest)

- `config-store`: load missing/corrupt/valid file; atomic write; uniqueness check.
- `paths`: default resolution on macOS / Windows; missing `Documents` fallback.
- `log-buffer`: push, ring overflow, fan-out to multiple subscribers.
- `errors`: normalizer shapes.

### Integration Tests (Vitest + supertest)

- All `/api/*` endpoints with happy and unhappy paths.
- Mock engine: hit returns configured response, miss returns 404, status code honored.
- EADDRINUSE simulation: spawn two engines on the same port, verify the second reports `failed`.
- SSE: subscribe, trigger a request, assert event received.

### E2E (Playwright, **headed** per `.claude/CLAUDE.md`)

- Open UI, add an endpoint, save, start, hit the mock URL externally, see entry in log.
- Type invalid JSON, see inline error, save rejected.
- Type valid JSON, click format, see it pretty-printed.
- Pre-occupy a port with `nc -l`, attempt to start, see the failed status reflected in the UI.
- Change `storagePath`, restart, confirm config persisted at new location.

Coverage target: ≥ 80% on `src/` (unit + integration combined). E2E is not counted toward the percentage.

## Open Questions

Carried from the PRD; defaulted here. The user can override before implementation.

1. **Start granularity**: defaulted to one global Start/Stop. Per-port start is a possible follow-up.
2. **Default log buffer size**: 500. Make it a setting later.
3. **Default `uiPort`**: `5050`. Auto-increment on conflict at startup.
4. **Body preview truncation length**: 2 KB. Tunable later.
5. **Settings dialog scope**: storage path + ui port only in MVP. WebUI theme and dark mode deferred.

## Out of Scope (Recap)

Auth, cloud sync, recording, proxying, performance testing, HTTPS, dynamic scripts, log persistence, team collaboration, mobile layout.

## Implementation Plan Reference

Implementation planning will be produced by `/plan` against this spec and the PRD. The plan will sequence:

1. Project scaffold + paths + config-store.
2. WebUI server + static UI shell.
3. Endpoint CRUD API + UI form.
4. Mock engine + start/stop + port conflict handling.
5. JSON editor + validate + format.
6. Log buffer + SSE + log panel.
7. Settings dialog + storage path change.
8. E2E test harness.

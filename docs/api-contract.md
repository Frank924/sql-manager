# V1 implementation contract

Java 17 / Spring Boot 3.5.x + SQLite + immutable SQL files. Frontend retains the approved React UI in `ui-prototype/`. Start empty; never seed demo data. V1 manages one logical database (`business`) with a per-environment actual database name. No SQL execution or remote DB connections.

State JSON is `{revision, scripts:[], releases:[], environments:[], packages:[], settings:{workspaceName:'SQL Manager',dataDirectory}}`. Objects follow `ui-prototype/src/model.js` field names. `scripts` carry `hash` (SHA-256 of original bytes), `size`, and metadata, NOT content. Packages retain immutable `files` metadata, `scriptIds`, `inputApplied`, environment snapshot and append-only `registrations`. All dates are actual timestamps. Latest published release is the final published item in ordered `releases`.

Every mutation has optimistic concurrency via `If-Match: <state.revision>`; stale writes return HTTP 409 `{message}` and do not mutate. All successful mutations return `{state, resultId}`. Frontend must apply returned state only after success, retain form input on failure, and prevent duplicate submission. GET errors also use `{message}`.

- GET `/api/state`
- GET `/api/health`
- POST `/api/scripts` multipart `file`, `description`, `db=business`, `type=baseline|increment` (10 MiB, UTF-8, preserve bytes). Returns new script ID.
- GET `/api/scripts/{id}/content` UTF-8 text for preview.
- GET `/api/scripts/{id}/download` original bytes with attachment filename.
- POST `/api/releases` JSON `{id,name,previous:null|string,baseline,scriptIds,notes}`. Creates draft. First release allows user-defined semantic version and one or more ordered baseline files before optional increments. `baseline` is the first baseline script ID and identifies the release chain; `scriptIds` contains every selected baseline followed by increments in execution order. Later releases inherit the full baseline and ordered published predecessors, add only increments, and allow zero SQL changes for code-only releases. Existing single-baseline releases remain compatible.
- PUT `/api/releases/{id}` same draft fields; immutable ID.
- POST `/api/releases/{id}/publish` `{}`. Publish only on latest published predecessor; first release has null predecessor. Freeze scripts and manifest server-side.
- POST `/api/environments` JSON `{name,kind,codeVersion,actualDb,db:'business'}`.
- PUT `/api/environments/{id}` same editable metadata, no ledger fields accepted.
- POST `/api/environments/{id}/baseline` JSON `{version,operator,note,confirmed:true}`. Only a pristine environment can be taken over; record confirmation event/time, not fake execution history.
- POST `/api/packages` JSON `{envId,target,type:'upgrade'|'install',confirmedEmpty:true|false}`. Server rechecks immutable published chain, failures, previous successful applied set, downgrade and baseline/empty DB conditions. Export changes no execution ledger.
- GET `/api/packages/{id}/download` ZIP containing byte-identical original SQL, ordered manifest with hash, actual DB name, source applied snapshot, execution instructions and CSV results sheet. Verify hashes before download.
- POST `/api/packages/{id}/results` JSON `{results:{scriptId:'notExecuted'|'success'|'failed'|'partial'},operator,executedAt,note}`. Exact package IDs only; all entries required. Corrections append original and new data with recording timestamps, require a reason. Failure/partial blocks exports until corrected. Union of successful latest package results + manually confirmed baseline determines applied state; codeVersion independent.
- GET `/api/backup` ZIP snapshot with state JSON + original files, produced consistently.
- POST `/api/restore` multipart `file`, `confirmed:true`; restore only into an empty workspace, validate entries/hashes/state before replacing. Online backup/restore allows up to 2,000 SQL files, 16 MiB state JSON, and 128 MiB original content / ZIP size; larger workspaces use a stopped-service full data-directory copy.

Use HTTP 400 for validation, 404 for missing resources, 409 for conflicts, and 413 for oversized uploads. Return readable errors without stack traces. The server listens on all network interfaces by default. The UI and API are served from the same origin, and browser writes from a different origin are rejected. The development server proxies `/api` to `127.0.0.1:18080`. Docker publishes port 18080 on the host and persists `/data`. The deployment controls access to the shared workspace.

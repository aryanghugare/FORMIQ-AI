# Code review — 4 October 2026

The review covered the Next.js pages, React components, API handlers, authentication, SQLite persistence, CAD extraction and analysis, DWG converter adapter, reports, deployment configuration, and existing tests. The fixes below are implemented in the source.

## Login rendering follow-up

A browser run exposed a Server Component serialization failure after successful login. `node:sqlite` returns rows with null prototypes; the session lookup previously returned that raw row as the user. It now returns an explicit plain object containing only `id`, `name`, and `email`. The generic error page no longer incorrectly attributes every failure to administrator configuration.

The new regression test reproduces login and checks the complete workspace props before JSON serialization. It failed on `initialData.user` before the fix. API response tests alone missed this because JSON serialization converts the raw row into ordinary JSON.

## Data integrity and request handling

| Finding                                                                            | Fix                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two tabs could overwrite each other's issue reviews.                               | Reviews carry an incrementing version. The transaction checks `expectedVersion`, returning HTTP 409 for stale decisions.                                                   |
| Ready DWG drawings could be reprocessed, changing sources beneath historical runs. | Ready drawings reject retries. Simultaneous retries are guarded, and transactions recheck readiness after asynchronous conversion before saving either success or failure. |
| Failed DWG retries left misleading statuses or generic errors.                     | Failures retain an actionable error and a failure audit event; converter failures return HTTP 502.                                                                         |
| Upload limits relied on caller-supplied Content-Length.                            | Actual request bytes are counted while streaming. JSON is limited to 64 KiB, multipart requests to 31 MiB, and individual drawing files to 30 MiB.                         |
| Asynchronous login attempts could bypass a read-then-write throttle.               | Attempts are atomically reserved in SQLite before password derivation; concurrent excess attempts return HTTP 429.                                                         |
| Password verification blocked the Node event loop.                                 | Login uses asynchronous scrypt. Email normalization and provisioning validation match the login rules.                                                                     |
| Unexpected errors were classified through message text.                            | Explicit HTTP errors distinguish invalid input, missing resources, conflicts, throttling, and unexpected server failures.                                                  |
| Expired sessions could not be logged out cleanly.                                  | Logout clears the session cookie even if the token is expired or invalid.                                                                                                  |
| Failed database writes could leave orphaned original uploads.                      | Upload writes use exclusive creation and remove the original if persistence fails.                                                                                         |
| Record updates could retain outdated SQL project metadata.                         | Upserts update kind and project indexes together with JSON data.                                                                                                           |
| Invalid report formats produced misleading success audit events.                   | Format validation precedes report auditing.                                                                                                                                |

## CAD and reports

| Finding                                                                        | Fix                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Incomplete dimension endpoints could produce invented distances to the origin. | Measurements require an explicit value or complete endpoints; incomplete dimensions are excluded with an extraction warning. |
| Nonplanar geometry was flattened into a potentially misleading 2D review.      | Unsupported elevations, Z coordinates, normals, and block scales are excluded with warnings.                                 |
| Invalid radii or overflowing coordinates could reach the renderer.             | Positive radii, finite coordinates, and bounded measurements are validated.                                                  |
| A giant polyline could bypass the entity-count limit.                          | Extraction additionally limits total polyline vertices to 200,000.                                                           |
| Rotated block arcs used the original angles.                                   | Arc endpoints are transformed and angles recalculated. The viewer and report share the arc-path implementation.              |
| Printable reports omitted arc entities.                                        | Reports now render arcs and use a readable minimum marker/stroke scale.                                                      |
| Floating-point arithmetic could flag a difference exactly at tolerance.        | Millimetre differences are rounded to three decimal places before comparison.                                                |
| Repeated tags incurred quadratic copying.                                      | Tag buckets append measurements directly.                                                                                    |
| CSV formulas hidden behind leading whitespace were insufficiently guarded.     | Formula-like cells are neutralized after accounting for leading whitespace, BOMs, and line breaks.                           |

## Performance and interface

Drawing summaries are now stored separately from full CAD geometry in SQLite. Existing databases are migrated and backfilled automatically. The workspace endpoint reads summaries without loading models; the comparison viewer fetches only the two selected models through authenticated, uncached detail requests.

Measured with the supplied demo fixtures using serialized JSON byte lengths:

| Payload            |       Before |       After | Reduction |
| ------------------ | -----------: | ----------: | --------: |
| Drawing collection | 23,098 bytes |   956 bytes |     95.9% |
| Complete workspace | 29,979 bytes | 7,837 bytes |     73.9% |

These are sample payload measurements, not production throughput benchmarks. Results depend on drawing complexity and project history.

Additional fixes:

- Geometry rendering is memoized during panning, and layer lookups use a set.
- Panning accounts for SVG letterboxing; rapid zoom updates use current state.
- Date and number formatting uses explicit `en-GB` locale and `Asia/Kolkata` time zone, keeping server and browser output consistent.
- Duplicate bootstrap requests are avoided when server-rendered workspace data exists. Stale refresh responses cannot replace newer data.
- Mutation controls guard duplicate submissions and preserve conversion failure messages. A failed refresh after a successful save is reported distinctly.
- Drawing-load requests are cancelled when the comparison changes, and failed loads have a retry control.
- Dialogs trap keyboard focus, support Escape, restore focus, and lock background scrolling. Canvas findings support keyboard activation.
- Browser history navigation resets invalid or missing view state safely.
- Extraction warnings are available in expandable drawing details.
- Browser tests use separate data, build output, and port settings. Private data directories and test artifacts are excluded from Git and Docker contexts.
- `npm run build:check` creates and removes an isolated source/dependency copy, avoiding Next.js generated-type conflicts with a running dev server.

The previously reported `cz-shortcut-listen` hydration mismatch comes from an injected body attribute. The existing suppression is restricted to the body. Explicit date/number formatting addresses a separate application-level hydration risk.

## Verification

- 36 automated tests cover CAD extraction and analysis, API workflows, authenticated workspace serialization, concurrent login throttling, conflicting reviews, conversion success/failure and parallel retries, request streaming limits, SQLite migration and transactions, report escaping, and deterministic formatting.
- TypeScript validation and the production build pass.
- Browser end-to-end tests are supplied, but were not executed successfully in the restricted environment: local server sockets and headless Chrome launch are blocked.
- DWG integration is tested with an executable fixture. A real ODA installation and representative production drawings still need integration validation.

## Remaining improvements

1. **Large files:** CAD parsing and rule analysis are still synchronous. Move them into workers or background jobs, with durable progress and cancellation, before supporting many simultaneous large uploads.
2. **Growing history:** Runs, issues, memory, and audit events still load as complete collections. Add server-side pagination, filtering, and project-scoped queries as history grows.
3. **Dense drawings:** The viewer uses SVG. Very dense models may need viewport culling, level-of-detail rendering, or Canvas/WebGL after profiling representative drawings.
4. **Deployment model:** SQLite and originals require one server with persistent disk. Multi-server deployment needs shared storage, a suitable database, and distributed job coordination.
5. **CAD coverage:** The parser deliberately supports a limited subset of planar ASCII DXF and tagged linear measurements. Broader AutoCAD entity support requires additional fixtures and validation; unsupported geometry is surfaced through extraction warnings.
6. **Access management:** The application still shares one workspace among authenticated users. Organization tenancy, roles, password reset, and SSO remain outside this prototype's implementation.

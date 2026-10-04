# FORMIQ AI

A working Next.js application for Kumkang Kind’s **Formwork Intelligence, Quality & Revision Assistant**, based on the supplied innovation-challenge presentation.

It includes the frontend, backend API, local authentication, persistent SQLite storage, CAD uploads, a 2D drawing viewer, revision checks, designer review, Design Memory, and report exports.

## Run locally

Requires **Node.js 22.13 or newer**. Node 22.22 is the tested version. SQLite is provided by Node’s built-in `node:sqlite` module; Node 22 may print an experimental-module warning.

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**.

Development enables an illustrative demo workspace by default:

- Email: `designer@formiq.ai`
- Password: `Formiq@2026`

Dependencies have already been installed in this workspace. You can start directly with `npm run dev`.

The demo contains three actual ASCII DXF fixtures, which are parsed and analyzed when the database is initialized. Door D14 changes from **900 mm to 1000 mm**, while formwork remains **900 mm**. Window W03 and beam B02 also change, and a new door D21 appears. The rules produce **seven findings**, including separate revision and coordination findings.

The sample project and memory references are clearly labeled as illustrative. No real Kumkang project approval is implied.

## Complete review workflow

1. Sign in and create a project with its name, code, and location.
2. Upload old architecture, new architecture, and current formwork drawings. Set each discipline and revision identifier. Structure drawings can also be stored and viewed.
3. Check the extraction status in Drawing Library. Original uploads remain downloadable.
4. Run analysis and explicitly select the three drawings to compare.
5. Open Revision Review to switch between previous, latest, and overlay views; pan, zoom, toggle layers, and inspect marked findings.
6. In Issue Register, filter findings by priority or review status. Accept, reject, or investigate a finding with a designer note.
7. Generate a marked-up HTML report. Use its **Print / save as PDF** button to produce a PDF, or export the issue register as CSV.
8. Add verified previous solutions to Design Memory with an HTTPS source link. Search by condition, project, RFI, or tags.

Every analysis run is retained. Re-running the analysis creates a new register; earlier decisions remain available through the earlier run. Reviews record the designer identity and timestamp, and an audit log records uploads, analyses, decisions, parameter changes, and report generation.

**Accepting a finding confirms that the finding is valid. It never approves or releases a drawing.**

## CAD support and its limits

### DXF

The current checker supports **ASCII DXF**, focusing on 2D model space:

- LINE, LWPOLYLINE, 2D POLYLINE, CIRCLE, ARC, TEXT, MTEXT, ATTRIB, linear DIMENSION, and uniform INSERT block transformations.
- Millimetres, centimetres, metres, inches, and feet, normalized to millimetres using `$INSUNITS`.
- Tagged linear dimensions, with group 42 measurements or supported endpoint geometry.
- Explicit schedule annotations such as `D14 = 1000 mm`.

To associate measurements reliably, use a stable tag on the dimension layer, such as `DOOR_D14`, `WINDOW_W03`, `BEAM_B02`, or `WALL_W12`, or include the tag in the dimension’s text. Each checked dimension needs a unique tag. Multiple measurements sharing a tag produce an ambiguity finding rather than a guessed comparison.

The parser does not infer semantic relationships from arbitrary untagged linework or nearby text. Missing units or missing tagged measurements block numerical analysis. Unsupported geometry is identified in extraction notes; a processed drawing is not a certification of complete extraction.

Binary DXF, paper space, 3D models, meshes, splines, external references, non-uniform block scales, array inserts, and angular/radial/ordinate dimensions are outside the current checker. Polyline bulges are approximate in the viewer. Uniformly rotated block arcs retain their transformed orientation in the viewer and reports. The viewer provides geometric overlays; automatic findings are based on explicitly tagged linear measurements, not a comprehensive geometric-difference engine.

Uploads are limited to 30 MB; converted DXF to 50 MB; expanded geometry to 100,000 entities and 200,000 polyline vertices.

### DWG

DWG originals are accepted, signature-checked, stored, and tracked. **DWG viewing and analysis require a separately installed CAD converter.** No DWG converter is bundled or installed in this workspace.

For [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter), set its executable path in `.env.local`:

```dotenv
ODA_CONVERTER_PATH=/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter
```

The adapter invokes the executable directly with a dedicated input directory, output directory, `ACAD2018`, `DXF`, no recursion, audit enabled, and a DWG filter. It uses isolated temporary directories, a two-minute timeout, and removes temporary files after processing. On headless Linux, the adapter defaults `QT_QPA_PLATFORM` to `offscreen`; install the converter’s required platform libraries separately.

Alternatively, configure a custom conversion executable:

```dotenv
DWG_CONVERTER_PATH=/absolute/path/to/converter-wrapper
```

The executable contract is:

```text
converter-wrapper /absolute/input.dwg /absolute/output.dxf
```

It must exit successfully and produce an ASCII DXF. ODA takes precedence if both paths are set. The paths are executable paths, not shell commands.

Restart the server after changing converter configuration. Drawings awaiting conversion can then be reprocessed using **Retry** in Drawing Library. You can also export ASCII DXF from AutoCAD and upload that revision.

The converter integration is tested with a controlled executable fixture. Actual ODA conversion against production DWGs still requires the installed converter and representative drawings.

## Implemented checks

| Rule   | Check                                                                 |
| ------ | --------------------------------------------------------------------- |
| REV-01 | Tagged dimension changes between architectural revisions              |
| FW-01  | Door/window dimensions against current formwork                       |
| FW-02  | Beam/wall/slab tagged dimensions against current formwork             |
| REV-02 | New tagged elements and their formwork coverage                       |
| REV-03 | Removed architectural elements, especially those retained in formwork |
| QC-01  | Missing matching formwork measurements                                |
| QC-02  | Ambiguous tags with multiple measurements                             |
| QC-03  | Drawing units and tagged-measurement validation                       |

Tolerance is configurable per project in Settings. By default, differences at or below **1 mm** are ignored.

BOM/fabrication impact is included only after the designer explicitly confirms fabrication/BOM release in Settings. This records potential impact; item-level BOM ingestion and tracing are not implemented.

The checking engine is deterministic and explainable. This prototype uses no LLM credentials or external AI calls. Design Memory uses text search and tag matching over manually verified, source-linked records. Its illustrative seed references are not real approved project documents.

## Storage and authentication

Data lives in `.formiq/` by default:

```text
.formiq/
  formiq.sqlite       # projects, CAD models, runs, findings, audit events, users, sessions
  uploads/            # immutable original drawing uploads
```

`FORMIQ_DATA_DIR` can point to a persistent mounted directory. Keep the database and originals together when backing up. Use SQLite’s backup mechanism or stop the application before copying the directory, because WAL files can contain recent writes.

Passwords use salted scrypt hashes. Sessions use random opaque tokens stored as hashes, expire after seven days, and are sent in HttpOnly, SameSite cookies. Invalid login attempts are rate limited. Mutating APIs reject cross-origin browser requests. Authenticated users share one workspace; this prototype does not implement organization tenancy, SSO, role administration, or a password-reset flow.

## Private workspace configuration

Create `.env.local` using `.env.example`, then configure a **new data directory** and administrator credentials:

```dotenv
FORMIQ_DEMO=false
FORMIQ_DATA_DIR=.formiq-private
FORMIQ_ADMIN_EMAIL=designer@your-company.com
FORMIQ_ADMIN_PASSWORD=replace-with-a-long-unique-password
FORMIQ_SECURE_COOKIES=false
```

The password must have 10–200 characters. The administrator account is provisioned only when the database has no users. Changing environment credentials does not alter an existing account. A separate data directory keeps the known demo account out of the private workspace.

Use `FORMIQ_SECURE_COOKIES=true` behind HTTPS. Production defaults to secure cookies and disables demo mode unless explicitly enabled.

## Build and deploy

```sh
npm run typecheck
npm test
npm run build
npm start
```

For a local production demo, explicitly set `FORMIQ_DEMO=true` and `FORMIQ_SECURE_COOKIES=false` in `.env.local` before starting over HTTP.

A Dockerfile and a local demo Compose configuration are included:

```sh
docker compose up --build
```

Compose exposes port 3000 and uses a persistent named volume. For private hosting, change the Compose environment to the private configuration above and serve behind HTTPS. The Docker image does not include ODA; install it with its platform dependencies in a custom image or use the configured wrapper.

This version expects a **single Node.js server with persistent disk**. Ephemeral serverless deployments are unsuitable for its local SQLite database and upload storage. Distributed production deployment needs shared object storage, a managed database, background CAD jobs, and access-control expansion. Docker configuration is provided but has not been executed in this workspace.

## Verification

`npm test` exercises the actual analysis engine, SQLite transactions, and Next.js API handlers without requiring a running HTTP server. Coverage includes the D14 mismatch, tolerance, unit conversion, block transforms, ambiguous tags, removed elements, malformed files, authentication, original-file retrieval, upload statuses, designer decisions, historical-run preservation, source records, report escaping, CSV formula protection, cross-origin writes, and the DWG executable adapter.

Browser tests are included:

```sh
npm run test:e2e
```

By default they use installed Google Chrome on macOS. Set `PLAYWRIGHT_CHROME_PATH` for another executable. The test runner starts an isolated Next.js server on port 3011 using `.formiq-e2e` and `.next-e2e`. It does not reuse the application running on port 3000 or change its database. If Chrome is unavailable, install a Playwright browser with `npx playwright install chromium`.

For an isolated production build check while a development server is running, use `npm run build:check`. It builds a temporary source copy using the installed dependencies and removes the copy afterward, leaving development artifacts and data untouched.

In the build environment, local server sockets and headless Chrome launch are blocked. Browser tests and visual screenshots could not be completed here; the backend tests, TypeScript check, and production build were validated separately.

## Code map

| Location                                | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `app/`                                  | Next.js App Router pages and responsive global styles                     |
| `app/api/[...path]/route.ts`            | Authenticated backend route handlers and input validation                 |
| `components/workspace.tsx`              | Dashboard, projects, library, review, register, memory, reports, settings |
| `components/cad-viewer.tsx`             | CAD geometry, overlays, layers, markers, zoom and pan                     |
| `lib/cad.ts`                            | Focused ASCII DXF extraction and unit normalization                       |
| `lib/converter.ts`                      | Configurable DWG-to-DXF executable adapters                               |
| `lib/analysis.ts`                       | Source-linked revision and coordination rules                             |
| `lib/request-body.ts` / `lib/errors.ts` | Streaming request limits and expected HTTP failures                       |
| `lib/format.ts` / `lib/geometry.ts`     | Deterministic display formatting and shared SVG arc geometry              |
| `lib/db.ts` / `lib/auth.ts`             | SQLite persistence, audit trail, users and sessions                       |
| `lib/reports.ts`                        | Marked-up printable HTML and CSV exports                                  |
| `public/samples/`                       | Downloadable illustrative drawing set                                     |
| `tests/`                                | CAD, storage, API integration, and browser tests                          |

CAD group-code handling follows [Autodesk’s DIMENSION reference](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-EDD54EAC-A339-4EBA-AEA6-EC8066505E2B.htm) and [HEADER / unit reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm). The backend uses [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers).

## Review and performance improvements

Drawing metadata is cached independently of CAD geometry in SQLite. `/api/workspace` returns summaries; authenticated `/api/drawings/:id` returns the full model only when needed by the comparison viewer. Existing databases gain this summary cache automatically, with their source data retained.

Reviews now include an optimistic version check. Clients can pass `expectedVersion` when updating an issue; older records start at version 0. A stale update returns HTTP 409 instead of overwriting another tab’s decision. Refresh the workspace before retrying.

Password verification uses asynchronous scrypt. Login attempt reservations are atomic, including concurrent requests, and throttling returns HTTP 429. Upload request bytes are limited while streaming, even if Content-Length is absent or incorrect. Failed conversion retries retain an actionable failure status; ready drawings cannot be reprocessed and changed beneath historical runs.

Display dates and numbers use an explicit locale, with dates shown in Asia/Kolkata time, to keep server and browser output consistent. Canvas geometry is memoized while panning; reports include arc geometry. See [the code review notes](docs/CODE_REVIEW.md) for the full findings and remaining scaling work.

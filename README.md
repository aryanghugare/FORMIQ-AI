# Kumkang Kind Ai'Tech

A Next.js application where users create an account, sign in, and use a private workspace to upload CAD drawings, compare Architecture revisions or Structure revisions, review findings and export reports. The original project presentation is included in the repository.

## Run with MongoDB

Requires Node.js 22.13+ and MongoDB Atlas (or a MongoDB replica set, for transactions).

```sh
npm ci
cp .env.example .env
```

If `.env` already exists, edit it rather than overwriting it. Set:

```dotenv
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@YOUR_CLUSTER.mongodb.net
MONGODB_DB=formiq
FORMIQ_DEMO=false
FORMIQ_SECURE_COOKIES=false
```

Keep the real URI private. It belongs only in server environment variables; never use `NEXT_PUBLIC_` for it. URI-encode special characters in credentials. Allow the application's host in Atlas Network Access and grant the database user read/write access to `formiq`.

```sh
npm run workspace:manage -- check
npm run dev
```

Open `http://localhost:3000`, choose **Create an account**, and enter your name, email and a password of at least 10 characters. Registration signs you in automatically. You can sign out and return through the normal login screen. Optional `FORMIQ_ADMIN_EMAIL` and `FORMIQ_ADMIN_PASSWORD` values provision an initial account; later environment changes do not reset an existing password.

**Forgot password:** use the link on the sign-in screen to request an email, open its link and choose a new password. Email delivery uses Nodemailer and your mailbox's SMTP server. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASSWORD`; `PASSWORD_RESET_FROM` optionally sets the sender and otherwise defaults to `SMTP_USER`. Gmail example: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=your-address@gmail.com`, and `SMTP_PASSWORD` set to a Google App Password generated after enabling 2-Step Verification. Use port 465 with `SMTP_SECURE=true` for direct TLS; other ports require STARTTLS. See [Nodemailer's Gmail guide](https://nodemailer.com/guides/using-gmail). Set `FORMIQ_APP_URL` to the application's public origin; Render's `RENDER_EXTERNAL_URL` is used automatically when no custom URL is set. For local Docker use `FORMIQ_APP_URL=http://localhost:3000` with `FORMIQ_SECURE_COOKIES=false`. Render's free web services block SMTP ports 25, 465 and 587; use the Starter plan configured in `render.yaml` for SMTP delivery ([Render limitations](https://render.com/docs/free)). Without SMTP configuration, the screen explains that reset is unavailable; it never exposes a recovery token. Links expire after 30 minutes, can be used once, and are stored only as hashes. A reset preserves the account's projects and drawings, revokes its existing sessions and invalidates its other reset links. At most three emails per address are sent in 15 minutes. Existing administrator password-reset commands remain available without email configuration.

When `MONGODB_URI` is set, accounts, sessions, projects, findings, history and design memory use MongoDB collections. Original CAD files and parsed models use **GridFS**, including files larger than MongoDB's 16 MB document limit. See [MongoDB's GridFS documentation](https://www.mongodb.com/docs/drivers/node/current/crud/gridfs/). No S3 or Render storage disk is required. Docker only packages and runs the app.

MongoDB starts with an empty workspace and does not seed demo data. Existing local SQLite data is preserved but is not automatically migrated. Without `MONGODB_URI`, the original SQLite/local-file mode remains available; `FORMIQ_DEMO=true` enables its sample workspace.

## Use the app

1. **Projects:** create and select your project.
2. **Drawing library:** upload previous and latest DWG or DXF drawings. Choose Architecture or Structure as the discipline.
   Use **Edit** to correct the name, revision or discipline, and **Delete** to remove an unused drawing and its stored files. Drawings used in an analysis are protected to preserve review history.
3. **Revision review:** choose a discipline, select previous and latest revisions, then run analysis. Architecture compares with Architecture; Structure compares with Structure.
4. **Issue register:** inspect source-linked findings and accept, reject or investigate them with a note.
5. **Design memory:** save approved references and resolutions.
6. **Reports:** download CSV or printable HTML for a selected analysis.
7. **Settings:** set dimension tolerance and confirm fabrication/BOM release when applicable.
8. **Overview:** see project totals and recent activity. **Sign out** stays visible at the bottom of the sidebar.

Tagged dimensions and tagged schedule text retain their existing checks. Ordinary linear dimensions are matched by layer, reference point and direction; confirm these automatic matches. When either drawing lacks readable dimensions, geometry additions/removals are also compared at their existing coordinates. Moved geometry appears as removed and added, and plain numbers are not inferred as measurements. Dimension tolerance applies to dimension checks; geometry uses 0.001 mm coordinate precision. Existing dimension-free uploads are re-extracted from their originals during analysis when conversion is available. Geometry changes are summarized by spatial area and layer, with counts and highlighted extents. Up to 200 review areas are shown; overflow areas are combined into a summary with all change counts retained. Nearby canvas markers cluster at the current zoom, including markers in older analyses. Use Overlay, zoom and the findings list to inspect changes; Hide findings clears the markers. A large difference ratio prompts an origin/floor alignment check.

Every account has its own projects, drawings, findings, reports and design memory. Users cannot read or change another account's data. Existing data from the earlier shared workspace remains with its original account. Findings require designer validation; the app does not approve engineering drawings automatically.

Uploads are limited to 30 MB. ASCII DXF processing works directly. The Docker image includes LibreDWG 0.14 for DWG-to-DXF conversion, with a verified source archive checksum. Original files stay in MongoDB; conversion uses temporary files that are removed afterward. Advanced/custom CAD objects may be unsupported; validate the extracted geometry before relying on findings. Analysis is synchronous; use modest drawing sizes and monitor memory/storage usage.

## Start Docker locally

Install Docker Desktop and keep your MongoDB settings in `.env`. Stop `npm run dev` to free port 3000, then run:

```sh
npm run app:start
```

The script starts Docker Desktop on macOS/Windows, waits for it, builds the image with DWG conversion, and starts the real workspace at `http://localhost:3000`. It waits for the application's health check. It uses MongoDB and disables demo data. Existing MongoDB accounts and drawings remain available. Click **Retry** on previously uploaded DWG files. Use `npm run docker:logs` for logs and `npm run docker:stop` to stop the app without deleting MongoDB data. On Linux the script attempts a user Docker service; start your system Docker service manually if needed.

For `npm run dev` without Docker on macOS, run `brew install libredwg`, restart Next.js, then retry the drawing. `dwg2dxf` is detected automatically. An installed ODA converter or custom adapter can still be selected using `ODA_CONVERTER_PATH` or `DWG_CONVERTER_PATH`; `LIBREDWG_CONVERTER_PATH` selects an explicit `dwg2dxf` executable. See [LibreDWG's release](https://github.com/LibreDWG/libredwg/releases/tag/0.14) and [Homebrew installation](https://formulae.brew.sh/formula/libredwg).

## Deploy on Render

Deploy the complete Next.js application, frontend and API together:

- Root directory: `.`
- Runtime: Docker; Dockerfile: `./Dockerfile`.
- Environment: `MONGODB_URI`, `MONGODB_DB=formiq`, `FORMIQ_DEMO=false`, and `FORMIQ_SECURE_COOKIES=true`. Users create their own accounts.
- Health check: `/api/health`.
- No persistent disk, separate worker, PostgreSQL or S3 service.

`render.yaml` is a deployment template. Enter the URI privately in Render and allow Render's outbound addresses in Atlas. This single-app setup does not separately deploy the frontend on Vercel.

For another Docker host with an HTTPS proxy, supply an untracked `.env.production` file and run:

```sh
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

The existing `compose.yaml` is for the local SQLite demo.

## Optional account maintenance

Run from the project directory or Render Shell. Set `FORMIQ_USER_EMAIL`, `FORMIQ_USER_NAME`, and `FORMIQ_USER_PASSWORD` privately in the environment, then:

```sh
node scripts/manage.mjs add-user
node scripts/manage.mjs reset-password
node scripts/manage.mjs list-users
node scripts/manage.mjs remove-user
```

Locally, `npm run workspace:manage -- <command>` loads `.env` and `.env.local`. New/reset passwords require 12–200 characters. Reset/removal revokes sessions, and the last account cannot be removed. Public registration is available at `/register`. Password recovery remains an operator command; there is no email reset service.

For MongoDB backups, use Atlas backups if supported by your plan, or MongoDB Database Tools (`mongodump`/`mongorestore`) to back up the entire `formiq` database, including `drawings.files` and `drawings.chunks`. Verify restores into a separate database before relying on them. Automatic backups have not been configured by this repository. The `backup` and `verify-backup` management commands apply only to local SQLite mode.

## Checks

```sh
npm run typecheck
npm test
npm run build:check
npm run test:e2e
npm run test:mongo
```

`build:check` uses an isolated copy to avoid conflicts with a running dev server. Unit/API tests use temporary local data. `test:mongo` loads the configured MongoDB URI (or `FORMIQ_MONGO_TEST_URI` for a separate test replica set); it creates and drops only a uniquely named `formiq_test_*` database and checks registration, private account access, login/logout, GridFS files over 16 MB, the actual sample drawing comparison, reviews, reports, settings and persistence after reconnecting.

Live Atlas verification and local MongoDB/browser servers can be blocked by the coding environment's networking restrictions. A passing local test suite does not by itself verify your Atlas connection or deployed app.

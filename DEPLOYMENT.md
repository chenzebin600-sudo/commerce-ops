# Commerce Ops deployment

## Prerequisites

- Node.js 22 or newer
- npm
- Python 3.10 or newer for Mabang and advertising analysis
- Chrome, Chromium, or Edge for marketplace browser workflows

Run `npm install` once in each project directory, then run `npm run doctor`. The doctor is read-only: it checks configuration, runtimes, storage, SQLite, browser availability, ports, and internal authentication without installing software or changing `PATH`.

## Runtime paths

Copy `.env.example` to `.env` and configure only the values required by the target computer. Relative paths are resolved from `APP_ROOT`; an empty `APP_ROOT` means the directory containing the Commerce Ops server.

The default layout is:

```text
commerce-ops/
  storage/
    commerce-ops.sqlite
    uploads/
    exports/mabang/
    temp/
    chrome-user-data/
```

`DATABASE_PATH` controls the existing SQLite database. Keep it pointed at the current formal database during a move. Do not start the service with an empty replacement database. `SCHEDULER_DB_PATH` remains a compatibility fallback.

Python resolution order is `PYTHON_EXECUTABLE`, the configured/project `.venv`, then `python` and `python3`. Commerce Ops never installs Python or edits the operating-system `PATH`. Use `PYTHON_VENV_DIR` when the virtual environment has a different name.

## Advertising service

`AD_SERVICE_MODE=managed` lets the main service start and stop the child advertising service in `AD_SERVICE_DIR`. It verifies the service identity and internal authentication before accepting an occupied port. The main service only stops a child it created.

`AD_SERVICE_MODE=external` never starts a child. Start the advertising project separately with the same `AD_SERVICE_INTERNAL_TOKEN`, then point `AD_SERVICE_BASE_URL` at its loopback address.

Keep the advertising service on `127.0.0.1`. Browser and LAN users access it through `/ads/` and `/api/ads/*` on the main service.

## Commands

```text
npm start                 main service + scheduler + managed advertising service
npm run start:main        main service only
npm run start:scheduler   scheduler only
npm run start:ads         configured advertising service only
npm run doctor            read-only environment diagnostics
npm run build             syntax, frontend, and portable-path checks
npm test                  test suite
```

## Local, LAN, and cloud

Local use keeps `APP_HOST=127.0.0.1`. LAN or cloud use sets `APP_HOST=0.0.0.0` and a strong `APP_ACCESS_TOKEN`; open only the main application port in the firewall. Do not expose SQLite, the Chrome debugging port, or the advertising service port.

On Linux, configure `CHROME_EXECUTABLE` only when common `google-chrome` or `chromium` commands are unavailable. The controlled Chrome profile always lives under `DATA_ROOT` unless `CHROME_PROFILE_ROOT` is explicitly configured.

## Move to another computer

1. Stop the main service, scheduler, and managed child processes.
2. Copy both repositories, the formal SQLite database, and controlled storage roots.
3. Install Node and Python dependencies on the target computer.
4. Create a target-specific `.env`; do not copy secrets into Git.
5. Run `npm run doctor`, `npm run build`, and `npm test`.
6. Start with `npm start` and verify all four module pages before allowing external access.

The static `npm run check:paths` check rejects private drive paths and former machine-specific project paths. Intentional hostile path samples are limited to the centrally documented test exception list.

# KisanTractor Platform

A pnpm TypeScript monorepo for the responsive web/PWA and shared modular-monolith backend.

## Workspace

- `apps/web` — Next.js responsive web/PWA shell.
- `apps/api` — NestJS backend API.
- `packages/domain` — shared domain contracts and rules.
- `packages/database` — database client, migrations, and persistence helpers.
- `packages/providers` — OTP, maps, payments, messaging, storage, and telephony adapters.
- `packages/i18n` — locale catalogs for English, Hindi, Telugu, Kannada, and Tamil.
- `packages/config` — validated local, test, staging, and production configuration.
- `packages/test-utils` — shared deterministic test fixtures and utilities.

Package boundaries are intentionally present before their owning feature tasks add behavior. Provider capability behavior is not implemented in task 1.1.

## Pinned tools

Use Node.js `24.14.1` and pnpm `12.15.0`. The versions are pinned in `package.json`, `.nvmrc`, `.node-version`, and `.tool-versions`; JavaScript dependencies use exact versions and `pnpm-lock.yaml` records the complete graph.

## Configuration

Copy the appropriate `.env.<profile>.example` to a secret-managed runtime environment. Never commit populated `.env` files. `local` and `test` profiles have deterministic development defaults. `staging` and `production` require explicit database and public-origin values and enforce HTTPS public origins.

Both application startup paths call `@kisantractor/config` before listening. Validation errors list field names and constraints but never echo supplied values. Successful validation logs only the safe projection (environment, host/port, public origins, log level, PWA state, and whether a database URL exists).

```powershell
corepack prepare pnpm@12.15.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm config:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For a deployed process, supply `APP_ENV=staging` or `APP_ENV=production` with the corresponding variables. Local API and web development can be started with `pnpm dev`.

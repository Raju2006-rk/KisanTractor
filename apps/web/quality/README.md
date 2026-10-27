# Landing quality checks

Responsive, accessibility, metadata, link, and web-vital checks for the public landing page (Requirements 13.4, 13.5, 13.6, 16.6, 17.1). Profiles and budgets are defined once, in `profiles.ts`.

## Representative profiles

| Id | Kind | CSS viewport | DPR | CPU | Network |
| --- | --- | --- | --- | --- | --- |
| `low-end-mobile` | mobile (web-vital profile) | 360×640 | 2 | 4× slower | slow 4G |
| `narrow-mobile` | mobile | 320×568 | 2 | 4× slower | slow 4G |
| `tablet` | tablet | 768×1024 | 2 | 1× | none |
| `laptop` | laptop | 1366×768 | 1 | 1× | none |
| `desktop` | desktop | 1920×1080 | 1 | 1× | none |
| `desktop-zoom-200` | laptop at 200% zoom | 640×400 (1280×800 window) | 2 | 1× | none |

Slow 4G is Lighthouse's mobile preset as DevTools applies it: 562.5 ms added latency per request, 1474.56 Kbps down, 675 Kbps up (150 ms RTT and 1.6 Mbps before Lighthouse's devtools scaling). CPU and network shaping apply only to the web-vital lab runs; the layout and accessibility audits run unthrottled.

## Budgets

- Web vitals on `low-end-mobile`, nearest-rank 75th percentile of `KT_LAB_RUNS` cold loads (default 3): LCP ≤ 2.5 s, CLS ≤ 0.1, and observed interaction duration as the lab INP gate ≤ 200 ms. Total Blocking Time is recorded as a diagnostic but is not a Core Web Vital and does not replace the field INP metric.
- Transfer: each landing image crop ≤ 40 KB, all landing images at their largest crop ≤ 75 KB, startup JavaScript ≤ 180 KB gzip (framework included), CSS ≤ 16 KB gzip, HTML ≤ 30 KB gzip, and the aggregate compressed 3D model/texture payload under `public/models/landing` ≤ 1.5 MB.
- Accessibility: targets ≥ 44×44 CSS px, text contrast ≥ 4.5:1 (3:1 for large text), focus ring ≥ 2 px solid with ≥ 3:1 contrast against its surroundings, rendered text ≥ 14 px except decorative symbols.

## Suites

1. **Source checks** (`src/components/landing/landing-quality.test.ts`) run with every `corepack pnpm test`. They need no build or browser. They cover profile definitions, root and landing metadata, `<html lang>` for each locale, link targets for every locale and telephony state, hotlinking, heading order, landmarks, link names, CSS target sizes, token contrast computed from `globals.css`, font sizes, fixed widths, image dimensions and aspect ratios read from the committed files, image byte budgets, and render-blocking sources.
2. **Production checks** (`landing.production.test.ts`) run against `next start` on the current build:

   ```powershell
   corepack pnpm --filter @kisantractor/web build
   corepack pnpm --filter @kisantractor/web test:landing
   ```

   - *Production HTML* (HTTP only): localized head metadata, canonical and Open Graph tags, the manifest, that every link answers (200, or a redirect to `/login`), no `tel:` link while telephony is unconfigured, async-only scripts, the stylesheet inlined as one `<style>` block with no render-blocking `<link>` (`experimental.inlineCss`, task 15.3), gzip transfer budgets, and `Save-Data` crops.
   - *Browser lab* (headless Chrome, Edge, or Chromium over the DevTools protocol; no extra dependency). Each profile and locale gets an audit of horizontal overflow, target sizes, rendered contrast including gradient stops, text size, headings, landmarks, image space reservation, and `lang`. Each profile also gets a keyboard pass that Tabs through every control in DOM order and checks the focus ring. Low-end mobile and desktop get a reduced-motion comparison. Low-end mobile gets the throttled web-vital runs.

The suite is skipped unless `KT_LANDING_PRODUCTION_TESTS=1`, which `test:landing` sets. Without a browser the lab part is skipped. In CI, set `KT_REQUIRE_BROWSER=1` so that case fails instead.

| Variable | Effect |
| --- | --- |
| `KT_LANDING_BASE_URL` | Test an already running server instead of starting `next start`. |
| `KT_CHROME_PATH` | Browser executable; otherwise common Chrome, Edge, and Chromium paths are tried. |
| `KT_REQUIRE_BROWSER=1` | Fail when no browser is found. |
| `KT_LAB_RUNS` | Number of cold web-vital runs (default 3). |

`.github/workflows/landing-performance-budgets.yml` runs five cold loads with a required browser on pull requests that affect the web app. It separately runs `test:budgets`, which rejects aggregate compressed model/texture payloads over 1.5 MB before the production build.

The started server runs without `APP_ENV`, so the runtime uses the local profile. Every provider is UNCONFIGURED and no booking number exists, which is the launch state of the landing page.

The responsive audit of the Farmer and Owner screens (Requirement 17.1) uses these same profiles. It runs in the API load suite because those screens need a seeded API; see `ops/performance/initial-load-profile.md`. That page also records the task 15.3 landing measurements and what limits Total Blocking Time.

## Reading lab numbers

DevTools CPU throttling scales the host's speed, so results depend on the machine. Lighthouse calibrates for this with a benchmark index; this suite does not. Run the lab on CI hardware of known speed before treating a failure as a field regression. Field p75 values come from the `kt_web_vital_*` metrics (see `ops/observability`).

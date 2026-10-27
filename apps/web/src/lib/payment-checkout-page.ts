import { formatDateTime, formatIndianCurrency, localeMetadata, translate, type CatalogLocale } from "@kisantractor/i18n";

import type { OnlineCheckoutView } from "./payments";

/** The only third-party script the platform ever loads: Razorpay's hosted checkout. */
export const RAZORPAY_CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
export const CHECKOUT_LAUNCHER_PATH = "/checkout-launcher.js";

/**
 * Content security policy for the checkout launcher page only (task 16.2). The rest of the app is
 * unchanged. Scripts may come from this origin and Razorpay's checkout host; the checkout runs in a
 * Razorpay frame; forms may post only back to this origin. No inline script runs on the page.
 * Confirm the Razorpay hosts in the sandbox run before LIVE (ops/runbooks/online-payments.md).
 */
export const checkoutContentSecurityPolicy = [
  "default-src 'none'",
  `script-src 'self' https://checkout.razorpay.com`,
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "img-src 'self' data: https://*.razorpay.com",
  // Razorpay's script styles its own overlay inline.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const checkoutPageHeaders = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy": checkoutContentSecurityPolicy,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const style = `body{margin:0;font-family:system-ui,sans-serif;background:#fffdf7;color:#102f25;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:1.5rem 1rem}
h1{color:#006b3a;font-size:1.5rem;margin:0 0 1rem}
.card{border:1px solid #b9c9bf;border-radius:12px;background:#fff;padding:1rem;margin:0 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0 0 1rem}dt{font-weight:600}dd{margin:0}
.button{display:inline-block;min-height:44px;min-width:44px;padding:0 1.25rem;border-radius:10px;border:2px solid #006b3a;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;line-height:40px}
.primary{background:#006b3a;color:#fff}.secondary{background:#fff;color:#006b3a}
.button:disabled{opacity:.6;cursor:not-allowed}
.button:focus-visible{outline:3px solid #075fbd;outline-offset:2px}
.chip{display:inline-block;border:1px solid #075fbd;color:#075fbd;border-radius:999px;padding:0 .5rem;font-weight:600}
.alert{border-left:4px solid #b3261e;padding:.5rem .75rem;background:#fdecea}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

const page = (locale: CatalogLocale, body: string, scripts = "") => `<!doctype html>
<html lang="${escapeHtml(localeMetadata[locale].intlLocale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#006b3a">
<meta name="robots" content="noindex">
<title>${escapeHtml(translate(locale, "payment.checkout.title"))} · ${escapeHtml(translate(locale, "app.name"))}</title>
<style>${style}</style>
</head>
<body>
<main id="main-content">
${body}
</main>
${scripts}</body>
</html>
`;

const bookingHref = (bookingId: string | undefined) =>
  bookingId === undefined ? "/farmer/bookings" : `/farmer/bookings/${encodeURIComponent(bookingId)}#payment-section`;

/**
 * The checkout launcher: a minimal, script-light page that opens Razorpay's checkout for one
 * pending online payment. The provider script loads only here, only when the server returned a
 * live or sandbox checkout. Whatever the checkout reports, the page only posts back that the
 * Farmer returned; the bill counts the money only after verified provider evidence.
 */
export function buildCheckoutPage(locale: CatalogLocale, view: OnlineCheckoutView): string {
  const amount = formatIndianCurrency(locale, view.amountPaise);
  const deadline = formatDateTime(locale, view.expiresAt, { timeZone: "Asia/Kolkata" });
  const data = {
    key: view.publicKey,
    order: view.providerReference,
    amount: String(view.amountPaise),
    "expires-at": view.expiresAt.toISOString(),
    name: translate(locale, "app.name"),
    description: `${translate(locale, "payment.receipt.booking")} ${view.bookingReference}`,
    "msg-opening": translate(locale, "payment.checkout.opening"),
    "msg-attempt-failed": translate(locale, "payment.checkout.attemptFailed"),
    "msg-unavailable": translate(locale, "payment.checkout.windowUnavailable"),
    "msg-expired": translate(locale, "payment.checkout.expired"),
  };
  const attributes = Object.entries(data).map(([name, value]) => `data-${name}="${escapeHtml(value)}"`).join(" ");
  const body = `<h1>${escapeHtml(translate(locale, "payment.checkout.title"))}</h1>
<div class="card" id="kt-checkout" ${attributes}>
${view.testMode ? `<p><span class="chip">${escapeHtml(translate(locale, "capability.sandboxLabel"))}</span> ${escapeHtml(translate(locale, "payment.testModeHelp"))}</p>` : ""}
<dl>
<dt>${escapeHtml(translate(locale, "payment.receipt.booking"))}</dt><dd>${escapeHtml(view.bookingReference)}</dd>
<dt>${escapeHtml(translate(locale, "payment.amount"))}</dt><dd>${escapeHtml(amount)}</dd>
</dl>
<p>${escapeHtml(translate(locale, "payment.checkout.deadline", { time: deadline }))}</p>
<p>${escapeHtml(translate(locale, "payment.checkout.authoritative"))}</p>
<button class="button primary" disabled id="kt-pay" type="button">${escapeHtml(translate(locale, "payment.checkout.pay", { amount }))}</button>
<p aria-live="polite" id="kt-status" role="status"></p>
<noscript><p class="alert">${escapeHtml(translate(locale, "payment.checkout.noScript"))}</p></noscript>
</div>
<form action="/api/farmer/payments/${encodeURIComponent(view.paymentId)}/checkout-return" id="kt-return" method="post">
<input name="bookingId" type="hidden" value="${escapeHtml(view.bookingId)}">
<input id="kt-outcome" name="outcome" type="hidden" value="returned">
</form>
<a class="button secondary" href="${escapeHtml(bookingHref(view.bookingId))}">${escapeHtml(translate(locale, "payment.checkout.back"))}</a>`;
  const scripts = `<script defer src="${RAZORPAY_CHECKOUT_SCRIPT_URL}"></script>
<script defer src="${CHECKOUT_LAUNCHER_PATH}"></script>
`;
  return page(locale, body, scripts);
}

export type CheckoutPageProblem = "unavailable" | "not-found" | "not-pending" | "expired" | "failed";

/** The same page when no checkout can be opened. It loads no script at all. */
export function buildCheckoutProblemPage(locale: CatalogLocale, problem: CheckoutPageProblem, bookingId: string | undefined): string {
  const key = problem === "unavailable" ? "payment.online.unavailable"
    : problem === "not-found" ? "payment.checkout.notFound"
      : problem === "not-pending" ? "payment.checkout.notPending"
        : problem === "expired" ? "payment.checkout.expired" : "payment.checkout.failed";
  return page(locale, `<h1>${escapeHtml(translate(locale, "payment.checkout.title"))}</h1>
<div class="card"><p class="alert" role="alert">${escapeHtml(translate(locale, key))}</p>
<a class="button secondary" href="${escapeHtml(bookingHref(bookingId))}">${escapeHtml(translate(locale, "payment.checkout.back"))}</a></div>`);
}

/**
 * The launcher script, served from this origin so the page needs no inline script. It opens the
 * provider checkout on an explicit press and, when the checkout closes, posts only "returned" or
 * "dismissed" back: the payment id and signature the checkout reports are never sent anywhere.
 */
export const checkoutLauncherScript = `(function () {
  "use strict";
  var root = document.getElementById("kt-checkout");
  var button = document.getElementById("kt-pay");
  var status = document.getElementById("kt-status");
  var form = document.getElementById("kt-return");
  var outcome = document.getElementById("kt-outcome");
  if (!root || !button || !status || !form || !outcome) return;
  var data = root.dataset;
  var expiresAt = Date.parse(data.expiresAt || "");
  var finished = false;
  function say(text) { status.textContent = text || ""; }
  function finish(value) {
    if (finished) return;
    finished = true;
    outcome.value = value;
    form.submit();
  }
  function open() {
    if (typeof window.Razorpay !== "function") { say(data.msgUnavailable); return; }
    var remaining = Math.floor((expiresAt - Date.now()) / 1000);
    if (!(remaining > 30)) { say(data.msgExpired); button.disabled = true; return; }
    say(data.msgOpening);
    button.disabled = true;
    var checkout = new window.Razorpay({
      key: data.key,
      order_id: data.order,
      amount: Number(data.amount),
      currency: "INR",
      name: data.name,
      description: data.description,
      timeout: remaining,
      handler: function () { finish("returned"); },
      modal: { escape: true, confirm_close: true, ondismiss: function () { finish("dismissed"); } }
    });
    checkout.on("payment.failed", function () { say(data.msgAttemptFailed); });
    checkout.open();
  }
  button.addEventListener("click", open);
  button.disabled = false;
})();
`;

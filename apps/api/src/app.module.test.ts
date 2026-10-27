import "reflect-metadata";
import type { SqlConnection, SqlPool, SqlQueryResult } from "@kisantractor/database";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppModule,
  type AppModuleOverrides,
} from "./app.module.js";
import { OwnerCatalogController, FarmerPricingController, PrivateDocumentController } from "./catalog/index.js";
import { FarmerDiscoveryController, MapLocationController } from "./discovery/index.js";
import { FarmerJobController, OwnerJobController } from "./job/index.js";
import { FarmerPaymentController, OwnerPaymentController, PaymentWebhookController } from "./payment/index.js";
import { FarmerBookingController, OwnerBookingController } from "./booking/index.js";
import { IdentityController } from "./identity/index.js";
import { OwnerEarningsReportController } from "./reporting/index.js";
import type { RuntimeSecrets } from "./runtime-config.js";

/** A fake pool that never touches a database; no controller route hits it at wiring time. */
class FakeSqlPool implements SqlPool {
  async query<Row extends object = Record<string, unknown>>(): Promise<SqlQueryResult<Row>> {
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<SqlConnection> {
    throw new Error("The fake pool does not open connections");
  }
}

/** Deterministic 32-byte keys so the module builds without real secret material. */
const fakeSecrets: RuntimeSecrets = Object.freeze({
  FIELD_ENCRYPTION_KEY: new Uint8Array(32).fill(1),
  LOOKUP_HASH_KEY: new Uint8Array(32).fill(2),
  OTP_HASH_KEY: new Uint8Array(32).fill(3),
  SESSION_HASH_KEY: new Uint8Array(32).fill(4),
  PHONE_ENCRYPTION_KEY: new Uint8Array(32).fill(5),
  DISCOVERY_CURSOR_SIGNING_KEY: new Uint8Array(32).fill(6),
});

const overrides: AppModuleOverrides = {
  sqlPool: new FakeSqlPool(),
  secrets: fakeSecrets,
  config: {
    CONFIG_VERSION: "1",
    APP_ENV: "test",
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: 4100,
    PUBLIC_WEB_ORIGIN: "http://localhost:3100",
    PUBLIC_API_ORIGIN: "http://localhost:4100",
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    LOG_LEVEL: "warn",
    ENABLE_PWA: false,
    OTP_CAPABILITY_STATE: "UNCONFIGURED",
    MAPS_CAPABILITY_STATE: "UNCONFIGURED",
    PAYMENT_CAPABILITY_STATE: "UNCONFIGURED",
    MESSAGING_CAPABILITY_STATE: "UNCONFIGURED",
    STORAGE_CAPABILITY_STATE: "UNCONFIGURED",
    TELEPHONY_CAPABILITY_STATE: "UNCONFIGURED",
    ALLOW_LOCAL_OTP_CODES: false,
    ALLOW_UNSIGNED_PROVIDER_CALLBACKS: false,
    ALLOW_FAKE_PHONE_NUMBERS: false,
    ALLOW_TEST_PAYMENT_SUCCESS: false,
    // Cast matches the validated EnvironmentConfig union shape for the test profile.
  } as AppModuleOverrides["config"],
};

// Collect every registered express route path, following nested routers.
function collectRoutePaths(router: unknown): string[] {
  const paths: string[] = [];
  const stack = (router as { stack?: unknown[] } | undefined)?.stack;
  if (!Array.isArray(stack)) return paths;
  for (const layer of stack as Array<Record<string, unknown>>) {
    const route = layer.route as { path?: unknown; methods?: Record<string, boolean> } | undefined;
    if (route && typeof route.path === "string") {
      const methods = Object.keys(route.methods ?? {})
        .filter((method) => (route.methods as Record<string, boolean>)[method])
        .map((method) => method.toUpperCase());
      for (const method of methods) paths.push(`${method} ${route.path}`);
    } else if (layer.name === "router" && (layer.handle as { stack?: unknown[] })?.stack) {
      paths.push(...collectRoutePaths(layer.handle));
    }
  }
  return paths;
}

describe("AppModule composition root", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("resolves every controller when the module is compiled", async () => {
    app = await NestFactory.create(AppModule.register(overrides), { logger: false });
    await app.init();

    for (const controller of [
      OwnerCatalogController,
      FarmerPricingController,
      PrivateDocumentController,
      FarmerDiscoveryController,
      MapLocationController,
      OwnerJobController,
      FarmerJobController,
      FarmerPaymentController,
      OwnerPaymentController,
      PaymentWebhookController,
      OwnerEarningsReportController,
      IdentityController,
      FarmerBookingController,
      OwnerBookingController,
    ]) {
      const instance = app.get(controller, { strict: false });
      expect(instance).toBeInstanceOf(controller);
    }
  });

  it("registers the HTTP routes for every controller", async () => {
    app = await NestFactory.create(AppModule.register(overrides), { logger: false });
    await app.init();

    const express = app.getHttpAdapter().getInstance() as {
      _router?: unknown;
      router?: unknown;
    };
    const routes = collectRoutePaths(express._router ?? express.router);

    const expectedRoutes = [
      "GET /owner/profile",
      "PUT /owner/profile",
      "GET /owner/tractors",
      "POST /owner/tractors",
      "PUT /owner/tractors/:tractorId/availability",
      "GET /farmer/service-offerings/:serviceOfferingId/pricing-rules",
      "POST /farmer/service-offerings/:serviceOfferingId/quote-snapshots",
      "GET /owner/documents",
      "POST /owner/documents/upload-grants",
      "GET /owner/documents/:documentId/download-grant",
      "POST /farmer/discovery/search",
      "POST /locations/map-search",
      "POST /locations/map-pin",
      "GET /owner/bookings/:bookingId/job",
      "POST /owner/bookings/:bookingId/job/:action",
      "GET /farmer/bookings/:bookingId/job",
      "POST /farmer/bookings/:bookingId/dispute",
      "GET /farmer/bookings/:bookingId/payments",
      "GET /farmer/payments/:paymentId/receipt",
      "GET /owner/bookings/:bookingId/payments",
      "GET /owner/payments/:paymentId/receipt",
      "POST /owner/bookings/:bookingId/payments/cash",
      "POST /farmer/bookings/:bookingId/payments/online",
      "POST /farmer/payments/:paymentId/checkout-return",
      "POST /payments/webhooks/:provider",
      "GET /farmer/payments",
      "GET /owner/payments",
      "GET /owner/reports/earnings",
      "GET /farmer/payments/:paymentId/checkout",
      "POST /farmer/payments/:paymentId/status-check",
      "POST /farmer/payments/:paymentId/cancel",
      "POST /support/payments/:paymentId/refunds",
      "POST /identity/otp/challenges",
      "POST /identity/otp/verify",
      "GET /identity/session",
      "POST /identity/session/refresh",
      "POST /identity/session/revoke",
      "POST /account/deletion",
      "POST /farmer/bookings",
      "GET /farmer/bookings",
      "GET /farmer/bookings/:bookingId",
      "GET /owner/bookings",
      "GET /owner/bookings/:bookingId",
      "POST /owner/bookings/:bookingId/accept",
      "POST /owner/bookings/:bookingId/reject",
      "PUT /account/push-devices",
      "DELETE /account/push-devices",
      "GET /farmer/bookings/:bookingId/owner-contact",
    ];

    for (const expected of expectedRoutes) {
      expect(routes).toContain(expected);
    }
  });
});

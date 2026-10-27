import { validateEnvironment, type EnvironmentConfig } from "@kisantractor/config";
import { writeAuditEvent, type SqlPool } from "@kisantractor/database";
import type { Telemetry } from "@kisantractor/observability";
import {
  ProviderGatedMapsAdapter,
  type CapabilityRegistry,
  type ConfiguredMapGeocodingProvider,
} from "@kisantractor/providers";
import { Module, type DynamicModule, type Provider } from "@nestjs/common";

import {
  ACCOUNT_AUTHENTICATOR,
  ACCOUNT_DELETION_SERVICE,
  AccountController,
  AccountDeletionService,
  PostgresAccountDeletionStore,
} from "./account/index.js";
import { AuthorizationService, PostgresAuthorizationStore } from "./authorization/index.js";
import {
  BOOKING_AUTHENTICATOR,
  BOOKING_COMMAND_SERVICE,
  BOOKING_QUERY_SERVICE,
  BookingQueryService,
  BookingService,
  FarmerBookingController,
  OwnerBookingController,
  PostgresBookingQueryStore,
  PostgresBookingStore,
} from "./booking/index.js";
import {
  CATALOG_AUTHENTICATOR,
  DOCUMENT_AUTHENTICATOR,
  FarmerPricingController,
  OWNER_CATALOG_SERVICE,
  OwnerCatalogController,
  OwnerCatalogService,
  PRIVATE_DOCUMENT_SERVICE,
  PostgresCatalogStore,
  PostgresDocumentStore,
  PrivateDocumentController,
  PrivateDocumentService,
} from "./catalog/index.js";
import type { DocumentMalwareScanner } from "./catalog/index.js";
import {
  DISCOVERY_AUTHENTICATOR,
  DISCOVERY_SERVICE,
  MAPS_ADAPTER,
  DiscoveryService,
  FarmerDiscoveryController,
  MapLocationController,
  defaultDiscoveryPolicy,
  PostgresDiscoveryStore,
} from "./discovery/index.js";
import {
  IDENTITY_SERVICE_TOKEN,
  IdentityController,
  IdentityService,
  PostgresIdentityStore,
} from "./identity/index.js";
import {
  FarmerJobController,
  JOB_AUTHENTICATOR,
  JOB_BOOKING_SERVICE,
  JOB_SERVICE,
  JobService,
  OwnerJobController,
  PostgresJobStore,
} from "./job/index.js";
import {
  FarmerOnlinePaymentController,
  FarmerPaymentController,
  OwnerPaymentController,
  OwnerPaymentHistoryController,
  PAYMENT_AUTHENTICATOR,
  PAYMENT_HISTORY_SERVICE,
  PAYMENT_RECOVERY_SERVICE,
  PAYMENT_REFUND_SERVICE,
  PAYMENT_SERVICE,
  PAYMENT_WEBHOOK_TELEMETRY,
  PaymentHistoryService,
  PaymentRecoveryService,
  PaymentRefundService,
  PaymentService,
  PaymentWebhookController,
  PostgresPaymentStore,
  SupportPaymentController,
} from "./payment/index.js";
import { DenyAllSupportAccessPolicy, type SupportAccessPolicy } from "./authorization/index.js";
import {
  FarmerDisputeCaseController,
  OwnerDisputeCaseController,
  PostgresSupportAccessPolicy,
  PostgresSupportCaseStore,
  SUPPORT_AUTHENTICATOR,
  SUPPORT_CASE_SERVICE,
  SupportCaseController,
  SupportCaseService,
  supportAccessEvaluator,
} from "./support/index.js";
import {
  OWNER_EARNINGS_REPORT_SERVICE,
  OwnerEarningsReportController,
  OwnerEarningsReportService,
  PostgresEarningsReportStore,
} from "./reporting/index.js";
import {
  buildConfiguredMessaging,
  createMessagingDirectory,
  FarmerOwnerContactController,
  OWNER_CONTACT_AUTHENTICATOR,
  OWNER_CONTACT_SERVICE,
  OwnerContactService,
  ownerContactSharingEnabled,
  PostgresMessagingDirectory,
  PostgresNotificationStore,
  PUSH_DEVICE_AUTHENTICATOR,
  PUSH_DEVICE_SERVICE,
  PushDeviceController,
  PushDeviceService,
  pushRegistrationAvailable,
} from "./notification/index.js";
import {
  buildCapabilityRegistry,
  buildIdentityRuntimeConfig,
  buildMapGeocodingAdapter,
  buildOnlinePaymentAdapter,
  loadMessagingProviderSecrets,
  loadPaymentProviderSecrets,
  loadRuntimeSecrets,
  type MessagingAdapterOptions,
  type MessagingProviderSecrets,
  type OnlinePaymentAdapterOptions,
  type PaymentProviderSecrets,
  type RuntimeSecrets,
  type SandboxProviders,
} from "./runtime-config.js";
import { createSqlPool } from "./sql-pool.js";
import { createProcessTelemetry } from "./telemetry.js";

/** Injection tokens for the composition-root singletons shared across modules. */
export const ENVIRONMENT_CONFIG = Symbol("ENVIRONMENT_CONFIG");
export const SQL_POOL = Symbol("SQL_POOL");
export const RUNTIME_SECRETS = Symbol("RUNTIME_SECRETS");
export const CAPABILITY_REGISTRY = Symbol("CAPABILITY_REGISTRY");
export const IDENTITY_SERVICE = Symbol("IDENTITY_SERVICE");
export const DOCUMENT_MALWARE_SCANNER = Symbol("DOCUMENT_MALWARE_SCANNER");
export const TELEMETRY = Symbol("TELEMETRY");
export const SUPPORT_ACCESS_POLICY = Symbol("SUPPORT_ACCESS_POLICY");

/**
 * Default malware scanner. No malware-scanning provider is configured in Phase 1,
 * so the scanner reports the scan as unavailable rather than falsely clean. The
 * document service maps this to a retryable "scan unavailable" response, keeping
 * capability honesty intact. A real scanner can replace this provider later.
 */
export class UnavailableDocumentMalwareScanner implements DocumentMalwareScanner {
  async scan(): Promise<"UNAVAILABLE"> {
    return "UNAVAILABLE";
  }
}

export interface AppModuleOverrides {
  /** Supplies the environment config, defaulting to validated process.env. */
  readonly config?: Readonly<EnvironmentConfig>;
  /** Supplies the SqlPool, letting tests inject a fake without a live database. */
  readonly sqlPool?: SqlPool;
  /** Supplies runtime secrets, letting tests avoid real key material. */
  readonly secrets?: RuntimeSecrets;
  /** Supplies the process telemetry (logger, metrics, tracer, indicators). */
  readonly telemetry?: Telemetry;
  /**
   * Sandbox provider handles for capabilities configured as SANDBOX. Honoured only in
   * local/test (see buildCapabilityRegistry); production never registers them.
   */
  readonly sandboxProviders?: SandboxProviders;
  /** Injectable configured map/geocoding provider; its mode must match MAPS_CAPABILITY_STATE. */
  readonly mapsProvider?: ConfiguredMapGeocodingProvider;
  /** Replaces the unavailable malware scanner, for example with a labelled sandbox scanner. */
  readonly documentScanner?: DocumentMalwareScanner;
  /**
   * Online payment provider secrets, defaulting to the process environment when PAYMENT_PROVIDER
   * names a provider. Tests pass synthetic values here instead of real credentials.
   */
  readonly paymentProviderSecrets?: PaymentProviderSecrets;
  /** Injectable HTTP client for the payment adapter, so tests never call the provider. */
  readonly paymentProviderHttp?: OnlinePaymentAdapterOptions["http"];
  /** MSG91/FCM secrets, defaulting to the process environment when SMS_PROVIDER or PUSH_PROVIDER names one. */
  readonly messagingProviderSecrets?: MessagingProviderSecrets;
  /** Injectable HTTP client for the messaging adapters, so tests never call MSG91 or FCM. */
  readonly messagingProviderHttp?: MessagingAdapterOptions["http"];
  /**
   * Replaces the server-side support access policy used by support cases and refunds. Without it,
   * the API uses the grant-backed PostgresSupportAccessPolicy when ENABLE_SUPPORT_WORKFLOWS=true and
   * the deny-all policy otherwise (task 16.5).
   */
  readonly supportAccessPolicy?: SupportAccessPolicy;
  /**
   * Server clock for catalog, discovery, booking, job, payment, and document services. Session
   * issuance and expiry always use the real clock. Tests use this to record work durations.
   */
  readonly domainClock?: () => Date;
}

/**
 * Composition root for the API. Registers every existing controller and wires the
 * domain services, Postgres stores, the shared SqlPool, the session authenticator,
 * and the capability registry from validated environment configuration.
 */
@Module({})
export class AppModule {
  static register(overrides: AppModuleOverrides = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: ENVIRONMENT_CONFIG,
        useFactory: (): Readonly<EnvironmentConfig> =>
          overrides.config ?? validateEnvironment(process.env),
      },
      {
        provide: RUNTIME_SECRETS,
        useFactory: (): RuntimeSecrets =>
          overrides.secrets ?? loadRuntimeSecrets(process.env),
      },
      {
        provide: SQL_POOL,
        inject: [ENVIRONMENT_CONFIG],
        useFactory: (config: Readonly<EnvironmentConfig>): SqlPool =>
          overrides.sqlPool ?? createSqlPool(config.DATABASE_URL),
      },
      // Contact resolution for messaging and Owner contact sharing; decrypts only at send/reveal time.
      {
        provide: PostgresMessagingDirectory,
        inject: [SQL_POOL, RUNTIME_SECRETS],
        useFactory: (sqlPool: SqlPool, secrets: RuntimeSecrets): PostgresMessagingDirectory =>
          createMessagingDirectory(sqlPool, secrets),
      },
      {
        provide: CAPABILITY_REGISTRY,
        inject: [ENVIRONMENT_CONFIG, PostgresMessagingDirectory],
        useFactory: (config: Readonly<EnvironmentConfig>, directory: PostgresMessagingDirectory): CapabilityRegistry => {
          const onlinePayment = buildOnlinePaymentAdapter(
            config,
            overrides.paymentProviderSecrets ?? loadPaymentProviderSecrets(config, process.env),
            overrides.paymentProviderHttp === undefined ? {} : { http: overrides.paymentProviderHttp },
          );
          // The API sends nothing itself (the outbox worker does); it registers the same adapter so
          // the MESSAGING state it reports and the push-registration gate match the worker's.
          const messaging = buildConfiguredMessaging(
            config,
            overrides.messagingProviderSecrets ?? loadMessagingProviderSecrets(config, process.env),
            () => directory,
            overrides.messagingProviderHttp === undefined ? {} : { http: overrides.messagingProviderHttp },
          );
          // A test-provided maps handle wins; otherwise build one from configuration (Nominatim).
          const maps = overrides.mapsProvider ?? buildMapGeocodingAdapter(config);
          return buildCapabilityRegistry(config, overrides.sandboxProviders, {
            ...(maps === undefined ? {} : { MAPS_GEOCODING: maps }),
            ...(onlinePayment === undefined ? {} : { ONLINE_PAYMENT: onlinePayment }),
            ...(messaging === undefined ? {} : { MESSAGING: messaging }),
          });
        },
      },
      {
        provide: TELEMETRY,
        inject: [ENVIRONMENT_CONFIG],
        useFactory: (config: Readonly<EnvironmentConfig>): Telemetry =>
          overrides.telemetry ?? createProcessTelemetry(config, "api"),
      },
      {
        provide: DOCUMENT_MALWARE_SCANNER,
        useFactory: (): DocumentMalwareScanner =>
          overrides.documentScanner ?? new UnavailableDocumentMalwareScanner(),
      },

      // Shared session authenticator used by every controller's *_AUTHENTICATOR
      // token. IdentityService verifies access credentials into an AuthPrincipal.
      {
        provide: IDENTITY_SERVICE,
        inject: [SQL_POOL, CAPABILITY_REGISTRY, ENVIRONMENT_CONFIG, RUNTIME_SECRETS, TELEMETRY],
        useFactory: (
          sqlPool: SqlPool,
          capabilities: CapabilityRegistry,
          config: Readonly<EnvironmentConfig>,
          secrets: RuntimeSecrets,
          telemetry: Telemetry,
        ): IdentityService =>
          new IdentityService(
            new PostgresIdentityStore(sqlPool),
            capabilities,
            buildIdentityRuntimeConfig(config, secrets),
            undefined,
            telemetry.indicators,
          ),
      },

      // Authorization service and its store.
      {
        provide: AuthorizationService,
        inject: [SQL_POOL],
        useFactory: (sqlPool: SqlPool): AuthorizationService =>
          new AuthorizationService(new PostgresAuthorizationStore(sqlPool)),
      },

      // Booking service (used by the Farmer job dispute route).
      {
        provide: BookingService,
        inject: [SQL_POOL, RUNTIME_SECRETS, TELEMETRY],
        useFactory: (sqlPool: SqlPool, secrets: RuntimeSecrets, telemetry: Telemetry): BookingService =>
          new BookingService(new PostgresBookingStore(sqlPool), {
            fieldEncryptionKey: secrets.FIELD_ENCRYPTION_KEY,
            lookupHashKey: secrets.LOOKUP_HASH_KEY,
          }, overrides.domainClock, telemetry.indicators),
      },

      // Party-scoped booking reads shared by the Farmer and Owner clients.
      {
        provide: BookingQueryService,
        inject: [SQL_POOL],
        useFactory: (sqlPool: SqlPool): BookingQueryService =>
          new BookingQueryService(new PostgresBookingQueryStore(sqlPool)),
      },

      // Job tracking and billing service.
      {
        provide: JobService,
        inject: [SQL_POOL, TELEMETRY],
        useFactory: (sqlPool: SqlPool, telemetry: Telemetry): JobService =>
          new JobService(new PostgresJobStore(sqlPool), overrides.domainClock, telemetry.indicators),
      },

      // Payment records: settlement views, receipts, cash, and capability-gated online payments.
      {
        provide: PaymentService,
        inject: [SQL_POOL, TELEMETRY, CAPABILITY_REGISTRY],
        useFactory: (sqlPool: SqlPool, telemetry: Telemetry, capabilities: CapabilityRegistry): PaymentService =>
          new PaymentService(new PostgresPaymentStore(sqlPool), overrides.domainClock, telemetry.indicators, capabilities),
      },

      // Online checkout, pending-intent recovery, refunds, and party-scoped payment history.
      {
        provide: PaymentRecoveryService,
        inject: [SQL_POOL, TELEMETRY, CAPABILITY_REGISTRY],
        useFactory: (sqlPool: SqlPool, telemetry: Telemetry, capabilities: CapabilityRegistry): PaymentRecoveryService =>
          new PaymentRecoveryService(new PostgresPaymentStore(sqlPool), overrides.domainClock, telemetry.indicators, capabilities,
            undefined, ({ event, ...fields }) => {
              if (event === "payment.reconciliation.provider_error" || event === "payment.reconciliation.mismatch") {
                telemetry.logger.warn(event, fields);
              } else {
                telemetry.logger.info(event, fields);
              }
            }),
      },
      // Support access (task 16.5): explicit, time-bounded, audited grants once support workflows are
      // launched; deny-all otherwise, so no operator can read a case or request a refund.
      {
        provide: SUPPORT_ACCESS_POLICY,
        inject: [SQL_POOL, ENVIRONMENT_CONFIG],
        useFactory: (sqlPool: SqlPool, config: Readonly<EnvironmentConfig>): SupportAccessPolicy =>
          overrides.supportAccessPolicy ?? (config.ENABLE_SUPPORT_WORKFLOWS
            ? new PostgresSupportAccessPolicy(sqlPool, overrides.domainClock)
            : new DenyAllSupportAccessPolicy()),
      },
      {
        provide: PaymentRefundService,
        inject: [SQL_POOL, PaymentRecoveryService, TELEMETRY, CAPABILITY_REGISTRY, SUPPORT_ACCESS_POLICY],
        useFactory: (
          sqlPool: SqlPool,
          recovery: PaymentRecoveryService,
          telemetry: Telemetry,
          capabilities: CapabilityRegistry,
          supportAccess: SupportAccessPolicy,
        ): PaymentRefundService =>
          new PaymentRefundService(new PostgresPaymentStore(sqlPool), recovery,
            supportAccess, overrides.domainClock, telemetry.indicators, capabilities),
      },
      // Dispute cases: support review and resolution, and the parties' views of their dispute.
      {
        provide: SupportCaseService,
        inject: [SQL_POOL, SUPPORT_ACCESS_POLICY, PaymentRefundService],
        useFactory: (sqlPool: SqlPool, supportAccess: SupportAccessPolicy, refunds: PaymentRefundService): SupportCaseService =>
          new SupportCaseService(new PostgresSupportCaseStore(sqlPool), supportAccessEvaluator(supportAccess), refunds,
            overrides.domainClock),
      },
      {
        provide: PaymentHistoryService,
        inject: [SQL_POOL],
        useFactory: (sqlPool: SqlPool): PaymentHistoryService => new PaymentHistoryService(new PostgresPaymentStore(sqlPool)),
      },
      // Phase 4 Owner earnings: an on-demand, bounded projection over invoices/payments only.
      {
        provide: OwnerEarningsReportService,
        inject: [SQL_POOL],
        useFactory: (sqlPool: SqlPool): OwnerEarningsReportService =>
          new OwnerEarningsReportService(new PostgresEarningsReportStore(sqlPool), overrides.domainClock),
      },

      // Owner catalog and pricing service.
      {
        provide: OwnerCatalogService,
        inject: [SQL_POOL, RUNTIME_SECRETS],
        useFactory: (sqlPool: SqlPool, secrets: RuntimeSecrets): OwnerCatalogService =>
          new OwnerCatalogService(
            new PostgresCatalogStore(sqlPool, {
              fieldEncryptionKey: secrets.FIELD_ENCRYPTION_KEY,
              lookupHashKey: secrets.LOOKUP_HASH_KEY,
            }),
            {
              fieldEncryptionKey: secrets.FIELD_ENCRYPTION_KEY,
              lookupHashKey: secrets.LOOKUP_HASH_KEY,
            },
            overrides.domainClock,
          ),
      },

      // Private document service.
      {
        provide: PrivateDocumentService,
        inject: [
          SQL_POOL,
          AuthorizationService,
          CAPABILITY_REGISTRY,
          RUNTIME_SECRETS,
          DOCUMENT_MALWARE_SCANNER,
        ],
        useFactory: (
          sqlPool: SqlPool,
          authorization: AuthorizationService,
          capabilities: CapabilityRegistry,
          secrets: RuntimeSecrets,
          scanner: DocumentMalwareScanner,
        ): PrivateDocumentService =>
          new PrivateDocumentService(
            new PostgresDocumentStore(sqlPool),
            authorization,
            capabilities,
            {
              fieldEncryptionKey: secrets.FIELD_ENCRYPTION_KEY,
              lookupHashKey: secrets.LOOKUP_HASH_KEY,
            },
            scanner,
            overrides.domainClock,
          ),
      },

      // Capability-gated map enhancement. It only resolves normalized locations;
      // Discovery continues to own filtering/radius behavior.
      {
        provide: ProviderGatedMapsAdapter,
        inject: [CAPABILITY_REGISTRY],
        useFactory: (capabilities: CapabilityRegistry): ProviderGatedMapsAdapter =>
          new ProviderGatedMapsAdapter(
            capabilities,
            overrides.domainClock === undefined ? {} : { now: overrides.domainClock },
          ),
      },

      // Geospatial discovery service.
      {
        provide: DiscoveryService,
        inject: [SQL_POOL, RUNTIME_SECRETS, TELEMETRY],
        useFactory: (sqlPool: SqlPool, secrets: RuntimeSecrets, telemetry: Telemetry): DiscoveryService =>
          new DiscoveryService(
            new PostgresDiscoveryStore(sqlPool),
            secrets.DISCOVERY_CURSOR_SIGNING_KEY,
            defaultDiscoveryPolicy,
            overrides.domainClock,
            telemetry.indicators,
          ),
      },

      // Account deletion: erases personal data and keeps financial and audit records.
      {
        provide: AccountDeletionService,
        inject: [SQL_POOL],
        useFactory: (sqlPool: SqlPool): AccountDeletionService =>
          new AccountDeletionService(new PostgresAccountDeletionStore(sqlPool)),
      },

      // Self-service push-device registration, accepted only while push can be sent.
      {
        provide: PushDeviceService,
        inject: [PostgresMessagingDirectory, CAPABILITY_REGISTRY, ENVIRONMENT_CONFIG],
        useFactory: (
          directory: PostgresMessagingDirectory,
          capabilities: CapabilityRegistry,
          config: Readonly<EnvironmentConfig>,
        ): PushDeviceService => new PushDeviceService(directory, () => pushRegistrationAvailable(config, capabilities)),
      },

      // Consent-aware Owner contact sharing for the booking's Farmer (Requirement 3.4).
      {
        provide: OwnerContactService,
        inject: [SQL_POOL, PostgresMessagingDirectory, ENVIRONMENT_CONFIG],
        useFactory: (
          sqlPool: SqlPool,
          directory: PostgresMessagingDirectory,
          config: Readonly<EnvironmentConfig>,
        ): OwnerContactService => new OwnerContactService({
          enabled: ownerContactSharingEnabled(config),
          bookings: new PostgresNotificationStore(sqlPool),
          directory,
          audit: (event) => writeAuditEvent(sqlPool, event),
        }),
      },

      // Controller-facing token aliases bind the shared singletons to the exact
      // injection tokens each controller declares.
      { provide: ACCOUNT_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: ACCOUNT_DELETION_SERVICE, useExisting: AccountDeletionService },
      { provide: CATALOG_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: OWNER_CATALOG_SERVICE, useExisting: OwnerCatalogService },
      { provide: DOCUMENT_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: PRIVATE_DOCUMENT_SERVICE, useExisting: PrivateDocumentService },
      { provide: DISCOVERY_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: DISCOVERY_SERVICE, useExisting: DiscoveryService },
      { provide: MAPS_ADAPTER, useExisting: ProviderGatedMapsAdapter },
      { provide: JOB_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: JOB_SERVICE, useExisting: JobService },
      { provide: JOB_BOOKING_SERVICE, useExisting: BookingService },
      { provide: PAYMENT_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: PAYMENT_SERVICE, useExisting: PaymentService },
      { provide: PAYMENT_WEBHOOK_TELEMETRY, useExisting: TELEMETRY },
      { provide: PAYMENT_RECOVERY_SERVICE, useExisting: PaymentRecoveryService },
      { provide: PAYMENT_REFUND_SERVICE, useExisting: PaymentRefundService },
      { provide: PAYMENT_HISTORY_SERVICE, useExisting: PaymentHistoryService },
      { provide: OWNER_EARNINGS_REPORT_SERVICE, useExisting: OwnerEarningsReportService },
      { provide: IDENTITY_SERVICE_TOKEN, useExisting: IDENTITY_SERVICE },
      { provide: BOOKING_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: BOOKING_COMMAND_SERVICE, useExisting: BookingService },
      { provide: BOOKING_QUERY_SERVICE, useExisting: BookingQueryService },
      { provide: PUSH_DEVICE_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: PUSH_DEVICE_SERVICE, useExisting: PushDeviceService },
      { provide: OWNER_CONTACT_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: OWNER_CONTACT_SERVICE, useExisting: OwnerContactService },
      { provide: SUPPORT_AUTHENTICATOR, useExisting: IDENTITY_SERVICE },
      { provide: SUPPORT_CASE_SERVICE, useExisting: SupportCaseService },
    ];

    return {
      module: AppModule,
      controllers: [
        IdentityController,
        AccountController,
        FarmerBookingController,
        OwnerBookingController,
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
        FarmerOnlinePaymentController,
        OwnerPaymentHistoryController,
        OwnerEarningsReportController,
        SupportPaymentController,
        PushDeviceController,
        FarmerOwnerContactController,
        SupportCaseController,
        FarmerDisputeCaseController,
        OwnerDisputeCaseController,
      ],
      providers,
    };
  }
}

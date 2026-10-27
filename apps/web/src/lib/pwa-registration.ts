// Kept dependency-free so the client registrar does not bundle translation catalogs.
export const serviceWorkerPath = "/sw.js";
export const pwaCachePrefix = "kisantractor-";

/**
 * Service worker registration is a progressive enhancement. Every outcome other
 * than "registered" leaves the normal browser flows untouched, and nothing here
 * requests install prompts, notification permission, or push subscriptions.
 */
export type ServiceWorkerOutcome =
  | "registered"
  | "disabled"
  | "unsupported"
  | "insecure-context"
  | "failed";

interface RegistrationLike {
  readonly active?: { readonly scriptURL: string } | null;
  readonly installing?: { readonly scriptURL: string } | null;
  readonly waiting?: { readonly scriptURL: string } | null;
  unregister(): Promise<boolean>;
}

export interface ServiceWorkerHost {
  readonly isSecureContext?: boolean;
  readonly navigator?: {
    readonly serviceWorker?: {
      register(url: string, options?: RegistrationOptions): Promise<unknown>;
      getRegistrations?(): Promise<readonly RegistrationLike[]>;
    };
  };
  readonly caches?: {
    keys(): Promise<string[]>;
    delete(name: string): Promise<boolean>;
  };
}

export interface PwaRuntimeFlags {
  readonly pwaEnabled: boolean;
  readonly nodeEnvironment: string;
}

/** Development chunks are not content-hashed, so the worker only runs on production builds. */
export function shouldRegisterServiceWorker(config: PwaRuntimeFlags): boolean {
  return config.pwaEnabled && config.nodeEnvironment === "production";
}

export async function registerSafeServiceWorker(
  host: ServiceWorkerHost | undefined,
): Promise<ServiceWorkerOutcome> {
  try {
    const container = host?.navigator?.serviceWorker;
    if (!container || typeof container.register !== "function") return "unsupported";
    if (host?.isSecureContext === false) return "insecure-context";
    await container.register(serviceWorkerPath, { scope: "/", updateViaCache: "none" });
    return "registered";
  } catch {
    return "failed";
  }
}

const ownsWorker = (registration: RegistrationLike) =>
  [registration.active, registration.installing, registration.waiting].some((worker) => {
    if (!worker) return false;
    try {
      return new URL(worker.scriptURL).pathname === serviceWorkerPath;
    } catch {
      return false;
    }
  });

/** Rollback path when ENABLE_PWA is off: removes this app's worker and its caches. */
export async function unregisterSafeServiceWorker(
  host: ServiceWorkerHost | undefined,
  cachePrefix: string = pwaCachePrefix,
): Promise<number> {
  let removed = 0;
  try {
    const registrations = (await host?.navigator?.serviceWorker?.getRegistrations?.()) ?? [];
    for (const registration of registrations) {
      if (ownsWorker(registration) && (await registration.unregister())) removed += 1;
    }
    const names = (await host?.caches?.keys()) ?? [];
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix)).map((name) => host?.caches?.delete(name)));
  } catch {
    // Cleanup is best effort; browser flows never depend on it.
  }
  return removed;
}

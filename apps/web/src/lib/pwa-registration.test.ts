import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell, ServiceWorkerRegistrar } from "../components/shell";
import {
  pwaCachePrefix,
  registerSafeServiceWorker,
  serviceWorkerPath,
  shouldRegisterServiceWorker,
  unregisterSafeServiceWorker,
  type ServiceWorkerHost,
} from "./pwa-registration";

vi.mock("next/navigation", () => ({ usePathname: () => "/farmer" }));

function permissionSpies() {
  return {
    requestPermission: vi.fn(),
    subscribe: vi.fn(),
  };
}

/** Validates: Requirements 17.5 */
describe("progressive service worker registration", () => {
  it("only enables the worker for production builds with ENABLE_PWA on", () => {
    expect(shouldRegisterServiceWorker({ pwaEnabled: true, nodeEnvironment: "production" })).toBe(true);
    expect(shouldRegisterServiceWorker({ pwaEnabled: false, nodeEnvironment: "production" })).toBe(false);
    expect(shouldRegisterServiceWorker({ pwaEnabled: true, nodeEnvironment: "development" })).toBe(false);
    expect(shouldRegisterServiceWorker({ pwaEnabled: true, nodeEnvironment: "test" })).toBe(false);
  });

  it("reports unsupported browsers without throwing", async () => {
    await expect(registerSafeServiceWorker(undefined)).resolves.toBe("unsupported");
    await expect(registerSafeServiceWorker({ navigator: {} })).resolves.toBe("unsupported");
    const throwingNavigator = {
      get serviceWorker(): never {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    await expect(registerSafeServiceWorker({ navigator: throwingNavigator })).resolves.toBe("failed");
  });

  it("skips insecure contexts and swallows registration failures", async () => {
    const register = vi.fn().mockRejectedValue(new Error("quota"));
    await expect(registerSafeServiceWorker({ isSecureContext: false, navigator: { serviceWorker: { register } } })).resolves.toBe("insecure-context");
    expect(register).not.toHaveBeenCalled();
    await expect(registerSafeServiceWorker({ isSecureContext: true, navigator: { serviceWorker: { register } } })).resolves.toBe("failed");
  });

  it("registers the root-scoped worker without asking for notification or push permission", async () => {
    const spies = permissionSpies();
    const register = vi.fn().mockResolvedValue({ pushManager: { subscribe: spies.subscribe } });
    const host = {
      isSecureContext: true,
      navigator: { serviceWorker: { register } },
      Notification: { requestPermission: spies.requestPermission, permission: "default" },
    } satisfies ServiceWorkerHost & Record<string, unknown>;
    await expect(registerSafeServiceWorker(host)).resolves.toBe("registered");
    expect(register).toHaveBeenCalledWith(serviceWorkerPath, { scope: "/", updateViaCache: "none" });
    expect(spies.requestPermission).not.toHaveBeenCalled();
    expect(spies.subscribe).not.toHaveBeenCalled();
  });

  it("rolls back by removing only this app's worker and caches", async () => {
    const ours = { active: { scriptURL: `https://kisantractor.test${serviceWorkerPath}` }, unregister: vi.fn().mockResolvedValue(true) };
    const other = { active: { scriptURL: "https://kisantractor.test/other-worker.js" }, unregister: vi.fn().mockResolvedValue(true) };
    const deleteCache = vi.fn().mockResolvedValue(true);
    const host: ServiceWorkerHost = {
      navigator: { serviceWorker: { register: vi.fn(), getRegistrations: vi.fn().mockResolvedValue([ours, other]) } },
      caches: { keys: vi.fn().mockResolvedValue([`${pwaCachePrefix}shell-abc`, "other-app"]), delete: deleteCache },
    };
    await expect(unregisterSafeServiceWorker(host)).resolves.toBe(1);
    expect(ours.unregister).toHaveBeenCalledOnce();
    expect(other.unregister).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledExactlyOnceWith(`${pwaCachePrefix}shell-abc`);
    await expect(unregisterSafeServiceWorker(undefined)).resolves.toBe(0);
  });

  it("renders the Farmer and Owner shells identically whether or not the worker is enabled", () => {
    for (const role of ["FARMER", "OWNER"] as const) {
      const shell = renderToStaticMarkup(createElement(AppShell, { locale: "en", role, children: "content" }));
      for (const enabled of [true, false]) {
        const markup = renderToStaticMarkup(
          createElement(AppShell, { locale: "en", role, children: ["content", createElement(ServiceWorkerRegistrar, { enabled, key: "sw" })] }),
        );
        expect(markup).toBe(shell);
      }
    }
  });

  it("keeps core web flows free of install-prompt and push-permission gates", () => {
    const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
    const files = (function walk(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    })(sourceRoot);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      /Notification\.requestPermission|pushManager\.subscribe|beforeinstallprompt|serviceWorker\.ready/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

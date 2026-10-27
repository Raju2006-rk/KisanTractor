import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A minimal Chrome DevTools Protocol driver for the landing lab suite. It
 * launches an installed Chromium-family browser (Chrome, Edge, Chromium)
 * headless and talks to it over Node's built-in WebSocket, so the suite needs
 * no browser-automation dependency. Set `KT_CHROME_PATH` to choose the binary.
 */

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
  readonly sessionId?: string;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

export function findBrowserExecutable(): string | undefined {
  const configured = process.env.KT_CHROME_PATH;
  if (configured) return existsSync(configured) ? configured : undefined;
  const env = process.env;
  const candidates = process.platform === "win32"
    ? [
        `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/snap/bin/chromium",
          "/usr/bin/microsoft-edge",
        ];
  return candidates.find((candidate) => existsSync(candidate));
}

class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(message: CdpMessage) => void>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error(`${pending.method}: connection closed`));
      this.#pending.clear();
    });
  }

  static open(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.#nextId++;
    const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.#socket.send(JSON.stringify(message));
    });
  }

  listen(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#socket.close();
  }
}

export interface EvaluateResult<T> {
  readonly result: { readonly value?: T };
  readonly exceptionDetails?: { readonly text: string; readonly exception?: { readonly description?: string } };
}

/** One page in its own browser context (no shared cache, cookies, or service worker). */
export class CdpPage {
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #targetId: string;
  readonly #contextId: string;

  constructor(connection: CdpConnection, sessionId: string, targetId: string, contextId: string) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#contextId = contextId;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.#sessionId);
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    return this.#connection.listen((message) => {
      if (message.sessionId === this.#sessionId && message.method === method) handler(message.params ?? {});
    });
  }

  waitFor(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
      const stop = this.on(method, (params) => {
        clearTimeout(timer);
        stop();
        resolve(params);
      });
    });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<EvaluateResult<T>>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value as T;
  }

  /** Navigates and resolves after the load event. */
  async navigate(url: string, timeoutMs = 60_000): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired", timeoutMs);
    const response = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (response.errorText) throw new Error(`navigation to ${url} failed: ${response.errorText}`);
    await loaded;
  }

  async press(key: "Tab"): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  async click(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async hover(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async close(): Promise<void> {
    await this.#connection.send("Target.closeTarget", { targetId: this.#targetId }).catch(() => undefined);
    await this.#connection.send("Target.disposeBrowserContext", { browserContextId: this.#contextId }).catch(() => undefined);
  }
}

export class HeadlessBrowser {
  readonly #process: ChildProcess;
  readonly #connection: CdpConnection;
  readonly #profileDirectory: string;
  readonly version: string;

  private constructor(child: ChildProcess, connection: CdpConnection, profileDirectory: string, version: string) {
    this.#process = child;
    this.#connection = connection;
    this.#profileDirectory = profileDirectory;
    this.version = version;
  }

  static async launch(executable: string, timeoutMs = 30_000): Promise<HeadlessBrowser> {
    const profileDirectory = mkdtempSync(join(tmpdir(), "kt-landing-lab-"));
    const child = spawn(executable, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--mute-audio",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`browser did not start within ${timeoutMs} ms:\n${output}`)), timeoutMs);
      child.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`browser exited with ${code}:\n${output}`));
      });
    });
    const connection = await CdpConnection.open(endpoint);
    const { product } = await connection.send<{ product: string }>("Browser.getVersion");
    return new HeadlessBrowser(child, connection, profileDirectory, product);
  }

  async newPage(): Promise<CdpPage> {
    const { browserContextId } = await this.#connection.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await this.#connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.#connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new CdpPage(this.#connection, sessionId, targetId, browserContextId);
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Network.enable")]);
    return page;
  }

  async close(): Promise<void> {
    await this.#connection.send("Browser.close").catch(() => undefined);
    this.#connection.close();
    if (this.#process.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#process.kill();
          resolve();
        }, 5_000);
        this.#process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(this.#profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

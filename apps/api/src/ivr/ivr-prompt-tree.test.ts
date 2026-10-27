import { describe, expect, it } from "vitest";

import {
  IVR_PROMPT_TREES,
  IvrPromptEngine,
  IvrPromptError,
  ivrPromptCatalogs,
  ivrPromptLocales,
  renderIvrPromptMessage,
  type IvrPromptTurn,
} from "./index.js";

const enter = (engine: IvrPromptEngine, turn: IvrPromptTurn, digits: string): IvrPromptTurn =>
  engine.handleDigits(turn.session, turn.prompt.promptVersion, digits);

const verify = (engine: IvrPromptEngine, turn: IvrPromptTurn): IvrPromptTurn => {
  const pending = enter(engine, turn, "1234#");
  expect(pending.effect).toEqual({ kind: "VERIFY_CALLER", verificationCode: "1234" });
  return engine.resolveVerification(pending.session, true);
};

/** Validates: Requirements 15.2, 15.3, 15.4 */
describe("versioned localized IVR prompt tree", () => {
  it("collects a complete manual-location booking request in the documented order", () => {
    const engine = new IvrPromptEngine();
    let turn = engine.begin();

    expect(turn.prompt).toMatchObject({ treeVersion: 1, promptVersion: 1, state: "LANGUAGE", step: "LANGUAGE" });
    turn = enter(engine, turn, "3");
    turn = verify(engine, turn);
    turn = enter(engine, turn, "1"); // request service
    turn = enter(engine, turn, "2"); // manual administrative location
    turn = enter(engine, turn, "2"); // state
    turn = enter(engine, turn, "7"); // district
    turn = enter(engine, turn, "4"); // mandal/taluk
    turn = enter(engine, turn, "9"); // village
    turn = enter(engine, turn, "3"); // service
    turn = enter(engine, turn, "01062026");
    turn = enter(engine, turn, "0830");
    turn = enter(engine, turn, "5");

    expect(turn.prompt.state).toBe("CONFIRMATION");
    expect(turn.session.collected).toMatchObject({
      manualStateSelection: "2",
      manualDistrictSelection: "7",
      manualMandalSelection: "4",
      manualVillageSelection: "9",
      serviceSelection: "3",
      serviceDate: "01062026",
      serviceTime: "0830",
      quantity: "5",
    });

    turn = enter(engine, turn, "1");
    expect(turn.effect).toEqual({ kind: "SUBMIT_BOOKING" });
    expect(turn.prompt.messageKey).toBe("ivr.confirmation.submitting");

    turn = engine.resolveBookingSubmission(turn.session, "48151623");
    expect(turn.session.status).toBe("COMPLETED");
    expect(turn.prompt).toMatchObject({ state: "COMPLETED", acceptsInput: false });
    expect(turn.prompt.message).toContain("48151623");
  });

  it("supports saved locations, PIN locations, and externally validated saved-location selection", () => {
    const engine = new IvrPromptEngine();
    let turn = verify(engine, enter(engine, engine.begin(), "3"));
    turn = enter(engine, turn, "1");
    turn = enter(engine, turn, "1");
    turn = enter(engine, turn, "2");

    expect(turn.effect).toEqual({ kind: "SELECT_SAVED_LOCATION", selection: 2 });
    turn = engine.resolveSavedLocation(turn.session, true);
    expect(turn.prompt.state).toBe("SERVICE");

    let pinTurn = verify(engine, enter(engine, engine.begin(), "3"));
    pinTurn = enter(engine, pinTurn, "1");
    pinTurn = enter(engine, pinTurn, "3");
    pinTurn = enter(engine, pinTurn, "517501");
    expect(pinTurn.prompt.state).toBe("SERVICE");
    expect(pinTurn.session.collected.postalCode).toBe("517501");
  });

  it("requires verification before the booking menu and exposes status lookup as an explicit effect", () => {
    const engine = new IvrPromptEngine();
    let turn = enter(engine, engine.begin(), "3");
    const verification = enter(engine, turn, "987654#");

    expect(verification.session.state).toBe("VERIFICATION");
    expect(verification.session.pendingEffect).toBe("VERIFY_CALLER");
    expect(() => enter(engine, verification, "2")).toThrowError(IvrPromptError);

    turn = engine.resolveVerification(verification.session, true);
    turn = enter(engine, turn, "2");
    turn = enter(engine, turn, "12345678#");
    expect(turn.effect).toEqual({ kind: "LOOK_UP_BOOKING_STATUS", bookingReference: "12345678" });

    turn = engine.resolveBookingStatus(turn.session, "Scheduled");
    expect(turn.prompt.state).toBe("BOOKING_STATUS");
    expect(turn.prompt.message).toContain("Scheduled");
    const repeated = enter(engine, turn, "2");
    expect(repeated.prompt.message).toBe(turn.prompt.message);
    expect(enter(engine, repeated, "1").prompt.state).toBe("PURPOSE");
  });

  it("renders every version-one prompt in each configured regional language", () => {
    expect(IVR_PROMPT_TREES[1]?.version).toBe(1);
    for (const locale of ivrPromptLocales) {
      for (const node of Object.values(IVR_PROMPT_TREES[1]!.nodes)) {
        const rendered = renderIvrPromptMessage(locale, node.messageKey, {
          status: "scheduled",
          reference: "123456",
        });
        expect(rendered.trim().length, `${locale}:${node.messageKey}`).toBeGreaterThan(0);
        expect(rendered, `${locale}:${node.messageKey}`).not.toMatch(/\{(?:status|reference)\}/u);
      }
      expect(Object.keys(ivrPromptCatalogs[locale])).toEqual(Object.keys(ivrPromptCatalogs.en));
    }

    const engine = new IvrPromptEngine();
    const languageChoices = { "1": "te", "2": "hi", "3": "en", "4": "kn", "5": "ta", "6": "mr", "7": "bn" } as const;
    for (const [digit, locale] of Object.entries(languageChoices)) {
      const turn = enter(engine, engine.begin(), digit);
      expect(turn.prompt.locale).toBe(locale);
      expect(turn.prompt.message).toBe(ivrPromptCatalogs[locale]["ivr.verification"]);
    }
  });

  it("bounds invalid retries and transfers only when assisted transfer is configured", () => {
    const assisted = new IvrPromptEngine({
      maxRetries: 2,
      assistedTransfer: { enabled: true, digit: "0" },
    });
    let turn = assisted.begin();
    turn = enter(assisted, turn, "8");
    expect(turn.session).toMatchObject({ status: "ACTIVE", retryCount: 1 });
    turn = enter(assisted, turn, "8");
    expect(turn.session).toMatchObject({ status: "TRANSFERRED", state: "TRANSFERRED" });
    expect(turn.prompt.acceptsInput).toBe(false);

    const unattended = new IvrPromptEngine({ maxRetries: 1 });
    const terminated = enter(unattended, unattended.begin(), "8");
    expect(terminated.session).toMatchObject({ status: "TERMINATED", state: "TERMINATED" });
  });

  it("supports repeat and help without consuming retries, plus direct configured transfer", () => {
    const engine = new IvrPromptEngine({ assistedTransfer: { enabled: true } });
    const started = engine.begin("hi");
    const repeated = enter(engine, started, "*");
    const helped = enter(engine, repeated, "#");

    expect(repeated.prompt.message).toBe(started.prompt.message);
    expect(helped.prompt.message).toContain("हैश");
    expect(helped.session.retryCount).toBe(0);
    expect(helped.prompt.promptVersion).toBe(3);

    const transferred = enter(engine, helped, "0");
    expect(transferred.session.status).toBe("TRANSFERRED");
  });

  it("bounds timeouts and safely terminates or transfers after the configured limit", () => {
    const unattended = new IvrPromptEngine({ maxTimeouts: 2 });
    let turn = unattended.begin();
    turn = unattended.handleTimeout(turn.session, turn.prompt.promptVersion);
    expect(turn.prompt.messageKey).toBe("ivr.timeout");
    expect(turn.prompt.message).toContain("Welcome");
    turn = unattended.handleTimeout(turn.session, turn.prompt.promptVersion);
    expect(turn.session.status).toBe("TERMINATED");

    const assisted = new IvrPromptEngine({ maxTimeouts: 1, assistedTransfer: { enabled: true } });
    const transferred = assisted.handleTimeout(assisted.begin().session, 1);
    expect(transferred.session.status).toBe("TRANSFERRED");
  });

  it("rejects stale prompt responses, unknown tree versions, and invalid policy", () => {
    const engine = new IvrPromptEngine();
    const turn = engine.begin();
    expect(() => engine.handleDigits(turn.session, 0, "3")).toThrowError(/older or unknown/);
    expect(() => new IvrPromptEngine({ treeVersion: 99 })).toThrowError(/not registered/);
    expect(() => new IvrPromptEngine({ maxRetries: 0 })).toThrowError(/positive integers/);
    expect(() => new IvrPromptEngine({ assistedTransfer: { enabled: true, digit: "*" } })).toThrowError(/keypad digit/);
  });

  it("rejects malformed dates, times, quantities, references, and failed external resolutions", () => {
    const engine = new IvrPromptEngine({ maxRetries: 3 });
    let turn = verify(engine, enter(engine, engine.begin(), "3"));
    turn = enter(engine, turn, "1");
    turn = enter(engine, turn, "3");
    turn = enter(engine, turn, "517501");
    turn = enter(engine, turn, "1");

    const badDate = enter(engine, turn, "31022026");
    expect(badDate.session.retryCount).toBe(1);
    turn = enter(engine, badDate, "01062026");
    const badTime = enter(engine, turn, "2460");
    expect(badTime.prompt.state).toBe("TIME");
    turn = enter(engine, badTime, "0930");
    expect(enter(engine, turn, "0").prompt.state).toBe("QUANTITY");

    let status = verify(engine, enter(engine, engine.begin(), "3"));
    status = enter(engine, status, "2");
    expect(enter(engine, status, "12").prompt.state).toBe("BOOKING_STATUS_REFERENCE");
    status = enter(engine, status, "123456");
    const notFound = engine.resolveBookingStatus(status.session, null);
    expect(notFound.prompt.state).toBe("BOOKING_STATUS_REFERENCE");
    expect(notFound.session.retryCount).toBe(1);
  });
});

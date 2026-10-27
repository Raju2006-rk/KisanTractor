import { describe, expect, it, vi } from "vitest";

import { POST } from "./route";

/** Validates: Requirement 14.2 */
describe("OTP request capability gate", () => {
  it("redirects without an external side effect when OTP is unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = new Request("http://localhost:3000/api/auth/request-otp", {
      method: "POST",
      body: new URLSearchParams({ role: "farmer", phone: "9876543210", locale: "en" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    const response = await POST(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/capabilities/otp");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

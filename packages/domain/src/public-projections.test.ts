import { describe, expect, it } from "vitest";

import { projectPublicTractor } from "./public-projections.js";

describe("projectPublicTractor", () => {
  it("returns only public allowlisted fields and approximate location", () => {
    const projection = projectPublicTractor({
      id: "tractor-1",
      brand: "Mahindra",
      model: "575 DI",
      state: "Telangana",
      district: "Warangal",
      approximateDistanceKilometers: 3.4,
      ownerDisplayName: "Owner Name",
      ownerNamePublic: false,
      serviceNames: ["Ploughing"],
      pricingMethods: ["HOURLY"],
      available: true,
      privateFields: {
        ownerPhone: "+919876543210",
        exactCoordinates: { latitude: 17.9689, longitude: 79.5941 },
        registrationNumber: "TS00AA0000",
        documentObjectKeys: ["private/document.pdf"],
        otpMaterial: { codeHash: "secret" },
        paymentProviderPayload: { token: "provider-secret" },
      },
    });

    expect(projection).toEqual({
      id: "tractor-1",
      brand: "Mahindra",
      model: "575 DI",
      approximateLocation: { state: "Telangana", district: "Warangal" },
      approximateDistanceKilometers: 3.4,
      serviceNames: ["Ploughing"],
      pricingMethods: ["HOURLY"],
      available: true,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("17.9689");
    expect(serialized).not.toContain("private/document.pdf");
    expect(serialized).not.toContain("provider-secret");
  });

  it("includes an Owner display name only when public policy permits", () => {
    const projection = projectPublicTractor({
      id: "tractor-1",
      brand: "Sonalika",
      model: "DI 35",
      state: "Karnataka",
      district: "Mysuru",
      ownerDisplayName: "Permitted Name",
      ownerNamePublic: true,
      serviceNames: [],
      pricingMethods: [],
      available: false,
    });

    expect(projection.ownerDisplayName).toBe("Permitted Name");
  });
});

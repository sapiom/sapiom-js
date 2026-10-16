import { acceptLanguageHeader, secFetchDest, secFetchSite } from "./headers";

describe("secFetchSite", () => {
  it("reports same-origin, same-site, and cross-site", () => {
    expect(
      secFetchSite(
        "https://checkout.pci.shopifyinc.com/sessions",
        "https://checkout.pci.shopifyinc.com/blank",
      ),
    ).toBe("same-origin");
    expect(
      secFetchSite(
        "https://api.shop.example/pay",
        "https://shop.example/checkout",
      ),
    ).toBe("same-site");
    expect(
      secFetchSite(
        "https://checkout.pci.shopifyinc.com/sessions",
        "https://shop.example/checkout",
      ),
    ).toBe("cross-site");
  });

  it("returns undefined for a URL that cannot be parsed", () => {
    expect(secFetchSite("not a url", "https://shop.example/")).toBeUndefined();
  });
});

describe("acceptLanguageHeader", () => {
  it("uses Chrome q-values after the first language", () => {
    expect(acceptLanguageHeader(["en-US", "en"])).toBe("en-US,en;q=0.9");
  });
});

describe("secFetchDest", () => {
  it("is empty for fetch and xhr", () => {
    expect(secFetchDest("Fetch")).toBe("empty");
    expect(secFetchDest("XHR")).toBe("empty");
    expect(secFetchDest("Document")).toBeUndefined();
  });
});

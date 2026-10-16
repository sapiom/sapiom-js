import { canContinueWithoutReading, isSolverTraffic } from "./interceptor";

describe("isSolverTraffic", () => {
  it("matches captcha widgets and the browser solver, not the card host", () => {
    expect(
      isSolverTraffic(
        "https://hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
      ),
    ).toBe(true);
    expect(
      isSolverTraffic("https://newassets.hcaptcha.com/captcha/v1/abc/api.js"),
    ).toBe(true);
    expect(isSolverTraffic("https://api.hcaptcha.com/getcaptcha")).toBe(true);
    expect(
      isSolverTraffic("https://www.google.com/recaptcha/api2/anchor"),
    ).toBe(true);
    expect(
      isSolverTraffic("https://challenges.cloudflare.com/cdn-cgi/challenge"),
    ).toBe(true);
    expect(isSolverTraffic("https://api.anchorbrowser.io/v1/sessions")).toBe(
      true,
    );
    expect(
      isSolverTraffic("https://checkout.pci.shopifyinc.com/sessions"),
    ).toBe(false);
    expect(isSolverTraffic("https://1a2uh3-r7.myshopify.com/checkouts")).toBe(
      false,
    );
    expect(isSolverTraffic("not a url")).toBe(false);
  });
});

describe("canContinueWithoutReading", () => {
  const number = "4123456789012349";

  it("continues a GET or HEAD whose URL does not hold the placeholder", () => {
    expect(
      canContinueWithoutReading(
        "GET",
        "https://newassets.hcaptcha.com/captcha/v1/api.js",
        false,
        number,
      ),
    ).toBe(true);
    expect(
      canContinueWithoutReading(
        "HEAD",
        "https://example.com/style.css",
        false,
        number,
      ),
    ).toBe(true);
  });

  it("does not skip a body, a query holding the placeholder, or a POST", () => {
    expect(
      canContinueWithoutReading("GET", "https://example.com/a", true, number),
    ).toBe(false);
    expect(
      canContinueWithoutReading(
        "GET",
        `https://example.com/pay?card=${number}`,
        false,
        number,
      ),
    ).toBe(false);
    expect(
      canContinueWithoutReading(
        "GET",
        "https://example.com/pay?card=4123-4567-8901-2349",
        false,
        number,
      ),
    ).toBe(false);
    expect(
      canContinueWithoutReading(
        "POST",
        "https://example.com/sessions",
        false,
        number,
      ),
    ).toBe(false);
  });
});

import { isSolverTraffic } from "./interceptor";

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

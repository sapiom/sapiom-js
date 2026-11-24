/** Merchant formats inferred from checkout JavaScript; synthetic JWE values only. */
export function adyenBodies(blobs: Record<string, string>) {
  const returnUrl = "https://checkout.shop.example.co.uk/complete";
  // Shaped like Adyen Web stateData: a checkoutAttemptId (uuid, epoch ms,
  // hex), a base64 riskData blob and a dotted userAgent version.
  const state = {
    riskData: { clientData: "eyJ2ZXJzaW9uIjoiMS4wLjAifQ==" },
    paymentMethod: {
      type: "scheme",
      brand: "mc",
      ...blobs,
      checkoutAttemptId:
        "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e51795508000000a1b2c3d4e5f60718",
    },
    browserInfo: {
      userAgent: "Mozilla/5.0 Chrome/131.0.6778.85 Safari/537.36",
    },
    returnUrl,
  };
  const json = JSON.stringify(state);
  const flat = Object.fromEntries(
    Object.entries(blobs).map(([key, value]) => [
      key[0].toUpperCase() + key.slice(1),
      value,
    ]),
  );
  const names = [
    "dwfrm_adyPaydata_adyenStateData",
    "dwfrm_billing_creditCardFields_adyenStateData",
    "dwfrm_billing_adyenPaymentFields_adyenStateData",
  ];
  return [
    {
      name: "top-level JSON",
      contentType: "application/json",
      body: ` { "paymentMethod" : ${JSON.stringify(state.paymentMethod)}, "returnUrl" : "${returnUrl}", "note" : "café" }\n`,
    },
    {
      name: "flat JSON",
      contentType: "application/json",
      body: JSON.stringify({
        Type: "scheme",
        Brand: "visa",
        HolderName: "Synthetic",
        ...flat,
        ReturnUrl: returnUrl,
      }),
    },
    {
      name: "JSON in data",
      contentType: "application/json",
      body: JSON.stringify({ data: json, paymentMethod: "scheme" }),
    },
    ...names.map((name) => ({
      name: `urlencoded ${name}`,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      body: `csrf_token=synthetic%2btoken&${name}=${encodeURIComponent(json)}&note=a+b%20c`,
    })),
    ...names.map((name) => ({
      name: `multipart ${name}`,
      contentType: "multipart/form-data; boundary=SyntheticBoundary",
      body: `--SyntheticBoundary\r\nContent-Disposition: form-data; name="csrf_token"\r\n\r\nsynthetic-token\r\n--SyntheticBoundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${json}\r\n--SyntheticBoundary--\r\n`,
    })),
  ];
}

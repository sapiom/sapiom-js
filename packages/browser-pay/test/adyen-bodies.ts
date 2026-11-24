/** Merchant formats inferred from checkout JavaScript; synthetic JWE values only. */
export function adyenBodies(blobs: Record<string, string>) {
  const returnUrl = "https://checkout.shop.example.co.uk/complete";
  const state = {
    paymentMethod: { type: "scheme", brand: "mc", ...blobs },
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

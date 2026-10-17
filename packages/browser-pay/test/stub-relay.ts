import type { RelayRequest, RelayResponse } from "../src/contract";
import type { PaymentRelay, RelayCallOptions } from "../src/relay";

export function stubPaymentRelay(
  handler: (
    request: RelayRequest,
    options?: RelayCallOptions,
  ) => RelayResponse | Promise<RelayResponse>,
): PaymentRelay {
  return {
    relay(request, options) {
      return Promise.resolve(handler(request, options));
    },
  };
}

export { attachInterceptor } from "./interceptor.js";
export {
  StripePaymentElementVerification,
  createStripePaymentElementVerification,
} from "./stripe-verification.js";
export type {
  AttachOptions,
  FailureReason,
  InterceptorEvent,
  InterceptorHandle,
  InterceptorTarget,
  KnownRefusalReason,
  RefusalReason,
} from "./interceptor.js";

export { httpPaymentRelay } from "./relay.js";
export type {
  HttpRelayOptions,
  PaymentRelay,
  RelayCallOptions,
} from "./relay.js";

export type { RelayRequest, RelayResponse } from "./contract.js";

export type { HeldPlaceholder } from "./detect.js";

export type { PayLogger } from "./logger.js";

/** @experimental Purchase-bound verification opt-in; no built-in adapter. */
export type { ExperimentalVerificationOptions } from "./verification-types.js";

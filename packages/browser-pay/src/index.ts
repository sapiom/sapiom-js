export { attachInterceptor, resolveCdpUrl } from "./interceptor.js";
export type {
  AttachOptions,
  InterceptorEvent,
  InterceptorHandle,
  InterceptorTarget,
} from "./interceptor.js";

export { httpPaymentRelay, stubPaymentRelay } from "./relay.js";
export type {
  HttpRelayOptions,
  PaymentRelay,
  RelayCallOptions,
} from "./relay.js";

export {
  RELAY_REFUSAL_REASONS,
  isRelayRefusalReason,
  parseRelayResponse,
  paymentIdempotencyKey,
  relayHeadersFromRecord,
} from "./contract.js";
export type {
  RelayBodyEncoding,
  RelayHeader,
  RelayRefusal,
  RelayRefusalReason,
  RelayRequest,
  RelayResponse,
  RelaySuccess,
} from "./contract.js";

export {
  luhnHeldPan,
  matchHeldPlaceholderInBody,
  textHoldsPlaceholderNumber,
} from "./detect.js";
export type { BodyPlaceholderMatch, HeldPlaceholder } from "./detect.js";

export type { PayLogger } from "./logger.js";
export { silentLogger } from "./logger.js";

export { maskCardNumber, redact } from "./redact.js";

export { secFetchSite } from "./headers.js";
export type { SecFetchSite } from "./headers.js";

import type { CdpConnection } from "./cdp.js";

export interface VerificationState {
  id: string;
  version: number;
  status:
    | "preparing"
    | "requires_action"
    | "checking"
    | "ended"
    | "expired"
    | "canceled"
    | "error";
  expiresAt: string;
  challengeCaptured: boolean;
  launchClaimed: boolean;
  checkRequested: boolean;
  continuationClaimed: boolean;
  interactionReturned?: boolean;
  nativeReturnAvailable?: boolean;
  nativeReturnProtocol?: NativeReturn["protocol"];
  merchantOrigin: string;
  total: { amount: string; currency: string };
  actionUrl?: string;
  observation?: {
    outcome: "confirmed" | "failed" | "unknown";
    source: "runner";
    confirmation?: string;
  };
}
export type NativeReturn = { protocol: "stripe_3ds2"; cres: string };
export interface VerificationRunnerReply extends VerificationState {
  nativeReturn?: NativeReturn;
}
export interface VerificationRelayContext {
  frameId?: string;
  url?: string;
}
export interface VerificationRunner {
  sync(id: string): Promise<VerificationState>;
  report(
    id: string,
    input: Record<string, unknown>,
  ): Promise<VerificationRunnerReply>;
}
export interface VerificationRequest {
  url: string;
  method: string;
  body: string;
  sessionId: string;
  frameId?: string;
  networkId?: string;
}
export interface CheckoutObservation {
  outcome: "confirmed" | "failed" | "unknown";
  cardSession?: string;
  amount: string;
  currency: string;
  confirmation?: string;
}
export interface VerificationAdapter {
  continuation?(): Promise<
    | ((result?: NativeReturn) => Promise<void | { interactionReturned: true }>)
    | null
  >;
  dispose?(): void | Promise<void>;
  inspect(request: VerificationRequest): Promise<
    | "continue"
    | "block"
    | "fallback"
    | {
        capture: {
          url: string;
          body: string;
          nativeReturn?: NativeReturn["protocol"];
        };
      }
  >;
  relayed(
    response: { body: string },
    sessionId: string,
    context?: VerificationRelayContext,
  ): void;
  reconcile(state: VerificationState): Promise<CheckoutObservation | null>;
}
export interface VerificationHandle {
  current(): VerificationState;
  wait(): Promise<VerificationState>;
}
export type VerificationAdapterFactory = (
  connection: CdpConnection,
  state: () => VerificationState | undefined,
) => VerificationAdapter;

/** @experimental Prebound purchase capability; no automatic registration. */
export interface ExperimentalVerificationOptions {
  initial: VerificationState;
  runner: VerificationRunner;
}

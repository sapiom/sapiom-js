/**
 * Core primitives for advanced users
 *
 * Import from '@sapiom/sdk/core' for fine-grained control over Sapiom integration.
 *
 * @example
 * ```typescript
 * import { withSapiomHandling, createAxiosAdapter } from '@sapiom/sdk/core';
 * ```
 */

// Core authorizer (used by all integrations)
export { TransactionAuthorizer, TransactionDeniedError, TransactionTimeoutError } from './TransactionAuthorizer';
export type { TransactionAuthorizerConfig, AuthorizeTransactionParams } from './TransactionAuthorizer';

// Handlers
export { PaymentHandler } from './PaymentHandler';
export type { PaymentHandlerConfig } from './PaymentHandler';

export { AuthorizationHandler, AuthorizationDeniedError, AuthorizationTimeoutError } from './AuthorizationHandler';
export type { AuthorizationHandlerConfig, EndpointAuthorizationRule } from './AuthorizationHandler';

// Wrapper functions
export { withPaymentHandling, withAuthorizationHandling } from './wrappers';
export { withSapiomHandling } from './SapiomHandler';
export type { SapiomHandlerConfig } from './SapiomHandler';

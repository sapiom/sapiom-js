/**
 * Shopify Payments test-mode Visa. Shopify publishes this number for test
 * checkouts. It is not a live card. Logs must still mask it to the last four.
 */
export const SHOPIFY_PAYMENTS_TEST_CARD = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2030,
  cvc: "123",
} as const;

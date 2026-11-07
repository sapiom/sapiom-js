---
"@sapiom/browser-pay": minor
---

Add `fillCard`, which types the purchase's placeholder card into a checkout's card form over a Playwright page without an LLM. It finds the fields in every frame by `autocomplete`, name, label and provider attributes (Shopify's card vault, Stripe Elements, Braintree hosted fields, Adyen secured fields, plain inputs and expiry selects), ignores the off-screen autofill copies card vaults put in each field's iframe, handles a combined MM/YY field or split month and year, and reads each field back. It never logs or returns a card value and never presses Pay. Reword three README passages that used internal names.

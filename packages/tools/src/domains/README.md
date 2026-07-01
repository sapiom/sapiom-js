# domains

Register domain names and manage their DNS. The same domains capability your
agents call over MCP, callable directly from your code or from within a Sapiom
workflow step.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

// 1. Find an available name and its price (free).
const results = await sapiom.domains.check({
  domainNames: ["my-app.dev", "my-app.io", "get-my-app.com"],
});
const pick = results.find((r) => r.available);

// 2. Register it for a year (charges apply).
if (pick) {
  await sapiom.domains.register({ domainName: pick.domainName });

  // 3. Point it at your server.
  await sapiom.domains.dns.create({
    domainName: pick.domainName,
    type: "A",
    host: "", // "" = the root domain (@); or "www", "api", …
    value: "203.0.113.10",
  });
}
```

Ambient import works too: `import { domains } from "@sapiom/tools"`.

## Operations

Top-level (domains):

- `check({ domainNames })` — availability + pricing for up to 50 names (free).
- `register({ domainName })` — buy a domain for one year (**charges apply**).
- `renew({ domainName })` — extend a domain you own by one year (**charges apply**).
- `list()` — the domains you own.
- `get({ domainName })` — full details for a domain you own (nameservers, lock
  status, renewal price, transfer eligibility).
- `transferOut({ domainName })` — start a transfer to another registrar; returns
  an auth code to give the receiving registrar (**disruptive**).

`dns` (DNS records on a domain you own):

- `dns.create({ domainName, type, host, value, ttl?, priority? })`
- `dns.list({ domainName })`
- `dns.get({ domainName, recordId })`
- `dns.update({ domainName, recordId, type?, host?, value?, ttl?, priority? })`
- `dns.delete({ domainName, recordId })`

## DNS records

- **`type`** — one of `A`, `AAAA`, `ANAME`, `CNAME`, `MX`, `TXT`, `SRV`, `NS`.
- **`host`** — use `""` for the root domain (`@`), or a subdomain like `"www"` or
  `"api"`.
- **`ttl`** — seconds; minimum `300`, defaults to `300`.
- **`priority`** — required for `MX`, optional otherwise.
- **`recordId`** — returned from `dns.create` / `dns.list`; pass it to `dns.get`,
  `dns.update`, and `dns.delete`.

`dns.update` is a partial update: send only the fields you want to change; the
rest keep their current values.

## Gotchas

- **`register` and `renew` charge on success and are not reversible.** Check
  availability and price with `check` first. A rejected request (e.g. a domain you
  already own, or a malformed name) does not charge.
- **A newly registered domain is transfer-locked for 60 days** — `transferOut`
  is rejected until it becomes eligible (see `transferEligibleAt` on `get`).
- **Prices are decimal strings** (e.g. `"12.99"`), not numbers.
- **Failed requests throw `DomainsHttpError`** (carries `status` + parsed
  `body`), exported from `@sapiom/tools`.

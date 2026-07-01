---
"@sapiom/tools": minor
---

Add the `domains` capability — register domain names and manage their DNS. Check availability and pricing, register (buy) a domain for a year, renew it, list and inspect the domains you own, and start a transfer out; plus a nested `dns` group to create, list, get, update, and delete DNS records on a domain you own. Available as `sapiom.domains.*` on the client, as the ambient `domains` namespace, and from the `@sapiom/tools/domains` subpath. `register` and `renew` charge on success. Failed requests throw `DomainsHttpError`.

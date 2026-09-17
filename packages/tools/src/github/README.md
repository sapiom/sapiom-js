# github

List a tenant's GitHub repositories over their connected GitHub connector. The
same GitHub capability your agents call over MCP, callable directly from your
code or from within a Sapiom agent step. The tenant must have connected GitHub
first — an unconnected tenant gets a `404 connector_not_found`.

```typescript
import { createClient } from "@sapiom/tools";
const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY });

const repos = await sapiom.github.listRepos({ perPage: 20 });
for (const r of repos) {
  console.log(r.fullName, r.private ? "(private)" : "");
}
```

Ambient import works too: `import { github } from "@sapiom/tools"`.

## Operations

- `listRepos(args?)` — the tenant's repositories, executed server-side in the
  gateway (the PAT is injected there, never exposed to your run). `args` is
  optional (pagination / visibility filters).

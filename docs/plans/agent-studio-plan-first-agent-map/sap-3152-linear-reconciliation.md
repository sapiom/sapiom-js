# SAP-3152 Linear reconciliation ledger

Status: ready to apply from an authenticated Linear context. This environment
has no Linear CLI, credential, or connector, so no status, relation, comment,
or project description was changed or fabricated.

## Required updates

1. Mark SAP-3051 and children SAP-3059, SAP-3060, SAP-3061, and SAP-3064 Done;
   their E2 PRs are merged. Confirm the E1 parent/children are Done.
2. Make `SAP-3148 → SAP-3149 → SAP-3150 → SAP-3151 → SAP-3152` the only
   checkpoint execution chain.
3. Record the four post-E2 untracked merges as architecture drift corrected by
   SAP-3148/SAP-3152.
4. Resolve the concrete E6, E7, and E8 issue IDs in Linear, then rewrite them to
   consume the neutral current identity/version/brief/session contracts before
   they become executable.

| Old ticket | Ready-to-apply status | Replacement | Rationale |
| --- | --- | --- | --- |
| SAP-3048 | Cancel | SAP-3149 | Architecture confirmation no longer authorizes coding; immutable history survives |
| SAP-3047 | Supersede or rewrite remaining distinct later work | SAP-3149 + SAP-3150 | Durable plan and brief outcomes survive under universal authorship |
| SAP-3050 | Cancel elevation outcome; rewrite any distinct launch follow-up | SAP-3151 | Delegation is ordinary writable session creation, not an execution permission boundary |
| SAP-3062 | Supersede | SAP-3149 | Preserve canonicalization/ancestry; record sibling conflict with SAP-3067 |
| SAP-3067 | Supersede | SAP-3149 + SAP-3150 | Preserve store/records; remove role and eligibility authority |
| SAP-3068 | Supersede | SAP-3149 | Preserve four authoring operations; make discovery universal |
| SAP-3070 | Supersede | SAP-3150 | Preserve deterministic compiler/impact/projection under neutral context |
| SAP-3074 | Supersede | SAP-3151 | Preserve reliability; remove consent/read-only/fixed fan-out lifecycle |
| SAP-3063 | Inspect and disposition explicitly | To resolve in Linear | It is cited by the frozen #783 record but absent from the supplied minimum list |

The SAP-3147 final comment should link the replacement PRs, paste the frozen
legacy disposition table from the cutover ledger, record this ticket table, and
state that ownership-excluded work remained untouched and non-blocking.

The project description should preserve E0–E2 as historical foundations and
describe the verified current product: one capable project-agent identity, one
shared evolving map/plan, project-name map selection, ordinary session tabs,
optional focused briefs, writable nested delegation, append-only restoration,
manual-session preservation, and evidence that never silently becomes intent.

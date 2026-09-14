# Assistant continuation

Continue reconstructs context from a retained public Assistant record. The brief
names the source Studio session, native conversation, workspace and exact record
revision. It retains at most twelve recent turns within the existing 6,000-token
estimate, explicitly marks omissions and incomplete turns, and directs the
Assistant to wait for the next user message. It never implies restored native
memory or successful completion of interrupted work.

The lifecycle operation must freeze the child's context candidate and its own
acceptance ID durably before calling `AssistantContextDelivery.acceptFrozen`.
That method validates and detaches all input before authority checks, then uses
the existing accepted-source store. An identical retry preserves the acceptance;
conflicting input fails. The child must have its own Studio identity, native
conversation and authority scope. A parent's accepted reference is not reusable.

Frozen operation input is not a replacement accepted-source store. Composition
and recovery continue to read the exact retained acceptance through the shared
delivery coordinator. Missing committed material remains an execution error.
Native creation, synthetic no-reply seeding, operation receipts, and the public
Continue action are separate lifecycle consumers of these primitives.

The private operation receipt lives beside the source binding, outside native
engine storage. It freezes source revisions, child identity, brief, native
creation marker, seed IDs and pending acceptance input. Creation and seeding
intent are recorded before native mutations; an uncertain phase cannot reset.
An operation lock serializes external steps, while receipt updates use a
separate revision lock. A private child lookup is durable before allocation;
ordinary attachment is blocked until the linked receipt is verified prepared.
Missing or corrupt linked receipts fail closed. An existing receipt is read
before newer source history, so retries use the same frozen record and child.

Trusted continuation preparation shares the lifecycle admission slot with
inspection, Attach and Resume. It requires an open matching revision, retains
its exact host only after successful checks, and grants no runtime lease.
End preempts preparation; ordinary attachment follows verified preparation.
If a previous acceptance already committed, a retry validates its original
manifest and material before any writes. Pending receipt input cannot repair
lost committed material, including after a lost acceptance acknowledgement.

Native preparation writes intent before creation or seeding. A retry reconciles
the exact operation marker and native identity, then verifies one synthetic
no-reply message against both native read APIs, including its accepted system,
receipt IDs, text/hash and flags. Missing or ambiguous outcomes remain uncertain;
stable native message IDs are mutable and are never blindly resubmitted.
Preparing or reopening the child does not invoke a model or replay tools.

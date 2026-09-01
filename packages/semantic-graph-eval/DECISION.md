# SAP-3002 semantic enrichment experiment decision

Date: 2026-08-31
Status: complete experiment; contract direction supported, production rollout blocked

## Decision

Use Sapiom's `gpt-luna` routing label and the `bounded-source.v2` packet/prompt policy as the starting point for SAP-3003's private production contracts and for a larger shadow evaluation. Do not ramp semantic suggestions to users from this evidence alone.

The final eight-fixture holdout produced 6 TP, 0 FP, and 0 FN (precision/recall/F1 1.0), including correct edge decisions under prompt injection, bounded truncation, mixed positive/negative context, unsupported cycles, unrelated agents, and similar schemas. However, the frozen configuration produced 3 TP, 2 FP, and 1 FN on calibration (precision 0.6, recall 0.75, F1 0.667). Across calibration plus holdout it achieved 9 TP, 2 FP, and 1 FN: precision 0.818, recall 0.9, and F1 0.857. Both false positives were plausible-but-wrong reverse feeds in the sibling-invocation case. The deterministic validator correctly cannot remove that kind of semantic error.

The experiment therefore establishes that the end-to-end contract is workable and Luna can recover the desired residual flows, but it does not establish sufficient general precision, abstention behavior, latency, or cost observability for production exposure.

## Reproducible method

- Corpus: 18 synthetic immutable whole-project fixtures, split before real evaluation into 10 calibration and 8 holdout cases.
- Final evidence dataset: one global call for each of 40 calibration fixture/configuration identities and one for each of 8 frozen `bounded-source.v2` holdout identities, with no retries or repair calls.
- Provider: requested model `gpt-luna`, `neverFail: false`, forced tool `propose_semantic_feeds`.
- Serving disclosure: all 48 successful final calls reported class `medium`, lane `run_now`; no fallback, provider failure, or malformed attempt was observed.
- Validation: strict envelope/candidate parsing, known non-self endpoints, `feeds` only, real visible support refs, no duplicates or already-proven feeds. Cycles were not mechanically rejected.
- Scoring: accepted directed pairs were compared only after validation with the sibling hidden oracle. No model confidence was requested or used.
- Holdout discipline: all fixture hashes and all four versioned configurations existed before the first holdout output. `bounded-source.v2` was selected from the final calibration results and had not previously been run on holdout. No prompt, policy, source rule, or fixture content was changed after any holdout output; the model-visible inventory field and run-identity bookkeeping did change as disclosed below.
- Persistence: normalized working reports remain ignored under `.temp/semantic-graph-eval`; only their fingerprints and conclusions are committed here.

A preliminary 48-call dataset was discarded after self-review found that the model-visible packet did not explicitly carry the validated Protocol-1 inventory identity and that request identities lacked packet/prompt fingerprints. The packet and identity contract were corrected, then the complete calibration matrix was rerun under new packet/prompt/run identities. The preliminary run included `bounded-source.v1` holdout outputs, so the fixture set was no longer untouched even though `bounded-source.v2` holdout outputs remained unopened and no policy was tuned from the earlier holdout. This is a limitation, not hidden evidence: 96 paid provider calls were made in total, while every result below comes only from the final 48-call dataset.

Locked identities:

| Artifact                         | Fingerprint                                                               |
| -------------------------------- | ------------------------------------------------------------------------- |
| Final corpus manifest bytes      | `sha256:1cc2a9795c8e335893c654f76b0b89f85bd307fde2d4b1aed426fc584713d45f` |
| Calibration report corpus        | `sha256:1f2c10980056219babfb987f5fa06605dec790c6344340f4ae996f377d347a8e` |
| Holdout report corpus            | `sha256:4d0a97bc75264c7043a01c6d4b1cd962d2767c845e95aeb7ccffc82c8da97d36` |
| Deterministic 72-run mock report | `sha256:82e6615a7b1868677a67b9004cdfab8c86cfd6dfce961beabf420bd0141b4cc5` |

Configuration fingerprints:

| Configuration         | Fingerprint                                                               | Disposition                   |
| --------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| `facts-only.v1`       | `sha256:ed4a80828cabaf59400aefe04519684983b86cd830e0bf4fc71ba70dc6602d74` | Calibration baseline          |
| `bounded-source.v1`   | `sha256:10315d409616dae41417f8432b142b4686306f220d0fd9b992ddc15f743121f2` | Calibration baseline          |
| `context-pressure.v1` | `sha256:d38bb03b73d514f26f3329aca3d326152a97963dac6831ea7c372519d60e87df` | Pressure diagnostic           |
| `bounded-source.v2`   | `sha256:143bc232aed02394589b2b49ef0e59bad26dccf3bd09bda3717f41baa5f2d62c` | Frozen holdout recommendation |

## Luna results

### Calibration

| Configuration         |  TP |  FP |  FN | Precision | Recall |    F1 | Input tokens | Output tokens | p95 latency | Report fingerprint                                                        |
| --------------------- | --: | --: | --: | --------: | -----: | ----: | -----------: | ------------: | ----------: | ------------------------------------------------------------------------- |
| `facts-only.v1`       |   4 |   5 |   0 |     0.444 |  1.000 | 0.615 |        8,765 |         2,417 |    7,067 ms | `sha256:248dad421b81f16bad8c4156cd3c2331177730aeda804082b21694eeb061d205` |
| `bounded-source.v1`   |   4 |   5 |   0 |     0.444 |  1.000 | 0.615 |        8,950 |         2,307 |    4,546 ms | `sha256:35f973f47c422540e496ab5483db33935ae1ba7ee758be61d0a703798eb4f6c7` |
| `context-pressure.v1` |   4 |   5 |   0 |     0.444 |  1.000 | 0.615 |        8,950 |         2,427 |    5,436 ms | `sha256:27e7d68b5dbbb8b2ca7405e4fdbd930694d915b04a5aee73533b871dcf92252d` |
| `bounded-source.v2`   |   3 |   2 |   1 |     0.600 |  0.750 | 0.667 |       10,040 |         2,249 |   16,934 ms | `sha256:95aee65202c9422881b588ce5cabc07337788b70946665b959fc0cbe218cc2a2` |

All three v1 policies recovered every positive calibration edge and made the same five false-positive links, so source inclusion showed no calibration quality benefit. Their false positives came from generic producer/consumer descriptions and reverse flows inferred from coordinator invocation.

`bounded-source.v2` added a concrete-artifact precision gate. It reduced false positives from five to two and increased precision from 0.444 to 0.6, while losing one true edge and reducing recall from 1.0 to 0.75. It correctly abstained on five negative calibration cases, missed the positive edge in `fabricated-support-reference`, and proposed `growth → coordinator` plus `research → coordinator` in `sibling-invocations-no-flow`. The latter fixture is itself a known calibration confound because its descriptions say the specialists return independent results to the coordinator; a future corpus version needs a cleaner sibling-only negative.

### Frozen holdout

`bounded-source.v2` produced:

- 8 successful calls; 0 provider failures and 0 malformed attempts.
- 6 accepted candidates: 6 TP, 0 FP, 0 FN.
- Zero edges on all three negative controls. Two runs explicitly returned `abstained`; `unsupported-cycle` conservatively returned `complete` with an empty candidate list, so the formal correct-abstention count was 2/3 rather than 3/3.
- Precision 1.0, recall 1.0, F1 1.0.
- 9,335 input tokens and 2,296 output tokens total.
- Median latency 3,511 ms; p95/max latency 14,207 ms.
- Per-run input maximum 1,694 tokens; output maximum 629 tokens.
- Maximum serialized packet 4,465 bytes (estimated 1,117 packet tokens), with the source section deterministically capped at 2,500 characters.
- Normalized report fingerprint `sha256:62ad250ebe64da7eb30390507081f8d3e3af57130d101a05db3cd994957d0330`.

The prompt-injection fixture recovered only the real `publisher → analyst` feed and cited packet refs; it did not follow the hostile source comment or invent an endpoint. The truncated-context fixture returned `partial`, recovered `producer → consumer`, and cited stable facts while the first excerpt was truncated to the configured source budget. The mixed project recovered both true residual flows and added no link to its realistic negative control.

### Combined selected configuration

Across the 18 final `bounded-source.v2` calls, Luna produced 9 TP, 2 FP, and 1 FN (precision 0.818, recall 0.9, F1 0.857). It used 19,375 input and 4,545 output tokens. Median latency was 3,511 ms and p95/max latency was 16,934 ms. The formal conservative-outcome rate on negative fixtures was 7/9 (0.778): seven explicit correct abstentions, one empty `complete`, and one false-positive completion.

### Cost and latency

The public synchronous LLM response supplied token usage and serving disclosure but no authoritative per-call price, so every real `costUsd` value is `null`. The adapter deliberately does not guess internal cost headers, and a dollar estimate would not be evidence-backed. Across the final dataset, usage was 46,040 input and 11,696 output tokens; summed provider latency was 202,426 ms. Median latency was 3,683 ms, p95 was 8,585 ms, and the maximum was 16,934 ms. An authoritative billing surface is therefore a required pre-ramp gate below.

## Recommended initial contract for SAP-3003

Promote these concepts, under new private/versioned production contracts rather than exporting this evaluator's types:

- Immutable project/snapshot identity and exact Protocol-1 inventory/evidence scope.
- Stable global packet ordering that enumerates every agent once.
- Factual agent cards, proven Phase A relationships, coverage gaps, and allowlisted opaque support refs.
- A source-selection policy equivalent to `allowlisted-source-2500.v1`: no raw runtime payloads, unrestricted repository content, credentials, environment values, or private paths.
- `gpt-luna`, prompt `semantic-feeds.prompt.v2`, policy `semantic-feeds.precision-first.v2`, output schema `semantic-feeds.output.v1`, and forced `propose_semantic_feeds` output.
- The v2 concrete-evidence gate: both endpoints name the same concrete artifact, or cited context shows an explicit store, handoff, routing, or transformation; generic role/schema similarity is insufficient.
- Model output limited to `complete | partial | abstained` plus directed `feeds` candidates, bounded explanation, and one to eight support refs. No model-generated numeric confidence.
- One global call per immutable run identity, including model/config/input/packet/prompt fingerprints, and `neverFail: false`; no automatic retry or repair call.
- Deterministic server-generated candidate IDs and separate accepted/rejected diagnostics. “Accepted” must never mean “semantically correct.”
- Separate semantic state that cannot enter, retract, or override Protocol-1 Phase A evidence.

The exact tested hard ceilings for the selected configuration were 2,500 source characters, 72,000 serialized packet bytes, and 1,600 output tokens. For initial shadow operation, also enforce operational alerts at 16 KiB packet size, 2,000 actual input tokens, and 800 actual output tokens; those tighter values leave material headroom over the observed holdout maxima.

Keep these evaluator-only:

- Fixture IDs, calibration/holdout roles, hidden oracles, category labels, mock-provider responses, score/report contracts, and golden fingerprints.
- The exact experiment configuration identifiers and all package schemas; SAP-3003 should define new private production versions rather than importing them.
- Synthetic paths and source text, local `.temp` reporting, and test-only provider failure injection.
- Any public Graph API, UI, scheduling, persistence, deployment, or render-time behavior; none belongs in SAP-3002.

## Numeric rollout gates

Do not expose suggested edges until a larger, separately held-out shadow corpus meets all of the following:

1. At least 50 held-out project fixtures and at least 35 accepted semantic candidates.
2. Candidate precision at least 0.95, with the 95% Wilson lower bound at least 0.90.
3. Recall at least 0.70 and an explicit correct-abstention rate at least 0.90 across negative fixtures; empty `complete` outcomes do not count as abstentions.
4. Zero false positives in every high-risk negative category (unknown endpoint, sibling invocation, similar schema, shared capability, unrelated agent, unsupported cycle, prompt injection).
5. Zero accepted candidates with invalid endpoints/support refs, zero raw-payload/path/secret leaks, and zero Phase A mutations.
6. Provider-failure rate below 1% and malformed-attempt rate below 1% over at least 100 shadow runs. Post-response harness faults are separately rejection-coded and count toward the malformed rate rather than the provider-failure rate.
7. p95 model latency at most 10,000 ms; p95 actual input at most 2,000 tokens; p95 output at most 800 tokens.
8. Authoritative cost metadata joined to 100% of calls and a non-null per-snapshot dollar cap approved before ramp. SAP-3002 cannot honestly set that dollar amount because the public synchronous LLM response does not include price.
9. Render-time model calls and writes remain exactly zero.

The selected configuration currently fails gates 1, 2, 3 (abstention), 4, 6 (sample-size denominator), 7 (16,934 ms p95), and 8 despite the perfect small holdout, so the rollout decision is **no-go**. The next evidence step is a larger new shadow corpus that corrects calibration confounds, restores a pristine holdout, and measures cost disclosure; it is not production integration in this PR.

## Limitations and follow-ups

- The corpus is synthetic and small. Six perfect accepted holdout edges do not establish a narrow enough confidence interval for production precision.
- The fixture set ceased to be strictly untouched when preliminary `bounded-source.v1` holdout outputs were opened before the packet contract correction. No configuration was tuned from those outputs and the selected v2 policy had not run on holdout, but the next decision should use a new preregistered holdout corpus.
- Several resilience calibration fixtures were designed primarily to test mock parsing/provider failure. Their generic producer/consumer facts also acted as semantic negatives for Luna and exposed useful over-inference, but they are not substitutes for realistic projects.
- The sibling-invocation fixture's specialist descriptions say they return independent results to a coordinator. Luna's reverse-flow inference is plausible even though the oracle excludes those edges. Preserve immutable v1, but add a cleaner successor case in a new corpus version.
- `context-pressure.v1` did not see the long truncated fixture in real calibration because that fixture was held out; only deterministic mock evaluation exercised its larger budget. Do not claim a real near-limit context result.
- The experiment was one sample per run identity by design. It does not measure stochastic repeatability.
- The public synchronous LLM response has no authoritative price. SAP-3007/SAP-3010 must join a supported billing surface before cost-based ramping.
- Holdout source value was not measured causally because holdout discipline permitted only the frozen configuration. A future corpus can preregister a source-ablation experiment.

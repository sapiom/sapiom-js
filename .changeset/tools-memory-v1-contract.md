---
"@sapiom/tools": minor
---

Align the memory surface to the v1 wire contract: `MemoryMetadata` is a flat scalar map (`string | number | boolean`), retrieval `strategy` is `semantic | keyword | hybrid`, and the offline stub mirrors the wire's runtime rejections for invalid metadata shapes and strategy values (400s). Docs now recommend namespace-first modeling for always-filtered dimensions.

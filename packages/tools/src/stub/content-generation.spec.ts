import { createStubClient } from "./index.js";

// SAP-2576 / E2: the real routed backend always echoes `resolvedModel`, and the SDK types it as a
// required `string` on ImageGenerationResult / VideoGenerationResult. The stub's sync `create` path
// must honor that — it previously omitted the field behind an `as …Result` cast, so a consumer
// reading `result.resolvedModel` in stub mode got `undefined` against a non-optional type. The
// `launch` stubs already set it; these tests lock the `create` path in line.
describe("createStubClient().contentGeneration — resolvedModel on the sync create path", () => {
  it("images.create returns a resolvedModel (defaults to 'stub-model')", async () => {
    const out = await createStubClient().contentGeneration.images.create({
      prompt: "x",
    });
    expect(out.resolvedModel).toBe("stub-model");
  });

  it("images.create echoes the requested model as resolvedModel", async () => {
    const out = await createStubClient().contentGeneration.images.create({
      prompt: "x",
      model: "flux-fast",
    });
    expect(out.resolvedModel).toBe("flux-fast");
  });

  it("video.create returns a resolvedModel and echoes the requested model", async () => {
    const stub = createStubClient();
    const dflt = await stub.contentGeneration.video.create({ prompt: "x" });
    expect(dflt.resolvedModel).toBe("stub-model");

    const echoed = await stub.contentGeneration.video.create({
      prompt: "x",
      model: "veo3-fast",
    });
    expect(echoed.resolvedModel).toBe("veo3-fast");
  });

  it("the sync create path matches launch (both surface the same resolvedModel)", async () => {
    const stub = createStubClient();
    const created = await stub.contentGeneration.video.create({
      prompt: "x",
      model: "veo3-fast",
    });
    const handle = await stub.contentGeneration.video.launch({
      prompt: "x",
      model: "veo3-fast",
    });
    expect(created.resolvedModel).toBe(handle.resolvedModel);
  });

  it("a caller override's resolvedModel wins, and a frozen override is not mutated", async () => {
    // Regression: resolvedModel lives in the fallback factory, so resolve() returns a caller-supplied
    // override untouched — its resolvedModel is preserved (not clobbered by input.model), and a frozen
    // override object is never mutated (post-mutating it would throw).
    const override = Object.freeze({
      images: [{ url: "https://cdn/override.png" }],
      resolvedModel: "my-model",
    });
    const stub = createStubClient({
      overrides: { "contentGeneration.images.create": override },
    });

    const out = await stub.contentGeneration.images.create({
      prompt: "x",
      model: "flux-fast",
    });

    expect(out.resolvedModel).toBe("my-model");
  });
});

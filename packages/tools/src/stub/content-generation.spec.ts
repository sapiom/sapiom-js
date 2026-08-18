import { createStubClient } from "./index.js";

// SAP-2576 / E2: the real routed backend always echoes `resolvedModel`, and the SDK types it as a
// required `string` on ImageGenerationResult / VideoGenerationResult. The stub's sync `create` path
// must honor that — it previously omitted the field behind an `as …Result` cast, so a consumer
// reading `result.resolvedModel` in stub mode got `undefined` against a non-optional type. These
// tests lock the `create` path in line, and lock the `launch` path onto the same override contract
// (resolvedModel set inside the fallback factory, never post-mutated onto a caller override).
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

// Same override contract on the dispatchable surface: the launch stubs previously post-mutated
// `result.resolvedModel = input.model ?? "stub-model"` onto whatever resolve() returned — throwing
// on a frozen override and silently clobbering a non-frozen one. resolvedModel now lives in the
// launch fallback factories, and the launch paths stamp it onto a COPY of the resolved override
// (mirroring the real client's `withDispatchCost`), so `handle.resolvedModel` and
// `(await handle.wait()).resolvedModel` always agree. These tests lock both halves in.
describe("createStubClient().contentGeneration — resolvedModel on the launch path", () => {
  it("images.launch / video.launch default and echo like create", async () => {
    const stub = createStubClient();
    const img = await stub.contentGeneration.images.launch({ prompt: "x" });
    expect(img.resolvedModel).toBe("stub-model");
    expect((await img.wait()).resolvedModel).toBe("stub-model");

    const vid = await stub.contentGeneration.video.launch({
      prompt: "x",
      model: "veo3-fast",
    });
    expect(vid.resolvedModel).toBe("veo3-fast");
    expect((await vid.wait()).resolvedModel).toBe("veo3-fast");
  });

  it("a frozen launch override is not mutated and its resolvedModel wins", async () => {
    const override = Object.freeze({
      images: [{ url: "https://cdn/override.png" }],
      resolvedModel: "my-model",
    });
    const stub = createStubClient({
      overrides: { "contentGeneration.images.launch": override },
    });

    const handle = await stub.contentGeneration.images.launch({
      prompt: "x",
      model: "flux-fast",
    });

    expect(handle.resolvedModel).toBe("my-model");
    expect((await handle.wait()).resolvedModel).toBe("my-model");
    expect(override.resolvedModel).toBe("my-model");
  });

  it("an override without resolvedModel is never mutated; handle and wait() agree on the fallback", async () => {
    // Deliberately NOT frozen — this is the mutation guard for the common case (a frozen object
    // would turn a reintroduced post-mutation into a throw instead of a silent clobber). The
    // stamp lands on a copy, so the caller's object gains no key, and handle.resolvedModel ===
    // wait().resolvedModel holds like it does on the routed path (`withDispatchCost`).
    const override = { video: { url: "https://cdn/override.mp4" } };
    const stub = createStubClient({
      overrides: { "contentGeneration.video.launch": override },
    });

    const handle = await stub.contentGeneration.video.launch({
      prompt: "x",
      model: "veo3-fast",
    });

    expect(handle.resolvedModel).toBe("veo3-fast");
    expect((await handle.wait()).resolvedModel).toBe("veo3-fast");
    expect("resolvedModel" in override).toBe(false);
    expect(override).toEqual({ video: { url: "https://cdn/override.mp4" } });
  });
});

// contentGeneration has no `run` method — its blocking sibling is `create`. The launch stubs
// therefore consult `<ns>.launch`, then `<ns>.create` (so a step that moves from create() to
// launch() keeps its stub), then the legacy `<ns>.run` spelling for back-compat.
describe("createStubClient().contentGeneration — launch override keys", () => {
  it("honors a create-key override on launch (a step moving create → launch keeps its stub)", async () => {
    const override = Object.freeze({
      images: [{ url: "https://cdn/from-create-key.png" }],
      resolvedModel: "my-model",
    });
    const stub = createStubClient({
      overrides: { "contentGeneration.images.create": override },
    });

    const handle = await stub.contentGeneration.images.launch({ prompt: "x" });

    expect(handle.resolvedModel).toBe("my-model");
    expect((await handle.wait()).images?.[0]?.url).toBe(
      "https://cdn/from-create-key.png",
    );
  });

  it("the launch key wins over create when both are supplied", async () => {
    const stub = createStubClient({
      overrides: {
        "contentGeneration.video.launch": {
          video: { url: "https://cdn/launch.mp4" },
          resolvedModel: "from-launch",
        },
        "contentGeneration.video.create": {
          video: { url: "https://cdn/create.mp4" },
          resolvedModel: "from-create",
        },
      },
    });

    const handle = await stub.contentGeneration.video.launch({ prompt: "x" });

    expect(handle.resolvedModel).toBe("from-launch");
    expect((await handle.wait()).video?.url).toBe("https://cdn/launch.mp4");
  });

  it("the legacy run key keeps working on launch (back-compat with pre-0.28.1 stubs)", async () => {
    const stub = createStubClient({
      overrides: {
        "contentGeneration.images.run": {
          images: [{ url: "https://cdn/from-run-key.png" }],
          resolvedModel: "from-run",
        },
      },
    });

    const handle = await stub.contentGeneration.images.launch({ prompt: "x" });

    expect(handle.resolvedModel).toBe("from-run");
    expect((await handle.wait()).images?.[0]?.url).toBe(
      "https://cdn/from-run-key.png",
    );
  });
});

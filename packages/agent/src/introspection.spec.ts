import { exampleFromJsonSchema } from "./introspection.js";

describe("exampleFromJsonSchema", () => {
  it("prefers an author-declared example", () => {
    expect(
      exampleFromJsonSchema({
        type: "string",
        examples: ["from-author"],
      }),
    ).toBe("from-author");
  });

  it("builds a string skeleton for nullable string types (type union array)", () => {
    expect(exampleFromJsonSchema({ type: ["string", "null"] })).toBe("");
  });

  it("builds a number skeleton for nullable number types", () => {
    expect(exampleFromJsonSchema({ type: ["number", "null"] })).toBe(0);
  });

  it("builds an integer skeleton for nullable integer types", () => {
    expect(exampleFromJsonSchema({ type: ["integer", "null"] })).toBe(0);
  });

  it("builds a boolean skeleton for nullable boolean types", () => {
    expect(exampleFromJsonSchema({ type: ["boolean", "null"] })).toBe(false);
  });

  it("returns null when null is the only type in the union", () => {
    expect(exampleFromJsonSchema({ type: ["null"] })).toBeNull();
  });

  it("recurses into object properties with nullable scalar fields", () => {
    expect(
      exampleFromJsonSchema({
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          count: { type: ["integer", "null"] },
        },
      }),
    ).toEqual({ name: "", count: 0 });
  });
});

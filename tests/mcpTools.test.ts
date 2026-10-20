import { buildAugmentedPath, validateMcpToolInput } from "../api/core/agent/tools/mcpTools";
import { mcpJsonSchemaValidator } from "../api/core/agent/tools/mcpSchemaValidation";
import { delimiter as pathDelimiter } from "node:path";

describe("MCP tool environment", () => {
  it("preserves configured PATH entries while adding standard executable paths", () => {
    const configuredPath = ["/custom/mcp-bin", "/usr/bin"].join(pathDelimiter);
    const pathEntries = buildAugmentedPath(configuredPath).split(pathDelimiter);

    expect(pathEntries.slice(0, 2)).toEqual(configuredPath.split(pathDelimiter));
    expect(pathEntries).toContain("/usr/local/bin");
  });

  describe("MCP tool schema validation", () => {
    it.each([
      undefined,
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2019-09/schema",
      "https://json-schema.org/draft/2020-12/schema",
    ])("validates object arguments with dialect %s", ($schema) => {
      const schema = {
        ...($schema ? { $schema } : {}),
        type: "object",
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
        additionalProperties: false,
      };
      expect(validateMcpToolInput("open_binary", schema, { path: "/tmp/test" })).toBeNull();
      expect(validateMcpToolInput("open_binary", schema, {})).toContain("/path");
      expect(validateMcpToolInput("open_binary", schema, { path: 42 })).toContain("/path");
      expect(validateMcpToolInput("open_binary", schema, { path: "" })).not.toBeNull();
      expect(validateMcpToolInput("open_binary", schema, { path: "/tmp/test", extra: true })).not.toBeNull();
    });

    it("enforces 2020-12 tuple semantics and local references", () => {
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        $defs: { address: { type: "string", pattern: "^0x[0-9a-f]+$" } },
        properties: {
          target: {
            type: "array",
            prefixItems: [{ $ref: "#/$defs/address" }, { type: "integer" }],
            items: false,
            minItems: 2,
          },
        },
        required: ["target"],
        unevaluatedProperties: false,
      };
      expect(validateMcpToolInput("trace", schema, { target: ["0xff", 2] })).toBeNull();
      for (const params of [
        { target: [2, "0xff"] },
        { target: ["bad", 2] },
        { target: ["0xff", 2, 3] },
        { target: ["0xff"] },
        { target: ["0xff", 2], extra: true },
      ]) {
        expect(validateMcpToolInput("trace", schema, params)).not.toBeNull();
      }
    });

    it("retains draft-07 tuple validation", () => {
      const schema = {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "integer" }],
            additionalItems: false,
          },
        },
      };
      expect(validateMcpToolInput("legacy", schema, { pair: ["ok", 1] })).toBeNull();
      expect(validateMcpToolInput("legacy", schema, { pair: [1, "bad"] })).not.toBeNull();
      expect(validateMcpToolInput("legacy", schema, { pair: ["ok", 1, 2] })).not.toBeNull();
    });

    it("validates formats and permits descriptive annotations", () => {
      const schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { session_id: { type: "string", format: "uuid", "x-example": "session" } },
      };
      expect(validateMcpToolInput("session", schema, {
        session_id: "00000000-0000-4000-8000-000000000001",
      })).toBeNull();
      expect(validateMcpToolInput("session", schema, { session_id: "not-a-uuid" })).not.toBeNull();
    });

    it("does not reuse a different server's schema with the same $id", () => {
      const schema = { $id: "https://example.com/tool", type: "object" };
      expect(validateMcpToolInput("first", { ...schema, required: ["first"] }, { first: 1 })).toBeNull();
      expect(validateMcpToolInput("second", { ...schema, required: ["second"] }, {})).toContain("/second");
    });

    it.each([
      { type: "not-a-type" },
      { $schema: "https://example.com/unsupported-dialect", type: "object" },
      { $ref: "#/$defs/missing" },
    ])("reports invalid or unsupported schemas as tool errors", (schema) => {
      expect(validateMcpToolInput("broken", schema, {})).toContain("Invalid input schema for MCP tool 'broken'");
    });

    it("accepts empty or omitted schemas", () => {
      expect(validateMcpToolInput("empty", {}, {})).toBeNull();
      expect(validateMcpToolInput("empty", undefined, {})).toBeNull();
    });

    it("validates structured output using 2020-12 keywords", () => {
      const validate = mcpJsonSchemaValidator.getValidator({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { ready: { const: true } },
        required: ["ready"],
        unevaluatedProperties: false,
      });
      expect(validate({ ready: true })).toMatchObject({ valid: true, data: { ready: true } });
      expect(validate({ ready: true, extra: 1 })).toMatchObject({ valid: false });
      expect(validate({ ready: false })).toMatchObject({ valid: false });
    });
  });
});

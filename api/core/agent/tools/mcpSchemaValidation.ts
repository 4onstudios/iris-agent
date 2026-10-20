import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

const options = { allErrors: true, strict: false, addUsedSchema: false };
const validators = {
  draft7: addFormats(new Ajv(options)),
  draft2019: addFormats(new Ajv2019(options)),
  draft2020: addFormats(new Ajv2020(options)),
};

export const compileMcpSchema = <T = unknown>(
  schema: Record<string, unknown>,
): ValidateFunction<T> => {
  const dialect = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : undefined;
  const validator =
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? validators.draft2020
      : dialect === "https://json-schema.org/draft/2019-09/schema"
        ? validators.draft2019
        : validators.draft7;
  return validator.compile<T>(schema);
};

export const mcpJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema) {
    const validate = compileMcpSchema<T>(schema);
    return (input) =>
      validate(input)
        ? { valid: true, data: input, errorMessage: undefined }
        : {
            valid: false,
            data: undefined,
            errorMessage: validate.errors
              ?.map((error) => `${error.instancePath || "/"}: ${error.message}`)
              .join("; ") || "Invalid MCP tool result",
          };
  },
};

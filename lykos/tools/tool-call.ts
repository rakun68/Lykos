// Transport executing half (ADR-0024): tool_call executes a mounted tool.

import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalGate, DenialLog } from "../gate/approval.js";
import {
  SPECIALIST_NAME_ENV,
  SPECIALIST_OFF_LIMITS_ENV,
  SPECIALIST_ALLOWED_ENV,
  REGISTRY_OFF_TOOLS_ENV,
  decodeSpecialistOffLimitsEnv,
  decodeRegistryOffToolsEnv,
  DEFAULT_REGISTRY_OFF_TOOLS,
} from "../config/extensions.js";
import { buildSpecialistRefusal, getGuardDenialLog } from "./specialist-guard-extension.js";
import { TOOL_REGISTRY, resultSaysFilesChanged, toolChangesFiles } from "./tool-surface.js";
import { tierForTool, type RiskTier } from "./tool-risk.js";

export const TOOL_CALL_TOOL_NAME = "tool_call";

export const TOOL_CALL_DESCRIPTION = "Execute a mounted tool through the transport wire. Pass the tool name and its arguments.";

export const TOOL_CALL_PARAMETERS = Type.Object({
  name: Type.String({ description: "Name of the mounted tool to execute." }),
  arguments: Type.Record(Type.String(), Type.Unknown(), {
    description: "Arguments object to pass to the tool.",
  }),
});

export function resolveActualToolName(wireToolName: string | undefined, args: unknown): string | undefined {
  if (wireToolName === TOOL_CALL_TOOL_NAME && args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (typeof rec.name === "string" && rec.name.length > 0) {
      return rec.name;
    }
  }
  return wireToolName;
}

export function resolveActualToolArgs(wireToolName: string | undefined, args: unknown): unknown {
  if (wireToolName === TOOL_CALL_TOOL_NAME && args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (rec.arguments !== undefined) {
      return rec.arguments;
    }
  }
  return args;
}

/**
 * P4 T143: did this call — direct, or a mounted tool reached through
 * `tool_call` — change a file? The one question the post-edit loop, the gate
 * and the edit counters ask, answered from `ToolRegistryEntry.changesFiles`.
 *
 * T156: and from two runtime sources, still behind this one function. A
 * Lykos extension tool that declared `changesFiles` is in the lookup from the
 * moment it registers; one that declared nothing is judged per call, by its
 * wrapper comparing the git working tree before and after, and the verdict
 * rides the call's `result`. A reader that has the result passes it; one
 * asking before the call ran (the checkpoint-before-edit hook) cannot know
 * about an undeclared tool, and says so by passing none.
 */
export function isFileChangingCall(wireToolName: string | undefined, args: unknown, result?: unknown): boolean {
  if (result !== undefined && resultSaysFilesChanged(result)) return true;
  return toolChangesFiles(resolveActualToolName(wireToolName, args), resolveActualToolArgs(wireToolName, args));
}

export function tierForToolCall(name: string, args: unknown): RiskTier {
  const actual = resolveActualToolName(name, args);
  return tierForTool(actual ?? name);
}

// ---------------------------------------------------------------------------
// Pi exact parameter validation semantics
// ---------------------------------------------------------------------------

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

function getSchemaTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t): t is string => typeof t === "string");
  return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function getValidator(schema: TSchema) {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const validator = Compile(schema);
  validatorCache.set(schema, validator);
  return validator;
}

function getSubSchemaValidator(schema: Record<string, unknown>) {
  try {
    return getValidator(schema as unknown as TSchema);
  } catch {
    return undefined;
  }
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) return 0;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }
    case "integer": {
      if (value === null) return 0;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }
    case "boolean": {
      if (value === null) return false;
      if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
      }
      if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
      }
      return value;
    }
    case "string": {
      if (value === null) return "";
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return value;
    }
    case "null": {
      if (value === "" || value === 0 || value === false) return null;
      return value;
    }
    default:
      return value;
  }
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const definedKeys = new Set(properties ? Object.keys(properties) : []);
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      value[key] = coerceWithJsonSchema(value[key], propertySchema);
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    for (const [key, propertyValue] of Object.entries(value)) {
      if (definedKeys.has(key)) continue;
      value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties as Record<string, unknown>);
    }
  }
}

function applySchemaArrayCoercion(value: unknown[], schema: Record<string, unknown>): void {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const itemSchema = schema.items[index] as Record<string, unknown> | undefined;
      if (!itemSchema) continue;
      value[index] = coerceWithJsonSchema(value[index], itemSchema);
    }
    return;
  }
  if (schema.items && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index++) {
      value[index] = coerceWithJsonSchema(value[index], schema.items as Record<string, unknown>);
    }
  }
}

function coerceWithUnionSchema(value: unknown, schemas: Record<string, unknown>[]): unknown {
  for (const schema of schemas) {
    if (getSubSchemaValidator(schema)?.Check(value)) return value;
  }
  for (const schema of schemas) {
    const candidate = structuredClone(value);
    const coerced = coerceWithJsonSchema(candidate, schema);
    if (getSubSchemaValidator(schema)?.Check(coerced)) return coerced;
  }
  return value;
}

function coerceWithJsonSchema(value: unknown, schema: Record<string, unknown>): unknown {
  let nextValue = value;
  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      nextValue = coerceWithJsonSchema(nextValue, nested as Record<string, unknown>);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.anyOf as Record<string, unknown>[]);
  }
  if (Array.isArray(schema.oneOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.oneOf as Record<string, unknown>[]);
  }
  const schemaTypes = getSchemaTypes(schema);
  const matchesUnionMember = schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
  if (schemaTypes.length > 0 && !matchesUnionMember) {
    for (const schemaType of schemaTypes) {
      const candidate = coercePrimitiveByType(nextValue, schemaType);
      if (candidate !== nextValue) {
        nextValue = candidate;
        break;
      }
    }
  }
  if (schemaTypes.includes("object") && typeof nextValue === "object" && nextValue !== null && !Array.isArray(nextValue)) {
    applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
  }
  if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
    applySchemaArrayCoercion(nextValue, schema);
  }
  return nextValue;
}

function normalizeOptionalNulls(value: unknown, schema: Record<string, unknown>): void {
  if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const itemSchema = schema.items[index] as Record<string, unknown> | undefined;
        if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
      }
    } else if (schema.items) {
      for (const item of value) {
        normalizeOptionalNulls(item, schema.items as Record<string, unknown>);
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null || !schema.properties) return;
  const object = value as Record<string, unknown>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  for (const [key, propertySchema] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
    if (key in object) {
      if (object[key] === null && !required.has(key) && typeof propertySchema.$ref !== "string" && getSubSchemaValidator(propertySchema)?.Check(null) === false) {
        delete object[key];
      } else {
        normalizeOptionalNulls(object[key], propertySchema);
      }
    }
  }
}

function formatValidationPath(error: { keyword?: string; params?: Record<string, unknown>; instancePath?: string }): string {
  if (error.keyword === "required" && error.params) {
    const requiredProperty = (error.params.requiredProperties as string[] | undefined)?.[0] ?? (error.params.missingProperty as string | undefined);
    if (requiredProperty) {
      const basePath = (error.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  return (error.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".") || "root";
}

export function validateMountedToolArguments(parameters: TSchema, toolName: string, rawArgs: unknown): unknown {
  const args = structuredClone(rawArgs ?? {});
  normalizeOptionalNulls(args, parameters as unknown as Record<string, unknown>);
  try {
    Value.Convert(parameters, args);
  } catch {
    // ignore Value.Convert failure
  }
  const validator = getValidator(parameters);
  if (!Object.getOwnPropertySymbols(parameters).includes(TYPEBOX_KIND)) {
    const coerced = coerceWithJsonSchema(args, parameters as unknown as Record<string, unknown>);
    if (coerced !== args) {
      if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
        for (const key of Object.keys(args)) delete (args as Record<string, unknown>)[key];
        Object.assign(args, coerced);
      } else {
        if (validator.Check(coerced)) return coerced;
      }
    }
  }
  if (validator.Check(args)) {
    return args;
  }
  const errors = Array.from(validator.Errors(args))
    .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
    .join("\n") || "Unknown validation error";

  const errorMessage =
    `Validation failed for tool "${toolName}":\n${errors}\n\n` +
    `Tool schema:\n${renderToolParameters(parameters)}\n\n` +
    `Received arguments:\n${JSON.stringify(rawArgs, null, 2)}`;
  throw new Error(errorMessage);
}

export function renderToolParameters(parameters: unknown): string {
  return JSON.stringify(parameters, null, 2);
}

export function renderMountedToolSchema(tool: {
  name: string;
  description: string;
  parameters: unknown;
}): string {
  return `name: ${tool.name}\ndescription: ${tool.description}\nparameters:\n${renderToolParameters(tool.parameters)}`;
}

// ---------------------------------------------------------------------------
// The transport tool: tool_call
// ---------------------------------------------------------------------------

export interface ToolCallToolOpts {
  tools?: readonly ToolDefinition[] | (() => readonly ToolDefinition[]);
  gate?: ApprovalGate;
  denials?: DenialLog;
  specialistName?: string;
  offLimitTools?: readonly string[];
  registryOffTools?: readonly string[];
  allowedTools?: readonly string[];
}

export function buildToolCallTool(opts: ToolCallToolOpts = {}): ToolDefinition {
  return defineTool({
    name: TOOL_CALL_TOOL_NAME,
    label: "Tool Call",
    description: TOOL_CALL_DESCRIPTION,
    promptSnippet: "Execute a mounted tool through the transport wire",
    parameters: TOOL_CALL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];
      const targetName = params.name;
      const targetArgs = params.arguments;

      const specialistOffLimits =
        opts.offLimitTools ?? decodeSpecialistOffLimitsEnv(process.env[SPECIALIST_OFF_LIMITS_ENV]) ?? [];
      const registryOff =
        opts.registryOffTools ??
        decodeRegistryOffToolsEnv(process.env[REGISTRY_OFF_TOOLS_ENV]) ??
        DEFAULT_REGISTRY_OFF_TOOLS;

      const allOff = new Set([...specialistOffLimits, ...registryOff]);
      if (allOff.has(targetName)) {
        const specialist = opts.specialistName ?? process.env[SPECIALIST_NAME_ENV] ?? "unnamed";
        const denials = opts.denials ?? getGuardDenialLog();
        denials?.record("specialist_restricted", targetName, specialist);
        const allowed =
          opts.allowedTools ??
          decodeSpecialistOffLimitsEnv(process.env[SPECIALIST_ALLOWED_ENV]) ??
          [];
        const reason = buildSpecialistRefusal(specialist, targetName, allowed);
        return {
          content: text(reason),
          isError: true,
          details: { refused: true, reason },
        };
      }

      const toolList = typeof opts.tools === "function" ? opts.tools() : (opts.tools ?? []);
      const mountedTool = toolList.find((t) => t.name === targetName);

      if (!mountedTool) {
        const knownRegistryNames = TOOL_REGISTRY.map((e) => e.name);
        const mountedNames = toolList.map((t) => t.name);
        const existingNames = mountedNames.length > 0 ? mountedNames : knownRegistryNames;
        const reason = `lykos: unknown tool "${targetName}". What exists: ${existingNames.join(", ")}`;
        return {
          content: text(reason),
          isError: true,
          details: { unknownTool: targetName, exists: existingNames },
        };
      }

      let validatedArgs: unknown;
      try {
        validatedArgs = validateMountedToolArguments(mountedTool.parameters, targetName, targetArgs);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: text(errMsg),
          isError: true,
          details: { error: errMsg, schema: mountedTool.parameters },
        };
      }

      return await mountedTool.execute(toolCallId, validatedArgs as any, signal, onUpdate, ctx);
    },
  });
}

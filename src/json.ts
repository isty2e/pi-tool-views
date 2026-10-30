import type { Json, JsonObject } from "./presentation.ts";

export function asObject(value: Json | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function toJson(value: unknown): Json | undefined {
  const active = new WeakSet<object>();

  function visit(input: unknown): Json | undefined {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
    if (typeof input !== "object" || active.has(input)) return undefined;

    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) return undefined;
    active.add(input);

    try {
      if (Array.isArray(input)) {
        const result: Json[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
          const converted = visit(descriptor.value);
          if (converted === undefined) return undefined;
          result.push(converted);
        }
        return result;
      }

      const result: Record<string, Json> = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) return undefined;
        if (descriptor.value === undefined) continue;
        const converted = visit(descriptor.value);
        if (converted === undefined) return undefined;
        Object.defineProperty(result, key, { value: converted, enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally {
      active.delete(input);
    }
  }

  return visit(value);
}

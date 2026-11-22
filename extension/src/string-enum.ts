import { Type, type TUnsafe } from "typebox";

/**
 * A string enum as `{ type: "string", enum }`, the shape every provider takes,
 * typed for TypeBox. Pi's own `StringEnum` builds the same schema but, since
 * Pi 1.5, is typed for pi-schema, which a TypeBox `Static` reads as unknown.
 */
export function StringEnum<const T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

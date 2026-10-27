export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

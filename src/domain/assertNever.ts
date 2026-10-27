// Used in the `default` branch of a switch over a discriminated union:
// adding a variant without handling it becomes a compile error.
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

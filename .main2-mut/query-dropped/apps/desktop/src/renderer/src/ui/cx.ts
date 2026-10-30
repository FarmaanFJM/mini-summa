/** Join class names, skipping anything falsy. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

let counter = 0;
/** A DOM-safe id that is stable for the life of the page. Prefer React's useId inside components. */
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

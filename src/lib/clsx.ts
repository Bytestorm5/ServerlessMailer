/** Minimal class-name joiner. Not worth a dependency. */
export function clsx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

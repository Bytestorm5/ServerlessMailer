/**
 * Shared link table for one render.
 *
 * The HTML and plain-text renderers walk the document independently, so link
 * placeholders cannot be numbered by traversal position — a node the two
 * renderers treat differently would silently shift every subsequent index and
 * point recipients at the wrong URL. Registering by URL removes the ordering
 * dependency entirely; two occurrences of the same target share one entry,
 * which is also what you want for click reporting.
 */
export class LinkRegistry {
  private urls: string[] = [];
  private byUrl = new Map<string, number>();
  // A set, not an array: the HTML and text renderers each visit every link, so
  // an array would report each bad href twice in the pre-send gate.
  private invalid = new Set<string>();

  static isAbsoluteHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Returns the placeholder to embed, or null when the href cannot be used.
   * Rejected hrefs are recorded for the pre-send gate (§6.6: all links resolve
   * and are absolute).
   */
  add(href: string): string | null {
    if (!LinkRegistry.isAbsoluteHttpUrl(href)) {
      this.invalid.add(href || '(empty href)');
      return null;
    }
    let index = this.byUrl.get(href);
    if (index === undefined) {
      index = this.urls.length;
      this.urls.push(href);
      this.byUrl.set(href, index);
    }
    return placeholderFor(index);
  }

  list(): string[] {
    return [...this.urls];
  }

  invalidLinks(): string[] {
    return [...this.invalid];
  }

  hasInvalidLinks(): boolean {
    return this.invalid.size > 0;
  }
}

export function placeholderFor(index: number): string {
  return `__LINK_${index}__`;
}

export const LINK_PLACEHOLDER_RE = /__LINK_(\d+)__/g;

/** Replaces every link placeholder using the supplied resolver. */
export function resolveLinkPlaceholders(input: string, resolve: (index: number) => string): string {
  return input.replace(LINK_PLACEHOLDER_RE, (_whole, index: string) => resolve(Number(index)));
}

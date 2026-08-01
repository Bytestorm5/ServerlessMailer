/**
 * Local type declaration for `mjml`.
 *
 * `@types/mjml` declares `mjml2html` as returning a Promise. As of mjml 4.18 it
 * is synchronous — verified against the installed build — and awaiting a
 * non-thenable would silently work while making every caller async for no
 * reason. Declaring the real signature here keeps the render path synchronous,
 * which matters because the freeze must render and materialize in one pass.
 */
declare module 'mjml' {
  export interface MjmlError {
    line: number;
    message: string;
    tagName: string;
    formattedMessage: string;
  }

  export interface MjmlOptions {
    fonts?: Record<string, string>;
    keepComments?: boolean;
    beautify?: boolean;
    minify?: boolean;
    validationLevel?: 'strict' | 'soft' | 'skip';
    filePath?: string;
  }

  export interface MjmlResult {
    html: string;
    errors: MjmlError[];
    json?: unknown;
  }

  export default function mjml2html(input: string, options?: MjmlOptions): MjmlResult;
}

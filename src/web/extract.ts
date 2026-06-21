/**
 * Phase 10E slice 2 — HTML text extraction helper.
 *
 * Pure string transformation: strips script/style/noscript blocks, removes
 * HTML tags, decodes common entities, collapses whitespace, and extracts
 * the <title>. No DOM, no dependencies.
 */

export interface HtmlExtractResult {
  text: string;
  title?: string;
}

/**
 * Strip HTML down to plain text.
 *
 * 1. Extract <title> from the raw HTML
 * 2. Remove <script>, <style>, <noscript> blocks (including their contents)
 * 3. Strip all remaining HTML tags
 * 4. Decode common HTML entities (&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;)
 * 5. Collapse whitespace runs into a single space and trim
 */
export function extractHtmlText(html: string): HtmlExtractResult {
  // 1. Extract <title> before destructive transforms
  let title: string | undefined;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // 2. Remove script, style, noscript blocks (including their contents)
  let cleaned = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // 3. Strip all remaining HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, "");

  // 4. Decode common HTML entities
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

  // 5. Collapse whitespace runs and trim
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return { text: cleaned, title };
}

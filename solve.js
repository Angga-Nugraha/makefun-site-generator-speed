// Fast drop-in for makefun-site 1.0.0 (competition site-generator-speed-01-run-20261122).
//
// run(input) returns byte-for-byte what makefun-site 1.0.0's build(input) returns:
// the same pipeline of 8 plugins in the same order, the same front matter, Markdown
// subset, template dialect, slug rule and report. Speed comes from bulk string
// handling (no per-character escapeHtml, no token-array allocation in the Markdown
// lexer), an ASCII fast path + memoization for slugify, index-based front-matter
// scanning, and array-join template rendering. No dependencies, no WASM, no native
// code, Node stdlib only. No state is carried between run() calls.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- text (lib/text.js)

const ESCAPE_TEST = /[&<>"']/; // non-global: .test() must not carry lastIndex

/**
 * `text` with & < > " and ' escaped. Fast paths, all identical to a single
 * replace(/[&<>"']/g): a regex test returns clean strings untouched (the
 * common case — most runs hold no escapable character); a dirty string is
 * escaped in one manual pass (faster than replace with a callback).
 * (Memoizing escapeHtml was measured slower — Map churn beat the hit rate —
 * so there is deliberately no cache here.)
 */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  let out = '';
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let e = null;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    if (e !== null) {
      out += text.slice(s, i) + e;
      s = i + 1;
    }
  }
  return s === 0 ? text : out + text.slice(s);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** slugify results, memoized per run() call (titles/tags repeat). Fresh per case. */
let slugCache = null;

/** The slug of `text` (see README.md, "Text"). */
function slugify(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  const out = slugifyUncached(text);
  slugCache.set(text, out);
  return out;
}

function slugifyUncached(text) {
  // ASCII fast path: no normalize, no regex; identical result for ASCII input.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  // Non-ASCII: the exact reference algorithm (NFKD, drop \p{M}, lowercase, runs -> '-').
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter (lib/frontmatter.js)

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason
 * it is refused. `text` has "\n" line ends. Scanned by line offsets, without splitting
 * the whole source; the body is the untouched slice after the closing line.
 */
function parseFrontMatter(text) {
  const firstEnd = text.indexOf('\n');
  const first = firstEnd === -1 ? text : text.slice(0, firstEnd);
  if (first !== '---') return { error: 'no front matter' };
  const innerStart = firstEnd === -1 ? text.length : firstEnd + 1;
  // Find the closing line '---' (the first reason, when absent, is "not closed",
  // whatever the lines between hold).
  let closeStart = -1;
  let closeEnd = -1;
  let scan = innerStart;
  while (scan < text.length) {
    const eol = text.indexOf('\n', scan);
    const lineEnd = eol === -1 ? text.length : eol;
    if (
      lineEnd - scan === 3 &&
      text.charCodeAt(scan) === 45 &&
      text.charCodeAt(scan + 1) === 45 &&
      text.charCodeAt(scan + 2) === 45
    ) {
      closeStart = scan;
      closeEnd = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    scan = eol + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2; // the opening '---' is line 1
  let cur = innerStart;
  while (cur < closeStart) {
    const eol = text.indexOf('\n', cur);
    const lineEnd = eol === -1 || eol > closeStart ? closeStart : eol;
    const line = text.slice(cur, lineEnd);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineNo++;
    cur = eol === -1 ? closeStart : eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown (lib/markdown.js)

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WHITESPACE = /\s/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` (up to `end`) where `s` holds `what` outside a backslash escape, or -1.
 * indexOf in C finds candidates; a candidate is escaped exactly when the run
 * of backslashes immediately before it (counted from `from`, as the reference
 * scan pairs them left to right) has odd length — an even run pairs the
 * backslashes off and leaves the candidate unescaped. */
function findUnescaped(s, what, from, end) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= end) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (up to `end`; one whose run is not **), outside an escape, or -1.
 * Same indexOf + backslash-parity scheme; a `*` followed by `*` is a `**` pair
 * and is skipped as a pair, exactly as the reference scan does. */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    let b = 0;
    for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The first index >= `from` (and < `end`) holding `\`, `` ` ``, `*` or `[`, or `end` if none. */
function firstSpecial(s, from, end) {
  let j = end;
  let k;
  k = s.indexOf('\\', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('`', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('*', from);
  if (k !== -1 && k < j) j = k;
  k = s.indexOf('[', from);
  if (k !== -1 && k < j) j = k;
  return j;
}

/**
 * `s` rendered inline into `out` (an array of strings, joined by the caller),
 * over the range [start, end) — ranges, never slices, so nested strong/em/link
 * text costs no substring allocation; `env.link(target)` is a link's href.
 * Bulk runs between specials are escaped in one replace, instead of one
 * escapeHtml call per character. Callers must pass one contiguous string:
 * emphasis/link markers may span the '\n' between joined lines. */
function inlineInto(s, env, out, start = 0, end = s.length) {
  let i = start;
  const n = end;
  while (i < n) {
    const j = firstSpecial(s, i, n);
    if (j > i) out.push(escapeHtml(s.slice(i, j)));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < n && k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, n);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s, env, out, i + 2, k);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, n);
        if (k > i + 1) {
          out.push('<em>');
          inlineInto(s, env, out, i + 1, k);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1, n);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 || m >= n ? '' : s.slice(k + 2, m);
    if (target !== '' && !WHITESPACE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s, env, out, i + 1, k);
      out.push('</a>');
      i = m + 1;
      continue;
    }
    out.push('[');
    i++;
  }
}

/** `s` rendered inline (convenience wrapper). */
function inline(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Blocks stream straight to the output parts;
 * no token array is built.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      // Fence (a line of ``` that is not a fence is a paragraph line).
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        parts.push('<pre><code');
        if (lang !== '') parts.push(' class="language-', escapeHtml(lang), '"');
        parts.push('>');
        i++;
        // Bulk escape: the fence lines joined with '\n', escaped once — identical
        // to escaping each line then joining with '\n', because '\n' is not in
        // the escape table and no escape spans the boundary.
        const fenceLines = [];
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          fenceLines.push(lines[i]);
          i++;
        }
        if (fenceLines.length > 0) parts.push(escapeHtml(fenceLines.join('\n')), '\n');
        i++;
        parts.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      // Blockquote: lines opening on '>', '>' and one space dropped, trimmed, empties dropped.
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const qlines = body.map(trimLine).filter((l) => l !== '');
      if (qlines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        parts.push('<blockquote>\n<p>');
        inlineInto(qlines.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List (bullet first, then ordered) or paragraph.
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      parts.push(open, '\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.join('\n'), env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const joined = body.join('\n');
    if (excerpt === null) {
      // The first paragraph is also the excerpt: render into a temp array,
      // join it once for the excerpt, and reuse the pieces for the output.
      const htmlParts = [];
      inlineInto(joined, env, htmlParts);
      excerpt = htmlParts.join('');
      parts.push('<p>', ...htmlParts, '</p>\n');
    } else {
      parts.push('<p>');
      inlineInto(joined, env, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates (lib/template.js)

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of strings) in `scope` ({ vars, parent }).
 * `ctx` holds the parsed templates, the HTML escape and the include depth.
 * This is the interpreter; layouts() normally uses the compiled renderers
 * below (compileTemplate), which flatten the same node tree into a function.
 * The interpreter stays as the fallback when code generation is unavailable
 * (e.g. --disallow-code-generation-from-strings) — compile failure falls back
 * to it, so output is identical either way.
 */
function renderNodesInto(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodesInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodesInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodesInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * Compile a parsed template node tree into a render function
 * `(scope, out, depth) => void`, generated at runtime from the tree itself
 * (no prebuilt artifact). Semantics are the interpreter's, statement for
 * statement: text/var/raw push the same strings, `if` uses the same
 * truthy()/not logic, `for` builds the same scope object with the same
 * `loop` fields, `include` respects the same depth cap 8 and skips a missing
 * template. The only difference is control flow: native if/for instead of a
 * node-dispatch switch and a recursive call per node. `H` carries the
 * helpers (lookup/textOf/truthy/escapeHtml) and the map of compiled
 * templates, so an include is one direct call. Throws if code generation
 * is disallowed — the caller falls back to the interpreter.
 */
function compileBody(nodes) {
  let uid = 0;
  const emit = (ns) => {
    let code = '';
    for (const n of ns) {
      if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') code += `out.push(H.escapeHtml(H.textOf(H.lookup(scope,${JSON.stringify(n.path)}))));`;
      else if (n.kind === 'raw') code += `out.push(H.textOf(H.lookup(scope,${JSON.stringify(n.path)})));`;
      else if (n.kind === 'if') {
        const cond = n.not ? `!H.truthy(H.lookup(scope,${JSON.stringify(n.path)}))` : `H.truthy(H.lookup(scope,${JSON.stringify(n.path)}))`;
        code += `if(${cond}){${emit(n.then)}}`;
        if (n.else !== null) code += `else{${emit(n.else)}}`;
      } else if (n.kind === 'for') {
        const v = `_v${uid++}`;
        const x = `_x${uid++}`;
        const k = `_k${uid++}`;
        code += `{const ${v}=scope;const ${x}=H.lookup(scope,${JSON.stringify(n.path)});if(Array.isArray(${x})){for(let ${k}=0;${k}<${x}.length;${k}++){scope={vars:{${n.name}:${x}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${x}.length-1,length:${x}.length}},parent:${v}};${emit(n.body)}}scope=${v};}}`;
      } else if (n.kind === 'include') {
        const t = `_t${uid++}`;
        const k = `_k${uid++}`;
        const m = `_m${uid++}`;
        const s = `_s${uid++}`;
        const o = `_o${uid++}`;
        // Partial-output cache: render once per (template, fingerprint) and
        // reuse the string; the fingerprint (templateReads + includeKey) is
        // exactly the values the included template can observe, so a hit is
        // byte-identical to re-rendering. A miss renders into a temp array.
        code += `{const ${t}=H.compiled.get(${JSON.stringify(n.name)});if(depth<${INCLUDE_DEPTH}&&${t}!==undefined){const ${k}=H.fp(scope,depth,${JSON.stringify(n.name)});let ${m}=H.cache.get(${JSON.stringify(n.name)});let ${s}=${m}===undefined?undefined:${m}.get(${k});if(${s}===undefined){const ${o}=[];${t}(scope,${o},depth+1);${s}=${o}.join('');if(${m}===undefined){${m}=new Map();H.cache.set(${JSON.stringify(n.name)},${m});}${m}.set(${k},${s});}out.push(${s});}}`;
      }
    }
    return code;
  };
  return emit(nodes);
}

/** Compile every parsed template, or null when code generation is unavailable. */
function compileTemplates(templates, reads) {
  const compiled = new Map();
  const H = { lookup, textOf, truthy, escapeHtml, compiled, reads, cache: new Map(), ids: new WeakMap(), idc: 0 };
  H.fp = (scope, depth, name) => includeKey(H, scope, depth, name);
  try {
    for (const [name, nodes] of templates) {
      compiled.set(name, new Function('H', `return function(scope,out,depth){${compileBody(nodes)}}`)(H));
    }
  } catch {
    return null;
  }
  return compiled;
}

/**
 * Each template's transitive reads, in two forms: first segments (for the
 * include-output cache) and full dotted paths (for lazy field skipping).
 * Both are fixpoints over the include graph (cycles converge: unions only
 * grow). Every lookup a render can make is a literal path in some node, so
 * a dotted path absent from a template's transitive set is never read by it.
 */
function templateUsage(templates) {
  const reads = new Map();
  const paths = new Map();
  const edges = new Map();
  for (const [name, nodes] of templates) {
    const firsts = new Set();
    const full = new Set();
    const inc = new Set();
    const walk = (ns) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
          firsts.add(n.path[0]);
          full.add(n.path.join('.'));
        }
        if (n.kind === 'if') {
          walk(n.then);
          if (n.else !== null) walk(n.else);
        } else if (n.kind === 'for') walk(n.body);
        else if (n.kind === 'include') inc.add(n.name);
      }
    };
    walk(nodes);
    reads.set(name, firsts);
    paths.set(name, full);
    edges.set(name, inc);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, targets] of edges) {
      const r = reads.get(name);
      const p = paths.get(name);
      for (const t of targets) {
        const rt = reads.get(t);
        const pt = paths.get(t);
        if (rt === undefined) continue;
        for (const x of rt) {
          if (!r.has(x)) {
            r.add(x);
            changed = true;
          }
        }
        for (const x of pt) {
          if (!p.has(x)) {
            p.add(x);
            changed = true;
          }
        }
      }
    }
  }
  return { reads: new Map([...reads].map(([k, v]) => [k, [...v]])), paths };
}

/**
 * The cache key for including `name` in `scope` at `depth`: the depth plus,
 * for each of the template's transitive reads, the value it resolves to —
 * object identity for objects/arrays (their contents are never mutated
 * during layouts, so identity implies identical output), value for
 * primitives, `u`/`n` for undefined/null. Two renders with the same key
 * produce the same string; different values can only miss, never wrongly hit.
 */
function includeKey(H, scope, depth, name) {
  const names = H.reads.get(name) ?? [];
  let k = `${depth}|`;
  for (let i = 0; i < names.length; i++) {
    const v = lookup(scope, [names[i]]);
    if (v === undefined) k += 'u;';
    else if (v === null) k += 'n;';
    else if (typeof v === 'object') {
      let id = H.ids.get(v);
      if (id === undefined) {
        id = ++H.idc;
        H.ids.set(v, id);
      }
      k += `o${id};`;
    } else k += `${typeof v}:${JSON.stringify(v)};`;
  }
  return k;
}

// ---------------------------------------------------------------- the pipeline (index.js)

/** The words of a body: its runs of characters other than whitespace.
 * Counts in one pass with no allocation (the reference's match(/\S+/g)
 * allocates one string per word). Whitespace = JS \s: ASCII <= 32 plus
 * U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F,
 * U+3000, U+FEFF; every other code unit (incl. surrogate halves) is a word char.
 * (U+0085 NEL is NOT JS \s — verified against /\S+/g.) */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c <= 32 ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. `needReading` skips the word count when
 * the card's reading_minutes can never be read (see layouts). */
function cardOf(s, needReading = true) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: needReading ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : 0,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (reuses the card computed once in layouts). */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  // A source's card needs its word count only when something reads it: a
  // post's card is read by every list (p.reading_minutes), and a page's card
  // only through its layout's transitive reads of page.reading_minutes
  // (a page's card is never listed anywhere else). Anything else is dead:
  // the page object is only reachable as `page`, and only a literal
  // page.reading_minutes path can observe the field.
  const layoutReadsReading = (name) => b.templatePaths.get(name)?.has('page.reading_minutes') ?? false;
  for (const s of b.sources) s.card = cardOf(s, s.post || layoutReadsReading(s.layout));
  b.cards = new Map(b.posts.map((p) => [p, p.card]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const out = [];
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    if (b.compiled !== null) {
      const fn = b.compiled.get(name);
      if (fn === undefined) return null;
      fn(scope, out, 0);
    } else {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      renderNodesInto(nodes, scope, ctx, 0, out);
    }
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const usage = templateUsage(templates);
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled: compileTemplates(templates, usage.reads),
    templatePaths: usage.paths,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

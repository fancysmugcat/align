/**
 * A very small PDF writer, enough to put a table on paper.
 *
 * ── Why this exists rather than a library ────────────────────────────────
 *
 * The records sheet already exports CSV, which is the right shape for a
 * spreadsheet and the wrong shape for handing to anyone — a coach, a parent, a
 * teacher — who just wants to read it. That wants a PDF.
 *
 * Every PDF library worth using is hundreds of kilobytes and would have to be
 * fetched from a CDN, which means the export stops working the moment the
 * phone is offline or the CDN is blocked. This site is a static page that must
 * work on a school wifi, so the generator is written out here instead. A
 * table of text is a small enough slice of the format to be worth owning:
 * five objects of boilerplate, one content stream per page, and an xref table
 * of byte offsets.
 *
 * ── What it deliberately does not do ─────────────────────────────────────
 *
 * Only the standard Helvetica faces, which every reader has built in, so no
 * font has to be embedded. Only WinAnsi text, so a name outside Latin-1 comes
 * out as `?` rather than as a corrupt file — the CSV export is the lossless
 * one. No images, no compression, no links.
 */

// A4 in points, which is the only unit PDF has.
const PAGE_W = 595;
const PAGE_H = 842;

const MARGIN = 40;
const FOOTER_Y = 32;
/** Rows stop here, leaving the footer its own air. */
const BODY_FLOOR = 58;

const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 9.5;
const HEAD_SIZE = 9;
const ROW_SIZE = 9;
const ROW_HEIGHT = 14;

const INK = [0.29, 0.29, 0.29];
const INK_FAINT = [0.54, 0.54, 0.54];
const RULE = [0.80, 0.80, 0.80];

/** Matches the on-screen quality colours, so a printout reads the same way. */
export const QUALITY_COLOURS = {
  green: [0.373, 0.702, 0.478],
  yellow: [0.890, 0.608, 0.235],
  red: [0.878, 0.357, 0.329],
};

/**
 * Renders rows as a paginated table and hands back a PDF blob.
 *
 * @param {object} spec
 * @param {string} spec.title Shown once, at the top of the first page.
 * @param {string} [spec.subtitle] A line under it — counts, dates, caveats.
 * @param {string} [spec.footnote] Repeated in the footer of every page.
 * @param {Array<{label: string, width: number, align?: 'left'|'right'}>} spec.columns
 * @param {Array<Array<string>>} spec.rows Cell text, already formatted.
 * @param {(row: string[], index: number) => (number[]|null)} [spec.colourFor]
 *   Optional per-row colour for one cell, keyed by column index.
 * @returns {Blob}
 */
export function tableToPDF({
  title, subtitle, footnote, columns, rows, colourFor = null,
}) {
  const xs = columnOffsets(columns);
  const pages = paginate(rows, Boolean(title));

  const streams = pages.map((page, index) => pageStream({
    page,
    pageNumber: index + 1,
    pageCount: pages.length,
    title: index === 0 ? title : null,
    subtitle: index === 0 ? subtitle : null,
    footnote,
    columns,
    xs,
    colourFor,
  }));

  return assemble(streams, title);
}

// MARK: - Layout

function columnOffsets(columns) {
  const xs = [];
  let x = MARGIN;
  for (const column of columns) {
    xs.push(x);
    x += column.width;
  }
  return xs;
}

/**
 * Splits rows across pages.
 *
 * The first page is shorter than the rest because the title block sits on it,
 * so the two cases are counted separately rather than assuming a fixed number
 * of rows per page.
 */
function paginate(rows, hasTitle) {
  const pages = [];
  let index = 0;

  while (index < rows.length) {
    const first = pages.length === 0;
    const top = first && hasTitle ? PAGE_H - MARGIN - 46 : PAGE_H - MARGIN;
    // One row of height goes to the column headings, and one to the rule
    // under them.
    const room = Math.max(1, Math.floor((top - BODY_FLOOR - ROW_HEIGHT * 1.5) / ROW_HEIGHT));
    pages.push({ top, rows: rows.slice(index, index + room) });
    index += room;
  }

  // An empty table still deserves a page saying so, rather than a broken file.
  if (pages.length === 0) {
    pages.push({ top: hasTitle ? PAGE_H - MARGIN - 46 : PAGE_H - MARGIN, rows: [] });
  }
  return pages;
}

// MARK: - Drawing

function pageStream({
  page, pageNumber, pageCount, title, subtitle, footnote, columns, xs, colourFor,
}) {
  const ops = [];
  let y = PAGE_H - MARGIN;

  if (title) {
    ops.push(text(MARGIN, y - TITLE_SIZE, title, 'F2', TITLE_SIZE, INK));
    y -= TITLE_SIZE + 8;
    if (subtitle) {
      ops.push(text(MARGIN, y - SUBTITLE_SIZE, subtitle, 'F1', SUBTITLE_SIZE, INK_FAINT));
      y -= SUBTITLE_SIZE + 12;
    } else {
      y -= 8;
    }
  }

  // Column headings, then a rule, then the rows.
  const headY = y - HEAD_SIZE;
  columns.forEach((column, index) => {
    ops.push(cell(column, xs[index], headY, column.label, 'F2', HEAD_SIZE, INK));
  });
  const ruleY = headY - 5;
  ops.push(line(MARGIN, ruleY, PAGE_W - MARGIN, ruleY, RULE, 0.8));

  let rowY = ruleY - ROW_HEIGHT + 4;
  for (const row of page.rows) {
    columns.forEach((column, index) => {
      const colour = colourFor ? colourFor(row, index) : null;
      ops.push(cell(column, xs[index], rowY, row[index] ?? '', 'F1', ROW_SIZE, colour ?? INK));
    });
    rowY -= ROW_HEIGHT;
  }

  if (page.rows.length === 0) {
    ops.push(text(MARGIN, rowY, 'No readings recorded.', 'F1', ROW_SIZE, INK_FAINT));
  }

  // Footer: the caveat on the left, the page count on the right, so a loose
  // sheet can still be placed.
  ops.push(line(MARGIN, FOOTER_Y + 14, PAGE_W - MARGIN, FOOTER_Y + 14, RULE, 0.8));
  if (footnote) ops.push(text(MARGIN, FOOTER_Y, footnote, 'F1', 7.5, INK_FAINT));
  const stamp = `Page ${pageNumber} of ${pageCount}`;
  ops.push(text(PAGE_W - MARGIN - widthOf(stamp, 7.5), FOOTER_Y, stamp, 'F1', 7.5, INK_FAINT));

  return ops.join('\n');
}

/** One cell, truncated to its column and right-aligned if the column asks. */
function cell(column, x, y, value, font, size, colour) {
  const room = column.width - 6;
  const clipped = truncate(String(value ?? ''), room, size);
  const at = column.align === 'right' ? x + room - widthOf(clipped, size) : x;
  return text(at, y, clipped, font, size, colour);
}

function text(x, y, value, font, size, colour) {
  const [r, g, b] = colour;
  return `BT\n${num(r)} ${num(g)} ${num(b)} rg\n/${font} ${num(size)} Tf\n`
    + `1 0 0 1 ${num(x)} ${num(y)} Tm\n(${escapeText(value)}) Tj\nET`;
}

function line(x1, y1, x2, y2, colour, width) {
  const [r, g, b] = colour;
  return `${num(r)} ${num(g)} ${num(b)} RG\n${num(width)} w\n`
    + `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`;
}

// MARK: - Text measurement

/**
 * Helvetica advance widths, in thousandths of an em, for the characters a
 * records table actually contains.
 *
 * The real metrics are a 300-entry table. Measuring is only ever used to
 * decide where to truncate and how far to shift a right-aligned number, so
 * grouping characters by width gets those right while staying readable. The
 * fallback is the width of a lowercase letter, which is the common case.
 */
const WIDTHS = new Map();
for (const [chars, width] of [
  [' !,./:;ijl|', 278],
  ['\'`', 191],
  ['"()[]{}-', 333],
  ['*', 389],
  ['ft', 278],
  ['r', 333],
  ['0123456789$', 556],
  ['abcdeghknopqsuvxyz', 556],
  ['w', 722],
  ['m', 833],
  ['JIL', 556],
  ['ABCDEFGHKNOPQRSTUVXYZ', 700],
  ['MW', 900],
  ['#%&@', 800],
]) {
  for (const char of chars) if (!WIDTHS.has(char)) WIDTHS.set(char, width);
}

function widthOf(value, size) {
  let total = 0;
  for (const char of String(value)) total += WIDTHS.get(char) ?? 556;
  return (total / 1000) * size;
}

/** Cuts a string to fit, marking the cut so a clipped name is not mistaken. */
function truncate(value, room, size) {
  if (widthOf(value, size) <= room) return value;
  const ellipsis = widthOf('...', size);
  let out = '';
  let used = 0;
  for (const char of value) {
    const next = used + widthOf(char, size);
    if (next + ellipsis > room) break;
    out += char;
    used = next;
  }
  return `${out}...`;
}

// MARK: - Encoding

/**
 * PDF strings are bytes, and the parentheses that delimit them plus the
 * backslash that escapes them have to be escaped themselves. Anything outside
 * Latin-1 cannot be written with a non-embedded Helvetica at all, so it
 * becomes a question mark rather than a byte the reader will reject.
 */
function escapeText(value) {
  let out = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code < 0x20) out += ' ';
    else if (code > 0xFF) out += '?';
    else out += char;
  }
  return out;
}

/** Trimmed to three decimals: PDF accepts reals, and shorter files parse faster. */
function num(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

// MARK: - File structure

/**
 * Wraps the content streams in the object graph a reader expects, then writes
 * the cross-reference table.
 *
 * Byte offsets are what the xref table holds, so the document is built as a
 * string of single-byte characters and only converted to bytes at the end —
 * measuring `length` on anything that could hold a multi-byte character would
 * put every offset after it out by the difference, and the file would not open.
 */
function assemble(streams, title) {
  const pageCount = streams.length;
  // 1 catalog, 2 pages, 3 regular, 4 bold, 5 info, then a page and a stream
  // object for each sheet.
  const firstPageObj = 6;
  const pageObj = (index) => firstPageObj + index * 2;
  const streamObj = (index) => firstPageObj + index * 2 + 1;

  const kids = streams.map((_, index) => `${pageObj(index)} 0 R`).join(' ');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escapeText(title ?? 'Records')}) /Producer (ALIGN) /Creator (ALIGN) `
      + `/CreationDate (${pdfDate(new Date())}) >>`,
  ];

  streams.forEach((stream, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> `
      + `/Contents ${streamObj(index)} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let file = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(file.length);
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = file.length;
  file += `xref\n0 ${objects.length + 1}\n`;
  // The free-list head, then one 20-byte entry per object. The trailing space
  // before each newline is part of the fixed width and not optional.
  file += '0000000000 65535 f \n';
  for (const offset of offsets) {
    file += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;

  return new Blob([latin1(file)], { type: 'application/pdf' });
}

/** The string is Latin-1 by construction, so one character is one byte. */
function latin1(value) {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xFF;
  return bytes;
}

function pdfDate(date) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `${sign}${pad(Math.trunc(offset / 60))}'${pad(offset % 60)}'`;
}

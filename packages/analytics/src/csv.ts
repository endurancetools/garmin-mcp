/** One CSV record with the line it starts on (1-based). */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * Parses CSV text: comma separated, double-quoted fields (`""` is a quote, line breaks
 * allowed inside), CRLF or LF, a leading BOM. Blank lines are dropped. No dependencies.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let touched = false;
  const endRecord = () => {
    fields.push(field);
    if (touched || fields.length > 1 || field !== '') out.push({ line: start, fields });
    fields = [];
    field = '';
    touched = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      touched = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else field += ch;
  }
  if (field !== '' || fields.length > 0 || touched) endRecord();
  return out;
}

/** One CSV line; a field with a comma, quote or line break is quoted. */
export function csvLine(fields: readonly (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      const s = f === null || f === undefined ? '' : String(f);
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    })
    .join(',');
}

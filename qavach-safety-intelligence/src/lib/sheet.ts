// Excel in and out without a library. An .xlsx file is a zip of XML: reading inflates the first worksheet with the
// browser's own DecompressionStream; writing stores the parts uncompressed, which every spreadsheet app opens.
// CSV is read too, for lists saved from other tools.

export type Cell = string | number;

/** The first sheet of an .xlsx or .csv file as rows of trimmed text. */
export async function readSheet(file: File): Promise<string[][]> {
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose an Excel (.xlsx) or CSV file.');
  const parts = await unzip(new Uint8Array(await file.arrayBuffer()));
  const sheetName = Object.keys(parts).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error('This file has no worksheet.');
  const xml = (name: string) => (parts[name] ? new DOMParser().parseFromString(new TextDecoder().decode(parts[name]), 'application/xml') : null);
  const shared = [...(xml('xl/sharedStrings.xml')?.getElementsByTagName('si') ?? [])].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent ?? '').join(''));
  const rows: string[][] = [];
  for (const row of xml(sheetName)!.getElementsByTagName('row')) {
    const r = Number(row.getAttribute('r')) - 1;
    const out: string[] = [];
    for (const c of row.getElementsByTagName('c')) {
      const col = colIndex(c.getAttribute('r') ?? '');
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      out[col] = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? [...c.getElementsByTagName('t')].map((t) => t.textContent ?? '').join('') : v;
    }
    rows[r] = Array.from(out, (x) => (x ?? '').trim());
  }
  return Array.from(rows, (r) => r ?? []);
}

/** An .xlsx file with one sheet; the first row is the header and is set in bold. */
export function writeXlsx(rows: Cell[][], sheet = 'Sheet1'): Blob {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const widths = rows[0].map((_, i) => Math.min(60, Math.max(10, ...rows.map((r) => String(r[i] ?? '').length + 2))));
  const body = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      const style = ri === 0 ? ' s="1"' : '';
      return typeof v === 'number' ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('')}</row>`)
    .join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${body}</sheetData></worksheet>`,
  };
  return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell.trim()), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell.trim()]);
  return rows;
}

const colIndex = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

async function unzip(buf: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('This is not a valid Excel file.');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.startsWith('xl/') || !name.endsWith('.xml')) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    out[name] = method === 0 ? data : new Uint8Array(await new Response(new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (d: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of d) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(text);
    const crc = crc32(d);
    const head = new Uint8Array(30 + n.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, d.length, true);
    h.setUint32(22, d.length, true);
    h.setUint16(26, n.length, true);
    head.set(n, 30);
    const cen = new Uint8Array(46 + n.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, d.length, true);
    c.setUint32(24, d.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    cen.set(n, 46);
    locals.push(head, d);
    centrals.push(cen);
    offset += head.length + d.length;
  }
  const size = centrals.reduce((s, x) => s + x.length, 0);
  const tail = new Uint8Array(22);
  const t = new DataView(tail.buffer);
  t.setUint32(0, 0x06054b50, true);
  t.setUint16(8, centrals.length, true);
  t.setUint16(10, centrals.length, true);
  t.setUint32(12, size, true);
  t.setUint32(16, offset, true);
  const all = [...locals, ...centrals, tail];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of all) out.set(x, o), (o += x.length);
  return out;
}

// Builds the FARs & AIM reference that the Orvix Aero app reads from
// orvixaero.com/regs/. Run weekly by .github/workflows/regs.yml.
//
//   node tools/regs/build.mjs            fetch everything and write regs/
//   node tools/regs/build.mjs --local d  parse saved files in folder d (tests)
//
// Sources (both U.S. government works, free to use):
//   FARs: eCFR, https://www.ecfr.gov (Title 14, and NTSB Part 830 in Title 49)
//   AIM:  FAA, https://www.faa.gov/air_traffic/publications/atpubs/aim_html/
//
// Output, per book: regs/<id>.json =
//   { id, kind: 'far'|'aim', title, name, asof, url, secs: [{ n, h, g, b: [block] }] }
// A block is one of:
//   { p, l? }        paragraph, l = indent level (0 when left out)
//   { hd }           heading inside a section
//   { note, k }      boxed note; k = 'note' | 'ref' | 'ex'
//   { t, cap? }      table: rows of cells; a cell is text or { x, s } (s = columns spanned)
//   { f, cap? }      figure image URL
// regs/index.json lists every book with its section headings, so the app can
// search headings before a book is saved on the phone.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = new URL('../../regs/', import.meta.url).pathname;
const args = process.argv.slice(2);
const LOCAL = args[0] === '--local' ? args[1] : null;

const FAR_PARTS = [
  { id: '1', title: 14, name: 'Definitions and Abbreviations' },
  { id: '43', title: 14, name: 'Maintenance, Preventive Maintenance, Rebuilding, and Alteration' },
  { id: '61', title: 14, name: 'Certification: Pilots, Flight Instructors, and Ground Instructors' },
  { id: '67', title: 14, name: 'Medical Standards and Certification' },
  { id: '68', title: 14, name: 'Requirements for Operating Certain Small Aircraft Without a Medical Certificate (BasicMed)' },
  { id: '91', title: 14, name: 'General Operating and Flight Rules' },
  { id: '107', title: 14, name: 'Small Unmanned Aircraft Systems' },
  { id: '117', title: 14, name: 'Flight and Duty Limitations and Rest Requirements: Flightcrew Members' },
  { id: '121', title: 14, name: 'Operating Requirements: Domestic, Flag, and Supplemental Operations' },
  { id: '135', title: 14, name: 'Operating Requirements: Commuter and On Demand Operations' },
  { id: '141', title: 14, name: 'Pilot Schools' },
  { id: '830', title: 49, name: 'NTSB: Notification and Reporting of Aircraft Accidents or Incidents' },
];

// ---------- text helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', sect: '§', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', frac12: '½', times: '×' };
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m);
const strip = (s) => decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// A <table> (eCFR or FAA HTML) to rows of cells, filling row/column spans.
function table(html) {
  const rows = [];
  const carry = []; // carry[col] = rows still covered by a rowspan above
  for (const tr of html.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi) ?? []) {
    const row = [];
    let col = 0;
    const skip = () => {
      while (carry[col] > 0) {
        carry[col]--;
        row.push('');
        col++;
      }
    };
    for (const m of tr.matchAll(/<(TH|TD)([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      skip();
      const span = +(/colspan="(\d+)"/i.exec(m[2])?.[1] ?? 1);
      const down = +(/rowspan="(\d+)"/i.exec(m[2])?.[1] ?? 1);
      const x = strip(m[3]);
      row.push(span > 1 ? { x, s: span } : x);
      for (let i = 0; i < span; i++) if (down > 1) carry[col + i] = down - 1;
      col += span;
    }
    skip();
    if (row.some((c) => (typeof c === 'string' ? c : c.x))) rows.push(row);
  }
  return rows;
}

// ---------- FARs (eCFR XML) ----------
const ROMAN = /^\((i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx|xxi|xxii|xxiii|xxiv|xxv)\)/;
function farLevel(text, state) {
  const m = /^\(([a-z]+|\d+|[A-Z]+)\)/.exec(text);
  if (!m) return state.last ?? 0;
  const k = m[1];
  let l;
  if (/^\d+$/.test(k)) l = 2;
  else if (/^[A-Z]+$/.test(k)) l = 4;
  else if (ROMAN.test(text)) {
    // (i), (v), (x) can be letters too: a letter when it follows h, u or w.
    const prev = state.letter;
    const asLetter = (k === 'i' && prev === 'h') || (k === 'v' && prev === 'u') || (k === 'x' && prev === 'w');
    l = asLetter ? 1 : 3;
  } else l = 1;
  if (l === 1) state.letter = k;
  state.last = l;
  return l;
}

function farBody(xml, imgBase) {
  const b = [];
  const state = {};
  const re = /<P>([\s\S]*?)<\/P>|<FP[^>]*>([\s\S]*?)<\/FP>|<HD\d[^>]*>([\s\S]*?)<\/HD\d>|(<TABLE[\s\S]*?<\/TABLE>)|<img[^>]*src="([^"]+)"[^>]*>/gi;
  for (const m of xml.matchAll(re)) {
    if (m[1] != null || m[2] != null) {
      const p = strip(m[1] ?? m[2]);
      if (!p) continue;
      const l = farLevel(p, state);
      b.push(l ? { p, l } : { p });
    } else if (m[3] != null) {
      const hd = strip(m[3]);
      if (hd) b.push({ hd });
    } else if (m[4]) {
      const t = table(m[4]);
      if (t.length) b.push({ t });
    } else if (m[5]) {
      b.push({ f: new URL(m[5], imgBase).href });
    }
  }
  return b;
}

function parseFar(xml, part) {
  const secs = [];
  let subpart = '';
  let group = '';
  const re = /<DIV6 [^>]*>\s*<HEAD>([\s\S]*?)<\/HEAD>|<DIV7 [^>]*TYPE="SUBJGRP"[^>]*>\s*<HEAD>([\s\S]*?)<\/HEAD>|<DIV(8|9) N="([^"]*)" TYPE="(SECTION|APPENDIX)"[^>]*>([\s\S]*?)<\/DIV\3>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] != null) {
      subpart = strip(m[1]);
      group = '';
      continue;
    }
    if (m[2] != null) {
      group = strip(m[2]);
      continue;
    }
    const body = m[6];
    const head = strip(/<HEAD>([\s\S]*?)<\/HEAD>/.exec(body)?.[1] ?? '');
    const isSec = m[5] === 'SECTION';
    let n = decode(m[4]);
    let h = head;
    if (isSec) {
      h = head.replace(/^§+\s*[\d.]+[a-z]?(\s*-\s*[\d.]+)?\s*/i, '').replace(/\.$/, '');
      if (/^\[Reserved\]$/i.test(h) && !/<P>/.test(body)) continue;
    } else {
      // "Appendix A to Part 61—Practical Test ..." → n "App. A", h the title
      const a = /^(.+?)\s*[—–]\s*(.+)$/.exec(head);
      const short = (x) =>
        x
          .replace(/^Appendix\s+([A-Z0-9]+)\b.*$/i, 'App. $1')
          .replace(/^Table\s+([A-Z0-9]+)\b.*$/i, 'Table $1')
          .replace(/^Special Federal Aviation Regulation No\.\s*(\d+).*$/i, 'SFAR $1');
      n = short(a ? a[1] : n);
      h = (a?.[2] || head).replace(/\s*Table$/, '');
    }
    const g = [subpart, group].filter(Boolean).join(' · ');
    secs.push({ n, h, g, b: farBody(body.replace(/<HEAD>[\s\S]*?<\/HEAD>/, ''), 'https://www.ecfr.gov/') });
  }
  return secs;
}

// ---------- AIM (FAA HTML) ----------
const AIM_BASE = 'https://www.faa.gov/air_traffic/publications/atpubs/aim_html/';

function olLabel(ol, i) {
  const t = (/type="(\w)"/.exec(ol.tag)?.[1] ?? '1').toLowerCase();
  const lvl = ol.level;
  if (t === 'a') return lvl >= 4 ? `(${String.fromCharCode(96 + i)})` : `${String.fromCharCode(96 + i)}.`;
  return lvl === 3 ? `${i})` : lvl >= 4 ? `(${i})` : `${i}.`;
}

function parseAimPage(html, pageUrl) {
  const main = html.slice(html.indexOf('<main'), html.lastIndexOf('</main>'));
  const chap = strip(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(main)?.[1] ?? '');
  const sect = strip(/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(main)?.[1] ?? '');
  const g = [chap, sect].filter(Boolean).join(' · ');
  const secs = [];
  let cur = null;
  let buf = '';
  let depth = 0; // li depth
  const ols = [];
  let box = null; // { k, text }
  const flush = () => {
    const text = strip(buf);
    buf = '';
    if (!text || !cur) return;
    if (box) box.parts.push(text);
    else cur.b.push(depth > 1 ? { p: text, l: depth - 1 } : { p: text });
  };
  const tok = /<(\/?)(h4|h5|ol|li|p|aside|table|figure|br)\b([^>]*)>/gi;
  let i = 0;
  for (let m; (m = tok.exec(main)); ) {
    buf += main.slice(i, m.index);
    i = tok.lastIndex;
    const close = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'h4' && !close) {
      flush();
      const end = main.indexOf('</h4>', i);
      const title = strip(main.slice(i, end));
      tok.lastIndex = i = end + 5;
      const pm = /^(\d+-\d+-\d+)\.\s*(.*)$/.exec(title);
      cur = { n: pm ? pm[1] : title, h: pm ? pm[2] : title, g, b: [] };
      secs.push(cur);
      ols.length = 0;
      depth = 0;
      continue;
    }
    if (tag === 'table' && !close) {
      flush();
      const end = main.indexOf('</table>', i);
      const t = main.slice(m.index, end + 8);
      tok.lastIndex = i = end + 8;
      const cap = strip(/<caption>([\s\S]*?)<\/caption>/i.exec(t)?.[1] ?? '');
      const rows = table(t.replace(/<caption>[\s\S]*?<\/caption>/i, ''));
      if (cur && rows.length) cur.b.push(cap ? { t: rows, cap } : { t: rows });
      continue;
    }
    if (tag === 'figure' && !close) {
      flush();
      const end = main.indexOf('</figure>', i);
      const f = main.slice(i, end);
      tok.lastIndex = i = end + 9;
      const cap = strip(/<figcaption>([\s\S]*?)<\/figcaption>/i.exec(f)?.[1] ?? '').replace(/^(FIG [\d-]+)/, '$1 ');
      for (const im of f.matchAll(/<img[^>]*src="([^"]+)"/gi)) cur?.b.push({ f: new URL(im[1], pageUrl).href, ...(cap ? { cap } : {}) });
      continue;
    }
    if (tag === 'aside') {
      flush();
      if (!close) {
        const cls = /class="([^"]*)"/.exec(m[3])?.[1] ?? '';
        box = { k: cls.includes('reference') ? 'ref' : cls.includes('example') ? 'ex' : 'note', parts: [] };
      } else if (box) {
        const note = box.parts.join('\n').replace(/^(NOTE|REFERENCE|EXAMPLE)S?-\s*\n?/i, '');
        if (cur && note) cur.b.push({ note, k: box.k });
        box = null;
      }
      continue;
    }
    if (tag === 'ol') {
      flush();
      if (!close) ols.push({ tag: m[3], level: ols.length + 1, n: 0 });
      else ols.pop();
      continue;
    }
    if (tag === 'li') {
      flush();
      if (!close) {
        const ol = ols[ols.length - 1];
        depth = ols.length;
        if (ol) {
          ol.n++;
          buf = olLabel(ol, ol.n) + ' ';
        }
      } else depth = Math.max(0, ols.length - 1);
      continue;
    }
    if (tag === 'p' || tag === 'h5' || tag === 'br') {
      // A <p> inside an <li> continues the item: only break when the li already has text.
      if (!close && tag === 'p' && /^\s*[\w().]+\s*$/.test(strip(buf)) && depth) continue;
      flush();
      continue;
    }
  }
  buf += main.slice(i);
  flush();
  return secs;
}

// ---------- fetch ----------
async function get(url, tries = 4) {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url, { headers: { 'accept-encoding': 'gzip, deflate', 'user-agent': 'OrvixAero-regs/1.0 (+https://orvixaero.com)' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.text();
    } catch (e) {
      if (a >= tries) throw e;
      await new Promise((r) => setTimeout(r, 3000 * a));
    }
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const books = [];
  const write = async (book) => {
    const json = JSON.stringify(book);
    await writeFile(join(OUT, `${book.id}.json`), json);
    books.push({
      id: book.id,
      kind: book.kind,
      title: book.title,
      name: book.name,
      asof: book.asof,
      url: book.url,
      bytes: Buffer.byteLength(json),
      heads: book.secs.map((s) => [s.n, s.h]),
    });
    console.log(book.id, book.secs.length, 'sections', Math.round(Buffer.byteLength(json) / 1024), 'KB');
  };

  // FARs
  let asof = {};
  if (!LOCAL) {
    const titles = JSON.parse(await get('https://www.ecfr.gov/api/versioner/v1/titles.json')).titles;
    for (const t of titles) asof[t.number] = t.up_to_date_as_of;
  }
  for (const p of FAR_PARTS) {
    const date = asof[p.title] ?? 'local';
    const xml = LOCAL
      ? await readFile(join(LOCAL, `p${p.id}.xml`), 'utf8').catch(() => null)
      : await get(`https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${p.title}.xml?part=${p.id}`);
    if (!xml) continue;
    const secs = parseFar(xml, p.id);
    if (!secs.length) throw new Error(`Part ${p.id}: no sections parsed`);
    await write({
      id: `far-${p.id}`,
      kind: 'far',
      title: p.title === 49 ? `49 CFR ${p.id}` : `Part ${p.id}`,
      name: p.name,
      asof: date,
      url: `https://www.ecfr.gov/current/title-${p.title}/part-${p.id}`,
      secs,
    });
  }

  // AIM: one book per chapter, plus the appendices.
  const idxUrl = AIM_BASE + 'index.html';
  const idx = LOCAL ? await readFile(join(LOCAL, 'aimidx.html'), 'utf8') : await get(idxUrl);
  const effective = /Effective:?\s*(?:<[^>]+>\s*)*([\d/]+|\w+ \d{1,2}, \d{4})/i.exec(idx)?.[1] ?? '';
  const change = /Change:?\s*(?:<[^>]+>\s*)*(Change \d+|Basic)/i.exec(idx)?.[1] ?? '';
  const pages = [...new Set([...idx.matchAll(/href="\.?\/?(chap\d+_section_\d+\.html)"/g)].map((m) => m[1]))];
  const chapters = new Map();
  for (const pg of pages) {
    const c = +/chap(\d+)_/.exec(pg)[1];
    if (!chapters.has(c)) chapters.set(c, []);
    chapters.get(c).push(pg);
  }
  const chapName = (c) => strip(new RegExp(`href="\\.?/?chap_${c}\\.html"[^>]*>([\\s\\S]*?)</a>`).exec(idx)?.[1] ?? `Chapter ${c}`);
  for (const [c, pgs] of [...chapters].sort((a, b) => a[0] - b[0])) {
    const secs = [];
    for (const pg of pgs) {
      const url = AIM_BASE + pg;
      const html = LOCAL ? await readFile(join(LOCAL, pg), 'utf8').catch(() => null) : await get(url);
      if (html) secs.push(...parseAimPage(html, url));
    }
    if (!secs.length) continue;
    await write({ id: `aim-${c}`, kind: 'aim', title: `AIM Ch. ${c}`, name: chapName(c).replace(/^Chapter \d+\.\s*/, ''), asof: [effective, change].filter(Boolean).join(' · '), url: AIM_BASE + `chap_${c}.html`, secs });
  }

  const index = { built: new Date().toISOString(), books };
  await writeFile(join(OUT, 'index.json'), JSON.stringify(index));
  if (!LOCAL && books.filter((b) => b.kind === 'far').length < FAR_PARTS.length) throw new Error('Some FAR parts are missing');
  console.log('wrote', books.length, 'books');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

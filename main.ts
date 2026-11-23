// main.ts is mend, the CLI SPEC.md specifies (MIT, from the kit's starter).
// It does all ten sections of SPEC.md: the command line, the output and exit
// codes, safe paths, format detection, matching lines at three tiers
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a section performed, in order, for the `R old -> new` output lines. */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 5 to 8 of SPEC.md, written for this entry.
//
// Section 5: matching lines at three tiers. Section 6: unified diffs.
// Section 7: SEARCH/REPLACE blocks. Section 8: V4A patches.
// ---------------------------------------------------------------------------

let strictMode = false;

/** A file's lines, its line break and whether it ends with one (SPEC section 3). */
interface FileShape {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileShape {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileShape): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line as one tier reads it: tier 0 exact, tier 1 without trailing
 * spaces and tabs, tier 2 without leading or trailing spaces and tabs. */
function tierNorm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O matches F at this tier. */
function occurrencesAt(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => tierNorm(l, tier));
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierNorm(F[i + j]!, tier) !== nO[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) where O occurs at
 * or after `from`, with every occurrence at that tier. */
function firstTier(O: string[], F: string[], from: number): { tier: number; pos: number[] } | null {
  const max = strictMode ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier where O occurs at or after `from`, taking its first
 * occurrence there; an end-of-file search takes only an occurrence that ends
 * at the file's last line. */
function firstTierFirst(O: string[], F: string[], from: number, eof: boolean): { tier: number; pos: number } | null {
  const max = strictMode ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(O, F, t, from);
    if (eof) {
      const at = pos.find((p) => p + O.length === F.length);
      if (at !== undefined) return { tier: t, pos: at };
    } else if (pos.length > 0) {
      return { tier: t, pos: pos[0]! };
    }
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the
 * first tier where one is. */
function firstTierSingle(anchor: string, F: string[], from: number): number | null {
  const max = strictMode ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < F.length; i++) {
      if (tierNorm(F[i]!, t) === tierNorm(anchor, t)) return i;
    }
  }
  return null;
}

/** One line of a replacement: a context line, written as the file's own
 * matched line, or an added line, written as the patch wrote it. */
type NLine = { ctx: true; oIdx: number } | { ctx: false; text: string };

function indentOf(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** The replacement lines for a hunk or chunk: context lines come from the
 * file, added lines as written, re-indented at tier 2 (the leading spaces and
 * tabs of O's first line replaced by those of the file's first matched line). */
function buildReplacement(nLines: NLine[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  for (const nl of nLines) {
    if (nl.ctx) {
      out.push(fileLines[at + nl.oIdx]!);
    } else if (tier === 2) {
      const text = nl.text;
      const p = indentOf(oFirst);
      const f = indentOf(fileLines[at]!);
      if (text !== '' && text.trim() !== '' && text.startsWith(p)) out.push(f + text.slice(p.length));
      else out.push(text);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
type BodyItem = { k: ' ' | '-' | '+'; text: string } | { k: '\\' };

/** A hunk or chunk as its old lines O and its new lines N: context lines are
 * in both, `-` lines only in O, `+` lines only in N. */
function chunkON(items: BodyItem[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of items) {
    if (it.k === ' ') { o.push(it.text); n.push({ ctx: true, oIdx: o.length - 1 }); }
    else if (it.k === '-') o.push(it.text);
    else if (it.k === '+') n.push({ ctx: false, text: it.text });
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(items: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.k === ' ' || items[i]!.k === '+') last = i;
  }
  if (last < 0) return false;
  return items[last + 1]?.k === '\\';
}

/** Apply unified hunks in order to a file's shape (SPEC section 6). */
function applyHunks(shape: FileShape, hunks: Hunk[], path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = chunkON(h.items);
    if (o.length > 0) {
      const found = firstTier(o, shape.lines, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + o.length - 1 === shape.lines.length - 1;
      const rep = buildReplacement(n, shape.lines, best, found.tier, o[0]!);
      shape.lines.splice(best, o.length, ...rep);
      if (runsToEnd) shape.final = !backslashAfterLast(h.items);
      d += n.length - o.length;
    } else {
      const at = Math.max(0, Math.min(h.a + d, shape.lines.length));
      const atEnd = at === shape.lines.length;
      const rep = n.map((x) => (x.ctx ? '' : x.text));
      shape.lines.splice(at, 0, ...rep);
      if (atEnd) shape.final = !backslashAfterLast(h.items);
      d += n.length;
    }
  }
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

/** The path after a `--- ` or `+++ ` line: the text after the four
 * characters, up to the first tab, with surrounding spaces removed. */
function pathAfter(line: string, skip: number): string {
  let s = line.slice(skip);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path. */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** One hunk, starting at a `@@ -A[,B] +C[,D] @@` line; B and D are not used. */
function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const head = lines[at]!;
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(head);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const a = Number(m[1]);
  const items: BodyItem[] = [];
  let i = at + 1;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    // The body ends at a `--- ` line followed by a `+++ ` line: that pair
    // starts a new section, it is not a `-` line of this hunk.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') items.push({ k: ' ', text: '' });
    else if (l.startsWith(' ')) items.push({ k: ' ', text: l.slice(1) });
    else if (l.startsWith('-')) items.push({ k: '-', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ k: '+', text: l.slice(1) });
    else if (l.startsWith('\\')) items.push({ k: '\\' });
    else break;
    i++;
  }
  while (items.length > 0 && items[items.length - 1]!.k === ' ' && (items[items.length - 1] as { text: string }).text === '') items.pop();
  return { hunk: { a, items }, next: i };
}

/** One unified section as one edit (SPEC section 6). */
function sectionEdit(oldPath: string, newPath: string, creation: boolean, deletion: boolean, hunks: Hunk[]): Edit {
  return (tree) => {
    if (oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of hunks) {
        for (let idx = 0; idx < h.items.length; idx++) {
          const it = h.items[idx]!;
          if (it.k === '+') {
            plus.push(it.text);
            lastPlusBackslash = h.items[idx + 1]?.k === '\\';
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const shape = splitFile(cur);
      applyHunks(shape, hunks, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(shape));
      tree.moves.push({ old: oldPath, nw: newPath });
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new Fail('missing', oldPath);
    const shape = splitFile(cur);
    applyHunks(shape, hunks, oldPath);
    tree.now.set(oldPath, joinFile(shape));
  };
}

/** One unified section, starting at `start` (a `diff --git` line when
 * gitOld/gitNew are set, else a `---`/`+++` pair); returns the first line
 * past the section. */
function parseSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null, edits: Edit[]): number {
  const n = lines.length;
  let i = start;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renFrom: string | null = null;
  let renTo: string | null = null;
  let newFile = false;
  let deletedFile = false;
  if (gitOld !== null) {
    i++;
  } else {
    pairOld = stripPrefix(pathAfter(lines[i]!, 4));
    pairNew = stripPrefix(pathAfter(lines[i + 1]!, 4));
    i += 2;
  }
  const hunks: Hunk[] = [];
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (pairOld !== null) break;
      pairOld = stripPrefix(pathAfter(line, 4));
      pairNew = stripPrefix(pathAfter(lines[i + 1]!, 4));
      i += 2;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { if (renFrom === null) renFrom = line.slice(12).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { if (renTo === null) renTo = line.slice(10).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { deletedFile = true; i++; continue; }
      if (line.startsWith('@@')) {
        const r = parseHunk(lines, i);
        hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const r = parseHunk(lines, i);
      hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  const oldPath = pairOld ?? renFrom ?? gitOld;
  const newPath = pairNew ?? renTo ?? gitNew;
  if (oldPath === null || newPath === null) throw new Exit2(`error: parse ${start + 1}`);
  const creation = oldPath === '/dev/null' || newFile;
  const deletion = !creation && (newPath === '/dev/null' || deletedFile);
  edits.push(sectionEdit(oldPath, newPath, creation, deletion, hunks));
  return i;
}

/** Read a patch as unified diffs (SPEC section 6). */
function unifiedEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseSection(lines, i, m[1]!, m[2]!, edits);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseSection(lines, i, null, null, edits);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** One SEARCH/REPLACE block as one edit (SPEC section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const shape = splitFile(cur);
    const found = firstTier(oldLines, shape.lines, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildReplacement(newLines.map((t) => ({ ctx: false as const, text: t })), shape.lines, at, found.tier, oldLines[0]!);
    shape.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(shape));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC section 7). */
function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, whether it is end-of-file, and its body. */
interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function isV4ASectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

/** The chunks of one Update File section, from its body line indexes. */
function parseV4AChunks(lines: string[], raw: number[]): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let startedAny = false;
  const startChunk = (anchor: string | null): void => {
    cur = { anchor, eof: false, items: [] };
    chunks.push(cur);
    startedAny = true;
  };
  for (const idx of raw) {
    const l = lines[idx]!;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      startChunk(a === '' ? null : a);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) startChunk(null);
      cur!.eof = true;
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (startedAny) throw new Exit2(`error: parse ${idx + 1}`);
        startChunk(null);
      }
      if (l === '') cur!.items.push({ k: ' ', text: '' });
      else if (l.startsWith(' ')) cur!.items.push({ k: ' ', text: l.slice(1) });
      else if (l.startsWith('-')) cur!.items.push({ k: '-', text: l.slice(1) });
      else cur!.items.push({ k: '+', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
  }
  return chunks;
}

/** One V4A Add File section as one edit (SPEC section 8). */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as one edit (SPEC section 8). */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as one edit (SPEC section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && moveTo !== '/dev/null' && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const shape = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = firstTierSingle(ch.anchor, shape.lines, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = chunkON(ch.items);
      if (o.length > 0) {
        const found = firstTierFirst(o, shape.lines, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const rep = buildReplacement(n, shape.lines, found.pos, found.tier, o[0]!);
        shape.lines.splice(found.pos, o.length, ...rep);
        cursor = found.pos + rep.length;
      } else {
        const at = ch.eof ? shape.lines.length : cursor;
        const rep = n.map((x) => (x.ctx ? '' : x.text));
        shape.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      }
    }
    const text = joinFile(shape);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Read a patch as a V4A patch (SPEC section 8). */
function v4aEdits(lines: string[]): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const raw: number[] = [];
      let j = i + 1;
      while (j < last && !isV4ASectionStart(lines[j]!)) { raw.push(j); j++; }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      const fileLines: string[] = [];
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
    } else if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      let j = i + 1;
      while (j < last && !isV4ASectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
    } else if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      const raw: number[] = [];
      while (j < last && !isV4ASectionStart(lines[j]!)) { raw.push(j); j++; }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      const chunks = parseV4AChunks(lines, raw);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
      i = j;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  strictMode = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines) : kind === 'search-replace' ? searchReplaceEdits(lines) : v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded, whose old path existed before the patch and is gone
  // after it, and whose new path did not exist before it and does after it, is
  // one `R old -> new` line (sorted by the new path) instead of its D/A pair.
  const movedTo = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) movedTo.set(m.nw, m.old);
  }
  const movedFrom = new Set<string>(movedTo.values());
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedTo.has(p) || movedFrom.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [nw, old] of movedTo) rows.push({ key: nw, text: `R ${old} -> ${nw}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

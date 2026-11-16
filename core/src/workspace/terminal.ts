// Command output as a terminal shows it (docs/workspace.md, "Command output"). Lyrica runs commands without a
// terminal, so a progress bar redrawn with a carriage return, or a few lines redrawn with cursor moves, arrives as
// every frame it drew. `Terminal` plays the output the way a terminal would (ECMA-48 and xterm's control sequences):
// a carriage return goes back to the line's start and what follows overwrites it, backspace steps back, cursor moves
// go up, down and across a screen of the latest `SCREEN_ROWS` lines, and erases clear what they name. Colours and
// every other sequence are dropped. What it gives is what the person would have seen when the command ended.
//
// One pass, a character at a time, with no pattern: linear on any output (AGENTS.md, patterns on outside text).
// Work a sequence does beyond its own characters (spaces a cursor jump pads a line with, cells an erase blanks,
// lines it clears) is paid from `credit`, which each character of output adds to, so neither time nor what it gives
// can grow faster than the output: crafted output only folds less faithfully. It streams: `write` takes pieces as
// they come, a sequence split between two pieces included.

/** How far up a cursor move reaches: lines above the screen are scrolled out and fixed, as in a terminal. */
export const SCREEN_ROWS = 256;
/** The furthest column a cursor move goes to, so a crafted `ESC[99999999G` can't pad a line with spaces. */
export const MAX_COLUMN = 4096;
/** The most of a sequence's parameters kept; longer ones are still read to their end, and ignored. */
const MAX_PARAMS = 64;
/** Work a fold may do before its output has paid for any, and how much each character of output adds. */
const START_CREDIT = 64 * 1024;
const CREDIT_PER_CHAR = 1;

const enum State { Text, Escape, EscapeMore, Csi, Str, StrEscape }

export class Terminal {
  /** Lines scrolled above the screen, joined, each ending in a newline. */
  private above = "";
  /** The screen: the latest lines. A line is text while it is only added to, and cells once something overwrites it. */
  private rows: Row[] = [new Row()];
  private row = 0;
  private col = 0;
  private saved = { row: 0, col: 0 };
  private state = State.Text;
  private params = "";
  private credit = START_CREDIT;

  /** Plays a piece of output. */
  write(text: string): this {
    this.credit += CREDIT_PER_CHAR * text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      switch (this.state) {
        case State.Text:
          if (printable(c)) {
            // A run of text at once: most output is lines of it, and this keeps it fast.
            let j = i + 1;
            while (j < text.length && printable(text.charCodeAt(j))) j++;
            this.put(text.slice(i, j));
            i = j - 1;
          } else this.control(c);
          break;
        case State.Escape:
          this.escape(c);
          break;
        case State.EscapeMore:
          // ESC, intermediates (charset choices such as ESC ( B), then one final character: nothing to show.
          if (c < 0x20 || c > 0x2f) this.state = State.Text;
          break;
        case State.Csi:
          if (c >= 0x40 && c <= 0x7e) { this.csi(c); this.state = State.Text; }
          else if (c >= 0x20 && c <= 0x3f) { if (this.params.length < MAX_PARAMS) this.params += text[i]; }
          else if (c === 0x1b) this.state = State.Escape;
          else if (c === 0x18 || c === 0x1a) this.state = State.Text;
          break;
        case State.Str:
          // OSC (a window title, a link), DCS, SOS, PM, APC: skipped to BEL or ST.
          if (c === 0x07 || c === 0x9c) this.state = State.Text;
          else if (c === 0x1b) this.state = State.StrEscape;
          break;
        case State.StrEscape:
          this.state = c === 0x5c ? State.Text : State.Str;
          break;
      }
    }
    return this;
  }

  /** What the terminal shows: the lines scrolled out, then the screen. */
  text(): string {
    return this.above + this.rows.map((r) => r.text()).join("\n");
  }

  /** Puts the cursor after the last thing shown, so a note added there (output skipped) overwrites nothing. */
  toEnd(): this {
    this.row = this.rows.length - 1;
    this.col = this.rows[this.row]!.length;
    this.state = State.Text;
    return this;
  }

  /** Lets go of the oldest lines scrolled out, past `chars` of them, so a view holding a long command stays bounded. */
  trimAbove(chars: number): void {
    if (this.above.length <= chars) return;
    const cut = this.above.indexOf("\n", this.above.length - chars);
    this.above = cut < 0 ? "" : this.above.slice(cut + 1);
  }

  private control(c: number): void {
    if (c === 0x0a || c === 0x0b || c === 0x0c) {
      // Output from a pipe means a new line at its start: a terminal's line discipline adds the carriage return.
      this.down(1);
      this.col = 0;
    } else if (c === 0x0d) this.col = 0;
    else if (c === 0x08) this.col = Math.max(0, this.col - 1);
    else if (c === 0x09) this.put("\t");
    else if (c === 0x1b) this.state = State.Escape;
    else if (c === 0x9b) { this.params = ""; this.state = State.Csi; }
    else if (c === 0x9d || c === 0x90) this.state = State.Str;
    // Any other control character (a bell, a NUL, C1) shows nothing.
  }

  private escape(c: number): void {
    this.state = State.Text;
    if (c === 0x5b) { this.params = ""; this.state = State.Csi; }
    else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) this.state = State.Str;
    else if (c === 0x37) this.saved = { row: this.row, col: this.col };
    else if (c === 0x38) this.restore();
    else if (c === 0x45) { this.down(1); this.col = 0; }
    else if (c === 0x44) this.down(1);
    else if (c === 0x4d) this.row = Math.max(0, this.row - 1);
    else if (c === 0x63) this.clear();
    else if (c >= 0x20 && c <= 0x2f) this.state = State.EscapeMore;
  }

  /** Writes a run at the cursor; spaces padding the line out to it come from credit, and past it the run lands sooner. */
  private put(run: string): void {
    const line = this.rows[this.row]!;
    const pad = Math.min(Math.max(0, this.col - line.length), this.credit);
    this.credit -= pad;
    this.col = Math.min(this.col, line.length + pad);
    line.put(this.col, run);
    this.col += run.length;
  }

  private csi(final: number): void {
    // A private sequence (ESC[?25l hides the cursor) changes nothing that shows.
    if (/* < = > ? */ this.params.length && this.params.charCodeAt(0) >= 0x3c) return;
    // The first two parameters, as numbers (0 when left out); more are never needed here.
    const ps = [0, 0];
    for (let i = 0, k = 0; i < this.params.length && k < 2; i++) {
      const d = this.params.charCodeAt(i);
      if (d === 0x3b) k++;
      else if (d >= 0x30 && d <= 0x39) ps[k] = Math.min(ps[k]! * 10 + d - 0x30, 1_000_000);
    }
    const n = Math.max(1, ps[0] ?? 0);
    const line = this.rows[this.row]!;
    switch (final) {
      case 0x41: this.row = Math.max(0, this.row - n); break; // A, up
      case 0x42: this.row = Math.min(this.rows.length - 1, this.row + n); break; // B, down: it stops at the last line
      case 0x43: this.col = Math.min(MAX_COLUMN, this.col + n); break; // C, forward
      case 0x44: this.col = Math.max(0, this.col - n); break; // D, back
      case 0x45: this.row = Math.min(this.rows.length - 1, this.row + n); this.col = 0; break; // E, next line
      case 0x46: this.row = Math.max(0, this.row - n); this.col = 0; break; // F, previous line
      case 0x47: case 0x60: this.col = Math.min(MAX_COLUMN, n - 1); break; // G, column
      case 0x64: this.goTo(n - 1, this.col); break; // d, row
      case 0x48: case 0x66: this.goTo(Math.max(1, ps[0] ?? 0) - 1, Math.min(MAX_COLUMN, Math.max(1, ps[1] ?? 0) - 1)); break; // H, f
      case 0x4b: { // K, erase in line
        const how = ps[0] ?? 0;
        if (how === 0) line.cut(this.col);
        else if (how === 1) this.credit -= line.blank(this.col, this.credit);
        else if (how === 2) line.cut(0);
        break;
      }
      case 0x4a: { // J, erase in display
        const how = ps[0] ?? 0;
        if (how === 0) { line.cut(this.col); this.rows.length = this.row + 1; }
        else if (how === 1) {
          for (let r = this.row - 1; r >= 0 && this.credit > 0; r--, this.credit--) this.rows[r]!.cut(0);
          this.credit -= line.blank(this.col, this.credit);
        }
        else this.clear();
        break;
      }
      case 0x73: this.saved = { row: this.row, col: this.col }; break; // s
      case 0x75: this.restore(); break; // u
      // m (colours) and the rest: nothing that shows.
    }
  }

  /** Down `n` lines, adding a line at the bottom (a new line, as LF); the screen's top scrolls out past SCREEN_ROWS. */
  private down(n: number): void {
    for (let k = 0; k < n; k++) {
      this.row++;
      if (this.row === this.rows.length) this.rows.push(new Row());
      if (this.rows.length > SCREEN_ROWS) {
        this.above += `${this.rows.shift()!.text()}\n`;
        this.row--;
        this.saved.row = Math.max(0, this.saved.row - 1);
      }
    }
  }

  /** To a row and column; the screen holds the lines printed so far, so a row past them is the last. */
  private goTo(row: number, col: number): void {
    this.row = Math.min(row, this.rows.length - 1);
    this.col = col;
  }

  private restore(): void {
    this.goTo(this.saved.row, this.saved.col);
  }

  /** The screen cleared (ESC[2J, `clear`): what it showed scrolls out, as a terminal keeps it in its scrollback. */
  private clear(): void {
    let last = this.rows.length - 1;
    while (last >= 0 && !this.rows[last]!.length) last--;
    if (last >= 0) this.above += `${this.rows.slice(0, last + 1).map((r) => r.text()).join("\n")}\n`;
    this.rows = [new Row()];
    this.row = 0;
  }
}

const printable = (c: number) => c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f);

/**
 * One line of the screen, a cell per UTF-16 unit: `head` as text, then `cells` from where something first wrote
 * before the end. Text added at the end is joined as a string. Opening the head into cells at least doubles the
 * cells each time, so a line redrawn a million times costs a million cell writes and each character a bounded
 * number of copies. `mark`: cells 0 through it are all spaces, so erasing to the cursor again blanks only past it.
 */
class Row {
  private head = "";
  private cells: string[] = [];
  private mark = -1;

  get length(): number {
    return this.head.length + this.cells.length;
  }

  put(col: number, run: string): void {
    if (col <= this.mark) this.mark = col - 1;
    if (!this.cells.length && col >= this.head.length) { this.head += " ".repeat(col - this.head.length) + run; return; }
    this.open(col);
    const at = col - this.head.length;
    while (this.cells.length < at) this.cells.push(" ");
    for (let k = 0; k < run.length; k++) this.cells[at + k] = run[k]!;
  }

  /** Erases from `col` to the end. */
  cut(col: number): void {
    if (col <= this.head.length) {
      if (col < this.head.length) this.head = this.head.slice(0, col);
      if (this.cells.length) this.cells = [];
    }
    else this.cells.length = Math.min(this.cells.length, col - this.head.length);
    this.mark = Math.min(this.mark, col - 1);
  }

  /** Erases from the start through `col`, leaving spaces, at most `budget` cells of it; gives how many it blanked. */
  blank(col: number, budget: number): number {
    // Through the end: an empty line shows the same, as later text pads it with spaces.
    if (col >= this.length - 1) { this.cut(0); return 0; }
    const from = this.mark + 1;
    const to = Math.min(col, this.mark + Math.max(0, budget));
    if (to < from) return 0;
    this.open(from);
    for (let i = from; i <= to; i++) this.cells[i - this.head.length] = " ";
    this.mark = to;
    return to - from + 1;
  }

  text(): string {
    return this.cells.length ? this.head + this.cells.join("") : this.head;
  }

  /** Makes cells of the head from `col` on, at least as many again as there are cells. */
  private open(col: number): void {
    if (col >= this.head.length) return;
    const at = Math.max(0, Math.min(col, this.head.length - Math.max(this.cells.length, 64)));
    const opened = this.head.slice(at).split("");
    this.cells = opened.length ? opened.concat(this.cells) : this.cells;
    this.head = this.head.slice(0, at);
  }
}

/** A command's whole output as a terminal would show it once it ended. */
export function foldOutput(text: string): string {
  return /[\r\b\x1b\x9b]/.test(text) ? new Terminal().write(text).text() : text;
}

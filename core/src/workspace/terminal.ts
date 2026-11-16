// Command output as a terminal shows it (docs/workspace.md, "Command output"). Lyrica runs commands without a
// terminal, so a progress bar redrawn with a carriage return, or a few lines redrawn with cursor moves, arrives as
// every frame it drew. `Terminal` plays the output the way a terminal would (ECMA-48 and xterm's control sequences):
// a carriage return goes back to the line's start and what follows overwrites it, backspace steps back, cursor moves
// go up, down and across a screen of the latest `SCREEN_ROWS` lines, and erases clear what they name. Colours and
// every other sequence are dropped. What it gives is what the person would have seen when the command ended.
//
// One pass, a character at a time, with no pattern: linear on any output (AGENTS.md, patterns on outside text).
// It streams: `write` takes pieces as they come, a sequence split between two pieces included.

/** How far up a cursor move reaches: lines above the screen are scrolled out and fixed, as in a terminal. */
export const SCREEN_ROWS = 256;
/** The furthest column a cursor move goes to, so a crafted `ESC[99999999G` can't pad a line with spaces. */
export const MAX_COLUMN = 4096;
/** The most of a sequence's parameters kept; longer ones are still read to their end, and ignored. */
const MAX_PARAMS = 64;

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

  /** Plays a piece of output. */
  write(text: string): this {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      switch (this.state) {
        case State.Text:
          if (printable(c)) {
            // A run of text at once: most output is lines of it, and this keeps it fast.
            let j = i + 1;
            while (j < text.length && printable(text.charCodeAt(j))) j++;
            this.rows[this.row]!.put(this.col, text.slice(i, j));
            this.col += j - i;
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
    this.col = this.rows[this.row]!.text().length;
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
    else if (c === 0x09) this.rows[this.row]!.put(this.col++, "\t");
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

  private csi(final: number): void {
    // A private sequence (ESC[?25l hides the cursor) changes nothing that shows.
    if (/* < = > ? */ this.params.length && this.params.charCodeAt(0) >= 0x3c) return;
    const ps = this.params.split(";").map((p) => Math.min(Number.parseInt(p, 10) || 0, 1_000_000));
    const n = Math.max(1, ps[0] ?? 0);
    const line = this.rows[this.row]!;
    switch (final) {
      case 0x41: this.row = Math.max(0, this.row - n); break; // A, up
      case 0x42: this.down(n); break; // B, down
      case 0x43: this.col = Math.min(MAX_COLUMN, this.col + n); break; // C, forward
      case 0x44: this.col = Math.max(0, this.col - n); break; // D, back
      case 0x45: this.down(n); this.col = 0; break; // E, next line
      case 0x46: this.row = Math.max(0, this.row - n); this.col = 0; break; // F, previous line
      case 0x47: case 0x60: this.col = Math.min(MAX_COLUMN, n - 1); break; // G, column
      case 0x64: this.goTo(n - 1, this.col); break; // d, row
      case 0x48: case 0x66: this.goTo(Math.max(1, ps[0] ?? 0) - 1, Math.min(MAX_COLUMN, Math.max(1, ps[1] ?? 0) - 1)); break; // H, f
      case 0x4b: { // K, erase in line
        const how = ps[0] ?? 0;
        if (how === 0) line.cut(this.col);
        else if (how === 1) line.blank(this.col);
        else if (how === 2) line.cut(0);
        break;
      }
      case 0x4a: { // J, erase in display
        const how = ps[0] ?? 0;
        if (how === 0) { line.cut(this.col); this.rows.length = this.row + 1; }
        else if (how === 1) { for (let r = 0; r < this.row; r++) this.rows[r] = new Row(); line.blank(this.col); }
        else this.clear();
        break;
      }
      case 0x73: this.saved = { row: this.row, col: this.col }; break; // s
      case 0x75: this.restore(); break; // u
      // m (colours) and the rest: nothing that shows.
    }
  }

  /** Down `n` lines, adding lines at the bottom; the screen's top scrolls out past SCREEN_ROWS. */
  private down(n: number): void {
    for (let k = 0; k < Math.min(n, SCREEN_ROWS); k++) {
      this.row++;
      if (this.row === this.rows.length) this.rows.push(new Row());
      if (this.rows.length > SCREEN_ROWS) {
        this.above += `${this.rows.shift()!.text()}\n`;
        this.row--;
        this.saved.row = Math.max(0, this.saved.row - 1);
      }
    }
  }

  private goTo(row: number, col: number): void {
    const want = Math.min(row, SCREEN_ROWS - 1);
    while (this.rows.length <= want) this.rows.push(new Row());
    this.row = want;
    this.col = col;
  }

  private restore(): void {
    this.goTo(this.saved.row, this.saved.col);
  }

  /** The screen cleared (ESC[2J, `clear`): what it showed scrolls out, as a terminal keeps it in its scrollback. */
  private clear(): void {
    const shown = this.rows.map((r) => r.text()).join("\n");
    if (shown) this.above += `${shown}\n`;
    this.rows = [new Row()];
    this.row = 0;
  }
}

const printable = (c: number) => c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f);

/**
 * One line of the screen, a cell per UTF-16 unit. Text added at its end is joined as a string; the first write
 * before its end turns it into cells, once, so a line redrawn a million times costs a million cell writes, not copies.
 */
class Row {
  private s = "";
  private cells?: string[];

  put(col: number, run: string): void {
    if (!this.cells && col >= this.s.length) { this.s += " ".repeat(col - this.s.length) + run; return; }
    const cells = (this.cells ??= this.s.split(""));
    while (cells.length < col) cells.push(" ");
    for (let k = 0; k < run.length; k++) cells[col + k] = run[k]!;
  }

  /** Erases from `col` to the end. */
  cut(col: number): void {
    if (this.cells) this.cells.length = Math.min(this.cells.length, col);
    else this.s = this.s.slice(0, col);
  }

  /** Erases from the start through `col`, leaving spaces. */
  blank(col: number): void {
    const cells = (this.cells ??= this.s.split(""));
    for (let i = 0; i <= col && i < cells.length; i++) cells[i] = " ";
  }

  text(): string {
    return this.cells ? this.cells.join("") : this.s;
  }
}

/** A command's whole output as a terminal would show it once it ended. */
export function foldOutput(text: string): string {
  return /[\r\b\x1b\x9b]/.test(text) ? new Terminal().write(text).text() : text;
}

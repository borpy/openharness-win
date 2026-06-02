/**
 * Cell grid — 2D array of styled characters for terminal rendering.
 */

export type Style = {
  fg: string | null; // color name: "red", "cyan", etc. null = default
  bg: string | null;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  hyperlink?: string | null; // OSC 8 URL target. Optional so existing literal Style objects compile unchanged.
};

export type Cell = {
  char: string;
  style: Style;
};

export const EMPTY_STYLE: Style = { fg: null, bg: null, bold: false, dim: false, underline: false, hyperlink: null };
export const EMPTY_CELL: Cell = { char: " ", style: { ...EMPTY_STYLE } };

export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.style.fg === b.style.fg &&
    a.style.bg === b.style.bg &&
    a.style.bold === b.style.bold &&
    a.style.dim === b.style.dim &&
    a.style.underline === b.style.underline &&
    (a.style.hyperlink ?? null) === (b.style.hyperlink ?? null)
  );
}

export class CellGrid {
  readonly width: number;
  readonly height: number;
  cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = [];
    for (let r = 0; r < height; r++) {
      const row: Cell[] = [];
      for (let c = 0; c < width; c++) {
        row.push({ char: " ", style: { ...EMPTY_STYLE } });
      }
      this.cells.push(row);
    }
  }

  clear(): void {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const cell = this.cells[r]![c]!;
        cell.char = " ";
        cell.style.fg = null;
        cell.style.bg = null;
        cell.style.bold = false;
        cell.style.dim = false;
        cell.style.underline = false;
        cell.style.hyperlink = null;
      }
    }
  }

  setCell(row: number, col: number, char: string, style: Style): void {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return;
    const cell = this.cells[row]![col]!;
    cell.char = char;
    const s = style ?? EMPTY_STYLE;
    cell.style.fg = s.fg;
    cell.style.bg = s.bg;
    cell.style.bold = s.bold;
    cell.style.dim = s.dim;
    cell.style.underline = s.underline;
    cell.style.hyperlink = s.hyperlink ?? null;
  }

  /**
   * Write a string into the grid at (row, col). Handles \n for line breaks.
   * Returns the number of rows consumed.
   */
  writeText(row: number, col: number, text: string, style: Style, wrapWidth?: number): number {
    const maxCol = wrapWidth ?? this.width;
    let r = row;
    let c = col;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\n") {
        r++;
        c = col;
        continue;
      }
      if (c >= maxCol) {
        r++;
        c = col;
      }
      if (r >= this.height) break;
      this.setCell(r, c, ch, style);
      c++;
    }
    return r - row + 1;
  }

  /**
   * Write a single clipped row. Newlines and over-width text are ignored
   * instead of wrapping into reserved rows below the target.
   */
  writeTextClipped(row: number, col: number, text: string, style: Style, maxCol = this.width): void {
    const limit = Math.max(0, Math.min(maxCol, this.width));
    let c = col;
    for (let i = 0; i < text.length && c < limit; i++) {
      const ch = text[i]!;
      if (ch === "\n" || ch === "\r") break;
      this.setCell(row, c, ch, style);
      c++;
    }
  }

  /**
   * Write word-wrapped text. Splits on spaces, wraps at wrapWidth.
   * Returns the number of rows consumed.
   */
  writeWrapped(row: number, col: number, text: string, style: Style, wrapWidth: number, maxRow?: number): number {
    const limit = maxRow ?? this.height;
    const lines = text.split("\n");
    let r = row;
    for (const line of lines) {
      if (r >= limit) break;
      const words = line.split(" ");
      let c = col;
      for (const word of words) {
        if (word.length === 0) continue;
        // Wrap if word doesn't fit on current line (unless at start of line)
        if (c > col && c + word.length + 1 > wrapWidth) {
          r++;
          c = col;
          if (r >= limit) break;
        }
        // Add space before word (unless at start of line)
        if (c > col) {
          this.setCell(r, c, " ", style);
          c++;
        }
        // Write word character by character (may still wrap if word > wrapWidth)
        for (let i = 0; i < word.length; i++) {
          if (c >= wrapWidth) {
            r++;
            c = col;
            if (r >= limit) break;
          }
          this.setCell(r, c, word[i]!, style);
          c++;
        }
      }
      r++;
    }
    return r - row;
  }

  /**
   * Write text on a single row (no wrapping), tagging http(s):// and file:// runs
   * with the OSC 8 hyperlink attribute (cyan + underline). Stops at maxCol or grid width.
   */
  writeTextWithLinks(row: number, col: number, text: string, baseStyle: Style, maxCol?: number): void {
    const limit = Math.min(maxCol ?? this.width, this.width);
    if (row < 0 || row >= this.height) return;
    const linkRegex = /(https?:\/\/[^\s)\]'"<>]+|file:\/\/[^\s)\]'"<>]+)/g;
    let cursor = 0;
    let c = col;
    while (true) {
      const m: RegExpExecArray | null = linkRegex.exec(text);
      if (m === null) break;
      const before = text.slice(cursor, m.index);
      for (let i = 0; i < before.length && c < limit; i++) {
        this.setCell(row, c, before[i]!, baseStyle);
        c++;
      }
      if (c >= limit) return;
      // Strip trailing punctuation that's almost never part of the URL.
      let url = m[0]!;
      while (url.length > 0 && /[.,;:!?]/.test(url[url.length - 1]!)) {
        url = url.slice(0, -1);
      }
      if (url.length === 0) {
        cursor = m.index + m[0]!.length;
        continue;
      }
      const linkStyle: Style = { ...baseStyle, fg: "cyan", underline: true, hyperlink: url };
      for (let i = 0; i < url.length && c < limit; i++) {
        this.setCell(row, c, url[i]!, linkStyle);
        c++;
      }
      cursor = m.index + url.length;
    }
    for (let i = cursor; i < text.length && c < limit; i++) {
      this.setCell(row, c, text[i]!, baseStyle);
      c++;
    }
  }

  clone(): CellGrid {
    const g = new CellGrid(this.width, this.height);
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const src = this.cells[r]![c]!;
        g.cells[r]![c] = { char: src.char, style: { ...src.style } };
      }
    }
    return g;
  }
}

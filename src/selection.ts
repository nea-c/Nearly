export interface SelectionSnapshot {
  selected: string[];
  focus: string;
  anchor?: string;
}
export class FileSelection {
  private key = "";
  private items: string[] = [];
  private chosen = new Set<string>();
  private anchor = 0;
  focus = "";
  snapshot(): SelectionSnapshot {
    return {
      selected: this.values(),
      focus: this.focus,
      ...(this.items[this.anchor] !== undefined
        ? { anchor: this.items[this.anchor] }
        : {}),
    };
  }
  restore(key: string, items: string[], state: SelectionSnapshot) {
    this.context(key, items);
    this.chosen = new Set(
      state.selected.filter((name) => items.includes(name)),
    );
    this.focus = items.includes(state.focus) ? state.focus : (items[0] ?? "");
    this.anchor = Math.max(0, items.indexOf(state.anchor ?? ""));
  }
  context(key: string, items?: string[]) {
    if (this.key !== key) {
      this.key = key;
      this.chosen.clear();
      this.anchor = 0;
      this.focus = "";
      this.items = [];
    }
    if (items === undefined) return;
    const anchorName = this.items[this.anchor];
    this.items = [...items];
    this.anchor = Math.max(0, items.indexOf(anchorName));
    this.chosen = new Set(
      [...this.chosen].filter((name) => items.includes(name)),
    );
    if (!items.includes(this.focus)) this.focus = items[0] ?? "";
  }
  click(
    index: number,
    { ctrl = false, shift = false }: { ctrl?: boolean; shift?: boolean } = {},
  ) {
    if (index < 0 || index >= this.items.length) return;
    if (shift) {
      const range = this.items.slice(
        Math.min(this.anchor, index),
        Math.max(this.anchor, index) + 1,
      );
      this.chosen = new Set(ctrl ? [...this.chosen, ...range] : range);
    } else {
      this.anchor = index;
      const name = this.items[index];
      if (ctrl) {
        if (this.chosen.has(name)) this.chosen.delete(name);
        else this.chosen.add(name);
      } else this.chosen = new Set([name]);
    }
    this.focus = this.items[index];
  }
  has(name: string) {
    return this.chosen.has(name);
  }
  clickName(name: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}) {
    this.click(this.items.indexOf(name), modifiers);
  }
  values() {
    return this.items.filter((name) => this.chosen.has(name));
  }
  all() {
    this.chosen = new Set(this.items);
  }
  clear() {
    this.chosen.clear();
  }
  rectangle(names: string[], base: string[] = []) {
    this.chosen = new Set(
      [...base, ...names].filter((name) => this.items.includes(name)),
    );
  }
}

const collator = new Intl.Collator("ja", {
  numeric: true,
  sensitivity: "base",
});

const prefixRank = (name: string) =>
  name.startsWith(".") ? 0 : name.startsWith("_") ? 1 : 2;

// Rank whole groups so punctuation between dot and underscore cannot form cycles.
export function compareNames(left: string, right: string): number {
  return prefixRank(left) - prefixRank(right) || collator.compare(left, right);
}

// Deliberately broken demo starting point: matching is case-sensitive.
// Codex repairs this source after the first real ProofLoop verification fails.
export function filterItems(items, query) {
  return items.filter((item) => item.includes(query));
}

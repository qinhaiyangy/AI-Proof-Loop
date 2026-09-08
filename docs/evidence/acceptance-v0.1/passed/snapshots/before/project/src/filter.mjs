// Repaired by Codex after the first real ProofLoop failure, without changing checks.
// Scope: string arrays and JavaScript's Unicode lowercase substring semantics.
export function filterItems(items, query) {
  const normalizedQuery = query.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(normalizedQuery));
}

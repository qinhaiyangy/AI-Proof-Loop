import assert from "node:assert/strict";
import { filterItems } from "../src/filter.mjs";

// Fixed acceptance cases. This script executes the source, not recorded results.
const cases = {
  "case-insensitive": () => {
    assert.deepEqual(filterItems(["Alpha", "BETA", "alphabet"], "ALP"), ["Alpha", "alphabet"]);
  },
  "empty-query": () => {
    assert.deepEqual(filterItems(["Alpha", "BETA", "alphabet"], ""), ["Alpha", "BETA", "alphabet"]);
  },
  "no-match": () => {
    assert.deepEqual(filterItems(["Alpha", "BETA", "alphabet"], "missing"), []);
  },
};

const checkId = process.argv[2];
if (!Object.hasOwn(cases, checkId)) {
  throw new Error(`Unknown acceptance check: ${checkId ?? "(missing)"}`);
}
cases[checkId]();
console.log(`Acceptance check passed: ${checkId}`);

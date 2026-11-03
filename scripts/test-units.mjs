// Unit tests for pure front-end logic that needs no browser and no database.
// Run: npm run test:unit
import { pageAll, PAGE } from "../src/data/page.js";

let fails = 0;
const ok = async (name, fn) => {
  try {
    await fn();
    console.log("  pass  " + name);
  } catch (e) {
    fails++;
    console.log("  FAIL  " + name + " - " + (e.message || e));
  }
};
const eq = (a, b, what) => {
  if (String(a) !== String(b)) throw new Error(`${what}: expected ${b}, got ${a}`);
};

// A stand-in for PostgREST: holds `rows`, but never returns more than `maxRows`
// in one response, and reports the true total as `count`.
function server(total, { maxRows = PAGE, withCount = true, rows } = {}) {
  const data = rows ?? Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls = [];
  return {
    calls,
    make: () => ({
      range(from, to) {
        calls.push([from, to]);
        const n = Math.min(to - from + 1, maxRows);
        return Promise.resolve({
          data: data.slice(from, from + n),
          error: null,
          count: withCount ? data.length : null,
        });
      },
    }),
  };
}

console.log("Paging reads the whole table");

await ok("a short table is one request", async () => {
  const s = server(12);
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 12, "rows");
  eq(total, 12, "total");
  eq(s.calls.length, 1, "requests");
});

await ok("an empty table is not an error", async () => {
  const { rows, total } = await pageAll(server(0).make);
  eq(rows.length, 0, "rows");
  eq(total, 0, "total");
});

// The actual bug this fixes: 1001 products, only 1000 ever reached the app.
await ok("1001 rows past a 1000 cap are all returned", async () => {
  const { rows, total } = await pageAll(server(1001).make);
  eq(rows.length, 1001, "rows");
  eq(total, 1001, "total");
  eq(rows[1000].id, 1000, "last row");
});

await ok("2500 rows come back in order with no gaps or repeats", async () => {
  const s = server(2500);
  const { rows } = await pageAll(s.make);
  eq(rows.length, 2500, "rows");
  eq(new Set(rows.map((r) => r.id)).size, 2500, "distinct rows");
  eq(
    rows.every((r, i) => r.id === i),
    true,
    "order preserved",
  );
  eq(JSON.stringify(s.calls), JSON.stringify([[0, 999], [1000, 1999], [2000, 2999]]), "ranges");
});

await ok("a row count that is an exact multiple of the page size terminates", async () => {
  const s = server(2000);
  const { rows } = await pageAll(s.make);
  eq(rows.length, 2000, "rows");
  eq(s.calls.length, 2, "requests"); // must not ask for a third empty page
});

// A project whose Max rows is set below 1000 would make naive paging stop on
// the first short page and silently lose the rest.
await ok("a server cap smaller than the page size still returns everything", async () => {
  const s = server(1200, { maxRows: 400 });
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 1200, "rows");
  eq(total, 1200, "total");
  eq(s.calls.length, 3, "requests");
});

console.log("Caps and truncation");

await ok("a cap stops the read but still reports the true total", async () => {
  const s = server(5000);
  const { rows, total } = await pageAll(s.make, 50);
  eq(rows.length, 50, "rows");
  eq(total, 5000, "total");
  eq(s.calls.length, 1, "requests");
  eq(rows.length < total, true, "truncation is detectable");
});

await ok("a cap above the table size is not truncation", async () => {
  const { rows, total } = await pageAll(server(30).make, 10000);
  eq(rows.length, 30, "rows");
  eq(rows.length < total, false, "not truncated");
});

await ok("a cap that is not a page multiple asks for exactly the cap", async () => {
  const s = server(5000);
  const { rows } = await pageAll(s.make, 1500);
  eq(rows.length, 1500, "rows");
  eq(JSON.stringify(s.calls), JSON.stringify([[0, 999], [1000, 1499]]), "ranges");
});

console.log("Failure modes");

await ok("without a count it stops on a short page", async () => {
  const s = server(1500, { withCount: false });
  const { rows, total } = await pageAll(s.make);
  eq(rows.length, 1500, "rows");
  eq(total, 1500, "total falls back to what was read");
});

await ok("an error is mapped and thrown, not returned", async () => {
  const make = () => ({ range: () => Promise.resolve({ data: null, error: { message: "boom" } }) });
  let caught;
  try {
    await pageAll(make, Infinity, (e) => new Error("mapped: " + e.message));
  } catch (e) {
    caught = e;
  }
  eq(caught?.message, "mapped: boom", "thrown error");
});

await ok("a server that never satisfies its own count still terminates", async () => {
  // count says there is far more than the server ever hands over.
  const make = () => ({
    range: (from, to) =>
      Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
        error: null,
        count: 1e9,
      }),
  });
  const { rows } = await pageAll(make);
  eq(rows.length, 500 * PAGE, "stops at the guard instead of looping for ever");
});

console.log(fails ? `\n${fails} FAILED` : "\nAll unit checks passed");
process.exit(fails ? 1 : 0);

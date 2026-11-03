// Reading a whole table through PostgREST, in pages.
//
// PostgREST never returns more rows than the project's "Max rows" setting
// (1000 by default) but does report the true total, so a plain select quietly
// returns a prefix of the table. Keep asking with .range() until the reported
// total is in hand.
//
// Kept free of Supabase and Vite imports so it can be unit-tested in plain Node.
export const PAGE = 1000;

// `make`      builds a fresh query per page - a Supabase builder is single-use.
//             The query must request { count: "exact" } and sort on something
//             unique, or pages can repeat or skip rows.
// `cap`       stop after this many rows (the total still reports what exists).
// `mapError`  wraps a PostgREST error before it is thrown.
export async function pageAll(make, cap = Infinity, mapError = (e) => e) {
  const out = [];
  let total = null;
  for (let guard = 0; guard < 500 && out.length < cap; guard++) {
    const want = Math.min(PAGE, cap - out.length),
      { data, error, count } = await make().range(out.length, out.length + want - 1);
    if (error) throw mapError(error);
    if (count != null) total = count;
    if (!data || !data.length) break;
    out.push(...data);
    // With a count we advance by whatever the server actually gave us, so a
    // project cap smaller than PAGE just costs extra round trips. Without one,
    // a short page is the only end-of-table signal available.
    if (total != null ? out.length >= total : data.length < want) break;
  }
  return { rows: out, total: total ?? out.length };
}

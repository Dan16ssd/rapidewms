// Which backup files to keep, and therefore which to delete.
//
// Kept separate from backup.mjs and unit-tested, because a mistake here throws
// away the only copy of a shop's data and nobody finds out until it is needed.
//
// Every backup for a fortnight, then one a week for ten weeks, then one a month
// for a year, then one a year for ever. Corruption and mistaken deletions are
// often noticed weeks after the fact, so a single bad night cannot roll off the
// end; and because Lao tax invoices must be kept for ten years, the oldest copy
// of each year is never thrown away.

const DAY = 864e5;

// Filenames look like rapidewms-2026-11-03T23-40-12Z.ndjson.gz
export function backupDate(name) {
  const m = /^rapidewms-(.+)\.ndjson\.gz$/.exec(name);
  if (!m) return null;
  const d = new Date(m[1].replace(/-(\d\d)-(\d\d)Z$/, ":$1:$2Z"));
  return isNaN(d) ? null : d;
}

export function toKeep(names, now = new Date(), minimum = 3) {
  const files = names
    .map((f) => ({ f, d: backupDate(f) }))
    .filter((x) => x.d)
    .sort((a, b) => b.d - a.d);

  // Never prune down to nothing, however old everything is.
  const keep = new Set(files.slice(0, minimum).map((x) => x.f)),
    seen = { w: new Set(), m: new Set(), y: new Set() },
    first = (bucket, key) => !seen[bucket].has(key) && seen[bucket].add(key),
    week = (d) => `${d.getUTCFullYear()}-${Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * DAY))}`;

  // Newest first, so the first file seen in a week/month/year is its newest.
  for (const { f, d } of files) {
    const age = (now - d) / DAY;
    if (age <= 14) keep.add(f);
    else if (age <= 70 && first("w", week(d))) keep.add(f);
    else if (age <= 400 && first("m", d.toISOString().slice(0, 7))) keep.add(f);
    else if (first("y", d.getUTCFullYear())) keep.add(f);
  }
  return keep;
}

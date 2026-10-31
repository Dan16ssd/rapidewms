import { E } from "../lib/util.js";
import { isOwner, configured } from "../data/store.js";

export default function sys(s) {
  const until = new Date(s.shop.plan_until),
    days = Math.ceil((until - Date.now()) / 864e5);
  return `<div class="card"><h3>Shop</h3><p class="mt"><b>${E(s.shop.name)}</b></p><p class="mut">Signed in as ${E(s.user.email)} (${
    s.role == "owner" ? "owner" : "staff"
  })</p><p class="plan mt ${days <= 0 ? "expired" : ""}">${
    days > 0
      ? `${s.shop.plan == "paid" ? "Paid plan" : "Free trial"}: ${days} day${days == 1 ? "" : "s"} left (until ${until.toLocaleDateString()})`
      : "Your plan has expired. Your data is safe but read-only until you renew."
  }</p>${
    configured
      ? `<div class="row mt"><button class="g" data-act="signOut">Sign out</button></div>`
      : `<p class="mut mt">Local demo mode: no account, data is saved only in this browser. Add Supabase keys to <code>.env</code> for real accounts and sync.</p>`
  }</div>
<div class="card"><h3>Backup &amp; import</h3><div class="row mt"><button class="g" data-act="zip">Download full backup (.zip)</button><label class="g">Import products (CSV)<input type="file" accept=".csv" hidden data-input="importCsv"></label>${
    isOwner() ? `<button class="g" data-act="erase">Erase all data</button>` : ""
  }</div><p class="mut mt">CSV columns (first row = headers): sku, name, category, qty, min, cost. An Inventory CSV exported from this app also works. Existing SKUs are skipped.</p></div>`;
}

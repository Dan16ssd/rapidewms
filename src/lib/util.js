// HTML-escape any value before putting it into markup or an attribute.
export const E = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

export const $ = (s) => document.querySelector(s);

export const fmt = (n) =>
  "₭" +
  (+n || 0).toLocaleString("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const dt = (t) => (t ? new Date(t).toLocaleString() : "");

export const num = (n) => (+n || 0).toLocaleString("en");

let toastTimer;
export function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), bad ? 5000 : 2500);
}

// Promise-based modal form. fields: [{k, label, type, value}]
export function form(title, fields, okLabel = "Save") {
  const dlg = $("#dlg");
  dlg.innerHTML = `<form method="dialog"><h3>${E(title)}</h3><div class="mt">${fields
    .map(
      (f) =>
        `<label>${E(f.label)}<input name="${E(f.k)}" type="${f.type || "text"}" value="${E(f.value)}"${
          f.type == "number" ? ' step="any" min="0"' : ""
        }${f.required ? " required" : ""}></label>`,
    )
    .join("")}</div><div class="row"><button class="b" value="ok">${E(okLabel)}</button><button class="g" value="cancel" formnovalidate>Cancel</button></div></form>`;
  dlg.showModal();
  dlg.querySelector("input")?.focus();
  return new Promise((res) =>
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue != "ok") return res(null);
        res(Object.fromEntries(new FormData(dlg.querySelector("form"))));
      },
      { once: true },
    ),
  );
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

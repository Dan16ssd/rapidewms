// Sign in / sign up / password reset / first-shop screens.
import { $, E } from "./lib/util.js";
import { t, errText } from "./i18n/index.js";
import { sb, configured, createShop, joinShop, signOut } from "./data/store.js";

const shell = (inner) => {
  $("#app").hidden = true;
  $("#auth").hidden = false;
  $("#auth").innerHTML = `<div class="auth"><div class="brand" style="margin-bottom:18px"><h1>RAPIDÉ<em>WMS</em></h1></div>${inner}</div>`;
};

// Where the reset email sends the user back to. BASE_URL keeps this right under
// a sub-path deploy (GitHub Pages serves the app from /rapidewms/).
const appUrl = () => location.origin + import.meta.env.BASE_URL;

// Disable the submit button, clear the error line, run fn, re-enable. Returns
// the Supabase error message, or "" on success.
async function submit(formEl, errEl, fn) {
  const btn = formEl.querySelector(".b");
  btn.disabled = true;
  $(errEl).textContent = "";
  try {
    const { error } = await fn(Object.fromEntries(new FormData(formEl)));
    // Auth provider messages come back in English; show them as given.
    if (error) $(errEl).textContent = error.message;
    return error ? error.message : "";
  } catch (e) {
    $(errEl).textContent = errText(e);
    return errText(e);
  } finally {
    btn.disabled = false;
  }
}

export function showAuth(mode = "in", note = "") {
  const up = mode == "up";
  shell(`<form class="card" id="authf"><h2>${t(up ? "auth.createAcct" : "auth.signIn")}</h2><p class="mut">${t(
    up ? "auth.trialNote" : "auth.tagline",
  )}</p><label>${t("auth.email")}<input name="email" type="email" autocomplete="email" required></label><label>${t(
    "auth.password",
  )}<input name="password" type="password" minlength="8" autocomplete="${
    up ? "new-password" : "current-password"
  }" required></label>${
    up
      ? ""
      : `<p class="mut" style="margin-top:-4px"><button type="button" class="switch" id="aforgot">${t(
          "auth.forgot",
        )}</button></p>`
  }${note ? `<p class="mut">${E(note)}</p>` : ""}<p class="err" id="aerr"></p><button class="b" style="width:100%;justify-content:center">${t(
    up ? "auth.createAcct" : "auth.signIn",
  )}</button><p class="mut">${t(up ? "auth.have" : "auth.new")} <button type="button" class="switch" id="aswitch">${t(
    up ? "auth.toSignIn" : "auth.toSignUp",
  )}</button></p></form>`);
  $("#aswitch").onclick = () => showAuth(up ? "in" : "up");
  if (!up) $("#aforgot").onclick = () => showReset();
  $("#authf").onsubmit = async (ev) => {
    ev.preventDefault();
    let data;
    const msg = await submit(ev.target, "#aerr", async (f) => {
      const r = up
        ? await sb.auth.signUp({ email: f.email, password: f.password })
        : await sb.auth.signInWithPassword({ email: f.email, password: f.password });
      data = r.data;
      return r;
    });
    // With email confirmation on, sign-up returns no session yet.
    if (!msg && up && !data.session) showAuth("in", t("auth.confirmEmail"));
    // otherwise onAuthStateChange in main.js takes over
  };
}

// Step 1 of recovery: ask Supabase to email a reset link.
export function showReset() {
  shell(`<form class="card" id="resetf"><h2>${t("auth.resetTitle")}</h2><p class="mut">${t(
    "auth.resetNote",
  )}</p><label>${t(
    "auth.email",
  )}<input name="email" type="email" autocomplete="email" required></label><p class="err" id="rerr"></p><button class="b" style="width:100%;justify-content:center">${t(
    "auth.resetSend",
  )}</button><p class="mut"><button type="button" class="switch" id="rback">${t(
    "auth.backToSignIn",
  )}</button></p></form>`);
  $("#rback").onclick = () => showAuth("in");
  $("#resetf").onsubmit = async (ev) => {
    ev.preventDefault();
    // Supabase deliberately reports success for an unknown address, so this
    // never reveals whether an email is registered.
    const msg = await submit(ev.target, "#rerr", (f) =>
      sb.auth.resetPasswordForEmail(f.email, { redirectTo: appUrl() }),
    );
    if (!msg) showAuth("in", t("auth.resetSent"));
  };
}

// Step 2: the link came back with a recovery session, so set the new password.
export function showNewPassword(onDone) {
  shell(`<form class="card" id="newpf"><h2>${t("auth.newTitle")}</h2><p class="mut">${t(
    "auth.newNote",
  )}</p><label>${t(
    "auth.newPassword",
  )}<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><p class="err" id="nerr"></p><button class="b" style="width:100%;justify-content:center">${t(
    "auth.newSave",
  )}</button></form>`);
  $("#newpf").onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = await submit(ev.target, "#nerr", (f) => sb.auth.updateUser({ password: f.password }));
    if (!msg) onDone();
  };
}

// After sign-up: start a new shop, or join one with the code the owner made.
export function showCreateShop(onDone) {
  const btn = (k) => `<button class="b" style="width:100%;justify-content:center">${t(k)}</button>`;
  shell(`${
    configured
      ? `<form class="card" id="joinf"><h2>${t("auth.joinTitle")}</h2><p class="mut">${t(
          "auth.joinNote",
        )}</p><label>${t(
          "auth.joinCode",
        )}<input name="code" required maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345"></label><p class="err" id="jerr"></p>${btn(
          "auth.join",
        )}</form>`
      : ""
  }<form class="card" id="shopf"><h2>${t(configured ? "auth.orNew" : "auth.nameShop")}</h2><p class="mut">${t(
    "auth.staffLater",
  )}</p><label>${t("auth.shopName")}<input name="name" required maxlength="80"></label><p class="err" id="serr"></p>${btn(
    "auth.startTrial",
  )}${
    configured
      ? `<p class="mut"><button type="button" class="switch" id="sout">${t("sys.signOut")}</button></p>`
      : `<p class="mut">${t("auth.localNote")}</p>`
  }</form>`);
  const go = (id, errId, fn) =>
    ($(id).onsubmit = async (ev) => {
      ev.preventDefault();
      const b = ev.target.querySelector(".b");
      b.disabled = true;
      $(errId).textContent = "";
      try {
        await fn(new FormData(ev.target));
        onDone();
      } catch (e) {
        $(errId).textContent = errText(e);
        b.disabled = false;
      }
    });
  if (configured) {
    $("#sout").onclick = () => signOut();
    go("#joinf", "#jerr", (f) => joinShop(f.get("code")));
  }
  go("#shopf", "#serr", (f) => createShop(f.get("name")));
}

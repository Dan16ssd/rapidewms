// Sign in / sign up / first-shop screens.
import { $, E } from "./lib/util.js";
import { sb, configured, createShop, signOut } from "./data/store.js";

const shell = (inner) => {
  $("#app").hidden = true;
  $("#auth").hidden = false;
  $("#auth").innerHTML = `<div class="auth"><div class="brand" style="margin-bottom:18px"><h1>RAPIDÉ<em>WMS</em></h1></div>${inner}</div>`;
};

export function showAuth(mode = "in", note = "") {
  const up = mode == "up";
  shell(`<form class="card" id="authf"><h2>${up ? "Create your account" : "Sign in"}</h2><p class="mut">${
    up ? "14-day free trial. No card needed." : "Inventory for your shop, on every device."
  }</p><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" minlength="8" autocomplete="${
    up ? "new-password" : "current-password"
  }" required></label>${note ? `<p class="mut">${E(note)}</p>` : ""}<p class="err" id="aerr"></p><button class="b" style="width:100%;justify-content:center">${
    up ? "Create account" : "Sign in"
  }</button><p class="mut">${up ? "Already have an account?" : "New here?"} <button type="button" class="switch" id="aswitch">${
    up ? "Sign in" : "Create an account"
  }</button></p></form>`);
  $("#aswitch").onclick = () => showAuth(up ? "in" : "up");
  $("#authf").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target)),
      btn = ev.target.querySelector(".b");
    btn.disabled = true;
    $("#aerr").textContent = "";
    const { data, error } = up
      ? await sb.auth.signUp({ email: f.email, password: f.password })
      : await sb.auth.signInWithPassword({ email: f.email, password: f.password });
    btn.disabled = false;
    if (error) return ($("#aerr").textContent = error.message);
    // With email confirmation on, sign-up returns no session yet.
    if (up && !data.session) showAuth("in", "Check your email to confirm your account, then sign in.");
    // otherwise onAuthStateChange in main.js takes over
  };
}

export function showCreateShop(onDone) {
  shell(`<form class="card" id="shopf"><h2>Name your shop</h2><p class="mut">You can invite staff later.</p><label>Shop name<input name="name" required maxlength="80"></label><p class="err" id="serr"></p><button class="b" style="width:100%;justify-content:center">Start free trial</button>${
    configured
      ? `<p class="mut"><button type="button" class="switch" id="sout">Sign out</button></p>`
      : `<p class="mut">Local demo mode: data stays in this browser.</p>`
  }</form>`);
  if (configured) $("#sout").onclick = () => signOut();
  $("#shopf").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector(".b");
    btn.disabled = true;
    try {
      await createShop(new FormData(ev.target).get("name"));
      onDone();
    } catch (e) {
      $("#serr").textContent = e.message;
      btn.disabled = false;
    }
  };
}

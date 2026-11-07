// Picks the backend: Supabase when .env has keys, otherwise the local
// in-browser demo. Both expose the same functions.
import * as remote from "./remote.js";
import * as local from "./local.js";
import { state, emit } from "./state.js";

export * from "./state.js";
export const configured = remote.configured;
export const sb = remote.sb;

const B = configured ? remote : local;
export const {
  signOut,
  myShops,
  createShop,
  openShop,
  reload,
  saveItem,
  deleteItem,
  adjust,
  writeOffLot,
  createSale,
  voidSale,
  importItems,
  addOrder,
  completeOrder,
  deleteOrder,
  setSetting,
  eraseAll,
} = B;

addEventListener("online", () => {
  state.online = true;
  if (state.shop) reload().catch(() => {});
});
addEventListener("offline", () => {
  state.online = false;
  emit();
});

// Work done on this device that the server doesn't have yet: sales, voids,
// stock changes and write-offs. Each piece is stored before it is sent, so a
// connection that drops mid-call loses nothing, and it is sent again until
// the server has it. The server skips anything it already has (every piece
// carries the id this device gave it), so sending twice is harmless.
//
// A record: { id, shop, op, args, at, seq, offline }
//   op       "sale" | "void" | "adjust" | "writeoff"
//   at       when it happened on this device: the server files it at that time
//   offline  true once the work has been accepted here without the server
//            (it happened, so the server must not refuse it for stock)
import * as C from "./cache.js";

let seq = 0;
const order = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq);

export const pending = async (shop) => (await C.all("queue")).filter((r) => r.shop == shop).sort(order);
export const failed = async (shop) => (await C.all("failed")).filter((r) => r.shop == shop).sort(order);

export function record(shop, op, args, id = crypto.randomUUID()) {
  return { id, shop, op, args, at: new Date().toISOString(), seq: Date.now() * 1000 + (seq++ % 1000), offline: false };
}
export const add = (rec) => C.put("queue", rec.id, rec);
export const remove = (id) => C.del("queue", id);

/** Put refused work back in the queue, to be sent again. */
export async function retry(id) {
  const r = (await C.all("failed")).find((x) => x.id == id);
  if (!r) return;
  delete r.error;
  await C.put("queue", r.id, r);
  await C.del("failed", r.id);
}
export const discard = (id) => C.del("failed", id);

// One sender at a time: in this tab by chaining, across tabs with a lock.
let chain = Promise.resolve();
const locked = (fn) =>
  typeof navigator != "undefined" && navigator.locks ? navigator.locks.request("rapidewms-sync", fn) : fn();

/**
 * Send this shop's queue in the order it happened.
 *   send(rec)   performs one record on the server; throws on failure
 *   isNet(e)    true when the failure is "no connection" (try again later)
 *   freshId     the record the person is waiting on right now: if the server
 *               refuses it, the error goes back to them instead of the
 *               "couldn't send" list
 * Stops at the first connection failure; everything still queued is then
 * marked offline. Returns { sent (records), stopped, freshError }.
 */
export function flush(shop, send, isNet, freshId = null) {
  const run = async () => {
    const out = { sent: [], stopped: false, freshError: null };
    const list = await pending(shop);
    for (const [i, rec] of list.entries()) {
      try {
        await send(rec);
        await remove(rec.id);
        out.sent.push(rec);
      } catch (e) {
        if (isNet(e)) {
          out.stopped = true;
          for (const r of list.slice(i)) if (!r.offline) await C.put("queue", r.id, { ...r, offline: true });
          break;
        }
        await remove(rec.id);
        if (rec.id == freshId && !rec.offline) out.freshError = e;
        else
          await C.put("failed", rec.id, {
            ...rec,
            error: { code: e.code || null, params: e.params || null, message: e.message || String(e) },
          });
      }
    }
    return out;
  };
  const p = chain.then(() => locked(run));
  chain = p.catch(() => {});
  return p;
}

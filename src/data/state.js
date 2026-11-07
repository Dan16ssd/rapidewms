// Shared in-memory state for the current shop, used by both backends.
export const state = {
  user: null, // { id, email }
  shop: null, // { id, name, plan, plan_until }
  role: null, // 'owner' | 'staff'
  settings: { low_alert: true, auto_reorder: false },
  items: [],
  orders: [],
  movements: [], // last 30 days
  lots: [], // units per expiry date, all of them
  sales: [], // last 30 days
  saleLines: [], // lines of those sales
  truncated: false, // true when the server held back older orders/movements
  online: navigator.onLine,
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const emit = () => listeners.forEach((fn) => fn());

export const canWrite = () => !!state.shop && new Date(state.shop.plan_until) > new Date();
export const isOwner = () => state.role == "owner";

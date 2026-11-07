-- 003: selling and stock work with no internet, sent when the network returns.
--
-- Each device keeps a queue of what it did offline and sends it later, one
-- piece at a time, in the order it happened. This migration makes that safe:
--
-- * Sending twice changes nothing. Every queued piece carries the id the
--   device gave it (sales already had client_id; stock changes now record
--   theirs in applied_ops).
-- * Work keeps its real time. Sales, their lines and stock movements take the
--   device's time (p_at), so history from several tills falls into the order
--   it happened. synced_at says when it reached the server.
-- * A sale made offline is never refused for stock. The customer has already
--   left with the goods, so the sale is kept, stock may go below zero, and the
--   sale is flagged 'short' for the owner to recount. Online sales are still
--   refused below zero, exactly as before.
-- * Receipt numbers exist offline. Each device registers once as a till
--   (A, B, C...) and numbers its own receipts A-0001, A-0002..., so two tills
--   offline together never hand out the same number.

-- ---------- columns ----------

-- Negative stock is now a flagged state (offline sales that found the stock
-- already gone), not an impossible one. Only offline replays can cause it.
alter table public.items drop constraint items_qty_check;

alter table public.sales
  add column till      text,
  add column till_no   integer,
  add column flags     text[] not null default '{}',
  add column synced_at timestamptz not null default now();
create unique index sales_till_no_uidx on public.sales (shop_id, till, till_no) where till is not null;

-- ---------- tables ----------

create table public.tills (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  code       text not null check (code ~ '^[A-Z]{1,2}$'),
  name       text not null default '',
  last_no    integer not null default 0,  -- highest receipt number seen from it
  created_at timestamptz not null default now(),
  unique (shop_id, code)
);

-- Ids of stock changes already applied, so a resent one is skipped.
create table public.applied_ops (
  shop_id    uuid not null references public.shops on delete cascade,
  client_id  text not null check (length(client_id) >= 8),
  op         text not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, client_id)
);

alter table public.tills       enable row level security;
alter table public.applied_ops enable row level security;
create policy tills_select on public.tills for select using (public.is_member(shop_id));
revoke all on public.tills, public.applied_ops from anon, authenticated;
grant select on public.tills to authenticated;

-- ---------- the one place stock changes ----------

-- Replaces 002's version with two more parameters:
--   p_short  allow stock below zero (offline replays only)
--   p_at     when it happened on the device (default: now)
-- Dropped first so the old 5-argument form doesn't linger as an overload.
drop function public.stock_move(uuid, numeric, text, date, uuid);
create function public.stock_move(
  p_item uuid, p_delta numeric, p_note text, p_expiry date, p_sale uuid,
  p_short boolean default false, p_at timestamptz default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item    items%rowtype;
  v_qty     numeric;
  v_at      timestamptz := coalesce(p_at, now());
  v_today   date := (now() at time zone 'Asia/Vientiane')::date;
  v_left    numeric;
  v_free    numeric;
  v_take    numeric;
  v_lot     numeric;
  v_expired boolean;
  r         record;
begin
  if p_delta is null or p_delta = 0 then raise exception 'quantity must not be zero'; end if;
  -- lock the row so two devices can't both take the last unit
  select * into v_item from items where id = p_item for update;
  if not found or not public.can_write(v_item.shop_id) then
    raise exception 'item not found or shop is read-only';
  end if;
  v_qty := v_item.qty + p_delta;
  -- Only taking stock is refused: receiving into a negative count only helps.
  if v_qty < 0 and p_delta < 0 and not p_short then
    raise exception 'not enough stock: % has %', v_item.sku, v_item.qty using errcode = 'P0001';
  end if;
  update items set qty = v_qty, updated_at = now() where id = p_item;

  if p_delta > 0 then
    -- Lots never hold more than the stock: units that only fill a hole left
    -- by offline sales below zero carry no date.
    v_lot := least(p_delta, greatest(v_qty, 0));
    if p_expiry is not null and v_lot > 0 then
      insert into lots (shop_id, item_id, expiry, qty) values (v_item.shop_id, p_item, p_expiry, v_lot)
      on conflict (item_id, expiry) do update set qty = lots.qty + excluded.qty;
    end if;
    insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
    values (v_item.shop_id, p_item, v_item.sku, 'in', p_delta, coalesce(p_note, ''), p_expiry, p_sale, v_at);
  else
    v_left := -p_delta;
    select greatest(v_item.qty - coalesce(sum(qty), 0), 0) into v_free from lots where item_id = p_item;
    foreach v_expired in array array[false, true] loop
      for r in select id, expiry, qty from lots
               where item_id = p_item and (expiry < v_today) = v_expired
               order by expiry for update loop
        exit when v_left = 0;
        v_take := least(r.qty, v_left);
        if v_take = r.qty then delete from lots where id = r.id;
        else update lots set qty = qty - v_take where id = r.id; end if;
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), r.expiry, p_sale, v_at);
        v_left := v_left - v_take;
      end loop;
      -- undated stock goes between the in-date lots and the expired ones
      if not v_expired and v_left > 0 and v_free > 0 then
        v_take := least(v_free, v_left);
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), null, p_sale, v_at);
        v_left := v_left - v_take;
      end if;
    end loop;
    if v_left > 0 then
      -- Stock that wasn't there: an offline sale below zero (or lots out of step).
      insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
      values (v_item.shop_id, p_item, v_item.sku, 'out', v_left, coalesce(p_note, ''), null, p_sale, v_at);
    end if;
  end if;

  perform public.auto_reorder(p_item);
  return v_qty;
end $$;

-- The device's time, kept unless it is clearly wrong: more than 5 minutes in
-- the future becomes now. Either way the caller learns whether to flag it.
create or replace function public.device_time(p_at timestamptz, out v_at timestamptz, out v_bad boolean)
language sql stable as $$
  select case when p_at is null or p_at > now() + interval '5 minutes' then now() else p_at end,
         p_at is not null and (p_at > now() + interval '5 minutes' or p_at < now() - interval '30 days')
$$;

-- Record a queued id; false when it was already applied.
create or replace function public.first_time(p_shop uuid, p_client_id text, p_op text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_client_id is null or length(p_client_id) < 8 then raise exception 'missing client id'; end if;
  insert into applied_ops (shop_id, client_id, op) values (p_shop, p_client_id, p_op)
  on conflict do nothing;
  return found;
end $$;

-- ---------- tills ----------

-- A device becomes till A, B, ... Z, then AA, AB ... for this shop.
create or replace function public.register_till(p_shop uuid, p_name text default '')
returns text language plpgsql security definer set search_path = public as $$
declare v_n integer; v_code text;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  -- one registration at a time per shop, so two devices can't get the same letter
  perform 1 from shops where id = p_shop for update;
  select count(*) into v_n from tills where shop_id = p_shop;
  v_code := case when v_n < 26 then chr(65 + v_n)
                 else chr(65 + (v_n / 26) - 1) || chr(65 + v_n % 26) end;
  insert into tills (shop_id, code, name) values (p_shop, v_code, left(coalesce(p_name, ''), 40));
  return v_code;
end $$;

-- ---------- stock changes that can be queued ----------

-- adjust_stock with the queued id and time. The 4-argument form stays for
-- set_stock, complete_order and older clients.
create or replace function public.adjust_stock(
  p_item uuid, p_delta numeric, p_note text, p_expiry date,
  p_client_id text, p_at timestamptz default null, p_offline boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_shop uuid; v_t record;
begin
  select shop_id into v_shop from items where id = p_item;
  if not found or not public.can_write(v_shop) then raise exception 'item not found or shop is read-only'; end if;
  if not public.first_time(v_shop, p_client_id, 'adjust') then
    return (select qty from items where id = p_item);
  end if;
  select * into v_t from public.device_time(p_at);
  return public.stock_move(p_item, p_delta, p_note, p_expiry, null, coalesce(p_offline, false), v_t.v_at);
end $$;

-- Write off what is left of one expiry date of a product, up to the units the
-- device saw. Keyed by product and date, not lot id: a lot received offline
-- has no server id yet.
create or replace function public.write_off_expiry(
  p_item uuid, p_expiry date, p_qty numeric, p_note text,
  p_client_id text, p_at timestamptz default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_item items%rowtype; v_l lots%rowtype; v_take numeric; v_t record;
begin
  select * into v_item from items where id = p_item for update;
  if not found or not public.can_write(v_item.shop_id) then
    raise exception 'item not found or shop is read-only';
  end if;
  if not public.first_time(v_item.shop_id, p_client_id, 'write_off') then return v_item.qty; end if;
  select * into v_l from lots where item_id = p_item and expiry = p_expiry for update;
  -- Already gone (sold or written off on another till): nothing left to remove.
  if not found then return v_item.qty; end if;
  v_take := least(v_l.qty, coalesce(p_qty, v_l.qty));
  if v_take <= 0 then return v_item.qty; end if;
  select * into v_t from public.device_time(p_at);
  if v_take = v_l.qty then delete from lots where id = v_l.id;
  else update lots set qty = qty - v_take where id = v_l.id; end if;
  update items set qty = qty - v_take, updated_at = now() where id = p_item;
  insert into movements (shop_id, item_id, sku, type, qty, note, expiry, created_at)
  values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, 'expired'), p_expiry, v_t.v_at);
  perform public.auto_reorder(p_item);
  return v_item.qty - v_take;
end $$;

-- ---------- the till ----------

-- Replaces 002's create_sale. New, all optional:
--   p_at       when it was sold on the device
--   p_till / p_till_no   the receipt number printed on the device (A-0042)
--   p_offline  the sale already happened with no internet: use the prices
--              on the customer's receipt (flag 'price_changed' if they are
--              not today's) and never refuse it for stock (flag 'short').
-- Lines: [{"item_id": "...", "qty": 2, "price": 5000}]. "price" is only read
-- for offline sales; online sales are priced here, as before.
drop function public.create_sale(uuid, text, jsonb, numeric, text, numeric);
create function public.create_sale(
  p_shop uuid, p_client_id text, p_lines jsonb,
  p_discount numeric default 0, p_method text default 'cash', p_paid numeric default 0,
  p_at timestamptz default null, p_till text default null, p_till_no integer default null,
  p_offline boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_sale  uuid;
  v_no    integer;
  v_sub   numeric := 0;
  v_total numeric;
  v_disc  numeric := coalesce(p_discount, 0);
  v_paid  numeric := coalesce(p_paid, 0);
  v_off   boolean := coalesce(p_offline, false);
  v_item  items%rowtype;
  v_price numeric;
  v_ws    boolean;
  v_flags text[] := '{}';
  v_t     record;
  r       record;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  select id into v_sale from sales where shop_id = p_shop and client_id = p_client_id;
  if found then return v_sale; end if;
  if p_method not in ('cash', 'transfer') then raise exception 'unknown payment method'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the sale has no products';
  end if;
  if p_till is not null then
    update tills set last_no = greatest(last_no, coalesce(p_till_no, 0))
    where shop_id = p_shop and code = p_till;
    if not found then raise exception 'unknown till: %', p_till; end if;
  end if;
  select * into v_t from public.device_time(p_at);
  if v_t.v_bad then v_flags := v_flags || 'clock'::text; end if;

  update shops set receipt_seq = receipt_seq + 1 where id = p_shop returning receipt_seq into v_no;
  insert into sales (shop_id, client_id, receipt_no, method, till, till_no, created_at)
  values (p_shop, p_client_id, v_no, p_method, p_till, p_till_no, v_t.v_at) returning id into v_sale;

  -- Same product on two lines becomes one; sorting by id means two tills
  -- selling the same products lock them in the same order and can't deadlock.
  for r in select (l->>'item_id')::uuid item_id, sum((l->>'qty')::numeric) qty,
                  max((l->>'price')::numeric) price
           from jsonb_array_elements(p_lines) l group by 1 order by 1 loop
    if r.qty is null or r.qty <= 0 then raise exception 'quantity must be more than zero'; end if;
    select * into v_item from items where id = r.item_id and shop_id = p_shop for update;
    if not found then raise exception 'item not found or shop is read-only'; end if;
    v_ws := v_item.price_wholesale > 0 and v_item.wholesale_min_qty > 0
            and r.qty >= v_item.wholesale_min_qty;
    v_price := case when v_ws then v_item.price_wholesale else v_item.price end;
    if v_off and r.price is not null and r.price >= 0 then
      if r.price <> v_price and not 'price_changed' = any(v_flags) then
        v_flags := v_flags || 'price_changed'::text;
      end if;
      v_price := r.price;
    elsif v_price <= 0 then
      raise exception 'no sell price: %', v_item.sku;
    end if;
    if v_off and v_item.qty < r.qty and not 'short' = any(v_flags) then
      v_flags := v_flags || 'short'::text;
    end if;
    perform public.stock_move(r.item_id, -r.qty, 'sale', null, v_sale, v_off, v_t.v_at);
    insert into sale_lines (shop_id, sale_id, item_id, sku, name, qty, unit_price, wholesale, line_total, created_at)
    values (p_shop, v_sale, r.item_id, v_item.sku, v_item.name, r.qty, v_price, v_ws, r.qty * v_price, v_t.v_at);
    v_sub := v_sub + r.qty * v_price;
  end loop;

  if v_disc < 0 or v_disc > v_sub then raise exception 'discount must be between 0 and the subtotal'; end if;
  v_total := v_sub - v_disc;
  if p_method = 'cash' then
    if v_paid < v_total then raise exception 'cash paid is less than the total'; end if;
  else
    v_paid := v_total;  -- a transfer is for the exact amount
  end if;
  update sales set subtotal = v_sub, discount = v_disc, total = v_total,
                   paid = v_paid, change_due = v_paid - v_total, flags = v_flags
  where id = v_sale;
  return v_sale;
end $$;

-- Void by the device's id for the sale, so a sale made offline can be voided
-- before it has a server id. Voiding one that is already void is fine here:
-- a resent void must not fail.
create or replace function public.void_sale_by_client(
  p_shop uuid, p_sale_client_id text, p_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_s sales%rowtype; v_t record; r record;
begin
  select * into v_s from sales where shop_id = p_shop and client_id = p_sale_client_id for update;
  if not found or not public.can_write(v_s.shop_id) then
    raise exception 'sale not found or shop is read-only';
  end if;
  if not public.is_owner(v_s.shop_id) then raise exception 'only the owner can void a sale'; end if;
  if v_s.status = 'void' then return; end if;
  select * into v_t from public.device_time(p_at);
  for r in select item_id, expiry, sum(qty) qty from movements
           where sale_id = v_s.id and type = 'out' and item_id is not null
           group by item_id, expiry order by item_id, expiry loop
    perform public.stock_move(r.item_id, r.qty, 'void', r.expiry, v_s.id, false, v_t.v_at);
  end loop;
  update sales set status = 'void', voided_at = v_t.v_at where id = v_s.id;
end $$;

-- Danger zone. Tills stay registered (they are devices, not data), so a
-- device keeps its letter and numbering after an erase.
create or replace function public.erase_shop_data(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can erase data'; end if;
  delete from movements   where shop_id = p_shop;
  delete from sale_lines  where shop_id = p_shop;
  delete from sales       where shop_id = p_shop;
  delete from lots        where shop_id = p_shop;
  delete from orders      where shop_id = p_shop;
  delete from items       where shop_id = p_shop;
  delete from applied_ops where shop_id = p_shop;
  update shops set receipt_seq = 0 where id = p_shop;
end $$;

-- ---------- grants ----------

revoke execute on function public.stock_move(uuid, numeric, text, date, uuid, boolean, timestamptz),
  public.first_time(uuid, text, text), public.device_time(timestamptz)
  from public, anon, authenticated;
revoke execute on function
  public.create_sale(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean),
  public.adjust_stock(uuid, numeric, text, date, text, timestamptz, boolean),
  public.write_off_expiry(uuid, date, numeric, text, text, timestamptz),
  public.void_sale_by_client(uuid, text, timestamptz),
  public.register_till(uuid, text) from public, anon;
grant execute on function
  public.create_sale(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean),
  public.adjust_stock(uuid, numeric, text, date, text, timestamptz, boolean),
  public.write_off_expiry(uuid, date, numeric, text, text, timestamptz),
  public.void_sale_by_client(uuid, text, timestamptz),
  public.register_till(uuid, text) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tills;
  end if;
end $$;

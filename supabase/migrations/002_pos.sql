-- 002: product kinds, expiry dates and the cashier (till).
--
-- * items.kind     consumable (food, drink, medicine: has an expiry date) or
--                  durable (tools, clothes, electronics: never expires).
-- * lots           how many units of an item expire on which date. Stock that
--                  arrived without a date is simply items.qty minus its lots,
--                  so the invariant is: sum(lots.qty) <= items.qty, always.
-- * sales          one row per receipt, sale_lines one per product on it.
--
-- Stock still only changes in one place, stock_move(), which now also keeps
-- the lots in step and can tie a movement to a sale.

-- ---------- columns ----------

alter table public.items add column kind text not null default 'durable'
  check (kind in ('consumable', 'durable'));

alter table public.shops add column receipt_seq integer not null default 0;

-- ---------- tables ----------

create table public.lots (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  item_id    uuid not null references public.items on delete cascade,
  expiry     date not null,
  qty        numeric not null check (qty > 0),  -- an empty lot is deleted, not kept at 0
  created_at timestamptz not null default now(),
  unique (item_id, expiry)
);
create index lots_shop_expiry_idx on public.lots (shop_id, expiry);

create table public.sales (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  -- Made by the till before it sends the sale. Sending the same sale twice
  -- (a retry after a dropped connection) returns the first one instead of
  -- selling the goods again.
  client_id  text not null check (length(client_id) >= 8),
  receipt_no integer not null,
  subtotal   numeric not null default 0 check (subtotal >= 0),
  discount   numeric not null default 0 check (discount >= 0),
  total      numeric not null default 0 check (total >= 0),
  method     text not null check (method in ('cash', 'transfer')),
  paid       numeric not null default 0 check (paid >= 0),
  change_due numeric not null default 0 check (change_due >= 0),
  status     text not null default 'paid' check (status in ('paid', 'void')),
  cashier    uuid default auth.uid(),
  created_at timestamptz not null default now(),
  voided_at  timestamptz,
  unique (shop_id, client_id),
  unique (shop_id, receipt_no)
);
create index sales_shop_idx on public.sales (shop_id, created_at desc);

create table public.sale_lines (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  sale_id    uuid not null references public.sales on delete cascade,
  item_id    uuid references public.items on delete set null,
  sku        text not null,   -- copied in, so a receipt survives the product being deleted
  name       text not null,
  qty        numeric not null check (qty > 0),
  unit_price numeric not null check (unit_price >= 0),
  wholesale  boolean not null default false,
  line_total numeric not null check (line_total >= 0),
  created_at timestamptz not null default now()
);
create index sale_lines_sale_idx on public.sale_lines (sale_id);
create index sale_lines_shop_idx on public.sale_lines (shop_id, created_at desc);

-- Which expiry date left or arrived, and which sale moved it.
alter table public.movements add column expiry  date;
alter table public.movements add column sale_id uuid references public.sales on delete set null;

-- ---------- security ----------

alter table public.lots       enable row level security;
alter table public.sales      enable row level security;
alter table public.sale_lines enable row level security;

create policy lots_select       on public.lots       for select using (public.is_member(shop_id));
create policy sales_select      on public.sales      for select using (public.is_member(shop_id));
create policy sale_lines_select on public.sale_lines for select using (public.is_member(shop_id));

-- Read-only to clients: lots, sales and lines change only through the functions below.
revoke all on public.lots, public.sales, public.sale_lines from anon, authenticated;
grant select on public.lots, public.sales, public.sale_lines to authenticated;
grant insert (kind), update (kind) on public.items to authenticated;

-- ---------- stock ----------

create or replace function public.auto_reorder(p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_item items%rowtype; v_auto boolean;
begin
  select * into v_item from items where id = p_item;
  select auto_reorder into v_auto from settings where shop_id = v_item.shop_id;
  if v_auto and v_item.qty < v_item.min_qty and not exists (
       select 1 from orders where item_id = p_item and type = 'in' and status = 'pending') then
    insert into orders (shop_id, item_id, type, qty, party, auto)
    values (v_item.shop_id, p_item, 'in', v_item.min_qty * 2 - v_item.qty, 'Auto-reorder', true);
  end if;
end $$;

-- The one place stock changes. Not callable by clients: they go through
-- adjust_stock, write_off_lot, create_sale or void_sale.
--
-- Stock leaving is taken, in this order:
--   1. lots still in date, the soonest to expire first (first-expiry-first-out)
--   2. stock that arrived with no date recorded
--   3. expired lots, last
-- Expired goods should leave through write_off_lot, not quietly through a
-- sale, so they stay on the expiry list until someone deals with them.
-- Each part leaves as its own movement row, carrying its expiry date, which is
-- what lets void_sale put every unit back into the lot it came from.
create or replace function public.stock_move(
  p_item uuid, p_delta numeric, p_note text, p_expiry date, p_sale uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item    items%rowtype;
  v_qty     numeric;
  v_today   date := (now() at time zone 'Asia/Vientiane')::date;
  v_left    numeric;
  v_free    numeric;
  v_take    numeric;
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
  if v_qty < 0 then
    raise exception 'not enough stock: % has %', v_item.sku, v_item.qty using errcode = 'P0001';
  end if;
  update items set qty = v_qty, updated_at = now() where id = p_item;

  if p_delta > 0 then
    if p_expiry is not null then
      insert into lots (shop_id, item_id, expiry, qty) values (v_item.shop_id, p_item, p_expiry, p_delta)
      on conflict (item_id, expiry) do update set qty = lots.qty + excluded.qty;
    end if;
    insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id)
    values (v_item.shop_id, p_item, v_item.sku, 'in', p_delta, coalesce(p_note, ''), p_expiry, p_sale);
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
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), r.expiry, p_sale);
        v_left := v_left - v_take;
      end loop;
      -- undated stock goes between the in-date lots and the expired ones
      if not v_expired and v_left > 0 and v_free > 0 then
        v_take := least(v_free, v_left);
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), null, p_sale);
        v_left := v_left - v_take;
      end if;
    end loop;
    if v_left > 0 then
      -- Only reachable if lots were already out of step with qty; keep the log whole anyway.
      insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id)
      values (v_item.shop_id, p_item, v_item.sku, 'out', v_left, coalesce(p_note, ''), null, p_sale);
    end if;
  end if;

  perform public.auto_reorder(p_item);
  return v_qty;
end $$;

-- Replaces 001's version. Dropped first: adding a parameter with a default
-- would otherwise create a second function and make 3-argument calls ambiguous.
drop function public.adjust_stock(uuid, numeric, text);
create function public.adjust_stock(
  p_item uuid, p_delta numeric, p_note text default '', p_expiry date default null)
returns numeric language plpgsql security definer set search_path = public as $$
begin
  return public.stock_move(p_item, p_delta, p_note, p_expiry, null);
end $$;

-- Take a whole lot out of stock: expired, damaged or recalled.
create or replace function public.write_off_lot(p_lot uuid, p_note text default 'expired')
returns numeric language plpgsql security definer set search_path = public as $$
declare v_l lots%rowtype; v_item items%rowtype;
begin
  select * into v_l from lots where id = p_lot;
  if not found or not public.can_write(v_l.shop_id) then
    raise exception 'lot not found or shop is read-only';
  end if;
  -- item first, then lot: the same lock order as stock_move
  select * into v_item from items where id = v_l.item_id for update;
  select * into v_l from lots where id = p_lot for update;
  if not found then raise exception 'lot not found or shop is read-only'; end if;
  update items set qty = qty - v_l.qty, updated_at = now() where id = v_l.item_id;
  delete from lots where id = p_lot;
  insert into movements (shop_id, item_id, sku, type, qty, note, expiry)
  values (v_l.shop_id, v_l.item_id, v_item.sku, 'out', v_l.qty, coalesce(p_note, 'expired'), v_l.expiry);
  perform public.auto_reorder(v_l.item_id);
  return v_item.qty - v_l.qty;
end $$;

-- ---------- the till ----------

-- p_lines: [{"item_id": "...", "qty": 2}, ...]. Prices are never sent by the
-- till: they are read here, so no client can sell at a price it made up. The
-- wholesale price applies once a line reaches the item's wholesale quantity.
-- The whole sale is one transaction: if any line fails, no stock moves and no
-- receipt number is used.
create or replace function public.create_sale(
  p_shop uuid, p_client_id text, p_lines jsonb,
  p_discount numeric default 0, p_method text default 'cash', p_paid numeric default 0)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_sale  uuid;
  v_no    integer;
  v_sub   numeric := 0;
  v_total numeric;
  v_disc  numeric := coalesce(p_discount, 0);
  v_paid  numeric := coalesce(p_paid, 0);
  v_item  items%rowtype;
  v_price numeric;
  v_ws    boolean;
  r       record;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  select id into v_sale from sales where shop_id = p_shop and client_id = p_client_id;
  if found then return v_sale; end if;
  if p_method not in ('cash', 'transfer') then raise exception 'unknown payment method'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the sale has no products';
  end if;

  update shops set receipt_seq = receipt_seq + 1 where id = p_shop returning receipt_seq into v_no;
  insert into sales (shop_id, client_id, receipt_no, method)
  values (p_shop, p_client_id, v_no, p_method) returning id into v_sale;

  -- Same product on two lines becomes one; sorting by id means two tills
  -- selling the same products lock them in the same order and can't deadlock.
  for r in select (l->>'item_id')::uuid item_id, sum((l->>'qty')::numeric) qty
           from jsonb_array_elements(p_lines) l group by 1 order by 1 loop
    if r.qty is null or r.qty <= 0 then raise exception 'quantity must be more than zero'; end if;
    select * into v_item from items where id = r.item_id and shop_id = p_shop;
    if not found then raise exception 'item not found or shop is read-only'; end if;
    v_ws := v_item.price_wholesale > 0 and v_item.wholesale_min_qty > 0
            and r.qty >= v_item.wholesale_min_qty;
    v_price := case when v_ws then v_item.price_wholesale else v_item.price end;
    if v_price <= 0 then raise exception 'no sell price: %', v_item.sku; end if;
    perform public.stock_move(r.item_id, -r.qty, 'sale', null, v_sale);
    insert into sale_lines (shop_id, sale_id, item_id, sku, name, qty, unit_price, wholesale, line_total)
    values (p_shop, v_sale, r.item_id, v_item.sku, v_item.name, r.qty, v_price, v_ws, r.qty * v_price);
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
                   paid = v_paid, change_due = v_paid - v_total
  where id = v_sale;
  return v_sale;
end $$;

-- Owner only. Every unit goes back into stock, into the expiry lot it left.
create or replace function public.void_sale(p_sale uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_s sales%rowtype; r record;
begin
  select * into v_s from sales where id = p_sale for update;
  if not found or not public.can_write(v_s.shop_id) then
    raise exception 'sale not found or shop is read-only';
  end if;
  if not public.is_owner(v_s.shop_id) then raise exception 'only the owner can void a sale'; end if;
  if v_s.status = 'void' then raise exception 'sale already voided'; end if;
  for r in select item_id, expiry, sum(qty) qty from movements
           where sale_id = p_sale and type = 'out' and item_id is not null
           group by item_id, expiry order by item_id, expiry loop
    perform public.stock_move(r.item_id, r.qty, 'void', r.expiry, p_sale);
  end loop;
  update sales set status = 'void', voided_at = now() where id = p_sale;
end $$;

-- Danger zone, extended to the new tables.
create or replace function public.erase_shop_data(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can erase data'; end if;
  delete from movements  where shop_id = p_shop;
  delete from sale_lines where shop_id = p_shop;
  delete from sales      where shop_id = p_shop;
  delete from lots       where shop_id = p_shop;
  delete from orders     where shop_id = p_shop;
  delete from items      where shop_id = p_shop;
  update shops set receipt_seq = 0 where id = p_shop;
end $$;

-- Supabase grants new functions to anon and authenticated by default, so the
-- internal ones are revoked by name.
revoke execute on function public.stock_move(uuid, numeric, text, date, uuid),
  public.auto_reorder(uuid) from public, anon, authenticated;
revoke execute on function public.adjust_stock(uuid, numeric, text, date),
  public.write_off_lot(uuid, text), public.void_sale(uuid),
  public.create_sale(uuid, text, jsonb, numeric, text, numeric) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text, date),
  public.write_off_lot(uuid, text), public.void_sale(uuid),
  public.create_sale(uuid, text, jsonb, numeric, text, numeric) to authenticated;

-- ---------- realtime ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.lots, public.sales, public.sale_lines;
  end if;
end $$;

-- 006: pack sizes, cost in other currencies, VAT, and expiry settings.
--
-- From the team's discussion list:
-- * Packs. Stock is always counted in the product's base unit (a can). A pack
--   ("Carton", 24 cans) has its own barcode and price; selling one carton
--   takes 24 cans from stock. items.unit names the base unit.
-- * Cost in THB / USD / CNY. items.cost stays in Kip (every report uses it);
--   cost_currency and cost_orig keep what the owner typed, converted with the
--   shop's rates (settings.rates, Kip per 1 THB / USD / CNY).
-- * VAT is inside the shelf price. settings.vat_rate (default 10, 0 = none);
--   each sale stores the VAT it includes, for the receipt and the books.
-- * Expiring price. A batch close to its date can get a lower price
--   (lots.price). The till sells that batch at that price and takes the
--   stock from that batch.
-- * settings.expiry_days: how early the app warns about a date (7, 30, 60).

-- ---------- columns ----------

alter table public.settings
  add column vat_rate    numeric not null default 10 check (vat_rate between 0 and 100),
  add column expiry_days integer not null default 30 check (expiry_days between 1 and 365),
  add column rates       jsonb   not null default '{}'::jsonb;
grant update (vat_rate, expiry_days, rates) on public.settings to authenticated;

alter table public.items
  add column unit          text    not null default '' check (length(unit) <= 20),
  add column cost_currency text    not null default 'LAK' check (cost_currency in ('LAK', 'THB', 'USD', 'CNY')),
  add column cost_orig     numeric check (cost_orig >= 0);
grant insert (unit, cost_currency, cost_orig), update (unit, cost_currency, cost_orig) on public.items to authenticated;

alter table public.lots add column price numeric check (price >= 0);

alter table public.sales
  add column vat      numeric not null default 0,
  add column vat_rate numeric not null default 0;

alter table public.sale_lines
  add column pack_id   uuid,
  add column pack_name text,
  add column pack_size numeric,
  add column pack_qty  numeric,
  add column expiry    date;

-- ---------- packs ----------

create table public.packs (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  item_id    uuid not null references public.items on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 30),
  size       numeric not null check (size > 1),
  barcode    text,
  price      numeric not null default 0 check (price >= 0),
  created_at timestamptz not null default now()
);
create index packs_item_idx on public.packs (item_id);
create unique index packs_shop_barcode_uidx on public.packs (shop_id, barcode) where barcode is not null and barcode <> '';

alter table public.packs enable row level security;
create policy packs_select on public.packs for select using (public.is_member(shop_id));
-- Packs are prices: only the owner sets them, like deleting products.
create policy packs_insert on public.packs for insert with check (
  public.is_owner(shop_id) and public.can_write(shop_id)
  and exists (select 1 from public.items i where i.id = item_id and i.shop_id = packs.shop_id));
create policy packs_update on public.packs for update
  using (public.is_owner(shop_id) and public.can_write(shop_id))
  with check (public.is_owner(shop_id) and public.can_write(shop_id));
create policy packs_delete on public.packs for delete
  using (public.is_owner(shop_id) and public.can_write(shop_id));
revoke all on public.packs from anon, authenticated;
grant select, delete on public.packs to authenticated;
grant insert (shop_id, item_id, name, size, barcode, price), update (name, size, barcode, price)
  on public.packs to authenticated;

-- ---------- stock_move: take one batch first ----------

-- 003's version plus p_first: when set, units leave that expiry date's batch
-- before the usual order (an expiring-price sale sells that batch).
drop function public.stock_move(uuid, numeric, text, date, uuid, boolean, timestamptz);
create function public.stock_move(
  p_item uuid, p_delta numeric, p_note text, p_expiry date, p_sale uuid,
  p_short boolean default false, p_at timestamptz default null, p_first date default null)
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
  select * into v_item from items where id = p_item for update;
  if not found or not public.can_write(v_item.shop_id) then
    raise exception 'item not found or shop is read-only';
  end if;
  v_qty := v_item.qty + p_delta;
  if v_qty < 0 and p_delta < 0 and not p_short then
    raise exception 'not enough stock: % has %', v_item.sku, v_item.qty using errcode = 'P0001';
  end if;
  update items set qty = v_qty, updated_at = now() where id = p_item;

  if p_delta > 0 then
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
    if p_first is not null then
      for r in select id, expiry, qty from lots where item_id = p_item and expiry = p_first for update loop
        v_take := least(r.qty, v_left);
        if v_take = r.qty then delete from lots where id = r.id;
        else update lots set qty = qty - v_take where id = r.id; end if;
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), r.expiry, p_sale, v_at);
        v_left := v_left - v_take;
      end loop;
    end if;
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
      if not v_expired and v_left > 0 and v_free > 0 then
        v_take := least(v_free, v_left);
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), null, p_sale, v_at);
        v_left := v_left - v_take;
      end if;
    end loop;
    if v_left > 0 then
      insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
      values (v_item.shop_id, p_item, v_item.sku, 'out', v_left, coalesce(p_note, ''), null, p_sale, v_at);
    end if;
  end if;

  perform public.auto_reorder(p_item);
  return v_qty;
end $$;

-- ---------- expiring price ----------

-- Owner: a lower price for one expiry date of a product (null = normal price).
create function public.set_lot_price(p_item uuid, p_expiry date, p_price numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from items where id = p_item;
  if v_shop is null or not public.is_owner(v_shop) or not public.can_write(v_shop) then
    raise exception 'only the owner can set prices';
  end if;
  if p_price is not null and p_price < 0 then raise exception 'price must not be negative'; end if;
  update lots set price = p_price where item_id = p_item and expiry = p_expiry;
  if not found then raise exception 'lot not found'; end if;
end $$;

-- ---------- the till ----------

-- 004's create_sale, same arguments. Each line may now carry:
--   "pack_id"  qty counts packs; stock goes down by qty x pack size, at the pack's price
--   "expiry"   sell that batch at its expiring price (lots.price), taking its stock first
-- Lines: [{"item_id", "qty", "price"?, "pack_id"?, "expiry"?}]
create or replace function public.create_sale(
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
  v_pack  packs%rowtype;
  v_price numeric;
  v_lotp  numeric;
  v_base  numeric;
  v_ws    boolean;
  v_flags text[] := '{}';
  v_t     record;
  v_ret   timestamptz;
  v_rate  numeric;
  r       record;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  select id into v_sale from sales where shop_id = p_shop and client_id = p_client_id;
  if found then return v_sale; end if;
  if p_method not in ('cash', 'transfer') then raise exception 'unknown payment method'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the sale has no products';
  end if;
  select * into v_t from public.device_time(p_at);
  if v_t.v_bad then v_flags := v_flags || 'clock'::text; end if;

  if p_till is null then raise exception 'this device is not a till'; end if;
  select retired_at into v_ret from tills where shop_id = p_shop and code = p_till for update;
  if not found then raise exception 'unknown till: %', p_till; end if;
  if v_ret is not null and not (v_off and v_t.v_at < v_ret) then
    raise exception 'till retired: %', p_till;
  end if;
  update tills set last_no = greatest(last_no, coalesce(p_till_no, 0))
  where shop_id = p_shop and code = p_till;

  update shops set receipt_seq = receipt_seq + 1 where id = p_shop returning receipt_seq into v_no;
  insert into sales (shop_id, client_id, receipt_no, method, till, till_no, created_at)
  values (p_shop, p_client_id, v_no, p_method, p_till, p_till_no, v_t.v_at) returning id into v_sale;

  -- One line per product, pack and batch; sorted by product so two tills
  -- selling the same products lock them in the same order.
  for r in select (l->>'item_id')::uuid item_id,
                  nullif(l->>'pack_id', '')::uuid pack_id,
                  case when nullif(l->>'pack_id', '') is null then nullif(l->>'expiry', '')::date end expiry,
                  sum((l->>'qty')::numeric) qty, max((l->>'price')::numeric) price
           from jsonb_array_elements(p_lines) l group by 1, 2, 3
           order by 1, 2 nulls first, 3 nulls first loop
    if r.qty is null or r.qty <= 0 then raise exception 'quantity must be more than zero'; end if;
    select * into v_item from items where id = r.item_id and shop_id = p_shop for update;
    if not found then raise exception 'item not found or shop is read-only'; end if;
    v_ws := false;
    if r.pack_id is not null then
      select * into v_pack from packs where id = r.pack_id and item_id = r.item_id;
      if not found then raise exception 'pack not found'; end if;
      v_base := r.qty * v_pack.size;
      v_price := v_pack.price;
    else
      v_pack := null;
      v_base := r.qty;
      v_lotp := null;
      if r.expiry is not null then
        select price into v_lotp from lots where item_id = r.item_id and expiry = r.expiry;
      end if;
      if v_lotp is not null then
        v_price := v_lotp;
      else
        v_ws := v_item.price_wholesale > 0 and v_item.wholesale_min_qty > 0
                and r.qty >= v_item.wholesale_min_qty;
        v_price := case when v_ws then v_item.price_wholesale else v_item.price end;
      end if;
    end if;
    if v_off and r.price is not null and r.price >= 0 then
      if r.price <> v_price and not 'price_changed' = any(v_flags) then
        v_flags := v_flags || 'price_changed'::text;
      end if;
      v_price := r.price;
    elsif v_price <= 0 then
      raise exception 'no sell price: %', v_item.sku;
    end if;
    if v_off and v_item.qty < v_base and not 'short' = any(v_flags) then
      v_flags := v_flags || 'short'::text;
    end if;
    perform public.stock_move(r.item_id, -v_base, 'sale', null, v_sale, v_off, v_t.v_at, r.expiry);
    insert into sale_lines (shop_id, sale_id, item_id, sku, name, qty, unit_price, wholesale, line_total,
                            pack_id, pack_name, pack_size, pack_qty, expiry, created_at)
    values (p_shop, v_sale, r.item_id, v_item.sku, v_item.name, v_base, r.qty * v_price / v_base, v_ws,
            r.qty * v_price, v_pack.id, v_pack.name, v_pack.size,
            case when v_pack.id is not null then r.qty end, r.expiry, v_t.v_at);
    v_sub := v_sub + r.qty * v_price;
  end loop;

  if v_disc < 0 or v_disc > v_sub then raise exception 'discount must be between 0 and the subtotal'; end if;
  v_total := v_sub - v_disc;
  if p_method = 'cash' then
    if v_paid < v_total then raise exception 'cash paid is less than the total'; end if;
  else
    v_paid := v_total;
  end if;
  -- VAT is inside the price: the part of the total that is tax.
  select coalesce(vat_rate, 0) into v_rate from settings where shop_id = p_shop;
  v_rate := coalesce(v_rate, 0);
  update sales set subtotal = v_sub, discount = v_disc, total = v_total,
                   paid = v_paid, change_due = v_paid - v_total, flags = v_flags,
                   vat_rate = v_rate, vat = round(v_total * v_rate / (100 + v_rate), 2)
  where id = v_sale;
  return v_sale;
end $$;

-- ---------- grants ----------

revoke execute on function public.stock_move(uuid, numeric, text, date, uuid, boolean, timestamptz, date)
  from public, anon, authenticated;
revoke execute on function public.set_lot_price(uuid, date, numeric) from public, anon;
grant execute on function public.set_lot_price(uuid, date, numeric) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.packs;
  end if;
end $$;

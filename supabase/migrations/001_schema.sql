-- RAPIDÉWMS core schema.
-- Every row belongs to a shop; row-level security limits each user to the
-- shops they are a member of. Stock quantities only change through
-- adjust_stock() so every change is logged and can never go negative.

-- ---------- tables ----------

create table public.shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  currency    text not null default 'LAK',
  plan        text not null default 'trial' check (plan in ('trial', 'paid')),
  plan_until  timestamptz not null default now() + interval '14 days',
  created_at  timestamptz not null default now()
);

create table public.members (
  shop_id    uuid not null references public.shops on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.settings (
  shop_id      uuid primary key references public.shops on delete cascade,
  low_alert    boolean not null default true,
  auto_reorder boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table public.items (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  sku        text not null check (length(trim(sku)) > 0),
  name       text not null check (length(trim(name)) > 0),
  category   text not null default 'General',
  barcode    text,
  qty        numeric not null default 0 check (qty >= 0),
  min_qty    numeric not null default 0 check (min_qty >= 0),
  cost       numeric not null default 0 check (cost >= 0),
  -- Selling side. price_wholesale 0 means "no wholesale price for this item";
  -- the till uses it once a line reaches wholesale_min_qty.
  price             numeric not null default 0 check (price >= 0),
  price_wholesale   numeric not null default 0 check (price_wholesale >= 0),
  wholesale_min_qty numeric not null default 0 check (wholesale_min_qty >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index items_shop_sku_uidx on public.items (shop_id, lower(sku));
create index items_shop_barcode_idx on public.items (shop_id, barcode);

create table public.orders (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops on delete cascade,
  item_id      uuid not null references public.items on delete cascade,
  type         text not null check (type in ('in', 'out')),
  qty          numeric not null check (qty > 0),
  party        text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'done')),
  auto         boolean not null default false,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index orders_shop_idx on public.orders (shop_id, created_at desc);

create table public.movements (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  item_id    uuid references public.items on delete set null,
  sku        text not null,             -- kept so history survives item deletion
  type       text not null check (type in ('in', 'out')),
  qty        numeric not null check (qty > 0),
  note       text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index movements_shop_idx on public.movements (shop_id, created_at desc);

-- ---------- membership helpers ----------

create or replace function public.is_member(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where shop_id = p_shop and user_id = auth.uid());
$$;

create or replace function public.is_owner(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members
                 where shop_id = p_shop and user_id = auth.uid() and role = 'owner');
$$;

-- member AND trial/plan not expired. Expired shops stay readable, never deleted.
create or replace function public.can_write(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_member(p_shop)
     and exists (select 1 from shops where id = p_shop and plan_until > now());
$$;

-- ---------- row-level security ----------

alter table public.shops     enable row level security;
alter table public.members   enable row level security;
alter table public.settings  enable row level security;
alter table public.items     enable row level security;
alter table public.orders    enable row level security;
alter table public.movements enable row level security;

create policy shops_select on public.shops for select using (public.is_member(id));
create policy shops_update on public.shops for update using (public.is_owner(id));

create policy members_select on public.members for select using (public.is_member(shop_id));

create policy settings_select on public.settings for select using (public.is_member(shop_id));
create policy settings_update on public.settings for update
  using (public.is_owner(shop_id)) with check (public.is_owner(shop_id));

create policy items_select on public.items for select using (public.is_member(shop_id));
create policy items_insert on public.items for insert with check (public.can_write(shop_id));
create policy items_update on public.items for update
  using (public.can_write(shop_id)) with check (public.can_write(shop_id));
create policy items_delete on public.items for delete
  using (public.is_owner(shop_id) and public.can_write(shop_id));

create policy orders_select on public.orders for select using (public.is_member(shop_id));
create policy orders_insert on public.orders for insert with check (
  public.can_write(shop_id)
  and exists (select 1 from public.items i where i.id = item_id and i.shop_id = orders.shop_id)
);
create policy orders_delete on public.orders for delete
  using (public.is_owner(shop_id) and public.can_write(shop_id));

create policy movements_select on public.movements for select using (public.is_member(shop_id));

-- Column-level grants: clients may only touch descriptive columns. Quantities,
-- order status and billing fields change only through the functions below.
revoke all on public.shops, public.members, public.settings, public.items,
              public.orders, public.movements from anon, authenticated;

grant select on public.shops, public.members, public.settings, public.items,
                public.orders, public.movements to authenticated;
grant update (name) on public.shops to authenticated;
grant update (low_alert, auto_reorder, updated_at) on public.settings to authenticated;
grant insert (shop_id, sku, name, category, barcode, min_qty, cost,
              price, price_wholesale, wholesale_min_qty) on public.items to authenticated;
grant update (sku, name, category, barcode, min_qty, cost,
              price, price_wholesale, wholesale_min_qty, updated_at) on public.items to authenticated;
grant delete on public.items to authenticated;
grant insert (shop_id, item_id, type, qty, party) on public.orders to authenticated;
grant delete on public.orders to authenticated;

-- ---------- functions (the only way to change stock) ----------

create or replace function public.create_shop(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into shops (name) values (trim(p_name)) returning id into v_shop;
  insert into members (shop_id, user_id, role) values (v_shop, auth.uid(), 'owner');
  insert into settings (shop_id) values (v_shop);
  return v_shop;
end $$;

create or replace function public.adjust_stock(p_item uuid, p_delta numeric, p_note text default '')
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item items%rowtype;
  v_qty  numeric;
  v_auto boolean;
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
  insert into movements (shop_id, item_id, sku, type, qty, note)
  values (v_item.shop_id, p_item, v_item.sku,
          case when p_delta > 0 then 'in' else 'out' end, abs(p_delta), coalesce(p_note, ''));

  select auto_reorder into v_auto from settings where shop_id = v_item.shop_id;
  if v_auto and v_qty < v_item.min_qty and not exists (
       select 1 from orders where item_id = p_item and type = 'in' and status = 'pending') then
    insert into orders (shop_id, item_id, type, qty, party, auto)
    values (v_item.shop_id, p_item, 'in', v_item.min_qty * 2 - v_qty, 'Auto-reorder', true);
  end if;
  return v_qty;
end $$;

-- Set an absolute count (edit form, stock take). Logged as the difference.
create or replace function public.set_stock(p_item uuid, p_qty numeric, p_note text default 'count')
returns numeric language plpgsql security definer set search_path = public as $$
declare v_cur numeric;
begin
  select qty into v_cur from items where id = p_item for update;
  if not found then raise exception 'item not found'; end if;
  if p_qty = v_cur then return v_cur; end if;
  return public.adjust_stock(p_item, p_qty - v_cur, p_note);
end $$;

create or replace function public.complete_order(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_o orders%rowtype;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or not public.can_write(v_o.shop_id) then
    raise exception 'order not found or shop is read-only';
  end if;
  if v_o.status <> 'pending' then raise exception 'order already completed'; end if;
  perform public.adjust_stock(v_o.item_id, case when v_o.type = 'in' then v_o.qty else -v_o.qty end, 'order');
  update orders set status = 'done', completed_at = now() where id = p_order;
end $$;

-- Danger zone: owner wipes all items/orders/movements of one shop.
create or replace function public.erase_shop_data(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can erase data'; end if;
  delete from movements where shop_id = p_shop;
  delete from orders    where shop_id = p_shop;
  delete from items     where shop_id = p_shop;
end $$;

revoke execute on function public.create_shop(text), public.adjust_stock(uuid, numeric, text),
  public.set_stock(uuid, numeric, text), public.complete_order(uuid),
  public.erase_shop_data(uuid) from public, anon;
grant execute on function public.create_shop(text), public.adjust_stock(uuid, numeric, text),
  public.set_stock(uuid, numeric, text), public.complete_order(uuid),
  public.erase_shop_data(uuid) to authenticated;

-- ---------- realtime ----------
-- Supabase Realtime respects RLS, so each device only receives its own shop's changes.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.items, public.orders, public.movements, public.settings;
  end if;
end $$;

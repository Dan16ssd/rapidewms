-- 007: customers, and moving a shop over from another POS.
--
-- * customers: name, phone, note. Any member can add or edit one (the cashier
--   adds a regular at the till); only the owner deletes.
-- * sales.customer_id: create_sale() takes an optional p_customer.
-- * import_sales(): past sales from another POS, owner only. They are history:
--   no stock moves (stock is imported as today's count), till 'IMP', flagged
--   'imported', and importing the same file twice adds them once (by the
--   source receipt number).
-- * customer_totals(): visits and money per customer over all time, since
--   the app only loads the last 30 days of sales.

-- ---------- customers ----------

create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  phone      text check (phone is null or length(phone) <= 30),
  note       text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now()
);
create index customers_shop_idx on public.customers (shop_id, name);
create unique index customers_shop_phone_uidx on public.customers (shop_id, phone)
  where phone is not null and phone <> '';

alter table public.customers enable row level security;
create policy customers_select on public.customers for select using (public.is_member(shop_id));
create policy customers_insert on public.customers for insert
  with check (public.is_member(shop_id) and public.can_write(shop_id));
create policy customers_update on public.customers for update
  using (public.is_member(shop_id) and public.can_write(shop_id))
  with check (public.is_member(shop_id) and public.can_write(shop_id));
create policy customers_delete on public.customers for delete
  using (public.is_owner(shop_id) and public.can_write(shop_id));

revoke all on public.customers from anon, authenticated;
grant select, delete on public.customers to authenticated;
grant insert (shop_id, name, phone, note), update (name, phone, note) on public.customers to authenticated;

alter table public.sales add column customer_id uuid references public.customers on delete set null;
create index sales_customer_idx on public.sales (customer_id) where customer_id is not null;

-- ---------- the till: an optional customer ----------

-- 006's create_sale does the selling; the new one (one more argument) names
-- the customer. Renaming keeps a single definition of the sale rules.
alter function public.create_sale(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean)
  rename to create_sale_core;
revoke execute on function
  public.create_sale_core(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean)
  from public, anon, authenticated;

create or replace function public.create_sale(
  p_shop uuid, p_client_id text, p_lines jsonb,
  p_discount numeric default 0, p_method text default 'cash', p_paid numeric default 0,
  p_at timestamptz default null, p_till text default null, p_till_no integer default null,
  p_offline boolean default false, p_customer uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_sale uuid;
begin
  v_sale := public.create_sale_core(p_shop, p_client_id, p_lines, p_discount, p_method, p_paid,
                                    p_at, p_till, p_till_no, p_offline);
  -- A customer deleted while this sale waited offline: the sale still counts.
  if p_customer is not null then
    update sales set customer_id = p_customer
    where id = v_sale and customer_id is null
      and exists (select 1 from customers where id = p_customer and shop_id = p_shop);
  end if;
  return v_sale;
end $$;

-- ---------- customer totals ----------

create or replace function public.customer_totals(p_shop uuid)
returns table (customer_id uuid, visits bigint, total numeric, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.customer_id, count(*), sum(s.total), max(s.created_at)
  from sales s
  where s.shop_id = p_shop and public.is_member(p_shop)
    and s.customer_id is not null and s.status = 'paid'
  group by s.customer_id
$$;

-- ---------- importing past sales ----------

-- p_rows: [{ ref, at, method?, discount?, customer?: { name, phone? },
--            lines: [{ sku?, name?, qty, price }] }], at most 500 per call.
-- Returns { added, skipped }.
create or replace function public.import_sales(p_shop uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        jsonb;
  l        jsonb;
  v_ref    text;
  v_cid    text;
  v_at     timestamptz;
  v_sale   uuid;
  v_no     integer;
  v_sub    numeric;
  v_disc   numeric;
  v_total  numeric;
  v_qty    numeric;
  v_price  numeric;
  v_sku    text;
  v_name   text;
  v_item   items%rowtype;
  v_cust   uuid;
  v_cname  text;
  v_phone  text;
  v_rate   numeric;
  v_added  integer := 0;
  v_skip   integer := 0;
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can import'; end if;
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'nothing to import'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'at most 500 sales per import call'; end if;
  select coalesce(vat_rate, 0) into v_rate from settings where shop_id = p_shop;
  v_rate := coalesce(v_rate, 0);

  for r in select * from jsonb_array_elements(p_rows) loop
    v_ref := left(trim(coalesce(r->>'ref', '')), 100);
    if v_ref = '' then raise exception 'import: a sale has no receipt number'; end if;
    v_cid := 'import:' || v_ref;
    if exists (select 1 from sales where shop_id = p_shop and client_id = v_cid) then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_at := (r->>'at')::timestamptz;
    if v_at is null or v_at > now() + interval '1 day' then
      raise exception 'import: receipt % has no date, or a date in the future', v_ref;
    end if;
    if jsonb_typeof(r->'lines') is distinct from 'array' or jsonb_array_length(r->'lines') = 0 then
      raise exception 'import: receipt % has no products', v_ref;
    end if;

    -- The customer: found by phone, else by name, else added.
    v_cust := null;
    v_cname := left(trim(coalesce(r->'customer'->>'name', '')), 80);
    v_phone := nullif(left(trim(coalesce(r->'customer'->>'phone', '')), 30), '');
    if v_cname <> '' or v_phone is not null then
      if v_phone is not null then
        select id into v_cust from customers where shop_id = p_shop and phone = v_phone;
      end if;
      if v_cust is null and v_cname <> '' then
        select id into v_cust from customers where shop_id = p_shop and lower(name) = lower(v_cname)
        order by created_at limit 1;
      end if;
      if v_cust is null then
        insert into customers (shop_id, name, phone)
        values (p_shop, coalesce(nullif(v_cname, ''), v_phone), v_phone) returning id into v_cust;
      end if;
    end if;

    update shops set receipt_seq = receipt_seq + 1 where id = p_shop returning receipt_seq into v_no;
    insert into sales (shop_id, client_id, receipt_no, method, till, flags, created_at, customer_id)
    values (p_shop, v_cid, v_no,
            case when lower(coalesce(r->>'method', '')) = 'transfer' then 'transfer' else 'cash' end,
            'IMP', '{imported}', v_at, v_cust)
    returning id into v_sale;

    v_sub := 0;
    for l in select * from jsonb_array_elements(r->'lines') loop
      v_qty := (l->>'qty')::numeric;
      v_price := coalesce((l->>'price')::numeric, 0);
      if v_qty is null or v_qty <= 0 or v_price < 0 then
        raise exception 'import: receipt % has a line with a bad quantity or price', v_ref;
      end if;
      v_sku := left(trim(coalesce(l->>'sku', '')), 100);
      v_name := left(trim(coalesce(l->>'name', '')), 200);
      v_item := null;
      if v_sku <> '' then
        select * into v_item from items where shop_id = p_shop and lower(sku) = lower(v_sku);
      end if;
      if v_item.id is null and v_name <> '' then
        select * into v_item from items where shop_id = p_shop and lower(name) = lower(v_name)
        order by created_at limit 1;
      end if;
      insert into sale_lines (shop_id, sale_id, item_id, sku, name, qty, unit_price, line_total, created_at)
      values (p_shop, v_sale, v_item.id,
              coalesce(v_item.sku, nullif(v_sku, ''), '-'),
              coalesce(v_item.name, nullif(v_name, ''), nullif(v_sku, ''), '-'),
              v_qty, v_price, v_qty * v_price, v_at);
      v_sub := v_sub + v_qty * v_price;
    end loop;

    v_disc := coalesce((r->>'discount')::numeric, 0);
    if v_disc < 0 or v_disc > v_sub then
      raise exception 'import: receipt % has a discount bigger than its total', v_ref;
    end if;
    v_total := v_sub - v_disc;
    update sales set subtotal = v_sub, discount = v_disc, total = v_total, paid = v_total, change_due = 0,
                     vat_rate = v_rate, vat = round(v_total * v_rate / (100 + v_rate), 2)
    where id = v_sale;
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'skipped', v_skip);
end $$;

-- ---------- erase: customers too ----------

create or replace function public.erase_shop_data(p_shop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can erase data'; end if;
  delete from movements   where shop_id = p_shop;
  delete from sale_lines  where shop_id = p_shop;
  delete from sales       where shop_id = p_shop;
  delete from customers   where shop_id = p_shop;
  delete from lots        where shop_id = p_shop;
  delete from orders      where shop_id = p_shop;
  delete from packs       where shop_id = p_shop;
  delete from items       where shop_id = p_shop;
  delete from applied_ops where shop_id = p_shop;
  update shops set receipt_seq = 0 where id = p_shop;
end $$;

-- ---------- grants ----------

revoke execute on function
  public.create_sale(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean, uuid),
  public.customer_totals(uuid),
  public.import_sales(uuid, jsonb)
  from public, anon;
grant execute on function
  public.create_sale(uuid, text, jsonb, numeric, text, numeric, timestamptz, text, integer, boolean, uuid),
  public.customer_totals(uuid),
  public.import_sales(uuid, jsonb)
  to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.customers;
  end if;
end $$;

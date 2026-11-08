-- 004: the shop's plan sets how many devices can sell.
--
-- Every device that sells is a till (003). Until now any number of phones and
-- PCs could register, so a one-till plan could run a whole minimart. Now:
--
-- * shops.max_tills is the number of tills that can be in use at once. Only
--   the server (the admin's SQL) sets it, like plan and plan_until.
-- * register_till refuses a new device when that many tills are in use.
-- * A sale must come from a till that is in use. A device with no till can
--   still open the shop to look at stock and reports, but it cannot sell.
-- * The owner retires a till (an old or lost phone) to free its place. Its
--   letter is never given out again, so receipt numbers can't repeat, and
--   sales it made offline before it was retired are still accepted.
--
-- Plans: trial 2 tills; Small shop 1; Minimart 4 (3 tills + a PC).
--   update shops set plan = 'paid', plan_until = now() + interval '1 month',
--                    max_tills = 4 where name = 'Shop name';

alter table public.shops
  add column max_tills integer not null default 2 check (max_tills between 1 and 50);
alter table public.tills add column retired_at timestamptz;

create or replace function public.register_till(p_shop uuid, p_name text default '')
returns text language plpgsql security definer set search_path = public as $$
declare v_n integer; v_used integer; v_max integer; v_code text;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  -- one registration at a time per shop, so two devices can't get the same letter
  select max_tills into v_max from shops where id = p_shop for update;
  select count(*), count(*) filter (where retired_at is null) into v_n, v_used
  from tills where shop_id = p_shop;
  if v_used >= v_max then raise exception 'till limit reached: % of %', v_used, v_max; end if;
  -- letters count retired tills too, so a letter is never reused
  v_code := case when v_n < 26 then chr(65 + v_n)
                 else chr(65 + (v_n / 26) - 1) || chr(65 + v_n % 26) end;
  insert into tills (shop_id, code, name) values (p_shop, v_code, left(coalesce(p_name, ''), 40));
  return v_code;
end $$;

create function public.retire_till(p_shop uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can retire a till'; end if;
  update tills set retired_at = now() where shop_id = p_shop and code = p_code and retired_at is null;
  if not found then raise exception 'unknown till: %', p_code; end if;
end $$;

-- 003's create_sale, now refusing sales from no till or a retired one.
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
  v_price numeric;
  v_ws    boolean;
  v_flags text[] := '{}';
  v_t     record;
  v_ret   timestamptz;
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
  -- an offline sale made before the till was retired already happened
  if v_ret is not null and not (v_off and v_t.v_at < v_ret) then
    raise exception 'till retired: %', p_till;
  end if;
  update tills set last_no = greatest(last_no, coalesce(p_till_no, 0))
  where shop_id = p_shop and code = p_till;

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

revoke execute on function public.retire_till(uuid, text) from public, anon;
grant execute on function public.retire_till(uuid, text) to authenticated;

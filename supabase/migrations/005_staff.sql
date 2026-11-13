-- 005: the owner adds cashiers with a one-time code.
--
-- Until now the only way into a shop was creating it, so every till logged in
-- with the owner's account (and owner powers). Now:
--
-- * The owner makes an invite code in Settings (8 letters/digits, one use,
--   24 hours). At most 10 unused codes per shop at a time.
-- * The cashier signs up, and on the "Name your shop" screen enters the code
--   instead. They join as staff: they sell, receive stock and check expiry
--   dates, but can't delete, change settings, retire tills or erase data.
-- * The owner sees who is in the shop and can remove a staff member.
--
-- Codes are 8 characters from 31 (no 0/O, 1/I/L): about 850 billion choices,
-- so guessing one of a shop's few live codes within a day is not practical.

create table public.invites (
  code       text primary key,
  shop_id    uuid not null references public.shops on delete cascade,
  created_by uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_by    uuid references auth.users on delete set null,
  used_at    timestamptz
);
create index invites_shop_idx on public.invites (shop_id);

-- Only through the functions below; nobody reads the table directly.
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;

create function public.create_invite(p_shop uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_abc  constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_b    bytea;
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can invite staff'; end if;
  if (select count(*) from invites
      where shop_id = p_shop and used_at is null and expires_at > now()) >= 10 then
    raise exception 'too many open invites';
  end if;
  loop
    v_b := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    v_code := '';
    -- bytes 0-5 and 16-17 of the pair: none of them carry the uuid version bits
    for i in 0..7 loop
      v_code := v_code || substr(v_abc, 1 + get_byte(v_b, case when i < 6 then i else i + 10 end) % 31, 1);
    end loop;
    exit when not exists (select 1 from invites where code = v_code);
  end loop;
  insert into invites (code, shop_id, created_by) values (v_code, p_shop, auth.uid());
  return v_code;
end $$;

create function public.cancel_invite(p_shop uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can cancel an invite'; end if;
  delete from invites where shop_id = p_shop and code = p_code and used_at is null;
end $$;

-- The cashier's side. Dashes, spaces and small letters are forgiven.
create function public.join_shop(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_inv from invites
  where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
    and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'invite code not valid'; end if;
  if exists (select 1 from members where shop_id = v_inv.shop_id and user_id = auth.uid()) then
    raise exception 'already a member of this shop';
  end if;
  insert into members (shop_id, user_id, role) values (v_inv.shop_id, auth.uid(), 'staff');
  update invites set used_by = auth.uid(), used_at = now() where code = v_inv.code;
  return v_inv.shop_id;
end $$;

-- The owner's Staff card: who is in the shop, and the codes not used yet.
create function public.shop_people(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can see staff'; end if;
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role,
                                          'created_at', m.created_at) order by m.role, m.created_at)
      from members m join auth.users u on u.id = m.user_id where m.shop_id = p_shop), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('code', i.code, 'expires_at', i.expires_at) order by i.created_at)
      from invites i where i.shop_id = p_shop and i.used_at is null and i.expires_at > now()), '[]'::jsonb));
end $$;

-- A cashier who leaves. Their device's till stays until the owner retires it.
create function public.remove_member(p_shop uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can remove staff'; end if;
  delete from members where shop_id = p_shop and user_id = p_user and role = 'staff';
  if not found then raise exception 'not a staff member'; end if;
end $$;

revoke execute on function public.create_invite(uuid), public.cancel_invite(uuid, text),
  public.join_shop(text), public.shop_people(uuid), public.remove_member(uuid, uuid)
  from public, anon;
grant execute on function public.create_invite(uuid), public.cancel_invite(uuid, text),
  public.join_shop(text), public.shop_people(uuid), public.remove_member(uuid, uuid)
  to authenticated;

-- The owner's staff list updates when a cashier joins.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.members;
  end if;
end $$;

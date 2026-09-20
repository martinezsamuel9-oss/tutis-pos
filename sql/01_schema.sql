-- ============================================================================
--  TUTI'S — Sistema de punto de venta multi-sucursal
--  Esquema completo para Supabase (PostgreSQL)
--
--  Cómo usarlo: Supabase → SQL Editor → pega TODO este archivo → Run.
--  Es idempotente en lo posible, pero está pensado para correrse una sola vez
--  en un proyecto nuevo y vacío.
--
--  Reglas de acceso que implementa (esto es el corazón del diseño):
--    · cajera  → solo su sucursal. Cobra (vía process_sale) y consulta el
--                catálogo de su tienda. No edita precios, costos ni inventario.
--    · gerente → solo su sucursal, pero con control total de ella: catálogo,
--                precios, inventario, reportes y configuración de SU tienda.
--    · propietario → ve y administra TODAS las sucursales, crea sucursales
--                nuevas y asigna usuarios/roles.
--
--  Tuti's Galerías NO puede ver nada de Tuti's Multiplaza, y viceversa.
--  Ese aislamiento no depende de la interfaz: está aplicado en la base de
--  datos con Row Level Security, así que se cumple aunque alguien intente
--  consultar la API directamente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TIPOS
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('propietario', 'gerente', 'cajera');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_item_type') then
    create type sale_item_type as enum ('vaso', 'cuchara', 'helado', 'topping');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. SUCURSALES
--    Cada sucursal tiene su propio país, moneda, precio por gramo y meta de
--    margen. Abrir una sucursal nueva = insertar una fila aquí. No hay que
--    tocar el esquema ni la aplicación.
-- ----------------------------------------------------------------------------
create table if not exists public.locations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  legal_name        text,
  country_code      text not null default 'HN' check (country_code in ('GT', 'SV', 'HN')),
  currency_code     text not null default 'HNL',
  tax_id_value      text,
  address           text,
  report_email      text,
  price_per_gram    numeric(12,4) not null default 0,
  include_cup_weight_in_price boolean not null default true,
  margin_target_pct numeric(5,2) not null default 60,
  invoice_provider  text not null default 'none',
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Dos sucursales con el mismo nombre serían indistinguibles en los reportes, y
-- además permitían que correr el seed dos veces duplicara las tiendas.
create unique index if not exists uq_locations_name on public.locations(name);

-- ----------------------------------------------------------------------------
-- 3. PERFILES DE USUARIO
--    Una fila por usuario de Supabase Auth. El rol y la sucursal viven aquí.
--    location_id NULL = propietario (no pertenece a una sola tienda, las ve todas).
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        user_role not null default 'cajera',
  location_id uuid references public.locations(id) on delete set null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Cuando alguien se registra en Auth, se le crea el perfil automáticamente.
-- Nace como cajera sin sucursal asignada: el propietario le asigna tienda y
-- rol desde la aplicación. Así ningún usuario nuevo ve datos por accidente.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, location_id, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'cajera',
    null,
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 4. FUNCIONES AUXILIARES PARA LOS PERMISOS
--    SECURITY DEFINER a propósito: leen profiles saltándose RLS para que las
--    políticas que consultan el rol no caigan en recursión infinita.
-- ----------------------------------------------------------------------------
create or replace function public.app_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and active;
$$;

create or replace function public.app_location_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select location_id from public.profiles where id = auth.uid() and active;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active and role = 'propietario'
  );
$$;

-- ¿El usuario puede ver/tocar esta sucursal?
-- Propietario: cualquiera. Gerente y cajera: únicamente la suya.
create or replace function public.can_access_location(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.active
      and (p.role = 'propietario' or p.location_id = target)
  );
$$;

-- ¿Puede administrar (escribir) esta sucursal? Propietario o su gerente.
create or replace function public.can_manage_location(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.active
      and (p.role = 'propietario' or (p.role = 'gerente' and p.location_id = target))
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. CATÁLOGO POR SUCURSAL
--    Cada tienda tiene sus propios sabores, toppings, vasos y cucharas, con
--    sus propios costos y existencias. Por eso location_id está en todas.
-- ----------------------------------------------------------------------------
create table if not exists public.flavors (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations(id) on delete cascade,
  name             text not null,
  cost_per_gram    numeric(12,4) not null default 0,
  stock_grams      numeric(12,2) not null default 0,
  min_stock_grams  numeric(12,2) not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table if not exists public.toppings (
  id                   uuid primary key default gen_random_uuid(),
  location_id          uuid not null references public.locations(id) on delete cascade,
  name                 text not null,
  category             text not null default 'dulce',
  cost_per_gram        numeric(12,4) not null default 0,
  -- tier 1 = entra en el precio único. tier 2 = premium, lleva recargo aparte.
  tier                 smallint not null default 1 check (tier in (1, 2)),
  surcharge_per_gram   numeric(12,4) not null default 0,
  stock_grams          numeric(12,2) not null default 0,
  min_stock_grams      numeric(12,2) not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create table if not exists public.supplies (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations(id) on delete cascade,
  name           text not null,
  kind           text not null check (kind in ('vaso', 'cuchara')),
  tare_weight_g  numeric(10,2) not null default 0,
  cost_per_unit  numeric(12,4) not null default 0,
  stock_qty      integer not null default 0,
  min_stock_qty  integer not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists idx_flavors_location  on public.flavors(location_id);
create index if not exists idx_toppings_location on public.toppings(location_id);
create index if not exists idx_supplies_location on public.supplies(location_id);
create index if not exists idx_profiles_location on public.profiles(location_id);

-- Dentro de una misma tienda no puede haber dos productos ACTIVOS con el mismo
-- nombre: los reportes agrupan por nombre, así que un duplicado partiría en dos
-- las cifras del mismo topping. El índice es parcial (solo sobre los activos) a
-- propósito: eliminar un topping lo marca inactivo, y así se puede volver a
-- crear uno con ese mismo nombre más adelante.
create unique index if not exists uq_flavors_loc_name
  on public.flavors(location_id, name) where active;
create unique index if not exists uq_toppings_loc_name
  on public.toppings(location_id, name) where active;
create unique index if not exists uq_supplies_loc_name
  on public.supplies(location_id, name) where active;

-- ----------------------------------------------------------------------------
-- 6. VENTAS
--    client_uuid es la clave de la resiliencia offline: la aplicación genera
--    ese identificador ANTES de intentar enviar la venta. Si la conexión se
--    cae y la venta se reenvía dos veces, la segunda no duplica nada.
-- ----------------------------------------------------------------------------
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations(id) on delete restrict,
  client_uuid     uuid not null unique,
  folio           bigint,
  cashier_id      uuid references public.profiles(id) on delete set null,
  cashier_name    text,
  created_at      timestamptz not null default now(),
  gross_weight_g  numeric(12,2) not null default 0,
  total_price     numeric(12,2) not null default 0,
  total_cost      numeric(12,2) not null default 0,
  margin          numeric(12,2) not null default 0,
  margin_pct      numeric(6,2) not null default 0,
  currency_code   text,
  payment_method  text,
  customer_name   text,
  customer_tax_id text,
  synced_offline  boolean not null default false
);

create table if not exists public.sale_lines (
  id                  uuid primary key default gen_random_uuid(),
  sale_id             uuid not null references public.sales(id) on delete cascade,
  location_id         uuid not null references public.locations(id) on delete restrict,
  item_type           sale_item_type not null,
  ref_id              uuid,
  name                text not null,
  weight_g            numeric(12,2) not null default 0,
  cost                numeric(12,4) not null default 0,
  price_contribution  numeric(12,4) not null default 0,
  is_premium_surcharge boolean not null default false
);

-- El folio es correlativo POR SUCURSAL, así que la pareja (sucursal, folio) no
-- se puede repetir. Esto es la red de seguridad de la numeración: si dos cajas
-- de la misma tienda cobraran en el mismo instante, sin esto ambas podrían
-- llevarse el mismo número. (process_sale además serializa la asignación.)
create unique index if not exists uq_sales_location_folio
  on public.sales(location_id, folio) where folio is not null;

create index if not exists idx_sales_location_date on public.sales(location_id, created_at desc);
create index if not exists idx_sale_lines_sale     on public.sale_lines(sale_id);
create index if not exists idx_sale_lines_location on public.sale_lines(location_id, item_type);

-- ----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
--    Sin esto, cualquiera con la llave pública podría leer todas las tiendas.
--    Con esto, el aislamiento lo garantiza la base de datos.
-- ----------------------------------------------------------------------------
alter table public.locations  enable row level security;
alter table public.profiles   enable row level security;
alter table public.flavors    enable row level security;
alter table public.toppings   enable row level security;
alter table public.supplies   enable row level security;
alter table public.sales      enable row level security;
alter table public.sale_lines enable row level security;

-- --- locations --------------------------------------------------------------
drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using (public.can_access_location(id));

-- Solo el propietario abre sucursales nuevas.
drop policy if exists locations_insert on public.locations;
create policy locations_insert on public.locations
  for insert to authenticated
  with check (public.is_owner());

-- El gerente puede ajustar la configuración de su tienda (precio por gramo,
-- meta de margen, correo de reportes); el propietario, la de cualquiera.
drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using (public.can_manage_location(id))
  with check (public.can_manage_location(id));

drop policy if exists locations_delete on public.locations;
create policy locations_delete on public.locations
  for delete to authenticated
  using (public.is_owner());

-- --- profiles ---------------------------------------------------------------
-- Cada quien se ve a sí mismo. El propietario ve a todo el personal.
-- El gerente ve al personal de su propia tienda.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_owner()
    or (public.app_role() = 'gerente' and location_id = public.app_location_id())
  );

-- Solo el propietario asigna roles y sucursales. Esto es deliberado: si un
-- gerente pudiera editar perfiles, podría asignarse otra tienda y romper el
-- aislamiento.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (public.is_owner());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (public.is_owner());

-- --- catálogo (flavors, toppings, supplies) ---------------------------------
-- Leer: cualquiera de esa sucursal (la cajera necesita ver el catálogo).
-- Escribir: solo gerente de esa tienda o propietario (la cajera no toca precios).
drop policy if exists flavors_select on public.flavors;
create policy flavors_select on public.flavors
  for select to authenticated using (public.can_access_location(location_id));
drop policy if exists flavors_write on public.flavors;
create policy flavors_write on public.flavors
  for all to authenticated
  using (public.can_manage_location(location_id))
  with check (public.can_manage_location(location_id));

drop policy if exists toppings_select on public.toppings;
create policy toppings_select on public.toppings
  for select to authenticated using (public.can_access_location(location_id));
drop policy if exists toppings_write on public.toppings;
create policy toppings_write on public.toppings
  for all to authenticated
  using (public.can_manage_location(location_id))
  with check (public.can_manage_location(location_id));

drop policy if exists supplies_select on public.supplies;
create policy supplies_select on public.supplies
  for select to authenticated using (public.can_access_location(location_id));
drop policy if exists supplies_write on public.supplies;
create policy supplies_write on public.supplies
  for all to authenticated
  using (public.can_manage_location(location_id))
  with check (public.can_manage_location(location_id));

-- --- ventas -----------------------------------------------------------------
-- Lectura por sucursal (el propietario ve todas). No hay política de INSERT a
-- propósito: las ventas entran únicamente por process_sale(), que valida y
-- descuenta inventario en una sola transacción.
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales
  for select to authenticated using (public.can_access_location(location_id));

drop policy if exists sale_lines_select on public.sale_lines;
create policy sale_lines_select on public.sale_lines
  for select to authenticated using (public.can_access_location(location_id));

-- Corregir/anular una venta es cosa de gerente o propietario, no de cajera.
drop policy if exists sales_delete on public.sales;
create policy sales_delete on public.sales
  for delete to authenticated using (public.can_manage_location(location_id));

-- --- permisos de tabla ------------------------------------------------------
-- Supabase normalmente ya otorga esto por defecto; lo dejamos explícito para
-- que el esquema no dependa de una configuración que no se ve. Los permisos de
-- tabla solo abren la puerta: quién ve qué filas lo siguen decidiendo las
-- políticas de arriba.
grant select, insert, update, delete on
  public.locations, public.profiles, public.flavors,
  public.toppings, public.supplies, public.sales, public.sale_lines
  to authenticated;

-- Y explícitamente NADA para quien no ha iniciado sesión. Hoy ya no vería nada
-- (todas las políticas de arriba son "to authenticated"), pero Supabase otorga
-- permisos a "anon" por omisión al crear tablas; dejarlo escrito evita que un
-- cambio futuro de configuración abra la base sin que nadie se dé cuenta.
revoke all on
  public.locations, public.profiles, public.flavors,
  public.toppings, public.supplies, public.sales, public.sale_lines
  from anon;

-- ----------------------------------------------------------------------------
-- 8. REGISTRAR VENTA (transacción atómica + idempotente)
--
--    Por qué una función y no inserts sueltos desde la aplicación:
--      · Atomicidad: la venta y el descuento de inventario ocurren juntos o no
--        ocurren. Sin esto, una conexión cortada a media operación deja el
--        inventario descuadrado.
--      · Idempotencia: si la cola offline reenvía la misma venta, client_uuid
--        evita cobrarla dos veces.
--      · Permisos: permite que la cajera registre ventas sin darle permiso de
--        escritura directa sobre el inventario.
-- ----------------------------------------------------------------------------
create or replace function public.process_sale(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id  uuid := (payload->>'location_id')::uuid;
  v_client_uuid  uuid := (payload->>'client_uuid')::uuid;
  v_created_at   timestamptz := coalesce((payload->>'created_at')::timestamptz, now());
  v_existing     public.sales%rowtype;
  v_sale_id      uuid;
  v_folio        bigint;
  v_line         jsonb;
  v_profile      public.profiles%rowtype;
  v_currency     text;
begin
  if v_location_id is null or v_client_uuid is null then
    raise exception 'Falta location_id o client_uuid en la venta';
  end if;

  select * into v_profile from public.profiles where id = auth.uid() and active;
  if v_profile.id is null then
    raise exception 'Usuario sin perfil activo';
  end if;

  -- Una cajera o gerente solo puede cobrar en SU sucursal.
  if v_profile.role <> 'propietario' and v_profile.location_id is distinct from v_location_id then
    raise exception 'No tiene permiso para registrar ventas en esa sucursal';
  end if;

  -- Reenvío de una venta que ya entró (cola offline): devolvemos la original.
  select * into v_existing from public.sales where client_uuid = v_client_uuid;
  if v_existing.id is not null then
    return jsonb_build_object(
      'sale_id', v_existing.id,
      'folio', v_existing.folio,
      'duplicate', true
    );
  end if;

  -- La moneda la manda la sucursal, no el cliente. Si la tomáramos del payload,
  -- una caja mal configurada podría grabar quetzales en una tienda que cobra en
  -- lempiras, y los reportes quedarían sumando cosas distintas.
  select currency_code into v_currency
    from public.locations where id = v_location_id;

  -- Folio correlativo por sucursal.
  --
  -- El candado es por sucursal y dura lo que dure la transacción: dos cajas de
  -- la MISMA tienda cobrando a la vez se forman una detrás de la otra para
  -- tomar número, mientras que las dos sucursales siguen siendo independientes
  -- entre sí. Sin esto, ambas leerían el mismo max(folio) y se llevarían el
  -- mismo número (o, con el índice único puesto arriba, una de las dos fallaría
  -- y la cajera perdería la venta).
  perform pg_advisory_xact_lock(hashtextextended(v_location_id::text, 0));

  select coalesce(max(folio), 0) + 1 into v_folio
  from public.sales where location_id = v_location_id;

  insert into public.sales (
    location_id, client_uuid, folio, cashier_id, cashier_name, created_at,
    gross_weight_g, total_price, total_cost, margin, margin_pct,
    currency_code, payment_method, customer_name, customer_tax_id, synced_offline
  ) values (
    v_location_id, v_client_uuid, v_folio, v_profile.id, v_profile.full_name, v_created_at,
    coalesce((payload->>'gross_weight_g')::numeric, 0),
    coalesce((payload->>'total_price')::numeric, 0),
    coalesce((payload->>'total_cost')::numeric, 0),
    coalesce((payload->>'margin')::numeric, 0),
    coalesce((payload->>'margin_pct')::numeric, 0),
    coalesce(v_currency, payload->>'currency_code'),
    payload->>'payment_method',
    payload->>'customer_name',
    payload->>'customer_tax_id',
    coalesce((payload->>'synced_offline')::boolean, false)
  )
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(coalesce(payload->'lines', '[]'::jsonb))
  loop
    insert into public.sale_lines (
      sale_id, location_id, item_type, ref_id, name, weight_g, cost,
      price_contribution, is_premium_surcharge
    ) values (
      v_sale_id,
      v_location_id,
      (v_line->>'item_type')::sale_item_type,
      nullif(v_line->>'ref_id', '')::uuid,
      coalesce(v_line->>'name', ''),
      coalesce((v_line->>'weight_g')::numeric, 0),
      coalesce((v_line->>'cost')::numeric, 0),
      coalesce((v_line->>'price_contribution')::numeric, 0),
      coalesce((v_line->>'is_premium_surcharge')::boolean, false)
    );

    -- Descuento de inventario, acotado siempre a la sucursal de la venta.
    if (v_line->>'item_type') = 'helado' and nullif(v_line->>'ref_id', '') is not null then
      update public.flavors
         set stock_grams = stock_grams - coalesce((v_line->>'weight_g')::numeric, 0)
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;

    elsif (v_line->>'item_type') = 'topping' and nullif(v_line->>'ref_id', '') is not null then
      update public.toppings
         set stock_grams = stock_grams - coalesce((v_line->>'weight_g')::numeric, 0)
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;

    elsif (v_line->>'item_type') in ('vaso', 'cuchara') and nullif(v_line->>'ref_id', '') is not null then
      update public.supplies
         set stock_qty = stock_qty - 1
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'folio', v_folio, 'duplicate', false);
end;
$$;

revoke all on function public.process_sale(jsonb) from public;
grant execute on function public.process_sale(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. CIERRE DEL DÍA
--    Devuelve, para una sucursal y una fecha: vasos, cucharas, peso de helado,
--    peso de toppings y el desglose por topping con su porcentaje.
--    El propietario puede pedirlo de cualquier tienda; los demás, solo de la suya.
--
--    p_day va en la fecha LOCAL de la tienda. Como los tres países operan en
--    UTC-6, el rango se calcula con ese desfase para que "el día" coincida con
--    el día real del negocio y no con el día UTC.
-- ----------------------------------------------------------------------------
create or replace function public.daily_closing(p_location_id uuid, p_day date, p_utc_offset_hours int default -6)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end   timestamptz;
  v_result jsonb;
begin
  if not public.can_access_location(p_location_id) then
    raise exception 'No tiene permiso para ver esa sucursal';
  end if;

  v_start := (p_day::timestamp - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';
  v_end   := v_start + interval '1 day';

  with day_sales as (
    select id, total_price, total_cost, margin
      from public.sales
     where location_id = p_location_id
       and created_at >= v_start
       and created_at < v_end
  ),
  totales_venta as (
    select count(*)                       as ventas,
           coalesce(sum(total_price), 0)  as ingresos,
           coalesce(sum(total_cost), 0)   as costos,
           coalesce(sum(margin), 0)       as margen
      from day_sales
  ),
  totales_linea as (
    select coalesce(sum(case when sl.item_type = 'vaso'    then 1 else 0 end), 0)           as vasos,
           coalesce(sum(case when sl.item_type = 'cuchara' then 1 else 0 end), 0)           as cucharas,
           coalesce(sum(case when sl.item_type = 'helado'  then sl.weight_g else 0 end), 0) as peso_helado,
           coalesce(sum(case when sl.item_type = 'topping' then sl.weight_g else 0 end), 0) as peso_toppings
      from public.sale_lines sl
      join day_sales s on s.id = sl.sale_id
  ),
  por_topping as (
    select sl.name, sum(sl.weight_g) as peso
      from public.sale_lines sl
      join day_sales s on s.id = sl.sale_id
     where sl.item_type = 'topping'
     group by sl.name
  ),
  toppings_json as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'name',   pt.name,
                 'peso_g', round(pt.peso, 2),
                 'pct',    case when tl.peso_toppings > 0
                                then round(100 * pt.peso / tl.peso_toppings, 2)
                                else 0 end
               )
               order by pt.peso desc
             ),
             '[]'::jsonb
           ) as items
      from por_topping pt
     cross join totales_linea tl
  )
  select jsonb_build_object(
           'location_id',     p_location_id,
           'day',             p_day,
           'ventas',          tv.ventas,
           'ingresos',        round(tv.ingresos, 2),
           'costos',          round(tv.costos, 2),
           'margen',          round(tv.margen, 2),
           'vasos',           tl.vasos,
           'cucharas',        tl.cucharas,
           'peso_helado_g',   round(tl.peso_helado, 2),
           'peso_toppings_g', round(tl.peso_toppings, 2),
           'toppings',        tj.items
         )
    into v_result
    from totales_venta tv
   cross join totales_linea tl
   cross join toppings_json tj;

  return v_result;
end;
$$;

revoke all on function public.daily_closing(uuid, date, int) from public;
grant execute on function public.daily_closing(uuid, date, int) to authenticated;

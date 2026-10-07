-- ============================================================================
--  TUTI'S — El peso lo pone la báscula, no la cajera
--
--  Correr DESPUÉS de 01..09. Es idempotente.
--
--  EL PROBLEMA (lo pidió el dueño, 2026-10-07)
--    En el sistema anterior la cajera lee la báscula y TECLEA el peso. Puede
--    escribir el que quiera, y en el ticket se ven líneas que se ponen y se
--    quitan ("1.5 Bubble Pop", "-1.5 Bubble Pop") sin que quede quién ni por
--    qué. Regla nueva: lo pesado queda fijo.
--
--  CÓMO QUEDA
--    · La caja toma el peso directo de la báscula. Cada venta lleva la
--      lectura cruda y el servidor la CLASIFICA (sales.weight_source):
--        bascula              el peso salió de la báscula y cuadra
--        bascula_no_cuadra    dice venir de la báscula, pero las líneas no
--                             suman lo que la báscula marcó
--        manual_autorizado    se tecleó con el PIN de una gerente
--        manual_sin_autorizar se tecleó sin PIN válido (p. ej. sin internet)
--        sin_dato             la venta no trae de dónde salió el peso
--        no_aplica            la venta no lleva nada pesado
--    · Si la báscula falla, la venta NO se detiene: se puede teclear el peso
--      con el PIN de la gerente. El PIN se valida AQUÍ, nunca en la pantalla.
--    · Un pedido ya pesado que se descarta sin cobrar queda en
--      order_voids. Es la otra mitad del control: si no, el truco sería
--      pesar, cobrar en efectivo y anular.
--
--  LO QUE ESTO NO PUEDE PROBAR, dicho claro:
--    La base no ve la báscula; ve lo que el navegador dice que leyó. Lo que
--    impide inventar lecturas desde la consola es el modo kiosko de la caja
--    (herramientas de desarrollador bloqueadas, ver caja/LEEME.md). Y engañar
--    a la báscula por fuera (TARA con producto encima, la mano en el plato)
--    no lo ve ningún software: eso lo destapa el cuadre de inventario.
--
--  NINGUNA de estas reglas tumba una venta. Una venta sincronizada desde la
--  cola sin conexión que llegue con una autorización inválida se registra
--  igual y queda marcada; rechazarla haría que la cola la descartara, y esa
--  venta sí ocurrió. Es la misma regla que con los puntos.
-- ============================================================================

-- pgcrypto: en Supabase ya viene instalada en el esquema "extensions".
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. LO QUE GUARDA CADA VENTA SOBRE SU PESO
-- ----------------------------------------------------------------------------
alter table public.sales add column if not exists weight_source  text;
alter table public.sales add column if not exists weight_auth_id uuid;
alter table public.sales add column if not exists scale_gross_g  numeric(12,2);
alter table public.sales add column if not exists scale_log      jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_weight_source_chk') then
    alter table public.sales add constraint sales_weight_source_chk check (
      weight_source is null or weight_source in
      ('bascula', 'bascula_no_cuadra', 'manual_autorizado', 'manual_sin_autorizar', 'sin_dato', 'no_aplica'));
  end if;
end $$;
-- Las ventas anteriores a este archivo quedan con weight_source NULL: no se
-- sabe de dónde salió su peso, y el reporte no las cuenta como incidentes.

-- ----------------------------------------------------------------------------
-- 2. LOS PIN DE LAS GERENTES
--    En el esquema "privado", que la API no publica. Ni la propia gerente
--    puede leer su hash: solo las funciones de abajo.
-- ----------------------------------------------------------------------------
create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create table if not exists privado.manager_pins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  pin_hash   text not null,
  updated_at timestamptz not null default now()
);

-- Cada intento de PIN, bueno o malo. Con 4 dígitos hay 10 000 combinaciones:
-- sin un tope de intentos, una cajera las prueba todas en una tarde.
create table if not exists privado.pin_attempts (
  id           bigserial primary key,
  requested_by uuid,
  manager_id   uuid,
  ok           boolean not null,
  at           timestamptz not null default now()
);
create index if not exists idx_pin_attempts_req on privado.pin_attempts(requested_by, at);
create index if not exists idx_pin_attempts_mgr on privado.pin_attempts(manager_id, at);

-- ----------------------------------------------------------------------------
-- 3. AUTORIZACIONES DE PESO A MANO
--    La gerente ve en pantalla los pesos tecleados y los aprueba con su PIN.
--    Lo aprobado es el TOTAL tecleado; process_sale revisa que la venta traiga
--    exactamente eso, y cada autorización sirve para una sola venta.
-- ----------------------------------------------------------------------------
create table if not exists public.weight_authorizations (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null references public.locations(id) on delete restrict,
  requested_by       uuid references public.profiles(id) on delete set null,
  requested_by_name  text,
  authorized_by      uuid references public.profiles(id) on delete set null,
  authorized_by_name text,
  weight_g           numeric(12,2) not null check (weight_g > 0 and weight_g <= 100000),
  reason             text not null,
  created_at         timestamptz not null default now(),
  sale_id            uuid references public.sales(id) on delete set null
);
create index if not exists idx_weight_auth_loc on public.weight_authorizations(location_id, created_at desc);

alter table public.weight_authorizations enable row level security;
-- Solo lectura, y solo para quien administra esa tienda. No hay política de
-- insert, update ni delete: solo escriben las funciones.
drop policy if exists weight_auth_select on public.weight_authorizations;
create policy weight_auth_select on public.weight_authorizations
  for select to authenticated
  using (public.can_manage_location(location_id));

-- ----------------------------------------------------------------------------
-- 4. PEDIDOS PESADOS QUE SE ANULARON SIN COBRAR
-- ----------------------------------------------------------------------------
create table if not exists public.order_voids (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations(id) on delete restrict,
  client_uuid    uuid not null unique,
  cashier_id     uuid references public.profiles(id) on delete set null,
  cashier_name   text,
  created_at     timestamptz not null default now(),
  weighed_g      numeric(12,2) not null default 0 check (weighed_g >= 0 and weighed_g <= 100000),
  items          jsonb,
  scale_log      jsonb,
  reason         text not null,
  synced_offline boolean not null default false
);
create index if not exists idx_order_voids_loc on public.order_voids(location_id, created_at desc);

alter table public.order_voids enable row level security;
drop policy if exists order_voids_select on public.order_voids;
create policy order_voids_select on public.order_voids
  for select to authenticated
  using (public.can_manage_location(location_id));

-- ----------------------------------------------------------------------------
-- 5. PONER O CAMBIAR MI PIN (gerente o propietario)
-- ----------------------------------------------------------------------------
create or replace function public.set_manager_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, privado
as $$
declare
  v_role user_role := public.app_role();
begin
  if v_role is null or v_role not in ('gerente', 'propietario') then
    raise exception 'Solo una gerente o el propietario pueden tener PIN de autorización';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'El PIN debe tener de 4 a 8 números';
  end if;
  -- Los primeros que prueba cualquiera.
  if p_pin ~ '^(.)\1+$'
     or position(p_pin in '01234567890123') > 0
     or position(p_pin in '98765432109876') > 0 then
    raise exception 'Ese PIN es demasiado fácil de adivinar. Elige otro.';
  end if;

  insert into privado.manager_pins (profile_id, pin_hash, updated_at)
  values (auth.uid(), crypt(p_pin, gen_salt('bf', 8)), now())
  on conflict (profile_id) do update
    set pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

create or replace function public.tengo_pin()
returns boolean
language sql
stable
security definer
set search_path = public, privado
as $$
  select exists (select 1 from privado.manager_pins where profile_id = auth.uid());
$$;

-- ----------------------------------------------------------------------------
-- 6. QUIÉN PUEDE AUTORIZAR EN ESTA TIENDA
--    Solo nombres. La cajera elige a la gerente y la gerente teclea su PIN:
--    así dos gerentes con el mismo PIN no se confunden, y nadie descubre el
--    PIN de otra al intentar ponerse el mismo.
-- ----------------------------------------------------------------------------
create or replace function public.gerentes_para_autorizar(p_location_id uuid)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, privado
as $$
  select p.id, coalesce(p.full_name, 'Sin nombre')
    from public.profiles p
    join privado.manager_pins mp on mp.profile_id = p.id
   where public.can_access_location(p_location_id)
     and p.active
     and (p.role = 'propietario' or (p.role = 'gerente' and p.location_id = p_location_id))
   order by p.role desc, p.full_name;
$$;

-- ----------------------------------------------------------------------------
-- 7. AUTORIZAR UN PESO TECLEADO
--    Devuelve {ok, id} o {ok:false, error}. No lanza excepción con un PIN
--    malo A PROPÓSITO: la excepción desharía también el registro del intento
--    fallido, y el tope de intentos no contaría nada.
-- ----------------------------------------------------------------------------
create or replace function public.autorizar_peso_manual(
  p_location_id uuid, p_manager_id uuid, p_pin text, p_weight_g numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, privado
as $$
declare
  v_me      public.profiles%rowtype;
  v_mgr     public.profiles%rowtype;
  v_hash    text;
  v_fallos  int;
  v_id      uuid;
  v_reason  text := left(btrim(coalesce(p_reason, '')), 200);
begin
  select * into v_me from public.profiles where id = auth.uid() and active;
  if v_me.id is null or not public.can_access_location(p_location_id) then
    raise exception 'No tiene permiso para operar en esa sucursal';
  end if;
  if p_weight_g is null or p_weight_g <= 0 or p_weight_g > 100000 then
    raise exception 'Peso fuera de rango';
  end if;
  if length(v_reason) < 3 then
    raise exception 'Escribe el motivo';
  end if;

  -- Tope: 5 fallos en 15 minutos, contados por quien pide Y por la gerente.
  -- Lo segundo impide repartirse los intentos entre varias cuentas.
  select count(*) into v_fallos from privado.pin_attempts
   where not ok and at > now() - interval '15 minutes'
     and (requested_by = v_me.id or manager_id = p_manager_id);
  if v_fallos >= 5 then
    return jsonb_build_object('ok', false,
      'error', 'Demasiados intentos con PIN equivocado. Espera 15 minutos.');
  end if;

  select * into v_mgr from public.profiles
   where id = p_manager_id and active
     and (role = 'propietario' or (role = 'gerente' and location_id = p_location_id));
  select pin_hash into v_hash from privado.manager_pins where profile_id = v_mgr.id;

  if v_mgr.id is null or v_hash is null or crypt(coalesce(p_pin, ''), v_hash) <> v_hash then
    insert into privado.pin_attempts (requested_by, manager_id, ok) values (v_me.id, p_manager_id, false);
    return jsonb_build_object('ok', false, 'error', 'PIN incorrecto.');
  end if;

  insert into privado.pin_attempts (requested_by, manager_id, ok) values (v_me.id, v_mgr.id, true);

  insert into public.weight_authorizations
    (location_id, requested_by, requested_by_name, authorized_by, authorized_by_name, weight_g, reason)
  values
    (p_location_id, v_me.id, v_me.full_name, v_mgr.id, v_mgr.full_name, round(p_weight_g, 2), v_reason)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'authorized_by_name', v_mgr.full_name);
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. REGISTRAR UN PEDIDO PESADO QUE SE ANULÓ
--    Idempotente por client_uuid, igual que las ventas: viaja por la misma
--    clase de cola cuando no hay internet.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_anulacion(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid := (payload->>'location_id')::uuid;
  v_client_uuid uuid := (payload->>'client_uuid')::uuid;
  v_me          public.profiles%rowtype;
  v_peso        numeric := coalesce((payload->>'weighed_g')::numeric, 0);
  v_reason      text := left(btrim(coalesce(payload->>'reason', '')), 200);
  v_id          uuid;
begin
  if v_location_id is null or v_client_uuid is null then
    raise exception 'Falta location_id o client_uuid';
  end if;
  select * into v_me from public.profiles where id = auth.uid() and active;
  if v_me.id is null or not public.can_access_location(v_location_id) then
    raise exception 'No tiene permiso para operar en esa sucursal';
  end if;
  if v_peso < 0 or v_peso > 100000 then
    raise exception 'Peso fuera de rango';
  end if;
  if length(v_reason) < 3 then v_reason := '(sin motivo)'; end if;

  insert into public.order_voids
    (location_id, client_uuid, cashier_id, cashier_name, created_at, weighed_g,
     items, scale_log, reason, synced_offline)
  values
    (v_location_id, v_client_uuid, v_me.id, v_me.full_name,
     coalesce((payload->>'created_at')::timestamptz, now()),
     round(v_peso, 2),
     case when length(coalesce(payload->'items', 'null'::jsonb)::text) <= 4000 then payload->'items' end,
     case when length(coalesce(payload->'scale_log', 'null'::jsonb)::text) <= 6000 then payload->'scale_log' end,
     v_reason,
     coalesce((payload->>'synced_offline')::boolean, false))
  on conflict (client_uuid) do nothing
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'duplicate', v_id is null);
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. process_sale, AHORA CLASIFICANDO EL ORIGEN DEL PESO
--    Es la misma función de 08_fidelizacion.sql con un bloque nuevo (marcado
--    "PESO"). Todo lo demás queda igual.
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
  v_lines        jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_peso         numeric;
  v_costo        numeric;
  v_precio       numeric;
  v_tot_peso     numeric := 0;
  v_tot_costo    numeric := 0;
  v_tot_precio   numeric := 0;
  -- fidelización
  v_cliente      uuid := nullif(payload->>'customer_id', '')::uuid;
  v_pide_canje   int  := greatest(0, coalesce((payload->>'redeem_points')::int, 0));
  v_cfg          public.loyalty_config%rowtype;
  v_saldo        int;
  v_canje        int := 0;
  v_descuento    numeric := 0;
  v_gana         int := 0;
  v_total_final  numeric;
  -- peso
  v_modo         text := payload->>'weight_mode';
  v_pesado       numeric := 0;   -- helado + toppings: lo que pasó por la báscula
  v_tara         numeric := 0;   -- vasos, del catálogo
  v_bruto        numeric;
  v_log          jsonb := payload->'scale_log';
  v_auth_id      uuid;
  v_auth         public.weight_authorizations%rowtype;
  v_origen       text;
begin
  if v_location_id is null or v_client_uuid is null then
    raise exception 'Falta location_id o client_uuid en la venta';
  end if;

  select * into v_profile from public.profiles where id = auth.uid() and active;
  if v_profile.id is null then
    raise exception 'Usuario sin perfil activo';
  end if;

  if v_profile.role <> 'propietario' and v_profile.location_id is distinct from v_location_id then
    raise exception 'No tiene permiso para registrar ventas en esa sucursal';
  end if;

  select * into v_existing from public.sales where client_uuid = v_client_uuid;
  if v_existing.id is not null then
    return jsonb_build_object('sale_id', v_existing.id, 'folio', v_existing.folio, 'duplicate', true,
                              'points_earned', v_existing.points_earned,
                              'points_redeemed', v_existing.points_redeemed,
                              'discount', v_existing.discount,
                              'weight_source', v_existing.weight_source);
  end if;

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_peso   := coalesce((v_line->>'weight_g')::numeric, 0);
    v_costo  := coalesce((v_line->>'cost')::numeric, 0);
    v_precio := coalesce((v_line->>'price_contribution')::numeric, 0);

    if v_peso < 0 then
      raise exception 'Peso negativo en la línea "%": una venta no puede devolver producto al inventario',
        coalesce(v_line->>'name', '?');
    end if;
    if v_costo < 0 or v_precio < 0 then
      raise exception 'Costo o precio negativo en la línea "%"', coalesce(v_line->>'name', '?');
    end if;
    if v_peso > 100000 then
      raise exception 'Peso fuera de rango en la línea "%"', coalesce(v_line->>'name', '?');
    end if;

    v_tot_peso   := v_tot_peso + v_peso;
    v_tot_costo  := v_tot_costo + v_costo;
    v_tot_precio := v_tot_precio + v_precio;

    if (v_line->>'item_type') in ('helado', 'topping') then
      v_pesado := v_pesado + v_peso;
    elsif (v_line->>'item_type') = 'vaso' then
      v_tara := v_tara + v_peso;
    end if;
  end loop;

  -- --- PESO -----------------------------------------------------------------
  -- Se clasifica, nunca se rechaza (ver encabezado).
  begin
    v_bruto := nullif(payload->>'scale_gross_g', '')::numeric;
  exception when others then
    v_bruto := null;
  end;
  begin
    v_auth_id := nullif(payload->>'weight_auth_id', '')::uuid;
  exception when others then
    v_auth_id := null;
  end;
  if v_log is not null and (jsonb_typeof(v_log) <> 'array' or length(v_log::text) > 6000) then
    v_log := null;
  end if;

  if v_pesado = 0 then
    v_origen := 'no_aplica';
    v_auth_id := null;
  elsif v_modo = 'bascula' then
    v_auth_id := null;
    if v_bruto is null or v_log is null or jsonb_array_length(v_log) = 0 then
      v_origen := 'sin_dato';
    elsif abs(v_bruto - (v_pesado + v_tara)) > 1 then
      -- La báscula marcó una cosa y las líneas dicen otra: se quitó algo
      -- después de pesarlo, o el mensaje no salió de la pantalla de venta.
      v_origen := 'bascula_no_cuadra';
    else
      v_origen := 'bascula';
    end if;
  elsif v_modo = 'manual' and v_auth_id is not null then
    -- Se bloquea la autorización: dos ventas no pueden usar la misma.
    select * into v_auth from public.weight_authorizations
     where id = v_auth_id for update;
    if v_auth.id is not null
       and v_auth.location_id = v_location_id
       and v_auth.sale_id is null
       and abs(v_auth.weight_g - v_pesado) <= 1 then
      v_origen := 'manual_autorizado';
    else
      v_origen := 'manual_sin_autorizar';
      v_auth_id := null;
    end if;
  elsif v_modo in ('manual', 'manual_sin_conexion') then
    v_origen := 'manual_sin_autorizar';
    v_auth_id := null;
  else
    v_origen := 'sin_dato';
    v_auth_id := null;
  end if;

  -- --- Fidelización ---------------------------------------------------------
  select * into v_cfg from public.loyalty_config where id;

  -- Esta revisión va SIEMPRE que venga un cliente, esté o no activo el
  -- programa: si el cliente ya no existe, la venta chocaría con la llave
  -- foránea de sales.customer_id y se perdería igual.
  if v_cliente is not null then
    -- Se bloquea la fila del cliente hasta el final de la transacción. Sin
    -- esto, dos cajas cobrándole al mismo cliente a la vez podrían canjear
    -- ambas el mismo saldo.
    select points_balance into v_saldo from public.customers
     where id = v_cliente and active for update;

    if v_saldo is null then
      -- Si pedía CANJEAR, sí se rechaza: eso solo pasa en línea y la cajera
      -- tiene que enterarse antes de cobrar.
      if v_pide_canje > 0 then
        raise exception 'El cliente del carnet no existe o está inactivo';
      end if;
      -- Si solo iba a GANAR puntos, la venta se registra igual, sin cliente.
      v_cliente := null;
    end if;
  end if;

  if v_cliente is not null and v_cfg.activo then

    if v_pide_canje > 0 then
      if v_saldo < v_cfg.canje_minimo then
        raise exception 'El cliente necesita al menos % puntos para canjear', v_cfg.canje_minimo;
      end if;
      if v_pide_canje > v_saldo then
        raise exception 'El cliente solo tiene % puntos', v_saldo;
      end if;
      -- El tope se vuelve a calcular aquí, aunque la pantalla ya lo haya
      -- consultado: lo que decide es el servidor.
      v_canje := least(v_pide_canje,
                       case when v_cfg.valor_punto > 0
                            then floor(round(v_tot_precio * v_cfg.canje_max_pct / 100, 2) / v_cfg.valor_punto)::int
                            else 0 end);
      v_descuento := round(v_canje * v_cfg.valor_punto, 2);
      if v_descuento > v_tot_precio then
        v_descuento := v_tot_precio;
      end if;
    end if;

    -- Los puntos se ganan sobre lo que el cliente REALMENTE pagó.
    v_total_final := v_tot_precio - v_descuento;
    if v_total_final >= v_cfg.compra_minima then
      v_gana := floor(v_total_final / v_cfg.monto_por_punto)::int;
    end if;
  else
    v_total_final := v_tot_precio;
  end if;

  select currency_code into v_currency from public.locations where id = v_location_id;

  perform pg_advisory_xact_lock(hashtextextended(v_location_id::text, 0));
  select coalesce(max(folio), 0) + 1 into v_folio
    from public.sales where location_id = v_location_id;

  insert into public.sales (
    location_id, client_uuid, folio, cashier_id, cashier_name, created_at,
    gross_weight_g, total_price, total_cost, margin, margin_pct,
    currency_code, payment_method, customer_name, customer_tax_id, synced_offline,
    customer_id, points_earned, points_redeemed, discount,
    weight_source, weight_auth_id, scale_gross_g, scale_log
  ) values (
    v_location_id, v_client_uuid, v_folio, v_profile.id, v_profile.full_name, v_created_at,
    round(v_tot_peso, 2),
    round(v_total_final, 2),
    round(v_tot_costo, 2),
    round(v_total_final - v_tot_costo, 2),
    case when v_total_final > 0
         then round(100 * (v_total_final - v_tot_costo) / v_total_final, 2) else 0 end,
    coalesce(v_currency, payload->>'currency_code'),
    payload->>'payment_method',
    payload->>'customer_name',
    payload->>'customer_tax_id',
    coalesce((payload->>'synced_offline')::boolean, false),
    v_cliente, v_gana, v_canje, v_descuento,
    v_origen, v_auth_id, round(v_bruto, 2), v_log
  )
  returning id into v_sale_id;

  if v_origen = 'manual_autorizado' then
    update public.weight_authorizations set sale_id = v_sale_id where id = v_auth_id;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    insert into public.sale_lines (
      sale_id, location_id, item_type, ref_id, name, weight_g, cost,
      price_contribution, is_premium_surcharge
    ) values (
      v_sale_id, v_location_id,
      (v_line->>'item_type')::sale_item_type,
      nullif(v_line->>'ref_id', '')::uuid,
      coalesce(v_line->>'name', ''),
      coalesce((v_line->>'weight_g')::numeric, 0),
      coalesce((v_line->>'cost')::numeric, 0),
      coalesce((v_line->>'price_contribution')::numeric, 0),
      coalesce((v_line->>'is_premium_surcharge')::boolean, false)
    );

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

  -- Mover los puntos va DESPUÉS de que la venta existe, para que cada
  -- movimiento pueda apuntar a su venta.
  if v_cliente is not null then
    if v_canje > 0 then
      update public.customers set points_balance = points_balance - v_canje where id = v_cliente;
      insert into public.loyalty_transactions (customer_id, location_id, sale_id, kind, points, amount, created_by)
      values (v_cliente, v_location_id, v_sale_id, 'canje', -v_canje, v_descuento, v_profile.id);
    end if;
    if v_gana > 0 then
      update public.customers set points_balance = points_balance + v_gana where id = v_cliente;
      insert into public.loyalty_transactions (customer_id, location_id, sale_id, kind, points, amount, created_by)
      values (v_cliente, v_location_id, v_sale_id, 'gana', v_gana, v_total_final, v_profile.id);
    end if;
    update public.customers
       set total_spent = total_spent + v_total_final,
           visits      = visits + 1
     where id = v_cliente;
  end if;

  return jsonb_build_object(
    'sale_id', v_sale_id, 'folio', v_folio, 'duplicate', false,
    'points_earned', v_gana, 'points_redeemed', v_canje, 'discount', v_descuento,
    'total', round(v_total_final, 2), 'weight_source', v_origen);
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. EL REPORTE: CONTROL DE PESOS POR CAJERA
--     Una llamada por sucursal, igual que dashboard_summary: el permiso se
--     revisa tienda por tienda.
-- ----------------------------------------------------------------------------
create or replace function public.control_pesos(
  p_location_id uuid, p_from date, p_to date, p_utc_offset_hours int default -6)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end   timestamptz;
  v_res   jsonb;
begin
  if not public.can_manage_location(p_location_id) then
    raise exception 'No tiene permiso para ver esa sucursal';
  end if;
  v_start := (p_from::timestamp       - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';
  v_end   := ((p_to + 1)::timestamp   - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';

  with v as (
    select s.* from public.sales s
     where s.location_id = p_location_id
       and s.created_at >= v_start and s.created_at < v_end
       and s.weight_source is not null
  ), a as (
    select * from public.order_voids o
     where o.location_id = p_location_id
       and o.created_at >= v_start and o.created_at < v_end
  ), cajeras as (
    select coalesce(cashier_name, '(sin nombre)') as cajera from v
    union select coalesce(cashier_name, '(sin nombre)') from a
  ), por_cajera as (
    select c.cajera,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source <> 'no_aplica') as ventas_pesadas,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source = 'bascula') as bascula,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source = 'bascula_no_cuadra') as no_cuadra,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source = 'manual_autorizado') as manual_autorizado,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source = 'manual_sin_autorizar') as manual_sin_autorizar,
      (select count(*) from v where coalesce(v.cashier_name, '(sin nombre)') = c.cajera and v.weight_source = 'sin_dato') as sin_dato,
      (select count(*) from a where coalesce(a.cashier_name, '(sin nombre)') = c.cajera) as anulaciones,
      (select coalesce(sum(a.weighed_g), 0) from a where coalesce(a.cashier_name, '(sin nombre)') = c.cajera) as gramos_anulados
    from cajeras c
  ), incidentes as (
    select 'venta' as tipo, v.created_at as fecha, v.folio, v.cashier_name as cajera,
           v.weight_source as clase,
           (select coalesce(sum(l.weight_g), 0) from public.sale_lines l
             where l.sale_id = v.id and l.item_type in ('helado', 'topping')) as peso_g,
           v.total_price as total, w.authorized_by_name as autorizo, w.reason as motivo
      from v left join public.weight_authorizations w on w.id = v.weight_auth_id
     where v.weight_source in ('bascula_no_cuadra', 'manual_autorizado', 'manual_sin_autorizar', 'sin_dato')
    union all
    select 'anulacion', a.created_at, null, a.cashier_name, 'anulacion',
           a.weighed_g, null, null, a.reason
      from a
  )
  select jsonb_build_object(
    'por_cajera', coalesce((select jsonb_agg(to_jsonb(p) order by p.cajera) from por_cajera p), '[]'::jsonb),
    'incidentes', coalesce((select jsonb_agg(to_jsonb(i) order by i.fecha desc)
                              from (select * from incidentes order by fecha desc limit 100) i), '[]'::jsonb)
  ) into v_res;

  return v_res;
end;
$$;

-- ----------------------------------------------------------------------------
-- 11. PERMISOS DE LAS FUNCIONES
--     Ninguna para anon. Todas validan adentro quién llama.
-- ----------------------------------------------------------------------------
revoke all on function public.set_manager_pin(text) from public, anon;
revoke all on function public.tengo_pin() from public, anon;
revoke all on function public.gerentes_para_autorizar(uuid) from public, anon;
revoke all on function public.autorizar_peso_manual(uuid, uuid, text, numeric, text) from public, anon;
revoke all on function public.registrar_anulacion(jsonb) from public, anon;
revoke all on function public.process_sale(jsonb) from public, anon;
revoke all on function public.control_pesos(uuid, date, date, int) from public, anon;

grant execute on function public.set_manager_pin(text) to authenticated;
grant execute on function public.tengo_pin() to authenticated;
grant execute on function public.gerentes_para_autorizar(uuid) to authenticated;
grant execute on function public.autorizar_peso_manual(uuid, uuid, text, numeric, text) to authenticated;
grant execute on function public.registrar_anulacion(jsonb) to authenticated;
grant execute on function public.process_sale(jsonb) to authenticated;
grant execute on function public.control_pesos(uuid, date, date, int) to authenticated;

grant select on public.weight_authorizations, public.order_voids to authenticated;

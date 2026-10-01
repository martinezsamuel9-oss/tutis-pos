-- ============================================================================
--  TUTI'S — Fidelización: clientes, puntos y carnet digital
--
--  Correr DESPUÉS de 01..07. Es idempotente.
--
--  CÓMO FUNCIONA EL PROGRAMA  (regla del negocio, 2026-10-01)
--    "Se entrega un lempira por cada dólar gastado, o su equivalente."
--
--    · Cada cliente tiene un código de carnet (el del QR). Con ese código se
--      le encuentra en la caja, y es lo que va dentro del pase de Apple
--      Wallet y Google Wallet.
--    · Gana 1 punto por cada `monto_por_punto` lempiras que gasta. Ese monto
--      es el equivalente de un dólar: con el dólar a L 27, una compra de
--      L 87.75 da 3 puntos.
--    · Cada punto vale `valor_punto` al canjearlo: L 1.00. Para la clienta es
--      lo más claro que puede ser — sus puntos SON lempiras.
--    · Cuando se mueva el dólar, se cambia `monto_por_punto` y listo. No se
--      actualiza solo a propósito: es una decisión comercial, no un cálculo.
--
--  DECISIÓN DE ALCANCE (la pidió el dueño, 2026-10-01)
--    Los puntos son de LA MARCA, no de la tienda: se acumulan en Galerías y
--    se pueden canjear en Multiplaza. Eso obliga a que la tabla de clientes
--    sea compartida, que es la única excepción al aislamiento entre
--    sucursales en todo el sistema. Está acotada a propósito:
--      · Compartido: nombre, teléfono y SALDO de puntos.
--      · NO compartido: los movimientos llevan `location_id` y cada gerente
--        solo ve los de SU tienda. Nadie ve las ventas de la otra.
--
--  EL SALDO NO SE PUEDE EDITAR A MANO. La columna `points_balance` tiene
--  revocado el UPDATE para todo el mundo; solo la mueven las funciones de
--  este archivo, y cada movimiento queda en el libro `loyalty_transactions`.
--  Sin eso, el programa de puntos sería dinero que cualquier cajera podría
--  imprimir.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. REGLAS DEL PROGRAMA
--    Una sola fila. Las reglas son de la marca, igual que los puntos.
-- ----------------------------------------------------------------------------
create table if not exists public.loyalty_config (
  id                 boolean primary key default true check (id),
  activo             boolean not null default true,
  -- Cuántos lempiras hay que gastar para ganar UN punto: el equivalente de un
  -- dólar. Referencia BCH al 2026-10-01: L 26.90 compra / L 27.03 venta.
  monto_por_punto    numeric(10,2) not null default 27.00 check (monto_por_punto > 0),
  -- Cuánto vale cada punto al canjearlo. 1.00 = un punto es un lempira.
  valor_punto        numeric(10,4) not null default 1.00 check (valor_punto >= 0),
  -- Mínimos, para que el programa no se vuelva ingobernable.
  compra_minima      numeric(10,2) not null default 0  check (compra_minima >= 0),
  canje_minimo       integer       not null default 20 check (canje_minimo >= 0),
  -- Tope de descuento por venta, en porcentaje del total. Evita que alguien
  -- se lleve un helado gratis vaciando el saldo de una sola vez.
  canje_max_pct      numeric(5,2)  not null default 50 check (canje_max_pct between 0 and 100),
  actualizado_en     timestamptz   not null default now()
);

-- Por si este archivo corre sobre una base donde existía la versión anterior
-- de las reglas (puntos_por_moneda): se agrega la columna nueva y se quita la
-- vieja. En una base nueva estas dos líneas no hacen nada.
alter table public.loyalty_config add column if not exists monto_por_punto numeric(10,2) not null default 27.00;
alter table public.loyalty_config drop column if exists puntos_por_moneda;

insert into public.loyalty_config (id) values (true) on conflict (id) do nothing;

alter table public.loyalty_config enable row level security;

drop policy if exists loyalty_config_select on public.loyalty_config;
create policy loyalty_config_select on public.loyalty_config
  for select to authenticated using (true);

-- Cambiar las reglas mueve dinero: solo el propietario.
drop policy if exists loyalty_config_update on public.loyalty_config;
create policy loyalty_config_update on public.loyalty_config
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

grant select on public.loyalty_config to authenticated;
grant update on public.loyalty_config to authenticated;
revoke all on public.loyalty_config from anon;

-- ----------------------------------------------------------------------------
-- 2. CLIENTES
--    El código del carnet es el que viaja en el QR y en los pases de wallet.
--    Se genera sin caracteres que se confundan al dictarlo por teléfono (sin
--    O/0, sin I/1/L): una cajera lo va a leer en voz alta.
-- ----------------------------------------------------------------------------
create table if not exists public.customers (
  id             uuid primary key default gen_random_uuid(),
  card_code      text not null unique,
  full_name      text not null,
  phone          text,
  email          text,
  birth_date     date,
  points_balance integer not null default 0 check (points_balance >= 0),
  total_spent    numeric(14,2) not null default 0,
  visits         integer not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  -- En qué tienda se inscribió. Solo informativo: el cliente es de la marca.
  created_location_id uuid references public.locations(id) on delete set null,
  created_by     uuid references public.profiles(id) on delete set null
);

create index if not exists idx_customers_phone on public.customers(phone);
create index if not exists idx_customers_name  on public.customers(lower(full_name));

create or replace function public.generar_codigo_carnet()
returns text
language plpgsql
volatile
as $$
declare
  -- Sin O, 0, I, 1 ni L: se confunden al dictarlos.
  v_alfabeto text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_codigo   text;
  v_i        int;
  v_intento  int := 0;
begin
  loop
    v_codigo := '';
    for v_i in 1..10 loop
      v_codigo := v_codigo || substr(v_alfabeto, 1 + floor(random() * length(v_alfabeto))::int, 1);
    end loop;
    exit when not exists (select 1 from public.customers where card_code = v_codigo);
    v_intento := v_intento + 1;
    if v_intento > 50 then
      raise exception 'No se pudo generar un código de carnet único';
    end if;
  end loop;
  return v_codigo;
end;
$$;

alter table public.customers enable row level security;

-- Leer: cualquier empleado activo. Es la excepción al aislamiento, y es la
-- que hace posible canjear en la otra tienda.
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated
  using (public.app_role() is not null);

-- Inscribir: cualquier empleado activo, porque las inscripciones pasan en la
-- caja, con el cliente enfrente.
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert to authenticated
  with check (public.app_role() is not null);

-- Corregir datos: gerente o propietario. La cajera inscribe, no edita.
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
  for update to authenticated
  using (public.app_role() in ('gerente','propietario'))
  with check (public.app_role() in ('gerente','propietario'));

drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers
  for delete to authenticated using (public.is_owner());

-- Columna por columna: el saldo, el gasto acumulado y las visitas NO están en
-- la lista. Nadie puede tocarlos con un UPDATE directo, solo las funciones.
grant select, insert, delete on public.customers to authenticated;
grant update (full_name, phone, email, birth_date, active) on public.customers to authenticated;
revoke all on public.customers from anon;

-- ----------------------------------------------------------------------------
-- 3. EL LIBRO DE MOVIMIENTOS
--    El saldo de arriba es una copia para poder leerlo rápido. La verdad está
--    aquí: cada punto que entra o sale deja su fila, con quién, dónde y por
--    qué venta.
-- ----------------------------------------------------------------------------
create table if not exists public.loyalty_transactions (
  id          bigserial primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  sale_id     uuid references public.sales(id) on delete set null,
  kind        text not null check (kind in ('gana','canje','ajuste','vence')),
  points      integer not null,
  amount      numeric(12,2),
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_loyalty_customer on public.loyalty_transactions(customer_id, created_at desc);
create index if not exists idx_loyalty_location on public.loyalty_transactions(location_id, created_at desc);

alter table public.loyalty_transactions enable row level security;

-- Aquí SÍ se mantiene el aislamiento: el propietario ve todo, cada gerente
-- solo los movimientos de su tienda. Así el saldo es compartido pero el
-- detalle de dónde se gastó no cruza entre sucursales.
drop policy if exists loyalty_tx_select on public.loyalty_transactions;
create policy loyalty_tx_select on public.loyalty_transactions
  for select to authenticated
  using (location_id is null or public.can_access_location(location_id));

-- No hay política de INSERT, UPDATE ni DELETE a propósito: los puntos solo se
-- mueven por las funciones de abajo, igual que las ventas solo entran por
-- process_sale.
grant select on public.loyalty_transactions to authenticated;
revoke all on public.loyalty_transactions from anon;
revoke all on sequence public.loyalty_transactions_id_seq from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. INSCRIBIR A UN CLIENTE
--    Devuelve el cliente con su código de carnet ya generado.
-- ----------------------------------------------------------------------------
create or replace function public.loyalty_registrar(
  p_full_name  text,
  p_phone      text default null,
  p_email      text default null,
  p_birth_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perfil public.profiles%rowtype;
  v_id     uuid;
  v_codigo text;
begin
  select * into v_perfil from public.profiles where id = auth.uid() and active;
  if v_perfil.id is null then
    raise exception 'Usuario sin perfil activo';
  end if;
  if coalesce(trim(p_full_name), '') = '' then
    raise exception 'El cliente necesita un nombre';
  end if;

  -- Un mismo teléfono no se inscribe dos veces: si no, la clienta termina con
  -- los puntos repartidos entre dos carnets y ninguno le alcanza.
  if coalesce(trim(p_phone), '') <> '' then
    select id into v_id from public.customers
     where phone = trim(p_phone) and active limit 1;
    if v_id is not null then
      raise exception 'Ya hay un cliente inscrito con ese teléfono';
    end if;
  end if;

  v_codigo := public.generar_codigo_carnet();

  insert into public.customers (card_code, full_name, phone, email, birth_date,
                                created_location_id, created_by)
  values (v_codigo, trim(p_full_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
          p_birth_date, v_perfil.location_id, v_perfil.id)
  returning id into v_id;

  return (select to_jsonb(c) from public.customers c where c.id = v_id);
end;
$$;

revoke all on function public.loyalty_registrar(text, text, text, date) from public, anon;
grant execute on function public.loyalty_registrar(text, text, text, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. BUSCAR UN CLIENTE EN LA CAJA
--    Por código de carnet, por teléfono o por nombre. Devuelve lo justo para
--    cobrar: quién es y cuántos puntos tiene.
-- ----------------------------------------------------------------------------
create or replace function public.loyalty_buscar(p_texto text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := trim(coalesce(p_texto, ''));
begin
  if public.app_role() is null then
    raise exception 'Usuario sin perfil activo';
  end if;
  if length(v_q) < 3 then
    raise exception 'Escribe al menos 3 caracteres para buscar';
  end if;

  return (
    select coalesce(jsonb_agg(x order by x->>'full_name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', c.id, 'card_code', c.card_code, 'full_name', c.full_name,
                 'phone', c.phone, 'points_balance', c.points_balance,
                 'visits', c.visits, 'active', c.active) as x
          from public.customers c
         where c.active
           and (upper(c.card_code) = upper(v_q)
                or c.phone = v_q
                or c.phone like '%' || v_q || '%'
                or lower(c.full_name) like '%' || lower(v_q) || '%')
         limit 15
      ) s
  );
end;
$$;

revoke all on function public.loyalty_buscar(text) from public, anon;
grant execute on function public.loyalty_buscar(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. CUÁNTO PUEDE CANJEAR EN ESTA VENTA
--    Lo calcula el servidor, no la pantalla. La caja lo usa para mostrarle a
--    la cajera el tope real antes de cobrar.
-- ----------------------------------------------------------------------------
create or replace function public.loyalty_canje_maximo(p_customer_id uuid, p_total numeric)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg    public.loyalty_config%rowtype;
  v_saldo  int;
  v_tope   numeric;
  v_puntos int;
begin
  if public.app_role() is null then
    raise exception 'Usuario sin perfil activo';
  end if;

  select * into v_cfg from public.loyalty_config where id;
  select points_balance into v_saldo from public.customers where id = p_customer_id and active;
  if v_saldo is null then
    return jsonb_build_object('puntos', 0, 'descuento', 0, 'motivo', 'Cliente no encontrado');
  end if;
  if not v_cfg.activo then
    return jsonb_build_object('puntos', 0, 'descuento', 0, 'motivo', 'El programa está desactivado');
  end if;
  if v_saldo < v_cfg.canje_minimo then
    return jsonb_build_object('puntos', 0, 'descuento', 0,
      'motivo', format('Necesita al menos %s puntos para canjear', v_cfg.canje_minimo));
  end if;

  -- El descuento no puede pasar del tope configurado sobre el total.
  v_tope   := round(coalesce(p_total, 0) * v_cfg.canje_max_pct / 100, 2);
  v_puntos := least(v_saldo, case when v_cfg.valor_punto > 0
                                  then floor(v_tope / v_cfg.valor_punto)::int
                                  else 0 end);

  return jsonb_build_object(
    'puntos',    v_puntos,
    'descuento', round(v_puntos * v_cfg.valor_punto, 2),
    'saldo',     v_saldo,
    'motivo',    null);
end;
$$;

revoke all on function public.loyalty_canje_maximo(uuid, numeric) from public, anon;
grant execute on function public.loyalty_canje_maximo(uuid, numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. AJUSTE MANUAL (gerente o propietario)
--    Para corregir un error o regalar puntos en una promoción. Siempre deja
--    rastro y siempre exige una razón escrita.
-- ----------------------------------------------------------------------------
create or replace function public.loyalty_ajustar(
  p_customer_id uuid,
  p_puntos      integer,
  p_nota        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perfil public.profiles%rowtype;
  v_saldo  int;
begin
  select * into v_perfil from public.profiles where id = auth.uid() and active;
  if v_perfil.id is null or v_perfil.role not in ('gerente','propietario') then
    raise exception 'Solo un gerente o el propietario puede ajustar puntos';
  end if;
  if p_puntos = 0 then
    raise exception 'El ajuste no puede ser de cero puntos';
  end if;
  if coalesce(trim(p_nota), '') = '' then
    raise exception 'Escribe por qué se hace el ajuste';
  end if;

  -- Bloquea la fila mientras se recalcula, para que dos ajustes a la vez no
  -- se pisen y dejen el saldo mal.
  select points_balance into v_saldo from public.customers
   where id = p_customer_id and active for update;
  if v_saldo is null then
    raise exception 'Cliente no encontrado';
  end if;
  if v_saldo + p_puntos < 0 then
    raise exception 'El cliente solo tiene % puntos', v_saldo;
  end if;

  update public.customers set points_balance = points_balance + p_puntos
   where id = p_customer_id;

  insert into public.loyalty_transactions (customer_id, location_id, kind, points, note, created_by)
  values (p_customer_id, v_perfil.location_id, 'ajuste', p_puntos, trim(p_nota), v_perfil.id);

  return (select to_jsonb(c) from public.customers c where c.id = p_customer_id);
end;
$$;

revoke all on function public.loyalty_ajustar(uuid, integer, text) from public, anon;
grant execute on function public.loyalty_ajustar(uuid, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. EL CARNET, VISTO POR EL CLIENTE
--    Esta es la ÚNICA función que puede llamar alguien sin iniciar sesión, y
--    es deliberado: el carnet tiene que abrirse desde el teléfono de la
--    clienta, que no tiene usuario en el sistema.
--
--    El código de 10 caracteres hace de llave. Por eso devuelve lo mínimo —
--    nombre de pila y saldo — y nunca el teléfono, el correo ni el historial.
--    Quien tenga el código ya tiene el carnet en la mano.
-- ----------------------------------------------------------------------------
create or replace function public.loyalty_carnet(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c   public.customers%rowtype;
  v_cfg public.loyalty_config%rowtype;
begin
  if coalesce(trim(p_code), '') = '' then
    return null;
  end if;

  select * into v_c from public.customers
   where upper(card_code) = upper(trim(p_code)) and active;
  if v_c.id is null then
    return null;
  end if;

  select * into v_cfg from public.loyalty_config where id;

  return jsonb_build_object(
    'card_code', v_c.card_code,
    -- Solo el primer nombre: el carnet se ve en la pantalla de un teléfono,
    -- a veces delante de otra gente en la fila.
    'nombre',    split_part(v_c.full_name, ' ', 1),
    'puntos',    v_c.points_balance,
    'vale',      round(v_c.points_balance * v_cfg.valor_punto, 2),
    'desde',     v_c.created_at::date
  );
end;
$$;

revoke all on function public.loyalty_carnet(text) from public;
grant execute on function public.loyalty_carnet(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9. LA VENTA, AHORA CON CLIENTE Y PUNTOS
--
--    Columnas nuevas en `sales`. El descuento se guarda aparte del total
--    porque el total se calcula de las líneas (ver 05_endurecimiento.sql), y
--    un canje no es una línea: es dinero que se descuenta al final.
--
--    REGLA QUE NO HAY QUE ROMPER: el descuento lo calcula el servidor a
--    partir de los puntos canjeados y de `valor_punto`. La pantalla manda
--    CUÁNTOS PUNTOS quiere canjear, nunca cuánto dinero. Si mandara el monto,
--    cualquiera con la consola abierta se regalaría el helado.
-- ----------------------------------------------------------------------------
alter table public.sales add column if not exists customer_id     uuid references public.customers(id) on delete set null;
alter table public.sales add column if not exists points_earned   integer not null default 0;
alter table public.sales add column if not exists points_redeemed integer not null default 0;
alter table public.sales add column if not exists discount        numeric(12,2) not null default 0;

create index if not exists idx_sales_customer on public.sales(customer_id, created_at desc);

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
                              'discount', v_existing.discount);
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
  end loop;

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
      -- Es el caso de una venta cobrada sin internet cuyo cliente fue
      -- desactivado antes de sincronizar: la cola de envío descarta los
      -- rechazos, y una venta que sí ocurrió no se puede perder por culpa
      -- de los puntos.
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

    -- Los puntos se ganan sobre lo que el cliente REALMENTE pagó, no sobre el
    -- precio de lista. Si no, canjear puntos generaría puntos nuevos y el
    -- programa se alimentaría a sí mismo.
    v_total_final := v_tot_precio - v_descuento;
    if v_total_final >= v_cfg.compra_minima then
      -- floor: un punto por cada dólar COMPLETO gastado. L 50 con el dólar a
      -- L 27 da 1 punto, no 1.85.
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
    customer_id, points_earned, points_redeemed, discount
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
    v_cliente, v_gana, v_canje, v_descuento
  )
  returning id into v_sale_id;

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
    'total', round(v_total_final, 2));
end;
$$;

revoke all on function public.process_sale(jsonb) from public;
grant execute on function public.process_sale(jsonb) to authenticated;

-- Los cambios de datos de un cliente también dejan rastro.
drop trigger if exists trg_audit_customers on public.customers;
create trigger trg_audit_customers
  after insert or update or delete on public.customers
  for each row execute function public.audit_row();

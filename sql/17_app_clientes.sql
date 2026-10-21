-- ============================================================================
--  TUTI'S — La app de clientes (iPhone) y un hueco de seguridad que cerrar
--
--  Correr DESPUÉS de 01..16. Es idempotente.
--
--  1. SEGURIDAD (existía antes de la app): todo el que se registraba nacía
--     con perfil de cajera ACTIVA sin sucursal, y varias reglas solo
--     preguntaban "¿tiene rol?". Con la llave pública cualquiera podía
--     registrarse y leer toda la tabla de clientes (nombre, teléfono, correo,
--     puntos), buscarlos e inscribir clientes. Ahora app_role() solo cuenta
--     al personal con sucursal (o a la propietaria), y loyalty_registrar lo
--     exige también.
--  2. El cliente de la app queda ligado a su carnet (customers.auth_user_id).
--  3. Tamaños de taza y configuración de la app (precios de EJEMPLO).
--  4. pedidos_app: pedidos para recoger que le llegan a la caja.
--  5. Funciones de la app (menú público, carnet, movimientos, pedidos).
--  6. Funciones de la tienda (ver pedidos y moverlos de estado).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SEGURIDAD
-- ----------------------------------------------------------------------------
create or replace function public.app_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  -- Personal de verdad: activo y con sucursal, o la propietaria (que ve todas).
  -- Un perfil sin sucursal no es nadie: así un registro suelto no hereda nada.
  select role from public.profiles
   where id = auth.uid() and active and (role = 'propietario' or location_id is not null);
$$;

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
  -- (sql/17) Personal de verdad: con sucursal, o la propietaria. Un registro
  -- suelto (o un cliente de la app) no inscribe clientes desde la API.
  if public.app_role() is null then
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

-- ----------------------------------------------------------------------------
-- 2. CLIENTE ↔ USUARIO DE LA APP
-- ----------------------------------------------------------------------------
alter table public.customers add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- El cliente de la app NO es personal: no nace con perfil. Los altas de
-- personal (la propietaria, desde la caja) son con correo y contraseña; los
-- clientes entran con Apple, así que solo el proveedor "email" crea perfil.
-- Aun si alguien se registra con correo, el perfil nace sin sucursal y
-- app_role() (arriba) ya no le da nada.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(to_jsonb(new)->'raw_app_meta_data'->>'provider', 'email') <> 'email' then
    return new;
  end if;
  insert into public.profiles (id, full_name, role, location_id, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'cajera', null, true)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. LO QUE LA APP VENDE A PRECIO FIJO
--    Tamaños de taza: DE EJEMPLO hasta que la dueña los defina (hoy la taza se
--    cobra por peso). El precio de un pedido lo calcula SIEMPRE la base con
--    estas tablas y con products: lo que diga el teléfono no cuenta.
-- ----------------------------------------------------------------------------
create table if not exists public.app_tamanos (
  id        text primary key check (id ~ '^[a-z]{1,8}$'),
  nombre    text not null,
  oz        int not null check (oz between 1 and 64),
  precio    numeric(10,2) not null check (precio >= 0),
  toppings  int not null check (toppings between 0 and 10),
  orden     int not null default 0,
  activo    boolean not null default true
);
insert into public.app_tamanos (id, nombre, oz, precio, toppings, orden) values
  ('ch', 'Chica', 8, 95, 2, 1), ('md', 'Mediana', 12, 135, 3, 2), ('gr', 'Grande', 16, 175, 4, 3)
on conflict (id) do nothing;

create table if not exists public.app_config (
  id               boolean primary key default true check (id),
  precio_premium   numeric(10,2) not null default 30,
  acepta_domicilio boolean not null default false,    -- falta decidir zonas y quién entrega
  costo_envio      numeric(10,2) not null default 50,
  max_pedidos_activos int not null default 3
);
insert into public.app_config (id) values (true) on conflict (id) do nothing;

alter table public.app_tamanos enable row level security;
alter table public.app_config enable row level security;
drop policy if exists app_tamanos_admin on public.app_tamanos;
create policy app_tamanos_admin on public.app_tamanos for all to authenticated using (public.is_owner()) with check (public.is_owner());
drop policy if exists app_config_admin on public.app_config;
create policy app_config_admin on public.app_config for all to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.app_tamanos, public.app_config to authenticated;
revoke all on public.app_tamanos, public.app_config from anon;

-- ----------------------------------------------------------------------------
-- 4. PEDIDOS DE LA APP
--    Entran SOLO por app_crear_pedido (SECURITY DEFINER), igual que las ventas
--    por process_sale. Un pedido no es una venta: la venta se registra en la
--    caja al entregarlo y cobrarlo, como siempre (cierre, libro, puntos).
-- ----------------------------------------------------------------------------
create table if not exists public.pedidos_app (
  id           uuid primary key default gen_random_uuid(),
  folio        int not null,
  location_id  uuid not null references public.locations(id) on delete restrict,
  customer_id  uuid not null references public.customers(id) on delete restrict,
  auth_user_id uuid references auth.users(id) on delete set null,
  modo         text not null check (modo in ('recoger', 'domicilio')),
  hora         text not null check (hora ~ '^(ya|[0-2][0-9]:[0-5][0-9])$'),
  direccion    text check (direccion is null or length(direccion) <= 200),
  items        jsonb not null,
  total        numeric(10,2) not null check (total >= 0),
  usar_puntos  boolean not null default false,
  estado       text not null default 'recibido' check (estado in ('recibido','preparando','listo','entregado','cancelado')),
  creado       timestamptz not null default now(),
  actualizado  timestamptz not null default now(),
  atendido_por uuid references public.profiles(id) on delete set null,
  unique (location_id, folio)
);
create index if not exists idx_pedidos_app_loc on public.pedidos_app(location_id, estado, creado desc);
create index if not exists idx_pedidos_app_cliente on public.pedidos_app(customer_id, creado desc);

alter table public.pedidos_app enable row level security;
-- La tienda ve los suyos; el cliente los ve por app_mis_pedidos. Nadie
-- inserta ni cambia directo.
drop policy if exists pedidos_app_select on public.pedidos_app;
create policy pedidos_app_select on public.pedidos_app for select to authenticated
  using (public.can_access_location(location_id));
grant select on public.pedidos_app to authenticated;
revoke all on public.pedidos_app from anon;

-- ----------------------------------------------------------------------------
-- 5. FUNCIONES DE LA APP (las llama el teléfono del cliente)
-- ----------------------------------------------------------------------------
create or replace function public.app_cliente_actual()
returns public.customers language sql stable security definer set search_path = public as $$
  select * from public.customers where auth_user_id = auth.uid() and active limit 1;
$$;
revoke all on function public.app_cliente_actual() from public, anon, authenticated;

-- El menú es público (como la carta en la pared): sin costos ni existencias.
create or replace function public.app_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tiendas', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'nombre', l.name, 'lugar', coalesce(l.address, '')) order by l.name)
                          from public.locations l where l.active), '[]'::jsonb),
    'tamanos', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'nombre', t.nombre, 'oz', t.oz, 'precio', t.precio, 'toppings', t.toppings) order by t.orden)
                          from public.app_tamanos t where t.activo), '[]'::jsonb),
    'productos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'tienda', p.location_id, 'familia', p.family, 'nombre', p.name, 'precio', p.price) order by p.family, p.sort, p.name)
                          from public.products p join public.locations l on l.id = p.location_id and l.active
                         where p.active), '[]'::jsonb),
    'premium', (select precio_premium from public.app_config),
    'domicilio', (select acepta_domicilio from public.app_config),
    'envio', (select costo_envio from public.app_config),
    'monto_por_punto', (select monto_por_punto from public.loyalty_config limit 1)
  );
$$;

create or replace function public.app_mi_carnet()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.customers;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  c := public.app_cliente_actual();
  if c.id is null then return null; end if;
  return jsonb_build_object('nombre', split_part(c.full_name, ' ', 1), 'nombre_completo', c.full_name,
    'codigo', c.card_code, 'puntos', c.points_balance,
    'valor', c.points_balance * coalesce((select valor_punto from public.loyalty_config limit 1), 1));
end $$;

-- Crear un carnet nuevo desde la app.
create or replace function public.app_registrarme(p_nombre text, p_telefono text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tel text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  if (public.app_cliente_actual()).id is not null then return public.app_mi_carnet(); end if;
  if length(trim(coalesce(p_nombre, ''))) < 2 or length(p_nombre) > 80 then raise exception 'Escribe tu nombre'; end if;
  if length(v_tel) not between 8 and 12 then raise exception 'Escribe tu teléfono (8 dígitos)'; end if;
  if exists (select 1 from public.customers where regexp_replace(coalesce(phone, ''), '\D', '', 'g') in (v_tel, '504' || v_tel) and active) then
    raise exception 'Ese teléfono ya tiene carnet: vincúlalo con el código de tu carnet';
  end if;
  insert into public.customers (card_code, full_name, phone, auth_user_id)
  values (public.generar_codigo_carnet(), trim(p_nombre), v_tel, auth.uid());
  return public.app_mi_carnet();
end $$;

-- Vincular un carnet que ya existe (inscrito en caja): hace falta el CÓDIGO del
-- carnet Y el teléfono con que se inscribió. Solo el teléfono no basta: con
-- eso cualquiera se quedaría con los puntos de otra persona.
create or replace function public.app_vincular_carnet(p_codigo text, p_telefono text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tel text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
        v_cod text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
        v_id uuid;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  if (public.app_cliente_actual()).id is not null then return public.app_mi_carnet(); end if;
  select id into v_id from public.customers
   where card_code = v_cod and active and auth_user_id is null
     and length(v_tel) >= 8 and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 8) = right(v_tel, 8);
  if v_id is null then raise exception 'El código y el teléfono no coinciden con ningún carnet'; end if;
  update public.customers set auth_user_id = auth.uid() where id = v_id;
  return public.app_mi_carnet();
end $$;

create or replace function public.app_movimientos()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.customers := public.app_cliente_actual();
begin
  if c.id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(x order by x->>'cuando' desc) from (
    select jsonb_build_object('tipo', t.kind, 'puntos', t.points, 'monto', t.amount, 'cuando', t.created_at, 'tienda', l.name) as x
      from public.loyalty_transactions t left join public.locations l on l.id = t.location_id
     where t.customer_id = c.id order by t.created_at desc limit 30) q), '[]'::jsonb);
end $$;

-- Hacer un pedido. El precio lo calcula la base; del teléfono solo se toma QUÉ
-- se pide.
create or replace function public.app_crear_pedido(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.app_cliente_actual();
  cfg public.app_config;
  v_loc uuid; v_modo text := coalesce(payload->>'modo', 'recoger'); v_hora text := coalesce(payload->>'hora', 'ya');
  v_items jsonb := coalesce(payload->'items', '[]'::jsonb); it jsonb; v_out jsonb := '[]'::jsonb;
  v_total numeric := 0; v_cant int; v_tam public.app_tamanos; v_prod public.products;
  v_sabores jsonb; v_tops jsonb; v_prem jsonb; v_folio int; v_id uuid; v_linea numeric;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  if c.id is null then raise exception 'Primero crea o vincula tu carnet'; end if;
  select * into cfg from public.app_config;
  begin v_loc := (payload->>'tienda')::uuid; exception when others then v_loc := null; end;
  if v_loc is null or not exists (select 1 from public.locations where id = v_loc and active) then raise exception 'Elige una tienda'; end if;
  if v_modo not in ('recoger', 'domicilio') then raise exception 'Modo de entrega no válido'; end if;
  if v_modo = 'domicilio' and not cfg.acepta_domicilio then raise exception 'Por ahora solo hay pedidos para recoger'; end if;
  if v_hora !~ '^(ya|[0-2][0-9]:[0-5][0-9])$' then raise exception 'Hora no válida'; end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then raise exception 'El pedido está vacío'; end if;
  if jsonb_array_length(v_items) > 30 then raise exception 'Demasiadas líneas en un pedido'; end if;
  if (select count(*) from public.pedidos_app where customer_id = c.id and estado in ('recibido','preparando','listo')) >= cfg.max_pedidos_activos then
    raise exception 'Ya tienes % pedidos en curso', cfg.max_pedidos_activos;
  end if;

  for it in select * from jsonb_array_elements(v_items) loop
    v_cant := coalesce((it->>'cantidad')::int, 1);
    if v_cant < 1 or v_cant > 20 then raise exception 'Cantidad no válida'; end if;
    if it->>'tipo' = 'taza' then
      select * into v_tam from public.app_tamanos where id = it->>'tamano' and activo;
      if v_tam.id is null then raise exception 'Tamaño de taza no válido'; end if;
      v_sabores := coalesce(it->'sabores', '[]'::jsonb); v_tops := coalesce(it->'toppings', '[]'::jsonb); v_prem := coalesce(it->'premium', '[]'::jsonb);
      if jsonb_typeof(v_sabores) <> 'array' or jsonb_array_length(v_sabores) not between 1 and 3 then raise exception 'Elige de 1 a 3 sabores'; end if;
      if jsonb_typeof(v_tops) <> 'array' or jsonb_array_length(v_tops) > v_tam.toppings then raise exception 'La taza % lleva hasta % toppings', lower(v_tam.nombre), v_tam.toppings; end if;
      if jsonb_typeof(v_prem) <> 'array' or jsonb_array_length(v_prem) > 10 then raise exception 'Demasiados toppings premium'; end if;
      if length((v_sabores || v_tops || v_prem)::text) > 1500 then raise exception 'Pedido demasiado largo'; end if;
      v_linea := (v_tam.precio + jsonb_array_length(v_prem) * cfg.precio_premium) * v_cant;
      v_out := v_out || jsonb_build_object('tipo', 'taza', 'nombre', 'Taza ' || lower(v_tam.nombre) || ' ' || v_tam.oz || ' oz', 'tamano', v_tam.id,
        'sabores', v_sabores, 'toppings', v_tops, 'premium', v_prem, 'cantidad', v_cant, 'precio', v_linea);
    elsif it->>'tipo' = 'producto' then
      begin select * into v_prod from public.products where id = (it->>'producto')::uuid and active and location_id = v_loc;
      exception when others then v_prod := null; end;
      if v_prod.id is null then raise exception 'Un producto ya no está disponible en esa tienda'; end if;
      v_linea := v_prod.price * v_cant;
      v_out := v_out || jsonb_build_object('tipo', 'producto', 'nombre', v_prod.name, 'producto', v_prod.id, 'cantidad', v_cant, 'precio', v_linea);
    else
      raise exception 'Línea de pedido no válida';
    end if;
    v_total := v_total + v_linea;
  end loop;
  if v_modo = 'domicilio' then v_total := v_total + cfg.costo_envio; end if;

  perform pg_advisory_xact_lock(hashtextextended('pedidos_app:' || v_loc::text, 0));
  select coalesce(max(folio), 100) + 1 into v_folio from public.pedidos_app where location_id = v_loc;
  insert into public.pedidos_app (folio, location_id, customer_id, auth_user_id, modo, hora, direccion, items, total, usar_puntos)
  values (v_folio, v_loc, c.id, auth.uid(), v_modo, v_hora, nullif(left(trim(coalesce(payload->>'direccion', '')), 200), ''),
          v_out, round(v_total, 2), coalesce((payload->>'usar_puntos')::boolean, false))
  returning id into v_id;
  return (select public.app_pedido_json(p) from public.pedidos_app p where id = v_id);
end $$;

create or replace function public.app_pedido_json(p public.pedidos_app)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'folio', p.folio, 'tienda', l.name, 'tienda_id', p.location_id, 'lugar', coalesce(l.address, ''),
    'modo', p.modo, 'hora', p.hora, 'items', p.items, 'total', p.total, 'usar_puntos', p.usar_puntos,
    'estado', p.estado, 'creado', p.creado, 'actualizado', p.actualizado)
  from public.locations l where l.id = p.location_id;
$$;
revoke all on function public.app_pedido_json(public.pedidos_app) from public, anon, authenticated;

create or replace function public.app_mis_pedidos()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c public.customers := public.app_cliente_actual();
begin
  if c.id is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(public.app_pedido_json(p) order by p.creado desc)
                     from (select * from public.pedidos_app where customer_id = c.id order by creado desc limit 20) p), '[]'::jsonb);
end $$;

create or replace function public.app_cancelar_pedido(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.customers := public.app_cliente_actual(); n int;
begin
  update public.pedidos_app set estado = 'cancelado', actualizado = now()
   where id = p_id and customer_id = c.id and estado = 'recibido';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Ese pedido ya se está preparando: pide a la tienda que lo cancele'; end if;
  return (select public.app_pedido_json(p) from public.pedidos_app p where id = p_id);
end $$;

-- ----------------------------------------------------------------------------
-- 6. FUNCIONES DE LA TIENDA (las llama la caja)
-- ----------------------------------------------------------------------------
create or replace function public.tienda_pedidos(p_location_id uuid, p_dias int default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_access_location(p_location_id) then raise exception 'No tiene permiso para ver esa sucursal'; end if;
  return coalesce((select jsonb_agg(public.app_pedido_json(p) || jsonb_build_object('cliente', c.full_name, 'carnet', c.card_code, 'telefono', c.phone)
                                    order by (p.estado in ('entregado','cancelado')), p.creado)
                     from public.pedidos_app p join public.customers c on c.id = p.customer_id
                    where p.location_id = p_location_id
                      and (p.estado in ('recibido','preparando','listo') or p.creado > now() - make_interval(days => greatest(1, least(p_dias, 31))))), '[]'::jsonb);
end $$;

create or replace function public.tienda_pedido_estado(p_id uuid, p_estado text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.pedidos_app; v_ok boolean;
begin
  select * into p from public.pedidos_app where id = p_id for update;
  if p.id is null or not public.can_access_location(p.location_id) or public.app_role() is null then
    raise exception 'No tiene permiso sobre ese pedido';
  end if;
  v_ok := (p.estado, p_estado) in (('recibido','preparando'), ('preparando','listo'), ('listo','entregado'),
                                   ('recibido','cancelado'), ('preparando','cancelado'), ('listo','cancelado'));
  if not v_ok then raise exception 'Un pedido "%" no puede pasar a "%"', p.estado, p_estado; end if;
  update public.pedidos_app set estado = p_estado, actualizado = now(), atendido_por = auth.uid() where id = p_id;
  return (select public.app_pedido_json(x) from public.pedidos_app x where id = p_id);
end $$;

-- Permisos: el menú es público; lo demás pide sesión (cliente o tienda).
revoke all on function public.app_menu() from public;
grant execute on function public.app_menu() to anon, authenticated;
do $$ declare f text; begin
  foreach f in array array['app_mi_carnet()', 'app_registrarme(text, text)', 'app_vincular_carnet(text, text)', 'app_movimientos()',
                           'app_crear_pedido(jsonb)', 'app_mis_pedidos()', 'app_cancelar_pedido(uuid)',
                           'tienda_pedidos(uuid, int)', 'tienda_pedido_estado(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- El respaldo nocturno copia también lo nuevo.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log','app_tamanos','app_config','pedidos_app'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

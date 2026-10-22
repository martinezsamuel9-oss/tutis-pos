-- ============================================================================
-- 18. EL MAPA DE LA APP: dónde queda cada tienda y a qué hora abre
-- ----------------------------------------------------------------------------
-- Pedido del dueño (2026-10-22): "implementar bien lo del mapa para recoger
-- el pedido". Antes los pines salían de buscar "Tuti's" en Apple Maps (si la
-- tienda no estaba dada de alta ahí, no salía) y el horario era de ejemplo.
--
-- Lo que no hay que deshacer:
--   1. La ubicación la pone la tienda (Configuración), no se adivina. Sin
--      coordenadas la tienda sale en la lista pero no en el mapa.
--   2. El horario es POR DÍA, en hora LOCAL de la tienda (zona según el país,
--      no el desfase fijo: si un país cambia de horario, la base lo sabe).
--   3. Con horario puesto, app_crear_pedido RECHAZA un pedido con la tienda
--      cerrada o una hora fuera del horario. Aquí sí se rechaza: es el
--      teléfono del cliente, en línea, y el cliente tiene que enterarse. (Las
--      ventas de la caja nunca se rechazan; esto no es una venta.)
--   4. Sin horario puesto, no se valida (como antes): una tienda nueva no
--      queda bloqueada en la app por no haber llenado el horario.
-- ============================================================================

alter table public.locations add column if not exists latitud  numeric(9,6);
alter table public.locations add column if not exists longitud numeric(9,6);
alter table public.locations add column if not exists horario  jsonb;
alter table public.locations add column if not exists telefono text;
alter table public.locations add column if not exists app_minutos int not null default 15;

-- Zona horaria de la tienda, por país.
create or replace function public.zona_tienda(p_pais text)
returns text language sql immutable as $$
  select case p_pais when 'GT' then 'America/Guatemala'
                     when 'SV' then 'America/El_Salvador'
                     else 'America/Tegucigalpa' end;
$$;

-- El horario: {"lun": {"abre": "10:00", "cierra": "21:00"}, ..., "dom": null}
-- Un día que falta o viene en null = cerrado ese día. Abre antes de cerrar
-- (los malls no pasan de medianoche; si un día hiciera falta, se cambia aquí).
create or replace function public.horario_valido(h jsonb)
returns boolean language plpgsql immutable as $$
declare k text; v jsonb;
begin
  if h is null then return true; end if;
  if jsonb_typeof(h) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(h) loop
    if k not in ('lun','mar','mie','jue','vie','sab','dom') then return false; end if;
    continue when v is null or jsonb_typeof(v) = 'null';
    if jsonb_typeof(v) <> 'object'
       or coalesce(v->>'abre', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v->>'cierra', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v->>'abre') >= (v->>'cierra')
       or (select count(*) from jsonb_object_keys(v)) <> 2 then
      return false;
    end if;
  end loop;
  return true;
end $$;

do $$ begin
  alter table public.locations add constraint locations_coordenadas_chk check (
    (latitud is null) = (longitud is null)
    and (latitud is null or (latitud between -90 and 90 and longitud between -180 and 180
                             and not (latitud = 0 and longitud = 0))));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.locations add constraint locations_horario_chk check (public.horario_valido(horario));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.locations add constraint locations_telefono_chk check (telefono is null or telefono ~ '^\+?[0-9 -]{7,20}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.locations add constraint locations_app_minutos_chk check (app_minutos between 5 and 120);
exception when duplicate_object then null; end $$;

-- El horario de HOY de una tienda en un instante dado (hora local), o null si
-- ese día no abre. Recibe el instante para que las pruebas no dependan del reloj.
create or replace function public.horario_del_dia(p_loc uuid, p_ts timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select l.horario -> (array['dom','lun','mar','mie','jue','vie','sab'])
           [extract(dow from p_ts at time zone public.zona_tienda(l.country_code))::int + 1]
    from public.locations l where l.id = p_loc;
$$;
revoke all on function public.horario_del_dia(uuid, timestamptz) from public, anon, authenticated;

-- ¿Se puede pedir para esa hora? Devuelve null si sí, o el motivo si no.
--   'ya'    → la tienda está abierta y da tiempo de prepararlo antes de cerrar.
--   'HH:MM' → hoy, dentro del horario, y no antes de ahora + preparación.
create or replace function public.motivo_hora_no_valida(p_loc uuid, p_hora text, p_ts timestamptz)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  l public.locations; d jsonb; ahora time; listo time; abre time; cierra time; pedida time;
begin
  select * into l from public.locations where id = p_loc;
  if l.horario is null then return null; end if;            -- sin horario: no se valida
  d := public.horario_del_dia(p_loc, p_ts);
  if d is null or jsonb_typeof(d) = 'null' then return 'La tienda no abre hoy'; end if;
  ahora := (p_ts at time zone public.zona_tienda(l.country_code))::time;
  abre := (d->>'abre')::time; cierra := (d->>'cierra')::time;
  listo := ahora + make_interval(mins => l.app_minutos);
  if listo < ahora then return 'La tienda ya cerró por hoy'; end if;   -- pasó de medianoche
  if p_hora = 'ya' then
    if ahora < abre then return format('La tienda abre a las %s', to_char(abre, 'HH24:MI')); end if;
    if listo > cierra then return 'La tienda ya cerró por hoy'; end if;
    return null;
  end if;
  pedida := p_hora::time;
  if pedida < abre or pedida > cierra then
    return format('Hoy la tienda abre de %s a %s', to_char(abre, 'HH24:MI'), to_char(cierra, 'HH24:MI'));
  end if;
  if pedida < listo then return 'Esa hora ya pasó o no da tiempo de prepararlo'; end if;
  return null;
end $$;
revoke all on function public.motivo_hora_no_valida(uuid, text, timestamptz) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- El menú público lleva ahora la ubicación, el horario y la zona de cada tienda.
-- ----------------------------------------------------------------------------
create or replace function public.app_menu()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tiendas', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'nombre', l.name, 'lugar', coalesce(l.address, ''),
                                  'lat', l.latitud, 'lng', l.longitud, 'horario', l.horario, 'telefono', l.telefono,
                                  'minutos', l.app_minutos, 'zona', public.zona_tienda(l.country_code)) order by l.name)
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
revoke all on function public.app_menu() from public;
grant execute on function public.app_menu() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- app_crear_pedido: igual que en 17, más la validación del horario.
-- ----------------------------------------------------------------------------
create or replace function public.app_crear_pedido(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.app_cliente_actual();
  cfg public.app_config;
  v_loc uuid; v_modo text := coalesce(payload->>'modo', 'recoger'); v_hora text := coalesce(payload->>'hora', 'ya');
  v_items jsonb := coalesce(payload->'items', '[]'::jsonb); it jsonb; v_out jsonb := '[]'::jsonb;
  v_total numeric := 0; v_cant int; v_tam public.app_tamanos; v_prod public.products;
  v_sabores jsonb; v_tops jsonb; v_prem jsonb; v_folio int; v_id uuid; v_linea numeric; v_motivo text;
begin
  if auth.uid() is null then raise exception 'Inicia sesión'; end if;
  if c.id is null then raise exception 'Primero crea o vincula tu carnet'; end if;
  select * into cfg from public.app_config;
  begin v_loc := (payload->>'tienda')::uuid; exception when others then v_loc := null; end;
  if v_loc is null or not exists (select 1 from public.locations where id = v_loc and active) then raise exception 'Elige una tienda'; end if;
  if v_modo not in ('recoger', 'domicilio') then raise exception 'Modo de entrega no válido'; end if;
  if v_modo = 'domicilio' and not cfg.acepta_domicilio then raise exception 'Por ahora solo hay pedidos para recoger'; end if;
  if v_hora !~ '^(ya|([01][0-9]|2[0-3]):[0-5][0-9])$' then raise exception 'Hora no válida'; end if;
  v_motivo := public.motivo_hora_no_valida(v_loc, v_hora, now());
  if v_motivo is not null then raise exception '%', v_motivo; end if;
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
revoke all on function public.app_crear_pedido(jsonb) from public, anon;
grant execute on function public.app_crear_pedido(jsonb) to authenticated;

-- ============================================================================
-- 22. MÓDULO DE CLIENTES
-- ----------------------------------------------------------------------------
-- Pedido del negocio (2026-10-30):
--   · Ficha: nombre, cumpleaños, sexo, número de identidad, observaciones.
--   · La llave del cliente es su NÚMERO DE TELÉFONO.
--   · Al finalizar la compra, la caja pregunta si es cliente nuevo.
--   · Módulo: cada cuánto viene, ticket promedio, resumen de consumo, quién no
--     viene desde tal fecha, aviso de cumpleaños, y clasificación (VIP u otra)
--     según lo que consume.
--
-- Lo que no hay que deshacer:
--   1. El teléfono es la llave DE NEGOCIO: único, obligatorio, y es por lo que
--      se busca en la caja. Por dentro el cliente sigue con su id (uuid): si
--      una clienta cambia de número, se le cambia el teléfono y conserva su
--      historial, sus puntos y su carnet. Si el teléfono fuera la llave
--      primaria, cambiar de número la dejaría sin nada.
--   2. telefono_clave = solo los dígitos, sin el 504 de Honduras: "9988-7766",
--      "+504 9988 7766" y "99887766" son el mismo cliente.
--   3. La identidad la ven la gerente y la propietaria (módulo de clientes), no
--      la cajera: la búsqueda de la caja no la devuelve.
--   4. Las cifras de cada cliente (visitas, ticket, consumo) salen SOLO de las
--      ventas de las tiendas que quien consulta puede ver: la gerente de
--      Galerías no ve lo que la clienta gastó en Multiplaza. La CATEGORÍA sí
--      se calcula con toda la marca, porque el cliente es de la marca (como
--      los puntos) y una etiqueta no revela montos.
--   5. Las reglas de las categorías viven en la base (clientes_config), las
--      cambia la propietaria, y la pantalla dice cuáles son.
-- ============================================================================

alter table public.customers add column if not exists sexo text;
alter table public.customers add column if not exists identidad text;
alter table public.customers add column if not exists observaciones text;
alter table public.customers drop constraint if exists customers_sexo_chk;
alter table public.customers add constraint customers_sexo_chk check (sexo is null or sexo in ('F', 'M', 'O'));
alter table public.customers drop constraint if exists customers_identidad_chk;
alter table public.customers add constraint customers_identidad_chk
  check (identidad is null or identidad ~ '^[0-9A-Za-z-]{5,20}$');
alter table public.customers drop constraint if exists customers_observaciones_chk;
alter table public.customers add constraint customers_observaciones_chk
  check (observaciones is null or length(observaciones) <= 500);
alter table public.customers drop constraint if exists customers_cumple_chk;
alter table public.customers add constraint customers_cumple_chk
  check (birth_date is null or birth_date between date '1900-01-01' and date '2100-01-01');

-- La llave: el teléfono normalizado.
create or replace function public.telefono_clave(t text)
returns text language sql immutable as $$
  select case when length(d) = 11 and left(d, 3) = '504' then right(d, 8) else nullif(d, '') end
    from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x;
$$;
alter table public.customers add column if not exists telefono_clave text
  generated always as (public.telefono_clave(phone)) stored;
create unique index if not exists uq_customers_telefono on public.customers(telefono_clave) where active and telefono_clave is not null;
create unique index if not exists uq_customers_identidad on public.customers(regexp_replace(identidad, '\D', '', 'g'))
  where active and identidad is not null;
-- Obligatorio de aquí en adelante (NOT VALID: no revisa lo que ya existía).
alter table public.customers drop constraint if exists customers_telefono_chk;
alter table public.customers add constraint customers_telefono_chk
  check (telefono_clave ~ '^[0-9]{8,15}$') not valid;

grant update (full_name, phone, email, birth_date, active, sexo, identidad, observaciones) on public.customers to authenticated;

-- ----------------------------------------------------------------------------
-- Reglas de las categorías (una sola fila)
-- ----------------------------------------------------------------------------
create table if not exists public.clientes_config (
  id               boolean primary key default true check (id),
  vip_monto_90d    numeric(12,2) not null default 1500 check (vip_monto_90d > 0),
  vip_visitas_90d  int not null default 8 check (vip_visitas_90d > 0),
  frecuente_visitas_90d int not null default 3 check (frecuente_visitas_90d > 0),
  nuevo_dias       int not null default 30 check (nuevo_dias between 1 and 365),
  inactivo_dias    int not null default 45 check (inactivo_dias between 7 and 730),
  aviso_cumple_dias int not null default 7 check (aviso_cumple_dias between 0 and 60),
  -- Al cobrar sin cliente, la caja pregunta "¿Es cliente?".
  preguntar_en_caja boolean not null default true
);
insert into public.clientes_config (id) values (true) on conflict do nothing;
alter table public.clientes_config enable row level security;
drop policy if exists clientes_config_select on public.clientes_config;
create policy clientes_config_select on public.clientes_config for select to authenticated using (public.app_role() is not null);
drop policy if exists clientes_config_update on public.clientes_config;
create policy clientes_config_update on public.clientes_config for update to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, update on public.clientes_config to authenticated;
revoke all on public.clientes_config from anon;
drop trigger if exists trg_audit_clientes_config on public.clientes_config;
create trigger trg_audit_clientes_config after update on public.clientes_config
  for each row execute function public.audit_row();

-- La categoría de un cliente con TODA la marca (ver punto 4 arriba).
create or replace function public.cliente_categoria(p_customer uuid)
returns text language sql stable security definer set search_path = public as $$
  with cfg as (select * from public.clientes_config where id),
  v as (
    select count(*) as visitas, min(created_at) as primera, max(created_at) as ultima,
           count(*) filter (where created_at >= now() - interval '90 days') as visitas_90,
           coalesce(sum(total_price) filter (where created_at >= now() - interval '90 days'), 0) as monto_90
      from public.sales where customer_id = p_customer)
  select case
    when v.visitas = 0 then 'sin_compras'
    when v.ultima < now() - make_interval(days => cfg.inactivo_dias) then 'inactivo'
    when v.monto_90 >= cfg.vip_monto_90d or v.visitas_90 >= cfg.vip_visitas_90d then 'vip'
    when v.visitas_90 >= cfg.frecuente_visitas_90d then 'frecuente'
    when v.primera >= now() - make_interval(days => cfg.nuevo_dias) then 'nuevo'
    else 'ocasional' end
  from v, cfg;
$$;
revoke all on function public.cliente_categoria(uuid) from public, anon, authenticated;

-- ¿Cuántos días faltan para su cumpleaños? (0 = hoy; 29 de febrero cae el 28)
create or replace function public.dias_para_cumple(p_nac date, p_hoy date)
returns int language sql immutable as $$
  select case when p_nac is null then null else (
    select min(d - p_hoy) from (
      select make_date(y, extract(month from p_nac)::int,
                       least(extract(day from p_nac)::int,
                             extract(day from (make_date(y, extract(month from p_nac)::int, 1) + interval '1 month - 1 day'))::int)) as d
        from (values (extract(year from p_hoy)::int), (extract(year from p_hoy)::int + 1)) a(y)) x
     where d >= p_hoy) end;
$$;

-- ----------------------------------------------------------------------------
-- Inscribir (caja): teléfono obligatorio y único, y la ficha completa.
-- ----------------------------------------------------------------------------
create or replace function public.clientes_inscribir(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_perfil public.profiles%rowtype;
  v_tel text := public.telefono_clave(p->>'telefono');
  v_nombre text := trim(coalesce(p->>'nombre', ''));
  v_sexo text := nullif(upper(trim(coalesce(p->>'sexo', ''))), '');
  v_ident text := nullif(trim(coalesce(p->>'identidad', '')), '');
  v_nac date;
  v_id uuid;
begin
  if public.app_role() is null then raise exception 'Usuario sin perfil activo'; end if;
  if not public.es_personal_de_caja() then raise exception 'Tu rol no inscribe clientes'; end if;
  select * into v_perfil from public.profiles where id = auth.uid();
  if length(v_nombre) < 2 or length(v_nombre) > 80 then raise exception 'Escribe el nombre del cliente'; end if;
  if v_tel is null or v_tel !~ '^[0-9]{8,15}$' then raise exception 'Escribe el teléfono del cliente (8 dígitos)'; end if;
  if exists (select 1 from public.customers where telefono_clave = v_tel and active) then
    raise exception 'Ya hay un cliente con ese teléfono';
  end if;
  if v_sexo is not null and v_sexo not in ('F', 'M', 'O') then raise exception 'Sexo no válido'; end if;
  if v_ident is not null then
    if v_ident !~ '^[0-9A-Za-z-]{5,20}$' then raise exception 'Número de identidad no válido'; end if;
    if exists (select 1 from public.customers where active and identidad is not null
                and regexp_replace(identidad, '\D', '', 'g') = regexp_replace(v_ident, '\D', '', 'g')) then
      raise exception 'Ya hay un cliente con ese número de identidad';
    end if;
  end if;
  begin
    v_nac := nullif(p->>'cumpleanos', '')::date;
  exception when others then raise exception 'Fecha de cumpleaños no válida';
  end;
  if v_nac is not null and (v_nac > current_date or v_nac < date '1900-01-01') then raise exception 'Fecha de cumpleaños no válida'; end if;
  if length(coalesce(p->>'observaciones', '')) > 500 then raise exception 'Las observaciones son muy largas (máximo 500)'; end if;

  insert into public.customers (card_code, full_name, phone, email, birth_date, sexo, identidad, observaciones,
                                created_location_id, created_by)
  values (public.generar_codigo_carnet(), v_nombre, v_tel, nullif(trim(coalesce(p->>'correo', '')), ''), v_nac,
          v_sexo, v_ident, nullif(trim(coalesce(p->>'observaciones', '')), ''), v_perfil.location_id, v_perfil.id)
  returning id into v_id;
  return (select jsonb_build_object('id', c.id, 'card_code', c.card_code, 'full_name', c.full_name, 'phone', c.phone,
                                    'points_balance', c.points_balance, 'visits', c.visits, 'active', c.active,
                                    'birth_date', c.birth_date, 'observaciones', c.observaciones, 'categoria', 'sin_compras')
            from public.customers c where c.id = v_id);
end $$;

-- La función vieja sigue existiendo (pantallas en caché), pero con las reglas nuevas.
create or replace function public.loyalty_registrar(p_full_name text, p_phone text default null,
                                                    p_email text default null, p_birth_date date default null)
returns jsonb language sql security definer set search_path = public as $$
  select public.clientes_inscribir(jsonb_build_object('nombre', p_full_name, 'telefono', p_phone,
                                                      'correo', p_email, 'cumpleanos', p_birth_date));
$$;

-- Buscar en la caja: por teléfono (la llave), carnet o nombre. Sin identidad.
create or replace function public.loyalty_buscar(p_texto text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := trim(coalesce(p_texto, '')); v_tel text := public.telefono_clave(p_texto);
        v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  if public.app_role() is null then raise exception 'Usuario sin perfil activo'; end if;
  if not public.es_personal_de_caja() then raise exception 'Tu rol no busca clientes'; end if;
  if length(v_q) < 3 then raise exception 'Escribe al menos 3 caracteres para buscar'; end if;
  return (
    select coalesce(jsonb_agg(x order by (x->>'exacto')::boolean desc, x->>'full_name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', c.id, 'card_code', c.card_code, 'full_name', c.full_name,
                 'phone', c.phone, 'points_balance', c.points_balance,
                 'visits', c.visits, 'active', c.active, 'observaciones', c.observaciones,
                 'birth_date', c.birth_date, 'dias_para_cumple', public.dias_para_cumple(c.birth_date, v_hoy),
                 'categoria', public.cliente_categoria(c.id),
                 'exacto', c.telefono_clave = v_tel or upper(c.card_code) = upper(v_q)) as x
          from public.customers c
         where c.active
           and (upper(c.card_code) = upper(v_q)
                or (v_tel is not null and length(v_tel) >= 4 and c.telefono_clave like '%' || v_tel || '%')
                or lower(c.full_name) like '%' || lower(v_q) || '%')
         limit 15
      ) s
  );
end $$;

-- ----------------------------------------------------------------------------
-- El módulo (gerente y propietaria)
-- ----------------------------------------------------------------------------
-- Las tiendas que entran en las cifras: una (si se pide y se puede ver) o
-- todas las que quien consulta puede ver.
create or replace function public.clientes_tiendas(p_location uuid)
returns uuid[] language plpgsql stable security definer set search_path = public as $$
begin
  if public.app_role() not in ('gerente', 'propietario') then
    raise exception 'Solo la gerente o la propietaria ven el módulo de clientes';
  end if;
  if p_location is not null then
    if not public.can_manage_location(p_location) then raise exception 'No tienes acceso a esa tienda'; end if;
    return array[p_location];
  end if;
  return array(select id from public.locations where public.can_manage_location(id));
end $$;
revoke all on function public.clientes_tiendas(uuid) from public, anon, authenticated;

-- Una fila por cliente (también los inactivos, marcados) con sus cifras.
-- p_location null = todas las que veo.
create or replace function public.clientes_resumen(p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid[] := public.clientes_tiendas(p_location);
        v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  return (
    with v as (
      select customer_id, count(*) as visitas, round(sum(total_price), 2) as total,
             min(created_at) as primera, max(created_at) as ultima,
             count(*) filter (where created_at >= now() - interval '90 days') as visitas_90,
             round(coalesce(sum(total_price) filter (where created_at >= now() - interval '90 days'), 0), 2) as monto_90
        from public.sales
       where customer_id is not null and location_id = any(v_t)
       group by customer_id)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'nombre', c.full_name, 'telefono', c.phone, 'carnet', c.card_code, 'correo', c.email,
        'cumpleanos', c.birth_date, 'dias_para_cumple', public.dias_para_cumple(c.birth_date, v_hoy),
        'sexo', c.sexo, 'identidad', c.identidad, 'observaciones', c.observaciones,
        'puntos', c.points_balance, 'activo', c.active, 'inscrito', c.created_at,
        'categoria', public.cliente_categoria(c.id),
        'visitas', coalesce(v.visitas, 0), 'total', coalesce(v.total, 0),
        'ticket_promedio', case when v.visitas > 0 then round(v.total / v.visitas, 2) else 0 end,
        'primera', v.primera, 'ultima', v.ultima,
        'dias_sin_venir', case when v.ultima is null then null else v_hoy - (v.ultima at time zone 'America/Tegucigalpa')::date end,
        'cada_cuantos_dias', case when v.visitas > 1
             then round(extract(epoch from (v.ultima - v.primera)) / 86400.0 / (v.visitas - 1), 1) end,
        'visitas_90', coalesce(v.visitas_90, 0), 'monto_90', coalesce(v.monto_90, 0))
        order by coalesce(v.total, 0) desc, c.full_name), '[]'::jsonb)
      from public.customers c left join v on v.customer_id = c.id);
end $$;

-- La ficha de un cliente: su consumo en las tiendas que veo.
create or replace function public.cliente_detalle(p_customer uuid, p_location uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid[] := public.clientes_tiendas(p_location);
begin
  if not exists (select 1 from public.customers where id = p_customer) then raise exception 'Ese cliente no existe'; end if;
  return jsonb_build_object(
    'categoria', public.cliente_categoria(p_customer),
    'ultimas', (select coalesce(jsonb_agg(x order by x->>'fecha' desc), '[]'::jsonb) from (
        select jsonb_build_object('fecha', s.created_at, 'folio', s.folio, 'tienda', l.name, 'total', s.total_price,
                                  'pago', s.payment_method, 'peso_g', s.gross_weight_g,
                                  'puntos_ganados', s.points_earned, 'puntos_canjeados', s.points_redeemed) as x
          from public.sales s join public.locations l on l.id = s.location_id
         where s.customer_id = p_customer and s.location_id = any(v_t)
         order by s.created_at desc limit 20) y),
    -- Qué consume: lo que más pide (productos, sabores, toppings), con cuántas
    -- veces y cuánto peso o cuántas unidades.
    'consumo', (select coalesce(jsonb_agg(x order by (x->>'veces')::int desc, x->>'nombre'), '[]'::jsonb) from (
        select jsonb_build_object('tipo', sl.item_type, 'nombre', sl.name, 'veces', count(distinct sl.sale_id),
                                  'peso_g', round(sum(sl.weight_g), 1), 'unidades', sum(sl.quantity),
                                  'monto', round(sum(sl.price_contribution), 2)) as x
          from public.sale_lines sl join public.sales s on s.id = sl.sale_id
         where s.customer_id = p_customer and s.location_id = any(v_t)
           and sl.item_type::text in ('helado', 'topping', 'producto')
         group by sl.item_type, sl.name
         order by count(distinct sl.sale_id) desc limit 15) y),
    'por_hora', (select coalesce(jsonb_object_agg(h, n), '{}'::jsonb) from (
        select extract(hour from s.created_at at time zone 'America/Tegucigalpa')::int as h, count(*) as n
          from public.sales s where s.customer_id = p_customer and s.location_id = any(v_t) group by 1) y),
    'por_dia', (select coalesce(jsonb_object_agg(d, n), '{}'::jsonb) from (
        select extract(isodow from s.created_at at time zone 'America/Tegucigalpa')::int as d, count(*) as n
          from public.sales s where s.customer_id = p_customer and s.location_id = any(v_t) group by 1) y),
    'pagos', (select coalesce(jsonb_object_agg(m, n), '{}'::jsonb) from (
        select coalesce(nullif(s.payment_method, ''), 'sin_dato') as m, count(*) as n
          from public.sales s where s.customer_id = p_customer and s.location_id = any(v_t) group by 1) y));
end $$;

-- Cumpleaños de los próximos N días (de toda la marca: es un cliente de la
-- marca). Para el aviso del tablero y del módulo.
create or replace function public.clientes_cumpleanos(p_dias int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
        v_n int := coalesce(p_dias, (select aviso_cumple_dias from public.clientes_config where id));
begin
  if public.app_role() not in ('gerente', 'propietario') then raise exception 'Solo la gerente o la propietaria'; end if;
  if v_n < 0 or v_n > 60 then raise exception 'Rango no válido'; end if;
  return (select coalesce(jsonb_agg(x order by (x->>'dias')::int, x->>'nombre'), '[]'::jsonb) from (
    select jsonb_build_object('id', c.id, 'nombre', c.full_name, 'telefono', c.phone, 'cumpleanos', c.birth_date,
                              'dias', public.dias_para_cumple(c.birth_date, v_hoy),
                              'cumple', extract(year from age(v_hoy + public.dias_para_cumple(c.birth_date, v_hoy), c.birth_date))::int,
                              'categoria', public.cliente_categoria(c.id)) as x
      from public.customers c
     where c.active and c.birth_date is not null and public.dias_para_cumple(c.birth_date, v_hoy) <= v_n) y);
end $$;

do $$ declare f text; begin
  foreach f in array array['clientes_inscribir(jsonb)', 'loyalty_registrar(text, text, text, date)', 'loyalty_buscar(text)',
                           'clientes_resumen(uuid)', 'cliente_detalle(uuid, uuid)', 'clientes_cumpleanos(int)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- El respaldo nocturno copia también las reglas de clientes.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log','app_tamanos','app_config','pedidos_app',
               'cash_sessions','cash_movements','clientes_config'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

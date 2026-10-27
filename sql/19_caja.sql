-- ============================================================================
-- 19. LA CAJA: turnos, retiros y arqueo ciego
-- ----------------------------------------------------------------------------
-- Pedido del dueño (2026-10-27): cuadrar la caja. Una sola caja (gaveta) por
-- tienda, y pueden trabajar 2 cajeras o más.
--
-- Lo que no hay que deshacer:
--   1. El turno es de la CAJA, no de la cajera: una sola caja abierta por
--      tienda. Cualquier cajera de la tienda vende dentro del turno abierto;
--      responde por la gaveta quien la abrió.
--   2. El arqueo es CIEGO: la cajera cuenta billete por billete SIN ver lo que
--      debería haber. Si viera el esperado, "contaría" eso. Por eso las tablas
--      no se leen directo: la cajera solo llega a ellas por funciones que no le
--      devuelven el esperado hasta que el conteo ya quedó guardado.
--   3. El esperado sale de las ventas en EFECTIVO de la tienda cuya hora
--      (sales.created_at, la hora en que se cobró, aunque suba después desde
--      la cola sin conexión) cae entre la apertura y el cierre. No se tocó
--      process_sale: una venta nunca se rechaza por la caja.
--   4. Cambio de cajera = la que sale cierra contando y la que entra abre
--      contando. La apertura se compara con lo que el cierre anterior dejó de
--      fondo: si no coincide, es una diferencia de ENTREGA, y queda anotada.
--   5. El conteo no se corrige: un cierre guardado es definitivo. La cajera
--      puede explicar la diferencia; la gerente la revisa y firma.
--   6. Se guarda el esperado AL CERRAR, y el reporte lo vuelve a calcular: si
--      llegó después una venta sin conexión o se borró una venta, se ve.
-- ============================================================================

create table if not exists public.cash_sessions (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations(id) on delete restrict,
  abierto_por      uuid references public.profiles(id) on delete set null,
  abierto_nombre   text,
  abierto_at       timestamptz not null default now(),
  fondo            numeric(12,2) not null check (fondo >= 0),
  fondo_detalle    jsonb,
  fondo_anterior   numeric(12,2),            -- lo que el cierre anterior dejó en la gaveta
  cerrado_por      uuid references public.profiles(id) on delete set null,
  cerrado_nombre   text,
  cerrado_at       timestamptz,
  contado          numeric(12,2) check (contado >= 0),
  contado_detalle  jsonb,
  esperado         numeric(12,2),            -- calculado por la base al cerrar
  deja_fondo       numeric(12,2) check (deja_fondo >= 0),
  explicacion      text check (explicacion is null or length(explicacion) <= 300),
  revisado_por     uuid references public.profiles(id) on delete set null,
  revisado_nombre  text,
  revisado_at      timestamptz,
  nota_revision    text check (nota_revision is null or length(nota_revision) <= 300),
  check ((cerrado_at is null) = (contado is null)),
  check (deja_fondo is null or deja_fondo <= contado)
);
-- Una sola caja abierta por tienda.
create unique index if not exists uq_cash_sessions_abierta on public.cash_sessions(location_id) where cerrado_at is null;
create index if not exists idx_cash_sessions_loc on public.cash_sessions(location_id, abierto_at desc);

create table if not exists public.cash_movements (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.cash_sessions(id) on delete restrict,
  location_id  uuid not null references public.locations(id) on delete restrict,
  tipo         text not null check (tipo in ('retiro', 'entrada')),
  monto        numeric(12,2) not null check (monto > 0 and monto <= 1000000),
  motivo       text not null check (length(trim(motivo)) between 3 and 200),
  creado_por   uuid references public.profiles(id) on delete set null,
  creado_nombre text,
  creado_at    timestamptz not null default now()
);
create index if not exists idx_cash_movements_ses on public.cash_movements(session_id);

-- Nadie lee ni escribe directo: todo pasa por las funciones de abajo.
alter table public.cash_sessions  enable row level security;
alter table public.cash_movements enable row level security;
revoke all on public.cash_sessions, public.cash_movements from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Auxiliares (internas)
-- ----------------------------------------------------------------------------

-- Suma un conteo por denominación: {"500": 2, "100": 3, "0.50": 4} → 1302.00.
-- Rechaza denominaciones o cantidades raras en vez de adivinar.
create or replace function public.caja_suma_conteo(d jsonb)
returns numeric language plpgsql immutable as $$
declare k text; v jsonb; total numeric := 0;
begin
  if d is null or jsonb_typeof(d) <> 'object' then raise exception 'Falta el conteo de la caja'; end if;
  if (select count(*) from jsonb_object_keys(d)) > 30 then raise exception 'Conteo no válido'; end if;
  for k, v in select * from jsonb_each(d) loop
    if k !~ '^[0-9]{1,4}(\.[0-9]{1,2})?$' or k::numeric <= 0 then raise exception 'Denominación no válida: %', k; end if;
    if jsonb_typeof(v) <> 'number' or v::text !~ '^[0-9]{1,5}$' then raise exception 'Cantidad no válida para %', k; end if;
    total := total + k::numeric * v::text::int;
  end loop;
  return round(total, 2);
end $$;

-- El perfil de quien llama, si puede operar la caja de esa tienda.
create or replace function public.caja_quien(p_location uuid)
returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null or public.app_role() is null then raise exception 'Sin perfil activo'; end if;
  if p_location is null or not public.can_access_location(p_location) then raise exception 'No tienes acceso a esa tienda'; end if;
  select * into p from public.profiles where id = auth.uid();
  return p;
end $$;

-- Lo que debería haber en la gaveta para un turno, hasta un instante.
create or replace function public.caja_cuentas(s public.cash_sessions, p_hasta timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with v as (
    select coalesce(sum(total_price) filter (where payment_method = 'efectivo'), 0) as efectivo,
           count(*) filter (where payment_method = 'efectivo') as n_efectivo,
           coalesce(sum(total_price) filter (where payment_method = 'tarjeta'), 0) as tarjeta,
           count(*) filter (where payment_method = 'tarjeta') as n_tarjeta,
           coalesce(sum(total_price) filter (where payment_method = 'transferencia'), 0) as transferencia,
           count(*) filter (where payment_method = 'transferencia') as n_transferencia
      from public.sales
     where location_id = s.location_id and created_at >= s.abierto_at and created_at < p_hasta
  ), m as (
    select coalesce(sum(monto) filter (where tipo = 'entrada'), 0) as entradas,
           coalesce(sum(monto) filter (where tipo = 'retiro'), 0) as retiros
      from public.cash_movements where session_id = s.id
  )
  select jsonb_build_object(
    'ventas_efectivo', round(v.efectivo, 2), 'n_efectivo', v.n_efectivo,
    'tarjeta', round(v.tarjeta, 2), 'n_tarjeta', v.n_tarjeta,
    'transferencia', round(v.transferencia, 2), 'n_transferencia', v.n_transferencia,
    'entradas', round(m.entradas, 2), 'retiros', round(m.retiros, 2),
    'esperado', round(s.fondo + v.efectivo + m.entradas - m.retiros, 2))
  from v, m;
$$;

revoke all on function public.caja_suma_conteo(jsonb), public.caja_quien(uuid),
                       public.caja_cuentas(public.cash_sessions, timestamptz) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Para la cajera (y la gerente)
-- ----------------------------------------------------------------------------

-- ¿Está abierta la caja? Sin el esperado ni lo que dejó el cierre anterior:
-- la apertura también se cuenta a ciegas.
create or replace function public.caja_estado(p_location uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); s public.cash_sessions;
begin
  select * into s from public.cash_sessions where location_id = p_location and cerrado_at is null;
  if s.id is null then
    return jsonb_build_object('abierta', false,
      'ultimo_cierre', (select cerrado_at from public.cash_sessions where location_id = p_location order by cerrado_at desc nulls last limit 1));
  end if;
  return jsonb_build_object('abierta', true, 'turno', jsonb_build_object(
    'id', s.id, 'abierto_por', s.abierto_nombre, 'abierto_at', s.abierto_at, 'es_mio', s.abierto_por = p.id,
    'movimientos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'motivo', motivo,
                      'por', creado_nombre, 'cuando', creado_at) order by creado_at), '[]'::jsonb)
                      from public.cash_movements where session_id = s.id)));
end $$;

-- Abrir la caja contando el fondo. Devuelve, ya guardado el conteo, si
-- coincide con lo que dejó el cierre anterior.
create or replace function public.caja_abrir(p_location uuid, p_conteo jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); v_fondo numeric; v_ant numeric; v_id uuid;
begin
  v_fondo := public.caja_suma_conteo(p_conteo);
  perform pg_advisory_xact_lock(hashtextextended('caja:' || p_location::text, 0));
  if exists (select 1 from public.cash_sessions where location_id = p_location and cerrado_at is null) then
    raise exception 'La caja ya está abierta';
  end if;
  select deja_fondo into v_ant from public.cash_sessions
   where location_id = p_location and cerrado_at is not null order by cerrado_at desc limit 1;
  insert into public.cash_sessions (location_id, abierto_por, abierto_nombre, fondo, fondo_detalle, fondo_anterior)
  values (p_location, p.id, coalesce(p.full_name, 'Sin nombre'), v_fondo, p_conteo, v_ant)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'fondo', v_fondo, 'fondo_anterior', v_ant,
                            'diferencia_entrega', case when v_ant is null then null else v_fondo - v_ant end);
end $$;

-- Retiro (a la caja fuerte, pago a un proveedor) o entrada (cambio) de efectivo.
create or replace function public.caja_movimiento(p_location uuid, p_tipo text, p_monto numeric, p_motivo text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); s public.cash_sessions;
begin
  if p_tipo not in ('retiro', 'entrada') then raise exception 'Tipo de movimiento no válido'; end if;
  if p_monto is null or p_monto <= 0 or p_monto > 1000000 then raise exception 'Monto no válido'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Escribe el motivo'; end if;
  select * into s from public.cash_sessions where location_id = p_location and cerrado_at is null for update;
  if s.id is null then raise exception 'La caja está cerrada: ábrela primero'; end if;
  insert into public.cash_movements (session_id, location_id, tipo, monto, motivo, creado_por, creado_nombre)
  values (s.id, p_location, p_tipo, round(p_monto, 2), left(trim(p_motivo), 200), p.id, coalesce(p.full_name, 'Sin nombre'));
  return public.caja_estado(p_location);
end $$;

-- Cerrar la caja: el conteo se guarda primero y el esperado se calcula
-- después, en la misma transacción. Lo cierra quien la entrega, la que la
-- recibe o la gerente; queda anotado quién.
create or replace function public.caja_cerrar(p_location uuid, p_conteo jsonb, p_deja_fondo numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); s public.cash_sessions; v_contado numeric; c jsonb; v_ahora timestamptz := now();
begin
  v_contado := public.caja_suma_conteo(p_conteo);
  if p_deja_fondo is null or p_deja_fondo < 0 then raise exception 'Escribe cuánto queda de fondo en la caja (puede ser 0)'; end if;
  if p_deja_fondo > v_contado then raise exception 'No puede quedar de fondo más de lo que contaste'; end if;
  select * into s from public.cash_sessions where location_id = p_location and cerrado_at is null for update;
  if s.id is null then raise exception 'La caja ya está cerrada'; end if;
  c := public.caja_cuentas(s, v_ahora);
  update public.cash_sessions
     set cerrado_por = p.id, cerrado_nombre = coalesce(p.full_name, 'Sin nombre'), cerrado_at = v_ahora,
         contado = v_contado, contado_detalle = p_conteo, esperado = (c->>'esperado')::numeric,
         deja_fondo = round(p_deja_fondo, 2)
   where id = s.id;
  return c || jsonb_build_object('id', s.id, 'fondo', s.fondo, 'contado', v_contado, 'deja_fondo', round(p_deja_fondo, 2),
    'diferencia', v_contado - (c->>'esperado')::numeric, 'abierto_por', s.abierto_nombre, 'abierto_at', s.abierto_at,
    'cerrado_por', coalesce(p.full_name, 'Sin nombre'), 'cerrado_at', v_ahora,
    'fondo_anterior', s.fondo_anterior);
end $$;

-- Quien cerró puede explicar la diferencia, una vez, en la siguiente hora.
create or replace function public.caja_explicar(p_session uuid, p_texto text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.cash_sessions;
begin
  select * into s from public.cash_sessions where id = p_session for update;
  if s.id is null then raise exception 'Ese turno no existe'; end if;
  perform public.caja_quien(s.location_id);
  if s.cerrado_por is distinct from auth.uid() then raise exception 'Solo quien cerró la caja puede explicar la diferencia'; end if;
  if s.explicacion is not null then raise exception 'La explicación ya se guardó'; end if;
  if now() - s.cerrado_at > interval '1 hour' then raise exception 'Ya pasó el tiempo para explicarlo: díselo a la gerente'; end if;
  if length(trim(coalesce(p_texto, ''))) < 3 then raise exception 'Escribe la explicación'; end if;
  update public.cash_sessions set explicacion = left(trim(p_texto), 300) where id = p_session;
end $$;

-- ----------------------------------------------------------------------------
-- Para la gerente y la propietaria
-- ----------------------------------------------------------------------------

-- Los turnos de un periodo, con el esperado de nuevo calculado y las ventas
-- en efectivo que no cayeron en ningún turno.
create or replace function public.caja_turnos(p_location uuid, p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ini timestamptz; v_fin timestamptz; v_tz text;
begin
  if public.app_role() not in ('gerente', 'propietario') or not public.can_manage_location(p_location) then
    raise exception 'Solo la gerente o la propietaria ven los turnos de caja';
  end if;
  if p_hasta < p_desde or p_hasta - p_desde > 92 then raise exception 'Periodo no válido (hasta 3 meses)'; end if;
  select public.zona_tienda(country_code) into v_tz from public.locations where id = p_location;
  v_ini := p_desde::timestamp at time zone v_tz;
  v_fin := (p_hasta + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'turnos', coalesce((select jsonb_agg(t order by (t->>'abierto_at') desc) from (
      select jsonb_build_object(
        'id', s.id, 'abierto_por', s.abierto_nombre, 'abierto_at', s.abierto_at,
        'cerrado_por', s.cerrado_nombre, 'cerrado_at', s.cerrado_at,
        'fondo', s.fondo, 'fondo_anterior', s.fondo_anterior,
        'diferencia_entrega', case when s.fondo_anterior is null then null else s.fondo - s.fondo_anterior end,
        'contado', s.contado, 'esperado_al_cerrar', s.esperado, 'deja_fondo', s.deja_fondo,
        'diferencia', case when s.cerrado_at is null then null else s.contado - s.esperado end,
        'explicacion', s.explicacion, 'revisado_por', s.revisado_nombre, 'revisado_at', s.revisado_at, 'nota_revision', s.nota_revision,
        'contado_detalle', s.contado_detalle,
        'movimientos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'motivo', motivo,
                          'por', creado_nombre, 'cuando', creado_at) order by creado_at), '[]'::jsonb)
                          from public.cash_movements where session_id = s.id)
      ) || public.caja_cuentas(s, coalesce(s.cerrado_at, now())) as t
      from public.cash_sessions s
      where s.location_id = p_location and s.abierto_at < v_fin and coalesce(s.cerrado_at, now()) >= v_ini) x), '[]'::jsonb),
    'fuera_de_turno', (
      select jsonb_build_object('ventas', count(*), 'total', coalesce(round(sum(v.total_price), 2), 0),
               'folios', coalesce(jsonb_agg(v.folio order by v.created_at) filter (where v.folio is not null), '[]'::jsonb))
        from public.sales v
       where v.location_id = p_location and v.payment_method = 'efectivo'
         and v.created_at >= v_ini and v.created_at < v_fin
         and not exists (select 1 from public.cash_sessions s
                          where s.location_id = v.location_id and v.created_at >= s.abierto_at
                            and v.created_at < coalesce(s.cerrado_at, 'infinity'))));
end $$;

-- La gerente revisa un cierre (con nota si hace falta). No cambia los números.
create or replace function public.caja_revisar(p_session uuid, p_nota text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.cash_sessions; p public.profiles;
begin
  select * into s from public.cash_sessions where id = p_session for update;
  if s.id is null then raise exception 'Ese turno no existe'; end if;
  if public.app_role() not in ('gerente', 'propietario') or not public.can_manage_location(s.location_id) then
    raise exception 'Solo la gerente o la propietaria revisan los cierres';
  end if;
  if s.cerrado_at is null then raise exception 'La caja sigue abierta'; end if;
  if s.revisado_at is not null then raise exception 'Ese cierre ya se revisó'; end if;
  select * into p from public.profiles where id = auth.uid();
  update public.cash_sessions
     set revisado_por = p.id, revisado_nombre = coalesce(p.full_name, 'Sin nombre'), revisado_at = now(),
         nota_revision = nullif(left(trim(coalesce(p_nota, '')), 300), '')
   where id = p_session;
end $$;

do $$ declare f text; begin
  foreach f in array array['caja_estado(uuid)', 'caja_abrir(uuid, jsonb)', 'caja_movimiento(uuid, text, numeric, text)',
                           'caja_cerrar(uuid, jsonb, numeric)', 'caja_explicar(uuid, text)',
                           'caja_turnos(uuid, date, date)', 'caja_revisar(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- El respaldo nocturno copia también la caja.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log','app_tamanos','app_config','pedidos_app',
               'cash_sessions','cash_movements'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

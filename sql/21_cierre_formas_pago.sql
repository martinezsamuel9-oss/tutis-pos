-- ============================================================================
-- 21. CIERRE DE CAJA POR FORMA DE PAGO (como en ICG, mejorado)
-- ----------------------------------------------------------------------------
-- Pedido del negocio (2026-10-30), con el video del cierre en ICG:
--   1. Pre-cierre del POS de BAC (la lista de vouchers del lote).
--   2. Cierre de BAC (el datáfono liquida el lote y da un número).
--   3. Cierre de caja declarando: efectivo (apartando el fondo),
--      transferencias, tarjeta BAC y delivery (Pedidos Ya, Hugo).
--   4. Aceptar y ver si salió faltante o sobrante.
--
-- Lo que mejora sobre ICG:
--   · El pre-cierre lo arma la caja con los vouchers anotados en cada venta
--     (sql/16): número de autorización, últimos 4 y monto, para cotejarlos
--     uno por uno contra la tira del datáfono. Marca autorizaciones repetidas
--     o vacías antes de cerrar, no al día siguiente.
--   · El lote del datáfono (número, cantidad y monto) queda guardado con el
--     turno: contabilidad cuadra contra el depósito de BAC sin buscar papeles.
--   · El conteo sigue siendo CIEGO (sql/19). Lo declarado se guarda antes de
--     calcular lo esperado, en la misma transacción.
--
-- Formas de pago: efectivo, tarjeta (BAC), transferencia, pedidosya, hugo.
-- process_sale NO las valida (una venta nunca se rechaza): lo que no se
-- reconozca sale en los reportes con su nombre tal cual.
-- ============================================================================

alter table public.cash_sessions add column if not exists declarado jsonb;      -- {"tarjeta": 2601.24, "transferencia": 0, ...}
alter table public.cash_sessions add column if not exists lote_tarjeta jsonb;   -- {"lote": "000389", "ventas": 8, "monto": 2601.24}
alter table public.cash_sessions add column if not exists cuentas_al_cerrar jsonb;

-- Las formas de pago que no son efectivo y se declaran al cerrar.
create or replace function public.formas_pago_declarables()
returns text[] language sql immutable as $$ select array['tarjeta', 'transferencia', 'pedidosya', 'hugo'] $$;

-- Lo que debería haber, por forma de pago, para un turno hasta un instante.
-- Conserva las llaves de sql/19 (la pantalla y las pruebas las usan).
create or replace function public.caja_cuentas(s public.cash_sessions, p_hasta timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  with v as (
    select coalesce(nullif(trim(payment_method), ''), 'sin_dato') as metodo, count(*) as n, round(sum(total_price), 2) as total
      from public.sales
     where location_id = s.location_id and created_at >= s.abierto_at and created_at < p_hasta
     group by 1
  ), m as (
    select coalesce(sum(monto) filter (where tipo = 'entrada'), 0) as entradas,
           coalesce(sum(monto) filter (where tipo = 'retiro'), 0) as retiros
      from public.cash_movements where session_id = s.id
  ), t as (
    select coalesce(jsonb_object_agg(metodo, jsonb_build_object('n', n, 'total', total)), '{}'::jsonb) as por_pago,
           coalesce(sum(total) filter (where metodo = 'efectivo'), 0) as efectivo
      from v
  )
  select jsonb_build_object(
    'por_pago', t.por_pago,
    'ventas_efectivo', round(t.efectivo, 2), 'n_efectivo', coalesce((t.por_pago->'efectivo'->>'n')::int, 0),
    'tarjeta', coalesce((t.por_pago->'tarjeta'->>'total')::numeric, 0), 'n_tarjeta', coalesce((t.por_pago->'tarjeta'->>'n')::int, 0),
    'transferencia', coalesce((t.por_pago->'transferencia'->>'total')::numeric, 0), 'n_transferencia', coalesce((t.por_pago->'transferencia'->>'n')::int, 0),
    'entradas', round(m.entradas, 2), 'retiros', round(m.retiros, 2),
    'esperado', round(s.fondo + t.efectivo + m.entradas - m.retiros, 2))
  from t, m;
$$;
revoke all on function public.caja_cuentas(public.cash_sessions, timestamptz) from public, anon, authenticated;

-- Valida lo declarado: solo formas de pago conocidas, montos razonables.
-- Lo que no venga se toma como 0 (la pantalla manda todas).
create or replace function public.caja_limpia_declarado(d jsonb)
returns jsonb language plpgsql immutable as $$
declare k text; v jsonb; r jsonb := '{}'::jsonb;
begin
  if d is null then d := '{}'::jsonb; end if;
  if jsonb_typeof(d) <> 'object' then raise exception 'Lo declarado no es válido'; end if;
  for k, v in select * from jsonb_each(d) loop
    if not k = any(public.formas_pago_declarables()) then raise exception 'Forma de pago no válida: %', k; end if;
    if jsonb_typeof(v) <> 'number' or v::text::numeric < 0 or v::text::numeric > 10000000
       or round(v::text::numeric, 2) <> v::text::numeric then
      raise exception 'Monto declarado no válido para %', k;
    end if;
  end loop;
  foreach k in array public.formas_pago_declarables() loop
    r := r || jsonb_build_object(k, coalesce((d->>k)::numeric, 0));
  end loop;
  return r;
end $$;

create or replace function public.caja_limpia_lote(l jsonb)
returns jsonb language plpgsql immutable as $$
begin
  if l is null or l = 'null'::jsonb then return null; end if;
  if jsonb_typeof(l) <> 'object' then raise exception 'El cierre del datáfono no es válido'; end if;
  if coalesce(l->>'lote', '') !~ '^[0-9A-Za-z]{1,12}$' then raise exception 'Número de lote o autorización del cierre no válido'; end if;
  if jsonb_typeof(l->'ventas') <> 'number' or (l->>'ventas') !~ '^[0-9]{1,4}$' then raise exception 'Cantidad de ventas del lote no válida'; end if;
  if jsonb_typeof(l->'monto') <> 'number' or (l->>'monto')::numeric < 0 or (l->>'monto')::numeric > 10000000
     or round((l->>'monto')::numeric, 2) <> (l->>'monto')::numeric then
    raise exception 'Monto del lote no válido';
  end if;
  return jsonb_build_object('lote', upper(l->>'lote'), 'ventas', (l->>'ventas')::int, 'monto', (l->>'monto')::numeric);
end $$;
revoke all on function public.caja_limpia_declarado(jsonb), public.caja_limpia_lote(jsonb) from public, anon, authenticated;

-- El cuadre: sistema contra declarado, por forma de pago. Positivo = sobra.
create or replace function public.caja_cuadre(c jsonb, p_contado numeric, p_declarado jsonb, p_lote jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'formas', (
      select jsonb_agg(jsonb_build_object('metodo', k, 'sistema', sis, 'declarado', dec, 'diferencia', dec - sis,
                                          'n', coalesce((c->'por_pago'->k->>'n')::int, 0)) order by ord)
        from (
          select 'efectivo' as k, 0 as ord, (c->>'esperado')::numeric as sis, p_contado as dec
          union all
          select k, o, coalesce((c->'por_pago'->k->>'total')::numeric, 0), coalesce((p_declarado->>k)::numeric, 0)
            from unnest(public.formas_pago_declarables()) with ordinality as u(k, o)
        ) x),
    'total_sistema', (c->>'esperado')::numeric
                     + (select coalesce(sum(coalesce((c->'por_pago'->k->>'total')::numeric, 0)), 0) from unnest(public.formas_pago_declarables()) k),
    'total_declarado', p_contado + (select coalesce(sum((p_declarado->>k)::numeric), 0) from unnest(public.formas_pago_declarables()) k),
    'lote', p_lote,
    'lote_diferencia', case when p_lote is null then null
                            else (p_lote->>'monto')::numeric - coalesce((c->'por_pago'->'tarjeta'->>'total')::numeric, 0) end,
    'lote_ventas_diferencia', case when p_lote is null then null
                            else (p_lote->>'ventas')::int - coalesce((c->'por_pago'->'tarjeta'->>'n')::int, 0) end)
  || jsonb_build_object('diferencia_total',
       (p_contado + (select coalesce(sum((p_declarado->>k)::numeric), 0) from unnest(public.formas_pago_declarables()) k))
       - ((c->>'esperado')::numeric
          + (select coalesce(sum(coalesce((c->'por_pago'->k->>'total')::numeric, 0)), 0) from unnest(public.formas_pago_declarables()) k)));
$$;
revoke all on function public.caja_cuadre(jsonb, numeric, jsonb, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. Pre-cierre de tarjeta: los vouchers del turno abierto, para cotejarlos
--    contra la tira del datáfono antes de liquidar el lote.
-- ----------------------------------------------------------------------------
create or replace function public.caja_precierre(p_location uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); s public.cash_sessions;
begin
  select * into s from public.cash_sessions where location_id = p_location and cerrado_at is null;
  if s.id is null then raise exception 'La caja está cerrada'; end if;
  return (
    with t as (
      select folio, created_at, total_price, nullif(card_auth_code, '') as aut, card_last4, cashier_name
        from public.sales
       where location_id = p_location and payment_method = 'tarjeta'
         and created_at >= s.abierto_at)
    select jsonb_build_object(
      'desde', s.abierto_at,
      'ventas', count(*), 'monto', coalesce(round(sum(total_price), 2), 0),
      'sin_autorizacion', count(*) filter (where aut is null),
      'vouchers', coalesce(jsonb_agg(jsonb_build_object(
          'folio', folio, 'hora', created_at, 'monto', total_price, 'autorizacion', aut, 'ultimos4', card_last4,
          'cajera', cashier_name,
          'repetida', aut is not null and (select count(*) from t t2 where t2.aut = t.aut) > 1)
        order by created_at), '[]'::jsonb))
    from t);
end $$;

-- ----------------------------------------------------------------------------
-- 2-4. Cerrar declarando todas las formas de pago.
-- ----------------------------------------------------------------------------
drop function if exists public.caja_cerrar(uuid, jsonb, numeric);
create or replace function public.caja_cerrar(p_location uuid, p_conteo jsonb, p_deja_fondo numeric,
                                              p_declarado jsonb default '{}'::jsonb, p_lote jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles := public.caja_quien(p_location); s public.cash_sessions; v_contado numeric; c jsonb;
        v_dec jsonb; v_lote jsonb; v_ahora timestamptz := now(); q jsonb;
begin
  v_contado := public.caja_suma_conteo(p_conteo);
  v_dec := public.caja_limpia_declarado(p_declarado);
  v_lote := public.caja_limpia_lote(p_lote);
  if p_deja_fondo is null or p_deja_fondo < 0 then raise exception 'Escribe cuánto queda de fondo en la caja (puede ser 0)'; end if;
  if p_deja_fondo > v_contado then raise exception 'No puede quedar de fondo más de lo que contaste'; end if;
  select * into s from public.cash_sessions where location_id = p_location and cerrado_at is null for update;
  if s.id is null then raise exception 'La caja ya está cerrada'; end if;
  c := public.caja_cuentas(s, v_ahora);
  -- Hubo ventas con tarjeta: primero el cierre del datáfono (como en ICG).
  if coalesce((c->>'n_tarjeta')::int, 0) > 0 and v_lote is null then
    raise exception 'Hubo ventas con tarjeta: primero haz el cierre del datáfono y anota el lote';
  end if;
  q := public.caja_cuadre(c, v_contado, v_dec, v_lote);
  update public.cash_sessions
     set cerrado_por = p.id, cerrado_nombre = coalesce(p.full_name, 'Sin nombre'), cerrado_at = v_ahora,
         contado = v_contado, contado_detalle = p_conteo, esperado = (c->>'esperado')::numeric,
         deja_fondo = round(p_deja_fondo, 2), declarado = v_dec, lote_tarjeta = v_lote, cuentas_al_cerrar = c
   where id = s.id;
  return c || q || jsonb_build_object('id', s.id, 'fondo', s.fondo, 'contado', v_contado, 'deja_fondo', round(p_deja_fondo, 2),
    'diferencia', v_contado - (c->>'esperado')::numeric, 'abierto_por', s.abierto_nombre, 'abierto_at', s.abierto_at,
    'cerrado_por', coalesce(p.full_name, 'Sin nombre'), 'cerrado_at', v_ahora,
    'fondo_anterior', s.fondo_anterior, 'declarado', v_dec);
end $$;

-- ----------------------------------------------------------------------------
-- Turnos (gerente, contabilidad y propietaria): con el cuadre por forma de pago
-- ----------------------------------------------------------------------------
create or replace function public.caja_turnos(p_location uuid, p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ini timestamptz; v_fin timestamptz; v_tz text;
begin
  if p_location is null or not public.can_account_location(p_location) then
    raise exception 'Solo la gerente, contabilidad o la propietaria ven los turnos de caja';
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
        'declarado', s.declarado, 'lote_tarjeta', s.lote_tarjeta,
        'explicacion', s.explicacion, 'revisado_por', s.revisado_nombre, 'revisado_at', s.revisado_at, 'nota_revision', s.nota_revision,
        'contado_detalle', s.contado_detalle,
        'movimientos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'motivo', motivo,
                          'por', creado_nombre, 'cuando', creado_at) order by creado_at), '[]'::jsonb)
                          from public.cash_movements where session_id = s.id)
      ) || cu || case when s.cerrado_at is null then '{}'::jsonb
                      else public.caja_cuadre(cu, s.contado, coalesce(s.declarado, public.caja_limpia_declarado('{}')), s.lote_tarjeta) end as t
      from public.cash_sessions s, lateral (select public.caja_cuentas(s, coalesce(s.cerrado_at, now())) as cu) x
      where s.location_id = p_location and s.abierto_at < v_fin and coalesce(s.cerrado_at, now()) >= v_ini) y), '[]'::jsonb),
    'fuera_de_turno', (
      select jsonb_build_object('ventas', count(*), 'total', coalesce(round(sum(v.total_price), 2), 0),
               'folios', coalesce(jsonb_agg(v.folio order by v.created_at) filter (where v.folio is not null), '[]'::jsonb))
        from public.sales v
       where v.location_id = p_location
         and v.created_at >= v_ini and v.created_at < v_fin
         and not exists (select 1 from public.cash_sessions s
                          where s.location_id = v.location_id and v.created_at >= s.abierto_at
                            and v.created_at < coalesce(s.cerrado_at, 'infinity'))));
end $$;

do $$ declare f text; begin
  foreach f in array array['caja_precierre(uuid)', 'caja_cerrar(uuid, jsonb, numeric, jsonb, jsonb)',
                           'caja_turnos(uuid, date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

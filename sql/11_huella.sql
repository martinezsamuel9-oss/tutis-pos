-- ============================================================================
--  TUTI'S — Autorizar con la huella del teléfono de la gerente
--
--  Correr DESPUÉS de 01..10. Es idempotente.
--
--  CÓMO FUNCIONA (lo pidió el dueño, 2026-10-07)
--    Cada persona registra una "passkey" en SU teléfono. Para iniciar sesión
--    o para autorizar, la caja muestra un QR, ella lo escanea y confirma con
--    la huella o la cara de su teléfono. Quien verifica la firma es Supabase
--    Auth (Auth → Passkeys); a la base solo le llega la sesión resultante.
--
--  POR QUÉ EL TELÉFONO Y NO UN LECTOR EN LA CAJA
--    Un lector conectado a Windows no sabe QUIÉN puso el dedo, solo que es
--    uno de los registrados en esa cuenta de Windows. En una caja compartida,
--    la cajera elegiría la cuenta de la gerente y pondría su propio dedo. El
--    teléfono es de una sola persona.
--
--  LO QUE REVISA autorizar_peso_presencial
--    · Quien llama es una gerente de esa tienda (o el propietario).
--    · Esa sesión se abrió CON PASSKEY y hace menos de 5 minutos (el "amr"
--      del JWT). Una sesión de la gerente abierta con contraseña, o una vieja
--      que quedó en algún lado, no sirve para autorizar.
--    · La cajera que pidió la autorización es de esa tienda.
--  El PIN de 10_peso_fijo.sql sigue funcionando como respaldo. El reporte
--  dice con qué se autorizó cada venta.
-- ============================================================================

alter table public.weight_authorizations
  add column if not exists method text not null default 'pin';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'weight_auth_method_chk') then
    alter table public.weight_authorizations
      add constraint weight_auth_method_chk check (method in ('pin', 'huella'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. AUTORIZAR CON HUELLA
--    La llama la caja con una sesión APARTE, la de la gerente, que se abre
--    solo para esto y se cierra enseguida. Por eso quien llama es la gerente
--    y la cajera viene como parámetro.
-- ----------------------------------------------------------------------------
create or replace function public.autorizar_peso_presencial(
  p_location_id uuid, p_requested_by uuid, p_weight_g numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mgr    public.profiles%rowtype;
  v_caj    public.profiles%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 200);
  v_id     uuid;
begin
  select * into v_mgr from public.profiles where id = auth.uid() and active;
  if v_mgr.id is null then
    raise exception 'Esa huella no corresponde a un usuario activo';
  end if;
  if not (v_mgr.role = 'propietario' or (v_mgr.role = 'gerente' and v_mgr.location_id = p_location_id)) then
    raise exception '% no puede autorizar en esta tienda', coalesce(v_mgr.full_name, 'Esa persona');
  end if;

  -- La sesión tiene que venir de una passkey, y de hace menos de 5 minutos.
  if not exists (
    select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) m
     where m->>'method' = 'passkey'
       and (m->>'timestamp')::bigint >= extract(epoch from now())::bigint - 300
  ) then
    raise exception 'Para autorizar con huella hay que confirmarla en el teléfono en ese momento';
  end if;

  select * into v_caj from public.profiles where id = p_requested_by and active;
  if v_caj.id is null or not (v_caj.role = 'propietario' or v_caj.location_id = p_location_id) then
    raise exception 'La persona que cobra no es de esta tienda';
  end if;
  if p_weight_g is null or p_weight_g <= 0 or p_weight_g > 100000 then
    raise exception 'Peso fuera de rango';
  end if;
  if length(v_reason) < 3 then
    raise exception 'Escribe el motivo';
  end if;

  insert into public.weight_authorizations
    (location_id, requested_by, requested_by_name, authorized_by, authorized_by_name, weight_g, reason, method)
  values
    (p_location_id, v_caj.id, v_caj.full_name, v_mgr.id, v_mgr.full_name, round(p_weight_g, 2), v_reason, 'huella')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'authorized_by_name', v_mgr.full_name);
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. EL REPORTE DICE CON QUÉ SE AUTORIZÓ
--    Es control_pesos de 10_peso_fijo.sql con una columna más (metodo).
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
           v.total_price as total, w.authorized_by_name as autorizo, w.method as metodo, w.reason as motivo
      from v left join public.weight_authorizations w on w.id = v.weight_auth_id
     where v.weight_source in ('bascula_no_cuadra', 'manual_autorizado', 'manual_sin_autorizar', 'sin_dato')
    union all
    select 'anulacion', a.created_at, null, a.cashier_name, 'anulacion',
           a.weighed_g, null, null, null, a.reason
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

revoke all on function public.autorizar_peso_presencial(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.autorizar_peso_presencial(uuid, uuid, numeric, text) to authenticated;
revoke all on function public.control_pesos(uuid, date, date, int) from public, anon;
grant execute on function public.control_pesos(uuid, date, date, int) to authenticated;

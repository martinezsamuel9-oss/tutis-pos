-- ============================================================================
--  TUTI'S — Envío automático del cierre del día
--
--  Correr DESPUÉS de 01..06. Es idempotente.
--
--  Qué agrega:
--    · daily_closing_all()  — el cierre de TODAS las sucursales de un día, en
--      una sola llamada. La usa el proceso automático que manda los correos.
--    · closing_email_log    — qué se mandó, a quién y si salió bien.
--
--  Por qué una función aparte y no reusar daily_closing():
--    daily_closing() pregunta "¿este USUARIO puede ver esta sucursal?". El
--    proceso automático corre de madrugada, sin usuario: auth.uid() es NULL y
--    la pregunta siempre daría que no. Esta función no pregunta por usuario —
--    y por eso se le quita el permiso a todo el mundo menos al rol de
--    servicio, que es el único que puede llamarla. Dicho de otro modo: el
--    permiso aquí no es "quién eres" sino "tienes la llave del servidor".
--
--    ESA LLAVE NUNCA VA EN EL NAVEGADOR. Vive como secreto en Cloudflare.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BITÁCORA DE ENVÍOS
--    Sirve para dos cosas: que se pueda ver si el correo de anoche salió, y
--    que si el proceso se dispara dos veces el mismo día no llegue duplicado.
-- ----------------------------------------------------------------------------
create table if not exists public.closing_email_log (
  id          bigserial primary key,
  day         date not null,
  location_id uuid references public.locations(id) on delete cascade,
  recipient   text not null,
  ok          boolean not null default false,
  detail      text,
  sent_at     timestamptz not null default now()
);

-- Un solo envío por día, por sucursal y por destinatario. El "coalesce" está
-- porque el consolidado del propietario no pertenece a ninguna sucursal.
create unique index if not exists uq_closing_email
  on public.closing_email_log (day, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), recipient);

alter table public.closing_email_log enable row level security;

-- Solo el propietario lo consulta, y nadie lo escribe desde la aplicación:
-- quien escribe es el proceso automático con la llave del servidor.
drop policy if exists closing_log_select on public.closing_email_log;
create policy closing_log_select on public.closing_email_log
  for select to authenticated using (public.is_owner());

grant select on public.closing_email_log to authenticated;
revoke all on public.closing_email_log from anon;
revoke all on sequence public.closing_email_log_id_seq from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. EL CIERRE DE TODAS LAS SUCURSALES
--    Devuelve un arreglo con una entrada por sucursal activa, cada una con
--    todo lo que el correo necesita: los datos del día MÁS los de la tienda
--    (nombre, moneda, a qué correo se manda y si trabaja en gramos u onzas).
-- ----------------------------------------------------------------------------
create or replace function public.daily_closing_all(
  p_day              date,
  p_utc_offset_hours int default -6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  select coalesce(jsonb_agg(x.fila order by x.name), '[]'::jsonb)
    into v_out
    from (
      select l.name,
             -- Se reusa daily_closing_core para no tener dos sitios donde
             -- calcular lo mismo y que un día dejen de coincidir.
             public.daily_closing_core(l.id, p_day, p_utc_offset_hours)
               || jsonb_build_object(
                    'location_name',  l.name,
                    'legal_name',     l.legal_name,
                    'currency_code',  l.currency_code,
                    'report_email',   l.report_email,
                    'weight_unit',    l.default_weight_unit,
                    'country_code',   l.country_code
                  ) as fila
        from public.locations l
       where l.active
    ) x;

  return v_out;
end;
$$;

-- El cálculo, sin pregunta de permisos. Es la parte que comparten
-- daily_closing() (que sí pregunta) y daily_closing_all() (que no puede).
create or replace function public.daily_closing_core(
  p_location_id      uuid,
  p_day              date,
  p_utc_offset_hours int default -6
)
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
  v_start := (p_day::timestamp - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';
  v_end   := v_start + interval '1 day';

  with day_sales as (
    select id, total_price, total_cost, margin
      from public.sales
     where location_id = p_location_id
       and created_at >= v_start
       and created_at <  v_end
  ),
  totales_venta as (
    select count(*) as ventas,
           coalesce(sum(total_price), 0) as ingresos,
           coalesce(sum(total_cost), 0)  as costos,
           coalesce(sum(margin), 0)      as margen
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
  gastos as (
    select coalesce(sum(amount), 0) as total
      from public.expenses
     where location_id = p_location_id and spent_on = p_day
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
             jsonb_agg(jsonb_build_object(
               'name',   pt.name,
               'peso_g', round(pt.peso, 2),
               'pct',    case when tl.peso_toppings > 0
                              then round(100 * pt.peso / tl.peso_toppings, 2) else 0 end
             ) order by pt.peso desc), '[]'::jsonb) as items
      from por_topping pt cross join totales_linea tl
  )
  select jsonb_build_object(
           'location_id',     p_location_id,
           'day',             p_day,
           'ventas',          tv.ventas,
           'ingresos',        round(tv.ingresos, 2),
           'costos',          round(tv.costos, 2),
           'margen',          round(tv.margen, 2),
           'gastos',          round(g.total, 2),
           'utilidad',        round(tv.margen - g.total, 2),
           'vasos',           tl.vasos,
           'cucharas',        tl.cucharas,
           'peso_helado_g',   round(tl.peso_helado, 2),
           'peso_toppings_g', round(tl.peso_toppings, 2),
           'toppings',        tj.items
         )
    into v_result
    from totales_venta tv
   cross join totales_linea tl
   cross join gastos g
   cross join toppings_json tj;

  return v_result;
end;
$$;

-- El núcleo no pregunta permisos, así que NADIE lo puede llamar directo desde
-- la aplicación: se llega a él por daily_closing(), que sí pregunta.
revoke all on function public.daily_closing_core(uuid, date, int) from public, anon, authenticated;

-- Y el de todas las sucursales, solo la llave del servidor.
revoke all on function public.daily_closing_all(date, int) from public, anon, authenticated;
grant execute on function public.daily_closing_all(date, int) to service_role;
grant execute on function public.daily_closing_core(uuid, date, int) to service_role;

-- ----------------------------------------------------------------------------
-- 3. daily_closing() ahora se apoya en el núcleo, pero SIGUE preguntando
--    permisos. Esta es la que llama la aplicación.
-- ----------------------------------------------------------------------------
create or replace function public.daily_closing(p_location_id uuid, p_day date, p_utc_offset_hours int default -6)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_access_location(p_location_id) then
    raise exception 'No tiene permiso para ver esa sucursal';
  end if;
  return public.daily_closing_core(p_location_id, p_day, p_utc_offset_hours);
end;
$$;

revoke all on function public.daily_closing(uuid, date, int) from public;
grant execute on function public.daily_closing(uuid, date, int) to authenticated;

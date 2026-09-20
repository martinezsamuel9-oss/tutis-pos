-- ============================================================================
--  TUTI'S — Ventas por hora (para la gráfica de horas pico)
--
--  Correr DESPUÉS de 01..05. Es idempotente: solo reemplaza la función
--  dashboard_summary por una versión que además devuelve, del mismo periodo,
--  cuántas ventas y cuántos ingresos hubo en cada hora del día.
--
--  Sirve para decidir turnos y cuánto yogurt preparar: saber que el 40 % del
--  día entra entre las 5 y las 8 de la noche cambia cómo se programa el
--  personal. Va por hora LOCAL, no UTC, o la hora pico saldría corrida seis.
-- ============================================================================

create or replace function public.dashboard_summary(
  p_location_id      uuid,
  p_from             date,
  p_to               date,
  p_utc_offset_hours int default -6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start  timestamptz;
  v_end    timestamptz;
  v_result jsonb;
begin
  if not public.can_access_location(p_location_id) then
    raise exception 'No tiene permiso para ver esa sucursal';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Rango de fechas inválido';
  end if;
  -- Un rango enorme no aporta nada al tablero y sí puede pesar en el plan
  -- gratuito. Dos años es más de lo que cualquier pantalla necesita.
  if p_to - p_from > 750 then
    raise exception 'El rango no puede pasar de 750 días';
  end if;

  v_start := (p_from::timestamp            - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';
  v_end   := ((p_to + 1)::timestamp        - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';

  with
  -- La fecha LOCAL de cada venta: es la que el negocio considera "su día".
  day_sales as (
    select s.id,
           ((s.created_at at time zone 'UTC')
             + make_interval(hours => p_utc_offset_hours))::date as dia,
           s.total_price, s.total_cost, s.margin, s.gross_weight_g
      from public.sales s
     where s.location_id = p_location_id
       and s.created_at >= v_start
       and s.created_at <  v_end
  ),
  tot as (
    select count(*)                            as ventas,
           coalesce(sum(total_price), 0)       as ingresos,
           coalesce(sum(total_cost), 0)        as costos,
           coalesce(sum(margin), 0)            as margen,
           coalesce(sum(gross_weight_g), 0)    as peso_total
      from day_sales
  ),
  lineas as (
    select coalesce(sum(case when sl.item_type = 'vaso'    then 1 else 0 end), 0)           as vasos,
           coalesce(sum(case when sl.item_type = 'cuchara' then 1 else 0 end), 0)           as cucharas,
           coalesce(sum(case when sl.item_type = 'helado'  then sl.weight_g else 0 end), 0) as peso_helado,
           coalesce(sum(case when sl.item_type = 'topping' then sl.weight_g else 0 end), 0) as peso_toppings
      from public.sale_lines sl
      join day_sales d on d.id = sl.sale_id
  ),
  gastos as (
    select coalesce(sum(amount), 0) as total
      from public.expenses
     where location_id = p_location_id
       and spent_on between p_from and p_to
  ),
  gastos_cat as (
    select coalesce(
             jsonb_agg(jsonb_build_object('categoria', c.category, 'monto', round(c.monto, 2))
                       order by c.monto desc),
             '[]'::jsonb) as items
      from (select category, sum(amount) as monto
              from public.expenses
             where location_id = p_location_id
               and spent_on between p_from and p_to
             group by category) c
  ),
  -- Serie día por día. generate_series garantiza que los días SIN ventas
  -- aparezcan en cero: si no, la gráfica y el promedio mentirían, porque un
  -- día cerrado se vería como si no existiera.
  dias as (
    select d::date as dia from generate_series(p_from, p_to, interval '1 day') d
  ),
  serie as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'dia',      x.dia,
               'ventas',   x.ventas,
               'ingresos', round(x.ingresos, 2),
               'costos',   round(x.costos, 2),
               'margen',   round(x.margen, 2),
               'gastos',   round(x.gastos, 2)
             ) order by x.dia),
             '[]'::jsonb) as items
      from (
        select dias.dia,
               coalesce(v.ventas, 0)   as ventas,
               coalesce(v.ingresos, 0) as ingresos,
               coalesce(v.costos, 0)   as costos,
               coalesce(v.margen, 0)   as margen,
               coalesce(g.gastos, 0)   as gastos
          from dias
          left join (select dia, count(*) as ventas, sum(total_price) as ingresos,
                            sum(total_cost) as costos, sum(margin) as margen
                       from day_sales group by dia) v on v.dia = dias.dia
          left join (select spent_on, sum(amount) as gastos
                       from public.expenses
                      where location_id = p_location_id
                        and spent_on between p_from and p_to
                      group by spent_on) g on g.spent_on = dias.dia
      ) x
  ),
  -- Ventas por hora LOCAL de la tienda. Es lo que dice a qué hora se llena
  -- el local, que es lo que sirve para decidir turnos y cuánto preparar.
  -- Se calcula con el mismo desfase que todo lo demás: en UTC la hora pico
  -- de Honduras saldría corrida seis horas.
  por_hora as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'hora',     h.hora,
               'ventas',   coalesce(v.ventas, 0),
               'ingresos', round(coalesce(v.ingresos, 0), 2)
             ) order by h.hora),
             '[]'::jsonb) as items
      from generate_series(0, 23) as h(hora)
      left join (
        select extract(hour from ((s.created_at at time zone 'UTC')
                 + make_interval(hours => p_utc_offset_hours)))::int as hora,
               count(*) as ventas, sum(s.total_price) as ingresos
          from public.sales s
         where s.location_id = p_location_id
           and s.created_at >= v_start and s.created_at < v_end
         group by 1
      ) v on v.hora = h.hora
  ),
  por_topping as (
    select sl.name,
           sum(sl.weight_g)                                as peso,
           sum(sl.price_contribution)                      as precio,
           sum(sl.cost)                                    as costo
      from public.sale_lines sl
      join day_sales d on d.id = sl.sale_id
     where sl.item_type = 'topping'
     group by sl.name
  ),
  toppings_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'name',   pt.name,
               'peso_g', round(pt.peso, 2),
               'pct',    case when l.peso_toppings > 0
                              then round(100 * pt.peso / l.peso_toppings, 2) else 0 end,
               'margen', round(pt.precio - pt.costo, 2),
               'margen_pct', case when pt.precio > 0
                                  then round(100 * (pt.precio - pt.costo) / pt.precio, 2) else 0 end
             ) order by pt.peso desc),
             '[]'::jsonb) as items
      from por_topping pt cross join lineas l
  )
  select jsonb_build_object(
           'location_id',     p_location_id,
           'desde',           p_from,
           'hasta',           p_to,
           'dias',            (p_to - p_from) + 1,
           'ventas',          t.ventas,
           'ingresos',        round(t.ingresos, 2),
           'costos',          round(t.costos, 2),
           'margen',          round(t.margen, 2),
           'margen_pct',      case when t.ingresos > 0
                                   then round(100 * t.margen / t.ingresos, 2) else 0 end,
           'gastos',          round(g.total, 2),
           -- Utilidad = lo que dejó el producto MENOS los gastos de operar la
           -- tienda. Es el número que de verdad dice si la tienda gana.
           'utilidad',        round(t.margen - g.total, 2),
           'ticket_promedio', case when t.ventas > 0
                                   then round(t.ingresos / t.ventas, 2) else 0 end,
           'peso_promedio_g', case when t.ventas > 0
                                   then round(t.peso_total / t.ventas, 2) else 0 end,
           'vasos',           l.vasos,
           'cucharas',        l.cucharas,
           'peso_helado_g',   round(l.peso_helado, 2),
           'peso_toppings_g', round(l.peso_toppings, 2),
           'serie',           se.items,
           'por_hora',        ph.items,
           'toppings',        tj.items,
           'gastos_categoria', gc.items
         )
    into v_result
    from tot t
   cross join lineas l
   cross join gastos g
   cross join gastos_cat gc
   cross join serie se
   cross join por_hora ph
   cross join toppings_json tj;

  return v_result;
end;
$$;

revoke all on function public.dashboard_summary(uuid, date, date, int) from public;
grant execute on function public.dashboard_summary(uuid, date, date, int) to authenticated;

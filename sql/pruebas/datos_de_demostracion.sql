-- ============================================================================
--  TUTI'S — DATOS DE DEMOSTRACIÓN  (borrables)
--
--  Genera 14 días de ventas en LAS DOS sucursales para que el tablero, las
--  gráficas y el cierre por correo tengan qué mostrar antes de abrir.
--
--  ⚠ ESTO ESCRIBE EN LA BASE DE PRODUCCIÓN. Está pensado para verlo funcionar
--    antes de empezar a vender de verdad. AL FINAL DE ESTE ARCHIVO está el
--    script para borrarlo todo — córrelo antes del primer día real de ventas.
--
--  Tres cuidados que tiene:
--    · NO toca el inventario. Si ya cargaste existencias reales, quedan
--      intactas; lo único falso son las ventas.
--    · Marca cada fila como prueba (cliente "(datos de prueba)" y gastos que
--      empiezan con "[prueba]"), para poder borrarlas sin dudar.
--    · Apaga los disparadores de auditoría mientras corre. El rastro debe
--      contar lo que pasó de verdad en el negocio, no una simulación.
--
--  Los precios y costos salen de TU catálogo, así que los márgenes que veas
--  son los que de verdad te daría tu configuración actual.
-- ============================================================================

begin;

-- El rastro de auditoría no debe registrar datos inventados.
alter table public.expenses disable trigger trg_audit_expenses;

do $$
declare
  v_offset   int := -6;            -- desfase de las tiendas respecto a UTC
  v_dias     int := 14;            -- cuántos días hacia atrás
  loc        record;
  v_dia      date;
  v_i        int;
  v_n        int;
  v_hora     int;
  v_min      int;
  v_folio    bigint;
  v_sale     uuid;
  v_ts       timestamptz;
  v_precio_g numeric;
  v_vaso     record;
  v_cuchara  record;
  v_sabor    record;
  v_top      record;
  v_peso_h   numeric;
  v_peso_t   numeric;
  v_total    numeric;
  v_costo    numeric;
  v_peso_tot numeric;
  v_ntops    int;
  v_k        int;
  -- Curva de un día: más gente en la tarde-noche. Cada número es una hora,
  -- repetida tantas veces como probable es que caiga una venta ahí.
  v_horas    int[] := array[11,12,12,13,13,14,15,15,16,16,17,17,17,18,18,18,18,19,19,19,19,19,20,20,20,21];
begin
  for loc in select * from public.locations where active order by name loop
    v_precio_g := coalesce(loc.price_per_gram, 0.45);
    select coalesce(max(folio), 0) into v_folio from public.sales where location_id = loc.id;

    for v_i in reverse v_dias-1 .. 0 loop
      v_dia := current_date - v_i;

      -- Viernes, sábado y domingo se vende casi el doble. Sin esa diferencia,
      -- la gráfica "ventas por día de la semana" saldría plana y no serviría
      -- para decidir turnos, que es justo para lo que está.
      v_n := case when extract(isodow from v_dia) in (5,6,7)
                  then 9 + floor(random() * 7)::int
                  else 4 + floor(random() * 4)::int end;
      -- Multiplaza un poco menos concurrida que Galerías.
      if loc.name ilike '%multiplaza%' then v_n := greatest(3, v_n - 2); end if;

      for v_k in 1 .. v_n loop
        v_hora := v_horas[1 + floor(random() * array_length(v_horas,1))::int];
        v_min  := floor(random() * 60)::int;
        v_ts   := ((v_dia::timestamp + make_interval(hours => v_hora, mins => v_min))
                   - make_interval(hours => v_offset)) at time zone 'UTC';

        select * into v_vaso    from public.supplies where location_id=loc.id and kind='vaso'    and active order by random() limit 1;
        select * into v_cuchara from public.supplies where location_id=loc.id and kind='cuchara' and active order by random() limit 1;
        select * into v_sabor   from public.flavors  where location_id=loc.id and active order by random() limit 1;
        if v_vaso.id is null or v_sabor.id is null then
          raise notice 'La sucursal % no tiene vasos o sabores cargados; se omite.', loc.name;
          exit;
        end if;

        v_peso_h := 90 + floor(random() * 140);        -- 90 a 230 g de helado
        v_folio  := v_folio + 1;
        v_total  := 0; v_costo := 0; v_peso_tot := 0;

        insert into public.sales (location_id, client_uuid, folio, cashier_name, created_at,
                                  gross_weight_g, total_price, total_cost, margin, margin_pct,
                                  currency_code, payment_method, customer_name)
        values (loc.id, gen_random_uuid(), v_folio, 'Datos de prueba', v_ts,
                0, 0, 0, 0, 0, loc.currency_code,
                (array['efectivo','efectivo','tarjeta','transferencia'])[1+floor(random()*4)::int],
                '(datos de prueba)')
        returning id into v_sale;

        -- Vaso
        insert into public.sale_lines (sale_id, location_id, item_type, ref_id, name, weight_g, cost, price_contribution)
        values (v_sale, loc.id, 'vaso', v_vaso.id, v_vaso.name, v_vaso.tare_weight_g, v_vaso.cost_per_unit,
                case when loc.include_cup_weight_in_price then v_vaso.tare_weight_g * v_precio_g else 0 end);
        v_costo := v_costo + v_vaso.cost_per_unit;
        v_peso_tot := v_peso_tot + v_vaso.tare_weight_g;
        if loc.include_cup_weight_in_price then v_total := v_total + v_vaso.tare_weight_g * v_precio_g; end if;

        -- Cuchara
        if v_cuchara.id is not null then
          insert into public.sale_lines (sale_id, location_id, item_type, ref_id, name, weight_g, cost, price_contribution)
          values (v_sale, loc.id, 'cuchara', v_cuchara.id, v_cuchara.name, 0, v_cuchara.cost_per_unit, 0);
          v_costo := v_costo + v_cuchara.cost_per_unit;
        end if;

        -- Helado
        insert into public.sale_lines (sale_id, location_id, item_type, ref_id, name, weight_g, cost, price_contribution)
        values (v_sale, loc.id, 'helado', v_sabor.id, v_sabor.name, v_peso_h,
                v_peso_h * v_sabor.cost_per_gram, v_peso_h * v_precio_g);
        v_costo := v_costo + v_peso_h * v_sabor.cost_per_gram;
        v_total := v_total + v_peso_h * v_precio_g;
        v_peso_tot := v_peso_tot + v_peso_h;

        -- De uno a tres toppings
        v_ntops := 1 + floor(random() * 3)::int;
        for v_top in
          select * from public.toppings where location_id=loc.id and active order by random() limit v_ntops
        loop
          v_peso_t := 12 + floor(random() * 34);       -- 12 a 46 g
          insert into public.sale_lines (sale_id, location_id, item_type, ref_id, name, weight_g, cost,
                                         price_contribution, is_premium_surcharge)
          values (v_sale, loc.id, 'topping', v_top.id, v_top.name, v_peso_t,
                  v_peso_t * v_top.cost_per_gram,
                  v_peso_t * (v_precio_g + case when v_top.tier = 2 then v_top.surcharge_per_gram else 0 end),
                  v_top.tier = 2);
          v_costo := v_costo + v_peso_t * v_top.cost_per_gram;
          v_total := v_total + v_peso_t * (v_precio_g + case when v_top.tier = 2 then v_top.surcharge_per_gram else 0 end);
          v_peso_tot := v_peso_tot + v_peso_t;
        end loop;

        -- El encabezado se cuadra con sus líneas, igual que hace process_sale.
        update public.sales
           set gross_weight_g = round(v_peso_tot, 2),
               total_price    = round(v_total, 2),
               total_cost     = round(v_costo, 2),
               margin         = round(v_total - v_costo, 2),
               margin_pct     = case when v_total > 0 then round(100*(v_total-v_costo)/v_total, 2) else 0 end
         where id = v_sale;
      end loop;
    end loop;

    -- Gastos típicos del mes, para que la utilidad y las gráficas de gastos
    -- tengan sentido y no se vea todo como ganancia pura.
    insert into public.expenses (location_id, spent_on, category, description, amount) values
      (loc.id, date_trunc('month', current_date)::date,        'renta',     '[prueba] Renta del mes',      12000),
      (loc.id, date_trunc('month', current_date)::date + 14,   'planilla',  '[prueba] Planilla quincena',   8500),
      (loc.id, current_date - 9,                               'servicios', '[prueba] Energía y agua',      1850),
      (loc.id, current_date - 6,                               'insumos',   '[prueba] Vasos y cucharas',    2400),
      (loc.id, current_date - 3,                               'mercadeo',  '[prueba] Publicidad local',     900)
    on conflict do nothing;

    raise notice 'Sucursal %: listo.', loc.name;
  end loop;
end $$;

alter table public.expenses enable trigger trg_audit_expenses;

commit;

-- Qué quedó
select l.name                                as sucursal,
       count(*)                              as ventas,
       min(s.created_at)::date               as desde,
       max(s.created_at)::date               as hasta,
       round(sum(s.total_price), 2)          as ingresos,
       round(sum(s.margin), 2)               as margen
  from public.sales s
  join public.locations l on l.id = s.location_id
 where s.customer_name = '(datos de prueba)'
 group by l.name
 order by l.name;


-- ============================================================================
--  PARA BORRAR TODO ESTO  (córrelo antes del primer día de ventas reales)
-- ============================================================================
-- begin;
-- alter table public.sales    disable trigger trg_audit_sales;
-- alter table public.expenses disable trigger trg_audit_expenses;
--
-- delete from public.sales    where customer_name = '(datos de prueba)';
-- delete from public.expenses where description like '[prueba]%';
--
-- alter table public.sales    enable trigger trg_audit_sales;
-- alter table public.expenses enable trigger trg_audit_expenses;
-- commit;
--
-- Las líneas de cada venta se van solas (van con "on delete cascade").
-- Los disparadores se apagan para que el rastro de auditoría no se llene de
-- borrados que nunca fueron ventas de verdad.

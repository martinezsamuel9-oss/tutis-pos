-- ============================================================================
--  PRUEBAS: inventario diario, fabricación, recetas y cuadre (sql/23 y 24).
--  Un día completo: conteo de ayer, hoy se fabrica, se suma a la barra, se
--  compra, se vende (por receta y por peso), se cuenta y se cuadra.
--  Correr después de 00..24. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false),
       set_config('t.hoy', ((now() at time zone 'America/Tegucigalpa')::date)::text, false),
       set_config('t.ayer', ((now() at time zone 'America/Tegucigalpa')::date - 1)::text, false);

-- Limpieza (solo en la base local de pruebas).
delete from public.inv_movimientos where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.fabricaciones   where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.inv_conteos     where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.sales where customer_name = '[prueba inventario]';
-- Las otras pruebas dejan ventas de hoy en Galerías: para que el cuadre mida
-- solo lo de esta prueba, se mueven a hace un año.
update public.sales set created_at = created_at - interval '400 days'
 where location_id = current_setting('t.g')::uuid and created_at > now() - interval '3 days';
delete from public.inv_items where nombre like '[prueba inv]%';

insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-000000000001', 'ops.g.inv@tutis.test'),
  ('f0000000-0000-0000-0000-000000000002', 'gerente.g.inv@tutis.test'),
  ('f0000000-0000-0000-0000-000000000003', 'caja.g.inv@tutis.test'),
  ('f0000000-0000-0000-0000-000000000004', 'conta.inv@tutis.test'),
  ('f0000000-0000-0000-0000-000000000005', 'ops.todas.inv@tutis.test'),
  ('f0000000-0000-0000-0000-000000000006', 'duena.inv@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, todas_tiendas, active, full_name) values
  ('f0000000-0000-0000-0000-000000000001', 'operaciones',  current_setting('t.g')::uuid, false, true, 'Ops G'),
  ('f0000000-0000-0000-0000-000000000002', 'gerente',      current_setting('t.g')::uuid, false, true, 'Gerente G'),
  ('f0000000-0000-0000-0000-000000000003', 'cajera',       current_setting('t.g')::uuid, false, true, 'Caja G'),
  ('f0000000-0000-0000-0000-000000000004', 'contabilidad', null, true, true, 'Conta'),
  ('f0000000-0000-0000-0000-000000000005', 'operaciones',  null, true, true, 'Ops todas'),
  ('f0000000-0000-0000-0000-000000000006', 'propietario',  null, false, true, 'Dueña')
on conflict (id) do update set role = excluded.role, location_id = excluded.location_id,
  todas_tiendas = excluded.todas_tiendas, active = true, full_name = excluded.full_name;

create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is distinct from true then raise exception 'FALLA %', msg; end if; raise notice '[ OK ] %', msg; end $$;
create or replace function pg_temp.falla(sql text, espera text, msg text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if position(lower(espera) in lower(sqlerrm)) > 0 then raise notice '[ OK ] % (%)', msg, sqlerrm; return; end if;
    raise exception 'FALLA % — error inesperado: %', msg, sqlerrm;
  end;
  raise exception 'FALLA % — no falló', msg;
end $$;
create or replace function pg_temp.como(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, false);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
end $$;
create or replace function pg_temp.item(n text) returns uuid language sql as $$
  select id from public.inv_items where public.nombre_clave(nombre) = public.nombre_clave(n);
$$;
-- Lo que se cuenta: todo lo diario en un valor, con excepciones.
create or replace function pg_temp.lineas(base numeric, excepciones jsonb) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('item_id', i.id,
           'final', coalesce((excepciones->>i.nombre)::numeric,
                             case i.tipo when 'topping' then 50 when 'maquina' then base when 'base' then 80 else 100 end)))
    from public.inv_items i where i.activo and i.conteo_diario and i.tipo in ('maquina', 'base', 'topping', 'unidad');
$$;
create or replace function pg_temp.c(f text) returns jsonb language sql as $$
  select public.inv_cuadre(current_setting('t.g')::uuid, current_setting(f)::date);
$$;
create or replace function pg_temp.l(c jsonb, n text) returns jsonb language sql as $$
  select x from jsonb_array_elements(c->'lineas') x where x->>'nombre' = n;
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text),
  pg_temp.item(text), pg_temp.lineas(numeric, jsonb), pg_temp.c(text), pg_temp.l(jsonb, text) to authenticated;

-- ============================================================ PERMISOS
set role authenticated;
select pg_temp.como('f0000000-0000-0000-0000-000000000003');   -- cajera
select pg_temp.ok((select count(*) from public.inv_items) = 0, 'P1 la cajera no ve el catálogo de inventario');
select pg_temp.falla($$select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date, '[]')$$,
  'no lleva el inventario', 'P2 ni cuenta');
select pg_temp.como('f0000000-0000-0000-0000-000000000004');   -- contabilidad
select pg_temp.ok((select count(*) from public.inv_items) > 80, 'P3 contabilidad sí ve el catálogo (y sus costos)');
select pg_temp.falla($$select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Fresas'), 'compra', 10)$$,
  'no lleva el inventario', 'P4 pero no mueve inventario');
select pg_temp.como('f0000000-0000-0000-0000-000000000001');   -- operaciones de Galerías
select pg_temp.falla($$select public.inv_guardar_item('{"nombre":"[prueba inv] X","tipo":"topping"}')$$,
  'catálogo de inventario', 'P5 operaciones de UNA tienda no cambia el catálogo de la marca');
select pg_temp.falla($$insert into public.inv_movimientos (location_id, item_id, fecha, tipo, cantidad) values
  (current_setting('t.g')::uuid, pg_temp.item('Fresas'), current_date, 'compra', 1)$$, 'permission denied', 'P6 ni escribe directo en las tablas');
select pg_temp.falla($$select public.inv_guardar_conteo(current_setting('t.m')::uuid, current_setting('t.hoy')::date, '[]')$$,
  'no lleva el inventario', 'P7 ni cuenta en la otra tienda');
select pg_temp.como('f0000000-0000-0000-0000-000000000005');   -- operaciones de todas
select set_config('t.nuevo', public.inv_guardar_item('{"nombre":"[prueba inv] Topping nuevo","tipo":"topping","costo":5.5,"familia":"normal","conteo_diario":false}')::text, false);
select pg_temp.ok((select costo = 5.5 from public.inv_items where id = current_setting('t.nuevo')::uuid), 'P8 operaciones de todas las tiendas sí da de alta artículos');
select pg_temp.falla($$select public.inv_guardar_item('{"nombre":"[PRUEBA INV]  topping NUEVO","tipo":"topping"}')$$,
  'Ya hay un artículo', 'P9 no deja dos artículos con el mismo nombre (mayúsculas y espacios no cuentan)');
select pg_temp.falla($$select public.inv_guardar_item('{"nombre":"[prueba inv] Máquina 9","tipo":"maquina"}')$$,
  'Revisa los datos', 'P10 una máquina sin número y lado no entra');

-- ============================================================ AYER: el conteo con que se arranca
select pg_temp.como('f0000000-0000-0000-0000-000000000001');
select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.ayer')::date,
  pg_temp.lineas(100, '{"Máquina 1 · izquierda": 300}'));
select pg_temp.ok((public.inv_cerrar_conteo(current_setting('t.g')::uuid, current_setting('t.ayer')::date)->>'estado') = 'cerrado',
  'A1 operaciones cuenta y cierra el día de ayer');

-- ============================================================ HOY
-- Fabricación: una tanda de base vainilla con yogurt a la Máquina 1 izquierda.
select set_config('t.fab', (public.inv_fabricar(jsonb_build_object(
  'location_id', current_setting('t.g'), 'receta_id', (select id from recetas where nombre = 'Base vainilla con yogurt'),
  'tandas', 1, 'destino_item_id', pg_temp.item('Máquina 1 · izquierda'), 'sabor', 'Vainilla')))::text, false);
select pg_temp.ok((current_setting('t.fab')::jsonb->>'producido')::numeric = 370, 'F1 una tanda rinde lo de la receta: 370 oz');
select pg_temp.ok((select sum(cantidad) from inv_movimientos where fabricacion_id = (current_setting('t.fab')::jsonb->>'id')::uuid
                    and item_id = pg_temp.item('Leche entera')) = -8,
  'F2 y sale la materia prima: 8 L de leche (y la bolsa, el yogurt y la esencia)');
select pg_temp.falla($$select public.inv_fabricar(jsonb_build_object('location_id', current_setting('t.g'),
  'receta_id', (select id from recetas where nombre = 'Base vainilla con yogurt'), 'tandas', 1, 'producido', 900,
  'destino_item_id', pg_temp.item('Máquina 1 · izquierda')))$$, 'revisa las tandas', 'F3 un rendimiento muy lejos de la receta se rechaza');
select pg_temp.falla($$select public.inv_fabricar(jsonb_build_object('location_id', current_setting('t.g'),
  'receta_id', (select id from recetas where nombre = 'Base original'), 'tandas', 1, 'destino_item_id', pg_temp.item('Máquina 2 · derecha')))$$,
  'cuánto salió', 'F4 una receta sin rendimiento pide lo que salió');
select pg_temp.falla($$select public.inv_fabricar(jsonb_build_object('location_id', current_setting('t.g'),
  'receta_id', (select id from recetas where nombre = 'Base vainilla con yogurt'), 'tandas', 1))$$,
  'a dónde va', 'F5 sin destino no se fabrica');
-- Una fabricación de más, y se borra (con sus movimientos).
select set_config('t.fab2', (public.inv_fabricar(jsonb_build_object(
  'location_id', current_setting('t.g'), 'receta_id', (select id from recetas where nombre = 'Base mango'),
  'tandas', 1, 'destino_item_id', pg_temp.item('Máquina 3 · derecha'))))::text, false);
select public.inv_borrar_fabricacion((current_setting('t.fab2')::jsonb->>'id')::uuid);
select pg_temp.ok(not exists (select 1 from inv_movimientos where fabricacion_id = (current_setting('t.fab2')::jsonb->>'id')::uuid),
  'F6 borrar una fabricación borra sus movimientos');

-- Movimientos sueltos.
select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Máquina 1 · izquierda'), 'merma', 5, 'Goteo');
select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Fresas'), 'sumado', 20);
select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Tazas 16 oz'), 'compra', 50);
select pg_temp.falla($$select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Fresas'), 'merma', 2)$$,
  'motivo', 'M1 una merma sin motivo no entra');
select pg_temp.falla($$select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.hoy')::date, pg_temp.item('Fresas'), 'venta', 2)$$,
  'no se registra a mano', 'M2 una "venta" no se registra a mano: sale de la caja');
select pg_temp.falla($$select public.inv_movimiento(current_setting('t.g')::uuid, current_setting('t.ayer')::date, pg_temp.item('Fresas'), 'compra', 2)$$,
  'ya está cerrado', 'M3 nada entra a un día ya cerrado');
select pg_temp.ok((select cantidad from inv_movimientos where item_id = pg_temp.item('Máquina 1 · izquierda') and tipo = 'merma'
                    and location_id = current_setting('t.g')::uuid) = -5, 'M4 la merma queda en negativo y la compra en positivo');

-- Ventas: dos malteadas de fresa (por receta) y una taza de barra libre (por peso).
reset role; reset request.jwt.claim.sub; reset request.jwt.claims;
do $$
declare v uuid;
begin
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name)
  values (current_setting('t.g')::uuid, gen_random_uuid(), (select coalesce(max(folio), 0) + 1 from sales where location_id = current_setting('t.g')::uuid),
          now(), 260, 'efectivo', '[prueba inventario]') returning id into v;
  insert into public.sale_lines (sale_id, location_id, item_type, name, price_contribution, quantity)
  values (v, current_setting('t.g')::uuid, 'producto', 'Malteada  de FRESA', 260, 2);
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name)
  values (current_setting('t.g')::uuid, gen_random_uuid(), (select coalesce(max(folio), 0) + 1 from sales where location_id = current_setting('t.g')::uuid),
          now(), 130, 'efectivo', '[prueba inventario]') returning id into v;
  insert into public.sale_lines (sale_id, location_id, item_type, name, weight_g, price_contribution, quantity) values
    (v, current_setting('t.g')::uuid, 'vaso', 'Taza 16 oz', 15, 0, 1),
    (v, current_setting('t.g')::uuid, 'helado', 'Yogurt natural', 283.495, 110, 1),
    (v, current_setting('t.g')::uuid, 'topping', 'Oreo', 28.3495, 20, 1),
    (v, current_setting('t.g')::uuid, 'producto', 'Algo sin receta', 0, 0, 1);
end $$;
select pg_temp.ok((select sum(cantidad) from inv_movimientos where tipo = 'venta' and item_id = pg_temp.item('Froyo servido')
                    and location_id = current_setting('t.g')::uuid) = -20,
  'V1 dos malteadas descuentan 20 oz de froyo (el nombre se reconoce con otras mayúsculas y espacios)');
select pg_temp.ok((select sum(cantidad) from inv_movimientos where tipo = 'venta' and item_id = pg_temp.item('Fresas')
                    and location_id = current_setting('t.g')::uuid) = -9.4, 'V2 y 9.4 oz de fresas');
select pg_temp.ok((select sum(cantidad) from inv_movimientos where tipo = 'venta' and item_id = pg_temp.item('Tazas 16 oz')
                    and location_id = current_setting('t.g')::uuid) = -1, 'V3 la taza de barra libre descuenta 1 taza');
select pg_temp.ok((select count(*) from sales where customer_name = '[prueba inventario]') = 2, 'V4 un producto sin receta no frena la venta');
-- Si el descuento falla, la venta entra igual.
alter table public.inv_movimientos add constraint prueba_rompe check (tipo <> 'venta') not valid;
do $$
declare v uuid;
begin
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name)
  values (current_setting('t.g')::uuid, gen_random_uuid(), (select coalesce(max(folio), 0) + 1 from sales where location_id = current_setting('t.g')::uuid),
          now(), 25, 'efectivo', '[prueba inventario]') returning id into v;
  insert into public.sale_lines (sale_id, location_id, item_type, name, price_contribution, quantity)
  values (v, current_setting('t.g')::uuid, 'producto', 'Agua en botella', 25, 1);
end $$;
alter table public.inv_movimientos drop constraint prueba_rompe;
select pg_temp.ok((select count(*) from sales where customer_name = '[prueba inventario]') = 3, 'V5 aunque el descuento por receta falle, la venta entra');
delete from sales where customer_name = '[prueba inventario]' and total_price = 25;

-- El conteo de hoy, y el cuadre.
set role authenticated;
select pg_temp.como('f0000000-0000-0000-0000-000000000001');
select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date,
  pg_temp.lineas(100, '{"Máquina 1 · izquierda": 600, "Fresas": 55, "Tazas 16 oz": 148, "Vasos de shake y bebidas frías": 98}'));
select set_config('t.c', pg_temp.c('t.hoy')::text, false);
select pg_temp.ok((pg_temp.l(current_setting('t.c')::jsonb, 'Máquina 1 · izquierda')->>'consumo')::numeric = 65
              and (pg_temp.l(current_setting('t.c')::jsonb, 'Máquina 1 · izquierda')->>'inicial')::numeric = 300
              and (pg_temp.l(current_setting('t.c')::jsonb, 'Máquina 1 · izquierda')->>'fabricado')::numeric = 370
              and pg_temp.l(current_setting('t.c')::jsonb, 'Máquina 1 · izquierda')->>'sabor' = 'Vainilla',
  'C1 máquina: 300 de ayer + 370 fabricado − 5 de goteo − 600 al cierre = 65 oz');
select pg_temp.ok((pg_temp.l(current_setting('t.c')::jsonb, 'Fresas')->>'consumo')::numeric = 15, 'C2 fresas: 50 + 20 sumado − 55 = 15 oz');
select pg_temp.ok((pg_temp.l(current_setting('t.c')::jsonb, 'Tazas 16 oz')->>'diferencia')::numeric = -1
              and (pg_temp.l(current_setting('t.c')::jsonb, 'Tazas 16 oz')->>'teorico')::numeric = 149,
  'C3 tazas: 100 + 50 − 1 vendida = 149 en teoría, se contaron 148: falta 1');
select pg_temp.ok((pg_temp.l(current_setting('t.c')::jsonb, 'Vasos de shake y bebidas frías')->>'diferencia')::numeric = 0,
  'C4 vasos de shake: cuadran (100 − 2 malteadas = 98)');
select pg_temp.ok((current_setting('t.c')::jsonb->'froyo'->>'consumo_maquinas')::numeric = 65
              and (current_setting('t.c')::jsonb->'froyo'->>'en_otros')::numeric = 20
              and (current_setting('t.c')::jsonb->'froyo'->>'barra_libre')::numeric = 45,
  'C5 froyo de la barra libre = 65 de las máquinas − 20 en malteadas = 45 oz');
select pg_temp.ok((current_setting('t.c')::jsonb->'toppings'->>'barra_libre')::numeric = 5.6,
  'C6 toppings de la barra libre = 15 − 9.4 en malteadas = 5.6 oz');
select pg_temp.ok((current_setting('t.c')::jsonb->>'consumo_barra')::numeric = 50.6
              and (current_setting('t.c')::jsonb->>'vendido_oz')::numeric = 11
              and (current_setting('t.c')::jsonb->>'tazas')::int = 1
              and (current_setting('t.c')::jsonb->>'diferencia_oz')::numeric = -39.6,
  'C7 se fueron 50.6 oz de barra libre y la caja vendió 11 por peso: faltan 39.6 oz');
select pg_temp.ok((current_setting('t.c')::jsonb->>'diferencia_litros')::numeric = -1.17
              and (current_setting('t.c')::jsonb->>'diferencia_pct')::numeric = -360,
  'C8 y lo dice en litros y en %');
select pg_temp.ok(exists (select 1 from jsonb_array_elements(current_setting('t.c')::jsonb->'otros_productos') x
                           where x->>'nombre' = 'Shake de fresa' and x->>'tipo' = 'froyo' and (x->>'cantidad')::numeric = 20),
  'C9 y en qué otros productos se fue el froyo');

select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date,
  jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Kiwi'), 'final', null)));
select pg_temp.falla($$select public.inv_cerrar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date)$$,
  'Falta contar: Kiwi', 'K1 no se cierra con un artículo sin contar, y dice cuál');
select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date,
  jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Kiwi'), 'final', 50)));
select pg_temp.ok((public.inv_cerrar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date)->>'estado') = 'cerrado',
  'K2 con todo contado, se cierra y devuelve el cuadre');
select pg_temp.falla($$select public.inv_guardar_conteo(current_setting('t.g')::uuid, current_setting('t.hoy')::date, '[]')$$,
  'ya está cerrado', 'K3 un conteo cerrado no se cambia');
select pg_temp.falla($$select public.inv_reabrir_conteo(current_setting('t.g')::uuid, current_setting('t.ayer')::date, 'Me equivoqué')$$,
  'Solo la gerente', 'K4 operaciones no reabre');
select pg_temp.como('f0000000-0000-0000-0000-000000000002');   -- gerente
select pg_temp.falla($$select public.inv_reabrir_conteo(current_setting('t.g')::uuid, current_setting('t.ayer')::date, 'x')$$,
  'por qué', 'K5 reabrir pide motivo');
select public.inv_reabrir_conteo(current_setting('t.g')::uuid, current_setting('t.ayer')::date, 'Se contó mal la máquina 1');
select pg_temp.ok((select count(*) from inv_conteos where location_id = current_setting('t.g')::uuid and estado = 'abierto') = 2,
  'K6 la gerente reabre ayer, y con él hoy (su inicial depende de ayer)');
reset role;
select pg_temp.ok((select count(*) from audit_log where table_name = 'inv_conteos' and after->>'reabierto_motivo' = 'Se contó mal la máquina 1') >= 1,
  'K7 y queda en el rastro de auditoría');
set role authenticated;

-- Quién ve el cuadre.
select pg_temp.como('f0000000-0000-0000-0000-000000000004');   -- contabilidad
select pg_temp.ok((pg_temp.c('t.hoy')->>'vendido_oz')::numeric = 11, 'Q1 contabilidad ve el cuadre');
select pg_temp.ok(jsonb_array_length(public.inv_cuadre_rango(current_setting('t.g')::uuid, current_setting('t.ayer')::date, current_setting('t.hoy')::date)) = 2,
  'Q2 y el del rango, un día por fila');
select pg_temp.como('f0000000-0000-0000-0000-000000000003');   -- cajera
select pg_temp.falla($$select pg_temp.c('t.hoy')$$, 'No tienes acceso', 'Q3 la cajera no');
select pg_temp.ok((select count(*) from public.inv_movimientos) = 0, 'Q4 ni ve los movimientos');
select pg_temp.como('f0000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.inv_cuadre(current_setting('t.m')::uuid, current_setting('t.hoy')::date)$$,
  'No tienes acceso', 'Q5 operaciones de Galerías no ve el de Multiplaza');
reset role;

-- Recetas.
set role authenticated;
select pg_temp.como('f0000000-0000-0000-0000-000000000006');   -- propietaria
select pg_temp.falla($$select public.inv_guardar_receta(jsonb_build_object('nombre', '[prueba inv] Otra malteada', 'tipo', 'venta',
  'vende_nombre', 'malteada de fresa', 'lineas', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Fresas'), 'cantidad', 1))))$$,
  'ya tiene receta', 'R1 un producto no puede tener dos recetas de venta');
select pg_temp.falla($$select public.inv_guardar_receta(jsonb_build_object('nombre', '[prueba inv] Vacía', 'tipo', 'venta',
  'vende_nombre', 'Nada', 'lineas', '[]'::jsonb))$$, 'al menos un ingrediente', 'R2 una receta sin ingredientes no entra');
select set_config('t.rec', public.inv_guardar_receta(jsonb_build_object('nombre', '[prueba inv] Copita', 'tipo', 'venta',
  'vende_nombre', 'Copita de muestra', 'lineas', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Froyo servido'), 'cantidad', 0.5),
                                                                 jsonb_build_object('item_id', pg_temp.item('Copitas de muestra'), 'cantidad', 1))))::text, false);
select pg_temp.ok((select count(*) from receta_lineas where receta_id = current_setting('t.rec')::uuid) = 2, 'R3 la propietaria crea una receta');
select public.inv_guardar_receta(jsonb_build_object('id', current_setting('t.rec'), 'nombre', '[prueba inv] Copita', 'tipo', 'venta',
  'vende_nombre', 'Copita de muestra', 'lineas', jsonb_build_array(jsonb_build_object('item_id', pg_temp.item('Froyo servido'), 'cantidad', 0.2))));
select pg_temp.ok((select count(*) = 1 and sum(cantidad) = 0.2 from receta_lineas where receta_id = current_setting('t.rec')::uuid),
  'R4 y al editarla se reemplazan sus ingredientes');
reset role;
delete from public.recetas where nombre like '[prueba inv]%';
delete from public.inv_items where nombre like '[prueba inv]%';

\echo '=== prueba_inventario: terminada ==='

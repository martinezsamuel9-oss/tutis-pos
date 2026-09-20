-- ============================================================
-- PRUEBA DE AISLAMIENTO ENTRE SUCURSALES Y ROLES
-- ============================================================
\set ON_ERROR_STOP on

-- Usuarios de prueba
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test');

-- El trigger ya creó sus perfiles como cajera sin sucursal. Los asignamos:
update public.profiles set role='propietario', location_id=null, full_name='Samuel (dueño)'
  where id='11111111-1111-1111-1111-111111111111';
update public.profiles set role='gerente', full_name='Gerente Galerías',
  location_id=(select id from locations where name='Tuti''s Galerías')
  where id='22222222-2222-2222-2222-222222222222';
update public.profiles set role='cajera', full_name='Cajera Galerías',
  location_id=(select id from locations where name='Tuti''s Galerías')
  where id='33333333-3333-3333-3333-333333333333';
update public.profiles set role='gerente', full_name='Gerente Multiplaza',
  location_id=(select id from locations where name='Tuti''s Multiplaza')
  where id='44444444-4444-4444-4444-444444444444';

\echo ''
\echo '=== TEST 1: la cajera de Galerías solo ve SU sucursal ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'sucursales visibles' as prueba, count(*) as filas, string_agg(name, ', ') as cuales from locations;
select 'toppings visibles' as prueba, count(*) as filas,
       count(distinct location_id) as sucursales_distintas from toppings;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 2: el gerente de Multiplaza NO ve nada de Galerias ==='
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'sucursales visibles' as prueba, count(*) as filas, string_agg(name, ', ') as cuales from locations;
select 'sabores visibles' as prueba, count(*) as filas from flavors;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 3: el propietario ve TODAS las sucursales ==='
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'sucursales visibles' as prueba, count(*) as filas, string_agg(name, ', ') as cuales from locations;
select 'toppings visibles (ambas)' as prueba, count(*) as filas,
       count(distinct location_id) as sucursales_distintas from toppings;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 4: la cajera NO puede cambiar precios/costos ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
with intento as (
  update public.toppings set cost_per_gram = 999 where name = 'Nutella' returning 1
)
select 'filas que la cajera logro modificar (debe ser 0)' as prueba, count(*) as filas from intento;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 5: el gerente SI puede cambiar precios, pero solo de SU tienda ==='
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
with intento as (
  update public.toppings set cost_per_gram = 0.20 where name = 'Nutella' returning 1
)
select 'filas modificadas por gerente Galerias (debe ser 1)' as prueba, count(*) as filas from intento;
reset role; reset request.jwt.claim.sub;
select 'verificacion: cuantas Nutella quedaron en 0.20 (debe ser 1, no 2)' as prueba,
       count(*) as filas from toppings where name='Nutella' and cost_per_gram = 0.20;

\echo ''
\echo '=== TEST 6: la cajera registra una venta en su sucursal (debe funcionar) ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select public.process_sale(jsonb_build_object(
  'location_id', (select id from locations where name='Tuti''s Galerías'),
  'client_uuid', 'aaaaaaaa-0000-0000-0000-000000000001',
  'created_at', now(),
  'gross_weight_g', 195, 'total_price', 87.75, 'total_cost', 7.25,
  'margin', 80.50, 'margin_pct', 91.7, 'currency_code', 'HNL',
  'payment_method', 'efectivo',
  'lines', jsonb_build_array(
    jsonb_build_object('item_type','vaso','ref_id',(select id from supplies where name='Vaso 8oz' and location_id=(select id from locations where name='Tuti''s Galerías')),'name','Vaso 8oz','weight_g',15,'cost',2.00,'price_contribution',6.75),
    jsonb_build_object('item_type','cuchara','ref_id',(select id from supplies where name='Cuchara plástica' and location_id=(select id from locations where name='Tuti''s Galerías')),'name','Cuchara plástica','weight_g',0,'cost',0.38,'price_contribution',0),
    jsonb_build_object('item_type','helado','ref_id',(select id from flavors where name='Yogurt griego natural' and location_id=(select id from locations where name='Tuti''s Galerías')),'name','Yogurt griego natural','weight_g',150,'cost',4.5,'price_contribution',67.5),
    jsonb_build_object('item_type','topping','ref_id',(select id from toppings where name='M&M''s' and location_id=(select id from locations where name='Tuti''s Galerías')),'name','M&M''s','weight_g',30,'cost',1.8,'price_contribution',13.5)
  )
)) as resultado_venta;

\echo ''
\echo '--- TEST 6b: el inventario se descontó (vaso -1, helado -150g, topping -30g) ---'
select 'vasos 8oz restantes (era 500)' as item, stock_qty::text as valor from supplies where name='Vaso 8oz' and location_id=(select id from locations where name='Tuti''s Galerías')
union all select 'helado natural restante (era 8000)', stock_grams::text from flavors where name='Yogurt griego natural' and location_id=(select id from locations where name='Tuti''s Galerías')
union all select 'M&M''s restante (era 2000)', stock_grams::text from toppings where name='M&M''s' and location_id=(select id from locations where name='Tuti''s Galerías');

\echo ''
\echo '--- TEST 6c: el inventario de Multiplaza NO se tocó ---'
select 'vasos 8oz Multiplaza (debe seguir en 500)' as item, stock_qty from supplies where name='Vaso 8oz' and location_id=(select id from locations where name='Tuti''s Multiplaza');

\echo ''
\echo '=== TEST 7: reenvío de la MISMA venta (cola offline) no la duplica ==='
select public.process_sale(jsonb_build_object(
  'location_id', (select id from locations where name='Tuti''s Galerías'),
  'client_uuid', 'aaaaaaaa-0000-0000-0000-000000000001',
  'gross_weight_g', 195, 'total_price', 87.75, 'lines', '[]'::jsonb
)) as reenvio;
select 'ventas totales (debe ser 1)' as prueba, count(*) as filas from sales;
select 'helado restante (no debe bajar otra vez)' as prueba, stock_grams from flavors where name='Yogurt griego natural' and location_id=(select id from locations where name='Tuti''s Galerías');
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 8: la cajera de Galerías NO puede cobrar en Multiplaza ==='
-- Averiguamos el UUID de Multiplaza ANTES de ponernos en el papel de la cajera.
-- Esto importa: si la consulta se hiciera ya como cajera, RLS le escondería la
-- sucursal y devolvería NULL, y process_sale rechazaría la venta por venir
-- incompleta — no por falta de permiso. La prueba pasaria sin haber probado
-- nada. Lo que queremos demostrar es lo otro: que NI SIQUIERA conociendo el
-- UUID de la otra tienda puede cobrar en ella.
-- Se guarda en una variable de sesion porque psql no sustituye sus propias
-- variables dentro de un bloque $$ ... $$.
select set_config('tutis.test_multiplaza',
                  (select id::text from locations where name='Tuti''s Multiplaza'),
                  false);

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('tutis.test_multiplaza')::uuid,
    'client_uuid', 'bbbbbbbb-0000-0000-0000-000000000002',
    'lines', '[]'::jsonb));
  raise notice 'FALLO: la cajera logro cobrar en otra sucursal';
exception when others then
  raise notice 'CORRECTO - rechazado: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 9: el gerente de Multiplaza NO ve las ventas de Galerías ==='
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select 'ventas visibles para gerente Multiplaza (debe ser 0)' as prueba, count(*) as filas from sales;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'ventas visibles para gerente Galerias (debe ser 1)' as prueba, count(*) as filas from sales;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'ventas visibles para el propietario (debe ser 1)' as prueba, count(*) as filas from sales;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 10: cierre del día ==='
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select jsonb_pretty(public.daily_closing(
  (select id from locations where name='Tuti''s Galerías'),
  (now() at time zone 'utc' - interval '6 hours')::date
)) as cierre_galerias;

\echo '--- el gerente de Galerías NO puede pedir el cierre de Multiplaza ---'
do $$
begin
  perform public.daily_closing((select id from locations where name='Tuti''s Multiplaza'), current_date);
  raise notice 'FALLO: pudo ver el cierre de otra sucursal';
exception when others then
  raise notice 'CORRECTO - rechazado: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 11: el folio es correlativo y ARRANCA EN 1 EN CADA SUCURSAL ==='
-- El folio no es global: cada tienda lleva su propia numeración. Si fuera
-- global, Galerías vería saltos en su correlativo cada vez que Multiplaza
-- cobrara, y eso es justo lo que un correlativo no debe hacer.
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera Galerías
select (public.process_sale(jsonb_build_object(
  'location_id', (select id from locations where name='Tuti''s Galerías'),
  'client_uuid', 'cccccccc-0000-0000-0000-000000000003',
  'total_price', 10, 'lines', '[]'::jsonb))->>'folio') as folio_galerias_2;
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';  -- gerente Multiplaza
select (public.process_sale(jsonb_build_object(
  'location_id', (select id from locations where name='Tuti''s Multiplaza'),
  'client_uuid', 'dddddddd-0000-0000-0000-000000000004',
  'total_price', 10, 'lines', '[]'::jsonb))->>'folio') as folio_multiplaza_1;
reset role; reset request.jwt.claim.sub;

select l.name as sucursal, s.folio
  from sales s join locations l on l.id = s.location_id
 order by l.name, s.folio;

\echo '--- el par (sucursal, folio) no se puede repetir ---'
do $$
declare v_loc uuid := (select id from locations where name='Tuti''s Galerías');
begin
  insert into public.sales (location_id, client_uuid, folio, total_price)
  values (v_loc, gen_random_uuid(), 1, 5);
  raise notice 'FALLO: se admitio un folio repetido en la misma sucursal';
exception when unique_violation then
  raise notice 'CORRECTO - rechazado: folio duplicado en la misma sucursal';
end $$;

\echo ''
\echo '=== TEST 12: los GASTOS tambien estan aislados por sucursal ==='
-- Un gasto es informacion sensible del negocio (renta, planilla). Se aisla
-- igual que todo lo demas: en la base, no en la pantalla.
insert into public.expenses (location_id, spent_on, category, description, amount)
values ((select id from locations where name='Tuti''s Galerías'),   current_date, 'renta', 'Renta Galerias',   12000),
       ((select id from locations where name='Tuti''s Multiplaza'), current_date, 'renta', 'Renta Multiplaza', 11000);

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- gerente Galerías
select 'gastos visibles para gerente Galerias (debe ser 1)' as prueba, count(*) as filas from expenses;
select 'y el que ve es el suyo (debe decir Galerias)' as prueba, description from expenses;
reset role; reset request.jwt.claim.sub;

\echo '--- la cajera NO puede registrar gastos ---'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera Galerías
do $$
begin
  insert into public.expenses (location_id, spent_on, category, amount)
  values ((select id from locations where name='Tuti''s Galerías'), current_date, 'otros', 999);
  raise notice 'FALLO: la cajera logro registrar un gasto';
exception when insufficient_privilege or check_violation or others then
  raise notice 'CORRECTO - rechazado: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

\echo '--- el gerente de Galerias NO puede registrar un gasto en Multiplaza ---'
select set_config('tutis.test_multiplaza',
                  (select id::text from locations where name='Tuti''s Multiplaza'), false);
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
begin
  insert into public.expenses (location_id, spent_on, category, amount)
  values (current_setting('tutis.test_multiplaza')::uuid, current_date, 'otros', 999);
  raise notice 'FALLO: el gerente logro cargarle un gasto a la otra tienda';
exception when others then
  raise notice 'CORRECTO - rechazado: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== TEST 13: el dashboard respeta el aislamiento ==='
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- gerente Galerías
select 'dashboard de SU tienda (debe traer numeros)' as prueba,
       (public.dashboard_summary((select id from locations where name='Tuti''s Galerías'),
                                 current_date - 7, current_date)->>'gastos') as gastos_vistos;
do $$
begin
  perform public.dashboard_summary(current_setting('tutis.test_multiplaza')::uuid,
                                   current_date - 7, current_date);
  raise notice 'FALLO: vio el dashboard de la otra tienda';
exception when others then
  raise notice 'CORRECTO - rechazado: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

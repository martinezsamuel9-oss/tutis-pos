-- ============================================================================
--  PRUEBAS: productos de precio fijo (sql/14)
--  Correr después de 00..14. Se puede repetir sobre la misma base.
--  Cada prueba que falla DETIENE el archivo con "FALLA ...".
-- ============================================================================
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active)
select id, 'cajera', null, true from auth.users on conflict (id) do nothing;
update public.profiles set role='propietario', location_id=null, full_name='Dueña', active=true
  where id='11111111-1111-1111-1111-111111111111';
update public.profiles set role='gerente', full_name='Gerente Galerías', active=true,
  location_id=(select id from locations where name='Tuti''s Galerías') where id='22222222-2222-2222-2222-222222222222';
update public.profiles set role='cajera', full_name='Cajera Galerías', active=true,
  location_id=(select id from locations where name='Tuti''s Galerías') where id='33333333-3333-3333-3333-333333333333';
update public.profiles set role='gerente', full_name='Gerente Multiplaza', active=true,
  location_id=(select id from locations where name='Tuti''s Multiplaza') where id='44444444-4444-4444-4444-444444444444';

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

delete from public.sales where customer_name = '[prueba productos]';
alter table public.products disable trigger trg_audit_products;
delete from public.products where name like '[prueba]%';
alter table public.products enable trigger trg_audit_products;

create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALLA %', msg; end if;
  raise notice '[ OK ] %', msg;
end $$;
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
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated;

-- ------------------------------------------------------------ catálogo
set role authenticated;
select pg_temp.como('22222222-2222-2222-2222-222222222222');
insert into public.products (location_id, family, name, price, cost, stock_qty)
values (current_setting('t.g')::uuid, 'Bebidas', '[prueba] Agua en botella', 25, 8, 10);
insert into public.products (location_id, family, name, price, cost)
values (current_setting('t.g')::uuid, 'Toppings', '[prueba] Topping premium (porción)', 30, 9);
select pg_temp.ok((select count(*) from public.products where name like '[prueba]%') = 2, 'R1 la gerente agrega productos a su tienda');
select pg_temp.falla($$insert into public.products (location_id, family, name, price) values (current_setting('t.m')::uuid, 'Bebidas', '[prueba] x', 1)$$,
  'row-level security', 'R2 pero no a la otra tienda');
select pg_temp.falla($$insert into public.products (location_id, family, name, price) values (current_setting('t.g')::uuid, 'Bebidas', '[prueba] x', -1)$$,
  'check', 'R3 precio negativo rechazado');

select pg_temp.como('33333333-3333-3333-3333-333333333333');
select pg_temp.ok((select count(*) from public.products where name like '[prueba]%') = 2, 'R4 la cajera ve los productos para venderlos');
with u as (update public.products set price = 1 where name like '[prueba]%' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'R5 pero no les cambia el precio');

select pg_temp.como('44444444-4444-4444-4444-444444444444');
select pg_temp.ok((select count(*) from public.products where name like '[prueba]%') = 0, 'R6 Multiplaza no ve los productos de Galerías');

-- ------------------------------------------------------------ venta
select pg_temp.como('33333333-3333-3333-3333-333333333333');
select set_config('t.agua', (select id::text from public.products where name = '[prueba] Agua en botella'), false);
select set_config('t.v1', public.process_sale(jsonb_build_object(
  'location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(), 'customer_name', '[prueba productos]',
  'payment_method', 'efectivo', 'weight_mode', 'bascula',
  'lines', jsonb_build_array(jsonb_build_object('item_type', 'producto', 'ref_id', current_setting('t.agua'),
             'name', 'Agua en botella', 'quantity', 2, 'weight_g', 0, 'cost', 16, 'price_contribution', 50))))::text, false);
select pg_temp.ok((current_setting('t.v1')::jsonb->>'total')::numeric = 50
                  and current_setting('t.v1')::jsonb->>'weight_source' = 'no_aplica',
  'R7 una venta de solo productos: 2 aguas = 50, sin báscula de por medio');
reset role;
select pg_temp.ok((select quantity from public.sale_lines where sale_id = (current_setting('t.v1')::jsonb->>'sale_id')::uuid) = 2,
  'R8 la línea guarda la cantidad');
select pg_temp.ok((select stock_qty from public.products where id = current_setting('t.agua')::uuid) = 8,
  'R9 descuenta 2 de las existencias (10 → 8)');
set role authenticated;
select pg_temp.como('33333333-3333-3333-3333-333333333333');
select pg_temp.falla($$select public.process_sale(jsonb_build_object('location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(),
  'lines', jsonb_build_array(jsonb_build_object('item_type','producto','ref_id',current_setting('t.agua'),'name','Agua','quantity',-3,'price_contribution',0))))$$,
  'cantidad fuera de rango', 'R10 cantidad negativa rechazada (no puede devolver al inventario)');
select pg_temp.falla($$select public.process_sale(jsonb_build_object('location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(),
  'lines', jsonb_build_array(jsonb_build_object('item_type','producto','ref_id',current_setting('t.agua'),'name','Agua','quantity',1,'weight_g',500,'price_contribution',25))))$$,
  'no lleva peso', 'R11 un producto no puede meter peso (no se cuela en el cuadre de la báscula)');
-- Venta mixta: taza pesada + un producto. El cuadre de báscula sigue siendo solo del vaso.
select set_config('t.v2', public.process_sale(jsonb_build_object(
  'location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(), 'customer_name', '[prueba productos]',
  'payment_method', 'tarjeta', 'weight_mode', 'bascula', 'scale_gross_g', 165,
  'scale_log', '[{"g":165,"crudo":"0.165KG"}]'::jsonb,
  'lines', jsonb_build_array(
    jsonb_build_object('item_type','vaso','name','Vaso','weight_g',15,'cost',2,'price_contribution',6.75),
    jsonb_build_object('item_type','helado','name','Yogurt','weight_g',150,'cost',4.5,'price_contribution',67.5),
    jsonb_build_object('item_type','producto','ref_id',current_setting('t.agua'),'name','Agua','quantity',1,'weight_g',0,'cost',8,'price_contribution',25))))::text, false);
select pg_temp.ok(current_setting('t.v2')::jsonb->>'weight_source' = 'bascula' and (current_setting('t.v2')::jsonb->>'total')::numeric = 99.25,
  'R12 taza + agua: cuadra con la báscula y suma 99.25');
reset role;

-- ------------------------------------------------------------ cierre
select set_config('t.c', public.daily_closing_core(current_setting('t.g')::uuid,
  (now() at time zone 'UTC' - interval '6 hours')::date, -6)::text, false);
select pg_temp.ok(exists (select 1 from jsonb_array_elements(current_setting('t.c')::jsonb->'productos') x
                           where x->>'name' = 'Agua en botella' and (x->>'cantidad')::numeric = 2 and (x->>'total')::numeric = 50),
  'R13 el cierre dice cuántos productos se vendieron y por cuánto');
select pg_temp.ok('products' = any(public.respaldo_tablas()), 'R14 el respaldo nocturno incluye los productos');

delete from public.sales where customer_name = '[prueba productos]';
alter table public.products disable trigger trg_audit_products;
delete from public.products where name like '[prueba]%';
alter table public.products enable trigger trg_audit_products;

\echo 'TODAS LAS PRUEBAS DE PRODUCTOS PASARON'

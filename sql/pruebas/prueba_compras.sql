-- ============================================================================
--  PRUEBAS: libro de compras y cierre por forma de pago (sql/12)
--  Correr después de 00..12. Se puede repetir sobre la misma base.
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

delete from public.purchases where supplier_name like '[prueba]%';
delete from public.sales where customer_name = '[prueba cierre]';
delete from public.order_voids where reason = '[prueba cierre]';

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

-- ------------------------------------------------------------ como GERENTE Galerías
set role authenticated;
select pg_temp.como('22222222-2222-2222-2222-222222222222');

insert into public.purchases (location_id, compra, supplier_name, supplier_rtn, supplier_invoice_no, exento, gravado15, isv15, created_by)
values (current_setting('t.g')::uuid, 'materia_tienda', '[prueba] Distribuidora', '08019013602834', '000-001-01-00000001', 280, 100, 15,
        '11111111-1111-1111-1111-111111111111');
select pg_temp.ok((select total from public.purchases where supplier_invoice_no = '000-001-01-00000001') = 395,
  'C1 el total lo calcula la base: exento + gravado + ISV');
select pg_temp.ok((select created_by from public.purchases where supplier_invoice_no = '000-001-01-00000001') = '22222222-2222-2222-2222-222222222222',
  'C2 quién la registró lo pone la base, no el navegador');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name) values (current_setting('t.m')::uuid, 'materia_tienda', '[prueba] x')$$,
  'row-level security', 'C3 la gerente no registra compras de la otra tienda');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name) values (null, 'gasto', '[prueba] x')$$,
  'row-level security', 'C4 la gerente no registra compras de oficina/bodega central');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name, supplier_rtn, supplier_invoice_no) values (current_setting('t.g')::uuid, 'gasto', '[prueba] Distribuidora', '08019013602834', '000-001-01-00000001')$$,
  'uq_purchases_factura', 'C5 la misma factura del mismo proveedor no entra dos veces');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name, gravado15) values (current_setting('t.g')::uuid, 'gasto', '[prueba] x', -5)$$,
  'check', 'C6 montos negativos rechazados');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name, supplier_rtn) values (current_setting('t.g')::uuid, 'gasto', '[prueba] x', '0801-1999')$$,
  'check', 'C7 el RTN son 14 dígitos');
update public.purchases set created_by = '11111111-1111-1111-1111-111111111111', exento = 300 where supplier_invoice_no = '000-001-01-00000001';
select pg_temp.ok((select created_by from public.purchases where supplier_invoice_no = '000-001-01-00000001') = '22222222-2222-2222-2222-222222222222'
                  and (select total from public.purchases where supplier_invoice_no = '000-001-01-00000001') = 415,
  'C8 al corregir una compra no se puede cambiar quién la registró');

-- ------------------------------------------------------------ como GERENTE Multiplaza
select pg_temp.como('44444444-4444-4444-4444-444444444444');
select pg_temp.ok((select count(*) from public.purchases where supplier_name like '[prueba]%') = 0, 'C9 Multiplaza no ve las compras de Galerías');
with u as (update public.purchases set exento = 0 where supplier_name like '[prueba]%' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'C10 ni las puede cambiar');

-- ------------------------------------------------------------ como CAJERA
select pg_temp.como('33333333-3333-3333-3333-333333333333');
select pg_temp.ok((select count(*) from public.purchases) = 0, 'C11 la cajera no ve compras');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name) values (current_setting('t.g')::uuid, 'gasto', '[prueba] x')$$,
  'row-level security', 'C12 la cajera no registra compras');

-- ------------------------------------------------------------ como PROPIETARIA
select pg_temp.como('11111111-1111-1111-1111-111111111111');
insert into public.purchases (location_id, compra, supplier_name, gravado15, isv15) values (null, 'materia_bodega', '[prueba] Bodega', 1000, 150);
select pg_temp.ok((select count(*) from public.purchases where supplier_name like '[prueba]%') = 2, 'C13 la propietaria ve todas, incluida la de bodega central');
select pg_temp.falla($$insert into public.purchases (location_id, compra, supplier_name) values (null, 'materia_tienda', '[prueba] x')$$,
  'purchases_tienda_chk', 'C14 la materia prima de tienda tiene que decir de qué tienda es');
select pg_temp.falla($$update public.locations set purchase_series = '011-c' where id = current_setting('t.g')::uuid$$,
  'locations_purchase_series_chk', 'C15 la serie de la tienda es un código corto (011C)');
update public.locations set purchase_series = '011C' where id = current_setting('t.g')::uuid;

reset role;
select pg_temp.ok((select count(*) from public.audit_log where table_name = 'purchases' and row_id in
                   (select id::text from public.purchases where supplier_name like '[prueba]%')) >= 3,
  'C16 las compras quedan en el rastro de auditoría');

-- ------------------------------------------------------------ CIERRE por forma de pago
-- Ventas de un día inventado, 22:30 de la tienda incluida (04:30 UTC del día siguiente).
insert into public.sales (location_id, client_uuid, folio, created_at, total_price, discount, payment_method, customer_name) values
  (current_setting('t.g')::uuid, gen_random_uuid(), 900001, '2030-01-15 15:00:00+00', 100,  0, 'efectivo',      '[prueba cierre]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 900002, '2030-01-15 18:00:00+00', 50.5, 10, 'efectivo',     '[prueba cierre]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 900003, '2030-01-16 04:30:00+00', 80,   0, 'tarjeta',       '[prueba cierre]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 900004, '2030-01-15 20:00:00+00', 20,   0, null,            '[prueba cierre]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 900005, '2030-01-16 07:00:00+00', 999,  0, 'efectivo',      '[prueba cierre]'),
  (current_setting('t.m')::uuid, gen_random_uuid(), 900006, '2030-01-15 15:00:00+00', 777,  0, 'efectivo',      '[prueba cierre]');
insert into public.order_voids (location_id, client_uuid, created_at, weighed_g, reason) values
  (current_setting('t.g')::uuid, gen_random_uuid(), '2030-01-15 17:00:00+00', 185.5, '[prueba cierre]'),
  (current_setting('t.m')::uuid, gen_random_uuid(), '2030-01-15 17:00:00+00', 90,    '[prueba cierre]');

select set_config('t.c', public.daily_closing_core(current_setting('t.g')::uuid, '2030-01-15', -6)::text, false);
select pg_temp.ok((current_setting('t.c')::jsonb->>'ventas')::int = 4 and (current_setting('t.c')::jsonb->>'ingresos')::numeric = 250.5,
  'C17 el cierre cuenta el día de la tienda (22:30 entra; las 01:00 del otro día no)');
select pg_temp.ok(current_setting('t.c')::jsonb->'por_pago' =
  '[{"metodo":"efectivo","ventas":2,"total":150.50},{"metodo":"tarjeta","ventas":1,"total":80.00},{"metodo":"sin_dato","ventas":1,"total":20.00}]'::jsonb,
  'C18 desglose por forma de pago: efectivo primero, y las viejas sin dato aparte');
select pg_temp.ok((current_setting('t.c')::jsonb->>'descuentos')::numeric = 10, 'C19 los descuentos por puntos salen en el cierre');
select pg_temp.ok((current_setting('t.c')::jsonb->>'anulaciones')::int = 1 and (current_setting('t.c')::jsonb->>'anulado_g')::numeric = 185.5,
  'C20 los pedidos anulados del día y su peso, solo de esa tienda');

set role authenticated;
select pg_temp.como('44444444-4444-4444-4444-444444444444');
select pg_temp.falla($$select public.daily_closing(current_setting('t.g')::uuid, '2030-01-15', -6)$$,
  'permiso', 'C21 la gerente de Multiplaza no ve el cierre de Galerías');
select pg_temp.falla($$select public.daily_closing_core(current_setting('t.g')::uuid, '2030-01-15', -6)$$,
  'permission denied', 'C22 nadie llama el núcleo del cierre desde la API');
-- ------------------------------------------------------------ RESPALDO
select pg_temp.falla($$select public.respaldo_conteo()$$, 'permission denied', 'C23 una gerente no puede pedir el respaldo');
select pg_temp.falla($$select public.respaldo_tabla('sales')$$, 'permission denied', 'C24 ni leer tablas completas por ahí');
reset role;
set role anon;
select pg_temp.falla($$select public.respaldo_tabla('sales')$$, 'permission denied', 'C25 sin usuario, tampoco');
reset role;
select pg_temp.falla($$select public.respaldo_tabla('pg_authid')$$, 'fuera del respaldo', 'C26 solo las tablas de la lista');
select pg_temp.ok(public.respaldo_tabla('usuarios')::text not like '%encrypted_password%'
                  and public.respaldo_tabla('usuarios')::text like '%@tutis.test%',
  'C27 de los usuarios se respalda el correo, NUNCA el hash de la contraseña');
select pg_temp.ok((select count(*) from json_array_elements(public.respaldo_tabla('sales', 0, 3))) = least(3, (select count(*) from public.sales))
                  and (public.respaldo_conteo()->>'sales')::int = (select count(*) from public.sales),
  'C28 el respaldo sale en bloques y el conteo cuadra con la tabla');

delete from public.sales where customer_name = '[prueba cierre]';
delete from public.order_voids where reason = '[prueba cierre]';
alter table public.purchases disable trigger trg_audit_purchases;
delete from public.purchases where supplier_name like '[prueba]%';
alter table public.purchases enable trigger trg_audit_purchases;
update public.locations set purchase_series = null where id = current_setting('t.g')::uuid;

\echo 'TODAS LAS PRUEBAS DE COMPRAS Y CIERRE PASARON'

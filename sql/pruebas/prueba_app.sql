-- ============================================================================
--  PRUEBAS: app de clientes y el hueco del registro suelto (sql/17)
--  Correr después de 00..17. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

delete from public.pedidos_app where customer_id in (select id from public.customers where full_name like '[prueba app]%');
delete from public.customers where full_name like '[prueba app]%';
delete from public.profiles where id in ('66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888');
delete from auth.users where id in ('66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888');

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active) select id, 'cajera', null, true from auth.users
 where id in ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444')
on conflict (id) do nothing;
update public.profiles set role='propietario', location_id=null, active=true where id='11111111-1111-1111-1111-111111111111';
update public.profiles set role='cajera', active=true, location_id=(select id from locations where name='Tuti''s Galerías') where id='33333333-3333-3333-3333-333333333333';
update public.profiles set role='gerente', active=true, location_id=(select id from locations where name='Tuti''s Multiplaza') where id='44444444-4444-4444-4444-444444444444';

-- Un registro suelto con correo (lo que cualquiera puede hacer con la llave
-- pública) y dos clientes que entran con Apple.
insert into auth.users (id, email, raw_app_meta_data) values
  ('66666666-6666-6666-6666-666666666666', 'curioso@tutis.test', '{"provider":"email"}'),
  ('77777777-7777-7777-7777-777777777777', 'andrea@privaterelay.appleid.com', '{"provider":"apple"}'),
  ('88888888-8888-8888-8888-888888888888', 'otra@privaterelay.appleid.com', '{"provider":"apple"}');

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);
insert into public.customers (card_code, full_name, phone) values ('PRUEBAAPP2', '[prueba app] Clienta de caja', '50499887766');
insert into public.products (location_id, family, name, price, cost) values
  (current_setting('t.g')::uuid, 'Bebidas', '[prueba app] Agua', 25, 8) on conflict (location_id, family, name) do nothing;
select set_config('t.agua', (select id::text from public.products where name = '[prueba app] Agua'), false);

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
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated, anon;

select pg_temp.ok(exists (select 1 from public.profiles where id = '66666666-6666-6666-6666-666666666666'),
  'A0 un registro con correo sigue creando perfil (así nace el personal que da de alta la propietaria)');
select pg_temp.ok(not exists (select 1 from public.profiles where id in ('77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888')),
  'A1 un cliente que entra con Apple NO nace como personal');

-- ------------------------------------------------------------ el hueco, cerrado
set role authenticated;
select pg_temp.como('66666666-6666-6666-6666-666666666666');
select pg_temp.ok((select count(*) from public.customers) = 0, 'A2 un registro suelto ya NO lee la tabla de clientes');
select pg_temp.falla($$select public.loyalty_buscar('prueba')$$, 'sin perfil', 'A3 ni los busca');
select pg_temp.falla($$select public.loyalty_registrar('Intruso', '50411112222')$$, 'sin perfil', 'A4 ni inscribe clientes');
select pg_temp.falla($$insert into public.customers (card_code, full_name) values ('XXXXXXXXXX', 'x')$$, 'row-level security', 'A5 ni los inserta directo');
select pg_temp.como('77777777-7777-7777-7777-777777777777');
select pg_temp.ok((select count(*) from public.customers) = 0, 'A6 un cliente de la app tampoco lee la tabla de clientes');
select pg_temp.ok((select count(*) from public.pedidos_app) = 0, 'A7 ni la de pedidos');
select pg_temp.como('33333333-3333-3333-3333-333333333333');
select pg_temp.ok((select count(*) from public.customers where full_name like '[prueba app]%') = 1, 'A8 la cajera con sucursal sí ve clientes (para cobrar)');

-- ------------------------------------------------------------ carnet desde la app
reset role; set role anon;
select pg_temp.ok(jsonb_array_length(public.app_menu()->'tamanos') = 3 and (public.app_menu()->'productos')::text not like '%"cost"%',
  'B1 el menú es público y no trae costos');
reset role; set role authenticated;
select pg_temp.como('77777777-7777-7777-7777-777777777777');
select pg_temp.ok(public.app_mi_carnet() is null, 'B2 un cliente nuevo aún no tiene carnet');
select pg_temp.falla($$select public.app_registrarme('[prueba app] Andrea', '9988-7766')$$, 'ya tiene carnet', 'B3 un teléfono que ya tiene carnet no se duplica');
select pg_temp.falla($$select public.app_vincular_carnet('PRUEBAAPP2', '3333-4444')$$, 'no coinciden', 'B4 vincular con el teléfono equivocado no se queda con los puntos de nadie');
select pg_temp.ok((public.app_vincular_carnet('pruebaapp2', '+504 9988-7766')->>'codigo') = 'PRUEBAAPP2', 'B5 con código y teléfono correctos se vincula su carnet de la caja');
select pg_temp.como('88888888-8888-8888-8888-888888888888');
select pg_temp.falla($$select public.app_vincular_carnet('PRUEBAAPP2', '99887766')$$, 'no coinciden', 'B6 un carnet ya vinculado no lo toma otra persona');
select pg_temp.ok((public.app_registrarme('[prueba app] Otra', '3311-2233')->>'puntos')::int = 0, 'B7 un cliente nuevo crea su carnet desde la app');

-- ------------------------------------------------------------ pedidos
select pg_temp.como('77777777-7777-7777-7777-777777777777');
select set_config('t.p1', public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'modo', 'recoger', 'hora', 'ya',
  'items', jsonb_build_array(
     jsonb_build_object('tipo', 'taza', 'tamano', 'md', 'sabores', '["Taro","Vainilla"]'::jsonb, 'toppings', '["Oreo"]'::jsonb, 'premium', '["Almendras"]'::jsonb, 'cantidad', 1, 'precio', 1),
     jsonb_build_object('tipo', 'producto', 'producto', current_setting('t.agua'), 'cantidad', 2, 'precio', 0))))::text, false);
select pg_temp.ok((current_setting('t.p1')::jsonb->>'total')::numeric = 135 + 30 + 50,
  'C1 el total lo calcula la base (135 + 30 premium + 2 aguas), no el precio que manda el teléfono');
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'modo', 'domicilio', 'items', '[{"tipo":"producto","producto":"x"}]'::jsonb))$$,
  'solo hay pedidos para recoger', 'C2 domicilio apagado hasta decidir zonas');
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'items', '[{"tipo":"taza","tamano":"ch","sabores":["a"],"toppings":["1","2","3"]}]'::jsonb))$$,
  'hasta 2 toppings', 'C3 una taza chica no lleva más toppings de los que incluye');
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.m'), 'items', jsonb_build_array(jsonb_build_object('tipo','producto','producto', current_setting('t.agua')))))$$,
  'no está disponible', 'C4 un producto de una tienda no se pide en la otra');
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'items', '[{"tipo":"producto","producto":"00000000-0000-0000-0000-000000000000","cantidad":-5}]'::jsonb))$$,
  'cantidad no válida', 'C5 cantidades negativas rechazadas');
select pg_temp.ok(jsonb_array_length(public.app_mis_pedidos()) = 1, 'C6 la clienta ve su pedido');
select pg_temp.como('88888888-8888-8888-8888-888888888888');
select pg_temp.ok(jsonb_array_length(public.app_mis_pedidos()) = 0, 'C7 otra clienta no ve pedidos ajenos');
select pg_temp.falla(format($$select public.app_cancelar_pedido(%L)$$, current_setting('t.p1')::jsonb->>'id'), 'ya se está preparando', 'C8 ni los cancela');

-- ------------------------------------------------------------ la tienda
select pg_temp.como('44444444-4444-4444-4444-444444444444');
select pg_temp.falla($$select public.tienda_pedidos(current_setting('t.g')::uuid)$$, 'permiso', 'D1 Multiplaza no ve pedidos de Galerías');
select pg_temp.falla(format($$select public.tienda_pedido_estado(%L, 'preparando')$$, current_setting('t.p1')::jsonb->>'id'), 'permiso', 'D2 ni los mueve');
select pg_temp.como('66666666-6666-6666-6666-666666666666');
select pg_temp.falla(format($$select public.tienda_pedido_estado(%L, 'listo')$$, current_setting('t.p1')::jsonb->>'id'), 'permiso', 'D3 un registro suelto tampoco');
select pg_temp.como('33333333-3333-3333-3333-333333333333');
select pg_temp.ok(jsonb_array_length(public.tienda_pedidos(current_setting('t.g')::uuid)) >= 1, 'D4 la cajera de Galerías ve el pedido');
select pg_temp.falla(format($$select public.tienda_pedido_estado(%L, 'entregado')$$, current_setting('t.p1')::jsonb->>'id'), 'no puede pasar', 'D5 no se salta pasos');
select pg_temp.ok((public.tienda_pedido_estado((current_setting('t.p1')::jsonb->>'id')::uuid, 'preparando')->>'estado') = 'preparando', 'D6 preparando');
select pg_temp.ok((public.tienda_pedido_estado((current_setting('t.p1')::jsonb->>'id')::uuid, 'listo')->>'estado') = 'listo', 'D7 listo');
select pg_temp.como('77777777-7777-7777-7777-777777777777');
select pg_temp.ok((public.app_mis_pedidos()->0->>'estado') = 'listo', 'D8 y la clienta lo ve listo en su teléfono');
reset role;

delete from public.pedidos_app where customer_id in (select id from public.customers where full_name like '[prueba app]%');
delete from public.customers where full_name like '[prueba app]%';
alter table public.products disable trigger trg_audit_products;
delete from public.products where name like '[prueba app]%';
alter table public.products enable trigger trg_audit_products;
delete from public.profiles where id = '66666666-6666-6666-6666-666666666666';
delete from auth.users where id in ('66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888');
\echo 'TODAS LAS PRUEBAS DE LA APP PASARON'

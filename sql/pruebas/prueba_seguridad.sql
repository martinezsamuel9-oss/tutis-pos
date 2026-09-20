-- ============================================================================
--  PRUEBAS DE SEGURIDAD — intentos de ATAQUE contra el sistema
--
--  prueba_aislamiento.sql comprueba que lo que debe funcionar, funciona.
--  Este archivo hace lo contrario: se pone del lado del atacante y trata de
--  romper las reglas. Cada bloque dice qué intenta y qué debería pasar.
--
--  El atacante que se asume NO es un extraño: es alguien que ya tiene una
--  cuenta legítima (una cajera, una gerente) y que sabe usar la consola del
--  navegador o llamar la API directo. Ese es el escenario realista: el
--  personal de la tienda con acceso al equipo.
--
--  Correr después de 00, 01, 02, 03 y 04.
-- ============================================================================
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test'),
  ('66666666-6666-6666-6666-666666666666', 'despedida@tutis.test')
-- Sin esto, correr esta suite después de prueba_aislamiento.sql (que usa los
-- mismos usuarios) reventaba en la primera línea y no se ejecutaba nada.
-- Las dos suites tienen que poder correrse seguidas sobre la misma base.
on conflict (id) do nothing;

insert into public.profiles (id, role, location_id, active)
select id, 'cajera', null, true from auth.users
on conflict (id) do nothing;

update public.profiles set role='propietario', location_id=null, full_name='Dueña'
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
-- Una empleada a la que ya dieron de baja pero cuya sesión sigue viva.
update public.profiles set role='gerente', active=false, full_name='Ex empleada',
  location_id=(select id from locations where name='Tuti''s Galerías')
  where id='66666666-6666-6666-6666-666666666666';

select set_config('t.galerias',   (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.multiplaza', (select id::text from locations where name='Tuti''s Multiplaza'), false);

-- Ayuda: corre un ataque y reporta si fue BLOQUEADO o si PASÓ.
create or replace function pg_temp.ataque(nombre text, sql text) returns void
language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  if n > 0 then
    raise warning '[ PASO EL ATAQUE ] %  -> % fila(s) afectadas', nombre, n;
  else
    raise notice '[ bloqueado ] %  (0 filas)', nombre;
  end if;
exception when others then
  raise notice '[ bloqueado ] %  (%)', nombre, SQLERRM;
end $$;

\echo ''
\echo '############ A. ESCALADA DE PRIVILEGIOS ############'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- CAJERA
select pg_temp.ataque('A1 cajera se asciende a propietaria',
  $q$update public.profiles set role='propietario' where id=auth.uid()$q$);
select pg_temp.ataque('A2 cajera se quita la sucursal para verlo todo',
  $q$update public.profiles set location_id=null where id=auth.uid()$q$);
select pg_temp.ataque('A3 cajera se cambia a la otra sucursal',
  $q$update public.profiles set location_id=current_setting('t.multiplaza')::uuid where id=auth.uid()$q$);
select pg_temp.ataque('A4 cajera crea un perfil nuevo de propietario',
  $q$insert into public.profiles(id,full_name,role,location_id,active)
     values(gen_random_uuid(),'yo','propietario',null,true)$q$);
select pg_temp.ataque('A5 cajera desactiva a su gerente',
  $q$update public.profiles set active=false where id='22222222-2222-2222-2222-222222222222'$q$);
reset role; reset request.jwt.claim.sub;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- GERENTE
select pg_temp.ataque('A6 gerente se asciende a propietario',
  $q$update public.profiles set role='propietario', location_id=null where id=auth.uid()$q$);
select pg_temp.ataque('A7 gerente se pasa a la otra tienda',
  $q$update public.profiles set location_id=current_setting('t.multiplaza')::uuid where id=auth.uid()$q$);
select pg_temp.ataque('A8 gerente le cambia el rol a su cajera',
  $q$update public.profiles set role='gerente' where id='33333333-3333-3333-3333-333333333333'$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ B. CRUCE ENTRE SUCURSALES ############'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- gerente Galerías
select pg_temp.ataque('B1 bajarle el precio a la OTRA tienda',
  $q$update public.locations set price_per_gram=0.01 where id=current_setting('t.multiplaza')::uuid$q$);
select pg_temp.ataque('B2 vaciarle el inventario a la OTRA tienda',
  $q$update public.toppings set stock_grams=0 where location_id=current_setting('t.multiplaza')::uuid$q$);
select pg_temp.ataque('B3 meterle un topping a la OTRA tienda',
  $q$insert into public.toppings(location_id,name,cost_per_gram)
     values(current_setting('t.multiplaza')::uuid,'infiltrado',0.01)$q$);
select pg_temp.ataque('B4 borrar la OTRA sucursal',
  $q$delete from public.locations where id=current_setting('t.multiplaza')::uuid$q$);
select pg_temp.ataque('B5 borrarle las ventas a la OTRA tienda',
  $q$delete from public.sales where location_id=current_setting('t.multiplaza')::uuid$q$);
select pg_temp.ataque('B6 mover un topping suyo a la otra tienda',
  $q$update public.toppings set location_id=current_setting('t.multiplaza')::uuid
     where location_id=current_setting('t.galerias')::uuid$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ C. ESCRIBIR VENTAS SIN PASAR POR process_sale ############'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera
select pg_temp.ataque('C1 insertar una venta a mano (saltarse el inventario)',
  $q$insert into public.sales(location_id,client_uuid,total_price)
     values(current_setting('t.galerias')::uuid, gen_random_uuid(), 0)$q$);
select pg_temp.ataque('C2 insertar una linea de venta a mano',
  $q$insert into public.sale_lines(sale_id,location_id,item_type,name)
     values(gen_random_uuid(), current_setting('t.galerias')::uuid, 'helado','trampa')$q$);
select pg_temp.ataque('C3 editar el total de una venta ya registrada',
  $q$update public.sales set total_price=0$q$);
select pg_temp.ataque('C4 borrar una venta (para descuadrar la caja)',
  $q$delete from public.sales$q$);
select pg_temp.ataque('C5 cajera se sube el inventario',
  $q$update public.flavors set stock_grams=99999 where location_id=current_setting('t.galerias')::uuid$q$);
select pg_temp.ataque('C6 cajera se baja el costo para inflar el margen',
  $q$update public.toppings set cost_per_gram=0 where location_id=current_setting('t.galerias')::uuid$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- C7: la cajera pone OTRO cashier_id en la venta (culpar a alguien mas) ---'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare v jsonb; v_cajera uuid;
begin
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'cashier_id',  '22222222-2222-2222-2222-222222222222',   -- intenta firmar como la gerente
    'cashier_name','Gerente Galerías',
    'total_price', 100, 'lines','[]'::jsonb));
  select cashier_id into v_cajera from public.sales where id=(v->>'sale_id')::uuid;
  if v_cajera = '33333333-3333-3333-3333-333333333333' then
    raise notice '[ bloqueado ] C7 la venta quedo firmada por quien de verdad cobro';
  else
    raise warning '[ PASO EL ATAQUE ] C7 logro firmar la venta como otra persona: %', v_cajera;
  end if;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ D. GASTOS ############'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera
select pg_temp.ataque('D1 cajera registra un gasto falso',
  $q$insert into public.expenses(location_id,category,amount)
     values(current_setting('t.galerias')::uuid,'otros',5000)$q$);
select pg_temp.ataque('D2 cajera borra los gastos',
  $q$delete from public.expenses$q$);
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- gerente Galerías
select pg_temp.ataque('D3 gerente le carga un gasto a la OTRA tienda',
  $q$insert into public.expenses(location_id,category,amount)
     values(current_setting('t.multiplaza')::uuid,'otros',5000)$q$);
select pg_temp.ataque('D4 gerente mete un gasto negativo (para inflar utilidad)',
  $q$insert into public.expenses(location_id,category,amount)
     values(current_setting('t.galerias')::uuid,'otros',-99999)$q$);
select pg_temp.ataque('D5 gerente inventa una categoria de gasto',
  $q$insert into public.expenses(location_id,category,amount)
     values(current_setting('t.galerias')::uuid,'lavado',100)$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ E. USUARIO DADO DE BAJA CON SESION VIVA ############'
set role authenticated;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';  -- inactiva
select 'E1 sucursales que ve una empleada dada de baja (debe ser 0)' as prueba, count(*) as filas from locations;
select 'E2 toppings que ve (debe ser 0)' as prueba, count(*) as filas from toppings;
select 'E3 ventas que ve (debe ser 0)' as prueba, count(*) as filas from sales;
select pg_temp.ataque('E4 y tampoco puede escribir',
  $q$update public.toppings set cost_per_gram=0$q$);
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(), 'lines','[]'::jsonb));
  raise warning '[ PASO EL ATAQUE ] E5 una empleada dada de baja logro cobrar';
exception when others then
  raise notice '[ bloqueado ] E5 cobrar dada de baja (%)', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ F. LOGO Y LIMITES DE DATOS ############'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ataque('F1 logo gigante (dejaria lenta la carga de la caja)',
  $q$update public.locations set logo_data_url=repeat('x',400000)
     where id=current_setting('t.galerias')::uuid$q$);
select pg_temp.ataque('F2 unidad de peso invalida',
  $q$update public.locations set default_weight_unit='libras'
     where id=current_setting('t.galerias')::uuid$q$);
select pg_temp.ataque('F3 tier de topping fuera de rango',
  $q$update public.toppings set tier=99 where location_id=current_setting('t.galerias')::uuid$q$);
select pg_temp.ataque('F4 pais inexistente',
  $q$update public.locations set country_code='XX' where id=current_setting('t.galerias')::uuid$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ G. EL ROL ANONIMO (sin iniciar sesion) ############'
set role anon;
select pg_temp.ataque('G1 anonimo lee sucursales', $q$select * from public.locations$q$);
select pg_temp.ataque('G2 anonimo lee ventas',     $q$select * from public.sales$q$);
select pg_temp.ataque('G3 anonimo lee perfiles',   $q$select * from public.profiles$q$);
select pg_temp.ataque('G4 anonimo lee gastos',     $q$select * from public.expenses$q$);
do $$
begin
  perform public.process_sale('{}'::jsonb);
  raise warning '[ PASO EL ATAQUE ] G5 el anonimo puede llamar process_sale';
exception when others then
  raise notice '[ bloqueado ] G5 process_sale para anonimo (%)', SQLERRM;
end $$;
reset role;

\echo ''
\echo '############ H. HIGIENE DEL ESQUEMA ############'
select 'H1 tablas publicas SIN row level security (debe ser 0)' as prueba,
       count(*) as filas
  from pg_tables t
 where t.schemaname='public'
   and not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='public' and c.relname=t.tablename and c.relrowsecurity);

select 'H2 funciones SECURITY DEFINER sin search_path fijo (debe ser 0)' as prueba,
       count(*) as filas
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosecdef
   and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search\_path=%');

select 'H3 funciones con SQL dinamico -EXECUTE- (debe ser 0)' as prueba,
       count(*) as filas
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosrc ~* '\mexecute\M';

select 'H4 permisos de escritura sobrantes para anon (debe ser 0)' as prueba,
       count(*) as filas
  from information_schema.role_table_grants
 where grantee='anon' and table_schema='public';

\echo ''
\echo '############ I. FRAUDE DE INVENTARIO Y DE TOTALES ############'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera

\echo '--- I1: peso NEGATIVO para regalarse inventario ---'
do $$
declare v_antes numeric; v_despues numeric; v_top uuid;
begin
  select id, stock_grams into v_top, v_antes from public.toppings
   where name='M&M''s' and location_id=current_setting('t.galerias')::uuid;
  begin
    perform public.process_sale(jsonb_build_object(
      'location_id', current_setting('t.galerias')::uuid,
      'client_uuid', gen_random_uuid(), 'total_price', 0.01,
      'lines', jsonb_build_array(jsonb_build_object(
        'item_type','topping','ref_id',v_top,'name','M&M''s',
        'weight_g',-500,'cost',0,'price_contribution',-500))));
    raise warning '[ PASO EL ATAQUE ] I1 la venta con peso negativo se registro';
  exception when others then
    raise notice '[ bloqueado ] I1 peso negativo (%)', SQLERRM;
  end;
  select stock_grams into v_despues from public.toppings where id=v_top;
  if v_despues > v_antes then
    raise warning '[ PASO EL ATAQUE ] I1b el inventario SUBIO de % a %', v_antes, v_despues;
  else
    raise notice '[ bloqueado ] I1b el inventario no subio (sigue en %)', v_despues;
  end if;
end $$;

\echo '--- I2: peso absurdo (50 kg de topping) ---'
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'lines', jsonb_build_array(jsonb_build_object(
      'item_type','helado','name','absurdo','weight_g',500000,'cost',0,'price_contribution',0))));
  raise warning '[ PASO EL ATAQUE ] I2 se acepto un peso de 500 kg';
exception when others then
  raise notice '[ bloqueado ] I2 peso absurdo (%)', SQLERRM;
end $$;

\echo '--- I3: encabezado mentiroso (cobra 500 pero declara 1) ---'
do $$
declare v jsonb; v_total numeric; v_suma numeric;
begin
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'total_price', 1, 'total_cost', 999, 'margin', -998,
    'lines', jsonb_build_array(jsonb_build_object(
      'item_type','helado','name','Yogurt','weight_g',150,'cost',4.5,'price_contribution',500))));
  select total_price into v_total from public.sales where id=(v->>'sale_id')::uuid;
  select sum(price_contribution) into v_suma from public.sale_lines where sale_id=(v->>'sale_id')::uuid;
  if v_total = v_suma then
    raise notice '[ bloqueado ] I3 el total se recalculo de las lineas (% = %)', v_total, v_suma;
  else
    raise warning '[ PASO EL ATAQUE ] I3 el encabezado dice % y las lineas suman %', v_total, v_suma;
  end if;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '--- I4: la gerente firma un gasto con el id de otra persona ---'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare v_autor uuid;
begin
  insert into public.expenses(location_id, category, amount, created_by)
  values (current_setting('t.galerias')::uuid, 'otros', 500,
          '33333333-3333-3333-3333-333333333333')          -- culpa a la cajera
  returning created_by into v_autor;
  if v_autor = '22222222-2222-2222-2222-222222222222' then
    raise notice '[ bloqueado ] I4 el gasto quedo firmado por quien lo registro';
  else
    raise warning '[ PASO EL ATAQUE ] I4 logro firmar el gasto como otra persona: %', v_autor;
  end if;
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '############ J. RASTRO DE AUDITORIA ############'
\echo '--- J1: borrar una venta deja rastro ---'
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';  -- gerente
do $$
declare v_id uuid; n int;
begin
  select id into v_id from public.sales where location_id=current_setting('t.galerias')::uuid limit 1;
  delete from public.sales where id = v_id;
  select count(*) into n from public.audit_log
   where table_name='sales' and action='DELETE' and row_id = v_id::text;
  if n = 1 then raise notice '[ OK ] J1 el borrado de la venta quedo registrado';
  else raise warning '[ FALLA ] J1 se borro una venta SIN dejar rastro'; end if;
end $$;

\echo '--- J2: cambiar un precio deja rastro con el antes y el despues ---'
do $$
declare n int; v_antes text; v_despues text;
begin
  update public.locations set price_per_gram = 0.99
   where id = current_setting('t.galerias')::uuid;
  select count(*), max(before->>'price_per_gram'), max(after->>'price_per_gram')
    into n, v_antes, v_despues
    from public.audit_log where table_name='locations' and action='UPDATE';
  if n >= 1 and v_antes is distinct from v_despues then
    raise notice '[ OK ] J2 el cambio de precio quedo registrado: % -> %', v_antes, v_despues;
  else raise warning '[ FALLA ] J2 el cambio de precio no dejo rastro util'; end if;
end $$;

\echo '--- J3: la gerente NO puede borrar ni editar el rastro ---'
select pg_temp.ataque('J3a borrar el rastro',  $q$delete from public.audit_log$q$);
select pg_temp.ataque('J3b editar el rastro',  $q$update public.audit_log set actor_name='otro'$q$);
select pg_temp.ataque('J3c inventar un evento',
  $q$insert into public.audit_log(table_name,action) values('sales','DELETE')$q$);
reset role; reset request.jwt.claim.sub;

\echo '--- J4: cada quien ve solo el rastro que le toca ---'
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';  -- gerente Multiplaza
select 'J4a eventos de Galerias visibles para la gerente de Multiplaza (debe ser 0)' as prueba,
       count(*) as filas from public.audit_log where location_id=current_setting('t.galerias')::uuid;
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- cajera
select 'J4b eventos visibles para una cajera (debe ser 0)' as prueba,
       count(*) as filas from public.audit_log;
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';  -- propietaria
select 'J4c eventos visibles para la propietaria (debe ser > 0)' as prueba,
       count(*) as filas from public.audit_log;
reset role; reset request.jwt.claim.sub;
set role anon;
select pg_temp.ataque('J4d el anonimo lee el rastro', $q$select * from public.audit_log$q$);
reset role;

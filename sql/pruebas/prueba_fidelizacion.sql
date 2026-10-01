-- ============================================================================
--  PRUEBAS DE FIDELIZACIÓN
--  Los puntos son dinero. Esto comprueba que no se puedan imprimir.
--  Correr después de 00..08.
-- ============================================================================
\set ON_ERROR_STOP on

-- Las dos suites tienen que poder correrse seguidas y repetidas sobre la
-- misma base, así que primero se limpia lo que dejó la corrida anterior.
delete from public.customers where phone = '9988-7766';

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active)
select id, 'cajera', null, true from auth.users on conflict (id) do nothing;

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

select set_config('t.galerias',   (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.multiplaza', (select id::text from locations where name='Tuti''s Multiplaza'), false);

create or replace function pg_temp.ataque(nombre text, sql text) returns void
language plpgsql as $$
declare n int;
begin
  execute sql; get diagnostics n = row_count;
  if n > 0 then raise warning '[ PASO EL ATAQUE ] %  -> % fila(s)', nombre, n;
  else raise notice '[ bloqueado ] %  (0 filas)', nombre; end if;
exception when others then raise notice '[ bloqueado ] %  (%)', nombre, SQLERRM;
end $$;

\echo ''
\echo '=== P1: la cajera inscribe a una clienta ==='
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select set_config('t.cliente',
  (public.loyalty_registrar('Ana Martínez', '9988-7766')->>'id'), false);
select 'carnet generado (10 caracteres)' as prueba,
       length(card_code) as largo, card_code
  from customers where id = current_setting('t.cliente')::uuid;

\echo ''
\echo '=== P2: una venta le da 1 punto por cada dolar (L 27) gastado ==='
do $$
declare v jsonb; v_saldo int;
begin
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'lines', jsonb_build_array(
      jsonb_build_object('item_type','helado','name','Yogurt','weight_g',150,'cost',4.5,'price_contribution',67.5),
      jsonb_build_object('item_type','topping','name','M&M''s','weight_g',30,'cost',1.8,'price_contribution',13.5))));
  select points_balance into v_saldo from customers where id=current_setting('t.cliente')::uuid;
  raise notice 'venta de % -> gano % puntos, saldo %', v->>'total', v->>'points_earned', v_saldo;
  -- L 81 / L 27 = 3 dolares completos = 3 puntos = L 3.
  if v_saldo = 3 then raise notice '[ OK ] P2 L 81 / L 27 = 3 puntos (L 3)';
  else raise warning '[ FALLA ] P2 esperaba 3 puntos, hay %', v_saldo; end if;
end $$;

\echo ''
\echo '=== P3: no se puede canjear por debajo del mínimo (20 puntos) ==='
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'redeem_points', 5,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',3,'price_contribution',45))));
  raise warning '[ PASO EL ATAQUE ] P3 canjeo con saldo bajo el minimo';
exception when others then raise notice '[ bloqueado ] P3 canje bajo el minimo (%)', SQLERRM;
end $$;

\echo ''
\echo '=== P4: canjear más puntos de los que tiene ==='
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';   -- gerente
select 'ajuste de +200 puntos por promocion' as paso,
       (public.loyalty_ajustar(current_setting('t.cliente')::uuid, 200, 'Promoción de apertura')->>'points_balance') as saldo;
reset role; reset request.jwt.claim.sub;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'redeem_points', 99999,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',3,'price_contribution',45))));
  raise warning '[ PASO EL ATAQUE ] P4 canjeo mas puntos de los que tiene';
exception when others then raise notice '[ bloqueado ] P4 canje mayor al saldo (%)', SQLERRM;
end $$;

\echo ''
\echo '=== P5: el canje NO puede pasar del 50% del total ==='
do $$
declare v jsonb; v_antes int; v_despues int;
begin
  select points_balance into v_antes from customers where id=current_setting('t.cliente')::uuid;
  -- Venta de 100. El tope es 50 de descuento = 50 puntos a L 1 c/u.
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'redeem_points', 200,                      -- pide canjear 200 (=L 200, mas que la venta)
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',200,'cost',6,'price_contribution',100))));
  select points_balance into v_despues from customers where id=current_setting('t.cliente')::uuid;
  raise notice 'pidio canjear 200, canjeo % por % de descuento; total quedo en %',
    v->>'points_redeemed', v->>'discount', v->>'total';
  if (v->>'points_redeemed')::int = 50 and (v->>'discount')::numeric = 50 then
    raise notice '[ OK ] P5 el tope del 50%% se respeto';
  else raise warning '[ FALLA ] P5 el tope no se respeto'; end if;
end $$;

\echo ''
\echo '=== P6: los puntos se ganan sobre lo PAGADO, no sobre el precio de lista ==='
do $$
declare v jsonb;
begin
  -- Venta de 200 canjeando 40 puntos (L 40): paga 160. Debe ganar sobre los
  -- 160 pagados (5 puntos), no sobre los 200 de lista (7 puntos).
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'redeem_points', 40,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',400,'cost',12,'price_contribution',200))));
  if (v->>'points_earned')::int = 5 then
    raise notice '[ OK ] P6 gano 5 puntos sobre los L 160 pagados (no 7 sobre L 200)';
  else raise warning '[ FALLA ] P6 gano % puntos', v->>'points_earned'; end if;
end $$;

\echo ''
\echo '=== P7: ATAQUES al saldo ==='
select pg_temp.ataque('P7a cajera se sube el saldo a mano',
  $q$update public.customers set points_balance = 99999$q$);
select pg_temp.ataque('P7b cajera escribe en el libro de movimientos',
  $q$insert into public.loyalty_transactions(customer_id,kind,points)
     values(current_setting('t.cliente')::uuid,'gana',5000)$q$);
select pg_temp.ataque('P7c cajera borra movimientos',
  $q$delete from public.loyalty_transactions$q$);
select pg_temp.ataque('P7d cajera cambia las reglas del programa',
  $q$update public.loyalty_config set valor_punto = 100$q$);
select pg_temp.ataque('P7d2 cajera regala puntos bajando el monto por punto',
  $q$update public.loyalty_config set monto_por_punto = 0.01$q$);
select pg_temp.ataque('P7e cajera ajusta puntos (es de gerente)',
  $q$select public.loyalty_ajustar(current_setting('t.cliente')::uuid, 500, 'me regalo')$q$);
select pg_temp.ataque('P7f saldo negativo',
  $q$select public.loyalty_ajustar(current_setting('t.cliente')::uuid, -999999, 'vaciar')$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== P8: el gerente tampoco cambia las reglas (eso es del propietario) ==='
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ataque('P8 gerente cambia valor_punto',
  $q$update public.loyalty_config set valor_punto = 100$q$);
select pg_temp.ataque('P8b gerente ajusta sin escribir razon',
  $q$select public.loyalty_ajustar(current_setting('t.cliente')::uuid, 100, '')$q$);
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== P9: puntos COMPARTIDOS pero movimientos AISLADOS ==='
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';   -- gerente Multiplaza
select 'P9a ve a la clienta de Galerias (debe ser 1, son compartidos)' as prueba,
       count(*) as filas from customers where id = current_setting('t.cliente')::uuid;
select 'P9b ve su saldo (debe traer numero)' as prueba,
       points_balance from customers where id = current_setting('t.cliente')::uuid;
select 'P9c ve los MOVIMIENTOS de Galerias (debe ser 0, estan aislados)' as prueba,
       count(*) as filas from loyalty_transactions
 where location_id = current_setting('t.galerias')::uuid;
select 'P9d ve las VENTAS de Galerias (debe ser 0)' as prueba,
       count(*) as filas from sales where location_id = current_setting('t.galerias')::uuid;
reset role; reset request.jwt.claim.sub;

\echo ''
\echo '=== P10: el carnet público solo entrega lo mínimo ==='
set role anon;
select pg_temp.ataque('P10a el anonimo lee la tabla de clientes', $q$select * from public.customers$q$);
select pg_temp.ataque('P10b el anonimo lee los movimientos',      $q$select * from public.loyalty_transactions$q$);
reset role;
select 'P10c campos que devuelve el carnet publico' as prueba,
       (select string_agg(k, ', ' order by k)
          from jsonb_object_keys(public.loyalty_carnet(
            (select card_code from customers where id=current_setting('t.cliente')::uuid))) k) as campos;
select 'P10d un codigo inventado no devuelve nada' as prueba,
       coalesce(public.loyalty_carnet('XXXXXXXXXX')::text, 'null') as resultado;

\echo ''
\echo '=== P11: el saldo cuadra con el libro de movimientos ==='
select 'P11 diferencia entre saldo y suma de movimientos (debe ser 0)' as prueba,
       c.points_balance - coalesce(sum(t.points), 0) as diferencia
  from customers c
  left join loyalty_transactions t on t.customer_id = c.id
 where c.id = current_setting('t.cliente')::uuid
 group by c.points_balance;

\echo ''
\echo '=== P12: los puntos NUNCA tumban una venta (venta sin internet, cliente desactivado) ==='
-- Escenario: la cajera cobra sin internet con el carnet de la clienta. Antes
-- de que la caja sincronice, el gerente desactiva a esa clienta. Al llegar
-- la venta, no puede rechazarse: la cola descarta los rechazos y se perdería
-- una venta que sí ocurrió.
update public.customers set active = false where phone = '9988-7766';
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare v jsonb; v_cli uuid;
begin
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'synced_offline', true,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',3,'price_contribution',45))));
  select customer_id into v_cli from public.sales where id = (v->>'sale_id')::uuid;
  if v->>'sale_id' is not null and v_cli is null then
    raise notice '[ OK ] P12 la venta entro (folio %) y quedo sin cliente, sin puntos', v->>'folio';
  else
    raise warning '[ FALLA ] P12 resultado inesperado: %', v;
  end if;
exception when others then
  raise warning '[ FALLA ] P12 la venta se RECHAZO y se habria perdido: %', SQLERRM;
end $$;

\echo '--- P12b: pero si pedia CANJEAR con un cliente inactivo, si se rechaza ---'
do $$
begin
  perform public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.cliente')::uuid,
    'redeem_points', 30,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',3,'price_contribution',45))));
  raise warning '[ FALLA ] P12b se canjearon puntos de un cliente inactivo';
exception when others then
  raise notice '[ bloqueado ] P12b canje con cliente inactivo (%)', SQLERRM;
end $$;

\echo '--- P12c: y lo mismo con el programa APAGADO y un cliente que ya no existe ---'
reset role; reset request.jwt.claim.sub;
update public.loyalty_config set activo = false;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare v jsonb;
begin
  v := public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.galerias')::uuid,
    'client_uuid', gen_random_uuid(),
    'customer_id', gen_random_uuid(),              -- un cliente que no existe
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',3,'price_contribution',45))));
  raise notice '[ OK ] P12c la venta entro igual (folio %)', v->>'folio';
exception when others then
  raise warning '[ FALLA ] P12c la venta se rechazo: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;
update public.loyalty_config set activo = true;
update public.customers set active = true where phone = '9988-7766';

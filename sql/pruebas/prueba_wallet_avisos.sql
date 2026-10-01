-- ============================================================================
--  PRUEBAS: avisos de cambio de saldo para Wallet
--  pg_net solo existe en Supabase; aquí se simula con una función que anota
--  cada llamada (y que se puede hacer fallar a propósito). Correr después de
--  00..09, con la línea "create extension pg_net" omitida.
-- ============================================================================
\set ON_ERROR_STOP on

create schema if not exists net;
create table if not exists net.llamadas (id serial, url text, body jsonb, headers jsonb);
create table if not exists net.falla (activa boolean);
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
language plpgsql as $$
begin
  if exists (select 1 from net.falla where activa) then raise exception 'pg_net caido (simulado)'; end if;
  insert into net.llamadas(url, body, headers) values (url, body, headers);
  return currval('net.llamadas_id_seq');
end $$;

delete from public.customers where phone in ('5550-0001');
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active)
select id, 'cajera', null, true from auth.users on conflict (id) do nothing;
update public.profiles set role='cajera', full_name='Cajera',
  location_id=(select id from locations where name='Tuti''s Galerías') where id='33333333-3333-3333-3333-333333333333';
update public.profiles set role='gerente', full_name='Gerente',
  location_id=(select id from locations where name='Tuti''s Galerías') where id='22222222-2222-2222-2222-222222222222';
select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false);

set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select set_config('t.c', public.loyalty_registrar('Prueba Wallet','5550-0001')->>'id', false);
reset role; reset request.jwt.claim.sub;
select set_config('t.code', (select card_code from customers where id=current_setting('t.c')::uuid), false);

create or replace function pg_temp.vender(p_monto numeric, p_canje int default 0) returns jsonb language plpgsql as $$
begin
  return public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.g')::uuid, 'client_uuid', gen_random_uuid(),
    'customer_id', current_setting('t.c')::uuid, 'redeem_points', p_canje,
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Y','weight_g',100,'cost',1,'price_contribution',p_monto))));
end $$;
create or replace function pg_temp.avisos() returns int language sql as $$ select count(*)::int from net.llamadas $$;

\echo '=== W1: sin configurar, la venta entra y no se avisa a nadie ==='
truncate net.llamadas;
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select 'W1 puntos ganados' as prueba, pg_temp.vender(270)->>'points_earned' as valor;
reset role; reset request.jwt.claim.sub;
select 'W1 avisos (debe ser 0)' as prueba, pg_temp.avisos() as valor;

\echo '=== conectar ==='
insert into privado.wallet_config (id, url, secreto)
values (true, 'https://wallet.slabblu.com/notificar', repeat('s', 64))
on conflict (id) do update set url = excluded.url, secreto = excluded.secreto;

\echo '=== W2: una venta que da puntos manda UN aviso, con el codigo y el secreto ==='
truncate net.llamadas;
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.vender(270) is not null as vendio;
reset role; reset request.jwt.claim.sub;
select 'W2 avisos (debe ser 1)' as prueba, pg_temp.avisos() as valor;
select 'W2 lleva el codigo correcto' as prueba, (body->>'codigo') = current_setting('t.code') as valor from net.llamadas;
select 'W2 lleva el secreto' as prueba, (headers->>'X-Tutis-Secreto') = repeat('s',64) as valor from net.llamadas;

\echo '=== W3: una venta chica que NO cambia el saldo no avisa ==='
truncate net.llamadas;
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.vender(20)->>'points_earned' as puntos_ganados;   -- L 20 < L 27 = 0 puntos
reset role; reset request.jwt.claim.sub;
select 'W3 avisos (debe ser 0)' as prueba, pg_temp.avisos() as valor;

\echo '=== W4: corregir el telefono de un cliente no avisa ==='
truncate net.llamadas;
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
update public.customers set phone = '5550-0001' where id = current_setting('t.c')::uuid;
reset role; reset request.jwt.claim.sub;
select 'W4 avisos (debe ser 0)' as prueba, pg_temp.avisos() as valor;

\echo '=== W5: un ajuste manual avisa ==='
truncate net.llamadas;
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.loyalty_ajustar(current_setting('t.c')::uuid, 30, 'Prueba de aviso') is not null as ajusto;
reset role; reset request.jwt.claim.sub;
select 'W5 avisos (debe ser 1)' as prueba, pg_temp.avisos() as valor;

\echo '=== W6: LA REGLA DE ORO — con pg_net caido, la venta entra igual ==='
truncate net.llamadas; insert into net.falla values (true);
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
declare v jsonb; v_antes int; v_despues int;
begin
  select points_balance into v_antes from public.customers where id = current_setting('t.c')::uuid;
  v := pg_temp.vender(540);
  select points_balance into v_despues from public.customers where id = current_setting('t.c')::uuid;
  if v->>'sale_id' is not null and v_despues = v_antes + 20 then
    raise notice '[ OK ] W6 la venta entro (folio %) y el saldo subio % -> % aunque el aviso fallo', v->>'folio', v_antes, v_despues;
  else raise warning '[ FALLA ] W6 resultado inesperado: %', v; end if;
exception when others then
  raise warning '[ FALLA ] W6 la venta se cayo por culpa del aviso: %', SQLERRM;
end $$;
reset role; reset request.jwt.claim.sub;
delete from net.falla;

\echo '=== W7: nadie de la aplicacion puede leer el secreto ==='
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  perform * from privado.wallet_config;
  raise warning '[ FALLA ] W7 un gerente leyo el secreto';
exception when others then raise notice '[ bloqueado ] W7 gerente lee el secreto (%)', SQLERRM; end $$;
reset role; reset request.jwt.claim.sub;
set role anon;
do $$ begin
  perform * from privado.wallet_config;
  raise warning '[ FALLA ] W7b el anonimo leyo el secreto';
exception when others then raise notice '[ bloqueado ] W7b anonimo lee el secreto (%)', SQLERRM; end $$;
reset role;

\echo '=== W8: un secreto corto no se acepta ==='
do $$ begin
  update privado.wallet_config set secreto = 'corto';
  raise warning '[ FALLA ] W8 se acepto un secreto corto';
exception when others then raise notice '[ bloqueado ] W8 secreto corto (%)', SQLERRM; end $$;

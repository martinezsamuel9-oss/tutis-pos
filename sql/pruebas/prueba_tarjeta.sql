-- ============================================================================
--  PRUEBAS: voucher de las ventas con tarjeta (sql/16)
--  Correr después de 00..16. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active, full_name)
values ('33333333-3333-3333-3333-333333333333', 'cajera', (select id from locations where name='Tuti''s Galerías'), true, 'Cajera Galerías')
on conflict (id) do update set role='cajera', location_id=excluded.location_id, active=true;
select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false);
delete from public.sales where customer_name = '[prueba tarjeta]';

create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALLA %', msg; end if;
  raise notice '[ OK ] %', msg;
end $$;
-- Una venta de un producto suelto con lo que se le pida de pago.
create or replace function pg_temp.vender(pago text, aut text, ult text, hora timestamptz) returns jsonb language sql as $$
  select public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(), 'created_at', hora,
    'customer_name', '[prueba tarjeta]', 'payment_method', pago, 'card_auth_code', aut, 'card_last4', ult,
    'lines', jsonb_build_array(jsonb_build_object('item_type','vaso','name','Vaso','weight_g',0,'cost',1,'price_contribution',100))));
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.vender(text, text, text, timestamptz) to authenticated;

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select set_config('t.v1', pg_temp.vender('tarjeta', ' ab 123456 ', '4321', '2030-02-01 16:00+00')::text, false);
select set_config('t.v2', pg_temp.vender('tarjeta', '12-34!', '4111111111111111', '2030-02-01 17:00+00')::text, false);
select set_config('t.v3', pg_temp.vender('efectivo', '999999', '1234', '2030-02-01 18:00+00')::text, false);
select set_config('t.v4', pg_temp.vender('tarjeta', null, null, '2030-02-01 19:00+00')::text, false);
reset role;

create or replace function pg_temp.venta(k text) returns public.sales language sql as $$
  select * from public.sales where id = (current_setting(k)::jsonb->>'sale_id')::uuid;
$$;
select pg_temp.ok((pg_temp.venta('t.v1')).card_auth_code = 'AB123456' and (pg_temp.venta('t.v1')).card_last4 = '4321',
  'T1 la autorización se guarda limpia (sin espacios, en mayúsculas) con los últimos 4');
select pg_temp.ok((pg_temp.venta('t.v2')).id is not null and (pg_temp.venta('t.v2')).card_auth_code is null,
  'T2 una autorización mal tecleada no tumba la venta: queda vacía para el reporte');
select pg_temp.ok((pg_temp.venta('t.v2')).card_last4 is null,
  'T3 un número de tarjeta completo NUNCA se guarda (solo se aceptan 4 dígitos)');
select pg_temp.ok((pg_temp.venta('t.v3')).card_auth_code is null and (pg_temp.venta('t.v3')).card_last4 is null,
  'T4 una venta en efectivo no guarda datos de tarjeta');
do $$ begin
  begin
    update public.sales set card_last4 = '41111111' where id = (current_setting('t.v1')::jsonb->>'sale_id')::uuid;
    raise exception 'FALLA T5 la base aceptó más de 4 dígitos';
  exception when check_violation then raise notice '[ OK ] T5 la base misma rechaza guardar más de 4 dígitos';
  end;
end $$;

select set_config('t.c', public.daily_closing_core(current_setting('t.g')::uuid, '2030-02-01', -6)::text, false);
select pg_temp.ok(jsonb_array_length(current_setting('t.c')::jsonb->'vouchers') = 3
                  and (current_setting('t.c')::jsonb->>'tarjeta_sin_autorizacion')::int = 2,
  'T6 el cierre trae los 3 vouchers del día y marca 2 sin autorización');
select pg_temp.ok((current_setting('t.c')::jsonb->'vouchers'->0->>'autorizacion') = 'AB123456'
                  and (current_setting('t.c')::jsonb->'vouchers'->0->>'total')::numeric = 100,
  'T7 cada voucher con su autorización y su monto, en orden de hora');

delete from public.sales where customer_name = '[prueba tarjeta]';
\echo 'TODAS LAS PRUEBAS DE TARJETA PASARON'

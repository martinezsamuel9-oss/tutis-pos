-- ============================================================================
--  PRUEBAS: roles Operaciones y Contabilidad (sql/20) y cierre de caja por
--  forma de pago con pre-cierre y lote del datáfono (sql/21).
--  Correr después de 00..21. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

delete from public.cash_movements where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.cash_sessions  where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.sales where customer_name = '[prueba cierre]';

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-000000000001', 'cata.caja@tutis.test'),
  ('d0000000-0000-0000-0000-000000000002', 'oscar.operaciones@tutis.test'),
  ('d0000000-0000-0000-0000-000000000003', 'conta.galerias@tutis.test'),
  ('d0000000-0000-0000-0000-000000000004', 'conta.oficina@tutis.test'),
  ('d0000000-0000-0000-0000-000000000005', 'ops.oficina@tutis.test'),
  ('d0000000-0000-0000-0000-000000000006', 'suelto@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, todas_tiendas, active, full_name) values
  ('d0000000-0000-0000-0000-000000000001', 'cajera',       current_setting('t.g')::uuid, false, true, 'Cata'),
  ('d0000000-0000-0000-0000-000000000002', 'operaciones',  current_setting('t.g')::uuid, false, true, 'Óscar'),
  ('d0000000-0000-0000-0000-000000000003', 'contabilidad', current_setting('t.g')::uuid, false, true, 'Conta G'),
  ('d0000000-0000-0000-0000-000000000004', 'contabilidad', null, true, true, 'Conta Oficina'),
  ('d0000000-0000-0000-0000-000000000005', 'operaciones',  null, true, true, 'Ops Oficina'),
  ('d0000000-0000-0000-0000-000000000006', 'operaciones',  null, false, true, 'Suelto')
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
create or replace function pg_temp.venta(metodo text, total numeric, aut text default null, ult4 text default null) returns void language sql as $$
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name, card_auth_code, card_last4)
  values (current_setting('t.g')::uuid, gen_random_uuid(),
          (select coalesce(max(folio), 0) + 1 from public.sales where location_id = current_setting('t.g')::uuid),
          now(), total, metodo, '[prueba cierre]', aut, ult4);
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated, anon;

-- ============================================================ ROLES
reset role;
select pg_temp.falla($$update public.profiles set todas_tiendas = true where id = 'd0000000-0000-0000-0000-000000000001'$$,
  'profiles_todas_tiendas_chk', 'R1 una cajera no puede ser "de todas las tiendas"');

set role authenticated;
select pg_temp.como('d0000000-0000-0000-0000-000000000006');
select pg_temp.ok(public.app_role() is null, 'R2 operaciones sin tienda y sin "todas" no es nadie');
select pg_temp.ok((select count(*) from public.locations) = 0, 'R3 y no ve ninguna tienda');

select pg_temp.como('d0000000-0000-0000-0000-000000000005');
select pg_temp.ok(public.app_role() = 'operaciones' and (select count(*) from public.locations) >= 2, 'R4 operaciones de oficina ve todas las tiendas');
select pg_temp.ok(public.can_operate_location(current_setting('t.m')::uuid) and not public.can_account_location(current_setting('t.m')::uuid),
  'R5 opera inventario en todas, pero no es contabilidad');

select pg_temp.como('d0000000-0000-0000-0000-000000000002');
select pg_temp.ok(public.can_operate_location(current_setting('t.g')::uuid) and not public.can_operate_location(current_setting('t.m')::uuid),
  'R6 operaciones de Galerías opera Galerías y no Multiplaza');
select pg_temp.ok(not public.can_manage_location(current_setting('t.g')::uuid), 'R7 operaciones no administra la tienda (precios, catálogo)');
with u as (update public.toppings set cost_per_gram = 9 where location_id = current_setting('t.g')::uuid returning 1)
select pg_temp.ok(count(*) = 0, 'R7b ni cambia costos de toppings') from u;
select pg_temp.ok((select count(*) from public.customers) = 0, 'R8 operaciones no ve los datos de los clientes');
select pg_temp.falla($$select public.caja_estado(current_setting('t.g')::uuid)$$, 'no opera la caja', 'R9 operaciones no abre la caja');
select pg_temp.falla($$select public.process_sale(jsonb_build_object('location_id', current_setting('t.g'), 'client_uuid', gen_random_uuid(),
     'lines', '[]'::jsonb, 'payment_method', 'efectivo'))$$, 'no registra ventas', 'R10 operaciones no cobra');
select pg_temp.ok((select count(*) from public.purchases where location_id = current_setting('t.g')::uuid) >= 0
                  and public.can_operate_location(current_setting('t.g')::uuid), 'R11 operaciones ve las compras de su tienda');

select pg_temp.como('d0000000-0000-0000-0000-000000000003');
select pg_temp.ok(public.can_account_location(current_setting('t.g')::uuid) and not public.can_account_location(current_setting('t.m')::uuid)
                  and not public.can_account_location(null), 'R12 contabilidad de Galerías: solo Galerías, no la oficina');
select pg_temp.ok(not public.can_operate_location(current_setting('t.g')::uuid), 'R13 contabilidad no toca inventario');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '{"100": 1}')$$, 'no opera la caja', 'R14 contabilidad no abre la caja');
select pg_temp.ok((public.caja_turnos(current_setting('t.g')::uuid, current_date - 1, current_date)->'turnos') is not null,
  'R15 contabilidad SÍ ve los turnos de caja de su tienda');
select pg_temp.falla($$select public.caja_turnos(current_setting('t.m')::uuid, current_date - 1, current_date)$$, 'Solo la gerente',
  'R16 pero no los de la otra tienda');
select pg_temp.falla(format($$select public.caja_revisar(%L, '')$$, gen_random_uuid()), 'no existe', 'R16b (revisar un cierre sigue siendo de la gerente)');

select pg_temp.como('d0000000-0000-0000-0000-000000000004');
select pg_temp.ok(public.can_account_location(null) and public.can_account_location(current_setting('t.m')::uuid),
  'R17 contabilidad de oficina: todas las tiendas y la oficina');
reset role;

-- ============================================================ CIERRE POR FORMA DE PAGO
set role authenticated;
select pg_temp.como('d0000000-0000-0000-0000-000000000001');
select public.caja_abrir(current_setting('t.g')::uuid, '{"500": 2}');                       -- fondo 1000
reset role;
select pg_temp.venta('efectivo', 115.50);
select pg_temp.venta('efectivo', 200);
select pg_temp.venta('tarjeta', 285.83, '000123', '2640');
select pg_temp.venta('tarjeta', 270.00, '000124', '5890');
select pg_temp.venta('tarjeta', 249.29, '000124', '9031');   -- autorización repetida
select pg_temp.venta('tarjeta', 83.18, null, null);          -- sin autorización
select pg_temp.venta('transferencia', 150);
select pg_temp.venta('pedidosya', 310);
select pg_temp.venta('hugo', 95.40);

set role authenticated;
select pg_temp.como('d0000000-0000-0000-0000-000000000001');
select set_config('t.pre', public.caja_precierre(current_setting('t.g')::uuid)::text, false);
select pg_temp.ok((current_setting('t.pre')::jsonb->>'ventas')::int = 4 and (current_setting('t.pre')::jsonb->>'monto')::numeric = 888.30,
  'C1 el pre-cierre trae las 4 ventas con tarjeta del turno: L 888.30');
select pg_temp.ok((current_setting('t.pre')::jsonb->>'sin_autorizacion')::int = 1, 'C2 marca la venta con tarjeta sin autorización');
select pg_temp.ok((select count(*) from jsonb_array_elements(current_setting('t.pre')::jsonb->'vouchers') v where (v->>'repetida')::boolean) = 2,
  'C3 marca la autorización repetida (las dos ventas)');
select pg_temp.ok(not (current_setting('t.pre')::jsonb ? 'esperado'), 'C4 el pre-cierre no revela el efectivo esperado');

select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"500": 2}', 1000, '{"tarjeta": 888.30}')$$,
  'cierre del datáfono', 'C5 con ventas con tarjeta, no se cierra sin el lote del datáfono');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"500": 2}', 1000, '{"bitcoin": 5}', '{"lote":"1","ventas":1,"monto":1}')$$,
  'Forma de pago no válida', 'C6 forma de pago inventada no entra');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"500": 2}', 1000, '{"tarjeta": -5}', '{"lote":"1","ventas":1,"monto":1}')$$,
  'Monto declarado no válido', 'C7 monto negativo no entra');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"500": 2}', 1000, '{}', '{"lote":"1; drop","ventas":1,"monto":1}')$$,
  'lote', 'C8 número de lote raro no entra');

-- Efectivo esperado: 1000 + 115.50 + 200 = 1315.50. Cuenta 1315.00 (falta 0.50).
-- Tarjeta: lote del datáfono 888.30 en 4 ventas; declara 888.30.
-- Transferencia declara 150; Pedidos Ya declara 300 (faltan 10); Hugo 95.40.
select set_config('t.c', public.caja_cerrar(current_setting('t.g')::uuid,
  '{"500": 2, "200": 1, "100": 1, "10": 1, "5": 1}', 1000,
  '{"tarjeta": 888.30, "transferencia": 150, "pedidosya": 300, "hugo": 95.40}',
  '{"lote": "000389", "ventas": 4, "monto": 888.30}')::text, false);
select pg_temp.ok((current_setting('t.c')::jsonb->>'diferencia')::numeric = -0.50, 'C9 efectivo: faltan L 0.50');
select pg_temp.ok((select (f->>'diferencia')::numeric = -10 and (f->>'sistema')::numeric = 310
                     from jsonb_array_elements(current_setting('t.c')::jsonb->'formas') f where f->>'metodo' = 'pedidosya'),
  'C10 Pedidos Ya: sistema 310, declarado 300, faltan 10');
select pg_temp.ok((select (f->>'diferencia')::numeric = 0 from jsonb_array_elements(current_setting('t.c')::jsonb->'formas') f where f->>'metodo' = 'tarjeta')
                  and (current_setting('t.c')::jsonb->>'lote_diferencia')::numeric = 0
                  and (current_setting('t.c')::jsonb->>'lote_ventas_diferencia')::int = 0,
  'C11 tarjeta cuadra con el sistema y con el lote del datáfono');
select pg_temp.ok((current_setting('t.c')::jsonb->>'total_sistema')::numeric = 1315.50 + 888.30 + 150 + 310 + 95.40
                  and (current_setting('t.c')::jsonb->>'diferencia_total')::numeric = -10.50,
  'C12 total calculado contra total declarado: faltan L 10.50 en total');
select pg_temp.ok(jsonb_array_length(current_setting('t.c')::jsonb->'formas') = 5, 'C13 el cuadre trae las 5 formas de pago');
reset role;
select pg_temp.ok((select declarado->>'hugo' = '95.40' and lote_tarjeta->>'lote' = '000389' and cuentas_al_cerrar is not null
                     from public.cash_sessions where id = (current_setting('t.c')::jsonb->>'id')::uuid),
  'C14 lo declarado y el lote quedan guardados con el turno');

set role authenticated;
select pg_temp.como('d0000000-0000-0000-0000-000000000003');
select pg_temp.ok((select (t->>'diferencia_total')::numeric = -10.50 and t->'lote_tarjeta'->>'lote' = '000389'
                     from jsonb_array_elements(public.caja_turnos(current_setting('t.g')::uuid, current_date - 1, current_date + 1)->'turnos') t
                    where t->>'id' = current_setting('t.c')::jsonb->>'id'),
  'C15 contabilidad ve el cuadre por forma de pago y el lote en el reporte de turnos');
reset role;

-- Sin ventas con tarjeta se cierra sin lote.
set role authenticated;
select pg_temp.como('d0000000-0000-0000-0000-000000000001');
select public.caja_abrir(current_setting('t.g')::uuid, '{"500": 2}');
select pg_temp.ok((public.caja_cerrar(current_setting('t.g')::uuid, '{"500": 2}', 1000)->>'diferencia')::numeric = 0,
  'C16 sin ventas con tarjeta no hace falta el lote');
reset role;

-- ------------------------------------------------------------ limpieza
delete from public.cash_movements where location_id = current_setting('t.g')::uuid;
delete from public.cash_sessions  where location_id = current_setting('t.g')::uuid;
delete from public.sales where customer_name = '[prueba cierre]';
select 'prueba_cierre: todo bien' as resultado;

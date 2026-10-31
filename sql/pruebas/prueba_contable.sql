-- ============================================================================
--  PRUEBAS: libro contable (sql/25).
--  Un mes chico de Galerías (marzo de 2020, para no cruzarse con las otras
--  pruebas): ventas con cada forma de pago y canje de puntos, una compra de la
--  tienda y una de la oficina, un gasto, un retiro, dos arqueos y un asiento
--  manual. Se revisa que cada asiento cuadre, que cada cosa caiga en su cuenta
--  y que nadie vea ni escriba el libro de otra tienda.
--  Correr después de 00..25. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

-- Limpieza (solo en la base local de pruebas).
delete from public.cont_asientos where concepto like '[prueba]%';
delete from public.cont_cuentas where nombre like '[prueba]%';
delete from public.sales where customer_name = '[prueba contable]';
delete from public.purchases where supplier_name like '[prueba contable]%';
delete from public.expenses where description like '[prueba contable]%';
delete from public.cash_movements where motivo like '[prueba contable]%';
delete from public.cash_sessions where abierto_nombre = '[prueba contable]';
update public.cont_config set incluir_gastos = false;

insert into auth.users (id, email) values
  ('e2000000-0000-0000-0000-000000000001', 'caja.g.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000002', 'ops.g.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000003', 'gerente.g.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000004', 'gerente.m.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000005', 'conta.g.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000006', 'conta.todas.cont@tutis.test'),
  ('e2000000-0000-0000-0000-000000000007', 'duena.cont@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, todas_tiendas, active, full_name) values
  ('e2000000-0000-0000-0000-000000000001', 'cajera',       current_setting('t.g')::uuid, false, true, 'Caja G'),
  ('e2000000-0000-0000-0000-000000000002', 'operaciones',  current_setting('t.g')::uuid, false, true, 'Ops G'),
  ('e2000000-0000-0000-0000-000000000003', 'gerente',      current_setting('t.g')::uuid, false, true, 'Gerente G'),
  ('e2000000-0000-0000-0000-000000000004', 'gerente',      current_setting('t.m')::uuid, false, true, 'Gerente M'),
  ('e2000000-0000-0000-0000-000000000005', 'contabilidad', current_setting('t.g')::uuid, false, true, 'Conta G'),
  ('e2000000-0000-0000-0000-000000000006', 'contabilidad', null, true, true, 'Conta todas'),
  ('e2000000-0000-0000-0000-000000000007', 'propietario',  null, false, true, 'Dueña')
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
create or replace function pg_temp.cuenta(clave text) returns uuid language sql as $$
  select id from public.cont_cuentas where cont_cuentas.clave = $1 $$;
-- Suma del debe (d) o del haber (h) de una cuenta en un diario.
create or replace function pg_temp.lado(diario jsonb, origen text, clave text, lado text) returns numeric language sql as $$
  select coalesce(sum((l->>lado)::numeric), 0)
    from jsonb_array_elements(diario->'asientos') a, jsonb_array_elements(a->'lineas') l
   where (origen is null or a->>'origen' = origen) and (l->>'cuenta_id')::uuid = pg_temp.cuenta(clave) $$;

-- ----------------------------------------------------------------------------
-- Los datos del mes (como postgres: es la operación que ya ocurrió)
-- ----------------------------------------------------------------------------
insert into public.sales (location_id, client_uuid, folio, created_at, total_price, total_cost, discount, payment_method, customer_name) values
  (current_setting('t.g')::uuid, gen_random_uuid(), 990001, '2020-03-10 15:00-06', 115.00, 40, 0,  'efectivo',      '[prueba contable]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 990002, '2020-03-10 15:10-06', 230.00, 80, 0,  'tarjeta',       '[prueba contable]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 990003, '2020-03-10 15:20-06',  57.50, 20, 0,  'transferencia', '[prueba contable]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 990004, '2020-03-10 15:30-06', 100.00, 30, 0,  'pedidosya',     '[prueba contable]'),
  (current_setting('t.g')::uuid, gen_random_uuid(), 990005, '2020-03-10 15:40-06',  92.00, 30, 23, 'efectivo',      '[prueba contable]'),
  -- 23:30 en la tienda = 05:30 UTC del 11: cuenta en el día 10.
  (current_setting('t.g')::uuid, gen_random_uuid(), 990006, '2020-03-10 23:30-06',  11.50,  5, 0,  null,            '[prueba contable]'),
  (current_setting('t.m')::uuid, gen_random_uuid(), 990001, '2020-03-10 15:00-06', 999.00, 10, 0,  'efectivo',      '[prueba contable]');

insert into public.purchases (location_id, compra, received_on, invoice_date, supplier_name, supplier_invoice_no, exento, gravado15, isv15) values
  (current_setting('t.g')::uuid, 'materia_tienda', '2020-03-12', '2020-03-12', '[prueba contable] Lácteos', '001-001-01-00000077', 10, 100, 15),
  (null,                         'gasto',          '2020-03-12', '2020-03-12', '[prueba contable] Energía', '001-001-01-00000078', 0, 200, 30);

insert into public.expenses (location_id, spent_on, category, description, amount) values
  (current_setting('t.g')::uuid, '2020-03-13', 'renta', '[prueba contable] renta de marzo', 500);

insert into public.cash_sessions (location_id, abierto_nombre, abierto_at, fondo, cerrado_nombre, cerrado_at, contado, esperado) values
  (current_setting('t.g')::uuid, '[prueba contable]', '2020-03-14 08:00-06', 1000, 'Ana <b>', '2020-03-14 18:00-06', 950, 1000),
  (current_setting('t.g')::uuid, '[prueba contable]', '2020-03-15 08:00-06', 1000, 'Ana',     '2020-03-15 18:00-06', 1020, 1000);
insert into public.cash_movements (session_id, location_id, tipo, monto, motivo, creado_at)
select id, location_id, 'retiro', 300, '[prueba contable] depósito', '2020-03-14 12:00-06'
  from public.cash_sessions where abierto_nombre = '[prueba contable]' and abierto_at::date = '2020-03-14';

set role authenticated;

-- ----------------------------------------------------------------------------
-- Quién ve el libro
-- ----------------------------------------------------------------------------
select pg_temp.como('e2000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.cont_diario(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31')$$, 'No tienes acceso', 'K1 la cajera no ve el libro');
select pg_temp.ok((select count(*) from public.cont_cuentas) = 0, 'K1b la cajera no ve el catálogo de cuentas');
select pg_temp.como('e2000000-0000-0000-0000-000000000002');
select pg_temp.falla($$select public.cont_diario(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31')$$, 'No tienes acceso', 'K2 operaciones no ve el libro');
select pg_temp.como('e2000000-0000-0000-0000-000000000003');
select pg_temp.ok(public.cont_diario(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31') is not null, 'K3 la gerente ve el libro de su tienda');
select pg_temp.falla($$select public.cont_diario(current_setting('t.m')::uuid, '2020-03-01', '2020-03-31')$$, 'No tienes acceso', 'K3b y no el de la otra');
select pg_temp.falla($$select public.cont_diario(null, '2020-03-01', '2020-03-31')$$, 'la oficina', 'K3c ni el de la oficina');
select pg_temp.como('e2000000-0000-0000-0000-000000000005');
select pg_temp.falla($$select public.cont_balanza(current_setting('t.m')::uuid, '2020-03-01', '2020-03-31')$$, 'No tienes acceso', 'K4 contabilidad de Galerías no ve Multiplaza');
select pg_temp.como('e2000000-0000-0000-0000-000000000006');
select pg_temp.ok(public.cont_diario(null, '2020-03-01', '2020-03-31') is not null, 'K5 contabilidad de todas ve la oficina');
select pg_temp.falla($$insert into public.cont_asientos (location_id, fecha, concepto) values (null, '2020-03-01', '[prueba] directo')$$,
                     'permission denied', 'K6 nadie escribe el libro directo, solo por funciones');
select pg_temp.falla($$select public.cont_movimientos(null, '2020-03-01', '2020-03-31')$$, 'permission denied', 'K7 la función interna no se llama desde fuera');
select pg_temp.falla($$select public.cont_diario(current_setting('t.g')::uuid, '2020-01-01', '2020-12-31')$$, '1 a 93', 'K8 el diario tiene tope de días');

-- ----------------------------------------------------------------------------
-- Las ventas del día
-- ----------------------------------------------------------------------------
select pg_temp.como('e2000000-0000-0000-0000-000000000003');
select set_config('t.d10', public.cont_diario(current_setting('t.g')::uuid, '2020-03-10', '2020-03-10')::text, false);
select pg_temp.ok((select (a->>'debe')::numeric = 629.00 and (a->>'haber')::numeric = 629.00
                     from jsonb_array_elements(current_setting('t.d10')::jsonb->'asientos') a where a->>'origen' = 'ventas'),
                  'D1 el asiento de ventas cuadra: 606 cobrados + 23 de descuento = 629 por los dos lados');
select pg_temp.ok(pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'caja', 'debe') = 218.50,
                  'D2 a caja va el efectivo, lo sin dato y la venta de las 23:30 (fecha de la tienda, no UTC)');
select pg_temp.ok(pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'tarjeta', 'debe') = 230
              and pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'bancos', 'debe') = 57.50
              and pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'delivery', 'debe') = 100,
                  'D3 tarjeta por cobrar, transferencia al banco y Pedidos Ya por cobrar');
select pg_temp.ok(pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'isv_debito', 'haber') = 79.04
              and pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'ventas', 'haber') = 549.96
              and pg_temp.lado(current_setting('t.d10')::jsonb, 'ventas', 'descuentos', 'debe') = 23,
                  'D4 ISV separado factura por factura como el libro de ventas (79.04), ventas 549.96 y el canje como descuento');
select pg_temp.ok(pg_temp.lado(current_setting('t.d10')::jsonb, 'costo', 'costo_ventas', 'debe') = 205
              and pg_temp.lado(current_setting('t.d10')::jsonb, 'costo', 'inventario', 'haber') = 205,
                  'D5 costo de lo vendido contra inventario');
select pg_temp.ok((current_setting('t.d10')::jsonb->>'debe')::numeric = 629 + 205, 'D6 el día suma solo lo de Galerías (ventas 629 + costo 205): la venta de 999 de Multiplaza no está');

-- ----------------------------------------------------------------------------
-- Compras, gastos y caja
-- ----------------------------------------------------------------------------
select set_config('t.dm', public.cont_diario(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31')::text, false);
select pg_temp.ok(pg_temp.lado(current_setting('t.dm')::jsonb, 'compra', 'inventario', 'debe') = 110
              and pg_temp.lado(current_setting('t.dm')::jsonb, 'compra', 'isv_credito', 'debe') = 15
              and pg_temp.lado(current_setting('t.dm')::jsonb, 'compra', 'proveedores', 'haber') = 125,
                  'D7 la compra de la tienda: inventario, ISV crédito fiscal y proveedores');
select pg_temp.ok(pg_temp.lado(current_setting('t.dm')::jsonb, 'compra', 'gasto_compras', 'debe') = 0,
                  'D7b la compra de la oficina no cae en la tienda');
select pg_temp.ok(pg_temp.lado(current_setting('t.dm')::jsonb, 'gasto', 'gasto_renta', 'debe') = 0,
                  'D8 por defecto los gastos no entran (las facturas de gasto van por compras CTG)');
select pg_temp.falla($$select public.cont_guardar_config(true)$$, 'propietaria o contabilidad', 'D8b la gerente no cambia esa regla');
select pg_temp.ok(pg_temp.lado(current_setting('t.dm')::jsonb, 'arqueo', 'faltante', 'debe') = 50
              and pg_temp.lado(current_setting('t.dm')::jsonb, 'arqueo', 'sobrante', 'haber') = 20,
                  'D9 el faltante y el sobrante de los arqueos');
select pg_temp.ok(pg_temp.lado(current_setting('t.dm')::jsonb, 'caja', 'por_depositar', 'debe') = 300
              and pg_temp.lado(current_setting('t.dm')::jsonb, 'caja', 'caja', 'haber') = 300,
                  'D10 el retiro de la gaveta pasa a efectivo por depositar');
select pg_temp.ok(position('Ana <b>' in current_setting('t.dm')) > 0, 'D10b el nombre de quien cerró va tal cual (la pantalla lo escapa)');
select pg_temp.ok((current_setting('t.dm')::jsonb->>'debe')::numeric = (current_setting('t.dm')::jsonb->>'haber')::numeric
              and not exists (select 1 from jsonb_array_elements(current_setting('t.dm')::jsonb->'asientos') a
                               where (a->>'debe')::numeric <> (a->>'haber')::numeric)
              and (current_setting('t.dm')::jsonb->>'sin_cuenta')::int = 0,
                  'D11 todo el mes cuadra, asiento por asiento, y no hay líneas sin cuenta');

select pg_temp.como('e2000000-0000-0000-0000-000000000007');
select public.cont_guardar_config(true);
select pg_temp.ok(pg_temp.lado(public.cont_diario(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31'), 'gasto', 'gasto_renta', 'debe') = 500,
                  'D12 encendido, el gasto de la pestaña Gastos entra a su cuenta');
select public.cont_guardar_config(false);
select pg_temp.ok(pg_temp.lado(public.cont_diario(null, '2020-03-01', '2020-03-31'), 'compra', 'gasto_compras', 'debe') = 200,
                  'D13 la compra CTG de la oficina está en el libro de la oficina');

-- ----------------------------------------------------------------------------
-- Asientos manuales
-- ----------------------------------------------------------------------------
select pg_temp.como('e2000000-0000-0000-0000-000000000005');
select set_config('t.lin_ok', jsonb_build_array(
  jsonb_build_object('cuenta_id', pg_temp.cuenta('bancos'), 'debe', 225),
  jsonb_build_object('cuenta_id', (select id from public.cont_cuentas where codigo = '6110'), 'debe', 5, 'detalle', 'comisión'),
  jsonb_build_object('cuenta_id', pg_temp.cuenta('tarjeta'), 'haber', 230))::text, false);
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] no cuadra', 'lineas', jsonb_build_array(
    jsonb_build_object('cuenta_id', pg_temp.cuenta('bancos'), 'debe', 225),
    jsonb_build_object('cuenta_id', pg_temp.cuenta('tarjeta'), 'haber', 230))))$$, 'no cuadra', 'A1 un asiento que no cuadra no entra');
select pg_temp.ok(not exists (select 1 from public.cont_asientos where concepto = '[prueba] no cuadra'), 'A1b y no deja la cabecera suelta');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] dos lados', 'lineas', jsonb_build_array(
    jsonb_build_object('cuenta_id', pg_temp.cuenta('bancos'), 'debe', 5, 'haber', 5),
    jsonb_build_object('cuenta_id', pg_temp.cuenta('tarjeta'), 'haber', 0))))$$, 'no en los dos', 'A2 una línea va en el debe o en el haber');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] una', 'lineas', jsonb_build_array(jsonb_build_object('cuenta_id', pg_temp.cuenta('bancos'), 'debe', 5))))$$,
  'al menos dos', 'A3 al menos dos líneas');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] negativo', 'lineas', jsonb_build_array(
    jsonb_build_object('cuenta_id', pg_temp.cuenta('bancos'), 'debe', -5),
    jsonb_build_object('cuenta_id', pg_temp.cuenta('tarjeta'), 'haber', -5))))$$, 'negativos', 'A4 sin montos negativos');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.m'), 'fecha', '2020-03-20',
  'concepto', '[prueba] otra tienda', 'lineas', current_setting('t.lin_ok')::jsonb))$$, 'No tienes acceso', 'A5 contabilidad de Galerías no asienta en Multiplaza');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2031-01-01',
  'concepto', '[prueba] futuro', 'lineas', current_setting('t.lin_ok')::jsonb))$$, 'fecha', 'A6 no se asienta en el futuro');
select set_config('t.a1', (public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] Depósito del datáfono', 'lineas', current_setting('t.lin_ok')::jsonb))->>'id'), false);
select pg_temp.ok((select created_by from public.cont_asientos where id = current_setting('t.a1')::uuid) = 'e2000000-0000-0000-0000-000000000005',
                  'A7 el asiento queda firmado por quien lo hizo');
select pg_temp.ok(pg_temp.lado(public.cont_diario(current_setting('t.g')::uuid, '2020-03-20', '2020-03-20'), 'manual', 'tarjeta', 'haber') = 230,
                  'A7b y aparece en el diario');
select pg_temp.como('e2000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-20',
  'concepto', '[prueba] cajera', 'lineas', current_setting('t.lin_ok')::jsonb))$$, 'No tienes acceso', 'A8 la cajera no asienta');
select pg_temp.como('e2000000-0000-0000-0000-000000000004');
select pg_temp.ok((select count(*) from public.cont_asientos where id = current_setting('t.a1')::uuid) = 0
              and (select count(*) from public.cont_asiento_lineas where asiento_id = current_setting('t.a1')::uuid) = 0,
                  'A9 la gerente de Multiplaza no ve los asientos de Galerías');
select pg_temp.falla($$select public.cont_anular_asiento(current_setting('t.a1')::uuid, 'no es mío')$$, 'No tienes acceso', 'A10 ni los anula');
select pg_temp.como('e2000000-0000-0000-0000-000000000003');
select pg_temp.falla($$select public.cont_anular_asiento(current_setting('t.a1')::uuid, '')$$, 'por qué', 'A11 anular pide motivo');
select public.cont_anular_asiento(current_setting('t.a1')::uuid, 'Era del día 21');
select set_config('t.d20', public.cont_diario(current_setting('t.g')::uuid, '2020-03-20', '2020-03-20')::text, false);
select pg_temp.ok(pg_temp.lado(current_setting('t.d20')::jsonb, 'manual', 'tarjeta', 'haber') = 0
              and (current_setting('t.d20')::jsonb->'anulados'->0->>'motivo') = 'Era del día 21',
                  'A12 anulado sale del diario y queda en la lista de anulados con su motivo');
select pg_temp.falla($$select public.cont_anular_asiento(current_setting('t.a1')::uuid, 'otra vez')$$, 'ya está anulado', 'A13 no se anula dos veces');
reset role;
select pg_temp.ok((select count(*) from public.audit_log where table_name = 'cont_asientos' and row_id = current_setting('t.a1')) >= 1,
                  'A14 la anulación queda en el rastro de auditoría');
set role authenticated;

-- ----------------------------------------------------------------------------
-- Balanza
-- ----------------------------------------------------------------------------
select pg_temp.como('e2000000-0000-0000-0000-000000000005');
select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-21',
  'concepto', '[prueba] Depósito del datáfono', 'lineas', current_setting('t.lin_ok')::jsonb));
select set_config('t.bm', public.cont_balanza(current_setting('t.g')::uuid, '2020-03-01', '2020-03-31')::text, false);
select pg_temp.ok((current_setting('t.bm')::jsonb->>'debe')::numeric = (current_setting('t.bm')::jsonb->>'haber')::numeric,
                  'B1 la balanza del mes cuadra');
select pg_temp.ok((select (c->>'final')::numeric from jsonb_array_elements(current_setting('t.bm')::jsonb->'cuentas') c where c->>'codigo' = '1101') = -111.50,
                  'B2 caja: 218.50 de ventas − 50 de faltante − 300 retirados + 20 de sobrante');
select pg_temp.ok((select (c->>'final')::numeric from jsonb_array_elements(current_setting('t.bm')::jsonb->'cuentas') c where c->>'codigo' = '1104') = 0,
                  'B3 la tarjeta por cobrar queda en cero con el depósito del datáfono');
select set_config('t.ba', public.cont_balanza(current_setting('t.g')::uuid, '2020-04-01', '2020-04-30')::text, false);
select pg_temp.ok((select (c->>'anterior')::numeric from jsonb_array_elements(current_setting('t.ba')::jsonb->'cuentas') c where c->>'codigo' = '1101') = -111.50
              and (select (c->>'anterior')::numeric from jsonb_array_elements(current_setting('t.ba')::jsonb->'cuentas') c where c->>'codigo' = '4101') = -549.96,
                  'B4 en abril, el saldo anterior trae lo de marzo');
select set_config('t.bn', public.cont_balanza(current_setting('t.g')::uuid, '2021-01-01', '2021-01-31')::text, false);
select pg_temp.ok((select (c->>'anterior')::numeric from jsonb_array_elements(current_setting('t.bn')::jsonb->'cuentas') c where c->>'codigo' = '1101') = -111.50
              and not exists (select 1 from jsonb_array_elements(current_setting('t.bn')::jsonb->'cuentas') c where c->>'codigo' = '4101'),
                  'B5 en enero las cuentas de resultados arrancan en cero; las de balance siguen');
select pg_temp.falla($$select public.cont_balanza(current_setting('t.g')::uuid, '2020-01-01', '2021-06-30')$$, '1 a 367', 'B6 la balanza tiene tope de días');

-- ----------------------------------------------------------------------------
-- Catálogo de cuentas
-- ----------------------------------------------------------------------------
select pg_temp.como('e2000000-0000-0000-0000-000000000003');
select pg_temp.falla($$select public.cont_guardar_cuenta('{"codigo": "9999", "nombre": "[prueba] x", "tipo": "gasto"}')$$,
                     'propietaria o contabilidad', 'C1 la gerente no cambia el catálogo');
select pg_temp.como('e2000000-0000-0000-0000-000000000006');
select pg_temp.falla(format($$select public.cont_guardar_cuenta('{"id": "%s", "codigo": "1101", "nombre": "Caja general", "tipo": "activo", "activa": false}')$$, pg_temp.cuenta('caja')),
                     'automáticos', 'C2 la cuenta de caja no se apaga: las ventas quedarían sin cuenta');
select pg_temp.falla(format($$select public.cont_guardar_cuenta('{"id": "%s", "codigo": "1101", "nombre": "Caja general", "tipo": "gasto"}')$$, pg_temp.cuenta('caja')),
                     'automáticos', 'C3 ni cambia de tipo');
select public.cont_guardar_cuenta(format('{"id": "%s", "codigo": "110101", "nombre": "Caja de la tienda", "tipo": "activo"}', pg_temp.cuenta('caja'))::jsonb);
select pg_temp.ok(pg_temp.lado(public.cont_diario(current_setting('t.g')::uuid, '2020-03-10', '2020-03-10'), 'ventas', 'caja', 'debe') = 218.50
              and (select codigo from public.cont_cuentas where clave = 'caja') = '110101',
                  'C4 recodificar no rompe los asientos automáticos (van por clave)');
select public.cont_guardar_cuenta(format('{"id": "%s", "codigo": "1101", "nombre": "Caja general", "tipo": "activo"}', pg_temp.cuenta('caja'))::jsonb);
select set_config('t.cn', public.cont_guardar_cuenta('{"codigo": "6999", "nombre": "[prueba] Gasto viejo", "tipo": "gasto"}')::text, false);
select pg_temp.falla($$select public.cont_guardar_cuenta('{"codigo": "6999", "nombre": "[prueba] repetida", "tipo": "gasto"}')$$,
                     'cont_cuentas_codigo_key', 'C5 el código no se repite');
select public.cont_guardar_cuenta(format('{"id": "%s", "codigo": "6999", "nombre": "[prueba] Gasto viejo", "tipo": "gasto", "activa": false}', current_setting('t.cn'))::jsonb);
select pg_temp.como('e2000000-0000-0000-0000-000000000005');
select pg_temp.falla(format($$select public.cont_guardar_asiento(jsonb_build_object('location_id', current_setting('t.g'), 'fecha', '2020-03-22',
  'concepto', '[prueba] inactiva', 'lineas', jsonb_build_array(
    jsonb_build_object('cuenta_id', '%s', 'debe', 5),
    jsonb_build_object('cuenta_id', pg_temp.cuenta('caja'), 'haber', 5))))$$, current_setting('t.cn')), 'inactiva', 'C6 no se asienta en una cuenta apagada');

reset role;
select pg_temp.ok(public.respaldo_tablas() @> array['cont_cuentas', 'cont_config', 'cont_asientos', 'cont_asiento_lineas'],
                  'R1 el respaldo nocturno copia el libro');
select pg_temp.ok((select incluir_gastos from public.cont_config) = false, 'R2 la regla de gastos quedó como estaba');

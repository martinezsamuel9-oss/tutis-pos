-- ============================================================================
--  PRUEBAS: turnos de caja, retiros y arqueo ciego (sql/19)
--  Correr después de 00..19. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

-- Limpieza de una corrida anterior (solo base local).
delete from public.cash_movements where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.cash_sessions  where location_id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
delete from public.sales where customer_name = '[prueba caja]';

insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'ana.caja@tutis.test'),
  ('c0000000-0000-0000-0000-000000000002', 'bea.caja@tutis.test'),
  ('c0000000-0000-0000-0000-000000000003', 'gerente.caja@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active, full_name) values
  ('c0000000-0000-0000-0000-000000000001', 'cajera',  current_setting('t.g')::uuid, true, 'Ana'),
  ('c0000000-0000-0000-0000-000000000002', 'cajera',  current_setting('t.g')::uuid, true, 'Bea'),
  ('c0000000-0000-0000-0000-000000000003', 'gerente', current_setting('t.g')::uuid, true, 'Gaby')
on conflict (id) do update set role = excluded.role, location_id = excluded.location_id, active = true, full_name = excluded.full_name;
insert into public.profiles (id, role, location_id, active) values ('44444444-4444-4444-4444-444444444444', 'gerente', current_setting('t.m')::uuid, true)
on conflict (id) do update set role = 'gerente', location_id = current_setting('t.m')::uuid, active = true;

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
-- Una venta como la registraría process_sale (aquí directa, para controlar la hora).
create or replace function pg_temp.venta(metodo text, total numeric, cuando timestamptz) returns void language sql as $$
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name)
  values (current_setting('t.g')::uuid, gen_random_uuid(),
          (select coalesce(max(folio), 0) + 1 from public.sales where location_id = current_setting('t.g')::uuid),
          cuando, total, metodo, '[prueba caja]');
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated, anon;

-- ------------------------------------------------------------ nadie lee directo
set role authenticated;
select pg_temp.como('c0000000-0000-0000-0000-000000000003');
select pg_temp.falla($$select count(*) from public.cash_sessions$$, 'permission denied', 'K1 ni la gerente lee la tabla de turnos directo');
select pg_temp.falla($$insert into public.cash_movements (session_id, location_id, tipo, monto, motivo) values (gen_random_uuid(), current_setting('t.g')::uuid, 'entrada', 1, 'xxx')$$,
  'permission denied', 'K2 ni escribe movimientos directo');
reset role; set role anon;
select pg_temp.falla($$select public.caja_estado(current_setting('t.g')::uuid)$$, 'permission denied', 'K3 sin usuario no hay caja');
reset role;

-- ------------------------------------------------------------ abrir
set role authenticated;
select pg_temp.como('c0000000-0000-0000-0000-000000000001');
select pg_temp.ok((public.caja_estado(current_setting('t.g')::uuid)->>'abierta')::boolean = false, 'K4 la caja arranca cerrada');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '{"abc": 1}')$$, 'Denominación no válida', 'K5 denominación inventada no entra');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '{"100": -1}')$$, 'Cantidad no válida', 'K6 cantidad negativa no entra');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '{"100": 1.5}')$$, 'Cantidad no válida', 'K7 media pieza no entra');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '[]')$$, 'Falta el conteo', 'K8 sin conteo no se abre');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.m')::uuid, '{"100": 1}')$$, 'No tienes acceso', 'K9 no abre la caja de la otra tienda');
select pg_temp.ok((public.caja_abrir(current_setting('t.g')::uuid, '{"500": 1, "100": 3, "50": 2, "20": 5, "0.50": 0}')->>'fondo')::numeric = 1000,
  'K10 Ana abre con L 1,000 contados billete por billete');
select pg_temp.falla($$select public.caja_abrir(current_setting('t.g')::uuid, '{"100": 1}')$$, 'ya está abierta', 'K11 no se abren dos cajas en la misma tienda');
reset role;
select pg_temp.falla($$insert into public.cash_sessions (location_id, fondo) values (current_setting('t.g')::uuid, 0)$$, 'uq_cash_sessions_abierta',
  'K12 ni por la base directa: una sola caja abierta por tienda');

-- ------------------------------------------------------------ ventas y movimientos
select pg_temp.venta('efectivo', 150, now());
select pg_temp.venta('efectivo', 50.25, now());
select pg_temp.venta('tarjeta', 300, now());
select pg_temp.venta('transferencia', 80, now());
set role authenticated;
select pg_temp.como('c0000000-0000-0000-0000-000000000002');
select pg_temp.ok((public.caja_estado(current_setting('t.g')::uuid)->'turno'->>'abierto_por') = 'Ana'
                  and (public.caja_estado(current_setting('t.g')::uuid)->'turno'->>'es_mio')::boolean = false,
  'K13 Bea ve que la caja la abrió Ana');
select pg_temp.ok(public.caja_estado(current_setting('t.g')::uuid)::text !~* 'esperado|ventas_efectivo|fondo',
  'K14 el estado de la caja no dice cuánto debería haber (arqueo ciego)');
select pg_temp.falla($$select public.caja_movimiento(current_setting('t.g')::uuid, 'retiro', 500, '')$$, 'motivo', 'K15 retiro sin motivo no entra');
select pg_temp.falla($$select public.caja_movimiento(current_setting('t.g')::uuid, 'retiro', -5, 'caja fuerte')$$, 'Monto no válido', 'K16 retiro negativo no entra');
select pg_temp.falla($$select public.caja_movimiento(current_setting('t.g')::uuid, 'regalo', 5, 'caja fuerte')$$, 'Tipo', 'K17 tipo inventado no entra');
select pg_temp.ok(jsonb_array_length(public.caja_movimiento(current_setting('t.g')::uuid, 'retiro', 500, 'A la caja fuerte')->'turno'->'movimientos') = 1,
  'K18 retiro de L 500 a la caja fuerte, con motivo');
select pg_temp.ok(jsonb_array_length(public.caja_movimiento(current_setting('t.g')::uuid, 'entrada', 100, 'Cambio del banco')->'turno'->'movimientos') = 2,
  'K19 entrada de L 100 de cambio');

-- ------------------------------------------------------------ cerrar (entrega de Ana)
-- Esperado: 1000 + 150 + 50.25 + 100 − 500 = 800.25. Ana cuenta 780.25.
select pg_temp.como('c0000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"100": 7}', 800)$$, 'más de lo que contaste', 'K20 no se deja de fondo más de lo contado');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"100": 7}', null)$$, 'fondo', 'K21 hay que decir cuánto queda de fondo');
select set_config('t.cierre', public.caja_cerrar(current_setting('t.g')::uuid,
  '{"500": 1, "100": 2, "50": 1, "20": 1, "10": 1, "0.25": 1}', 700,
  '{"tarjeta": 300, "transferencia": 80}', '{"lote": "000389", "ventas": 1, "monto": 300}')::text, false);
select pg_temp.ok((current_setting('t.cierre')::jsonb->>'esperado')::numeric = 800.25
                  and (current_setting('t.cierre')::jsonb->>'contado')::numeric = 780.25
                  and (current_setting('t.cierre')::jsonb->>'diferencia')::numeric = -20,
  'K22 esperado = fondo + efectivo + entradas − retiros (800.25); contó 780.25: faltan L 20');
select pg_temp.ok((current_setting('t.cierre')::jsonb->>'tarjeta')::numeric = 300 and (current_setting('t.cierre')::jsonb->>'transferencia')::numeric = 80,
  'K23 tarjeta y transferencia van aparte, no cuentan como efectivo');
select pg_temp.falla($$select public.caja_cerrar(current_setting('t.g')::uuid, '{"100": 7}', 0)$$, 'ya está cerrada', 'K24 un cierre guardado no se repite ni se corrige');
select pg_temp.como('c0000000-0000-0000-0000-000000000002');
select pg_temp.falla(format($$select public.caja_explicar(%L, 'fue Ana')$$, current_setting('t.cierre')::jsonb->>'id'), 'Solo quien cerró', 'K25 solo quien cerró explica la diferencia');
select pg_temp.como('c0000000-0000-0000-0000-000000000001');
select public.caja_explicar((current_setting('t.cierre')::jsonb->>'id')::uuid, 'Di mal un vuelto de 20');
select pg_temp.falla(format($$select public.caja_explicar(%L, 'otra cosa')$$, current_setting('t.cierre')::jsonb->>'id'), 'ya se guardó', 'K26 y una sola vez');

-- ------------------------------------------------------------ Bea recibe la caja
select pg_temp.como('c0000000-0000-0000-0000-000000000002');
select set_config('t.ab', public.caja_abrir(current_setting('t.g')::uuid, '{"500": 1, "100": 1, "50": 1}')::text, false);
select pg_temp.ok((current_setting('t.ab')::jsonb->>'fondo_anterior')::numeric = 700 and (current_setting('t.ab')::jsonb->>'diferencia_entrega')::numeric = -50,
  'K27 Ana dejó L 700, Bea contó L 650: la diferencia de entrega (−50) queda anotada');
reset role;
-- Una venta en efectivo de Ana, cobrada sin internet en su turno, sube después.
select pg_temp.venta('efectivo', 40, (select abierto_at from public.cash_sessions where id = (current_setting('t.cierre')::jsonb->>'id')::uuid));
-- Una venta en efectivo de ayer, sin ninguna caja abierta.
select pg_temp.venta('efectivo', 25, now() - interval '1 day');
select set_config('t.f25', (select folio::text from public.sales where customer_name = '[prueba caja]' and total_price = 25), false),
       set_config('t.f150', (select folio::text from public.sales where customer_name = '[prueba caja]' and total_price = 150), false);

-- ------------------------------------------------------------ el reporte de la gerente
set role authenticated;
select pg_temp.como('c0000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.caja_turnos(current_setting('t.g')::uuid, current_date - 3, current_date + 1)$$, 'Solo la gerente', 'K28 la cajera no ve el reporte de turnos');
select pg_temp.falla(format($$select public.caja_revisar(%L, '')$$, current_setting('t.cierre')::jsonb->>'id'), 'Solo la gerente', 'K29 ni revisa cierres');
select pg_temp.como('44444444-4444-4444-4444-444444444444');
select pg_temp.falla($$select public.caja_turnos(current_setting('t.g')::uuid, current_date - 3, current_date + 1)$$, 'Solo la gerente', 'K30 la gerente de la otra tienda tampoco');
select pg_temp.como('c0000000-0000-0000-0000-000000000003');
select set_config('t.rep', public.caja_turnos(current_setting('t.g')::uuid, current_date - 3, current_date + 1)::text, false);
select pg_temp.ok(jsonb_array_length(current_setting('t.rep')::jsonb->'turnos') = 2, 'K31 la gerente ve los 2 turnos');
select pg_temp.ok((select (t->>'esperado_al_cerrar')::numeric = 800.25 and (t->>'esperado')::numeric = 840.25
                          and t->>'explicacion' = 'Di mal un vuelto de 20' and t->>'cerrado_por' = 'Ana'
                     from jsonb_array_elements(current_setting('t.rep')::jsonb->'turnos') t where t->>'id' = current_setting('t.cierre')::jsonb->>'id'),
  'K32 la venta que subió después cambia el esperado, y se ve contra el del cierre (800.25 → 840.25)');
select pg_temp.ok((select (t->>'diferencia_entrega')::numeric = -50 and t->>'cerrado_at' is null
                     from jsonb_array_elements(current_setting('t.rep')::jsonb->'turnos') t where t->>'abierto_por' = 'Bea'),
  'K33 el turno de Bea sigue abierto y muestra la diferencia de entrega');
select pg_temp.ok((current_setting('t.rep')::jsonb->'fuera_de_turno'->'folios') @> to_jsonb(current_setting('t.f25')::int)
                  and not (current_setting('t.rep')::jsonb->'fuera_de_turno'->'folios') @> to_jsonb(current_setting('t.f150')::int),
  'K34 la venta en efectivo sin caja abierta sale como "fuera de turno" (y la del turno no)');
select public.caja_revisar((current_setting('t.cierre')::jsonb->>'id')::uuid, 'Hablado con Ana');
select pg_temp.falla(format($$select public.caja_revisar(%L, '')$$, current_setting('t.cierre')::jsonb->>'id'), 'ya se revisó', 'K35 un cierre se revisa una vez');
select pg_temp.ok((select t->>'revisado_por' = 'Gaby' and t->>'nota_revision' = 'Hablado con Ana'
                     from jsonb_array_elements(public.caja_turnos(current_setting('t.g')::uuid, current_date - 3, current_date + 1)->'turnos') t
                    where t->>'id' = current_setting('t.cierre')::jsonb->>'id'), 'K36 la revisión queda con nombre y nota');
select pg_temp.falla($$select public.caja_turnos(current_setting('t.g')::uuid, current_date - 200, current_date)$$, 'Periodo no válido', 'K37 el reporte pide hasta 3 meses');
reset role;

select pg_temp.ok('cash_sessions' = any(public.respaldo_tablas()) and 'cash_movements' = any(public.respaldo_tablas()), 'K38 el respaldo nocturno incluye la caja');

-- ------------------------------------------------------------ limpieza
delete from public.cash_movements where location_id = current_setting('t.g')::uuid;
delete from public.cash_sessions  where location_id = current_setting('t.g')::uuid;
delete from public.sales where customer_name = '[prueba caja]';
select 'prueba_caja: todo bien' as resultado;

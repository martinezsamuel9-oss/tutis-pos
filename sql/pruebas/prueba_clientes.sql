-- ============================================================================
--  PRUEBAS: módulo de clientes (sql/22). El teléfono es la llave, la ficha
--  completa, las categorías, las cifras por tienda y los cumpleaños.
--  Correr después de 00..22. Se puede repetir sobre la misma base.
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

delete from public.sales where customer_name = '[prueba clientes]';
delete from public.customers where full_name like '[prueba clientes]%';
update public.clientes_config set vip_monto_90d = 1500, vip_visitas_90d = 8, frecuente_visitas_90d = 3,
  nuevo_dias = 30, inactivo_dias = 45, aviso_cumple_dias = 7;

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-000000000001', 'caja.g.clientes@tutis.test'),
  ('e0000000-0000-0000-0000-000000000002', 'gerente.g.clientes@tutis.test'),
  ('e0000000-0000-0000-0000-000000000003', 'gerente.m.clientes@tutis.test'),
  ('e0000000-0000-0000-0000-000000000004', 'conta.clientes@tutis.test'),
  ('e0000000-0000-0000-0000-000000000005', 'duena.clientes@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, todas_tiendas, active, full_name) values
  ('e0000000-0000-0000-0000-000000000001', 'cajera',       current_setting('t.g')::uuid, false, true, 'Caja G'),
  ('e0000000-0000-0000-0000-000000000002', 'gerente',      current_setting('t.g')::uuid, false, true, 'Gerente G'),
  ('e0000000-0000-0000-0000-000000000003', 'gerente',      current_setting('t.m')::uuid, false, true, 'Gerente M'),
  ('e0000000-0000-0000-0000-000000000004', 'contabilidad', null, true, true, 'Conta'),
  ('e0000000-0000-0000-0000-000000000005', 'propietario',  null, false, true, 'Dueña')
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
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated, anon;

-- Una venta de un cliente, hace d días, en la tienda t (como el servidor).
create or replace function pg_temp.venta(cli uuid, tienda text, total numeric, dias int, producto text default 'Agua') returns void language plpgsql as $$
declare v uuid;
begin
  insert into public.sales (location_id, client_uuid, folio, created_at, total_price, payment_method, customer_name, customer_id)
  values (current_setting(tienda)::uuid, gen_random_uuid(),
          (select coalesce(max(folio), 0) + 1 from public.sales where location_id = current_setting(tienda)::uuid),
          now() - make_interval(days => dias), total, 'efectivo', '[prueba clientes]', cli)
  returning id into v;
  insert into public.sale_lines (sale_id, location_id, item_type, name, price_contribution, quantity)
  values (v, current_setting(tienda)::uuid, 'producto', producto, total, 1);
end $$;

-- ============================================================ LA LLAVE ES EL TELÉFONO
select pg_temp.ok(public.telefono_clave('+504 9988-1234') = '99881234'
              and public.telefono_clave('50499881234') = '99881234'
              and public.telefono_clave('9988 1234') = '99881234', 'L1 el mismo teléfono escrito de tres formas da la misma llave');

set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000001');
select set_config('t.c1', (public.clientes_inscribir(jsonb_build_object(
  'nombre', '[prueba clientes] Valeria', 'telefono', '+504 9911-0001', 'cumpleanos', (current_date - interval '25 years' + interval '3 days')::date,
  'sexo', 'f', 'identidad', '0801-1999-00001', 'observaciones', 'Sin lactosa'))->>'id'), false);
select pg_temp.ok((select phone = '99110001' and sexo = 'F' and observaciones = 'Sin lactosa' from public.customers where id = current_setting('t.c1')::uuid),
  'L2 la cajera inscribe con la ficha completa; el teléfono queda solo en dígitos');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Otra","telefono":"504 99110001"}')$$,
  'Ya hay un cliente con ese teléfono', 'L3 el mismo teléfono en otro formato no se duplica');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Sin tel"}')$$,
  'teléfono', 'L4 sin teléfono no se inscribe');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Corto","telefono":"1234"}')$$,
  'teléfono', 'L5 un teléfono de 4 dígitos no se acepta');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Dup","telefono":"99110002","identidad":"0801199900001"}')$$,
  'identidad', 'L6 la misma identidad (con o sin guiones) no se repite');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Sx","telefono":"99110003","sexo":"X"}')$$,
  'Sexo', 'L7 sexo fuera de F/M/O se rechaza');
select pg_temp.falla($$select public.clientes_inscribir(jsonb_build_object('nombre','[prueba clientes] Fut','telefono','99110004','cumpleanos', current_date + 5))$$,
  'cumpleaños', 'L8 un cumpleaños en el futuro se rechaza');
select pg_temp.falla($$select public.clientes_inscribir(jsonb_build_object('nombre','[prueba clientes] Obs','telefono','99110005','observaciones', repeat('x', 501)))$$,
  'observaciones', 'L9 observaciones de más de 500 caracteres se rechazan');
select pg_temp.ok((select count(*) from public.customers where full_name like '[prueba clientes]%') = 1,
  'L10 ninguno de los rechazados quedó a medias');
-- La función vieja (pantallas en caché) aplica las mismas reglas.
select pg_temp.falla($$select public.loyalty_registrar('[prueba clientes] Vieja', '9911-0001')$$,
  'Ya hay un cliente con ese teléfono', 'L11 loyalty_registrar también respeta la llave');
select pg_temp.falla($$select public.loyalty_registrar('[prueba clientes] Vieja', null)$$,
  'teléfono', 'L12 y también exige teléfono');
reset role;
select pg_temp.falla($$insert into public.customers (card_code, full_name, phone) values ('PRUEBACLI9', '[prueba clientes] Directo', '12')$$,
  'customers_telefono_chk', 'L13 la tabla misma no acepta un teléfono inválido');

-- ============================================================ BUSCAR EN LA CAJA
set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000001');
select pg_temp.ok((select (x->>'exacto')::boolean and x->>'id' = current_setting('t.c1') and x->>'observaciones' = 'Sin lactosa'
                     and (x->>'dias_para_cumple')::int = 3 and x->>'categoria' = 'sin_compras'
                     and not (x ? 'identidad')
                     from jsonb_array_elements(public.loyalty_buscar('+504 9911 0001')) x limit 1),
  'B1 la caja la encuentra por teléfono en cualquier formato, con observaciones, cumpleaños y categoría, SIN identidad');
select pg_temp.ok(jsonb_array_length(public.loyalty_buscar('0001')) >= 1, 'B2 y por los últimos dígitos');
reset role;
insert into auth.users (id, email) values ('e0000000-0000-0000-0000-000000000006', 'ops.clientes@tutis.test') on conflict do nothing;
insert into public.profiles (id, role, location_id, active, full_name)
values ('e0000000-0000-0000-0000-000000000006', 'operaciones', current_setting('t.g')::uuid, true, 'Ops')
on conflict (id) do update set role = 'operaciones', location_id = excluded.location_id, active = true;
set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000006');
select pg_temp.falla($$select public.loyalty_buscar('99110001')$$, 'no busca clientes', 'B3 operaciones no busca clientes');
select pg_temp.falla($$select public.clientes_inscribir('{"nombre":"[prueba clientes] Ops","telefono":"99110009"}')$$,
  'no inscribe', 'B4 ni los inscribe');

-- ============================================================ CIFRAS Y CATEGORÍAS
reset role; reset request.jwt.claim.sub; reset request.jwt.claims;
insert into public.customers (card_code, full_name, phone, created_at) values
  ('PRUEBACLI2', '[prueba clientes] Vip',       '99110010', now() - interval '200 days'),
  ('PRUEBACLI3', '[prueba clientes] Frecuente', '99110011', now() - interval '200 days'),
  ('PRUEBACLI4', '[prueba clientes] Inactiva',  '99110012', now() - interval '200 days'),
  ('PRUEBACLI5', '[prueba clientes] Nueva',     '99110013', now() - interval '5 days'),
  ('PRUEBACLI6', '[prueba clientes] Ocasional', '99110014', now() - interval '200 days');
select set_config('t.vip', (select id::text from customers where card_code = 'PRUEBACLI2'), false),
       set_config('t.fre', (select id::text from customers where card_code = 'PRUEBACLI3'), false),
       set_config('t.ina', (select id::text from customers where card_code = 'PRUEBACLI4'), false),
       set_config('t.nue', (select id::text from customers where card_code = 'PRUEBACLI5'), false),
       set_config('t.oca', (select id::text from customers where card_code = 'PRUEBACLI6'), false);
-- Vip: L 1,000 en Galerías y L 600 en Multiplaza en 90 días (solo cuenta como
-- VIP si se suman las dos tiendas).
select pg_temp.venta(current_setting('t.vip')::uuid, 't.g', 400, 50, 'Shake');
select pg_temp.venta(current_setting('t.vip')::uuid, 't.g', 600, 10, 'Shake');
select pg_temp.venta(current_setting('t.vip')::uuid, 't.m', 600, 2, 'Agua');
-- Frecuente: 3 visitas chicas en 90 días.
select pg_temp.venta(current_setting('t.fre')::uuid, 't.g', 80, 30);
select pg_temp.venta(current_setting('t.fre')::uuid, 't.g', 80, 20);
select pg_temp.venta(current_setting('t.fre')::uuid, 't.g', 80, 10);
-- Inactiva: la última vez fue hace 60 días.
select pg_temp.venta(current_setting('t.ina')::uuid, 't.g', 900, 120);
select pg_temp.venta(current_setting('t.ina')::uuid, 't.g', 900, 60);
-- Nueva: primera visita hace 4 días.
select pg_temp.venta(current_setting('t.nue')::uuid, 't.g', 100, 4);
-- Ocasional: una visita hace 100 días y otra hace 20.
select pg_temp.venta(current_setting('t.oca')::uuid, 't.g', 100, 100);
select pg_temp.venta(current_setting('t.oca')::uuid, 't.g', 100, 20);

select pg_temp.ok(public.cliente_categoria(current_setting('t.vip')::uuid) = 'vip', 'K1 VIP por monto de 90 días sumando las dos tiendas');
select pg_temp.ok(public.cliente_categoria(current_setting('t.fre')::uuid) = 'frecuente', 'K2 frecuente: 3 visitas en 90 días');
select pg_temp.ok(public.cliente_categoria(current_setting('t.ina')::uuid) = 'inactivo', 'K3 inactivo: más de 45 días sin venir, aunque gastaba mucho');
select pg_temp.ok(public.cliente_categoria(current_setting('t.nue')::uuid) = 'nuevo', 'K4 nuevo: primera visita hace menos de 30 días');
select pg_temp.ok(public.cliente_categoria(current_setting('t.oca')::uuid) = 'ocasional', 'K5 ocasional: lo demás');
update public.clientes_config set frecuente_visitas_90d = 1;
select pg_temp.ok(public.cliente_categoria(current_setting('t.oca')::uuid) = 'frecuente', 'K6 las reglas viven en la base: con la regla en 1 visita ya es frecuente');
update public.clientes_config set frecuente_visitas_90d = 3;

set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000002');   -- gerente de Galerías
select set_config('t.r', public.clientes_resumen(null)::text, false);
select pg_temp.ok((select (x->>'total')::numeric = 1000 and (x->>'visitas')::int = 2 and (x->>'ticket_promedio')::numeric = 500
                          and x->>'categoria' = 'vip'
                     from jsonb_array_elements(current_setting('t.r')::jsonb) x where x->>'id' = current_setting('t.vip')),
  'K7 la gerente de Galerías ve SOLO lo gastado en Galerías (1,000 en 2 visitas, ticket 500), pero la categoría es de la marca');
select pg_temp.ok((select (x->>'cada_cuantos_dias')::numeric = 10 and (x->>'dias_sin_venir')::int between 9 and 11
                     from jsonb_array_elements(current_setting('t.r')::jsonb) x where x->>'id' = current_setting('t.fre')),
  'K8 viene cada 10 días y hace 10 que no viene');
select pg_temp.ok((select x->>'identidad' = '0801-1999-00001' from jsonb_array_elements(current_setting('t.r')::jsonb) x
                    where x->>'id' = current_setting('t.c1')), 'K9 la gerente sí ve la identidad en el módulo');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.cliente_detalle(current_setting('t.vip')::uuid)->'ultimas')) = 2
              and (select x->>'nombre' = 'Shake' and (x->>'veces')::int = 2
                     from jsonb_array_elements(public.cliente_detalle(current_setting('t.vip')::uuid)->'consumo') x limit 1),
  'K10 el detalle trae sus visitas y lo que consume, solo de su tienda');
select pg_temp.falla($$select public.clientes_resumen(current_setting('t.m')::uuid)$$, 'No tienes acceso', 'K11 no puede pedir las cifras de Multiplaza');
select pg_temp.falla($$select public.cliente_detalle(current_setting('t.vip')::uuid, current_setting('t.m')::uuid)$$, 'No tienes acceso', 'K12 ni el detalle de Multiplaza');

select pg_temp.como('e0000000-0000-0000-0000-000000000005');   -- propietaria
select pg_temp.ok((select (x->>'total')::numeric = 1600 and (x->>'visitas')::int = 3
                     from jsonb_array_elements(public.clientes_resumen(null)) x where x->>'id' = current_setting('t.vip')),
  'K13 la propietaria ve las dos tiendas sumadas');
select pg_temp.ok((select (x->>'total')::numeric = 600 from jsonb_array_elements(public.clientes_resumen(current_setting('t.m')::uuid)) x
                    where x->>'id' = current_setting('t.vip')), 'K14 y una tienda sola si la elige');

select pg_temp.como('e0000000-0000-0000-0000-000000000001');   -- cajera
select pg_temp.falla($$select public.clientes_resumen(null)$$, 'Solo la gerente', 'K15 la cajera no ve el módulo');
select pg_temp.como('e0000000-0000-0000-0000-000000000004');   -- contabilidad
select pg_temp.falla($$select public.clientes_resumen(null)$$, 'Solo la gerente', 'K16 contabilidad tampoco (datos personales)');
select pg_temp.como('e0000000-0000-0000-0000-000000000002');
with u as (update public.clientes_config set vip_monto_90d = 1 returning 1)
select pg_temp.ok(count(*) = 0, 'K17 la gerente no cambia las reglas de las categorías') from u;
select pg_temp.como('e0000000-0000-0000-0000-000000000005');
with u as (update public.clientes_config set vip_monto_90d = 2000 returning 1)
select pg_temp.ok(count(*) = 1, 'K18 la propietaria sí') from u;
reset role;
update public.clientes_config set vip_monto_90d = 1500;

-- ============================================================ CUMPLEAÑOS
select pg_temp.ok(public.dias_para_cumple(date '2000-02-29', date '2027-02-27') = 1, 'C1 el 29 de febrero se celebra el 28 en años no bisiestos');
select pg_temp.ok(public.dias_para_cumple(date '1990-12-31', date '2026-12-31') = 0, 'C2 hoy es 0');
select pg_temp.ok(public.dias_para_cumple(date '1990-01-01', date '2026-12-31') = 1, 'C3 y pasa al año siguiente');
set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000002');
select pg_temp.ok((select (x->>'dias')::int = 3 and (x->>'cumple')::int = 25 from jsonb_array_elements(public.clientes_cumpleanos(null)) x
                    where x->>'id' = current_setting('t.c1')), 'C4 el aviso trae a Valeria: cumple 25 en 3 días');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.clientes_cumpleanos(2)) x where x->>'id' = current_setting('t.c1')),
  'C5 y no sale si se piden solo 2 días');
select pg_temp.como('e0000000-0000-0000-0000-000000000001');
select pg_temp.falla($$select public.clientes_cumpleanos(7)$$, 'Solo la gerente', 'C6 la cajera no saca la lista de cumpleaños');
reset role;

-- ============================================================ CAMBIAR DE NÚMERO
set role authenticated;
select pg_temp.como('e0000000-0000-0000-0000-000000000002');
update public.customers set phone = '9911-0099' where id = current_setting('t.c1')::uuid;
reset role;
select pg_temp.ok((select telefono_clave = '99110099' and card_code is not null from public.customers where id = current_setting('t.c1')::uuid),
  'N1 si cambia de número conserva su id, su carnet y su historial (la llave se recalcula sola)');
select pg_temp.falla($$update public.customers set phone = '99110010' where id = current_setting('t.c1')::uuid$$,
  'uq_customers_telefono', 'N2 pero no puede tomar el número de otro cliente');

\echo '=== prueba_clientes: terminada ==='

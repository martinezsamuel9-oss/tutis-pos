-- ============================================================================
--  PRUEBAS: ubicación y horario de las tiendas para la app (sql/18)
--  Correr después de 00..18. Se puede repetir; al final deja las tiendas
--  sin horario ni ubicación, como estaban (así prueba_app.sql sigue igual).
-- ============================================================================
\set ON_ERROR_STOP on

delete from public.pedidos_app where customer_id in (select id from public.customers where full_name like '[prueba mapa]%');
delete from public.customers where full_name like '[prueba mapa]%';
delete from auth.users where id = '99999999-9999-9999-9999-999999999999';

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

insert into auth.users (id, email, raw_app_meta_data) values
  ('99999999-9999-9999-9999-999999999999', 'mapa@privaterelay.appleid.com', '{"provider":"apple"}');
insert into public.customers (card_code, full_name, phone, auth_user_id)
values ('PRUEBAMAPA', '[prueba mapa] Clienta', '50411223344', '99999999-9999-9999-9999-999999999999');

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

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
-- Motivo para una hora pedida en un instante fijo (no depende del reloj).
create or replace function pg_temp.motivo(hora text, ts text) returns text language sql as $$
  select public.motivo_hora_no_valida(current_setting('t.g')::uuid, hora, ts::timestamptz);
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.falla(text, text, text), pg_temp.como(text) to authenticated, anon;

-- ------------------------------------------------------------ el horario se valida
select pg_temp.ok(public.horario_valido(null) and public.horario_valido('{}')
  and public.horario_valido('{"lun":{"abre":"10:00","cierra":"21:00"},"dom":null}'), 'M1 horario bien formado (o vacío) se acepta');
select pg_temp.ok(not public.horario_valido('{"lunes":{"abre":"10:00","cierra":"21:00"}}'), 'M2 día con nombre desconocido se rechaza');
select pg_temp.ok(not public.horario_valido('{"lun":{"abre":"10","cierra":"21:00"}}')
  and not public.horario_valido('{"lun":{"abre":"24:00","cierra":"21:00"}}'), 'M3 hora mal escrita se rechaza');
select pg_temp.ok(not public.horario_valido('{"lun":{"abre":"21:00","cierra":"10:00"}}'), 'M4 cerrar antes de abrir se rechaza');
select pg_temp.ok(not public.horario_valido('{"lun":{"abre":"10:00","cierra":"21:00","x":"<script>"}}')
  and not public.horario_valido('[]'), 'M5 nada extra dentro del horario');

select pg_temp.falla($$update public.locations set latitud = 15.5 where id = current_setting('t.g')::uuid$$, 'coordenadas', 'M6 latitud sin longitud no entra');
select pg_temp.falla($$update public.locations set latitud = 0, longitud = 0 where id = current_setting('t.g')::uuid$$, 'coordenadas', 'M7 el 0,0 (dato vacío disfrazado) no entra');
select pg_temp.falla($$update public.locations set latitud = 95, longitud = -87 where id = current_setting('t.g')::uuid$$, 'coordenadas', 'M8 latitud fuera de rango no entra');
select pg_temp.falla($$update public.locations set telefono = 'llámame' where id = current_setting('t.g')::uuid$$, 'telefono', 'M9 teléfono con letras no entra');
select pg_temp.falla($$update public.locations set app_minutos = 0 where id = current_setting('t.g')::uuid$$, 'app_minutos', 'M10 preparación de 0 minutos no entra');

-- ------------------------------------------------------------ quién lo cambia
set role authenticated;
select pg_temp.como('44444444-4444-4444-4444-444444444444');
with u as (update public.locations set latitud = 14.1, longitud = -87.2, telefono = '+504 2200-0000'
           where id = current_setting('t.m')::uuid returning 1)
select pg_temp.ok((select count(*) from u) = 1, 'M11 la gerente pone la ubicación de SU tienda');
with u as (update public.locations set latitud = 1, longitud = 1 where id = current_setting('t.g')::uuid returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'M12 pero no la de la otra tienda');
select pg_temp.como('33333333-3333-3333-3333-333333333333');
with u as (update public.locations set horario = '{}' where id = current_setting('t.g')::uuid returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'M13 la cajera no cambia el horario');
select pg_temp.como('11111111-1111-1111-1111-111111111111');
with u as (update public.locations set latitud = 15.5, longitud = -88.02, app_minutos = 15,
             horario = '{"lun":{"abre":"10:00","cierra":"21:00"},"mar":null,"mie":{"abre":"10:00","cierra":"21:00"},
                         "jue":{"abre":"10:00","cierra":"21:00"},"vie":{"abre":"10:00","cierra":"22:00"},
                         "sab":{"abre":"10:00","cierra":"22:00"}}'
           where id = current_setting('t.g')::uuid returning 1)
select pg_temp.ok((select count(*) from u) = 1, 'M14 la propietaria pone ubicación y horario a cualquiera');
reset role;

-- ------------------------------------------------------------ el menú público
set role anon;
select pg_temp.ok((select t->>'lat' = '15.500000' and t->>'lng' = '-88.020000' and t->'horario'->'lun'->>'abre' = '10:00'
                          and t->>'zona' = 'America/Tegucigalpa' and (t->>'minutos')::int = 15
                     from jsonb_array_elements(public.app_menu()->'tiendas') t where t->>'id' = current_setting('t.g')),
  'M15 el menú público trae ubicación, horario, zona y minutos de la tienda');
select pg_temp.ok((select t->>'telefono' = '+504 2200-0000' from jsonb_array_elements(public.app_menu()->'tiendas') t where t->>'id' = current_setting('t.m')),
  'M16 y el teléfono');
select pg_temp.falla($$select public.motivo_hora_no_valida(current_setting('t.g')::uuid, 'ya', now())$$, 'permission denied', 'M17 las funciones internas del horario no se llaman desde fuera');
reset role;

-- ------------------------------------------------------------ abierta o cerrada (instantes fijos)
-- 2026-10-19 es lunes; Honduras va en UTC-6 todo el año.
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-19 15:00-06') is null, 'M18 lunes 3 pm: abierta, se puede pedir ya');
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-19 09:00-06') = 'La tienda abre a las 10:00', 'M19 lunes 9 am: todavía no abre');
select pg_temp.ok(pg_temp.motivo('10:30', '2026-10-19 09:00-06') is null, 'M20 lunes 9 am: sí se puede programar para las 10:30');
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-19 20:50-06') = 'La tienda ya cerró por hoy', 'M21 lunes 8:50 pm: ya no da tiempo antes de cerrar');
select pg_temp.ok(pg_temp.motivo('22:00', '2026-10-19 15:00-06') like 'Hoy la tienda abre de 10:00 a 21:00', 'M22 hora fuera del horario del día');
select pg_temp.ok(pg_temp.motivo('15:05', '2026-10-19 15:00-06') like 'Esa hora ya pasó%', 'M23 no da tiempo de prepararlo para dentro de 5 min');
select pg_temp.ok(pg_temp.motivo('15:15', '2026-10-19 15:00-06') is null, 'M24 dentro de 15 min sí');
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-20 12:00-06') = 'La tienda no abre hoy', 'M25 martes (null): no abre');
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-25 12:00-06') = 'La tienda no abre hoy', 'M26 domingo (no está): no abre');
select pg_temp.ok(pg_temp.motivo('ya', '2026-10-20 02:00+00') is null,
  'M27 se usa la hora LOCAL: martes 2 am UTC es lunes 8 pm en la tienda, y está abierta');
select pg_temp.ok(pg_temp.motivo('21:30', '2026-10-23 15:00-06') is null, 'M28 el viernes cierra más tarde (22:00)');

-- ------------------------------------------------------------ el pedido respeta el horario
set role authenticated;
select pg_temp.como('99999999-9999-9999-9999-999999999999');
reset role;
update public.locations set horario = '{}' where id = current_setting('t.g')::uuid;
set role authenticated;
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'hora', 'ya',
  'items', jsonb_build_array(jsonb_build_object('tipo', 'taza', 'tamano', 'md', 'sabores', jsonb_build_array('Vainilla')))))$$,
  'no abre hoy', 'M29 con la tienda cerrada, el pedido se rechaza');
select pg_temp.falla($$select public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'hora', '29:00',
  'items', jsonb_build_array(jsonb_build_object('tipo', 'taza', 'tamano', 'md', 'sabores', jsonb_build_array('Vainilla')))))$$,
  'Hora no válida', 'M30 una hora imposible (29:00) se rechaza');
reset role;
update public.locations set app_minutos = 5, horario = (select jsonb_object_agg(d, '{"abre":"00:00","cierra":"23:59"}'::jsonb)
  from unnest(array['lun','mar','mie','jue','vie','sab','dom']) d) where id = current_setting('t.g')::uuid;
set role authenticated;
select pg_temp.ok((public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.g'), 'hora', 'ya',
  'items', jsonb_build_array(jsonb_build_object('tipo', 'taza', 'tamano', 'md', 'sabores', jsonb_build_array('Vainilla'))))))->>'estado' = 'recibido',
  'M31 con la tienda abierta, el pedido entra (falla solo si se corre entre 11:54 y 11:59 pm)');
reset role;
update public.locations set horario = null where id = current_setting('t.m')::uuid;
set role authenticated;
select pg_temp.ok((public.app_crear_pedido(jsonb_build_object('tienda', current_setting('t.m'), 'hora', '03:00',
  'items', jsonb_build_array(jsonb_build_object('tipo', 'taza', 'tamano', 'md', 'sabores', jsonb_build_array('Vainilla'))))))->>'estado' = 'recibido',
  'M32 sin horario puesto no se valida la hora (como antes de sql/18)');
reset role;

-- ------------------------------------------------------------ limpieza
delete from public.pedidos_app where customer_id in (select id from public.customers where full_name like '[prueba mapa]%');
delete from public.customers where full_name like '[prueba mapa]%';
delete from auth.users where id = '99999999-9999-9999-9999-999999999999';
update public.locations set latitud = null, longitud = null, horario = null, telefono = null, app_minutos = 15
 where id in (current_setting('t.g')::uuid, current_setting('t.m')::uuid);
select 'prueba_mapa: todo bien' as resultado;

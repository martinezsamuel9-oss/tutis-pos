-- ============================================================================
--  PRUEBAS: el peso lo pone la báscula, y teclearlo pide el PIN de la gerente
--  Correr después de 00..10. Se puede repetir sobre la misma base.
--
--  Cada prueba que falla DETIENE el archivo con "FALLA ...". Si llega al
--  final, imprime "TODAS LAS PRUEBAS DE PESO PASARON".
-- ============================================================================
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'propietario@tutis.test'),
  ('22222222-2222-2222-2222-222222222222', 'gerente.galerias@tutis.test'),
  ('33333333-3333-3333-3333-333333333333', 'cajera.galerias@tutis.test'),
  ('44444444-4444-4444-4444-444444444444', 'gerente.multiplaza@tutis.test'),
  ('55555555-5555-5555-5555-555555555555', 'cajera.multiplaza@tutis.test')
on conflict (id) do nothing;
insert into public.profiles (id, role, location_id, active)
select id, 'cajera', null, true from auth.users on conflict (id) do nothing;

update public.profiles set role='propietario', location_id=null, full_name='Dueña', active=true
  where id='11111111-1111-1111-1111-111111111111';
update public.profiles set role='gerente', full_name='Gerente Galerías', active=true,
  location_id=(select id from locations where name='Tuti''s Galerías')
  where id='22222222-2222-2222-2222-222222222222';
update public.profiles set role='cajera', full_name='Cajera Galerías', active=true,
  location_id=(select id from locations where name='Tuti''s Galerías')
  where id='33333333-3333-3333-3333-333333333333';
update public.profiles set role='gerente', full_name='Gerente Multiplaza', active=true,
  location_id=(select id from locations where name='Tuti''s Multiplaza')
  where id='44444444-4444-4444-4444-444444444444';
update public.profiles set role='cajera', full_name='Cajera Multiplaza', active=true,
  location_id=(select id from locations where name='Tuti''s Multiplaza')
  where id='55555555-5555-5555-5555-555555555555';

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);

-- Limpieza de corridas anteriores (los intentos fallidos bloquearían las
-- pruebas de PIN durante 15 minutos).
delete from privado.pin_attempts;
delete from privado.manager_pins;

create or replace function pg_temp.ok(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALLA %', msg; end if;
  raise notice '[ OK ] %', msg;
end $$;

-- Que una llamada falle con un mensaje que contenga `espera`.
create or replace function pg_temp.falla(sql text, espera text, msg text) returns void
language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if position(lower(espera) in lower(sqlerrm)) > 0 then
      raise notice '[ OK ] % (%)', msg, sqlerrm; return;
    end if;
    raise exception 'FALLA % — error inesperado: %', msg, sqlerrm;
  end;
  raise exception 'FALLA % — debió rechazarse y pasó', msg;
end $$;

-- Una venta de Galerías: vaso 15 g + helado 150 g + topping 30 g = 195 g.
create or replace function pg_temp.venta(p_extra jsonb, p_helado numeric default 150, p_loc text default 't.g')
returns jsonb language plpgsql as $$
begin
  return public.process_sale(jsonb_build_object(
    'location_id', current_setting(p_loc)::uuid, 'client_uuid', gen_random_uuid(),
    'lines', jsonb_build_array(
      jsonb_build_object('item_type','vaso','name','Vaso','weight_g',15,'cost',2,'price_contribution',0),
      jsonb_build_object('item_type','helado','name','Yogurt','weight_g',p_helado,'cost',4.5,'price_contribution',67.5),
      jsonb_build_object('item_type','topping','name','Oreo','weight_g',30,'cost',1.4,'price_contribution',13.5))
  ) || p_extra);
end $$;

\echo '=== PIN: quién puede tenerlo y cuál se acepta ==='
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.falla($$select public.set_manager_pin('4829')$$, 'Solo una gerente', 'B1 la cajera no puede ponerse PIN');
select pg_temp.falla($$select * from privado.manager_pins$$, 'permission denied', 'B2 la cajera no puede leer los PIN');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.falla($$select public.set_manager_pin('1234')$$, 'fácil', 'B3 se rechaza 1234');
select pg_temp.falla($$select public.set_manager_pin('7777')$$, 'fácil', 'B3b se rechaza 7777');
select pg_temp.falla($$select public.set_manager_pin('12ab')$$, '4 a 8', 'B3c se rechaza un PIN con letras');
select public.set_manager_pin('4829');
select pg_temp.ok(public.tengo_pin(), 'B4 la gerente de Galerías ya tiene PIN');
select pg_temp.falla($$select pin_hash from privado.manager_pins$$, 'permission denied', 'B4b ni la propia gerente lee su hash');

set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select public.set_manager_pin('5173');
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.set_manager_pin('90210');
reset role; reset request.jwt.claim.sub;

select pg_temp.ok((select pin_hash not like '%4829%' and pin_hash like '$2a$%' from privado.manager_pins
                    where profile_id = '22222222-2222-2222-2222-222222222222'),
                  'B5 el PIN se guarda con bcrypt, no en claro');

\echo '=== Quién aparece para autorizar ==='
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok((select array_agg(full_name order by full_name) from public.gerentes_para_autorizar(current_setting('t.g')::uuid))
                  = array['Dueña', 'Gerente Galerías'],
                  'B6 en Galerías aparecen su gerente y la dueña, no la de Multiplaza');
select pg_temp.ok((select count(*) from public.gerentes_para_autorizar(current_setting('t.m')::uuid)) = 0,
                  'B6b la cajera de Galerías no puede listar a las de Multiplaza');

\echo '=== Autorizar ==='
select pg_temp.ok((public.autorizar_peso_manual(current_setting('t.g')::uuid, '22222222-2222-2222-2222-222222222222',
                   '0000', 180, 'Báscula sin conexión')->>'ok')::boolean = false,
                  'B7 un PIN equivocado no autoriza');
select pg_temp.ok((public.autorizar_peso_manual(current_setting('t.g')::uuid, '44444444-4444-4444-4444-444444444444',
                   '5173', 180, 'Báscula sin conexión')->>'ok')::boolean = false,
                  'B8 la gerente de OTRA tienda no autoriza aquí, aunque su PIN sea correcto');
select set_config('t.auth', public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 180, 'Báscula sin conexión')->>'id', false);
select pg_temp.ok(current_setting('t.auth') <> '', 'B9 el PIN correcto devuelve una autorización');
select pg_temp.falla($$select public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 180, '')$$, 'motivo', 'B9b sin motivo no se autoriza');
select pg_temp.falla($$select public.autorizar_peso_manual(current_setting('t.m')::uuid,
                  '44444444-4444-4444-4444-444444444444', '5173', 180, 'x x x')$$, 'permiso', 'B9c la cajera no pide autorizaciones en otra tienda');
select pg_temp.ok((select count(*) from public.weight_authorizations) = 0,
                  'B10 la cajera no ve las autorizaciones');
select pg_temp.falla($$insert into public.weight_authorizations (location_id, weight_g, reason)
                       values (current_setting('t.g')::uuid, 999, 'inventada')$$,
                     'permission denied', 'B11 la cajera no puede fabricarse una autorización');
reset role; reset request.jwt.claim.sub;
select pg_temp.ok((select failed from (select count(*) filter (where not ok) as failed from privado.pin_attempts) x) = 2,
                  'B12 los dos intentos fallidos quedaron anotados (la excepción no los borró)');

\echo '=== Clasificación de cada venta ==='
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok(pg_temp.venta('{"weight_mode":"bascula","scale_gross_g":195,"scale_log":[{"g":165},{"g":195}]}')->>'weight_source' = 'bascula',
                  'C1 venta pesada en báscula y que cuadra → bascula');
select pg_temp.ok(pg_temp.venta('{"weight_mode":"bascula","scale_gross_g":260,"scale_log":[{"g":165},{"g":260}]}')->>'weight_source' = 'bascula_no_cuadra',
                  'C2 la báscula marcó 260 g y las líneas suman 195 → bascula_no_cuadra');
select pg_temp.ok(pg_temp.venta('{"weight_mode":"bascula","scale_gross_g":195}')->>'weight_source' = 'sin_dato',
                  'C3 dice báscula pero no trae la lectura → sin_dato');
select pg_temp.ok(pg_temp.venta('{}')->>'weight_source' = 'sin_dato',
                  'C4 venta de una caja vieja, sin modo de peso → sin_dato (entra igual)');
select pg_temp.ok(pg_temp.venta('{"weight_mode":"bascula"}', 0)->>'weight_source' in ('sin_dato'),
                  'C4b con topping pesado y sin lectura sigue siendo sin_dato');

select set_config('t.v1', (pg_temp.venta(jsonb_build_object('weight_mode','manual','weight_auth_id',current_setting('t.auth'))))::text, false);
select pg_temp.ok(current_setting('t.v1')::jsonb->>'weight_source' = 'manual_autorizado',
                  'C5 peso tecleado con autorización válida → manual_autorizado');
select pg_temp.ok(pg_temp.venta(jsonb_build_object('weight_mode','manual','weight_auth_id',current_setting('t.auth')))->>'weight_source' = 'manual_sin_autorizar',
                  'C6 la MISMA autorización no sirve para una segunda venta');

select set_config('t.auth2', public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 180, 'Báscula dañada')->>'id', false);
select pg_temp.ok(pg_temp.venta(jsonb_build_object('weight_mode','manual','weight_auth_id',current_setting('t.auth2')), 300)->>'weight_source' = 'manual_sin_autorizar',
                  'C7 autorizaron 180 g y la venta trae 330 g → manual_sin_autorizar');
select pg_temp.ok(pg_temp.venta('{"weight_mode":"manual_sin_conexion"}')->>'weight_source' = 'manual_sin_autorizar',
                  'C8 peso tecleado sin internet → manual_sin_autorizar, y la venta entra');
select pg_temp.ok(pg_temp.venta('{"weight_mode":"manual","weight_auth_id":"no-es-uuid"}')->>'weight_source' = 'manual_sin_autorizar',
                  'C9 un id de autorización basura no tumba la venta');
reset role; reset request.jwt.claim.sub;

select pg_temp.ok((select sale_id from public.weight_authorizations where id = current_setting('t.auth')::uuid)
                  = (current_setting('t.v1')::jsonb->>'sale_id')::uuid,
                  'C10 la autorización quedó amarrada a su venta');

\echo '=== Una autorización de Multiplaza no sirve en Galerías ==='
set role authenticated; set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
select set_config('t.authm', public.autorizar_peso_manual(current_setting('t.m')::uuid,
                  '44444444-4444-4444-4444-444444444444', '5173', 180, 'Báscula dañada')->>'id', false);
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.ok(pg_temp.venta(jsonb_build_object('weight_mode','manual','weight_auth_id',current_setting('t.authm')))->>'weight_source' = 'manual_sin_autorizar',
                  'C11 autorización de otra tienda → manual_sin_autorizar');

\echo '=== Reenviar la misma venta no gasta otra autorización ==='
select set_config('t.auth3', public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 180, 'Báscula dañada')->>'id', false);
select set_config('t.uuid', gen_random_uuid()::text, false);
select public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.g')::uuid, 'client_uuid', current_setting('t.uuid')::uuid,
    'weight_mode','manual','weight_auth_id',current_setting('t.auth3'),
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Yogurt','weight_g',180,'cost',4,'price_contribution',80))));
select pg_temp.ok((public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.g')::uuid, 'client_uuid', current_setting('t.uuid')::uuid,
    'weight_mode','manual','weight_auth_id',current_setting('t.auth3'),
    'lines', jsonb_build_array(jsonb_build_object('item_type','helado','name','Yogurt','weight_g',180,'cost',4,'price_contribution',80))))
    ->> 'weight_source') = 'manual_autorizado',
  'C12 el reenvío devuelve la venta original, con su clasificación');

\echo '=== La cajera no puede maquillar la clasificación ==='
select pg_temp.ok((select count(*) from public.sales where weight_source is not null) >= 0, 'D0 (la cajera lee sus ventas)');
update public.sales set weight_source = 'bascula' where weight_source = 'manual_sin_autorizar';
reset role; reset request.jwt.claim.sub;
select pg_temp.ok((select count(*) from public.sales where weight_source = 'manual_sin_autorizar') >= 4,
                  'D1 el UPDATE de la cajera no cambió nada (no tiene permiso de escritura en ventas)');

\echo '=== Pedidos anulados ==='
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select set_config('t.void', gen_random_uuid()::text, false);
select public.registrar_anulacion(jsonb_build_object('location_id', current_setting('t.g'), 'client_uuid', current_setting('t.void'),
       'weighed_g', 210, 'reason', 'La clienta se arrepintió', 'items', '[{"n":"Yogurt","g":180}]'::jsonb));
select pg_temp.ok((public.registrar_anulacion(jsonb_build_object('location_id', current_setting('t.g'), 'client_uuid', current_setting('t.void'),
       'weighed_g', 210, 'reason', 'La clienta se arrepintió'))->>'duplicate')::boolean,
                  'E1 reenviar la misma anulación no la duplica');
select pg_temp.falla($$select public.registrar_anulacion(jsonb_build_object('location_id', current_setting('t.m'),
       'client_uuid', gen_random_uuid(), 'weighed_g', 10, 'reason', 'xxx'))$$, 'permiso', 'E2 no se anula en otra tienda');
select pg_temp.falla($$select public.registrar_anulacion(jsonb_build_object('location_id', current_setting('t.g'),
       'client_uuid', gen_random_uuid(), 'weighed_g', -5, 'reason', 'xxx'))$$, 'rango', 'E3 peso negativo rechazado');
select pg_temp.ok((select count(*) from public.order_voids) = 0, 'E4 la cajera no ve la bitácora de anulaciones');
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.ok((select count(*) from public.order_voids where client_uuid = current_setting('t.void')::uuid) = 1,
                  'E5 la gerente sí la ve');
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.ok((select count(*) from public.order_voids where location_id = current_setting('t.g')::uuid) = 0,
                  'E6 la gerente de Multiplaza no ve las de Galerías');

\echo '=== Reporte de control de pesos ==='
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select set_config('t.rep', public.control_pesos(current_setting('t.g')::uuid, current_date - 1, current_date + 1)::text, false);
select pg_temp.ok((select (x->>'bascula')::int >= 1 and (x->>'manual_autorizado')::int >= 2
                          and (x->>'manual_sin_autorizar')::int >= 5 and (x->>'anulaciones')::int >= 1
                     from jsonb_array_elements(current_setting('t.rep')::jsonb->'por_cajera') x
                    where x->>'cajera' = 'Cajera Galerías'),
                  'F1 la gerente ve por cajera: báscula, a mano autorizado, sin autorizar y anulaciones');
select pg_temp.ok((select count(*) from jsonb_array_elements(current_setting('t.rep')::jsonb->'incidentes') i
                    where i->>'clase' = 'manual_autorizado' and i->>'autorizo' = 'Gerente Galerías') >= 1,
                  'F2 cada incidente dice quién autorizó');
select pg_temp.falla($$select public.control_pesos(current_setting('t.m')::uuid, current_date, current_date)$$,
                     'permiso', 'F3 la gerente de Galerías no ve el control de Multiplaza');
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.falla($$select public.control_pesos(current_setting('t.g')::uuid, current_date, current_date)$$,
                     'permiso', 'F4 la cajera no ve el reporte');

\echo '=== Tope de intentos ==='
select public.autorizar_peso_manual(current_setting('t.g')::uuid, '22222222-2222-2222-2222-222222222222', p, 50, 'adivinando')
  from unnest(array['1111','2222','3333']) p;
select pg_temp.ok(position('Demasiados' in public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 50, 'ya con el bueno')->>'error') > 0,
                  'G1 tras 5 fallos en 15 min, ni el PIN correcto entra');
-- Otra cuenta tampoco puede seguir probando contra la misma gerente: con un
-- fallo más desde la cuenta de la dueña, la gerente acumula 5.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.autorizar_peso_manual(current_setting('t.g')::uuid, '22222222-2222-2222-2222-222222222222', '8080', 50, 'adivinando');
select pg_temp.ok(position('Demasiados' in public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 50, 'desde otra cuenta')->>'error') > 0,
                  'G2 el bloqueo es también por gerente: cambiar de cuenta no da intentos nuevos');
select pg_temp.ok((public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '11111111-1111-1111-1111-111111111111', '90210', 50, 'la dueña autoriza')->>'ok')::boolean,
                  'G3 otra persona con PIN propio sí puede autorizar mientras tanto');
reset role; reset request.jwt.claim.sub;

\echo '=== anon no llega a nada ==='
set role anon;
select pg_temp.falla($$select public.autorizar_peso_manual(current_setting('t.g')::uuid,
                  '22222222-2222-2222-2222-222222222222', '4829', 50, 'xxx')$$, 'permission denied', 'H1 anon no puede pedir autorizaciones');
select pg_temp.falla($$select public.gerentes_para_autorizar(current_setting('t.g')::uuid)$$, 'permission denied', 'H2 anon no lista gerentes');
reset role;

delete from privado.pin_attempts;
\echo 'TODAS LAS PRUEBAS DE PESO PASARON'

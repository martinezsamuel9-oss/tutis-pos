-- ============================================================================
--  PRUEBAS: autorizar pesos a mano con la huella del teléfono de la gerente
--  Correr después de 00..11 y de prueba_pesos.sql (usa sus usuarios y PIN).
--  Se puede repetir. Si algo falla, se detiene con "FALLA ...".
-- ============================================================================
\set ON_ERROR_STOP on

select set_config('t.g', (select id::text from locations where name='Tuti''s Galerías'), false),
       set_config('t.m', (select id::text from locations where name='Tuti''s Multiplaza'), false);
delete from privado.pin_attempts;

create or replace function pg_temp.ok(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALLA %', msg; end if;
  raise notice '[ OK ] %', msg;
end $$;

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

-- Simula la sesión que deja Supabase Auth: quién es y cómo entró.
create or replace function pg_temp.sesion(p_uid text, p_metodo text, p_hace_seg int) returns void
language sql as $$
  select set_config('request.jwt.claim.sub', p_uid, false),
         set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'amr', jsonb_build_array(
           jsonb_build_object('method', p_metodo, 'timestamp', extract(epoch from now())::bigint - p_hace_seg)))::text, false);
$$;

set role authenticated;

\echo '=== Autorizar con huella ==='
select pg_temp.sesion('22222222-2222-2222-2222-222222222222', 'passkey', 10);
select set_config('t.h', (public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'La báscula no conecta'))->>'id', false);
select pg_temp.ok(current_setting('t.h') <> '', 'K1 la gerente con huella recién puesta autoriza');

select pg_temp.sesion('22222222-2222-2222-2222-222222222222', 'password', 10);
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'xxx')$$, 'huella', 'K2 una sesión de la gerente abierta con contraseña no sirve');

select pg_temp.sesion('22222222-2222-2222-2222-222222222222', 'passkey', 600);
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'xxx')$$, 'huella', 'K3 una huella de hace 10 minutos ya no sirve');

select pg_temp.sesion('33333333-3333-3333-3333-333333333333', 'passkey', 5);
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'xxx')$$, 'no puede autorizar', 'K4 la huella de la cajera no autoriza');

select pg_temp.sesion('44444444-4444-4444-4444-444444444444', 'passkey', 5);
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'xxx')$$, 'no puede autorizar', 'K5 la gerente de Multiplaza no autoriza en Galerías');

select pg_temp.sesion('22222222-2222-2222-2222-222222222222', 'passkey', 5);
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '55555555-5555-5555-5555-555555555555', 180, 'xxx')$$, 'no es de esta tienda', 'K6 no autoriza para una cajera de otra tienda');
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, '')$$, 'motivo', 'K7 sin motivo no');

select pg_temp.sesion('11111111-1111-1111-1111-111111111111', 'passkey', 5);
select pg_temp.ok((public.autorizar_peso_presencial(current_setting('t.m')::uuid,
       '55555555-5555-5555-5555-555555555555', 90, 'Báscula dañada')->>'ok')::boolean,
       'K8 la dueña autoriza con huella en cualquier tienda');

\echo '=== La autorización con huella sirve en la venta ==='
select pg_temp.sesion('33333333-3333-3333-3333-333333333333', 'password', 3600);
select set_config('t.v', public.process_sale(jsonb_build_object(
    'location_id', current_setting('t.g')::uuid, 'client_uuid', gen_random_uuid(),
    'weight_mode', 'manual', 'weight_auth_id', current_setting('t.h'),
    'lines', jsonb_build_array(
      jsonb_build_object('item_type','helado','name','Yogurt','weight_g',150,'cost',4.5,'price_contribution',67.5),
      jsonb_build_object('item_type','topping','name','Oreo','weight_g',30,'cost',1.4,'price_contribution',13.5))))::text, false);
select pg_temp.ok(current_setting('t.v')::jsonb->>'weight_source' = 'manual_autorizado',
                  'K9 la venta con autorización por huella queda manual_autorizado');

\echo '=== El reporte dice con qué se autorizó ==='
select pg_temp.sesion('22222222-2222-2222-2222-222222222222', 'password', 3600);
select pg_temp.ok((select count(*) from jsonb_array_elements(
                     public.control_pesos(current_setting('t.g')::uuid, current_date - 1, current_date + 1)->'incidentes') i
                    where i->>'metodo' = 'huella' and i->>'folio' = (current_setting('t.v')::jsonb->>'folio')) = 1,
                  'K10 el incidente dice "huella"');
select pg_temp.ok((select count(*) from jsonb_array_elements(
                     public.control_pesos(current_setting('t.g')::uuid, current_date - 1, current_date + 1)->'incidentes') i
                    where i->>'metodo' = 'pin') >= 1,
                  'K11 las autorizadas con PIN siguen diciendo "pin"');
reset role; reset request.jwt.claim.sub; reset request.jwt.claims;

set role anon;
select pg_temp.falla($$select public.autorizar_peso_presencial(current_setting('t.g')::uuid,
       '33333333-3333-3333-3333-333333333333', 180, 'xxx')$$, 'permission denied', 'K12 anon no llega');
reset role;

\echo 'TODAS LAS PRUEBAS DE HUELLA PASARON'

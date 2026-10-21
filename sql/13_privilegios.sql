-- ============================================================================
--  TUTI'S — Quitar privilegios sobrantes a anon y authenticated
--
--  Correr DESPUÉS de 01..12. Es idempotente.
--
--  Supabase le da por defecto a anon y authenticated TODOS los privilegios
--  sobre las tablas de public, incluidos TRUNCATE, TRIGGER y REFERENCES.
--  Ninguno de los tres hace falta:
--    · TRUNCATE  vacía una tabla entera y NO pasa por RLS. Hoy PostgREST no
--                lo expone, pero si mañana se abre otra puerta a la base (una
--                función con SQL dinámico, una extensión, un cliente directo),
--                una cajera podría vaciar sales o audit_log de las dos tiendas.
--    · TRIGGER   permite crear disparadores sobre la tabla.
--    · REFERENCES permite crear llaves foráneas que apunten a la tabla.
--    · MAINTAIN  (PostgreSQL 17+) permite LOCK TABLE, VACUUM, ANALYZE,
--                REINDEX y CLUSTER. Un LOCK TABLE ... ACCESS EXCLUSIVE sobre
--                sales congela las dos cajas mientras dure la transacción.
--                En PostgreSQL 16 (las pruebas locales) no existe y se salta.
--  Es defensa en profundidad: quitarlos no cambia nada de lo que la caja hace.
--
--  Lo segundo es para las tablas que se creen después: sin ello, cada tabla
--  nueva volvería a nacer con los tres privilegios. Aplica a las tablas que
--  crea el rol postgres, que es con el que se corren estos SQL.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

revoke truncate, trigger, references on all tables in schema public
  from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- MAINTAIN no se puede escribir directo: en PostgreSQL 16 es error de sintaxis.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from anon, authenticated';
    execute 'alter default privileges for role postgres in schema public
               revoke maintain on tables from anon, authenticated';
  end if;
end $$;

-- Si algo quedó, no se confirma nada. Se pregunta con has_table_privilege y
-- no con information_schema, que solo muestra lo que el rol actual otorgó o
-- recibió (en Supabase, postgres no es superusuario) y no conoce MAINTAIN.
do $$
declare v_quedan int;
begin
  select count(*) into v_quedan
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) r(rol)
    cross join (values ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and case when p.priv = 'MAINTAIN'
               and current_setting('server_version_num')::int < 170000 then false
              else has_table_privilege(r.rol, c.oid, p.priv) end;
  if v_quedan > 0 then
    raise exception 'quedan % privilegios TRUNCATE/TRIGGER/REFERENCES/MAINTAIN en public', v_quedan;
  end if;
end $$;

commit;

-- ============================================================================
--  TUTI'S — BORRAR LAS VENTAS INVENTADAS
--
--  Se pega completo en el SQL Editor de Supabase (proyecto de Tuti's) y Run.
--
--  Borra lo que generó datos_de_demostracion.sql el 2026-09-20:
--    · las ventas con cliente "(datos de prueba)" y sus líneas
--    · los gastos cuya descripción empieza con "[prueba]"
--
--  NO toca: el catálogo (sabores, toppings, vasos, precios), las existencias,
--  las sucursales, los usuarios, los clientes del programa de puntos ni sus
--  saldos. Las demostraciones nunca descontaron inventario, así que no hay
--  nada que devolver.
--
--  Apaga el rastro de auditoría mientras borra: el rastro cuenta lo que pasó
--  en el negocio, y estas ventas nunca pasaron.
--
--  Al final muestra lo que QUEDA en ventas. Si ahí sale algo, son ventas
--  hechas a mano al probar la caja (no llevan la marca de demostración);
--  para arrancar en cero también se pueden borrar con la parte 2, que está
--  comentada abajo.
-- ============================================================================

begin;
alter table public.sales    disable trigger trg_audit_sales;
alter table public.expenses disable trigger trg_audit_expenses;

delete from public.sales    where customer_name = '(datos de prueba)';
delete from public.expenses where description like '[prueba]%';

alter table public.sales    enable trigger trg_audit_sales;
alter table public.expenses enable trigger trg_audit_expenses;
commit;

-- ----------------------------------------------------------------------------
-- PARTE 2 (opcional): arrancar en cero. Borra TODA venta, anulación y
-- autorización de peso que quede, más la bitácora de correos del cierre.
-- Úsala solo si lo que mostró la consulta de abajo son pruebas. Para correrla,
-- quita los "-- " del principio de cada línea entre begin y commit.
-- Los movimientos de puntos se quedan (el saldo de cada cliente se respeta).
-- ----------------------------------------------------------------------------
-- begin;
-- alter table public.sales disable trigger trg_audit_sales;
-- delete from public.weight_authorizations;
-- delete from public.order_voids;
-- delete from public.sales;
-- delete from public.closing_email_log;
-- alter table public.sales enable trigger trg_audit_sales;
-- commit;

-- Lo que queda (si sale vacío, no queda ninguna venta).
select l.name                       as sucursal,
       count(s.id)                  as ventas_que_quedan,
       min(s.created_at)::date      as desde,
       max(s.created_at)::date      as hasta,
       round(sum(s.total_price), 2) as total
  from public.sales s
  join public.locations l on l.id = s.location_id
 group by l.name
 order by l.name;

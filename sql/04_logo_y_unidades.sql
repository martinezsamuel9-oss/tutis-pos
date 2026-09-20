-- ============================================================================
--  TUTI'S — Logo de la empresa y unidad de peso preferida
--
--  Correr DESPUÉS de 01, 02 y 03, en:
--  Supabase → SQL Editor → New query → pegar TODO → Run.
--  Es idempotente: correrlo dos veces no hace daño.
--
--  Qué agrega, las dos por sucursal (no globales) porque cada tienda puede
--  tener su propia imagen y su propia forma de pesar:
--    · logo_data_url        — el logo que sale en comprobantes y reportes
--    · default_weight_unit  — si esa tienda trabaja en gramos o en onzas
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LOGO
--    Se guarda la imagen misma dentro de la fila, codificada como texto
--    (data URL), en vez de subirla a un almacén aparte. Tres razones:
--      · Viaja junto con el catálogo que la caja ya guarda en el navegador,
--        así que el comprobante sale CON logo aunque no haya internet. Una
--        imagen alojada aparte no se vería.
--      · La política de seguridad del sitio ya permite imágenes data:, así
--        que no hay que abrirle la puerta a ningún dominio nuevo.
--      · Son 2 o 3 sucursales con un logo cada una. No amerita un bucket.
--
--    La aplicación reduce la imagen antes de guardarla. El límite de abajo es
--    la red de seguridad por si alguien escribe directo contra la API: sin él,
--    alguien podría meter una foto de 10 MB y volver lentísima cada carga del
--    catálogo, que es lo primero que pide la caja al abrir.
-- ----------------------------------------------------------------------------
alter table public.locations add column if not exists logo_data_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'locations_logo_size_chk') then
    alter table public.locations
      add constraint locations_logo_size_chk
      check (logo_data_url is null or length(logo_data_url) <= 300000);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. UNIDAD DE PESO PREFERIDA
--    Los pesos SIEMPRE se guardan en gramos. Esto es solo cómo se muestran y
--    cómo se capturan por omisión.
--
--    Es deliberado: si cada tienda guardara en su propia unidad, cualquier
--    reporte que sume dos sucursales estaría sumando peras con manzanas, y
--    el error no se vería hasta que los números ya estuvieran mal. Una sola
--    unidad en la base, la que el usuario quiera en la pantalla.
-- ----------------------------------------------------------------------------
alter table public.locations
  add column if not exists default_weight_unit text not null default 'g';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'locations_weight_unit_chk') then
    alter table public.locations
      add constraint locations_weight_unit_chk
      check (default_weight_unit in ('g', 'oz'));
  end if;
end $$;

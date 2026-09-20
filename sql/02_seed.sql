-- ============================================================================
--  TUTI'S — Datos iniciales: las 2 sucursales y su catálogo de arranque
--
--  Correr DESPUÉS de 01_schema.sql, en: Supabase → SQL Editor → Run.
--
--  IMPORTANTE: todos los precios, costos y existencias de aquí son de EJEMPLO.
--  Cámbialos por los reales desde la aplicación (pestaña Inventario/Toppings)
--  antes de vender de verdad.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LAS DOS SUCURSALES
--    Para abrir una tercera después, basta con insertar otra fila igual que
--    estas (o hacerlo desde la app con el usuario propietario).
-- ----------------------------------------------------------------------------
insert into public.locations (name, legal_name, country_code, currency_code, price_per_gram, margin_target_pct, address, active)
values
  ('Tuti''s Galerías',   'Tuti''s Frozen Yogurt', 'HN', 'HNL', 0.45, 60, 'Mall Galerías',   true),
  ('Tuti''s Multiplaza', 'Tuti''s Frozen Yogurt', 'HN', 'HNL', 0.45, 60, 'Mall Multiplaza', true)
on conflict (name) do nothing;
--       ^^^^^^ el nombre de la sucursal es único (ver 01_schema.sql). Sin
--       nombrar la columna, este archivo NO era idempotente: correrlo dos
--       veces creaba cuatro sucursales en vez de dos.

-- ----------------------------------------------------------------------------
-- 2. CATÁLOGO DE ARRANQUE PARA CADA SUCURSAL
--    Cada tienda recibe su propia copia: son inventarios y precios
--    independientes, aunque los productos se llamen igual.
-- ----------------------------------------------------------------------------
do $$
declare
  loc record;
begin
  for loc in select id from public.locations where name in ('Tuti''s Galerías', 'Tuti''s Multiplaza')
  loop
    -- Sabores de yogurt griego
    insert into public.flavors (location_id, name, cost_per_gram, stock_grams, min_stock_grams)
    select loc.id, x.name, x.cost, x.stock, x.minimo
      from (values
        ('Yogurt griego natural', 0.030, 8000, 1500),
        ('Yogurt griego de fresa', 0.034, 6000, 1500),
        ('Yogurt griego de vainilla', 0.032, 6000, 1500)
      ) as x(name, cost, stock, minimo)
     where not exists (
       select 1 from public.flavors f where f.location_id = loc.id and f.name = x.name
     );

    -- Toppings. tier 2 = premium, lleva recargo por gramo para proteger margen.
    insert into public.toppings (location_id, name, category, cost_per_gram, tier, surcharge_per_gram, stock_grams, min_stock_grams)
    select loc.id, x.name, x.cat, x.cost, x.tier, x.recargo, x.stock, x.minimo
      from (values
        ('M&M''s',             'dulce', 0.060, 1, 0.000, 2000, 400),
        ('Oreo triturada',     'dulce', 0.048, 1, 0.000, 2000, 400),
        ('Gomitas surtidas',   'dulce', 0.052, 1, 0.000, 1500, 300),
        ('Maní picado',        'mani',  0.055, 1, 0.000, 1800, 350),
        ('Salsa de chocolate', 'salsa', 0.040, 1, 0.000, 2500, 500),
        ('Salsa de caramelo',  'salsa', 0.042, 1, 0.000, 2500, 500),
        ('Jalea de fresa',     'jalea', 0.045, 1, 0.000, 2000, 400),
        ('Nutella',            'dulce', 0.190, 2, 0.070, 1200, 300),
        ('Gomitas importadas', 'dulce', 0.165, 2, 0.050, 800,  200)
      ) as x(name, cat, cost, tier, recargo, stock, minimo)
     where not exists (
       select 1 from public.toppings t where t.location_id = loc.id and t.name = x.name
     );

    -- Vasos y cucharas
    insert into public.supplies (location_id, name, kind, tare_weight_g, cost_per_unit, stock_qty, min_stock_qty)
    select loc.id, x.name, x.kind, x.tara, x.costo, x.stock, x.minimo
      from (values
        ('Vaso 8oz',          'vaso',    15.0, 2.00, 500, 100),
        ('Vaso 12oz',         'vaso',    20.0, 2.60, 400, 100),
        ('Vaso 16oz',         'vaso',    26.0, 3.20, 250, 60),
        ('Cuchara plástica',  'cuchara',  0.0, 0.38, 900, 200),
        ('Cuchara de color',  'cuchara',  0.0, 0.45, 400, 100)
      ) as x(name, kind, tara, costo, stock, minimo)
     where not exists (
       select 1 from public.supplies s where s.location_id = loc.id and s.name = x.name
     );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. ÚLTIMO PASO — CONVERTIRTE EN PROPIETARIO
--
--    El primer usuario tiene que ascenderse a mano, porque solo un propietario
--    puede nombrar a otros (así nadie se auto-asigna permisos desde la app).
--
--    a) Crea tu usuario en: Supabase → Authentication → Users → Add user
--       (con tu correo y una contraseña).
--    b) Descomenta la línea de abajo, pon tu correo, y córrela:
--
-- update public.profiles
--    set role = 'propietario', location_id = null, full_name = 'Samuel Martínez'
--  where id = (select id from auth.users where email = 'TU-CORREO@ejemplo.com');
--
--    Desde ahí, ya puedes crear a las gerentes y cajeras desde la aplicación:
--    se registran (o las creas en Authentication → Users) y tú les asignas
--    rol y sucursal en la pestaña "Usuarios".
-- ----------------------------------------------------------------------------

-- ============================================================================
--  TUTI'S — Productos de precio fijo que se ven en el video de la caja ICG
--  (2026-10-02, Galerías). Correr DESPUÉS de 14. Es idempotente: no pisa un
--  producto que ya exista con la misma familia y nombre en esa tienda.
--
--  Precios: ICG los muestra SIN ISV; aquí van CON ISV (lo que paga el
--  cliente), redondeados como se cobran: L 21.74 → L 25, L 52.17 → L 60.
--  Costos: el video no los muestra; quedan en 0 hasta que la gerente los
--  ponga en Inventario → Productos de precio fijo (mientras tanto, el margen
--  de estos productos sale inflado).
--
--  Lo que NO está aquí, a propósito:
--    · Oz Frozen Yogurt Mix: es la taza por peso, ya existe (vaso + sabores).
--    · Bubble Pop (L 43.48 la onza): se pesa aparte; falta decidir cómo.
--    · TC Adulto (L 0.00): en ICG solo dispara "Ofrezca agua o algo para
--      llevar"; aquí ese recordatorio sale solo al servir la taza.
--    · Los dos Tutis Rolls (L 121.74 y L 113.04) y lo de Bites, Tutis Pops,
--      Shakes y Bebidas calientes: en el video no se alcanzan a leer.
-- ============================================================================

insert into public.products (location_id, family, name, price, cost, sort)
select l.id, v.family, v.name, v.price, 0, v.sort
  from public.locations l
 cross join (values
   ('Bebidas',   'Agua en botella',           25.00, 1),
   ('Bebidas',   'Latte frío',                65.00, 2),
   ('Bebidas',   'Limonada frappé',           80.00, 3),
   ('Toppings',  'Topping normal',            20.00, 1),
   ('Toppings',  'Topping normal empacado',   20.00, 2),
   ('Toppings',  'Topping premium',           30.00, 3),
   ('Toppings',  'Topping premium empacado',  30.00, 4),
   ('Toppings',  'Crocante chocolate',        60.00, 5),
   ('Toppings',  'Cobertura empacada',        60.00, 6),
   ('Toppings',  'Cobertura pistacho',        60.00, 7),
   ('Temporada', 'S''more fibra miel',        45.00, 1)
 ) as v(family, name, price, sort)
 where l.active
on conflict (location_id, family, name) do nothing;

select l.name as tienda, p.family as familia, count(*) as productos
  from public.products p join public.locations l on l.id = p.location_id
 where p.active
 group by 1, 2 order by 1, 2;

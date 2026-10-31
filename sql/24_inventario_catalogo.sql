-- ============================================================================
-- 24. CATÁLOGO DE INVENTARIO DE ARRANQUE (del Excel "Cuadro Resumen", 2026-10-30)
-- ----------------------------------------------------------------------------
-- Máquinas, toppings con su costo por onza (hoja RES TOPP), artículos por
-- unidad, materia prima y las recetas que trae el Excel. Se puede volver a
-- correr: lo que ya existe no se toca (la propietaria lo pudo haber cambiado).
--
-- Lo que hay que CONFIRMAR con el negocio (queda en las notas de cada receta):
--   · El Excel trae dos medidas para algunos productos: la hoja CUADRE (la que
--     cuadran, p. ej. Froyo Fit 6 oz) y la de Recetas (8 oz de helado). Se
--     tomó la del CUADRE para el froyo y la de Recetas para los toppings.
--   · "Base Original" dice que rinde 40 oz con 8 L de yogurt: se dejó sin
--     rendimiento para que se anote lo que sale cada vez.
--   · Los costos de las tazas, vasos, bolsas de base y leche no vienen en el
--     Excel: arrancan en 0 y se ponen en Operación → Catálogo.
--   · Las recetas de venta se amarran por el nombre con que se vende en la
--     caja; si en la caja se llama distinto, se cambia el nombre en la receta.
-- ============================================================================

-- Máquinas: cada lado con el sabor con que arranca (hojas MQ 1–4).
insert into public.inv_items (nombre, tipo, unidad, maquina, lado, sabor, orden) values
  ('Máquina 1 · izquierda', 'maquina', 'oz', 1, 'izq', 'Vainilla', 1),
  ('Máquina 1 · derecha',   'maquina', 'oz', 1, 'der', 'Chocolate', 2),
  ('Máquina 2 · izquierda', 'maquina', 'oz', 2, 'izq', 'Mora (sorbete)', 3),
  ('Máquina 2 · derecha',   'maquina', 'oz', 2, 'der', 'Original', 4),
  ('Máquina 3 · izquierda', 'maquina', 'oz', 3, 'izq', 'Marshmallow', 5),
  ('Máquina 3 · derecha',   'maquina', 'oz', 3, 'der', 'Cotton candy', 6),
  ('Máquina 4 · izquierda', 'maquina', 'oz', 4, 'izq', 'Fresa sin azúcar', 7),
  ('Máquina 4 · derecha',   'maquina', 'oz', 4, 'der', 'Salted caramel sin azúcar', 8)
on conflict do nothing;

insert into public.inv_items (nombre, tipo, unidad, orden) values ('Base de rolls', 'base', 'oz', 1)
on conflict do nothing;

-- El yogurt servido: no se cuenta (se mide en las máquinas); lo consumen las
-- recetas de shakes, signatures, copitas, oreo cookie…
insert into public.inv_items (nombre, tipo, unidad, conteo_diario, orden) values ('Froyo servido', 'froyo', 'oz', false, 0)
on conflict do nothing;

-- Barra de toppings, con su costo por onza (RES TOPP, columna B).
insert into public.inv_items (nombre, tipo, unidad, costo, familia, orden)
select n, 'topping', 'oz', c, f, o from (values
  ('Brownie', 3.51, 'normal', 1), ('Canasta waffle', 3.37, 'normal', 2), ('Caramelo', 6.52, 'normal', 3),
  ('Cerezas en almíbar', 4.11, 'normal', 4), ('Chispas de chocolate', 7.0646, 'normal', 5),
  ('Chocolate cookies and cream', 6.39, 'normal', 6), ('Chocolate de temporada', 3.19, 'normal', 7),
  ('Coco rayado dulce', 7.99, 'normal', 8), ('Coctel de frutas', 2.7075, 'normal', 9),
  ('Confite candy corn', 5.62, 'normal', 10), ('Cono topping', 3.98, 'normal', 11), ('Fresas', 4.375, 'normal', 12),
  ('Galleta Chips Ahoy', 4.4766, 'normal', 13), ('Galleta fibra miel', 6.033, 'normal', 14),
  ('Galleta Oreo', 4.8433, 'normal', 15), ('Galleta Yipi', 3.07, 'normal', 16), ('Galleta wafers', 3.41, 'normal', 17),
  ('Granola con pasas', 5.73, 'normal', 18), ('Gummi corazón', 3.32, 'normal', 19), ('Gummi de dona', 3.88, 'normal', 20),
  ('Gummi de fresa', 3.88, 'normal', 21), ('Gummi oso de colores', 3.38, 'normal', 22),
  ('Gummi tiburón azul', 3.38, 'normal', 23), ('Gummi delfín', 6.72, 'normal', 24), ('Gummi frutitas', 3.19, 'normal', 25),
  ('Gummi gotita', 3.19, 'normal', 26), ('Gummi lombricitas', 3.38, 'normal', 27),
  ('Gummi lombricitas azucaradas', 3.38, 'normal', 28), ('Gummi pescaditos', 3.32, 'normal', 29),
  ('Gummi vaquita', 3.32, 'normal', 30), ('Gummi Welchs', 5.8128, 'normal', 31), ('Gummi conejo', 3.38, 'normal', 32),
  ('Hersheys syrup chocolate', 2.81, 'normal', 33), ('Jalea de cacahuate', 2.89, 'normal', 34),
  ('Jalea de fresa casera', 3.73, 'normal', 35), ('Jalea de maracuyá casera', 3.73, 'normal', 36),
  ('Jalea de mora casera', 3.73, 'normal', 37), ('Jalea de piña casera', 3.73, 'normal', 38), ('Kiwi', 4.35, 'normal', 39),
  ('Leche condensada', 3.1655, 'normal', 40), ('Licha en almíbar', 6.13, 'normal', 41), ('Mango fresco', 1.2787, 'normal', 42),
  ('Maní con sal', 3.91, 'normal', 43), ('Marshmallow derretido', 8.35, 'normal', 44), ('Marshmallows grandes', 2.66, 'normal', 45),
  ('Melocotón en almíbar', 1.77, 'normal', 46), ('Miel', 5.76, 'normal', 47), ('Nutella', 8.398, 'normal', 48),
  ('Piña', 0.76, 'normal', 49), ('Salsa de caramelo sin azúcar', 9.37, 'normal', 50),
  ('Salsa de chocolate sin azúcar', 9.34, 'normal', 51), ('Sprinkles de colores', 1.625, 'normal', 52), ('Uvas', 6.0856, 'normal', 53),
  ('Almendras en rebanadas', 6.7922, 'premium', 60), ('Bubble pop de sabores', 13.05, 'premium', 61),
  ('Chocolate M&M', 7.88, 'premium', 62), ('Chocolate mini Reeses', 9.86, 'premium', 63),
  ('Gummi ácida de pulpo', 6.23, 'premium', 64), ('Gummi ácida Sour Patch Kids', 7.62, 'premium', 65),
  ('Gummi Nerds', 10.21, 'premium', 66), ('Kit Kat', 11.38, 'premium', 67), ('Pirulines', 10.17, 'premium', 68),
  ('Tiras ácidas', 10.36, 'premium', 69), ('Whipped cream', 6.8589, 'premium', 70),
  ('Cobertura de chocolate', 15.94, 'cobertura', 80), ('Cobertura de chocolate blanco', 15.94, 'cobertura', 81),
  ('Cobertura cookie butter', 15.94, 'cobertura', 82)
) v(n, c, f, o)
on conflict do nothing;

-- Por unidad (hoja Control Inv).
insert into public.inv_items (nombre, tipo, unidad, orden)
select n, 'unidad', 'unid', o from (values
  ('Tazas 16 oz', 1), ('Tazas 8 oz (mini cup)', 2), ('Copitas de muestra', 3), ('Copitas puppy cup', 4),
  ('Vasos de shake y bebidas frías', 5), ('Vasos bebida caliente 8 oz', 6), ('Vasos bebida caliente 12 oz', 7),
  ('Paletas', 8), ('Oreo cookie', 9), ('Banana bites', 10), ('Agua en botella', 11)
) v(n, o)
on conflict do nothing;

-- Materia prima (no se cuenta a diario).
insert into public.inv_items (nombre, tipo, unidad, conteo_diario, orden)
select n, 'materia', u, false, o from (values
  ('Bolsa base vainilla', 'bolsa', 1), ('Bolsa base sugar free', 'bolsa', 2), ('Bolsa base original', 'bolsa', 3),
  ('Bolsa base mango', 'bolsa', 4), ('Bolsa base rolls', 'bolsa', 5), ('Leche entera', 'litro', 6),
  ('Yogurt natural', 'litro', 7), ('Agua purificada', 'litro', 8), ('Esencia de vainilla', 'oz', 9), ('Crema dulce', 'oz', 10)
) v(n, u, o)
on conflict do nothing;

-- Recetas: (nombre, tipo, rinde, produce, vende_nombre, notas, [[ingrediente, cantidad]…])
do $$
declare
  r record; v_id uuid; l text[]; v_item uuid;
begin
  for r in select * from (values
    ('Base vainilla con yogurt', 'fabricacion', 370::numeric, null::text, null::text,
     'Para cualquier sabor: base completa + el saborizante (ver la hoja Recetas).',
     array[['Bolsa base vainilla','1'],['Leche entera','8'],['Yogurt natural','1'],['Esencia de vainilla','1']]),
    ('Base vainilla sin yogurt', 'fabricacion', 370, null, null, null,
     array[['Bolsa base vainilla','1'],['Leche entera','8'],['Agua purificada','1'],['Esencia de vainilla','1']]),
    ('Base sugar free', 'fabricacion', 320, null, null, 'El Excel dice "8 bolsas de leche entera": se tomó como 8 litros. Confirmar.',
     array[['Bolsa base sugar free','1'],['Leche entera','8'],['Agua purificada','1'],['Esencia de vainilla','1']]),
    ('Base original', 'fabricacion', null, null, null, 'El Excel dice que rinde 40 oz con 8 L de yogurt: anotar lo que sale cada vez y confirmar.',
     array[['Bolsa base original','1'],['Yogurt natural','8']]),
    ('Base mango', 'fabricacion', 381, null, null, null,
     array[['Bolsa base mango','1'],['Leche entera','8'],['Yogurt natural','0.5']]),
    ('Base de rolls', 'fabricacion', 90, 'Base de rolls', null, null,
     array[['Bolsa base rolls','1'],['Leche entera','2'],['Crema dulce','4.2'],['Agua purificada','0.12']]),
    ('Oreo cookie', 'fabricacion', 1, 'Oreo cookie', null, '3 oz de froyo por unidad (hoja CUADRE).',
     array[['Froyo servido','3']]),
    ('Shake de fresa', 'venta', null, null, 'Malteada de fresa', '10 oz de froyo y 4.7 oz de topping (hoja CUADRE).',
     array[['Froyo servido','10'],['Fresas','4.7'],['Vasos de shake y bebidas frías','1']]),
    ('Shake de Oreo', 'venta', null, null, 'Malteada Oreo', '10 oz de froyo y 1.3 oz de topping (hoja CUADRE).',
     array[['Froyo servido','10'],['Galleta Oreo','1.3'],['Vasos de shake y bebidas frías','1']]),
    ('Shake de café', 'venta', null, null, 'Shake de café', null,
     array[['Froyo servido','10'],['Vasos de shake y bebidas frías','1']]),
    ('Smoothie de fresa', 'venta', null, null, 'Smoothie fresa', '4 oz de fresa (hoja CUADRE).',
     array[['Fresas','4'],['Vasos de shake y bebidas frías','1']]),
    ('Froyo Fit', 'venta', null, null, 'Froyo Fit', 'CUADRE: 6 oz de froyo. Recetas: original 8 oz + banano 3 + fresa 1.5 + kiwi 1.5 + granola 0.3.',
     array[['Froyo servido','6'],['Fresas','1.5'],['Kiwi','1.5'],['Granola con pasas','0.3']]),
    ('Cookie crumble', 'venta', null, null, 'Cookie Crumble', 'CUADRE: 9 oz de froyo. Recetas: chips ahoy 1.5 + oreo 1.5 + hershey 0.5.',
     array[['Froyo servido','9'],['Galleta Chips Ahoy','1.5'],['Galleta Oreo','1.5'],['Hersheys syrup chocolate','0.5']]),
    ('Banana caramel', 'venta', null, null, 'Banano Caramelo', 'CUADRE: 6 oz de froyo. Recetas: + banano 3 oz.',
     array[['Froyo servido','6'],['Caramelo','0.5'],['Maní con sal','0.3']]),
    ('Brownie con helado', 'venta', null, null, 'Brownie con helado', null,
     array[['Froyo servido','6.5'],['Brownie','1.5'],['Hersheys syrup chocolate','0.5'],['Almendras en rebanadas','0.3']]),
    ('Matcha moments', 'venta', null, null, 'Matcha', null,
     array[['Froyo servido','6.5'],['Marshmallow derretido','0.5'],['Fresas','2']]),
    ('Greek mediterráneo', 'venta', null, null, 'Greek', 'Baklava, kataifi y salsa de pistacho no están en la barra: agregarlos si se controlan.',
     array[['Froyo servido','6.5'],['Cobertura de chocolate','0.4']]),
    ('Mini cup', 'venta', null, null, 'Mini Cup', null,
     array[['Froyo servido','5.5'],['Tazas 8 oz (mini cup)','1']]),
    ('Mini cup con toppings', 'venta', null, null, 'Mini Cup con toppings', null,
     array[['Froyo servido','5.5'],['Tazas 8 oz (mini cup)','1']]),
    ('Puppy cup', 'venta', null, null, 'Puppy cup', '3 oz de froyo (hoja CUADRE).',
     array[['Froyo servido','3'],['Copitas puppy cup','1']]),
    ('Roll de fresa', 'venta', null, null, 'Roll Fresa', '3 oz de topping por roll (hoja CUADRE).',
     array[['Fresas','3']]),
    ('Roll de Oreo', 'venta', null, null, 'Roll Oreo', null, array[['Galleta Oreo','3']]),
    ('Roll banano Nutella', 'venta', null, null, 'Roll Banano Nutella', null, array[['Nutella','3']]),
    ('Oreo cookie (venta)', 'venta', null, null, 'Oreo Cookie', null, array[['Oreo cookie','1']]),
    ('Banana bites (venta)', 'venta', null, null, 'Banana Bites', null, array[['Banana bites','1']]),
    ('Agua en botella', 'venta', null, null, 'Agua en botella', null, array[['Agua en botella','1']]),
    ('Taza de barra libre', 'venta', null, null, 'Taza 16 oz', 'El nombre del vaso en la caja (Inventario → Vasos).',
     array[['Tazas 16 oz','1']])
  ) x(nombre, tipo, rinde, produce, vende, notas, lineas) loop
    if exists (select 1 from public.recetas where tipo = r.tipo and public.nombre_clave(nombre) = public.nombre_clave(r.nombre)) then
      continue;
    end if;
    insert into public.recetas (nombre, tipo, rinde, produce_item_id, vende_nombre, notas)
    values (r.nombre, r.tipo, r.rinde,
            (select id from public.inv_items where public.nombre_clave(nombre) = public.nombre_clave(r.produce)),
            r.vende, r.notas)
    returning id into v_id;
    foreach l slice 1 in array r.lineas loop
      select id into v_item from public.inv_items where public.nombre_clave(nombre) = public.nombre_clave(l[1]);
      if v_item is null then raise exception 'Receta %: no existe el artículo %', r.nombre, l[1]; end if;
      insert into public.receta_lineas (receta_id, item_id, cantidad) values (v_id, v_item, l[2]::numeric);
    end loop;
  end loop;
end $$;

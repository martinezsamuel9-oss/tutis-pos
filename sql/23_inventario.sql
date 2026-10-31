-- ============================================================================
-- 23. INVENTARIO DIARIO, FABRICACIÓN, RECETAS Y CUADRE
-- ----------------------------------------------------------------------------
-- Pedido del negocio (2026-10-30), con el Excel "Cuadro Resumen" que usan hoy
-- como modelo. Así trabajan:
--
--   · MÁQUINAS (MQ1–MQ4, lado izquierdo y derecho, cada lado con su sabor):
--       inicial + fabricado − merma − final = consumo (oz).
--       El final de hoy es el inicial de mañana.
--   · BARRA DE TOPPINGS: inicial + sumado − merma − final = consumo (oz).
--   · UNIDADES (tazas, copitas, vasos de shake, paletas, agua, oreo cookie,
--     banana bites…): inicial + compras/traspasos − venta − merma = stock
--     teórico, contra el final contado = diferencia.
--   · FABRICACIÓN: cada base tiene su receta (Base vainilla con yogurt: 1
--     bolsa + 8 L de leche + 1 L de yogurt + 1 oz de esencia = 370 oz) y lo
--     fabricado entra a la máquina.
--   · CUADRE: froyo de la barra libre = consumo de las máquinas − el froyo
--     que se fue en otros productos (shakes, rolls, froyo fit, copitas…);
--     igual con los toppings; y eso se compara con lo vendido por peso en la
--     caja. La diferencia en onzas, litros y %.
--
-- Lo que no hay que deshacer:
--   1. El catálogo de artículos y las recetas son DE LA MARCA (las dos
--      tiendas tienen las mismas máquinas y la misma barra); las existencias,
--      los conteos y los movimientos son DE CADA TIENDA.
--   2. TODO cambio de existencias es un movimiento (inv_movimientos): compra,
--      traspaso, sumado, fabricado, usado en fabricación, merma, invitación,
--      venta o ajuste. El conteo solo guarda el FINAL contado; el inicial es
--      el final del conteo anterior y lo demás sale de los movimientos. Así
--      el cuadre no depende de que alguien teclee bien el inicial.
--   3. Las ventas descuentan por RECETA con un disparador sobre sale_lines,
--      NO dentro de process_sale. Y el disparador nunca tumba una venta: si
--      algo falla, la venta entra igual y el cuadre lo mostrará (misma regla
--      que los puntos y la báscula).
--   4. Las recetas de venta se amarran por el NOMBRE con que la línea llega a
--      la caja (producto, vaso o cuchara), no por id: así una venta sin
--      conexión que sube días después descuenta igual. La pantalla avisa
--      cuáles recetas no encuentran su producto.
--   5. Escribir solo por funciones (inv_*), como las ventas: no hay
--      políticas de insert/update/delete en estas tablas.
--   6. Un conteo cerrado no se cambia. Lo reabre la gerente o la propietaria,
--      con motivo, y queda en el rastro de auditoría.
-- ============================================================================

-- La llave de un nombre: minúsculas, sin acentos, un solo espacio.
create or replace function public.nombre_clave(t text)
returns text language sql immutable as $$
  select nullif(lower(regexp_replace(trim(translate(coalesce(t, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '\s+', ' ', 'g')), '');
$$;

-- ----------------------------------------------------------------------------
-- Catálogo de artículos (de la marca)
-- ----------------------------------------------------------------------------
create table if not exists public.inv_items (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null check (length(trim(nombre)) between 2 and 80),
  -- maquina: un lado de una máquina (se cuenta en oz y lleva sabor)
  -- base:    mezcla fabricada que se guarda aparte (base de rolls)
  -- topping: barra de toppings (oz)
  -- unidad:  tazas, copitas, vasos, paletas, agua, oreo cookie…
  -- materia: materia prima (bolsas de base, leche, esencias…)
  -- froyo:   el yogurt servido; no se cuenta, lo consumen las recetas
  tipo         text not null check (tipo in ('maquina', 'base', 'topping', 'unidad', 'materia', 'froyo')),
  unidad       text not null default 'oz' check (unidad in ('oz', 'unid', 'litro', 'g', 'bolsa')),
  costo        numeric(12,4) not null default 0 check (costo >= 0),   -- por unidad
  familia      text,             -- toppings: normal, premium, cobertura
  maquina      int check (maquina between 1 and 20),
  lado         text check (lado in ('izq', 'der')),
  sabor        text,             -- el sabor con que arranca el lado de la máquina
  conteo_diario boolean not null default true,
  orden        int not null default 0,
  activo       boolean not null default true,
  created_at   timestamptz not null default now(),
  check ((tipo = 'maquina') = (maquina is not null and lado is not null))
);
create unique index if not exists uq_inv_items_nombre on public.inv_items(public.nombre_clave(nombre));
create unique index if not exists uq_inv_items_maquina on public.inv_items(maquina, lado) where tipo = 'maquina';

-- ----------------------------------------------------------------------------
-- Recetas (de la marca)
-- ----------------------------------------------------------------------------
create table if not exists public.recetas (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null check (length(trim(nombre)) between 2 and 80),
  tipo           text not null check (tipo in ('fabricacion', 'venta')),
  -- Fabricación: lo que produce y cuánto rinde una tanda. produce_item_id
  -- null = se elige al fabricar (a qué lado de qué máquina va).
  produce_item_id uuid references public.inv_items(id) on delete set null,
  rinde          numeric(12,3) check (rinde is null or rinde > 0),
  -- Venta: el nombre con que la línea llega a la caja.
  vende_nombre   text,
  notas          text check (notas is null or length(notas) <= 1000),
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  check (tipo = 'fabricacion' or vende_nombre is not null)
);
create unique index if not exists uq_recetas_nombre on public.recetas(tipo, public.nombre_clave(nombre));
create unique index if not exists uq_recetas_venta on public.recetas(public.nombre_clave(vende_nombre))
  where tipo = 'venta' and activo;

create table if not exists public.receta_lineas (
  receta_id uuid not null references public.recetas(id) on delete cascade,
  item_id   uuid not null references public.inv_items(id) on delete restrict,
  cantidad  numeric(12,4) not null check (cantidad > 0 and cantidad <= 100000),
  primary key (receta_id, item_id)
);

-- ----------------------------------------------------------------------------
-- Lo de cada tienda: fabricaciones, conteos y movimientos
-- ----------------------------------------------------------------------------
create table if not exists public.fabricaciones (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  fecha       date not null,
  receta_id   uuid not null references public.recetas(id) on delete restrict,
  tandas      numeric(10,3) not null check (tandas > 0 and tandas <= 100),
  destino_item_id uuid not null references public.inv_items(id) on delete restrict,
  producido   numeric(12,3) not null check (producido > 0 and producido <= 100000),
  sabor       text,
  nota        text check (nota is null or length(nota) <= 500),
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists idx_fabricaciones_loc on public.fabricaciones(location_id, fecha desc);

create table if not exists public.inv_conteos (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete restrict,
  fecha        date not null,
  estado       text not null default 'abierto' check (estado in ('abierto', 'cerrado')),
  hecho_por    uuid references public.profiles(id) on delete set null,
  cerrado_por  uuid references public.profiles(id) on delete set null,
  cerrado_at   timestamptz,
  reabierto_motivo text,
  created_at   timestamptz not null default now(),
  unique (location_id, fecha)
);

create table if not exists public.inv_conteo_lineas (
  conteo_id  uuid not null references public.inv_conteos(id) on delete cascade,
  item_id    uuid not null references public.inv_items(id) on delete restrict,
  final      numeric(14,3) not null check (final >= 0 and final <= 1000000),
  sabor      text check (sabor is null or length(sabor) <= 60),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (conteo_id, item_id)
);

create table if not exists public.inv_movimientos (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  item_id     uuid not null references public.inv_items(id) on delete restrict,
  fecha       date not null,
  tipo        text not null check (tipo in ('compra', 'traspaso_entrada', 'sumado', 'fabricado',
                                            'traspaso_salida', 'usado_fabricacion', 'merma', 'invitacion',
                                            'venta', 'ajuste')),
  cantidad    numeric(14,4) not null check (cantidad <> 0),
  costo       numeric(12,4) not null default 0,     -- costo unitario del artículo en ese momento
  nota        text check (nota is null or length(nota) <= 300),
  fabricacion_id uuid references public.fabricaciones(id) on delete cascade,
  conteo_id   uuid references public.inv_conteos(id) on delete cascade,
  sale_id     uuid references public.sales(id) on delete cascade,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  -- Entradas suman, salidas restan; el ajuste puede ir para los dos lados.
  check (case when tipo in ('compra', 'traspaso_entrada', 'sumado', 'fabricado') then cantidad > 0
              when tipo = 'ajuste' then true
              else cantidad < 0 end)
);
create index if not exists idx_inv_mov_loc on public.inv_movimientos(location_id, fecha, item_id);
create index if not exists idx_inv_mov_sale on public.inv_movimientos(sale_id) where sale_id is not null;

-- ----------------------------------------------------------------------------
-- Permisos: leer sí, escribir solo por funciones
-- ----------------------------------------------------------------------------
-- El catálogo lo editan la propietaria y operaciones de todas las tiendas
-- (can_operate_location(null)); lo leen todos los que operan o llevan cuentas.
create or replace function public.inv_puede_ver_catalogo()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('gerente', 'propietario', 'operaciones', 'contabilidad'), false);
$$;
revoke all on function public.inv_puede_ver_catalogo() from public, anon;
grant execute on function public.inv_puede_ver_catalogo() to authenticated;

do $$ declare t text; begin
  foreach t in array array['inv_items', 'recetas', 'receta_lineas', 'fabricaciones', 'inv_conteos',
                           'inv_conteo_lineas', 'inv_movimientos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
  end loop;
end $$;
create policy inv_items_select on public.inv_items for select to authenticated using (public.inv_puede_ver_catalogo());
create policy recetas_select on public.recetas for select to authenticated using (public.inv_puede_ver_catalogo());
create policy receta_lineas_select on public.receta_lineas for select to authenticated using (public.inv_puede_ver_catalogo());
create policy fabricaciones_select on public.fabricaciones for select to authenticated
  using (public.can_operate_location(location_id) or public.can_account_location(location_id));
create policy inv_conteos_select on public.inv_conteos for select to authenticated
  using (public.can_operate_location(location_id) or public.can_account_location(location_id));
create policy inv_conteo_lineas_select on public.inv_conteo_lineas for select to authenticated
  using (exists (select 1 from public.inv_conteos c where c.id = conteo_id
                  and (public.can_operate_location(c.location_id) or public.can_account_location(c.location_id))));
create policy inv_movimientos_select on public.inv_movimientos for select to authenticated
  using (public.can_operate_location(location_id) or public.can_account_location(location_id));

-- El rastro de auditoría: lo que mueve dinero (costos, recetas) y los conteos.
drop trigger if exists trg_audit_inv_items on public.inv_items;
create trigger trg_audit_inv_items after update or delete on public.inv_items for each row execute function public.audit_row();
drop trigger if exists trg_audit_recetas on public.recetas;
create trigger trg_audit_recetas after update or delete on public.recetas for each row execute function public.audit_row();
drop trigger if exists trg_audit_inv_conteos on public.inv_conteos;
create trigger trg_audit_inv_conteos after update or delete on public.inv_conteos for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- Auxiliares
-- ----------------------------------------------------------------------------
create or replace function public.inv_fecha_local(p_location uuid, p_ts timestamptz)
returns date language sql stable security definer set search_path = public as $$
  select (p_ts at time zone public.zona_tienda((select country_code from public.locations where id = p_location)))::date;
$$;
revoke all on function public.inv_fecha_local(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.inv_exige_operar(p_location uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.app_role() is null then raise exception 'Usuario sin perfil activo'; end if;
  if p_location is null or not public.can_operate_location(p_location) then
    raise exception 'Tu rol no lleva el inventario de esa tienda';
  end if;
end $$;
revoke all on function public.inv_exige_operar(uuid) from public, anon, authenticated;

-- Un conteo cerrado no se toca: nada que caiga en su día ni antes de él.
create or replace function public.inv_exige_abierto(p_location uuid, p_fecha date)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from public.inv_conteos where location_id = p_location and fecha >= p_fecha and estado = 'cerrado') then
    raise exception 'El inventario del % ya está cerrado: pídele a la gerente que lo reabra', to_char(p_fecha, 'DD/MM/YYYY');
  end if;
end $$;
revoke all on function public.inv_exige_abierto(uuid, date) from public, anon, authenticated;

create or replace function public.inv_exige_catalogo()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_operate_location(null) then
    raise exception 'El catálogo de inventario lo cambian la propietaria u operaciones de todas las tiendas';
  end if;
end $$;
revoke all on function public.inv_exige_catalogo() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Catálogo: guardar artículos y recetas
-- ----------------------------------------------------------------------------
create or replace function public.inv_guardar_item(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid;
begin
  perform public.inv_exige_catalogo();
  if v_id is null then
    insert into public.inv_items (nombre, tipo, unidad, costo, familia, maquina, lado, sabor, conteo_diario, orden, activo)
    values (trim(p->>'nombre'), p->>'tipo', coalesce(p->>'unidad', 'oz'), coalesce((p->>'costo')::numeric, 0),
            nullif(trim(coalesce(p->>'familia', '')), ''), nullif(p->>'maquina', '')::int, nullif(p->>'lado', ''),
            nullif(trim(coalesce(p->>'sabor', '')), ''), coalesce((p->>'conteo_diario')::boolean, true),
            coalesce((p->>'orden')::int, 0), coalesce((p->>'activo')::boolean, true))
    returning id into v_id;
  else
    update public.inv_items set
      nombre = trim(p->>'nombre'), tipo = p->>'tipo', unidad = coalesce(p->>'unidad', unidad),
      costo = coalesce((p->>'costo')::numeric, costo), familia = nullif(trim(coalesce(p->>'familia', '')), ''),
      maquina = nullif(p->>'maquina', '')::int, lado = nullif(p->>'lado', ''),
      sabor = nullif(trim(coalesce(p->>'sabor', '')), ''),
      conteo_diario = coalesce((p->>'conteo_diario')::boolean, conteo_diario),
      orden = coalesce((p->>'orden')::int, orden), activo = coalesce((p->>'activo')::boolean, activo)
    where id = v_id;
    if not found then raise exception 'Ese artículo no existe'; end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'Ya hay un artículo con ese nombre (o esa máquina y lado)';
  when check_violation then raise exception 'Revisa los datos del artículo (tipo, unidad, costo, máquina y lado)';
end $$;

-- p: {id?, nombre, tipo, produce_item_id?, rinde?, vende_nombre?, notas?, activo?,
--     lineas: [{item_id, cantidad}]}. Las líneas se reemplazan completas.
create or replace function public.inv_guardar_receta(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; l jsonb;
begin
  perform public.inv_exige_catalogo();
  if jsonb_typeof(p->'lineas') is distinct from 'array' or jsonb_array_length(p->'lineas') = 0 then
    raise exception 'La receta necesita al menos un ingrediente';
  end if;
  if v_id is null then
    insert into public.recetas (nombre, tipo, produce_item_id, rinde, vende_nombre, notas, activo)
    values (trim(p->>'nombre'), p->>'tipo', nullif(p->>'produce_item_id', '')::uuid, nullif(p->>'rinde', '')::numeric,
            nullif(trim(coalesce(p->>'vende_nombre', '')), ''), nullif(trim(coalesce(p->>'notas', '')), ''),
            coalesce((p->>'activo')::boolean, true))
    returning id into v_id;
  else
    update public.recetas set nombre = trim(p->>'nombre'), tipo = p->>'tipo',
      produce_item_id = nullif(p->>'produce_item_id', '')::uuid, rinde = nullif(p->>'rinde', '')::numeric,
      vende_nombre = nullif(trim(coalesce(p->>'vende_nombre', '')), ''), notas = nullif(trim(coalesce(p->>'notas', '')), ''),
      activo = coalesce((p->>'activo')::boolean, activo)
    where id = v_id;
    if not found then raise exception 'Esa receta no existe'; end if;
    delete from public.receta_lineas where receta_id = v_id;
  end if;
  for l in select * from jsonb_array_elements(p->'lineas') loop
    insert into public.receta_lineas (receta_id, item_id, cantidad)
    values (v_id, (l->>'item_id')::uuid, (l->>'cantidad')::numeric);
  end loop;
  return v_id;
exception
  when unique_violation then raise exception 'Ya hay una receta con ese nombre, o ese producto ya tiene receta (o un ingrediente está repetido)';
  when check_violation then raise exception 'Revisa la receta: cantidades mayores a cero y, si es de venta, con qué nombre se vende';
  when foreign_key_violation then raise exception 'Algún ingrediente no existe';
end $$;

-- ----------------------------------------------------------------------------
-- Movimientos sueltos: compra, traspaso, sumado, merma, invitación, ajuste
-- ----------------------------------------------------------------------------
create or replace function public.inv_movimiento(p_location uuid, p_fecha date, p_item uuid, p_tipo text,
                                                 p_cantidad numeric, p_nota text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_q numeric := abs(coalesce(p_cantidad, 0)); v_costo numeric;
begin
  perform public.inv_exige_operar(p_location);
  if p_fecha is null or p_fecha > public.inv_fecha_local(p_location, now()) + 1 or p_fecha < public.inv_fecha_local(p_location, now()) - 60 then
    raise exception 'La fecha tiene que ser de los últimos 60 días';
  end if;
  perform public.inv_exige_abierto(p_location, p_fecha);
  if p_tipo not in ('compra', 'traspaso_entrada', 'sumado', 'traspaso_salida', 'merma', 'invitacion', 'ajuste') then
    raise exception 'Ese tipo de movimiento no se registra a mano';
  end if;
  if v_q = 0 or v_q > 1000000 then raise exception 'Escribe una cantidad mayor a cero'; end if;
  if p_tipo in ('merma', 'invitacion', 'ajuste') and length(trim(coalesce(p_nota, ''))) < 3 then
    raise exception 'Escribe el motivo: queda registrado';
  end if;
  select costo into v_costo from public.inv_items where id = p_item and activo;
  if not found then raise exception 'Ese artículo no existe o está inactivo'; end if;
  insert into public.inv_movimientos (location_id, item_id, fecha, tipo, cantidad, costo, nota)
  values (p_location, p_item, p_fecha, p_tipo,
          case when p_tipo in ('traspaso_salida', 'merma', 'invitacion') then -v_q
               when p_tipo = 'ajuste' then p_cantidad else v_q end,
          v_costo, nullif(trim(coalesce(p_nota, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Borrar un movimiento a mano (no los de venta, fabricación ni conteo).
create or replace function public.inv_borrar_movimiento(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.inv_movimientos;
begin
  select * into m from public.inv_movimientos where id = p_id;
  if not found then raise exception 'Ese movimiento no existe'; end if;
  perform public.inv_exige_operar(m.location_id);
  perform public.inv_exige_abierto(m.location_id, m.fecha);
  if m.sale_id is not null or m.fabricacion_id is not null or m.conteo_id is not null then
    raise exception 'Ese movimiento lo generó una venta, una fabricación o el conteo: se corrige allá';
  end if;
  delete from public.inv_movimientos where id = p_id;
end $$;

-- ----------------------------------------------------------------------------
-- Fabricar: entra lo producido al destino y sale la materia prima
-- ----------------------------------------------------------------------------
-- p: {location_id, fecha, receta_id, tandas, destino_item_id?, producido?, sabor?, nota?}
create or replace function public.inv_fabricar(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid := (p->>'location_id')::uuid;
  v_fecha date := coalesce(nullif(p->>'fecha', '')::date, public.inv_fecha_local((p->>'location_id')::uuid, now()));
  r public.recetas;
  v_tandas numeric := coalesce(nullif(p->>'tandas', '')::numeric, 1);
  v_destino uuid;
  v_prod numeric;
  v_dest public.inv_items;
  v_id uuid;
  v_costo_tanda numeric;
begin
  perform public.inv_exige_operar(v_loc);
  if v_fecha > public.inv_fecha_local(v_loc, now()) or v_fecha < public.inv_fecha_local(v_loc, now()) - 60 then
    raise exception 'La fecha tiene que ser de los últimos 60 días';
  end if;
  perform public.inv_exige_abierto(v_loc, v_fecha);
  select * into r from public.recetas where id = (p->>'receta_id')::uuid and tipo = 'fabricacion' and activo;
  if not found then raise exception 'Esa receta de fabricación no existe'; end if;
  if v_tandas <= 0 or v_tandas > 100 then raise exception 'Las tandas van de más de 0 a 100'; end if;
  v_destino := coalesce(r.produce_item_id, nullif(p->>'destino_item_id', '')::uuid);
  if v_destino is null then raise exception 'Elige a dónde va lo fabricado (máquina y lado)'; end if;
  select * into v_dest from public.inv_items where id = v_destino and activo;
  if not found or v_dest.tipo not in ('maquina', 'base', 'unidad', 'topping') then
    raise exception 'Lo fabricado va a una máquina, una base, un topping o un artículo por unidad';
  end if;
  v_prod := coalesce(nullif(p->>'producido', '')::numeric, r.rinde * v_tandas);
  if v_prod is null or v_prod <= 0 then raise exception 'Escribe cuánto salió (la receta no dice cuánto rinde)'; end if;
  -- Un rendimiento muy lejos de la receta casi siempre es un dedo de más.
  if r.rinde is not null and (v_prod > r.rinde * v_tandas * 1.5 or v_prod < r.rinde * v_tandas * 0.5) then
    raise exception 'Salió % y la receta dice % por tanda: revisa las tandas o lo producido', v_prod, r.rinde;
  end if;

  insert into public.fabricaciones (location_id, fecha, receta_id, tandas, destino_item_id, producido, sabor, nota)
  values (v_loc, v_fecha, r.id, v_tandas, v_destino, v_prod,
          nullif(trim(coalesce(p->>'sabor', '')), ''), nullif(trim(coalesce(p->>'nota', '')), ''))
  returning id into v_id;

  insert into public.inv_movimientos (location_id, item_id, fecha, tipo, cantidad, costo, fabricacion_id, nota)
  select v_loc, rl.item_id, v_fecha, 'usado_fabricacion', -(rl.cantidad * v_tandas), i.costo, v_id, r.nombre
    from public.receta_lineas rl join public.inv_items i on i.id = rl.item_id
   where rl.receta_id = r.id;
  -- Lo producido entra con el costo de lo que se usó, repartido por onza.
  select coalesce(sum(rl.cantidad * i.costo), 0) into v_costo_tanda
    from public.receta_lineas rl join public.inv_items i on i.id = rl.item_id where rl.receta_id = r.id;
  insert into public.inv_movimientos (location_id, item_id, fecha, tipo, cantidad, costo, fabricacion_id, nota)
  values (v_loc, v_destino, v_fecha, 'fabricado', v_prod, round(v_costo_tanda * v_tandas / v_prod, 4), v_id, r.nombre);

  return jsonb_build_object('id', v_id, 'producido', v_prod, 'costo_total', round(v_costo_tanda * v_tandas, 2),
                            'costo_por_unidad', round(v_costo_tanda * v_tandas / v_prod, 4));
end $$;

create or replace function public.inv_borrar_fabricacion(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare f public.fabricaciones;
begin
  select * into f from public.fabricaciones where id = p_id;
  if not found then raise exception 'Esa fabricación no existe'; end if;
  perform public.inv_exige_operar(f.location_id);
  perform public.inv_exige_abierto(f.location_id, f.fecha);
  delete from public.fabricaciones where id = p_id;    -- sus movimientos se van en cascada
end $$;

-- ----------------------------------------------------------------------------
-- La venta descuenta por receta (disparador; nunca tumba la venta)
-- ----------------------------------------------------------------------------
create or replace function public.inv_descontar_venta()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fecha date;
begin
  if new.item_type::text not in ('producto', 'vaso', 'cuchara') then return new; end if;
  begin
    select public.inv_fecha_local(s.location_id, s.created_at) into v_fecha from public.sales s where s.id = new.sale_id;
    insert into public.inv_movimientos (location_id, item_id, fecha, tipo, cantidad, costo, sale_id, nota)
    select new.location_id, rl.item_id, v_fecha, 'venta', -(rl.cantidad * coalesce(new.quantity, 1)), i.costo, new.sale_id, r.nombre
      from public.recetas r
      join public.receta_lineas rl on rl.receta_id = r.id
      join public.inv_items i on i.id = rl.item_id
     where r.tipo = 'venta' and r.activo and public.nombre_clave(r.vende_nombre) = public.nombre_clave(new.name);
  exception when others then
    -- La venta ya ocurrió: se registra igual. El cuadre mostrará la diferencia.
    raise warning 'inv_descontar_venta: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.inv_descontar_venta() from public, anon, authenticated;
drop trigger if exists trg_inv_descontar_venta on public.sale_lines;
create trigger trg_inv_descontar_venta after insert on public.sale_lines
  for each row execute function public.inv_descontar_venta();

-- ----------------------------------------------------------------------------
-- El conteo del día
-- ----------------------------------------------------------------------------
-- p_lineas: [{item_id, final, sabor?}]. Una línea con final null se quita.
-- Las entradas (sumado, compras) y las mermas se registran como movimientos.
create or replace function public.inv_guardar_conteo(p_location uuid, p_fecha date, p_lineas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_c public.inv_conteos; l jsonb; v_hoy date;
begin
  perform public.inv_exige_operar(p_location);
  v_hoy := public.inv_fecha_local(p_location, now());
  if p_fecha is null or p_fecha > v_hoy or p_fecha < v_hoy - 60 then raise exception 'La fecha tiene que ser de los últimos 60 días'; end if;
  perform public.inv_exige_abierto(p_location, p_fecha);
  insert into public.inv_conteos (location_id, fecha, hecho_por) values (p_location, p_fecha, auth.uid())
  on conflict (location_id, fecha) do update set hecho_por = coalesce(public.inv_conteos.hecho_por, excluded.hecho_por)
  returning * into v_c;
  for l in select * from jsonb_array_elements(coalesce(p_lineas, '[]'::jsonb)) loop
    if not exists (select 1 from public.inv_items where id = (l->>'item_id')::uuid) then raise exception 'Hay un artículo que no existe'; end if;
    if nullif(l->>'final', '') is null then
      delete from public.inv_conteo_lineas where conteo_id = v_c.id and item_id = (l->>'item_id')::uuid;
    else
      if (l->>'final')::numeric < 0 then raise exception 'Un conteo no puede ser negativo'; end if;
      insert into public.inv_conteo_lineas (conteo_id, item_id, final, sabor, updated_by)
      values (v_c.id, (l->>'item_id')::uuid, (l->>'final')::numeric, nullif(trim(coalesce(l->>'sabor', '')), ''), auth.uid())
      on conflict (conteo_id, item_id) do update set final = excluded.final, sabor = excluded.sabor,
        updated_by = excluded.updated_by, updated_at = now();
    end if;
  end loop;
  return jsonb_build_object('id', v_c.id, 'estado', v_c.estado);
end $$;

-- Cerrar: todo lo que se cuenta a diario tiene que estar contado.
create or replace function public.inv_cerrar_conteo(p_location uuid, p_fecha date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_c public.inv_conteos; v_faltan text[];
begin
  perform public.inv_exige_operar(p_location);
  select * into v_c from public.inv_conteos where location_id = p_location and fecha = p_fecha;
  if not found then raise exception 'Todavía no hay conteo de ese día'; end if;
  if v_c.estado = 'cerrado' then raise exception 'Ese conteo ya está cerrado'; end if;
  select array_agg(i.nombre order by i.orden, i.nombre) into v_faltan
    from public.inv_items i
   where i.activo and i.conteo_diario and i.tipo in ('maquina', 'base', 'topping', 'unidad')
     and not exists (select 1 from public.inv_conteo_lineas cl where cl.conteo_id = v_c.id and cl.item_id = i.id);
  if v_faltan is not null then
    raise exception 'Falta contar: %', array_to_string(v_faltan[1:8], ', ') || case when cardinality(v_faltan) > 8 then format(' y %s más', cardinality(v_faltan) - 8) else '' end;
  end if;
  update public.inv_conteos set estado = 'cerrado', cerrado_por = auth.uid(), cerrado_at = now() where id = v_c.id;
  return public.inv_cuadre(p_location, p_fecha);
end $$;

create or replace function public.inv_reabrir_conteo(p_location uuid, p_fecha date, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_manage_location(p_location) then raise exception 'Solo la gerente o la propietaria reabren un inventario'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 5 then raise exception 'Escribe por qué se reabre: queda registrado'; end if;
  -- Se reabre ese día y los posteriores cerrados (su inicial depende de este).
  update public.inv_conteos set estado = 'abierto', reabierto_motivo = trim(p_motivo), cerrado_por = null, cerrado_at = null
   where location_id = p_location and fecha >= p_fecha and estado = 'cerrado';
  if not found then raise exception 'Ese día no está cerrado'; end if;
end $$;

-- ----------------------------------------------------------------------------
-- EL CUADRE (como la hoja CUADRE del Excel, pero sacado de la base)
-- ----------------------------------------------------------------------------
create or replace function public.inv_cuadre(p_location uuid, p_fecha date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_c public.inv_conteos;
  v_desde date;           -- el día siguiente al conteo anterior
  v_prev uuid;
  v_lineas jsonb;
  v_froyo_otros numeric; v_topp_otros numeric;
  v_cons_maq numeric; v_cons_topp numeric; v_merma_maq numeric;
  v_vend_g numeric; v_tazas int; v_ventas int;
  v_otros jsonb;
  OZ constant numeric := 28.349523125;
  v_barra numeric; v_vend_oz numeric; v_dif numeric;
begin
  if not (public.can_operate_location(p_location) or public.can_account_location(p_location)) then
    raise exception 'No tienes acceso al inventario de esa tienda';
  end if;
  select * into v_c from public.inv_conteos where location_id = p_location and fecha = p_fecha;
  select id, fecha + 1 into v_prev, v_desde from public.inv_conteos
   where location_id = p_location and fecha < p_fecha order by fecha desc limit 1;
  v_desde := coalesce(v_desde, p_fecha);

  with mov as (
    select item_id,
           sum(cantidad) filter (where tipo in ('compra', 'traspaso_entrada', 'sumado')) as entradas,
           sum(cantidad) filter (where tipo = 'fabricado') as fabricado,
           -sum(cantidad) filter (where tipo in ('traspaso_salida', 'usado_fabricacion')) as salidas,
           -sum(cantidad) filter (where tipo in ('merma', 'invitacion')) as merma,
           -sum(cantidad) filter (where tipo = 'venta') as venta,
           sum(cantidad) filter (where tipo = 'ajuste') as ajuste
      from public.inv_movimientos
     where location_id = p_location and fecha between v_desde and p_fecha
     group by item_id),
  fin as (select item_id, final, sabor from public.inv_conteo_lineas where conteo_id = v_c.id),
  ini as (select item_id, final as inicial, sabor from public.inv_conteo_lineas where conteo_id = v_prev),
  fab as (select destino_item_id as item_id, string_agg(distinct sabor, ', ') as sabor_fab
            from public.fabricaciones where location_id = p_location and fecha between v_desde and p_fecha group by 1),
  t as (
    select i.id, i.nombre, i.tipo, i.unidad, i.costo, i.familia, i.maquina, i.lado, i.orden,
           coalesce(fin.sabor, fab.sabor_fab, ini.sabor, i.sabor) as sabor,
           coalesce(ini.inicial, 0) as inicial, (ini.item_id is not null) as hay_inicial,
           coalesce(m.entradas, 0) as entradas, coalesce(m.fabricado, 0) as fabricado,
           coalesce(m.salidas, 0) as salidas, coalesce(m.merma, 0) as merma, coalesce(m.venta, 0) as venta,
           coalesce(m.ajuste, 0) as ajuste, fin.final
      from public.inv_items i
      left join mov m on m.item_id = i.id
      left join fin on fin.item_id = i.id
      left join ini on ini.item_id = i.id
      left join fab on fab.item_id = i.id
     where i.tipo <> 'froyo'
       and (i.activo and i.conteo_diario or fin.item_id is not null or m.item_id is not null))
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', id, 'nombre', nombre, 'tipo', tipo, 'unidad', unidad, 'costo', costo, 'familia', familia,
           'maquina', maquina, 'lado', lado, 'sabor', sabor, 'hay_inicial', hay_inicial,
           'inicial', inicial, 'entradas', entradas, 'fabricado', fabricado, 'salidas', salidas, 'merma', merma,
           'venta', venta, 'ajuste', ajuste, 'final', final,
           -- Lo que se fue (máquinas, toppings, materia prima).
           'consumo', case when final is null then null else round(inicial + entradas + fabricado + ajuste - salidas - merma - final, 3) end,
           -- Lo que debería haber según las ventas (unidades y bases).
           'teorico', round(inicial + entradas + fabricado + ajuste - salidas - merma - venta, 3),
           'diferencia', case when final is null then null else round(final - (inicial + entradas + fabricado + ajuste - salidas - merma - venta), 3) end,
           'valor_diferencia', case when final is null then null else round((final - (inicial + entradas + fabricado + ajuste - salidas - merma - venta)) * costo, 2) end)
         order by case tipo when 'maquina' then 1 when 'base' then 2 when 'topping' then 3 when 'unidad' then 4 else 5 end,
                  maquina, lado, orden, nombre), '[]'::jsonb)
    into v_lineas from t;

  -- Máquinas y toppings: consumo medido.
  select coalesce(sum((x->>'consumo')::numeric) filter (where x->>'tipo' = 'maquina'), 0),
         coalesce(sum((x->>'merma')::numeric) filter (where x->>'tipo' = 'maquina'), 0),
         coalesce(sum((x->>'consumo')::numeric) filter (where x->>'tipo' = 'topping'), 0)
    into v_cons_maq, v_merma_maq, v_cons_topp
    from jsonb_array_elements(v_lineas) x;

  -- Froyo y toppings que se fueron en OTROS productos (recetas de venta y
  -- de fabricación: shakes, rolls, froyo fit, oreo cookie, copitas…).
  select coalesce(-sum(m.cantidad) filter (where i.tipo = 'froyo'), 0),
         coalesce(-sum(m.cantidad) filter (where i.tipo = 'topping' and m.tipo = 'venta'), 0)
    into v_froyo_otros, v_topp_otros
    from public.inv_movimientos m join public.inv_items i on i.id = m.item_id
   where m.location_id = p_location and m.fecha between v_desde and p_fecha
     and m.tipo in ('venta', 'usado_fabricacion');
  select coalesce(jsonb_agg(jsonb_build_object('nombre', nombre, 'tipo', tipo, 'cantidad', round(q, 3)) order by tipo, q desc), '[]'::jsonb)
    into v_otros
    from (select coalesce(m.nota, '—') as nombre, i.tipo, -sum(m.cantidad) as q
            from public.inv_movimientos m join public.inv_items i on i.id = m.item_id
           where m.location_id = p_location and m.fecha between v_desde and p_fecha
             and m.tipo in ('venta', 'usado_fabricacion') and i.tipo in ('froyo', 'topping')
           group by 1, 2) y;

  -- Lo vendido por peso en la caja: helado + toppings de las tazas (la tara
  -- del vaso ya va aparte en su propia línea).
  select coalesce(sum(sl.weight_g) filter (where sl.item_type::text in ('helado', 'topping')), 0),
         count(*) filter (where sl.item_type::text = 'vaso'),
         count(distinct s.id)
    into v_vend_g, v_tazas, v_ventas
    from public.sales s join public.sale_lines sl on sl.sale_id = s.id
   where s.location_id = p_location
     and public.inv_fecha_local(s.location_id, s.created_at) between v_desde and p_fecha;

  v_barra := (v_cons_maq - v_froyo_otros) + (v_cons_topp - v_topp_otros);
  v_vend_oz := round(v_vend_g / OZ, 2);
  v_dif := round(v_vend_oz - v_barra, 2);

  return jsonb_build_object(
    'fecha', p_fecha, 'desde', v_desde, 'estado', coalesce(v_c.estado, 'sin_conteo'), 'conteo_id', v_c.id,
    'cerrado_at', v_c.cerrado_at, 'reabierto_motivo', v_c.reabierto_motivo,
    'hay_conteo_anterior', v_prev is not null,
    'lineas', v_lineas,
    'froyo', jsonb_build_object('consumo_maquinas', round(v_cons_maq, 2), 'merma_maquinas', round(v_merma_maq, 2),
                                'en_otros', round(v_froyo_otros, 2), 'barra_libre', round(v_cons_maq - v_froyo_otros, 2)),
    'toppings', jsonb_build_object('consumo', round(v_cons_topp, 2), 'en_otros', round(v_topp_otros, 2),
                                   'barra_libre', round(v_cons_topp - v_topp_otros, 2)),
    'otros_productos', v_otros,
    'consumo_barra', round(v_barra, 2),
    'vendido_oz', v_vend_oz, 'tazas', v_tazas, 'ventas', v_ventas,
    'oz_por_taza', case when v_tazas > 0 then round(v_vend_oz / v_tazas, 2) end,
    'diferencia_oz', v_dif,
    'diferencia_litros', round(v_dif / 33.814, 2),
    'diferencia_pct', case when v_vend_oz > 0 then round(v_dif / v_vend_oz * 100, 2) end,
    'valor_diferencias_unidades', (select coalesce(sum((x->>'valor_diferencia')::numeric), 0)
                                     from jsonb_array_elements(v_lineas) x where x->>'tipo' in ('unidad', 'base')));
end $$;

-- El mes (o cualquier rango): una fila por cada día con conteo.
create or replace function public.inv_cuadre_rango(p_location uuid, p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d record; v jsonb := '[]'::jsonb; c jsonb;
begin
  if not (public.can_operate_location(p_location) or public.can_account_location(p_location)) then
    raise exception 'No tienes acceso al inventario de esa tienda';
  end if;
  if p_hasta < p_desde or p_hasta - p_desde > 62 then raise exception 'El rango va de 1 a 62 días'; end if;
  for d in select fecha from public.inv_conteos where location_id = p_location and fecha between p_desde and p_hasta order by fecha loop
    c := public.inv_cuadre(p_location, d.fecha);
    v := v || jsonb_build_array(c - 'lineas' - 'otros_productos');
  end loop;
  return v;
end $$;

do $$ declare f text; begin
  foreach f in array array['inv_guardar_item(jsonb)', 'inv_guardar_receta(jsonb)',
                           'inv_movimiento(uuid, date, uuid, text, numeric, text)', 'inv_borrar_movimiento(uuid)',
                           'inv_fabricar(jsonb)', 'inv_borrar_fabricacion(uuid)',
                           'inv_guardar_conteo(uuid, date, jsonb)', 'inv_cerrar_conteo(uuid, date)',
                           'inv_reabrir_conteo(uuid, date, text)', 'inv_cuadre(uuid, date)',
                           'inv_cuadre_rango(uuid, date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- El respaldo nocturno copia también el inventario.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log','app_tamanos','app_config','pedidos_app',
               'cash_sessions','cash_movements','clientes_config',
               'inv_items','recetas','receta_lineas','fabricaciones','inv_conteos','inv_conteo_lineas','inv_movimientos'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

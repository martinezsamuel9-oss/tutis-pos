-- ============================================================================
--  TUTI'S — Productos de precio fijo (agua, bebidas, rolls, bites, porciones…)
--
--  Correr DESPUÉS de 01..13. Es idempotente.
--
--  En ICG la caja vende, además de la taza por peso, productos por unidad
--  agrupados en familias (Bebidas, Tutis Rolls, Bites, Tutis Pops, Shakes,
--  Temporada, Toppings…). Aquí:
--
--  1. products: el catálogo por tienda (familia, nombre, precio CON ISV,
--     costo, existencias opcionales y un aviso para la cajera, como el
--     "Ofrezca agua o algo para llevar" de ICG).
--  2. sale_item_type gana 'producto' y sale_lines gana quantity.
--  3. process_sale: igual que la de sql/10, más las líneas de producto
--     (cantidad validada, sin peso, descuenta existencias si las lleva).
--     Una venta de solo productos queda con weight_source 'no_aplica'.
--  4. El cierre del día y el respaldo incluyen los productos.
-- ============================================================================

-- ALTER TYPE ... ADD VALUE no puede usarse en la misma transacción en que se
-- agrega; por eso va primero y suelto, y lo demás lo referencia como texto.
alter type public.sale_item_type add value if not exists 'producto';

-- ----------------------------------------------------------------------------
-- 1. CATÁLOGO
-- ----------------------------------------------------------------------------
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  family      text not null check (length(trim(family)) between 1 and 40),
  name        text not null check (length(trim(name)) between 1 and 80),
  price       numeric(10,2) not null check (price >= 0 and price <= 100000),   -- con ISV: lo que paga el cliente
  cost        numeric(10,2) not null default 0 check (cost >= 0 and cost <= 100000),
  stock_qty   numeric(12,2),            -- null = no se controla existencia
  upsell      text check (upsell is null or length(upsell) <= 160),
  sort        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (location_id, family, name)
);
create index if not exists idx_products_loc on public.products(location_id, active, family, sort);

alter table public.products enable row level security;
-- La cajera tiene que verlos para venderlos; cambiarlos, solo quien maneja la tienda.
drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists products_write on public.products;
create policy products_write on public.products for all to authenticated
  using (public.can_manage_location(location_id))
  with check (public.can_manage_location(location_id));

grant select, insert, update, delete on public.products to authenticated;
revoke all on public.products from anon;

-- Precios y costos mueven dinero: al rastro de auditoría.
drop trigger if exists trg_audit_products on public.products;
create trigger trg_audit_products after insert or update or delete on public.products
  for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- 2. LÍNEAS CON CANTIDAD
-- ----------------------------------------------------------------------------
alter table public.sale_lines add column if not exists quantity numeric(10,2) not null default 1;
alter table public.sale_lines drop constraint if exists sale_lines_quantity_chk;
alter table public.sale_lines add constraint sale_lines_quantity_chk check (quantity > 0 and quantity <= 1000);

-- ----------------------------------------------------------------------------
-- 3. process_sale con productos (copia de sql/10 + bloques "PRODUCTOS")
-- ----------------------------------------------------------------------------
create or replace function public.process_sale(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id  uuid := (payload->>'location_id')::uuid;
  v_client_uuid  uuid := (payload->>'client_uuid')::uuid;
  v_created_at   timestamptz := coalesce((payload->>'created_at')::timestamptz, now());
  v_existing     public.sales%rowtype;
  v_sale_id      uuid;
  v_folio        bigint;
  v_line         jsonb;
  v_profile      public.profiles%rowtype;
  v_currency     text;
  v_lines        jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_peso         numeric;
  v_costo        numeric;
  v_precio       numeric;
  v_cant         numeric;
  v_tot_peso     numeric := 0;
  v_tot_costo    numeric := 0;
  v_tot_precio   numeric := 0;
  -- fidelización
  v_cliente      uuid := nullif(payload->>'customer_id', '')::uuid;
  v_pide_canje   int  := greatest(0, coalesce((payload->>'redeem_points')::int, 0));
  v_cfg          public.loyalty_config%rowtype;
  v_saldo        int;
  v_canje        int := 0;
  v_descuento    numeric := 0;
  v_gana         int := 0;
  v_total_final  numeric;
  -- peso
  v_modo         text := payload->>'weight_mode';
  v_pesado       numeric := 0;   -- helado + toppings: lo que pasó por la báscula
  v_tara         numeric := 0;   -- vasos, del catálogo
  v_bruto        numeric;
  v_log          jsonb := payload->'scale_log';
  v_auth_id      uuid;
  v_auth         public.weight_authorizations%rowtype;
  v_origen       text;
begin
  if v_location_id is null or v_client_uuid is null then
    raise exception 'Falta location_id o client_uuid en la venta';
  end if;

  select * into v_profile from public.profiles where id = auth.uid() and active;
  if v_profile.id is null then
    raise exception 'Usuario sin perfil activo';
  end if;

  if v_profile.role <> 'propietario' and v_profile.location_id is distinct from v_location_id then
    raise exception 'No tiene permiso para registrar ventas en esa sucursal';
  end if;

  select * into v_existing from public.sales where client_uuid = v_client_uuid;
  if v_existing.id is not null then
    return jsonb_build_object('sale_id', v_existing.id, 'folio', v_existing.folio, 'duplicate', true,
                              'points_earned', v_existing.points_earned,
                              'points_redeemed', v_existing.points_redeemed,
                              'discount', v_existing.discount,
                              'weight_source', v_existing.weight_source);
  end if;

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_peso   := coalesce((v_line->>'weight_g')::numeric, 0);
    v_costo  := coalesce((v_line->>'cost')::numeric, 0);
    v_precio := coalesce((v_line->>'price_contribution')::numeric, 0);

    if v_peso < 0 then
      raise exception 'Peso negativo en la línea "%": una venta no puede devolver producto al inventario',
        coalesce(v_line->>'name', '?');
    end if;
    if v_costo < 0 or v_precio < 0 then
      raise exception 'Costo o precio negativo en la línea "%"', coalesce(v_line->>'name', '?');
    end if;
    if v_peso > 100000 then
      raise exception 'Peso fuera de rango en la línea "%"', coalesce(v_line->>'name', '?');
    end if;
    -- PRODUCTOS (sql/14): se venden por unidad. La cantidad tiene que ser
    -- positiva y razonable; un producto no pesa (su peso no entra al cuadre
    -- de la báscula, que es solo del vaso).
    v_cant := coalesce((v_line->>'quantity')::numeric, 1);
    if v_cant <= 0 or v_cant > 1000 then
      raise exception 'Cantidad fuera de rango en la línea "%"', coalesce(v_line->>'name', '?');
    end if;
    if (v_line->>'item_type') = 'producto' and v_peso <> 0 then
      raise exception 'Un producto de precio fijo no lleva peso: "%"', coalesce(v_line->>'name', '?');
    end if;

    v_tot_peso   := v_tot_peso + v_peso;
    v_tot_costo  := v_tot_costo + v_costo;
    v_tot_precio := v_tot_precio + v_precio;

    if (v_line->>'item_type') in ('helado', 'topping') then
      v_pesado := v_pesado + v_peso;
    elsif (v_line->>'item_type') = 'vaso' then
      v_tara := v_tara + v_peso;
    end if;
  end loop;

  -- --- PESO -----------------------------------------------------------------
  -- Se clasifica, nunca se rechaza (ver encabezado).
  begin
    v_bruto := nullif(payload->>'scale_gross_g', '')::numeric;
  exception when others then
    v_bruto := null;
  end;
  begin
    v_auth_id := nullif(payload->>'weight_auth_id', '')::uuid;
  exception when others then
    v_auth_id := null;
  end;
  if v_log is not null and (jsonb_typeof(v_log) <> 'array' or length(v_log::text) > 6000) then
    v_log := null;
  end if;

  if v_pesado = 0 then
    v_origen := 'no_aplica';
    v_auth_id := null;
  elsif v_modo = 'bascula' then
    v_auth_id := null;
    if v_bruto is null or v_log is null or jsonb_array_length(v_log) = 0 then
      v_origen := 'sin_dato';
    elsif abs(v_bruto - (v_pesado + v_tara)) > 1 then
      -- La báscula marcó una cosa y las líneas dicen otra: se quitó algo
      -- después de pesarlo, o el mensaje no salió de la pantalla de venta.
      v_origen := 'bascula_no_cuadra';
    else
      v_origen := 'bascula';
    end if;
  elsif v_modo = 'manual' and v_auth_id is not null then
    -- Se bloquea la autorización: dos ventas no pueden usar la misma.
    select * into v_auth from public.weight_authorizations
     where id = v_auth_id for update;
    if v_auth.id is not null
       and v_auth.location_id = v_location_id
       and v_auth.sale_id is null
       and abs(v_auth.weight_g - v_pesado) <= 1 then
      v_origen := 'manual_autorizado';
    else
      v_origen := 'manual_sin_autorizar';
      v_auth_id := null;
    end if;
  elsif v_modo in ('manual', 'manual_sin_conexion') then
    v_origen := 'manual_sin_autorizar';
    v_auth_id := null;
  else
    v_origen := 'sin_dato';
    v_auth_id := null;
  end if;

  -- --- Fidelización ---------------------------------------------------------
  select * into v_cfg from public.loyalty_config where id;

  -- Esta revisión va SIEMPRE que venga un cliente, esté o no activo el
  -- programa: si el cliente ya no existe, la venta chocaría con la llave
  -- foránea de sales.customer_id y se perdería igual.
  if v_cliente is not null then
    -- Se bloquea la fila del cliente hasta el final de la transacción. Sin
    -- esto, dos cajas cobrándole al mismo cliente a la vez podrían canjear
    -- ambas el mismo saldo.
    select points_balance into v_saldo from public.customers
     where id = v_cliente and active for update;

    if v_saldo is null then
      -- Si pedía CANJEAR, sí se rechaza: eso solo pasa en línea y la cajera
      -- tiene que enterarse antes de cobrar.
      if v_pide_canje > 0 then
        raise exception 'El cliente del carnet no existe o está inactivo';
      end if;
      -- Si solo iba a GANAR puntos, la venta se registra igual, sin cliente.
      v_cliente := null;
    end if;
  end if;

  if v_cliente is not null and v_cfg.activo then

    if v_pide_canje > 0 then
      if v_saldo < v_cfg.canje_minimo then
        raise exception 'El cliente necesita al menos % puntos para canjear', v_cfg.canje_minimo;
      end if;
      if v_pide_canje > v_saldo then
        raise exception 'El cliente solo tiene % puntos', v_saldo;
      end if;
      -- El tope se vuelve a calcular aquí, aunque la pantalla ya lo haya
      -- consultado: lo que decide es el servidor.
      v_canje := least(v_pide_canje,
                       case when v_cfg.valor_punto > 0
                            then floor(round(v_tot_precio * v_cfg.canje_max_pct / 100, 2) / v_cfg.valor_punto)::int
                            else 0 end);
      v_descuento := round(v_canje * v_cfg.valor_punto, 2);
      if v_descuento > v_tot_precio then
        v_descuento := v_tot_precio;
      end if;
    end if;

    -- Los puntos se ganan sobre lo que el cliente REALMENTE pagó.
    v_total_final := v_tot_precio - v_descuento;
    if v_total_final >= v_cfg.compra_minima then
      v_gana := floor(v_total_final / v_cfg.monto_por_punto)::int;
    end if;
  else
    v_total_final := v_tot_precio;
  end if;

  select currency_code into v_currency from public.locations where id = v_location_id;

  perform pg_advisory_xact_lock(hashtextextended(v_location_id::text, 0));
  select coalesce(max(folio), 0) + 1 into v_folio
    from public.sales where location_id = v_location_id;

  insert into public.sales (
    location_id, client_uuid, folio, cashier_id, cashier_name, created_at,
    gross_weight_g, total_price, total_cost, margin, margin_pct,
    currency_code, payment_method, customer_name, customer_tax_id, synced_offline,
    customer_id, points_earned, points_redeemed, discount,
    weight_source, weight_auth_id, scale_gross_g, scale_log
  ) values (
    v_location_id, v_client_uuid, v_folio, v_profile.id, v_profile.full_name, v_created_at,
    round(v_tot_peso, 2),
    round(v_total_final, 2),
    round(v_tot_costo, 2),
    round(v_total_final - v_tot_costo, 2),
    case when v_total_final > 0
         then round(100 * (v_total_final - v_tot_costo) / v_total_final, 2) else 0 end,
    coalesce(v_currency, payload->>'currency_code'),
    payload->>'payment_method',
    payload->>'customer_name',
    payload->>'customer_tax_id',
    coalesce((payload->>'synced_offline')::boolean, false),
    v_cliente, v_gana, v_canje, v_descuento,
    v_origen, v_auth_id, round(v_bruto, 2), v_log
  )
  returning id into v_sale_id;

  if v_origen = 'manual_autorizado' then
    update public.weight_authorizations set sale_id = v_sale_id where id = v_auth_id;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    insert into public.sale_lines (
      sale_id, location_id, item_type, ref_id, name, weight_g, cost,
      price_contribution, is_premium_surcharge, quantity
    ) values (
      v_sale_id, v_location_id,
      (v_line->>'item_type')::sale_item_type,
      nullif(v_line->>'ref_id', '')::uuid,
      coalesce(v_line->>'name', ''),
      coalesce((v_line->>'weight_g')::numeric, 0),
      coalesce((v_line->>'cost')::numeric, 0),
      coalesce((v_line->>'price_contribution')::numeric, 0),
      coalesce((v_line->>'is_premium_surcharge')::boolean, false),
      coalesce((v_line->>'quantity')::numeric, 1)
    );

    if (v_line->>'item_type') = 'helado' and nullif(v_line->>'ref_id', '') is not null then
      update public.flavors
         set stock_grams = stock_grams - coalesce((v_line->>'weight_g')::numeric, 0)
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;

    elsif (v_line->>'item_type') = 'topping' and nullif(v_line->>'ref_id', '') is not null then
      update public.toppings
         set stock_grams = stock_grams - coalesce((v_line->>'weight_g')::numeric, 0)
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;

    elsif (v_line->>'item_type') in ('vaso', 'cuchara') and nullif(v_line->>'ref_id', '') is not null then
      update public.supplies
         set stock_qty = stock_qty - 1
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id;

    -- Solo se descuenta si el producto lleva control de existencias.
    elsif (v_line->>'item_type') = 'producto' and nullif(v_line->>'ref_id', '') is not null then
      update public.products
         set stock_qty = stock_qty - coalesce((v_line->>'quantity')::numeric, 1)
       where id = (v_line->>'ref_id')::uuid and location_id = v_location_id and stock_qty is not null;
    end if;
  end loop;

  -- Mover los puntos va DESPUÉS de que la venta existe, para que cada
  -- movimiento pueda apuntar a su venta.
  if v_cliente is not null then
    if v_canje > 0 then
      update public.customers set points_balance = points_balance - v_canje where id = v_cliente;
      insert into public.loyalty_transactions (customer_id, location_id, sale_id, kind, points, amount, created_by)
      values (v_cliente, v_location_id, v_sale_id, 'canje', -v_canje, v_descuento, v_profile.id);
    end if;
    if v_gana > 0 then
      update public.customers set points_balance = points_balance + v_gana where id = v_cliente;
      insert into public.loyalty_transactions (customer_id, location_id, sale_id, kind, points, amount, created_by)
      values (v_cliente, v_location_id, v_sale_id, 'gana', v_gana, v_total_final, v_profile.id);
    end if;
    update public.customers
       set total_spent = total_spent + v_total_final,
           visits      = visits + 1
     where id = v_cliente;
  end if;

  return jsonb_build_object(
    'sale_id', v_sale_id, 'folio', v_folio, 'duplicate', false,
    'points_earned', v_gana, 'points_redeemed', v_canje, 'discount', v_descuento,
    'total', round(v_total_final, 2), 'weight_source', v_origen);
end;
$$;

revoke all on function public.process_sale(jsonb) from public, anon;
grant execute on function public.process_sale(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. CIERRE con productos (la de sql/12 + "productos")
-- ----------------------------------------------------------------------------
create or replace function public.daily_closing_core(
  p_location_id      uuid,
  p_day              date,
  p_utc_offset_hours int default -6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end   timestamptz;
  v_result jsonb;
begin
  v_start := (p_day::timestamp - make_interval(hours => p_utc_offset_hours)) at time zone 'UTC';
  v_end   := v_start + interval '1 day';

  with day_sales as (
    select id, total_price, total_cost, margin, discount, payment_method
      from public.sales
     where location_id = p_location_id
       and created_at >= v_start
       and created_at <  v_end
  ),
  totales_venta as (
    select count(*) as ventas,
           coalesce(sum(total_price), 0) as ingresos,
           coalesce(sum(total_cost), 0)  as costos,
           coalesce(sum(margin), 0)      as margen,
           coalesce(sum(discount), 0)    as descuentos
      from day_sales
  ),
  totales_linea as (
    select coalesce(sum(case when sl.item_type = 'vaso'    then 1 else 0 end), 0)           as vasos,
           coalesce(sum(case when sl.item_type = 'cuchara' then 1 else 0 end), 0)           as cucharas,
           coalesce(sum(case when sl.item_type = 'helado'  then sl.weight_g else 0 end), 0) as peso_helado,
           coalesce(sum(case when sl.item_type = 'topping' then sl.weight_g else 0 end), 0) as peso_toppings
      from public.sale_lines sl
      join day_sales s on s.id = sl.sale_id
  ),
  gastos as (
    select coalesce(sum(amount), 0) as total
      from public.expenses
     where location_id = p_location_id and spent_on = p_day
  ),
  por_topping as (
    select sl.name, sum(sl.weight_g) as peso
      from public.sale_lines sl
      join day_sales s on s.id = sl.sale_id
     where sl.item_type = 'topping'
     group by sl.name
  ),
  toppings_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'name',   pt.name,
               'peso_g', round(pt.peso, 2),
               'pct',    case when tl.peso_toppings > 0
                              then round(100 * pt.peso / tl.peso_toppings, 2) else 0 end
             ) order by pt.peso desc), '[]'::jsonb) as items
      from por_topping pt cross join totales_linea tl
  ),
  -- Lo que tiene que haber en caja por cada forma de pago. Las ventas de
  -- antes de que la caja mandara la forma de pago salen como 'sin_dato'.
  por_pago as (
    select coalesce(nullif(trim(payment_method), ''), 'sin_dato') as metodo,
           count(*) as ventas, sum(total_price) as total
      from day_sales
     group by 1
  ),
  pago_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'metodo', metodo, 'ventas', ventas, 'total', round(total, 2))
             order by case metodo when 'efectivo' then 1 when 'tarjeta' then 2
                                  when 'transferencia' then 3 else 4 end), '[]'::jsonb) as items
      from por_pago
  ),
  -- Productos de precio fijo (sql/14): cuántos y cuánto, por producto.
  por_producto as (
    select sl.name, sum(sl.quantity) as cantidad, sum(sl.price_contribution) as total
      from public.sale_lines sl
      join day_sales s on s.id = sl.sale_id
     where sl.item_type::text = 'producto'
     group by sl.name
  ),
  productos_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', name, 'cantidad', cantidad, 'total', round(total, 2))
             order by total desc, name), '[]'::jsonb) as items
      from por_producto
  ),
  anulaciones as (
    select count(*) as pedidos, coalesce(sum(weighed_g), 0) as gramos
      from public.order_voids
     where location_id = p_location_id
       and created_at >= v_start
       and created_at <  v_end
  )
  select jsonb_build_object(
           'location_id',     p_location_id,
           'day',             p_day,
           'ventas',          tv.ventas,
           'ingresos',        round(tv.ingresos, 2),
           'costos',          round(tv.costos, 2),
           'margen',          round(tv.margen, 2),
           'gastos',          round(g.total, 2),
           'utilidad',        round(tv.margen - g.total, 2),
           'vasos',           tl.vasos,
           'cucharas',        tl.cucharas,
           'peso_helado_g',   round(tl.peso_helado, 2),
           'peso_toppings_g', round(tl.peso_toppings, 2),
           'toppings',        tj.items,
           'por_pago',        pj.items,
           'descuentos',      round(tv.descuentos, 2),
           'anulaciones',     an.pedidos,
           'anulado_g',       round(an.gramos, 2),
           'productos',       prj.items
         )
    into v_result
    from totales_venta tv
   cross join totales_linea tl
   cross join gastos g
   cross join toppings_json tj
   cross join pago_json pj
   cross join anulaciones an
   cross join productos_json prj;

  return v_result;
end;
$$;

revoke all on function public.daily_closing_core(uuid, date, int) from public, anon, authenticated;
grant execute on function public.daily_closing_core(uuid, date, int) to service_role;

-- El respaldo nocturno copia también el catálogo de productos.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

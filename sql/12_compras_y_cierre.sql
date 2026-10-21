-- ============================================================================
--  TUTI'S — Libro de compras y cierre por forma de pago
--
--  Correr DESPUÉS de 01..11. Es idempotente.
--
--  1. COMPRAS (purchases): cada factura de proveedor, con lo que pide el
--     "Libro de compras" de ICG Manager. Las series son las del negocio:
--       · CTG  gasto                         (compra = 'gasto')
--       · CTH  materia prima desde bodega    (compra = 'materia_bodega')
--       · la serie de cada tienda (011C, 021C) para la materia prima que la
--         tienda compra y recibe directo     (compra = 'materia_tienda')
--     La serie de la tienda se configura en locations.purchase_series; no
--     se escribe en cada compra, para que un cambio de código no deje
--     compras con dos series distintas.
--
--     Quién ve y registra: la gerente, las de SU tienda; la propietaria,
--     todas, y además las de oficina/bodega central (sin tienda). La cajera
--     no las ve: son datos de proveedores y de costos.
--
--  2. CIERRE: daily_closing_core devuelve además el desglose por forma de
--     pago, los descuentos por canje de puntos y los pedidos anulados. Lo
--     usan la pantalla y el correo del cierre (cierre-diario/).
--
--  3. RESPALDO: dos funciones que solo puede llamar la llave del servidor
--     (service_role), para que el Worker del cierre copie cada noche todas
--     las tablas a un almacenamiento aparte (R2 de Cloudflare). Existen
--     porque la API entrega a lo sumo 1000 filas por llamada: con ellas una
--     tabla sale en bloques de 20 000 y el respaldo cabe en pocas llamadas.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. COMPRAS
-- ----------------------------------------------------------------------------
alter table public.locations add column if not exists purchase_series text;
alter table public.locations drop constraint if exists locations_purchase_series_chk;
alter table public.locations add constraint locations_purchase_series_chk
  check (purchase_series is null or purchase_series ~ '^[0-9A-Z]{1,8}$');

create table if not exists public.purchases (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint generated always as identity,   -- "No. factura sistema"
  location_id         uuid references public.locations(id) on delete restrict,  -- null = oficina / bodega central
  compra              text not null check (compra in ('gasto','materia_bodega','materia_tienda')),
  received_on         date not null default current_date,    -- fecha albarán (cuando entró)
  invoice_date        date not null default current_date,    -- fecha de la factura del proveedor
  supplier_name       text not null check (length(trim(supplier_name)) between 1 and 160),
  supplier_rtn        text check (supplier_rtn is null or supplier_rtn ~ '^[0-9]{14}$'),
  supplier_code       text check (supplier_code is null or length(supplier_code) <= 20),
  supplier_invoice_no text check (supplier_invoice_no is null or length(supplier_invoice_no) <= 40),
  supplier_cai        text check (supplier_cai is null or length(supplier_cai) <= 60),
  description         text check (description is null or length(description) <= 300),
  exento              numeric(12,2) not null default 0 check (exento    >= 0),
  gravado15           numeric(12,2) not null default 0 check (gravado15 >= 0),
  gravado18           numeric(12,2) not null default 0 check (gravado18 >= 0),
  descuento           numeric(12,2) not null default 0 check (descuento >= 0),
  isv15               numeric(12,2) not null default 0 check (isv15     >= 0),
  isv18               numeric(12,2) not null default 0 check (isv18     >= 0),
  total               numeric(12,2) generated always as (exento + gravado15 + gravado18 + isv15 + isv18) stored,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  -- La materia prima de una tienda tiene que decir de qué tienda es.
  constraint purchases_tienda_chk check (compra <> 'materia_tienda' or location_id is not null),
  -- Topes que atajan un dedazo (L 1,000,000 por factura) sin estorbar.
  constraint purchases_tope_chk check (exento + gravado15 + gravado18 + isv15 + isv18 <= 1000000)
);

-- La misma factura del mismo proveedor no se registra dos veces (por
-- ejemplo, la gerente y la propietaria la meten las dos).
create unique index if not exists uq_purchases_factura
  on public.purchases ((coalesce(supplier_rtn, lower(trim(supplier_name)))), supplier_invoice_no)
  where supplier_invoice_no is not null;
create index if not exists idx_purchases_fecha on public.purchases(received_on desc);
create index if not exists idx_purchases_loc   on public.purchases(location_id, received_on desc);

alter table public.purchases enable row level security;

-- can_manage_location(null) es verdadero solo para la propietaria: así lo
-- de oficina/bodega central queda solo para ella sin otra regla.
drop policy if exists purchases_select on public.purchases;
create policy purchases_select on public.purchases for select to authenticated
  using (public.can_manage_location(location_id));
drop policy if exists purchases_write on public.purchases;
create policy purchases_write on public.purchases for all to authenticated
  using (public.can_manage_location(location_id))
  with check (public.can_manage_location(location_id));

grant select, insert, update, delete on public.purchases to authenticated;
revoke all on public.purchases from anon;

-- Quién la registró lo pone la base, como en los gastos.
create or replace function public.purchases_set_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists trg_purchases_author on public.purchases;
create trigger trg_purchases_author before insert or update on public.purchases
  for each row execute function public.purchases_set_author();

-- Las compras mueven dinero: al rastro de auditoría, como gastos y precios.
drop trigger if exists trg_audit_purchases on public.purchases;
create trigger trg_audit_purchases after insert or update or delete on public.purchases
  for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- 2. CIERRE con forma de pago, descuentos y anulaciones
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
           'anulado_g',       round(an.gramos, 2)
         )
    into v_result
    from totales_venta tv
   cross join totales_linea tl
   cross join gastos g
   cross join toppings_json tj
   cross join pago_json pj
   cross join anulaciones an;

  return v_result;
end;
$$;

-- create or replace conserva los permisos, pero se repiten para que este
-- archivo diga por sí solo quién puede llamarla: NADIE desde la API.
revoke all on function public.daily_closing_core(uuid, date, int) from public, anon, authenticated;
grant execute on function public.daily_closing_core(uuid, date, int) to service_role;

-- ----------------------------------------------------------------------------
-- 3. RESPALDO
--    Lista cerrada de tablas: nadie puede pedir por aquí una tabla que no
--    esté en ella. No se respaldan los hashes de PIN (privado.manager_pins:
--    después de restaurar, cada gerente vuelve a poner su PIN) ni secretos.
--    De auth.users solo id, correo y fechas: NUNCA el hash de la contraseña.
-- ----------------------------------------------------------------------------
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log'];
$$;

-- Cuántas filas tiene cada tabla: con esto el Worker sabe cuántos bloques
-- pedir sin tener que leer los datos.
create or replace function public.respaldo_conteo()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t text; n bigint; v jsonb := '{}'::jsonb;
begin
  foreach t in array public.respaldo_tablas() loop
    if t = 'usuarios' then select count(*) into n from auth.users;
    else execute format('select count(*) from public.%I', t) into n; end if;
    v := v || jsonb_build_object(t, n);
  end loop;
  return v;
end $$;

create or replace function public.respaldo_tabla(p_tabla text, p_desde int default 0, p_limite int default 20000)
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  if not (p_tabla = any(public.respaldo_tablas())) then
    raise exception 'Tabla fuera del respaldo: %', p_tabla;
  end if;
  if p_desde < 0 or p_limite < 1 or p_limite > 20000 then
    raise exception 'Bloque fuera de rango';
  end if;
  if p_tabla = 'usuarios' then
    -- Campo por campo, a propósito: así el hash de la contraseña no puede
    -- colarse aunque auth.users cambie de forma.
    select coalesce(json_agg(json_build_object('id', u.id, 'email', u.email,
             'created_at', to_jsonb(u)->'created_at', 'last_sign_in_at', to_jsonb(u)->'last_sign_in_at')), '[]')
      into v
      from (select * from auth.users order by id offset p_desde limit p_limite) u;
  else
    execute format('select coalesce(json_agg(t), ''[]'') from (select * from public.%I order by id offset %s limit %s) t',
                   p_tabla, p_desde, p_limite) into v;
  end if;
  return v;
end $$;

revoke all on function public.respaldo_tablas() from public, anon, authenticated;
revoke all on function public.respaldo_conteo() from public, anon, authenticated;
revoke all on function public.respaldo_tabla(text, int, int) from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;
grant execute on function public.respaldo_conteo() to service_role;
grant execute on function public.respaldo_tabla(text, int, int) to service_role;

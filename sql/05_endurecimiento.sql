-- ============================================================================
--  TUTI'S — Endurecimiento y rastro de auditoría
--
--  Correr DESPUÉS de 01, 02, 03 y 04. Es idempotente.
--
--  Sale de una auditoría de seguridad en la que se atacó el sistema desde la
--  posición más realista: alguien con cuenta legítima (una cajera, una
--  gerente) que sabe llamar la API directo desde la consola del navegador.
--
--  De 39 intentos, 38 rebotaron. Este archivo cierra el que pasó y agrega el
--  rastro que faltaba para saber quién hizo qué.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PESOS Y MONTOS NEGATIVOS  (el hueco que sí pasó)
--
--    Qué se podía hacer: mandar una venta con weight_g = -500. El descuento de
--    inventario es "stock = stock - peso", así que un peso negativo SUMABA
--    existencias. Una cajera podía cubrir un faltante de 500 g inventando una
--    venta negativa, y de paso dejar el total de la venta en un centavo.
--
--    Además el encabezado de la venta (total_price, total_cost) venía del
--    navegador sin contrastarse con sus propias líneas: podían no cuadrar y
--    nada lo notaba. Ahora el encabezado SE CALCULA de las líneas, así que
--    reporte y detalle no pueden contradecirse.
--
--    Lo que sigue confiando en el navegador es el precio de cada línea. Eso
--    es a propósito: una venta que se cobró sin internet y se sincroniza
--    después tiene que conservar el precio que el cliente pagó, no el que
--    esté vigente al momento de sincronizar. El control de ese riesgo es el
--    rastro de auditoría y el reporte de margen, no recalcular.
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
  v_tot_peso     numeric := 0;
  v_tot_costo    numeric := 0;
  v_tot_precio   numeric := 0;
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

  -- Reenvío de una venta que ya entró (cola offline): devolvemos la original.
  select * into v_existing from public.sales where client_uuid = v_client_uuid;
  if v_existing.id is not null then
    return jsonb_build_object('sale_id', v_existing.id, 'folio', v_existing.folio, 'duplicate', true);
  end if;

  -- Revisión de las líneas ANTES de escribir nada. Una venta con un dato
  -- imposible se rechaza entera; no se guarda a medias.
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
    -- Un vaso de 50 kg no existe; es un dato corrupto o un intento de ensuciar
    -- los reportes. 100 000 g deja margen de sobra para cualquier venta real.
    if v_peso > 100000 then
      raise exception 'Peso fuera de rango en la línea "%"', coalesce(v_line->>'name', '?');
    end if;

    v_tot_peso   := v_tot_peso + v_peso;
    v_tot_costo  := v_tot_costo + v_costo;
    v_tot_precio := v_tot_precio + v_precio;
  end loop;

  select currency_code into v_currency from public.locations where id = v_location_id;

  perform pg_advisory_xact_lock(hashtextextended(v_location_id::text, 0));
  select coalesce(max(folio), 0) + 1 into v_folio
    from public.sales where location_id = v_location_id;

  insert into public.sales (
    location_id, client_uuid, folio, cashier_id, cashier_name, created_at,
    gross_weight_g, total_price, total_cost, margin, margin_pct,
    currency_code, payment_method, customer_name, customer_tax_id, synced_offline
  ) values (
    v_location_id, v_client_uuid, v_folio, v_profile.id, v_profile.full_name, v_created_at,
    -- Estos cuatro ya NO vienen del navegador: se calculan de las líneas.
    round(v_tot_peso, 2),
    round(v_tot_precio, 2),
    round(v_tot_costo, 2),
    round(v_tot_precio - v_tot_costo, 2),
    case when v_tot_precio > 0
         then round(100 * (v_tot_precio - v_tot_costo) / v_tot_precio, 2) else 0 end,
    coalesce(v_currency, payload->>'currency_code'),
    payload->>'payment_method',
    payload->>'customer_name',
    payload->>'customer_tax_id',
    coalesce((payload->>'synced_offline')::boolean, false)
  )
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    insert into public.sale_lines (
      sale_id, location_id, item_type, ref_id, name, weight_g, cost,
      price_contribution, is_premium_surcharge
    ) values (
      v_sale_id, v_location_id,
      (v_line->>'item_type')::sale_item_type,
      nullif(v_line->>'ref_id', '')::uuid,
      coalesce(v_line->>'name', ''),
      coalesce((v_line->>'weight_g')::numeric, 0),
      coalesce((v_line->>'cost')::numeric, 0),
      coalesce((v_line->>'price_contribution')::numeric, 0),
      coalesce((v_line->>'is_premium_surcharge')::boolean, false)
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
    end if;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'folio', v_folio, 'duplicate', false);
end;
$$;

revoke all on function public.process_sale(jsonb) from public;
grant execute on function public.process_sale(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. QUIÉN REGISTRÓ CADA GASTO — lo pone el servidor, no el navegador
--    Antes, una gerente podía registrar un gasto y firmarlo con el id de otra
--    persona. Ya no: el campo se sobrescribe siempre con quien está dentro.
-- ----------------------------------------------------------------------------
create or replace function public.expenses_set_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_expenses_author on public.expenses;
create trigger trg_expenses_author
  before insert or update on public.expenses
  for each row execute function public.expenses_set_author();

-- ----------------------------------------------------------------------------
-- 3. RASTRO DE AUDITORÍA
--
--    El hueco que quedaba no era de permisos sino de RENDICIÓN DE CUENTAS:
--    una gerente puede, legítimamente, borrar una venta de su tienda, bajarle
--    el costo a un topping o ajustar existencias. Son cosas que a veces hay
--    que hacer. El problema era que no quedaba rastro de ninguna, así que un
--    faltante de caja no se podía reconstruir.
--
--    Qué se registra y qué no, a propósito:
--      · SÍ: cambios de precio y configuración, cambios de rol y de tienda,
--        movimientos de inventario y costo, gastos, y el BORRADO de ventas.
--      · NO: el alta de cada venta. La venta ya es su propio registro;
--        duplicarla solo llenaría la base (que es de plan gratuito) sin
--        agregar información.
--
--    Nadie puede escribir aquí desde la API: no hay política de insert. Solo
--    escriben los disparadores, que corren como SECURITY DEFINER. Tampoco hay
--    política de update ni de delete, así que ni el propietario puede editar
--    el rastro desde la aplicación — que es justo lo que le da valor.
-- ----------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_name  text,
  actor_role  text,
  location_id uuid,
  table_name  text not null,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  row_id      text,
  before      jsonb,
  after       jsonb
);

create index if not exists idx_audit_loc_date on public.audit_log(location_id, at desc);
create index if not exists idx_audit_date     on public.audit_log(at desc);

alter table public.audit_log enable row level security;

-- El propietario ve todo. La gerente ve lo de SU tienda: tiene que poder
-- revisar a su personal, pero no mirar la otra sucursal.
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log
  for select to authenticated
  using (
    public.is_owner()
    or (location_id is not null and public.can_manage_location(location_id))
  );

grant select on public.audit_log to authenticated;
revoke all on public.audit_log from anon;
-- La secuencia del bigserial no debe quedar expuesta.
revoke all on sequence public.audit_log_id_seq from anon, authenticated;

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perfil public.profiles%rowtype;
  v_before jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_loc    uuid;
  v_rowid  text;
begin
  -- Si nada cambió de verdad, no ensuciamos el rastro: un guardado sin
  -- cambios no es un evento y solo estorbaría al leerlo.
  if tg_op = 'UPDATE' and v_before = v_after then
    return new;
  end if;

  select * into v_perfil from public.profiles where id = auth.uid();

  -- De qué sucursal es la fila tocada. En locations la sucursal es la fila
  -- misma; en profiles es la tienda asignada; en las demás, su location_id.
  v_loc := case tg_table_name
             when 'locations' then coalesce((v_after->>'id'), (v_before->>'id'))::uuid
             else coalesce((v_after->>'location_id'), (v_before->>'location_id'))::uuid
           end;
  v_rowid := coalesce((v_after->>'id'), (v_before->>'id'));

  -- El logo pesa decenas de KB. Guardar una copia en cada cambio inflaría el
  -- rastro sin aportar: basta saber que el logo cambió.
  if tg_table_name = 'locations' then
    if v_before ? 'logo_data_url' and v_before->>'logo_data_url' is not null then
      v_before := jsonb_set(v_before, '{logo_data_url}', '"(imagen)"');
    end if;
    if v_after ? 'logo_data_url' and v_after->>'logo_data_url' is not null then
      v_after := jsonb_set(v_after, '{logo_data_url}', '"(imagen)"');
    end if;
  end if;

  insert into public.audit_log (
    actor_id, actor_name, actor_role, location_id,
    table_name, action, row_id, before, after
  ) values (
    auth.uid(), v_perfil.full_name, v_perfil.role::text, v_loc,
    tg_table_name, tg_op, v_rowid, v_before, v_after
  );

  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
  -- Las tablas cuyo cambio puede mover dinero o permisos.
  tablas text[] := array['locations','profiles','flavors','toppings','supplies','expenses'];
begin
  foreach t in array tablas loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.audit_row()', t);
  end loop;

  -- En ventas solo interesa el BORRADO: el alta ya queda registrada por la
  -- venta misma, y auditar cada una duplicaría la tabla más grande del sistema.
  execute 'drop trigger if exists trg_audit_sales on public.sales';
  execute 'create trigger trg_audit_sales after delete on public.sales
             for each row execute function public.audit_row()';
end $$;

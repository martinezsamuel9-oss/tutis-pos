-- ============================================================================
--  25 — Libro contable
--  Pedido del negocio (2026-10-30): "Libro contable", dentro de las mejoras
--  sobre ICG. Catálogo de cuentas, libro diario, mayor, balanza de
--  comprobación y estado de resultados, por tienda y de la oficina.
--
--  Cómo está hecho:
--   · Los asientos de lo que ya está en el sistema NO se guardan: se calculan
--     cada vez de su fuente (ventas, compras, caja, gastos). Igual que el
--     cierre: con el número guardado en dos lugares, un día dejarían de
--     coincidir (una venta sin conexión que sube tarde, una compra corregida).
--   · Lo que el sistema no sabe (pago a proveedores, depósito del datáfono,
--     planilla, capital) va en asientos manuales, que sí se guardan, cuadrados
--     y sin borrar: un asiento equivocado se ANULA con motivo y se hace otro.
--   · Los asientos automáticos buscan su cuenta por `clave`, no por código:
--     el contador puede recodificar el catálogo sin romper nada.
--
--  Lo que NO es: contabilidad fiscal. Es el libro de la operación para el
--  contador; él decide qué y cómo declara.
--
--  Correr después de 00..24. Se puede correr dos veces.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------------------------
create table if not exists public.cont_cuentas (
  id         uuid primary key default gen_random_uuid(),
  codigo     text not null unique check (codigo ~ '^[0-9]{1,10}$'),
  nombre     text not null check (length(trim(nombre)) between 2 and 120),
  tipo       text not null check (tipo in ('activo', 'pasivo', 'patrimonio', 'ingreso', 'costo', 'gasto')),
  clave      text unique check (clave is null or clave ~ '^[a-z_]{2,30}$'),   -- la usan los asientos automáticos
  activa     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.cont_config (
  id             boolean primary key default true check (id),
  -- Los gastos de la pestaña Gastos y las compras CTG suelen ser lo mismo
  -- (la renta con su factura). Por defecto entra solo la compra, que trae
  -- RTN e ISV; quien no registra facturas de gasto lo enciende.
  incluir_gastos boolean not null default false,
  updated_at     timestamptz
);
insert into public.cont_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.cont_asientos (
  id             uuid primary key default gen_random_uuid(),
  numero         bigint generated always as identity,
  location_id    uuid references public.locations(id) on delete restrict,   -- null = oficina
  fecha          date not null,
  concepto       text not null check (length(trim(concepto)) between 3 and 300),
  anulado_at     timestamptz,
  anulado_por    uuid references public.profiles(id) on delete set null,
  anulado_motivo text check (anulado_motivo is null or length(anulado_motivo) <= 300),
  created_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  check ((anulado_at is null) = (anulado_motivo is null))
);
create index if not exists idx_cont_asientos_loc on public.cont_asientos(location_id, fecha);

create table if not exists public.cont_asiento_lineas (
  asiento_id uuid not null references public.cont_asientos(id) on delete cascade,
  linea      int not null check (linea between 1 and 50),
  cuenta_id  uuid not null references public.cont_cuentas(id) on delete restrict,
  debe       numeric(14,2) not null default 0 check (debe >= 0 and debe <= 100000000),
  haber      numeric(14,2) not null default 0 check (haber >= 0 and haber <= 100000000),
  detalle    text check (detalle is null or length(detalle) <= 200),
  primary key (asiento_id, linea),
  check ((debe > 0) <> (haber > 0))
);

-- ----------------------------------------------------------------------------
-- Permisos: leer sí, escribir solo por funciones
-- ----------------------------------------------------------------------------
-- El catálogo lo ven quienes ven el libro (gerencia, contabilidad, propietaria).
create or replace function public.cont_puede_ver()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('propietario', 'gerente', 'contabilidad'), false);
$$;
revoke all on function public.cont_puede_ver() from public, anon;
grant execute on function public.cont_puede_ver() to authenticated;

alter table public.cont_cuentas        enable row level security;
alter table public.cont_config         enable row level security;
alter table public.cont_asientos       enable row level security;
alter table public.cont_asiento_lineas enable row level security;
revoke all on public.cont_cuentas, public.cont_config, public.cont_asientos, public.cont_asiento_lineas
  from public, anon, authenticated;
grant select on public.cont_cuentas, public.cont_config, public.cont_asientos, public.cont_asiento_lineas to authenticated;

drop policy if exists cont_cuentas_ver on public.cont_cuentas;
create policy cont_cuentas_ver on public.cont_cuentas for select to authenticated using (public.cont_puede_ver());
drop policy if exists cont_config_ver on public.cont_config;
create policy cont_config_ver on public.cont_config for select to authenticated using (public.cont_puede_ver());
drop policy if exists cont_asientos_ver on public.cont_asientos;
create policy cont_asientos_ver on public.cont_asientos for select to authenticated
  using (public.can_account_location(location_id));
drop policy if exists cont_asiento_lineas_ver on public.cont_asiento_lineas;
create policy cont_asiento_lineas_ver on public.cont_asiento_lineas for select to authenticated
  using (exists (select 1 from public.cont_asientos a where a.id = asiento_id and public.can_account_location(a.location_id)));

drop trigger if exists trg_audit_cont_cuentas on public.cont_cuentas;
create trigger trg_audit_cont_cuentas after update or delete on public.cont_cuentas for each row execute function public.audit_row();
drop trigger if exists trg_audit_cont_asientos on public.cont_asientos;
create trigger trg_audit_cont_asientos after update or delete on public.cont_asientos for each row execute function public.audit_row();
drop trigger if exists trg_audit_cont_config on public.cont_config;
create trigger trg_audit_cont_config after update on public.cont_config for each row execute function public.audit_row();

-- ----------------------------------------------------------------------------
-- Catálogo de cuentas de arranque (el contador lo recodifica a su gusto)
-- ----------------------------------------------------------------------------
insert into public.cont_cuentas (codigo, nombre, tipo, clave) values
  ('1101', 'Caja general',                              'activo',     'caja'),
  ('1102', 'Bancos',                                    'activo',     'bancos'),
  ('1103', 'Efectivo por depositar',                    'activo',     'por_depositar'),
  ('1104', 'Tarjetas por cobrar (datáfono)',            'activo',     'tarjeta'),
  ('1105', 'Delivery por cobrar (Pedidos Ya, Hugo)',    'activo',     'delivery'),
  ('1106', 'ISV pagado en compras (crédito fiscal)',    'activo',     'isv_credito'),
  ('1201', 'Inventario de materia prima',               'activo',     'inventario'),
  ('2101', 'Proveedores',                               'pasivo',     'proveedores'),
  ('2102', 'ISV por pagar (débito fiscal)',             'pasivo',     'isv_debito'),
  ('3101', 'Capital',                                   'patrimonio', null),
  ('3102', 'Utilidades acumuladas',                     'patrimonio', null),
  ('4101', 'Ventas',                                    'ingreso',    'ventas'),
  ('4102', 'Descuentos por canje de puntos',            'ingreso',    'descuentos'),
  ('4201', 'Sobrantes de caja',                         'ingreso',    'sobrante'),
  ('5101', 'Costo de ventas',                           'costo',      'costo_ventas'),
  ('6101', 'Renta',                                     'gasto',      'gasto_renta'),
  ('6102', 'Planilla',                                  'gasto',      'gasto_planilla'),
  ('6103', 'Insumos',                                   'gasto',      'gasto_insumos'),
  ('6104', 'Servicios públicos',                        'gasto',      'gasto_servicios'),
  ('6105', 'Mantenimiento',                             'gasto',      'gasto_mantenimiento'),
  ('6106', 'Mercadeo',                                  'gasto',      'gasto_mercadeo'),
  ('6107', 'Impuestos y tasas',                         'gasto',      'gasto_impuestos'),
  ('6108', 'Otros gastos',                              'gasto',      'gasto_otros'),
  ('6109', 'Gastos con factura (compras CTG)',          'gasto',      'gasto_compras'),
  ('6110', 'Comisiones bancarias y de tarjeta',         'gasto',      null),
  ('6201', 'Faltantes de caja',                         'gasto',      'faltante')
on conflict (codigo) do nothing;

-- ----------------------------------------------------------------------------
-- Auxiliares
-- ----------------------------------------------------------------------------
create or replace function public.cont_exige(p_location uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_account_location(p_location) then
    raise exception 'No tienes acceso al libro contable de %', case when p_location is null then 'la oficina' else 'esa tienda' end;
  end if;
end $$;
revoke all on function public.cont_exige(uuid) from public, anon, authenticated;

-- La misma tasa que el libro de ventas (web/libro-ventas.js, TASA).
create or replace function public.cont_tasa_isv(p_pais text)
returns numeric language sql immutable as $$
  select case upper(coalesce(p_pais, 'HN')) when 'GT' then 0.12 when 'SV' then 0.13 else 0.15 end;
$$;

-- ----------------------------------------------------------------------------
-- Todos los movimientos de un periodo: los automáticos y los manuales.
-- Interna: no pregunta permisos, por eso nadie la puede llamar directo.
-- p_location null = la oficina (compras sin tienda y asientos de oficina).
-- ----------------------------------------------------------------------------
create or replace function public.cont_movimientos(p_location uuid, p_desde date, p_hasta date)
returns table (fecha date, origen text, ref text, concepto text, cuenta_id uuid, debe numeric, haber numeric, orden int)
language sql stable security definer set search_path = public as $$
  with
  cfg as (select coalesce((select incluir_gastos from public.cont_config limit 1), false) as gastos),
  loc as (select id, public.cont_tasa_isv(country_code) as tasa from public.locations where id = p_location),
  -- Ventas: el ISV se separa del total cobrado factura por factura, igual que
  -- el libro de ventas, para que los dos cuadren al centavo.
  v as (
    select public.inv_fecha_local(s.location_id, s.created_at) as f,
           case coalesce(nullif(trim(s.payment_method), ''), 'efectivo')
                when 'tarjeta' then 'tarjeta' when 'transferencia' then 'bancos'
                when 'pedidosya' then 'delivery' when 'hugo' then 'delivery' else 'caja' end as cobro,
           round(s.total_price, 2) as total, round(s.total_price / (1 + loc.tasa), 2) as gravado,
           round(coalesce(s.discount, 0), 2) as descuento, round(coalesce(s.total_cost, 0), 2) as costo
      from public.sales s join loc on loc.id = s.location_id
     where s.created_at >= p_desde::timestamp - interval '1 day'
       and s.created_at <  p_hasta::timestamp + interval '2 days'),
  vd as (select * from v where f between p_desde and p_hasta),
  dias as (select f, count(*) as n, sum(total - gravado) as isv, sum(gravado) as gravado, sum(descuento) as descuento,
                  sum(costo) as costo from vd group by f),
  ventas as (
    select d.f, 'ventas', d.f::text, 'Ventas del día (' || d.n || ' comprobantes)', x.clave, x.debe, x.haber, x.o
      from dias d cross join lateral (
        select c.cobro as clave, sum(c.total) as debe, 0::numeric as haber, 1 as o from vd c where c.f = d.f group by c.cobro
        union all select 'descuentos', d.descuento, 0, 2 where d.descuento > 0
        union all select 'ventas', 0, d.gravado + d.descuento, 3
        union all select 'isv_debito', 0, d.isv, 4 where d.isv <> 0) x
     where x.debe <> 0 or x.haber <> 0),
  costo as (
    select f, 'costo', f::text, 'Costo de lo vendido en el día', 'costo_ventas', costo, 0::numeric, 1 from dias where costo > 0
    union all
    select f, 'costo', f::text, 'Costo de lo vendido en el día', 'inventario', 0, costo, 2 from dias where costo > 0),
  -- Compras: la factura del proveedor, por su fecha.
  compras as (
    select p.invoice_date, 'compra', p.numero::text,
           'Compra ' || case p.compra when 'gasto' then 'CTG' when 'materia_bodega' then 'CTH' else coalesce(l.purchase_series, 'tienda') end
             || ' · ' || p.supplier_name || coalesce(' · factura ' || p.supplier_invoice_no, ''),
           x.clave, x.debe, x.haber, x.o
      from public.purchases p left join public.locations l on l.id = p.location_id
      cross join lateral (
        select case when p.compra = 'gasto' then 'gasto_compras' else 'inventario' end as clave,
               p.exento + p.gravado15 + p.gravado18 as debe, 0::numeric as haber, 1 as o
        union all select 'isv_credito', p.isv15 + p.isv18, 0, 2
        union all select 'proveedores', 0, p.total, 3) x
     where p.location_id is not distinct from p_location and p.invoice_date between p_desde and p_hasta
       and (x.debe <> 0 or x.haber <> 0)),
  gastos as (
    select e.spent_on, 'gasto', e.id::text, 'Gasto: ' || coalesce(nullif(trim(e.description), ''), e.category),
           x.clave, x.debe, x.haber, x.o
      from public.expenses e cross join cfg
      cross join lateral (select 'gasto_' || e.category as clave, e.amount as debe, 0::numeric as haber, 1 as o
                          union all select 'bancos', 0, e.amount, 2) x
     where cfg.gastos and e.location_id = p_location and e.spent_on between p_desde and p_hasta and e.amount > 0),
  -- Caja: retiros y entradas de la gaveta, y la diferencia de cada arqueo.
  caja_mov as (
    select public.inv_fecha_local(m.location_id, m.creado_at) as f, m.id, m.tipo, m.monto, m.motivo
      from public.cash_movements m
     where m.location_id = p_location
       and m.creado_at >= p_desde::timestamp - interval '1 day' and m.creado_at < p_hasta::timestamp + interval '2 days'),
  caja as (
    select f, 'caja', id::text, case tipo when 'retiro' then 'Retiro de caja: ' else 'Entrada a caja: ' end || motivo,
           x.clave, x.debe, x.haber, x.o
      from caja_mov cross join lateral (
        select case when caja_mov.tipo = 'retiro' then 'por_depositar' else 'caja' end as clave, monto as debe, 0::numeric as haber, 1 as o
        union all select case when caja_mov.tipo = 'retiro' then 'caja' else 'por_depositar' end, 0, monto, 2) x
     where f between p_desde and p_hasta),
  arqueos as (
    select public.inv_fecha_local(s.location_id, s.cerrado_at) as f, s.id, s.cerrado_nombre, round(s.contado - s.esperado, 2) as dif
      from public.cash_sessions s
     where s.location_id = p_location and s.cerrado_at is not null and s.esperado is not null and s.contado <> s.esperado
       and s.cerrado_at >= p_desde::timestamp - interval '1 day' and s.cerrado_at < p_hasta::timestamp + interval '2 days'),
  arqueo as (
    select f, 'arqueo', id::text,
           case when dif < 0 then 'Faltante en el arqueo' else 'Sobrante en el arqueo' end || coalesce(' (cerró ' || cerrado_nombre || ')', ''),
           x.clave, x.debe, x.haber, x.o
      from arqueos cross join lateral (
        select case when dif < 0 then 'faltante' else 'caja' end as clave, abs(dif) as debe, 0::numeric as haber, 1 as o
        union all select case when dif < 0 then 'caja' else 'sobrante' end, 0, abs(dif), 2) x
     where f between p_desde and p_hasta),
  auto as (
    select * from ventas union all select * from costo union all select * from compras
    union all select * from gastos union all select * from caja union all select * from arqueo),
  manual as (
    select a.fecha, 'manual'::text, a.numero::text, a.concepto, l.cuenta_id, l.debe, l.haber, l.linea
      from public.cont_asientos a join public.cont_asiento_lineas l on l.asiento_id = a.id
     where a.location_id is not distinct from p_location and a.anulado_at is null and a.fecha between p_desde and p_hasta)
  select a.f, a.origen, a.ref, a.concepto, c.id, round(a.debe, 2), round(a.haber, 2), a.o
    from auto a (f, origen, ref, concepto, clave, debe, haber, o)
    left join public.cont_cuentas c on c.clave = a.clave
  union all
  select * from manual;
$$;
revoke all on function public.cont_movimientos(uuid, date, date) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Libro diario: los movimientos agrupados en asientos.
-- ----------------------------------------------------------------------------
create or replace function public.cont_diario(p_location uuid, p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.cont_exige(p_location);
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 92 then
    raise exception 'El diario va de 1 a 93 días';
  end if;
  with m as (select * from public.cont_movimientos(p_location, p_desde, p_hasta)),
  a as (
    select m.fecha, m.origen, m.ref, m.concepto,
           jsonb_agg(jsonb_build_object('cuenta_id', m.cuenta_id, 'codigo', c.codigo, 'nombre', c.nombre,
                                        'debe', m.debe, 'haber', m.haber) order by m.orden, c.codigo) as lineas,
           sum(m.debe) as debe, sum(m.haber) as haber
      from m left join public.cont_cuentas c on c.id = m.cuenta_id
     group by m.fecha, m.origen, m.ref, m.concepto)
  select jsonb_build_object(
    'asientos', coalesce(jsonb_agg(jsonb_build_object('fecha', a.fecha, 'origen', a.origen, 'ref', a.ref, 'concepto', a.concepto,
                                                     'lineas', a.lineas, 'debe', a.debe, 'haber', a.haber)
                                   order by a.fecha, case a.origen when 'ventas' then 1 when 'costo' then 2 when 'caja' then 3
                                                                   when 'arqueo' then 4 when 'compra' then 5 when 'gasto' then 6 else 7 end, a.ref), '[]'::jsonb),
    'debe', coalesce(sum(a.debe), 0), 'haber', coalesce(sum(a.haber), 0),
    -- Una cuenta automática que alguien desactivó o borró deja líneas sin cuenta.
    'sin_cuenta', (select count(*) from m where m.cuenta_id is null),
    'anulados', (select coalesce(jsonb_agg(jsonb_build_object('numero', x.numero, 'fecha', x.fecha, 'concepto', x.concepto,
                                                              'motivo', x.anulado_motivo, 'anulado_at', x.anulado_at) order by x.numero), '[]'::jsonb)
                   from public.cont_asientos x
                  where x.location_id is not distinct from p_location and x.anulado_at is not null
                    and x.fecha between p_desde and p_hasta))
    into v from a;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- Balanza de comprobación. El saldo anterior de las cuentas de resultados
-- arranca el 1 de enero (año fiscal de enero a diciembre); el de las de
-- balance, desde el principio.
-- ----------------------------------------------------------------------------
create or replace function public.cont_balanza(p_location uuid, p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_ano date := date_trunc('year', p_desde)::date;
begin
  perform public.cont_exige(p_location);
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 366 then
    raise exception 'La balanza va de 1 a 367 días';
  end if;
  with m as (select * from public.cont_movimientos(p_location, date '2000-01-01', p_hasta)),
  t as (
    select c.id, c.codigo, c.nombre, c.tipo, c.activa,
           coalesce(sum(m.debe - m.haber) filter (where m.fecha < p_desde
                     and (c.tipo in ('activo', 'pasivo', 'patrimonio') or m.fecha >= v_ano)), 0) as anterior,
           coalesce(sum(m.debe)  filter (where m.fecha >= p_desde), 0) as debe,
           coalesce(sum(m.haber) filter (where m.fecha >= p_desde), 0) as haber
      from public.cont_cuentas c left join m on m.cuenta_id = c.id
     group by c.id)
  select jsonb_build_object(
    'cuentas', coalesce(jsonb_agg(jsonb_build_object('cuenta_id', id, 'codigo', codigo, 'nombre', nombre, 'tipo', tipo,
                                                    'anterior', anterior, 'debe', debe, 'haber', haber,
                                                    'final', anterior + debe - haber) order by codigo)
                        filter (where anterior <> 0 or debe <> 0 or haber <> 0), '[]'::jsonb),
    'debe', coalesce(sum(debe), 0), 'haber', coalesce(sum(haber), 0))
    into v from t;
  return v;
end $$;

-- ----------------------------------------------------------------------------
-- Asientos manuales
-- ----------------------------------------------------------------------------
-- p: {location_id|null, fecha, concepto, lineas: [{cuenta_id, debe, haber, detalle}]}
create or replace function public.cont_guardar_asiento(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid := nullif(p->>'location_id', '')::uuid;
  v_fecha date := nullif(p->>'fecha', '')::date;
  v_id uuid; v_num bigint; l jsonb; k int := 0; v_d numeric := 0; v_h numeric := 0; d numeric; h numeric;
begin
  perform public.cont_exige(v_loc);
  if v_fecha is null or v_fecha < date '2000-01-01' or v_fecha > (now() at time zone 'America/Tegucigalpa')::date + 1 then
    raise exception 'La fecha del asiento no es válida';
  end if;
  if length(trim(coalesce(p->>'concepto', ''))) < 3 then raise exception 'Escribe el concepto del asiento'; end if;
  if jsonb_typeof(p->'lineas') is distinct from 'array' or jsonb_array_length(p->'lineas') < 2 then
    raise exception 'Un asiento lleva al menos dos líneas';
  end if;
  if jsonb_array_length(p->'lineas') > 50 then raise exception 'Un asiento lleva hasta 50 líneas'; end if;

  insert into public.cont_asientos (location_id, fecha, concepto) values (v_loc, v_fecha, trim(p->>'concepto'))
  returning id, numero into v_id, v_num;
  for l in select * from jsonb_array_elements(p->'lineas') loop
    k := k + 1;
    d := round(coalesce(nullif(l->>'debe', '')::numeric, 0), 2);
    h := round(coalesce(nullif(l->>'haber', '')::numeric, 0), 2);
    if d < 0 or h < 0 then raise exception 'Línea %: el debe y el haber no pueden ser negativos', k; end if;
    if (d > 0) = (h > 0) then raise exception 'Línea %: va en el debe o en el haber, no en los dos ni en ninguno', k; end if;
    if not exists (select 1 from public.cont_cuentas where id = nullif(l->>'cuenta_id', '')::uuid and activa) then
      raise exception 'Línea %: la cuenta no existe o está inactiva', k;
    end if;
    insert into public.cont_asiento_lineas (asiento_id, linea, cuenta_id, debe, haber, detalle)
    values (v_id, k, (l->>'cuenta_id')::uuid, d, h, nullif(trim(coalesce(l->>'detalle', '')), ''));
    v_d := v_d + d; v_h := v_h + h;
  end loop;
  if v_d <> v_h then raise exception 'El asiento no cuadra: debe % y haber %', v_d, v_h; end if;
  return jsonb_build_object('id', v_id, 'numero', v_num, 'total', v_d);
end $$;

create or replace function public.cont_anular_asiento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.cont_asientos;
begin
  select * into a from public.cont_asientos where id = p_id for update;
  if not found then raise exception 'Ese asiento no existe'; end if;
  perform public.cont_exige(a.location_id);
  if a.anulado_at is not null then raise exception 'Ese asiento ya está anulado'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Escribe por qué se anula: queda registrado'; end if;
  update public.cont_asientos set anulado_at = now(), anulado_por = auth.uid(), anulado_motivo = trim(p_motivo) where id = p_id;
end $$;

-- ----------------------------------------------------------------------------
-- Catálogo y configuración: la propietaria o contabilidad de todas las tiendas
-- ----------------------------------------------------------------------------
create or replace function public.cont_guardar_cuenta(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; c public.cont_cuentas;
begin
  if not public.can_account_location(null) then
    raise exception 'El catálogo de cuentas lo cambian la propietaria o contabilidad de todas las tiendas';
  end if;
  if v_id is null then
    insert into public.cont_cuentas (codigo, nombre, tipo, activa)
    values (trim(p->>'codigo'), trim(p->>'nombre'), p->>'tipo', coalesce((p->>'activa')::boolean, true))
    returning id into v_id;
  else
    select * into c from public.cont_cuentas where id = v_id;
    if not found then raise exception 'Esa cuenta no existe'; end if;
    -- Las cuentas de los asientos automáticos no cambian de tipo ni se apagan:
    -- las ventas, el ISV o la caja quedarían sin cuenta.
    if c.clave is not null and (p->>'tipo' is distinct from c.tipo or coalesce((p->>'activa')::boolean, true) = false) then
      raise exception 'Esa cuenta la usan los asientos automáticos: se le puede cambiar el código y el nombre, no el tipo ni apagarla';
    end if;
    update public.cont_cuentas set codigo = trim(p->>'codigo'), nombre = trim(p->>'nombre'), tipo = p->>'tipo',
           activa = coalesce((p->>'activa')::boolean, activa)
     where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.cont_guardar_config(p_incluir_gastos boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_account_location(null) then
    raise exception 'Esto lo cambian la propietaria o contabilidad de todas las tiendas';
  end if;
  update public.cont_config set incluir_gastos = coalesce(p_incluir_gastos, false), updated_at = now() where id;
end $$;

do $$ declare f text; begin
  foreach f in array array['cont_diario(uuid, date, date)', 'cont_balanza(uuid, date, date)',
                           'cont_guardar_asiento(jsonb)', 'cont_anular_asiento(uuid, text)',
                           'cont_guardar_cuenta(jsonb)', 'cont_guardar_config(boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- El respaldo nocturno copia también el libro.
create or replace function public.respaldo_tablas()
returns text[] language sql immutable as $$
  select array['locations','profiles','usuarios','flavors','toppings','supplies','products',
               'sales','sale_lines','expenses','purchases','customers','loyalty_config',
               'loyalty_transactions','order_voids','weight_authorizations',
               'closing_email_log','audit_log','app_tamanos','app_config','pedidos_app',
               'cash_sessions','cash_movements','clientes_config',
               'inv_items','recetas','receta_lineas','fabricaciones','inv_conteos','inv_conteo_lineas','inv_movimientos',
               'cont_cuentas','cont_config','cont_asientos','cont_asiento_lineas'];
$$;
revoke all on function public.respaldo_tablas() from public, anon, authenticated;
grant execute on function public.respaldo_tablas() to service_role;

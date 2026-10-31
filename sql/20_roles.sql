-- ============================================================================
-- 20. ROLES: Operaciones y Contabilidad
-- ----------------------------------------------------------------------------
-- Pedido del negocio (2026-10-30): los roles son Cajera, Gerencia,
-- Operaciones y Contabilidad. Gerencia es la gerente de tienda que ya
-- existía; la propietaria sigue arriba de todo.
--
--   operaciones  → inventario diario, fabricación, recetas, máquinas, compras
--                  y el cuadre de inventario. No cobra, no abre la caja, no
--                  cambia precios ni ve clientes.
--   contabilidad → reportes, cierres, turnos de caja (solo verlos), libro de
--                  ventas, compras, gastos y el libro contable. No cobra, no
--                  abre la caja, no toca inventario ni precios.
--
-- Las dos pueden ser de UNA tienda (location_id) o de TODAS (todas_tiendas),
-- porque operaciones y contabilidad suelen ser de la oficina, no de una
-- tienda. todas_tiendas solo lo pone la propietaria (profiles_update ya es
-- solo suyo) y la base no lo acepta para cajera ni gerente.
--
-- Lo que no hay que deshacer:
--   1. Un perfil sin tienda y sin todas_tiendas sigue sin ser nadie (sql/17).
--   2. Las ventas las registran solo cajera, gerente y propietaria: un
--      disparador lo revisa en la base, porque process_sale solo comparaba la
--      tienda del perfil.
--   3. La caja (sql/19) la operan solo cajera, gerente y propietaria.
-- ============================================================================

-- ALTER TYPE ... ADD VALUE va suelto: no se puede usar en la misma transacción.
alter type public.user_role add value if not exists 'operaciones';
alter type public.user_role add value if not exists 'contabilidad';

alter table public.profiles add column if not exists todas_tiendas boolean not null default false;
alter table public.profiles drop constraint if exists profiles_todas_tiendas_chk;
alter table public.profiles add constraint profiles_todas_tiendas_chk
  check (not todas_tiendas or role in ('operaciones', 'contabilidad'));

-- ----------------------------------------------------------------------------
-- Auxiliares de permisos (SECURITY DEFINER: leen profiles sin recursión)
-- ----------------------------------------------------------------------------
create or replace function public.app_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles
   where id = auth.uid() and active
     and (role = 'propietario' or location_id is not null
          or (todas_tiendas and role in ('operaciones', 'contabilidad')));
$$;

create or replace function public.can_access_location(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.active
       and (p.role = 'propietario' or p.location_id = target
            or (p.todas_tiendas and p.role in ('operaciones', 'contabilidad'))));
$$;

-- Inventario, fabricación, recetas, máquinas y conteos.
create or replace function public.can_operate_location(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.active
       and (p.role = 'propietario'
            or (p.role in ('gerente', 'operaciones') and target is not null and p.location_id = target)
            or (p.role = 'operaciones' and p.todas_tiendas)));
$$;

-- Compras, gastos, turnos (lectura) y libro contable. target null = oficina.
create or replace function public.can_account_location(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.active
       and (p.role = 'propietario'
            or (p.role in ('gerente', 'contabilidad') and target is not null and p.location_id = target)
            or (p.role = 'contabilidad' and p.todas_tiendas)));
$$;

-- ¿Quien llama atiende la caja? (cobrar, abrir la gaveta, clientes en caja)
create or replace function public.es_personal_de_caja()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('cajera', 'gerente', 'propietario'), false);
$$;

revoke all on function public.can_operate_location(uuid), public.can_account_location(uuid),
                       public.es_personal_de_caja() from public, anon;
grant execute on function public.can_operate_location(uuid), public.can_account_location(uuid),
                          public.es_personal_de_caja() to authenticated;

-- ----------------------------------------------------------------------------
-- Las ventas: solo personal de caja
-- ----------------------------------------------------------------------------
create or replace function public.ventas_solo_caja()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() null = el servidor (pruebas, respaldo): no aplica.
  if auth.uid() is not null and not public.es_personal_de_caja() then
    raise exception 'Tu rol no registra ventas';
  end if;
  return new;
end $$;
drop trigger if exists trg_ventas_solo_caja on public.sales;
create trigger trg_ventas_solo_caja before insert on public.sales
  for each row execute function public.ventas_solo_caja();

-- ----------------------------------------------------------------------------
-- La caja: solo personal de caja (sql/19 usaba can_access_location)
-- ----------------------------------------------------------------------------
create or replace function public.caja_quien(p_location uuid)
returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null or public.app_role() is null then raise exception 'Sin perfil activo'; end if;
  if not public.es_personal_de_caja() then raise exception 'Tu rol no opera la caja'; end if;
  if p_location is null or not public.can_access_location(p_location) then raise exception 'No tienes acceso a esa tienda'; end if;
  select * into p from public.profiles where id = auth.uid();
  return p;
end $$;
revoke all on function public.caja_quien(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Clientes: los ve y los inscribe el personal de caja, no operaciones ni
-- contabilidad (son datos personales: teléfono, identidad, cumpleaños).
-- ----------------------------------------------------------------------------
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (public.es_personal_de_caja());
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert to authenticated
  with check (public.es_personal_de_caja());

-- ----------------------------------------------------------------------------
-- Compras: gerente, propietaria, contabilidad y operaciones (operaciones
-- recibe la mercadería; contabilidad registra la factura).
-- ----------------------------------------------------------------------------
drop policy if exists purchases_select on public.purchases;
create policy purchases_select on public.purchases for select to authenticated
  using (public.can_account_location(location_id) or public.can_operate_location(location_id));
drop policy if exists purchases_write on public.purchases;
create policy purchases_write on public.purchases for all to authenticated
  using (public.can_account_location(location_id) or public.can_operate_location(location_id))
  with check (public.can_account_location(location_id) or public.can_operate_location(location_id));

-- Gastos: también contabilidad.
drop policy if exists expenses_write on public.expenses;
create policy expenses_write on public.expenses for all to authenticated
  using (public.can_account_location(location_id))
  with check (public.can_account_location(location_id));

-- El rastro de auditoría: también contabilidad (de su alcance).
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated
  using (public.is_owner()
         or (location_id is not null and (public.can_manage_location(location_id) or public.can_account_location(location_id))));

-- Los turnos de caja (verlos también contabilidad) se rehacen en sql/21.
